import type { AcquisitionAttempt } from "@sciretriever/contracts";
import { DocumentProcessingError } from "../document/service.js";
import {
  parseDatabaseCompletionReport,
  parseLiteratureId,
  type BatchGoal,
  type CompletedCompletionTarget,
  type CompletionStage,
  type CompletionTarget,
  type DatabaseCompletionReport,
  type FailedCompletionTarget,
  type InterruptedCompletionTarget,
  type LiteratureSearchItem,
  type LiteratureDetail,
  type LiteratureId,
  type MetaLiteratureId,
  type NotStartedCompletionTarget,
  type ReportEnd,
  type SkippedCompletionReason,
  type SkippedCompletionTarget,
  type StableFailure,
  type VersionRole,
  type ParseDocumentReceipt,
} from "@sciretriever/contracts";
import {
  classifyAcquisitionFailure,
  type AcquisitionBatchFailure,
} from "../acquisition/tiered.js";
import {
  LiteratureNotFoundError,
  type LiteratureQueryService,
} from "../literature/query.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { CatalogWriteAdmission } from "../storage/write-admission.js";
import {
  LiteratureCompletionFailure,
  type LiteratureCompletionService,
} from "./literature-completion.js";
import { ParsingFailure } from "../parsing/ports.js";
import type { PdfAcquisitionPort } from "./pdf-acquisition.js";
import {
  CompletionSerialExecutor,
  directCompletionCommit,
  type CompletionExecution,
  type CompletionCommit,
} from "./completion-execution.js";
import {
  explicitRetryLiteratureIds,
  selectCompletionLiteratures,
  type LiteratureSelector,
} from "./selectors.js";
import { randomUUID } from "node:crypto";

/** The frozen scope of one database-completion request. */
export interface DatabaseCompletionRequest {
  readonly selector: LiteratureSelector;
  readonly goal: BatchGoal;
  /** Supplied durable candidate transfers, only meaningful for `PARSER_RESULT_READY`. */
  readonly transfer_ids?: readonly string[];
}

export interface DatabaseCompletionOptions {
  readonly on_pdf_source_result?: (
    target: CompletionTarget,
    result: import("@sciretriever/contracts").PdfSourceResult,
  ) => Promise<void>;
  readonly on_acquisition_attempt?: (
    target: CompletionTarget,
    literatureId: LiteratureId,
    attempt: AcquisitionAttempt,
  ) => Promise<void>;
  readonly signal?: AbortSignal | undefined;
  /** The immutable scope after selection, before any target starts. Feedback only. */
  readonly on_scope?: (targets: readonly CompletionTarget[]) => void;
  readonly on_progress?: (progress: DatabaseCompletionProgress) => void;
  /** False stops later admission without cancelling already running targets. */
  readonly on_target_start?: (
    target: CompletionTarget,
  ) => Promise<boolean | void>;
  /** Durable policy may stop admission after a settled target; true stops later targets. */
  readonly on_target_finish?: (
    target: CompletionTarget,
    outcome: DatabaseCompletionTargetOutcome,
  ) => Promise<boolean>;
}

export interface DatabaseCompletionProgress {
  readonly target: CompletionTarget;
  readonly literature_id: LiteratureId | null;
  readonly state:
    | "started"
    | "completed"
    | "failed"
    | "skipped"
    | "interrupted";
  /** The stable failure behind this state, including a deliberate skip. */
  readonly failure: StableFailure | null;
}

export interface DatabaseCompletionTargetPorts {
  readonly library: Pick<LiteratureQueryService, "detail">;
  readonly database: Pick<
    SqliteWorker,
    | "currentFacts"
    | "hasAutomaticPdfExhaustion"
    | "setAutomaticPdfExhaustion"
    | "clearAutomaticPdfExhaustion"
  > | null;
  readonly completion: Pick<
    LiteratureCompletionService,
    "complete" | "isReady"
  > | null;
  /** `null` means the automatic route set is not wired for this caller. */
  readonly acquisition: PdfAcquisitionPort | null;
  /** Production enables automatic PDF acquisition before PARSER_RESULT_READY parsing. */
  readonly automatic_pdf_for_parsing?: boolean;
}

export interface DatabaseCompletionPorts extends DatabaseCompletionTargetPorts {
  readonly selectionWrites?: Pick<
    SqliteWorker,
    "writeLibrarySelection" | "collectLiteratures"
  >;
  readonly library: Pick<
    LiteratureQueryService,
    "search" | "selectionSnapshot" | "detail"
  >;
  readonly writes: Pick<CatalogWriteAdmission, "run">;
  /** Bootstrap supplies the existing execution setting; direct callers default to one. */
  readonly max_concurrency?: number;
  /** Production enables automatic PDF acquisition before PARSER_RESULT_READY parsing. */
  readonly automatic_pdf_for_parsing?: boolean;
}

/** The single final partition of one frozen target. */
export interface DatabaseCompletionTargetOutcome {
  readonly partition: "completed" | "failed" | "skipped" | "interrupted";
  readonly literature_id: LiteratureId | null;
  readonly stage: CompletionStage;
  readonly failure: StableFailure | null;
  readonly skipped_reason: SkippedCompletionReason | null;
  readonly skipped_literature_ids: readonly LiteratureId[];
  /** An unrecoverable shared-dependency failure stops the remaining schedule. */
  readonly operation_failure: boolean;
  readonly receipt?: ParseDocumentReceipt;
}

