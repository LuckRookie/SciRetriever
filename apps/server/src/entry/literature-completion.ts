import { randomUUID } from "node:crypto";
import {
  parseLiteratureId,
  type RawParseProfile,
  type ParseDocumentReceipt,
} from "@sciretriever/contracts";
import type { CandidateAcceptanceService } from "../acquisition/candidate-acceptance.js";
import { LiteraturePublicationError } from "../literature/primary-pdf.js";
import type { LiteratureQueryService } from "../literature/query.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { RawParseRepository } from "../parsing/raw-service.js";
import type { DocumentProcessingService } from "../document/service.js";
import {
  directCompletionCommit,
  type CompletionCommit,
} from "./completion-execution.js";
export interface CompletionCommand {
  readonly literature_id: string;
  readonly transfer_ids: readonly string[];
}
export interface CompletionAttempt {
  readonly transfer_id: string;
  readonly outcome:
    | "accepted"
    | "duplicate_input"
    | "candidate_missing"
    | "candidate_rejected"
    | "candidate_uncertain";
}
export type CompletionResult =
  | {
      readonly outcome: "parser_results_ready" | "parsing_failed";
      readonly literature_id: string;
      readonly receipt: ParseDocumentReceipt;
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
/** An explicitly requested completion reaches the raw parser boundary. It never archives, analyzes, or deletes valid input. */
export class LiteratureCompletionService {
  private readonly stop = new AbortController();
  private readonly active = new Map<string, Promise<CompletionResult>>();
  constructor(
    private readonly library: Pick<LiteratureQueryService, "detail">,
    private readonly repository: Pick<SqliteWorker, "getCandidate">,
    private readonly acceptance: Pick<CandidateAcceptanceService, "accept">,
    private readonly documents: Pick<
      DocumentProcessingService,
      "parseDocuments"
    >,
    private readonly raw: Pick<RawParseRepository, "current">,
    private readonly archiveProfile: RawParseProfile = "vlm-engine",
  ) {}
  async isReady(literatureId: string, signal?: AbortSignal): Promise<boolean> {
    const detail = await this.library.detail(parseLiteratureId(literatureId)),
      asset = detail.primary_pdf?.asset;
    if (signal?.aborted)
      throw new LiteratureCompletionFailure("completion-cancelled");
    if (!asset) return false;
    const rows = await this.raw.current(asset.asset_id, signal);
    return rows.some(
      (r) =>
        (r.profile === this.archiveProfile ||
          r.profile === "vlm-engine-markdown-only") &&
        r.result?.source_sha256 === asset.sha256,
    );
  }
  complete(
    value: CompletionCommand,
    signal?: AbortSignal,
    commit: CompletionCommit = directCompletionCommit,
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
          (v) => typeof v !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(v),
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
    const pending = this.run(command, active, commit);
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
    commit: CompletionCommit,
  ): Promise<CompletionResult> {
    const check = () => {
      if (signal.aborted)
        throw new LiteratureCompletionFailure("completion-cancelled");
    };
    check();
    const id = command.literature_id,
      attempts: CompletionAttempt[] = [],
      seen = new Set<string>();
    let detail = await this.library.detail(id);
    check();
    if (!detail.primary_pdf) {
      for (const transfer_id of command.transfer_ids) {
        check();
        const candidate = await this.repository.getCandidate(transfer_id);
        check();
        if (!candidate) {
          attempts.push({ transfer_id, outcome: "candidate_missing" });
          continue;
        }
        if (candidate.capture?.article_id !== id)
          throw new LiteratureCompletionFailure("completion-command");
        if (seen.has(candidate.sha256)) {
          attempts.push({ transfer_id, outcome: "duplicate_input" });
          continue;
        }
        seen.add(candidate.sha256);
        try {
          await commit(() =>
            this.acceptance.accept(
              {
                literature_id: id,
                transfer_id,
                receipt_id: `completion:${randomUUID()}`,
                metadata_snapshot: {
                  revision: detail.metadata_revision,
                  sha256: detail.metadata_sha256,
                },
              },
              signal,
            ),
          );
        } catch (e) {
          if (
            e instanceof LiteraturePublicationError &&
            (e.code === "candidate-rejected" ||
              e.code === "candidate-uncertain")
          ) {
            check();
            attempts.push({
              transfer_id,
              outcome:
                e.code === "candidate-rejected"
                  ? "candidate_rejected"
                  : "candidate_uncertain",
            });
            continue;
          }
          throw e;
        }
        detail = await this.library.detail(id);
        if (detail.primary_pdf?.asset.sha256 !== candidate.sha256)
          throw new LiteratureCompletionFailure("completion-stale");
        attempts.push({ transfer_id, outcome: "accepted" });
        break;
      }
    }
    if (!detail.primary_pdf)
      return {
        outcome: "supplied_candidates_exhausted",
        literature_id: id,
        attempts,
      };
    check();
    const asset = detail.primary_pdf.asset;
    const receipt = await this.documents.parseDocuments(
      {
        literature_id: id,
        asset_id: asset.asset_id,
        asset_sha256: asset.sha256,
        profiles: [this.archiveProfile],
        force: false,
      },
      signal,
      commit,
    );
    if (!receipt.profiles.some((p) => p.failure_code === "parser-publication"))
      check();
    return {
      outcome: receipt.profiles.every((p) => p.status !== "failed")
        ? "parser_results_ready"
        : "parsing_failed",
      literature_id: id,
      receipt,
      attempts,
    };
  }
  async close() {
    this.stop.abort();
    await Promise.allSettled([...this.active.values()]);
  }
}
