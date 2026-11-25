import { randomUUID } from "node:crypto";
import {
  canonicalJsonBytes,
  sha256,
  parseFormDraftsPreviewRequest,
  parseFormDraftsCounts,
  parseFormDraftsPartResult,
  parseAssetId,
  parseLiteratureId,
  parseIntakeTaskScope,
  tagRecord,
  type FormDraftsPreviewRequest,
  type FormDraftsScope,
  type FormDraftsPartResult,
} from "@sciretriever/contracts";
import { ftsMatchQuery, queryTerms } from "../../literature/query.js";
import { currentDraftMethodHash } from "../../document/draft-builder.js";
import type { DraftPublicationService } from "../../document/draft-publication.js";
import type {
  SqliteWorker,
  ExecutionTarget,
} from "../../storage/sqlite/worker.js";
import type { DraftBackfillCandidate } from "../../storage/sqlite/draft-text-engine.js";
import type { SqliteRawParseStorage } from "../../storage/raw-parsing.js";
import {
  normalizeExecutionPolicy,
  type ExecutionRepository,
  type CreateExecutionJobInput,
} from "../../storage/execution/repository.js";
import {
  ExecutionQueue,
  QueueInterruptedError,
  QueueTargetFailureError,
  type ExecutionBatchRunOptions,
} from "./service.js";

type FrozenPart = Pick<
  DraftBackfillCandidate["parts"][number],
  | "asset_id"
  | "asset_sha256"
  | "part"
  | "raw_parse_id"
  | "raw_result_sha256"
  | "known_version_ids"
> & { readonly process: boolean };
interface FrozenTarget {
  readonly literature_id: string;
  readonly version_role: DraftBackfillCandidate["version_role"];
  readonly parts: readonly FrozenPart[];
}
interface Selection {
  readonly scope: FormDraftsScope;
  readonly targets: readonly FrozenTarget[];
}

/** One read-only selection for preview and durable member freezing. */
export class DraftBackfillSelection {
  constructor(
    private readonly database: SqliteWorker,
    private readonly profile: string,
  ) {}
  async select(value: unknown, signal?: AbortSignal): Promise<Selection> {
    const request = parseFormDraftsPreviewRequest(value),
      selector = request.selector;
    const terms =
      selector.kind === "query" && selector.query.text !== null
        ? queryTerms(selector.query.text)
        : null;
    const candidates =
      terms?.length === 0
        ? []
        : await this.database.draftBackfillCandidates(
            selector,
            this.profile,
            terms === null || selector.kind !== "query" || !selector.query.text
              ? null
              : ftsMatchQuery(selector.query.text),
            signal,
          );
    const counts = {
      matched: candidates.length,
      process: 0,
      process_parts: 0,
      skipped_has_draft: 0,
      skipped_no_raw_parse: 0,
      over_limit: 0,
    };
    const targets: FrozenTarget[] = [],
      method = currentDraftMethodHash();
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      const parts = candidate.parts.map((p) => ({
        asset_id: p.asset_id,
        asset_sha256: p.asset_sha256,
        part: p.part,
        raw_parse_id: p.raw_parse_id,
        raw_result_sha256: p.raw_result_sha256,
        known_version_ids: p.known_version_ids,
        process:
          p.raw_parse_id !== null &&
          (!p.has_draft ||
            (request.include_older_method &&
              p.current_method_sha256 !== null &&
              p.current_method_sha256 !== method)),
      }));
      const eligible = parts.filter((p) => p.process).length;
      if (!parts.some((p) => p.raw_parse_id !== null))
        counts.skipped_no_raw_parse++;
      else if (!eligible) counts.skipped_has_draft++;
      else if (
        selector.kind === "query" &&
        selector.limit !== null &&
        targets.length >= selector.limit
      )
        counts.over_limit++;
      else {
        counts.process++;
        counts.process_parts += eligible;
        targets.push({
          literature_id: candidate.literature_id,
          version_role: candidate.version_role,
          parts,
        });
      }
    }
    return {
      scope: { selector, counts: parseFormDraftsCounts(counts) },
      targets,
    };
  }
  async preview(value: unknown, signal?: AbortSignal) {
    return (await this.select(value, signal)).scope.counts;
  }
}

type CreateInput = Omit<CreateExecutionJobInput, "selector"> &
  FormDraftsPreviewRequest;
