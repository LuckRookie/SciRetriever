import { randomUUID } from "node:crypto";
import {
  parseLiteratureId,
  type LiteratureContent,
  type DurableCandidate,
} from "@sciretriever/contracts";
import type { CandidateAcceptanceService } from "../acquisition/candidate-acceptance.js";
import { LiteraturePublicationError } from "../literature/primary-pdf.js";
import type { LiteratureQueryService } from "../literature/query.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { ParsingService } from "../parsing/service.js";
import type { ContentAnalysisService } from "./content-analysis.js";
export interface CompletionCommand {
  readonly literature_id: string;
  readonly transfer_ids: readonly string[];
}
export interface CompletionAttempt {
  readonly transfer_id: string | null;
  readonly outcome:
    | "content_accepted"
    | "no_usable_content"
    | "duplicate_input"
    | "candidate_missing"
    | "candidate_rejected"
    | "candidate_uncertain";
}
export type CompletionResult =
  | {
      readonly outcome: "content_ready";
      readonly literature_id: string;
      readonly content: LiteratureContent;
      readonly attempts: readonly CompletionAttempt[];
    }
  | {
      readonly outcome: "supplied_candidates_exhausted";
      readonly literature_id: string;
      readonly attempts: readonly CompletionAttempt[];
    };
export class LiteratureCompletionFailure extends Error {
  constructor(
    readonly code:
      | "completion-command"
      | "completion-active"
      | "completion-closed"
      | "completion-cancelled"
      | "completion-stale"
      | "completion-contract",
  ) {
    super("literature completion failed");
  }
}
/** One bounded invocation. Attempt memory is discarded at its end and never becomes a durable exhaustion fact. */
export class LiteratureCompletionService {
  private readonly stop = new AbortController();
  private readonly active = new Map<string, Promise<CompletionResult>>();
  constructor(
    private readonly library: Pick<LiteratureQueryService, "detail">,
    private readonly repository: Pick<SqliteWorker, "getCandidate">,
    private readonly acceptance: Pick<CandidateAcceptanceService, "accept">,
    private readonly parsing: Pick<
      ParsingService,
      "prepareCurrentPrimary" | "commitCurrentPrimary" | "discardPrepared"
    >,
    private readonly analysis: Pick<ContentAnalysisService, "analyzeCurrent">,
  ) {}
  complete(
    value: CompletionCommand,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    if (this.stop.signal.aborted)
      return Promise.reject(
        new LiteratureCompletionFailure("completion-closed"),
      );
    let command: CompletionCommand;
    try {
      if (
        !value ||
        Object.keys(value).sort().join() !== "literature_id,transfer_ids" ||
        !Array.isArray(value.transfer_ids) ||
        value.transfer_ids.length > 1000 ||
        value.transfer_ids.some(
          (v) => typeof v !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(v),
        )
      )
        throw new Error("invalid command");
      command = {
        literature_id: parseLiteratureId(value.literature_id),
        transfer_ids: [...value.transfer_ids],
      };
    } catch {
      return Promise.reject(
        new LiteratureCompletionFailure("completion-command"),
      );
    }
    if (this.active.has(command.literature_id))
      return Promise.reject(
        new LiteratureCompletionFailure("completion-active"),
      );
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    const pending = this.run(command, active);
    this.active.set(command.literature_id, pending);
    void pending.then(
      () => this.active.delete(command.literature_id),
      () => this.active.delete(command.literature_id),
    );
    return pending;
  }
  private async run(
    command: CompletionCommand,
    signal: AbortSignal,
  ): Promise<CompletionResult> {
    const id = command.literature_id,
      attempts: CompletionAttempt[] = [],
      tried = new Set<string>();
    const check = () => {
      if (signal.aborted)
        throw new LiteratureCompletionFailure("completion-cancelled");
    };
    check();
    let detail = await this.library.detail(id);
    check();
    if (detail.content)
      return {
        outcome: "content_ready",
        literature_id: id,
        content: detail.content,
        attempts,
      };
    // Capture identities before NoUsableContent removes duplicate durable records. Bytes are verified only when selected.
    const candidates: { id: string; candidate: DurableCandidate | null }[] = [];
    for (const transferId of command.transfer_ids) {
      check();
      const candidate = await this.repository.getCandidate(transferId);
      if (candidate && candidate.capture?.article_id !== id)
        throw new LiteratureCompletionFailure("completion-command");
      candidates.push({ id: transferId, candidate });
    }
    let index = 0,
      processed = 0;
    while (true) {
      check();
      let transferId: string | null = null;
      if (!detail.primary_pdf) {
        let accepted = false;
        while (index < candidates.length) {
          check();
          const next = candidates[index++]!;
          if (!next.candidate) {
            attempts.push({
              transfer_id: next.id,
              outcome: "candidate_missing",
            });
            continue;
          }
          if (tried.has(next.candidate.sha256)) {
            attempts.push({ transfer_id: next.id, outcome: "duplicate_input" });
            continue;
          }
          tried.add(next.candidate.sha256);
          try {
            await this.acceptance.accept(
              {
                literature_id: id,
                transfer_id: next.id,
                receipt_id: `completion:${randomUUID()}`,
                metadata_snapshot: {
                  revision: detail.metadata_revision,
                  sha256: detail.metadata_sha256,
                },
              },
              signal,
            );
          } catch (error) {
            check();
            if (
              error instanceof LiteraturePublicationError &&
              (error.code === "candidate-rejected" ||
                error.code === "candidate-uncertain")
            ) {
              attempts.push({
                transfer_id: next.id,
                outcome:
                  error.code === "candidate-rejected"
                    ? "candidate_rejected"
                    : "candidate_uncertain",
              });
              continue;
            }
            throw error;
          }
          transferId = next.id;
          accepted = true;
          detail = await this.library.detail(id);
          if (detail.content)
            return {
              outcome: "content_ready",
              literature_id: id,
              content: detail.content,
              attempts,
            };
          if (detail.primary_pdf?.asset.sha256 !== next.candidate.sha256)
            throw new LiteratureCompletionFailure("completion-stale");
          break;
        }
        if (!accepted)
          return {
            outcome: "supplied_candidates_exhausted",
            literature_id: id,
            attempts,
          };
      } else {
        if (tried.has(detail.primary_pdf.asset.sha256))
          throw new LiteratureCompletionFailure("completion-stale");
        tried.add(detail.primary_pdf.asset.sha256);
      }
      if (++processed > candidates.length + 1)
        throw new LiteratureCompletionFailure("completion-stale");
      check();
      if (!detail.parser_result) {
        const prepared = await this.parsing.prepareCurrentPrimary(id, signal);
        try {
          check();
          await this.parsing.commitCurrentPrimary(prepared, signal);
        } finally {
          this.parsing.discardPrepared(prepared);
        }
      }
      check();
      const result = await this.analysis.analyzeCurrent(id, signal);
      if (result.outcome === "content_accepted") {
        attempts.push({ transfer_id: transferId, outcome: "content_accepted" });
        return {
          outcome: "content_ready",
          literature_id: id,
          content: result.content,
          attempts,
        };
      }
      if (result.outcome !== "no_usable_content_cleaned")
        throw new LiteratureCompletionFailure("completion-contract");
      attempts.push({ transfer_id: transferId, outcome: "no_usable_content" });
      check();
      detail = await this.library.detail(id);
      if (detail.content)
        return {
          outcome: "content_ready",
          literature_id: id,
          content: detail.content,
          attempts,
        };
    }
  }
  async close(): Promise<void> {
    this.stop.abort();
    await Promise.allSettled([...this.active.values()]);
  }
}