export interface FrozenCompletionTarget {
  readonly target: CompletionTarget;
  readonly candidates: readonly LiteratureId[];
  readonly clear_exhaustion: boolean;
}
type FrozenTarget = FrozenCompletionTarget;

type CandidateOutcome =
  | {
      readonly kind: "completed";
      readonly literature_id: LiteratureId;
      readonly receipt?: ParseDocumentReceipt;
    }
  | { readonly kind: "exhausted"; readonly literature_id: LiteratureId }
  | { readonly kind: "satisfied"; readonly literature_id: LiteratureId }
  | {
      readonly kind: "skipped";
      readonly reason: SkippedCompletionReason;
      readonly failure: StableFailure | null;
      readonly literature_id: LiteratureId | null;
    }
  | {
      readonly kind: "interrupted";
      readonly literature_id: LiteratureId | null;
    }
  | {
      readonly kind: "failed";
      readonly stage: CompletionStage;
      readonly failure: StableFailure;
      readonly literature_id: LiteratureId | null;
      readonly operation: boolean;
    };

const TRANSFER_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const VERSION_RANK: Record<VersionRole, number> = {
  published: 0,
  "accepted-manuscript": 1,
  preprint: 2,
  other: 3,
};

function stableFailure(
  code: string,
  reason: string,
  action: string,
  retryable: boolean,
): StableFailure {
  return Object.freeze({ code, reason, action, retryable });
}

async function goalSatisfied(
  item: LiteratureSearchItem,
  goal: BatchGoal,
  completion: DatabaseCompletionTargetPorts["completion"],
  signal?: AbortSignal,
): Promise<boolean> {
  if (goal === "ASSET_READY") return item.missing_step !== "primary-pdf";
  return completion
    ? completion.isReady(item.literature.literature_id, signal)
    : false;
}

function stepRank(step: LiteratureSearchItem["missing_step"]): number {
  if (step === null) return 0;
  return step === "primary-pdf" ? 3 : step === "raw-parse" ? 2 : 1;
}

function candidateRank(item: LiteratureSearchItem): readonly number[] {
  return [
    stepRank(item.missing_step),
    VERSION_RANK[item.literature.version_role],
  ];
}