/** Uses the existing queue, leases, attempts, controls and immutable part receipts. */
export class DraftBackfillService {
  constructor(
    readonly selection: DraftBackfillSelection,
    private readonly repository: ExecutionRepository,
    private readonly queue: ExecutionQueue,
    private readonly raw: Pick<SqliteRawParseStorage, "byId">,
    private readonly publisher: Pick<DraftPublicationService, "publish">,
    private readonly concurrency: number,
  ) {}
  async create(input: CreateInput) {
    const request = parseFormDraftsPreviewRequest({
      selector: input.selector,
      include_older_method: input.include_older_method,
    });
    const jobId =
      input.job_id ??
      `job-${(await sha256(canonicalJsonBytes({ idempotency_key: input.idempotency_key }))).slice(0, 32)}`;
    const existing = await this.repository.getJob(jobId);
    let scope: FormDraftsScope, frozen: readonly FrozenTarget[];
    if (existing) {
      const saved = this.snapshot(existing.selector);
      if (
        existing.idempotency_key !== input.idempotency_key ||
        existing.target_kind !== input.target_kind ||
        !Buffer.from(canonicalJsonBytes(saved.request)).equals(
          Buffer.from(canonicalJsonBytes(request)),
        )
      )
        throw new TypeError("execution job idempotency conflict");
      scope = saved.scope;
      frozen = saved.targets;
    } else {
      const selected = await this.selection.select(request);
      scope = selected.scope;
      frozen = selected.targets;
    }
    if (frozen.length > 10_000)
      throw new TypeError("execution selector is too large");
    const policy = normalizeExecutionPolicy({
      ...input.policy,
      ...(input.policy.max_attempts === undefined
        ? { max_attempts: Math.max(1000, frozen.length) }
        : {}),
    });
    const policy_version = `${input.policy_version}:${await sha256(canonicalJsonBytes(policy))}`;
    if (existing && existing.policy_version !== policy_version)
      throw new TypeError("execution job idempotency conflict");
    const targets: ExecutionTarget[] = frozen.map((target, ordinal) => ({
      job_id: jobId,
      target_id: `${jobId}:${ordinal}`,
      ordinal,
      literature_id: target.literature_id,
      version_role: target.version_role,
      stage: "queued",
      disposition: "pending",
      next_eligible_at: null,
    }));
    return this.repository.createJob({
      ...input,
      job_id: jobId,
      policy,
      policy_version,
      selector: existing?.selector ?? {
        schema_version: 2,
        goal: "draft",
        request,
        scope,
        frozen_targets: frozen,
      },
      ...(existing ? {} : { targets }),
    });
  }
  private snapshot(value: unknown) {
    const r = tagRecord(value, [
      "schema_version",
      "goal",
      "request",
      "scope",
      "frozen_targets",
    ]);
    if (
      r.schema_version !== 2 ||
      r.goal !== "draft" ||
      !Array.isArray(r.frozen_targets) ||
      r.frozen_targets.length > 10_000
    )
      throw new TypeError("draft task snapshot is invalid");
    const request = parseFormDraftsPreviewRequest(r.request),
      scope = parseIntakeTaskScope(r.scope);
    if (!("process_parts" in scope.counts))
      throw new TypeError("draft task scope is invalid");
    const targets = r.frozen_targets.map((item): FrozenTarget => {
      const t = tagRecord(item, ["literature_id", "version_role", "parts"]);
      if (
        !Array.isArray(t.parts) ||
        typeof t.version_role !== "string" ||
        !["published", "accepted-manuscript", "preprint", "other"].includes(
          String(t.version_role),
        )
      )
        throw new TypeError("draft target is invalid");
      return {
        literature_id: parseLiteratureId(t.literature_id),
        version_role: t.version_role as FrozenTarget["version_role"],
        parts: t.parts.map((item): FrozenPart => {
          const p = tagRecord(item, [
            "asset_id",
            "asset_sha256",
            "part",
            "raw_parse_id",
            "raw_result_sha256",
            "known_version_ids",
            "process",
          ]);
          if (
            (p.part !== "main" && p.part !== "supplementary") ||
            typeof p.process !== "boolean" ||
            !Array.isArray(p.known_version_ids) ||
            typeof p.asset_sha256 !== "string" ||
            !/^[a-f0-9]{64}$/u.test(p.asset_sha256) ||
            (p.raw_result_sha256 !== null &&
              (typeof p.raw_result_sha256 !== "string" ||
                !/^[a-f0-9]{64}$/u.test(p.raw_result_sha256))) ||
            (p.raw_parse_id === null) !== (p.raw_result_sha256 === null) ||
            (p.process && p.raw_parse_id === null)
          )
            throw new TypeError("draft part is invalid");
          return {
            asset_id: parseAssetId(p.asset_id),
            asset_sha256: p.asset_sha256,
            part: p.part,
            raw_parse_id:
              p.raw_parse_id === null ? null : parseAssetId(p.raw_parse_id),
            raw_result_sha256: p.raw_result_sha256 as string | null,
            known_version_ids: p.known_version_ids.map(parseAssetId),
            process: p.process,
          };
        }),
      };
    });
    if (scope.counts.process !== targets.length)
      throw new TypeError("draft members are invalid");
    return { request, scope: scope as FormDraftsScope, targets };
  }
  async run(jobId: string, value: unknown, options: ExecutionBatchRunOptions) {
    const snapshot = this.snapshot(value);
    const rows = await this.repository.listTargets(jobId, 10000);
    if (
      rows.length !== snapshot.targets.length ||
      rows.some(
        (r, i) =>
          r.ordinal !== i ||
          r.literature_id !== snapshot.targets[i]!.literature_id,
      )
    )
      throw new TypeError("draft members do not match their targets");
    if (!rows.length) {
      await this.repository.updateJobIfActive(
        jobId,
        "completed",
        new Date().toISOString(),
      );
      return [];
    }
    // Read successful per-part receipts once, including a crash after publish
    // but before the target attempt settled. Failed parts may be retried.
    const settled = new Map<string, FormDraftsPartResult>();
    let after = -1;
    for (;;) {
      const page = await this.repository.listEvents(jobId, after, 1000);
      for (const event of page)
        if (event.kind === "form-drafts-part") {
          const p = tagRecord(event.payload, ["target_id", "part"]);
          const part = parseFormDraftsPartResult(p.part);
          if (part.status !== "failed")
            settled.set(`${String(p.target_id)}:${part.asset_id}`, part);
        }
      if (page.length < 1000) break;
      after = page.at(-1)!.sequence;
    }
    return this.queue.runUntilIdle(
      jobId,
      async (row, signal) => {
        const target = snapshot.targets[row.ordinal]!;
        const parts: FormDraftsPartResult[] = [];
        const receipt = async (partial: boolean) =>
          this.repository.appendEvent({
            event_id: partial
              ? `draft-partial:${randomUUID()}`
              : `${row.target_id}:result`,
            job_id: jobId,
            sequence: -1,
            kind: partial ? "processing-partial-result" : "processing-result",
            payload: {
              target_id: row.target_id,
              operation: "form-drafts",
              result: { literature_id: target.literature_id, parts },
            },
            created_at: new Date().toISOString(),
          });
        for (const part of target.parts) {
          if (signal.aborted) {
            await receipt(true);
            throw new QueueInterruptedError();
          }
          const key = `${row.target_id}:${part.asset_id}`,
            prior = settled.get(key);
          if (prior) {
            parts.push(prior);
            continue;
          }
          let result: FormDraftsPartResult = {
            asset_id: part.asset_id,
            part: part.part,
            status: "skipped",
            document_version_id: null,
            failure_code: null,
            default_changed: false,
          };
          if (part.process) {
            try {
              const raw = await this.raw.byId(part.raw_parse_id!, signal);
              if (
                !raw ||
                raw.result_sha256 !== part.raw_result_sha256 ||
                raw.source_asset_id !== part.asset_id ||
                raw.source_sha256 !== part.asset_sha256
              )
                throw new Error("draft input changed");
              const outcome = await this.publisher.publish(
                {
                  literature_id: target.literature_id,
                  asset_id: part.asset_id,
                  asset_sha256: part.asset_sha256,
                  raw,
                },
                signal,
              );
              if (outcome.status === "not-formed")
                throw new Error("draft was not attempted");
              result =
                outcome.status === "failed"
                  ? {
                      ...result,
                      status: "failed",
                      failure_code: outcome.failure_code,
                    }
                  : {
                      ...result,
                      // Reactivating a version already present at creation is
                      // formation work. Only a version arriving after freezing
                      // is reported as the cross-operation reuse case.
                      status:
                        outcome.status === "reused" &&
                        part.known_version_ids.includes(
                          outcome.document_version_id,
                        )
                          ? "formed"
                          : outcome.status,
                      document_version_id: outcome.document_version_id,
                      default_changed: outcome.default_changed,
                    };
            } catch {
              result = {
                ...result,
                status: "failed",
                failure_code: signal.aborted ? "cancelled" : "source-integrity",
              };
            }
          }
          result = parseFormDraftsPartResult(result);
          parts.push(result);
          await this.repository.appendEvent({
            event_id:
              result.status === "failed"
                ? `draft-failed:${randomUUID()}`
                : `draft-part:${row.target_id}:${part.asset_id}`,
            job_id: jobId,
            sequence: -1,
            kind: "form-drafts-part",
            payload: { target_id: row.target_id, part: result },
            created_at: new Date().toISOString(),
          });
          if (result.status !== "failed") settled.set(key, result);
        }
        if (signal.aborted) {
          await receipt(true);
          throw new QueueInterruptedError();
        }
        const failed = parts.some((p) => p.status === "failed");
        await receipt(failed);
        if (failed)
          throw new QueueTargetFailureError({
            code: "draft-formation-failed",
            reason: "One or more PDF parts could not form a draft.",
            action:
              "Inspect part receipts, correct the input or page tools, and submit again.",
            retryable: false,
          });
        return "completed";
      },
      {
        ...options,
        concurrency: Math.min(
          options.concurrency ?? this.concurrency,
          this.concurrency,
        ),
        max_targets: rows.length,
        max_retries: 0,
        stage_for_target: () => "analysis",
      },
    );
  }
}