function compareCandidates(
  left: LiteratureSearchItem,
  right: LiteratureSearchItem,
): number {
  const a = candidateRank(left);
  const b = candidateRank(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return left.literature.literature_id < right.literature.literature_id
    ? -1
    : 1;
}

function acquisitionFailure(failure: AcquisitionBatchFailure): StableFailure {
  const code =
    failure.code === "rate-limited"
      ? "pdf-rate-limited"
      : failure.code === "http-response-failed"
        ? "pdf-http-response-failed"
        : failure.code === "network-failed"
          ? "pdf-network-failed"
          : failure.code === "source-discovery-failed"
            ? "pdf-route-discovery-failed"
            : failure.code === "candidate-download-failed"
              ? "pdf-route-delivery-failed"
              : failure.code === "source-cooldown"
                ? "pdf-route-cooling-down"
                : failure.code === "assistance-required"
                  ? "pdf-assistance-required"
                  : failure.code === "assistance-skipped"
                    ? "pdf-assistance-skipped"
                    : failure.code === "execution-cancelled"
                      ? "pdf-acquisition-cancelled"
                      : "pdf-route-unavailable";
  return stableFailure(
    code,
    failure.reason,
    "Review the automatic route evidence, then retry the target or supply a verified PDF.",
    failure.retryable,
  );
}

/** One complete-target unit shared by the CLI orchestrator and durable jobs. */
export class DatabaseCompletionTargetRunner {
  constructor(private readonly ports: DatabaseCompletionTargetPorts) {}

  async runTarget(
    literatureId: LiteratureId,
    options: {
      readonly goal: BatchGoal;
      readonly transfer_ids?: readonly string[];
      readonly signal?: AbortSignal | undefined;
      readonly clear_exhaustion?: boolean;
      /** Frozen targets report `already-satisfied` when another commit met the goal. */
      readonly explicit_target?: boolean;
      readonly execution?: CompletionExecution;
    },
  ): Promise<DatabaseCompletionTargetOutcome> {
    const id = parseLiteratureId(literatureId);
    const goal = options.goal;
    if (goal !== "ASSET_READY" && goal !== "PARSER_RESULT_READY")
      throw new TypeError("completion goal is invalid");
    const signal = options.signal ?? new AbortController().signal;
    const transfers = options.transfer_ids ?? [];
    const outcome = await this.completeCandidate(
      id,
      goal,
      transfers,
      signal,
      options.clear_exhaustion === true,
      options.explicit_target === true,
      options.execution ?? {
        commit: directCompletionCommit,
        acquire: directCompletionCommit,
        generation: 0,
        operation_id: "direct",
      },
    );
    return this.partitionOf(outcome, id);
  }

  private partitionOf(
    outcome: CandidateOutcome,
    candidate: LiteratureId,
  ): DatabaseCompletionTargetOutcome {
    if (outcome.kind === "completed")
      return {
        partition: "completed",
        literature_id: outcome.literature_id,
        stage: "literature",
        failure: null,
        skipped_reason: null,
        skipped_literature_ids: [],
        operation_failure: false,
        ...(outcome.receipt ? { receipt: outcome.receipt } : {}),
      };
    if (outcome.kind === "exhausted")
      return {
        partition: "skipped",
        literature_id: null,
        stage: "acquisition",
        failure: null,
        skipped_reason: "manual-pdf-required",
        skipped_literature_ids: [outcome.literature_id],
        operation_failure: false,
      };
    if (outcome.kind === "satisfied")
      return {
        partition: "skipped",
        literature_id: null,
        stage: "literature",
        failure: null,
        skipped_reason: "already-satisfied",
        skipped_literature_ids: [outcome.literature_id],
        operation_failure: false,
      };
    if (outcome.kind === "skipped")
      return {
        partition: "skipped",
        literature_id: null,
        stage: "acquisition",
        failure: outcome.failure,
        skipped_reason: outcome.reason,
        skipped_literature_ids: outcome.literature_id
          ? [outcome.literature_id]
          : [],
        operation_failure: false,
      };
    if (outcome.kind === "interrupted")
      return {
        partition: "interrupted",
        literature_id: outcome.literature_id,
        stage: "literature",
        failure: null,
        skipped_reason: null,
        skipped_literature_ids: [],
        operation_failure: false,
      };
    return {
      partition: "failed",
      literature_id: outcome.literature_id ?? candidate,
      stage: outcome.stage,
      failure: outcome.failure,
      skipped_reason: null,
      skipped_literature_ids: [],
      operation_failure: outcome.operation,
    };
  }

  private async completeCandidate(
    id: LiteratureId,
    goal: BatchGoal,
    transfer_ids: readonly string[],
    signal: AbortSignal,
    clearExhaustion: boolean,
    explicitTarget: boolean,
    execution: CompletionExecution,
  ): Promise<CandidateOutcome> {
    if (signal.aborted) return { kind: "interrupted", literature_id: id };
    let detail: LiteratureDetail;
    try {
      detail = await this.ports.library.detail(id);
    } catch (error) {
      if (error instanceof LiteratureNotFoundError)
        return {
          kind: "failed",
          stage: "literature",
          failure: stableFailure(
            "literature-not-found",
            "The frozen target no longer exists in the database.",
            "Recreate the target scope and retry.",
            false,
          ),
          literature_id: id,
          operation: false,
        };
      throw error;
    }
    if (signal.aborted) return { kind: "interrupted", literature_id: id };
    if (await goalSatisfied(detail, goal, this.ports.completion, signal)) {
      if (explicitTarget) return { kind: "satisfied", literature_id: id };
      return { kind: "completed", literature_id: id };
    }
    if (
      !detail.primary_pdf &&
      !clearExhaustion &&
      (await this.ports.database?.hasAutomaticPdfExhaustion(id))
    )
      return signal.aborted
        ? { kind: "interrupted", literature_id: id }
        : { kind: "exhausted", literature_id: id };
    if (signal.aborted) return { kind: "interrupted", literature_id: id };
    if (goal === "ASSET_READY")
      return execution.acquire(() =>
        this.acquirePdf(
          id,
          detail,
          signal,
          clearExhaustion,
          execution.commit,
          execution,
        ),
      );
    // PARSER_RESULT_READY with no supplied durable candidate first uses the same
    // admitted automatic PDF path as ASSET_READY. Once the receipt is committed,
    // re-read the concrete Literature and continue through the raw parsing owner. A stable automatic exhaustion remains a manual intervention;
    // it is never passed to the content service as if a PDF existed.
    if (
      !detail.primary_pdf &&
      transfer_ids.length === 0 &&
      this.ports.acquisition &&
      this.ports.automatic_pdf_for_parsing === true
    ) {
      const acquired = await execution.acquire(() =>
        this.acquirePdf(
          id,
          detail,
          signal,
          clearExhaustion,
          execution.commit,
          execution,
        ),
      );
      if (acquired.kind !== "completed") return acquired;
      detail = await this.ports.library.detail(id);
      if (signal.aborted) return { kind: "interrupted", literature_id: id };
    }
    return this.completeParsing(id, transfer_ids, signal, execution.commit);
  }

  private async acquirePdf(
    id: LiteratureId,
    detail: LiteratureDetail,
    signal: AbortSignal,
    clearExhaustion: boolean,
    commit: CompletionCommit,
    execution: CompletionExecution,
  ): Promise<CandidateOutcome> {
    if (detail.primary_pdf) return { kind: "completed", literature_id: id };
    const acquisition = this.ports.acquisition;
    if (!acquisition)
      // The automatic route set is not wired for this caller. A durable job
      // turns this stable failure into an explicit intervention instead of
      // claiming the target was deliberately skipped.
      return {
        kind: "failed",
        stage: "acquisition",
        failure: stableFailure(
          "pdf-acquisition-required",
          "No durable primary PDF is available for this target and no automatic route is wired.",
          "Provide a verified PDF or enable an admitted acquisition route, then retry.",
          false,
        ),
        literature_id: id,
        operation: false,
      };
    const database = this.ports.database;
    if (!database)
      throw new TypeError("completion target ports are incomplete");
    if (clearExhaustion && (await database.hasAutomaticPdfExhaustion(id))) {
      if (signal.aborted) return { kind: "interrupted", literature_id: id };
      await commit(() => database.clearAutomaticPdfExhaustion(id));
    }
    const facts = await database.currentFacts(id);
    if (signal.aborted) return { kind: "interrupted", literature_id: id };
    if (!facts) throw new LiteratureNotFoundError();
    let outcome;
    try {
      const request = {
        literature_id: id,
        detail,
        ...(execution.on_pdf_source_result
          ? { on_source_result: execution.on_pdf_source_result }
          : {}),
        metadata_snapshot: facts.metadata_snapshot,
        ...(execution.on_acquisition_attempt
          ? {
              on_attempt: (attempt: AcquisitionAttempt) =>
                execution.on_acquisition_attempt!(id, attempt),
            }
          : {}),
        signal,
        commit,
        generation: execution.generation,
        operation_id: execution.operation_id,
      } as const;
      outcome = await acquisition.acquire(request);
    } catch (error) {
      // Only route failures are values here; anything escaping the port is a
      // shared-dependency failure that must stop the remaining schedule.
      const kind = classifyAcquisitionFailure(error, signal);
      if (kind === "cancel") return { kind: "interrupted", literature_id: id };
      return {
        kind: "failed",
        stage: "acquisition",
        failure: stableFailure(
          kind === "storage" || kind === "receipt"
            ? "pdf-acquisition-storage-failed"
            : kind === "contract"
              ? "pdf-acquisition-contract"
              : "pdf-acquisition-failed",
          "Automatic PDF acquisition failed outside a route outcome.",
          "Inspect the acquisition boundary, then retry the target.",
          false,
        ),
        literature_id: id,
        operation: true,
      };
    }
    if (outcome.kind === "acquired")
      return {
        kind: "completed",
        literature_id: outcome.literature_id,
      };
    if (outcome.kind === "exhausted") {
      // Every current automatic route finished normally without an unresolved
      // failure, so this is the only place allowed to commit the durable fact.
      await commit(() => database.setAutomaticPdfExhaustion(id));
      return { kind: "exhausted", literature_id: id };
    }
    if (outcome.kind === "browser-failure")
      // A Browser-tier failure keeps its own stable code instead of being flattened
      // into a generic route failure. It is a per-target failure: it never stops the
      // remaining schedule and never writes an exhaustion fact.
      return {
        kind: "failed",
        stage: "acquisition",
        failure: stableFailure(
          outcome.code.startsWith("browser-")
            ? `pdf-${outcome.code}`
            : /^pdf-reader-[a-z0-9-]{1,96}$/u.test(outcome.code)
              ? outcome.code
              : "pdf-browser-unavailable",
          outcome.reason,
          outcome.code === "browser-rate-limited"
            ? "Wait for the platform Retry-After and shared cooldown before retrying; do not switch routes to evade the limit."
            : outcome.code === "browser-runtime-unavailable"
              ? "Set SCIRETRIEVER_CLOAK_BUNDLE to a verified installed Cloak bundle (or use the bundled portable runtime), then restart and retry."
              : "Inspect the reported Browser page state or route availability, then retry when the required condition is resolved.",
          outcome.code === "browser-rate-limited",
        ),
        literature_id: id,
        operation: false,
      };
    if (outcome.kind === "assistance-required")
      // Action required is a target failure, never a user-controlled stop.
      return {
        kind: "failed",
        stage: "acquisition",
        failure: acquisitionFailure(outcome.failure),
        literature_id: id,
        operation: false,
      };
    if (outcome.kind === "policy-skip")
      // The notify policy did not continue this eligible target: it is an explicit,
      // non-executed skip in the report (`skipped`/`not-eligible`), never a failure
      // partition. The stable `pdf-assistance-skipped` code stays on the progress detail —
      // and therefore on the CLI stderr line — instead of being dropped.
      return {
        kind: "skipped",
        reason: "not-eligible",
        failure: acquisitionFailure(outcome.failure),
        literature_id: id,
      };
    if (outcome.kind === "cancelled")
      return { kind: "interrupted", literature_id: id };
    return {
      kind: "failed",
      stage: "acquisition",
      failure: acquisitionFailure(outcome.failure),
      literature_id: id,
      operation: false,
    };
  }

  private async completeParsing(
    id: LiteratureId,
    transfer_ids: readonly string[],
    signal: AbortSignal,
    commit: CompletionCommit,
  ): Promise<CandidateOutcome> {
    const completion = this.ports.completion;
    if (!completion)
      return {
        kind: "failed",
        stage: "literature",
        failure: stableFailure(
          "parser-completion-unavailable",
          "The target cannot continue without the configured completion services.",
          "Configure raw Parsing, then retry the target.",
          false,
        ),
        literature_id: id,
        operation: false,
      };
    let result;
    try {
      result = await completion.complete(
        { literature_id: id, transfer_ids: [...transfer_ids] },
        signal,
        commit,
      );
    } catch (error) {
      if (
        error instanceof ParsingFailure ||
        error instanceof DocumentProcessingError
      ) {
        const publication = error.code === "parser-publication";
        if (!publication && signal.aborted)
          return { kind: "interrupted", literature_id: id };
        return {
          kind: "failed",
          literature_id: id,
          stage: "parsing",
          failure: stableFailure(
            publication
              ? "completion-storage-failed"
              : "completion-parsing-failed",
            "The raw parsing stage did not reach both profile publication boundaries.",
            "Inspect raw parsing status and retry the target; successful profiles and the PDF are preserved.",
            !publication,
          ),
          operation: publication,
        };
      }
      if (error instanceof LiteratureCompletionFailure) {
        if (error.code === "completion-cancelled")
          return signal.aborted
            ? { kind: "interrupted", literature_id: id }
            : {
                kind: "failed",
                stage: "literature",
                failure: stableFailure(
                  "completion-cancelled",
                  "The completion attempt stopped before reaching its boundary.",
                  "Retry the target when the shared capability is available.",
                  true,
                ),
                literature_id: id,
                operation: false,
              };
        if (error.code === "completion-command" && transfer_ids.length > 0)
          // A supplied candidate belongs to another concrete version; that is
          // one not-eligible candidate, never a system failure.
          return {
            kind: "skipped",
            reason: "not-eligible",
            failure: stableFailure(
              "completion-candidate-mismatch",
              "The supplied candidate is not bound to this concrete Literature.",
              "Supply a candidate captured for this Literature or select its version.",
              false,
            ),
            literature_id: id,
          };
        const table: Record<
          Exclude<LiteratureCompletionFailure["code"], "completion-cancelled">,
          {
            readonly code: string;
            readonly operation: boolean;
            readonly retryable: boolean;
          }
        > = {
          "completion-active": {
            code: "completion-already-active",
            operation: false,
            retryable: true,
          },
          "completion-command": {
            code: "completion-command-invalid",
            operation: true,
            retryable: false,
          },
          "completion-closed": {
            code: "completion-service-closed",
            operation: true,
            retryable: false,
          },
          "completion-stale": {
            code: "completion-stale",
            operation: false,
            retryable: true,
          },
          "completion-contract": {
            code: "completion-contract",
            operation: true,
            retryable: false,
          },
        };
        const entry = table[error.code];
        return {
          kind: "failed",
          stage: "literature",
          failure: stableFailure(
            entry.code,
            "The completion attempt did not reach its boundary.",
            "Retry the target after inspecting the persisted facts.",
            entry.retryable,
          ),
          literature_id: id,
          operation: entry.operation,
        };
      }
      const kind = classifyAcquisitionFailure(error, signal);
      if (kind === "cancel") return { kind: "interrupted", literature_id: id };
      return {
        kind: "failed",
        stage: "literature",
        failure: stableFailure(
          kind === "storage" || kind === "receipt"
            ? "completion-storage-failed"
            : kind === "contract"
              ? "completion-contract"
              : "completion-failed",
          "The completion attempt failed outside a candidate outcome.",
          "Inspect the persisted attempt and retry the target.",
          false,
        ),
        literature_id: id,
        // Storage, receipt, contract and unknown internal failures are shared
        // dependencies: they stop the remaining schedule instead of being
        // hidden inside one target.
        operation: true,
      };
    }
    if (result.outcome === "parser_results_ready")
      return { kind: "completed", literature_id: id, receipt: result.receipt };
    if (result.outcome === "parsing_failed") {
      const storage = result.receipt.profiles.some(
        (p) => p.failure_code === "parser-publication",
      );
      if (!storage && signal.aborted)
        return { kind: "interrupted", literature_id: id };
      return {
        kind: "failed",
        stage: "parsing",
        failure: stableFailure(
          storage ? "completion-storage-failed" : "completion-parsing-failed",
          "One or more raw parsing profiles could not be published.",
          "Inspect raw parsing status and retry; successful profiles are reused.",
          !storage,
        ),
        literature_id: id,
        operation: storage,
      };
    }
    return {
      kind: "failed",
      stage: "acquisition",
      failure: stableFailure(
        "completion-candidates-exhausted",
        "No supplied or current primary PDF is available.",
        "Provide an eligible PDF or run automatic PDF acquisition, then retry.",
        false,
      ),
      literature_id: id,
      operation: false,
    };
  }
}

/** One run owns and drains its workers, acquisition lane and commit executor. */
class DatabaseCompletionOperation {
  constructor(
    readonly max_concurrency: number,
    private readonly requestedSignal: AbortSignal,
    private readonly onProgress: DatabaseCompletionOptions["on_progress"],
    private readonly onTargetStart: DatabaseCompletionOptions["on_target_start"],
    private readonly onTargetFinish: DatabaseCompletionOptions["on_target_finish"],
  ) {}

  private notify(progress: DatabaseCompletionProgress): boolean {
    try {
      this.onProgress?.(Object.freeze(progress));
      return true;
    } catch {
      // Progress is best-effort feedback, never a source of report or commit decisions.
      // Do not forward the callback exception: it may contain unredacted sink data.
      return false;
    }
  }

  async run(
    targets: readonly FrozenTarget[],
    execute: (
      target: FrozenTarget,
      signal: AbortSignal,
      execution: CompletionExecution,
    ) => Promise<DatabaseCompletionTargetOutcome>,
  ): Promise<{
    readonly outcomes: ReadonlyMap<
      FrozenTarget,
      DatabaseCompletionTargetOutcome
    >;
    readonly end: ReportEnd;
  }> {
    const stop = new AbortController();
    const signal = AbortSignal.any([this.requestedSignal, stop.signal]);
    const operationId = randomUUID();
    const commits = new CompletionSerialExecutor(signal);
    const outcomes = new Map<FrozenTarget, DatabaseCompletionTargetOutcome>();
    let admissionStopped = false;
    const execution: CompletionExecution = {
      commit: commits.run,
      acquire: directCompletionCommit,
      // Ordinary refills and per-target retries share this operation epoch.
      // Advancing it would invalidate sibling Browser sessions still downloading.
      generation: 0,
      operation_id: operationId,
    };
    let next = 0;
    const worker = async () => {
      while (!signal.aborted && !admissionStopped) {
        const frozen = targets[next++];
        if (!frozen) return;
        if (signal.aborted || admissionStopped) return;
        let outcome: DatabaseCompletionTargetOutcome;
        try {
          const admitted = await this.onTargetStart?.(frozen.target);
          if (admitted === false) {
            admissionStopped = true;
            return;
          }
          this.notify({
            target: frozen.target,
            literature_id: frozen.candidates[0] ?? null,
            state: "started",
            failure: null,
          });
          outcome = await execute(frozen, signal, execution);
        } catch (error) {
          const kind = classifyAcquisitionFailure(error, signal);
          outcome = {
            partition: kind === "cancel" ? "interrupted" : "failed",
            literature_id: frozen.candidates[0] ?? null,
            stage: "literature",
            failure:
              kind === "cancel"
                ? null
                : stableFailure(
                    kind === "storage" || kind === "receipt"
                      ? "completion-storage-failed"
                      : kind === "contract"
                        ? "completion-contract"
                        : "completion-operation-failed",
                    "The completion operation stopped on a shared dependency.",
                    "Inspect the database and file boundary, then retry the scope.",
                    false,
                  ),
            operation_failure: kind !== "cancel",
            skipped_reason: null,
            skipped_literature_ids: [],
          };
        }
        let policyStop = false;
        try {
          policyStop =
            (await this.onTargetFinish?.(frozen.target, outcome)) === true;
        } catch {
          outcome = {
            partition: "failed",
            literature_id: outcome.literature_id,
            stage: "literature",
            failure: stableFailure(
              "completion-operation-failed",
              "The completion operation stopped on a shared dependency.",
              "Inspect the database and file boundary, then retry the scope.",
              false,
            ),
            operation_failure: true,
            skipped_reason: null,
            skipped_literature_ids: [],
          };
        }
        outcomes.set(frozen, outcome);
        // Policy stops later admission but lets already running targets
        // and receipt waves finish. Shared failures still abort siblings.
        if (policyStop) admissionStopped = true;
        if (outcome.operation_failure) stop.abort();
        this.notify({
          target: frozen.target,
          literature_id: outcome.literature_id ?? frozen.candidates[0] ?? null,
          state: outcome.partition,
          failure: outcome.failure,
        });
      }
    };
    try {
      await Promise.all(
        Array.from(
          { length: Math.min(this.max_concurrency, targets.length) },
          worker,
        ),
      );
    } finally {
      await commits.drain();
    }
    // A failure dominates cancellation. Frozen order also makes simultaneous
    // shared failures deterministic without discarding any individual failure.
    const failure = targets
      .map((target) => outcomes.get(target))
      .find((outcome) => outcome?.operation_failure)?.failure;
    const interrupted = [...outcomes.values()].some(
      (outcome) => outcome.partition === "interrupted",
    );
    const end: ReportEnd = failure
      ? { kind: "failed", failure }
      : interrupted ||
          ((signal.aborted || admissionStopped) &&
            outcomes.size < targets.length)
        ? { kind: "interrupted" }
        : { kind: "finished" };
    return { outcomes, end };
  }
}

/**
 * Non-persistent database-completion orchestration: it freezes the selector
 * once, isolates every target, honours cancellation, and returns one
 * `DatabaseCompletionReport`. It never writes logs into the report and never
 * re-expands the selector while the run is in progress.
 */
export class DatabaseCompletionService {
  private readonly runner: DatabaseCompletionTargetRunner;
  private readonly maxConcurrency: number;
  constructor(private readonly ports: DatabaseCompletionPorts) {
    this.maxConcurrency = ports.max_concurrency ?? 1;
    if (
      !Number.isSafeInteger(this.maxConcurrency) ||
      this.maxConcurrency < 1 ||
      this.maxConcurrency > 64
    )
      throw new TypeError("completion concurrency is invalid");
    this.runner = new DatabaseCompletionTargetRunner(ports);
  }

  async run(
    request: DatabaseCompletionRequest,
    options: DatabaseCompletionOptions = {},
  ): Promise<DatabaseCompletionReport> {
    const goal = request.goal;
    if (goal !== "ASSET_READY" && goal !== "PARSER_RESULT_READY")
      throw new TypeError("completion goal is invalid");
    const transferIds = this.normalizeTransfers(request.transfer_ids ?? []);
    // Freeze once under admission; network/model/file preparation must not hold
    // the catalog lock. Each publication owns its short admission and CAS.
    const selection = this.ports.selectionWrites;
    const targets = await (selection
      ? selection.writeLibrarySelection(
          () =>
            this.freeze(request.selector, goal, (ids) =>
              selection.collectLiteratures(ids),
            ),
          options.signal,
        )
      : this.ports.writes.run(() => this.freeze(request.selector, goal)));
    return this.runAdmitted(targets, goal, transferIds, options);
  }

  /** Snapshot used when a durable Job is created; the returned candidate order is immutable. */
  async freezeRequest(
    request: DatabaseCompletionRequest,
  ): Promise<readonly FrozenCompletionTarget[]> {
    if (
      request.goal !== "ASSET_READY" &&
      request.goal !== "PARSER_RESULT_READY"
    )
      throw new TypeError("completion goal is invalid");
    this.normalizeTransfers(request.transfer_ids ?? []);
    return this.ports.writes.run(() =>
      this.freeze(request.selector, request.goal),
    );
  }

  /** Run exactly the persisted targets, without re-expanding their original selector. */
  async runFrozen(
    targets: readonly FrozenCompletionTarget[],
    goal: BatchGoal,
    options: DatabaseCompletionOptions = {},
  ): Promise<DatabaseCompletionReport> {
    if (goal !== "ASSET_READY" && goal !== "PARSER_RESULT_READY")
      throw new TypeError("completion goal is invalid");
    const keys = new Set<string>();
    for (const frozen of targets) {
      const key =
        frozen.target.kind === "literature"
          ? `literature:${frozen.target.literature_id}`
          : `meta-literature:${frozen.target.meta_literature_id}`;
      if (
        keys.has(key) ||
        !frozen.candidates.length ||
        frozen.candidates.some((id) => parseLiteratureId(id) !== id) ||
        (frozen.target.kind === "literature" &&
          (frozen.candidates.length !== 1 ||
            frozen.candidates[0] !== frozen.target.literature_id))
      )
        throw new TypeError("frozen completion targets are invalid");
      keys.add(key);
    }
    return this.runAdmitted(targets, goal, [], options);
  }

  private async runAdmitted(
    targets: readonly FrozenTarget[],
    goal: BatchGoal,
    transferIds: readonly string[],
    options: DatabaseCompletionOptions,
  ): Promise<DatabaseCompletionReport> {
    try {
      options.on_scope?.(
        Object.freeze(
          targets.map(
            (item): CompletionTarget =>
              Object.freeze(
                item.target.kind === "literature"
                  ? {
                      kind: "literature",
                      literature_id: item.target.literature_id,
                    }
                  : {
                      kind: "meta-literature",
                      meta_literature_id: item.target.meta_literature_id,
                    },
              ),
          ),
        ),
      );
    } catch {
      // Feedback cannot change the frozen operation or leak callback details.
    }
    const signal = options.signal ?? new AbortController().signal;
    const completed: CompletedCompletionTarget[] = [];
    const failed: FailedCompletionTarget[] = [];
    const skipped: SkippedCompletionTarget[] = [];
    const notStarted: NotStartedCompletionTarget[] = [];
    const interrupted: InterruptedCompletionTarget[] = [];
    const operation = new DatabaseCompletionOperation(
      this.maxConcurrency,
      signal,
      options.on_progress,
      options.on_target_start,
      options.on_target_finish,
    );
    const { outcomes, end } = await operation.run(
      targets,
      (frozen, active, execution) =>
        this.completeTarget(frozen, goal, transferIds, active, {
          ...execution,
          ...(options.on_pdf_source_result
            ? {
                on_pdf_source_result: (
                  result: import("@sciretriever/contracts").PdfSourceResult,
                ) => options.on_pdf_source_result!(frozen.target, result),
              }
            : {}),
          ...(options.on_acquisition_attempt
            ? {
                on_acquisition_attempt: (
                  literatureId: LiteratureId,
                  attempt: AcquisitionAttempt,
                ) =>
                  options.on_acquisition_attempt!(
                    frozen.target,
                    literatureId,
                    attempt,
                  ),
              }
            : {}),
        }),
    );
    // Results are projected in frozen order, independent of worker completion order.
    for (const frozen of targets) {
      const outcome = outcomes.get(frozen);
      if (!outcome) {
        notStarted.push({ target: frozen.target });
        continue;
      }
      const literatureId =
        outcome.literature_id ?? frozen.candidates[0] ?? null;
      if (outcome.partition === "completed")
        completed.push({
          target: frozen.target,
          literature_id: literatureId!,
          ...(outcome.receipt ? { receipt: outcome.receipt } : {}),
        });
      else if (outcome.partition === "failed")
        failed.push({
          target: frozen.target,
          literature_id: outcome.literature_id,
          stage: outcome.stage,
          failure: outcome.failure!,
        });
      else if (outcome.partition === "skipped")
        skipped.push({
          target: frozen.target,
          reason: outcome.skipped_reason!,
          literature_ids: outcome.skipped_literature_ids,
        });
      else
        interrupted.push({
          target: frozen.target,
          literature_id: outcome.literature_id,
        });
    }
    return parseDatabaseCompletionReport({
      kind: "database-completion",
      end,
      goal,
      completed,
      failed,
      skipped,
      notStarted,
      interrupted,
    });
  }

  private normalizeTransfers(
    transfer_ids: readonly string[],
  ): readonly string[] {
    if (!Array.isArray(transfer_ids) || transfer_ids.length > 1000)
      throw new TypeError("completion transfers are invalid");
    const seen = new Set<string>();
    for (const transfer of transfer_ids) {
      if (typeof transfer !== "string" || !TRANSFER_ID_RE.test(transfer))
        throw new TypeError("completion transfers are invalid");
      seen.add(transfer);
    }
    return Object.freeze([...seen]);
  }

  /**
   * Freezes the selector expansion once. Ordinary scopes dedupe by
   * MetaLiterature, drop scopes whose goal is already reached, and order the
   * remaining version candidates by completeness, version role and stable ID.
   * `literatures` stays a strict per-version scope and is the only selector
   * that may clear an exhausted automatic fact before acquisition.
   */
  private async freeze(
    selector: LiteratureSelector,
    goal: BatchGoal,
    collect?: (ids: readonly LiteratureId[]) => Promise<void>,
  ): Promise<readonly FrozenTarget[]> {
    const page = await selectCompletionLiteratures(
      this.ports.library,
      selector,
    );
    await collect?.(page.items.map((item) => item.literature.literature_id));
    if (selector.kind === "literatures") {
      const explicit = new Set(explicitRetryLiteratureIds(selector));
      return Object.freeze(
        page.items.map((item) => {
          const id = item.literature.literature_id;
          return Object.freeze({
            target: Object.freeze({
              kind: "literature",
              literature_id: id,
            } as const),
            candidates: Object.freeze([id]),
            clear_exhaustion: explicit.has(id),
          });
        }),
      );
    }
    const groups = new Map<MetaLiteratureId, LiteratureSearchItem[]>();
    for (const item of page.items) {
      const meta = item.literature.meta_literature_id;
      const group = groups.get(meta);
      if (group) group.push(item);
      else groups.set(meta, [item]);
    }
    const targets: FrozenTarget[] = [];
    for (const [meta, members] of groups) {
      if (
        (
          await Promise.all(
            members.map((item) =>
              goalSatisfied(item, goal, this.ports.completion),
            ),
          )
        ).some(Boolean)
      )
        continue;
      const ordered = members
        .filter(
          (item) => selector.kind !== "all-pending" || !item.needs_manual_pdf,
        )
        .sort(compareCandidates);
      if (!ordered.length) continue;
      targets.push(
        Object.freeze({
          target: Object.freeze({
            kind: "meta-literature",
            meta_literature_id: meta,
          } as const),
          candidates: Object.freeze(
            ordered.map((item) => item.literature.literature_id),
          ),
          clear_exhaustion: false,
        }),
      );
    }
    return Object.freeze(targets);
  }

  private async completeTarget(
    frozen: FrozenTarget,
    goal: BatchGoal,
    transferIds: readonly string[],
    signal: AbortSignal,
    execution: CompletionExecution,
  ): Promise<DatabaseCompletionTargetOutcome> {
    let exhausted: LiteratureId[] = [];
    for (const candidate of frozen.candidates) {
      if (signal.aborted)
        return {
          partition: "interrupted",
          literature_id: null,
          stage: "literature",
          failure: null,
          skipped_reason: null,
          skipped_literature_ids: [],
          operation_failure: false,
        };
      const outcome = await this.runner.runTarget(candidate, {
        goal,
        transfer_ids: transferIds,
        signal,
        clear_exhaustion: frozen.clear_exhaustion,
        explicit_target: true,
        execution,
      });
      if (
        outcome.partition === "completed" ||
        outcome.partition === "interrupted"
      )
        return outcome;
      if (outcome.partition === "failed")
        // A failed parse never invalidates its PDF or advances to another version.
        return {
          ...outcome,
          literature_id: outcome.literature_id ?? candidate,
        };
      if (outcome.skipped_reason === "manual-pdf-required") {
        exhausted = [...exhausted, ...outcome.skipped_literature_ids];
        continue;
      }
      // A deliberately skipped candidate ends the target.
      return outcome;
    }
    if (exhausted.length > 0)
      return {
        partition: "skipped",
        literature_id: null,
        stage: "acquisition",
        failure: null,
        skipped_reason: "manual-pdf-required",
        skipped_literature_ids: exhausted,
        operation_failure: false,
      };
    return {
      partition: "skipped",
      literature_id: null,
      stage: "literature",
      failure: null,
      skipped_reason: "not-eligible",
      skipped_literature_ids: [],
      operation_failure: false,
    };
  }
}
