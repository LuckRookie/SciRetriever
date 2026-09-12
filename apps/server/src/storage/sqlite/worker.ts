import type { CandidateCleanupSnapshot } from "../../acquisition/candidate-cleanup.js";
import type { CatalogWriteAdmission } from "../write-admission.js";
import type {
  ContentCleanupSnapshot,
  ContentCleanupCommand,
  RetiredArtifact,
} from "../../literature/cleanup.js";
import {
  EXECUTION_SCHEMA,
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_SCHEMA_VERSION,
  EXECUTION_RUNTIME_SCHEMA,
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
} from "./execution-schema.js";
import { Worker } from "node:worker_threads";
import { deriveCurrentState } from "../../literature/state.js";
import {
  CASE_FOLD,
  caseFold,
  ftsIndexText,
} from "../../literature/unicode-casefold.js";
import { SCHEMA_FINGERPRINT, SCHEMA_MANIFEST } from "./schema.js";
import {
  SCHEMA_IDENTITY_V2,
  SCHEMA_V2_FINGERPRINT,
  SCHEMA_V2_VERSION,
} from "./schema-v2.js";
import {
  canonicalJsonBytes,
  parseDurableCandidate,
  parseCandidatePublicationIntent,
  parseCandidatePublicationReceipt,
  type DurableCandidate,
  type CandidatePublicationIntent,
  type CandidatePublicationReceipt,
  decodeCursor,
  encodeCursor,
  parseLiterature,
  parseMetaLiterature,
  parseMetadataObservation,
  parseIdentifier,
  parseLiteratureCurrentFacts,
  parseAsset,
  parseArtifactRef,
  type ArtifactRef,
  type ParserResult,
  parseParserResult,
  type LiteratureCurrentFacts,
  parseLiteratureSearchItem,
  parseReferenceDetail,
  type ReferenceDetail,
  type LiteratureSearchItem,
  sha256,
  type Asset,
  type Literature,
  type MetaLiterature,
  type MetadataObservation as ContractMetadataObservation,
  type Identifier,
  type Reference,
  type Sha256,
} from "@sciretriever/contracts";
import {
  fallbackIdentityKey,
  fallbackIdentitySha256,
  stableIdentifierKeys,
} from "../../literature/identity-rules.js";
import type {
  LiteratureAssetPublication,
  ContentAcceptanceCommit,
  MetadataObservation,
  ParserResultPublication,
  LiteratureContentPublication,
  ReferenceSnapshot,
  ProviderRelationObservation,
} from "./repositories.js";

export class SqliteWorkerError extends Error {
  readonly code = "sqlite-worker" as const;
  constructor() {
    super("sqlite worker operation failed");
    this.name = "SqliteWorkerError";
  }
}

export interface DiscoveryPublication {
  readonly run: {
    readonly discovery_run_id: string;
    readonly kind: "topic" | "citation";
    readonly status:
      | "RUNNING"
      | "COMPLETED"
      | "PARTIAL"
      | "FAILED"
      | "INTERRUPTED";
    readonly started_at: string;
    readonly query?: string;
    readonly year_from?: number | null;
    readonly year_to?: number | null;
    readonly direction?: "references" | "cited-by" | "both";
    readonly max_depth?: number;
    readonly result_limit?: number;
    readonly seed_literature_ids?: readonly string[];
  };
  readonly providers: readonly {
    readonly provider_name: string;
    readonly scan_limit: number;
  }[];
  readonly source_results: readonly {
    readonly provider_name: string;
    readonly outcome: "EXHAUSTED" | "SCAN_LIMIT_REACHED" | "FAILED";
    readonly failure: {
      readonly code: string;
      readonly reason: string;
      readonly action: string;
      readonly retryable: boolean;
    } | null;
  }[];
  readonly results: readonly { readonly meta_literature_id: string }[];
  readonly topic_causes: readonly {
    readonly meta_literature_id: string;
    readonly metadata_observation_id: string;
    readonly actual_literature_id: string;
  }[];
  readonly citation_causes: readonly {
    readonly meta_literature_id: string;
    readonly source_literature_id: string;
    readonly target_literature_id: string;
    readonly actual_literature_id: string;
    readonly depth: number;
  }[];
}

export interface IdentityReadRequest {
  readonly observation_id: string;
  readonly provider_record_key: {
    readonly source_name: string;
    readonly source_record_id: string;
  } | null;
  readonly stable_identifier_keys: readonly (readonly [string, string])[];
  readonly fallback_identity_sha256: string | null;
  readonly user_observation_semantic_sha256: string | null;
  readonly version_link_keys: readonly {
    readonly source_name: string;
    readonly record_id: string | null;
    readonly stable_identifier_keys: readonly (readonly [string, string])[];
  }[];
}

export interface IdentityReadContext {
  readonly literatures: readonly Literature[];
  readonly meta_literatures: readonly MetaLiterature[];
  readonly observations: readonly {
    readonly literature_id: string;
    readonly observation: ContractMetadataObservation;
  }[];
  readonly facts: readonly {
    readonly literature: Literature;
    readonly metadata_revision: number;
    readonly metadata_sha256: string;
    readonly content_ready: boolean;
  }[];
}

export interface IdentityPublicationCommand {
  readonly literatures: readonly {
    readonly literature: Literature;
    readonly metadata_revision: number;
    readonly metadata_sha256: string;
    readonly fallback_identity_sha256: string | null;
  }[];
  readonly meta_literatures: readonly MetaLiterature[];
  readonly observation: {
    readonly literature_id: string;
    readonly observation: ContractMetadataObservation;
    readonly user_semantic_sha256: string | null;
  } | null;
  readonly expected_literatures: readonly {
    readonly literature_id: string;
    readonly meta_literature_id: string;
    readonly metadata_revision: number;
    readonly metadata_sha256: string;
  }[];
  readonly expected_meta_literatures: readonly {
    readonly meta_literature_id: string;
    readonly representative_literature_id: string;
    readonly member_literature_ids: readonly string[];
  }[];
  readonly retired_meta_literature_ids: readonly string[];
  readonly clear_automatic_pdf_exhaustion_for: readonly string[];
}

function parseDiscoveryPublication(value: unknown): DiscoveryPublication {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SqliteWorkerError();
  const publication = value as Partial<DiscoveryPublication>;
  const run = publication.run;
  if (
    !run ||
    typeof run.discovery_run_id !== "string" ||
    !run.discovery_run_id.trim() ||
    !["topic", "citation"].includes(run.kind) ||
    !["RUNNING", "COMPLETED", "PARTIAL", "FAILED", "INTERRUPTED"].includes(
      run.status,
    ) ||
    typeof run.started_at !== "string" ||
    !Array.isArray(publication.providers) ||
    !Array.isArray(publication.source_results) ||
    !Array.isArray(publication.results) ||
    !Array.isArray(publication.topic_causes) ||
    !Array.isArray(publication.citation_causes)
  )
    throw new SqliteWorkerError();
  return value as DiscoveryPublication;
}

export type SqliteCommand =
  | { readonly kind: "candidate_cleanup_snapshot" }
  | {
      readonly kind: "artifact_reclamation_snapshot";
      readonly reference: string;
    }
  | { readonly kind: "content_cleanup_snapshot"; readonly literatureId: string }
  | {
      readonly kind: "cleanup_no_usable_content";
      readonly command: ContentCleanupCommand;
    }
  | {
      readonly kind: "accept_literature_content";
      readonly command: ContentAcceptanceCommit;
    }
  | {
      readonly kind: "commit_current_parser";
      readonly literatureId: string;
      readonly result: ParserResultPublication;
    }
  | { readonly kind: "execution_upgrade" }
  | { readonly kind: "execution_runtime_inspect" }
  | { readonly kind: "execution_runtime_migrate"; readonly dryRun: boolean }
  | { readonly kind: "execution_backup"; readonly path: string }
  | { readonly kind: "execution_restore_check"; readonly path: string }
  | { readonly kind: "execution_rollback"; readonly backupPath: string }
  | {
      readonly kind: "execution_create_job";
      readonly job: ExecutionJob;
      readonly policy_sha256: string;
      readonly policy_json: unknown;
    }
  | { readonly kind: "execution_get_job"; readonly jobId: string }
  | { readonly kind: "execution_list_jobs"; readonly limit: number }
  | {
      readonly kind: "execution_list_targets";
      readonly jobId: string;
      readonly limit: number;
    }
  | {
      readonly kind: "execution_list_attempts";
      readonly targetId: string;
      readonly limit: number;
    }
  | {
      readonly kind: "execution_recover";
      readonly bootId: string;
      readonly now: string;
    }
  | { readonly kind: "execution_get_policy"; readonly jobId: string }
  | { readonly kind: "execution_get_budget"; readonly jobId: string }
  | {
      readonly kind: "execution_consume_budget";
      readonly jobId: string;
      readonly usage: ExecutionBudgetUsage;
      readonly now: string;
    }
  | {
      readonly kind: "execution_update_job";
      readonly jobId: string;
      readonly status: ExecutionJobStatus;
      readonly finishedAt: string | null;
    }
  | {
      readonly kind: "execution_put_target";
      readonly target: ExecutionTarget;
    }
  | { readonly kind: "execution_get_target"; readonly targetId: string }
  | {
      readonly kind: "execution_claim_target";
      readonly jobId: string;
      readonly now: string;
    }
  | {
      readonly kind: "execution_update_target";
      readonly targetId: string;
      readonly stage: ExecutionTargetStage;
      readonly disposition: ExecutionTarget["disposition"];
      readonly nextEligibleAt: string | null;
    }
  | {
      readonly kind: "execution_start_attempt";
      readonly attempt: ExecutionAttempt;
    }
  | {
      readonly kind: "execution_finish_attempt";
      readonly attemptId: string;
      readonly status: ExecutionAttemptStatus;
      readonly finishedAt: string;
      readonly failure: ExecutionAttempt["failure"];
      readonly usage: unknown;
    }
  | {
      readonly kind: "execution_append_event";
      readonly event: ExecutionEvent;
    }
  | {
      readonly kind: "execution_list_events";
      readonly jobId: string;
      readonly after: number;
      readonly limit: number;
    }
  | {
      readonly kind: "execution_put_intervention";
      readonly intervention: ExecutionIntervention;
    }
  | {
      readonly kind: "execution_list_interventions";
      readonly jobId: string;
      readonly limit: number;
    }
  | {
      readonly kind: "execution_resolve_intervention";
      readonly interventionId: string;
      readonly status: "resolved" | "expired";
      readonly resolvedAt: string;
      readonly resolution: unknown;
    }
  | {
      readonly kind: "execution_acquire_lease";
      readonly lease: ExecutionLease;
    }
  | {
      readonly kind: "execution_release_lease";
      readonly leaseId: string;
      readonly releasedAt: string;
    }
  | { readonly kind: "put_candidate"; readonly candidate: DurableCandidate }
  | { readonly kind: "retire_candidate"; readonly candidate: DurableCandidate }
  | { readonly kind: "get_candidate"; readonly transferId: string }
  | { readonly kind: "get_receipt_intent"; readonly receiptId: string }
  | { readonly kind: "get_receipt_result"; readonly receiptId: string }
  | { readonly kind: "list_candidates"; readonly articleId: string }
  | { readonly kind: "current_facts"; readonly literatureId: string }
  | {
      readonly kind: "literature_detail_snapshot";
      readonly literatureId: string;
    }
  | { readonly kind: "asset_by_hash"; readonly sha256: string }
  | { readonly kind: "locate_artifact"; readonly value: Asset | ArtifactRef }
  | {
      readonly kind: "prepare_receipt";
      readonly intent: CandidatePublicationIntent;
    }
  | {
      readonly kind: "commit_receipt";
      readonly intent: CandidatePublicationIntent;
      readonly created: boolean;
    }
  | { readonly kind: "pending_receipts" }
  | { readonly kind: "close" }
  | { readonly kind: "schema" }
  | {
      readonly kind: "library_snapshot";
      readonly ftsQuery: string | null;
      readonly discoveryRunIds: readonly string[];
    }
  | {
      readonly kind: "put_literature";
      readonly literature: Literature;
      readonly metadataSha256: Sha256;
      readonly fallbackIdentitySha256: string | null;
    }
  | { readonly kind: "get_literature"; readonly literatureId: string }
  | {
      readonly kind: "find_literature_by_identifiers";
      readonly identifiers: readonly Identifier[];
    }
  | {
      readonly kind: "list_literature";
      readonly afterLiteratureId: string | null;
      readonly limit: number;
    }
  | { readonly kind: "put_asset"; readonly asset: Asset }
  | { readonly kind: "get_asset"; readonly assetId: string }
  | {
      readonly kind: "put_literature_asset";
      readonly publication: LiteratureAssetPublication;
    }
  | {
      readonly kind: "put_parser_result";
      readonly result: ParserResultPublication;
    }
  | {
      readonly kind: "put_literature_content";
      readonly content: LiteratureContentPublication;
    }
  | { readonly kind: "get_literature_content"; readonly literatureId: string }
  | { readonly kind: "put_reference"; readonly reference: Reference }
  | {
      readonly kind: "put_provider_relation";
      readonly observation: ProviderRelationObservation;
    }
  | {
      readonly kind: "get_provider_relation";
      readonly observationId: string;
    }
  | {
      readonly kind: "put_provider_reference_support";
      readonly referenceId: string;
      readonly observationId: string;
    }
  | {
      readonly kind: "put_metadata_reference_support";
      readonly referenceId: string;
      readonly observationId: string;
      readonly referenceIndex: number;
    }
  | {
      readonly kind: "put_content_reference_support";
      readonly referenceId: string;
      readonly contentSha256: string;
      readonly referenceIndex: number;
    }
  | { readonly kind: "reference_snapshot" }
  | {
      readonly kind: "reference_query_snapshot";
      readonly selection:
        | {
            readonly literature_id: string;
            readonly direction: "references" | "cited-by";
          }
        | { readonly reference_id: string };
    }
  | {
      readonly kind: "put_observation";
      readonly observation: MetadataObservation;
    }
  | { readonly kind: "get_observation"; readonly observationId: string }
  | { readonly kind: "identity_read"; readonly request: IdentityReadRequest }
  | {
      readonly kind: "publish_identity_observation";
      readonly publication: IdentityPublicationCommand;
    }
  | {
      readonly kind: "accept_observation";
      readonly observationId: string;
      readonly literatureId: string;
      readonly expectedMetadataRevision: number;
      readonly expectedMetadataSha256: string;
      readonly nextMetadataSha256: Sha256;
    }
  | {
      readonly kind: "put_discovery";
      readonly publication: DiscoveryPublication;
    }
  | { readonly kind: "get_discovery"; readonly discoveryRunId: string }
  | { readonly kind: "snapshot_counts" };

export interface SqliteSnapshotCounts {
  readonly tables: Readonly<Record<string, number>>;
}

export type ExecutionJobStatus =
  | "queued"
  | "running"
  | "paused"
  | "cancelled"
  | "completed"
  | "failed"
  | "interrupted";
export type ExecutionTargetStage =
  | "queued"
  | "acquisition"
  | "parsing"
  | "analysis"
  | "literature"
  | "completed"
  | "failed"
  | "skipped"
  | "interrupted";
export type ExecutionAttemptStage =
  | "acquisition"
  | "parsing"
  | "analysis"
  | "literature";
export type ExecutionAttemptStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "unknown";
export interface ExecutionJob {
  readonly job_id: string;
  readonly target_kind: "literature" | "selector" | "discovery";
  readonly selector: unknown;
  readonly policy_version: string;
  readonly status: ExecutionJobStatus;
  readonly idempotency_key: string;
  readonly created_at: string;
  readonly finished_at: string | null;
}
export interface ExecutionTarget {
  readonly target_id: string;
  readonly job_id: string;
  readonly ordinal: number;
  readonly literature_id: string | null;
  readonly version_role:
    | "published"
    | "accepted-manuscript"
    | "preprint"
    | "other"
    | null;
  readonly stage: ExecutionTargetStage;
  readonly disposition:
    | "pending"
    | "completed"
    | "failed"
    | "skipped"
    | "interrupted"
    | null;
  readonly next_eligible_at: string | null;
}
export interface ExecutionAttempt {
  readonly attempt_id: string;
  readonly target_id: string;
  readonly stage: ExecutionAttemptStage;
  readonly status: ExecutionAttemptStatus;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly failure: {
    readonly code: string;
    readonly reason: string;
    readonly action: string;
    readonly retryable: boolean;
  } | null;
  readonly usage: unknown;
}
export interface ExecutionEvent {
  readonly event_id: string;
  readonly job_id: string;
  readonly sequence: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly created_at: string;
}
export interface ExecutionLease {
  readonly lease_id: string;
  readonly job_id: string;
  readonly workspace_id: string | null;
  readonly boot_id: string;
  readonly control_epoch: number;
  readonly acquired_at: string;
  readonly released_at: string | null;
}
export interface ExecutionPolicySnapshot {
  readonly mode: "never" | "notify" | "pause";
  readonly max_retries: number;
  readonly max_attempts: number;
  readonly max_network_bytes: number;
  readonly max_model_calls: number;
  readonly intervention_timeout_ms: number;
}
export interface ExecutionBudgetUsage {
  readonly attempts: number;
  readonly network_bytes: number;
  readonly model_calls: number;
}
export interface ExecutionBudget extends ExecutionBudgetUsage {
  readonly job_id: string;
  readonly max_attempts: number;
  readonly max_network_bytes: number;
  readonly max_model_calls: number;
  readonly updated_at: string;
}
export interface ExecutionBudgetClaim {
  readonly accepted: boolean;
  readonly budget: ExecutionBudget;
}
export interface ExecutionIntervention {
  readonly intervention_id: string;
  readonly job_id: string;
  readonly target_id: string | null;
  readonly mode: ExecutionPolicySnapshot["mode"];
  readonly status: "open" | "resolved" | "expired" | "declined";
  readonly failure: {
    readonly code: string;
    readonly reason: string;
    readonly action: string;
    readonly retryable: boolean;
  };
  readonly created_at: string;
  readonly expires_at: string;
  readonly resolved_at: string | null;
  readonly resolution: unknown;
}
export interface ExecutionRuntimeInspection {
  readonly catalog_version: 1 | 2;
  readonly catalog_fingerprint: string;
  readonly version: number | null;
  readonly fingerprint: string | null;
  readonly migrated: boolean;
  readonly tables: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
}
export interface ExecutionMigrationReceipt {
  readonly migration_id: string;
  readonly action: "migrate" | "dry-run";
  readonly from_version: number | null;
  readonly to_version: number;
  readonly manifest_fingerprint: string;
  readonly applied_at: string;
  readonly inspection: ExecutionRuntimeInspection;
}
export interface ExecutionRestoreCheck {
  readonly path: string;
  readonly integrity: "ok";
  readonly schema_version: number;
  readonly schema_fingerprint: string;
  readonly runtime: ExecutionRuntimeInspection;
}
export interface ExecutionRecoveryResult {
  readonly boot_id: string;
  readonly recovered_attempts: number;
  readonly recovered_targets: number;
  readonly recovered_jobs: number;
  readonly released_leases: number;
  readonly expired_interventions: number;
}

const executionJobStatuses = new Set<ExecutionJobStatus>([
  "queued",
  "running",
  "paused",
  "cancelled",
  "completed",
  "failed",
  "interrupted",
]);
const executionTargetStages = new Set<ExecutionTargetStage>([
  "queued",
  "acquisition",
  "parsing",
  "analysis",
  "literature",
  "completed",
  "failed",
  "skipped",
  "interrupted",
]);
const executionAttemptStages = new Set<ExecutionAttemptStage>([
  "acquisition",
  "parsing",
  "analysis",
  "literature",
]);
const executionAttemptStatuses = new Set<ExecutionAttemptStatus>([
  "running",
  "completed",
  "failed",
  "interrupted",
  "unknown",
]);
function executionText(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new SqliteWorkerError();
  return value;
}
function parseExecutionJob(value: unknown): ExecutionJob {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SqliteWorkerError();
  const job = value as Partial<ExecutionJob>;
  if (
    typeof job.job_id !== "string" ||
    typeof job.target_kind !== "string" ||
    !["literature", "selector", "discovery"].includes(job.target_kind) ||
    typeof job.policy_version !== "string" ||
    typeof job.status !== "string" ||
    !executionJobStatuses.has(job.status as ExecutionJobStatus) ||
    typeof job.idempotency_key !== "string" ||
    typeof job.created_at !== "string" ||
    (job.finished_at !== null && typeof job.finished_at !== "string")
  )
    throw new SqliteWorkerError();
  executionText(job.job_id);
  executionText(job.policy_version);
  executionText(job.idempotency_key);
  executionText(job.created_at, 64);
  if (job.finished_at !== null) executionText(job.finished_at, 64);
  return {
    job_id: job.job_id,
    target_kind: job.target_kind as ExecutionJob["target_kind"],
    selector: job.selector,
    policy_version: job.policy_version,
    status: job.status as ExecutionJobStatus,
    idempotency_key: job.idempotency_key,
    created_at: job.created_at,
    finished_at: job.finished_at,
  };
}
function parseExecutionTarget(value: unknown): ExecutionTarget {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SqliteWorkerError();
  const target = value as Partial<ExecutionTarget>;
  if (
    typeof target.target_id !== "string" ||
    typeof target.job_id !== "string" ||
    !Number.isSafeInteger(target.ordinal) ||
    (target.ordinal as number) < 0 ||
    (target.literature_id !== null &&
      typeof target.literature_id !== "string") ||
    (target.version_role !== null &&
      !["published", "accepted-manuscript", "preprint", "other"].includes(
        target.version_role as string,
      )) ||
    typeof target.stage !== "string" ||
    !executionTargetStages.has(target.stage as ExecutionTargetStage) ||
    (target.disposition !== null &&
      !["pending", "completed", "failed", "skipped", "interrupted"].includes(
        target.disposition as string,
      )) ||
    (target.next_eligible_at !== null &&
      typeof target.next_eligible_at !== "string")
  )
    throw new SqliteWorkerError();
  executionText(target.target_id);
  executionText(target.job_id);
  return target as ExecutionTarget;
}
function parseExecutionAttempt(value: unknown): ExecutionAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SqliteWorkerError();
  const attempt = value as Partial<ExecutionAttempt>;
  if (
    typeof attempt.attempt_id !== "string" ||
    typeof attempt.target_id !== "string" ||
    typeof attempt.stage !== "string" ||
    !executionAttemptStages.has(attempt.stage as ExecutionAttemptStage) ||
    typeof attempt.status !== "string" ||
    !executionAttemptStatuses.has(attempt.status as ExecutionAttemptStatus) ||
    typeof attempt.started_at !== "string" ||
    (attempt.finished_at !== null && typeof attempt.finished_at !== "string") ||
    (attempt.failure !== null &&
      (!attempt.failure ||
        typeof attempt.failure.code !== "string" ||
        typeof attempt.failure.reason !== "string" ||
        typeof attempt.failure.action !== "string" ||
        typeof attempt.failure.retryable !== "boolean"))
  )
    throw new SqliteWorkerError();
  executionText(attempt.attempt_id);
  executionText(attempt.target_id);
  executionText(attempt.started_at, 64);
  if (attempt.finished_at !== null) executionText(attempt.finished_at, 64);
  return attempt as ExecutionAttempt;
}
function parseExecutionPolicy(value: unknown): ExecutionPolicySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SqliteWorkerError();
  const policy = value as Partial<ExecutionPolicySnapshot>;
  if (
    !["never", "notify", "pause"].includes(policy.mode as string) ||
    !Number.isSafeInteger(policy.max_retries) ||
    (policy.max_retries as number) < 0 ||
    (policy.max_retries as number) > 100 ||
    !Number.isSafeInteger(policy.max_attempts) ||
    (policy.max_attempts as number) < 1 ||
    (policy.max_attempts as number) > 100000 ||
    !Number.isSafeInteger(policy.max_network_bytes) ||
    (policy.max_network_bytes as number) < 1 ||
    (policy.max_network_bytes as number) > 1_099_511_627_776 ||
    !Number.isSafeInteger(policy.max_model_calls) ||
    (policy.max_model_calls as number) < 0 ||
    (policy.max_model_calls as number) > 100000 ||
    !Number.isSafeInteger(policy.intervention_timeout_ms) ||
    (policy.intervention_timeout_ms as number) < 1000 ||
    (policy.intervention_timeout_ms as number) > 604_800_000
  )
    throw new SqliteWorkerError();
  return policy as ExecutionPolicySnapshot;
}
function parseExecutionBudget(value: unknown): ExecutionBudget {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SqliteWorkerError();
  const budget = value as Partial<ExecutionBudget>;
  if (
    typeof budget.job_id !== "string" ||
    !Number.isSafeInteger(budget.max_attempts) ||
    !Number.isSafeInteger(budget.max_network_bytes) ||
    !Number.isSafeInteger(budget.max_model_calls) ||
    !Number.isSafeInteger(budget.attempts) ||
    !Number.isSafeInteger(budget.network_bytes) ||
    !Number.isSafeInteger(budget.model_calls) ||
    typeof budget.updated_at !== "string"
  )
    throw new SqliteWorkerError();
  executionText(budget.job_id);
  executionText(budget.updated_at, 64);
  return budget as ExecutionBudget;
}
function parseExecutionIntervention(value: unknown): ExecutionIntervention {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SqliteWorkerError();
  const intervention = value as Partial<ExecutionIntervention>;
  if (
    typeof intervention.intervention_id !== "string" ||
    typeof intervention.job_id !== "string" ||
    (intervention.target_id !== null &&
      typeof intervention.target_id !== "string") ||
    !["never", "notify", "pause"].includes(intervention.mode as string) ||
    !["open", "resolved", "expired", "declined"].includes(
      intervention.status as string,
    ) ||
    !intervention.failure ||
    typeof intervention.failure.code !== "string" ||
    typeof intervention.failure.reason !== "string" ||
    typeof intervention.failure.action !== "string" ||
    typeof intervention.failure.retryable !== "boolean" ||
    typeof intervention.created_at !== "string" ||
    typeof intervention.expires_at !== "string" ||
    (intervention.resolved_at !== null &&
      typeof intervention.resolved_at !== "string")
  )
    throw new SqliteWorkerError();
  for (const text of [
    intervention.intervention_id,
    intervention.job_id,
    intervention.created_at,
    intervention.expires_at,
  ])
    executionText(text, 256);
  if (intervention.target_id !== null) executionText(intervention.target_id);
  return intervention as ExecutionIntervention;
}
export interface LiteraturePage {
  readonly items: readonly Literature[];
  readonly next_cursor: string | null;
}

interface Reply {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { createHash, randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const CASE_FOLD = ${JSON.stringify(CASE_FOLD)};
const caseFold = ${caseFold.toString()};
const ftsIndexText = ${ftsIndexText.toString()};
const deriveCurrentState = ${deriveCurrentState.toString()};
let db;
const schema = ${JSON.stringify(SCHEMA_MANIFEST)};
function fail(){ throw new Error("sqlite worker operation failed"); }
function initialize(){
  db = new DatabaseSync(workerData.path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 5000");
  const existingTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_identity'").get();
  const existing = existingTable ? db.prepare("SELECT product,schema_version,schema_fingerprint FROM schema_identity WHERE singleton=1").get() : undefined;
  if (!existing) {
    for (const statement of schema) db.exec(statement);
    db.prepare("INSERT INTO schema_identity(singleton,product,schema_version,schema_fingerprint,created_at) VALUES(1,?,?,?,?)").run("sciretriever",1,${JSON.stringify(SCHEMA_FINGERPRINT)},new Date().toISOString());
  }
  else if (existing.product !== "sciretriever" || !((existing.schema_version === 1 && existing.schema_fingerprint === ${JSON.stringify(SCHEMA_FINGERPRINT)}) || (existing.schema_version === ${JSON.stringify(SCHEMA_V2_VERSION)} && existing.schema_fingerprint === ${JSON.stringify(SCHEMA_V2_FINGERPRINT)}))) fail();
}
function putLiterature(l, metadataSha256, fallbackIdentitySha256){
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO meta_literatures(meta_literature_id,representative_literature_id) VALUES(?,?) ON CONFLICT(meta_literature_id) DO NOTHING").run(l.meta_literature_id,l.literature_id);
    db.prepare("INSERT INTO literatures(literature_id,meta_literature_id,version_role) VALUES(?,?,?) ON CONFLICT(literature_id) DO UPDATE SET meta_literature_id=excluded.meta_literature_id,version_role=excluded.version_role").run(l.literature_id,l.meta_literature_id,l.version_role);
    writeMetadata(l.literature_id,l.metadata,metadataSha256);
    replaceFallbackIndex(l.literature_id,fallbackIdentitySha256);
    db.exec("COMMIT");
  } catch(e){ try{db.exec("ROLLBACK");}catch{} throw e; }
  return true;
}
function replaceFallbackIndex(literatureId,digest){
  db.prepare("DELETE FROM literature_fallback_identity_indexes WHERE literature_id=?").run(literatureId);
  if(digest!==null)db.prepare("INSERT INTO literature_fallback_identity_indexes(literature_id,fallback_identity_sha256) VALUES(?,?)").run(literatureId,digest);
}
function writeMetadata(literatureId,m,metadataSha256){
    const current=db.prepare("SELECT metadata_revision FROM literature_metadata WHERE literature_id=?").get(literatureId);
    writeMetadataAtRevision(literatureId,m,current?current.metadata_revision+1:1,metadataSha256);
}
function writeMetadataAtRevision(literatureId,m,revision,metadataSha256){
    db.prepare("INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title,abstract,publication_date,publication_year,document_type,language,venue,publisher,volume,issue,pages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(literature_id) DO UPDATE SET metadata_revision=excluded.metadata_revision,metadata_sha256=excluded.metadata_sha256,title=excluded.title,abstract=excluded.abstract,publication_date=excluded.publication_date,publication_year=excluded.publication_year,document_type=excluded.document_type,language=excluded.language,venue=excluded.venue,publisher=excluded.publisher,volume=excluded.volume,issue=excluded.issue,pages=excluded.pages").run(literatureId,revision,metadataSha256,m.title,m.abstract,m.publication_date,m.publication_year,m.document_type,m.language,m.venue,m.publisher,m.volume,m.issue,m.pages);
    db.prepare("DELETE FROM literature_metadata_authors WHERE literature_id=?").run(literatureId);
    db.prepare("DELETE FROM literature_metadata_identifiers WHERE literature_id=?").run(literatureId);
    db.prepare("DELETE FROM literature_metadata_keywords WHERE literature_id=?").run(literatureId);
    const author=db.prepare("INSERT INTO literature_metadata_authors(literature_id,ordinal,kind,display_name,given_name,family_name,orcid) VALUES(?,?,?,?,?,?,?)");
    for(let i=0;i<m.authors.length;i++){const a=m.authors[i]; author.run(literatureId,i,a.kind,a.display_name,a.given_name,a.family_name,a.orcid); for(let j=0;j<a.affiliations.length;j++){const f=a.affiliations[j]; db.prepare("INSERT INTO literature_metadata_author_affiliations(literature_id,author_ordinal,affiliation_ordinal,name,ror) VALUES(?,?,?,?,?)").run(literatureId,i,j,f.name,f.ror);}}
    const identifier=db.prepare("INSERT INTO literature_metadata_identifiers(literature_id,ordinal,namespace,value) VALUES(?,?,?,?)");
    for(let i=0;i<m.identifiers.length;i++){const x=m.identifiers[i]; identifier.run(literatureId,i,x.namespace,x.value);}
    const keyword=db.prepare("INSERT INTO literature_metadata_keywords(literature_id,ordinal,keyword) VALUES(?,?,?)");
    for(let i=0;i<m.keywords.length;i++) keyword.run(literatureId,i,m.keywords[i]);
    indexMetadata(literatureId,m);
}
function indexMetadata(literatureId,m){
    const contentBody=db.prepare("SELECT content_body FROM literature_search_fts WHERE literature_id=?").get(literatureId)?.content_body || "";
    db.prepare("DELETE FROM literature_search_fts WHERE literature_id=?").run(literatureId);
    const index=value=>ftsIndexText(value||"");
    db.prepare("INSERT INTO literature_search_fts(literature_id,title,abstract,authors,affiliations,identifiers,keywords,venue,publisher,volume,issue,pages,content_body) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(literatureId,index(m.title),index(m.abstract),index(m.authors.flatMap(a=>[a.display_name,a.given_name,a.family_name,a.orcid]).filter(Boolean).join(" ")),index(m.authors.flatMap(a=>a.affiliations.flatMap(f=>[f.name,f.ror])).filter(Boolean).join(" ")),index(m.identifiers.flatMap(x=>[x.namespace,x.value]).join(" ")),index(m.keywords.join(" ")),index(m.venue),index(m.publisher),index(m.volume),index(m.issue),index(m.pages),contentBody);
}
function getLiterature(id){
  const l=db.prepare("SELECT literature_id,meta_literature_id,version_role FROM literatures WHERE literature_id=?").get(id);
  if(!l) return null;
  const m=db.prepare("SELECT title,abstract,publication_date,publication_year,document_type,language,venue,publisher,volume,issue,pages FROM literature_metadata WHERE literature_id=?").get(id);
  if(!m) fail();
  const authors=db.prepare("SELECT ordinal,kind,display_name,given_name,family_name,orcid FROM literature_metadata_authors WHERE literature_id=? ORDER BY ordinal").all(id).map(({ordinal,...a})=>({...a,affiliations:db.prepare("SELECT name,ror FROM literature_metadata_author_affiliations WHERE literature_id=? AND author_ordinal=? ORDER BY affiliation_ordinal").all(id,ordinal)}));
  const identifiers=db.prepare("SELECT namespace,value FROM literature_metadata_identifiers WHERE literature_id=? ORDER BY ordinal").all(id);
  const keywords=db.prepare("SELECT keyword FROM literature_metadata_keywords WHERE literature_id=? ORDER BY ordinal").all(id).map(x=>x.keyword);
  const status=stateEvidence(id).status;
  return {literature_id:l.literature_id,meta_literature_id:l.meta_literature_id,version_role:l.version_role,status,metadata:{...m,authors,identifiers,keywords}};
}
function findLiteratureByIdentifiers(identifiers){
  if(!Array.isArray(identifiers) || identifiers.length>128) fail();
  const ids=new Set();
  const query=db.prepare("SELECT literature_id FROM literature_metadata_identifiers WHERE namespace=? AND value=? ORDER BY literature_id");
  for(const identifier of identifiers){
    if(!identifier || typeof identifier.namespace!=="string" || typeof identifier.value!=="string") fail();
    for(const row of query.all(identifier.namespace,identifier.value)) ids.add(row.literature_id);
  }
  return [...ids].sort().map(getLiterature);
}
function stateEvidence(id){
  const metadata=db.prepare("SELECT metadata_revision,metadata_sha256 FROM literature_metadata WHERE literature_id=?").get(id);
  if(!metadata) fail();
  const primary=db.prepare("SELECT a.asset_id,a.sha256,a.media_type FROM literature_assets l JOIN assets a ON a.asset_id=l.asset_id WHERE l.literature_id=? AND l.role='primary-pdf'").get(id) || null;
  const parser=primary?(db.prepare("SELECT source_asset_id,source_sha256 FROM parser_results WHERE source_asset_id=?").get(primary.asset_id)||null):null;
  const content=db.prepare("SELECT c.metadata_revision,c.metadata_sha256,c.primary_asset_id,c.primary_asset_sha256,c.parser_result_sha256,p.source_kind,p.input_sha256 FROM literature_contents c JOIN provenances p ON p.provenance_id=c.analysis_provenance_id WHERE c.literature_id=?").get(id)||null;
  if(content) content.expected_input_sha256=createHash("sha256").update(JSON.stringify({metadata_sha256:metadata.metadata_sha256,parser_result_sha256:content.parser_result_sha256,primary_pdf_sha256:primary?.sha256 || "",schema:"sciretriever-literature-content-input-v1"})).digest("hex");
  return deriveCurrentState({...metadata,primary,parser,content});
}
function searchItem(id){
  const literature=getLiterature(id);
  const metadata=db.prepare("SELECT metadata_revision,metadata_sha256 FROM literature_metadata WHERE literature_id=?").get(id);
  const state=stateEvidence(id);
  const exhausted=!!db.prepare("SELECT 1 FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?").get(id);
  return {literature,...metadata,missing_step:state.missing_step,needs_manual_pdf:state.status==='UNREVIEWED' && exhausted};
}
function validateDiscoveryCauses(ids){
  for(const id of new Set(ids)){
    const run=db.prepare("SELECT kind FROM discovery_runs WHERE discovery_run_id=?").get(id);
    const results=db.prepare("SELECT meta_literature_id FROM discovery_results WHERE discovery_run_id=?").all(id);
    const resultIds=new Set(results.map(row=>row.meta_literature_id));
    const counts=new Map();
    for(const c of db.prepare("SELECT * FROM topic_discovery_causes WHERE discovery_run_id=?").all(id)){
      if(run?.kind!=="topic" || !resultIds.has(c.meta_literature_id) || !db.prepare("SELECT 1 FROM literature_metadata_observations owner JOIN literatures actual ON actual.literature_id=owner.literature_id WHERE owner.observation_id=? AND actual.literature_id=? AND actual.meta_literature_id=?").get(c.metadata_observation_id,c.actual_literature_id,c.meta_literature_id)) fail();
      counts.set(c.meta_literature_id,(counts.get(c.meta_literature_id)||0)+1);
    }
    for(const c of db.prepare("SELECT * FROM citation_discovery_causes WHERE discovery_run_id=?").all(id)){
      if(run?.kind!=="citation" || !resultIds.has(c.meta_literature_id) || ![c.source_literature_id,c.target_literature_id].includes(c.actual_literature_id) || !db.prepare("SELECT 1 FROM literatures WHERE literature_id=?").get(c.source_literature_id) || !db.prepare("SELECT 1 FROM literatures WHERE literature_id=?").get(c.target_literature_id) || !db.prepare("SELECT 1 FROM literatures WHERE literature_id=? AND meta_literature_id=?").get(c.actual_literature_id,c.meta_literature_id)) fail();
      counts.set(c.meta_literature_id,(counts.get(c.meta_literature_id)||0)+1);
    }
    for(const result of results)if(!["topic","citation"].includes(run?.kind) || !counts.get(result.meta_literature_id))fail();
  }
}
function librarySnapshot(ftsQuery,discoveryRunIds){
  db.exec("BEGIN");
  try {
    validateDiscoveryCauses(discoveryRunIds);
    const rows=ftsQuery===null?db.prepare("SELECT literature_id,NULL AS relevance FROM literatures ORDER BY literature_id").all():db.prepare("SELECT literature_id,bm25(literature_search_fts) AS relevance FROM literature_search_fts WHERE literature_search_fts MATCH ? ORDER BY literature_id").all(ftsQuery);
    if(new Set(rows.map(row=>row.literature_id)).size!==rows.length)fail();
    const result=rows.map(row=>({item:searchItem(row.literature_id),relevance:row.relevance,has_pdf_exhaustion:!!db.prepare("SELECT 1 FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?").get(row.literature_id),discovery_run_ids:db.prepare("SELECT discovery_run_id FROM topic_discovery_causes WHERE actual_literature_id=? UNION SELECT discovery_run_id FROM citation_discovery_causes WHERE actual_literature_id=?").all(row.literature_id,row.literature_id).map(x=>x.discovery_run_id)}));
    db.exec("COMMIT");return result;
  } catch(error){db.exec("ROLLBACK");throw error;}
}
function listLiterature(afterId,limit){
  const rows=db.prepare("SELECT literature_id FROM literatures WHERE (? IS NULL OR literature_id>?) ORDER BY literature_id LIMIT ?").all(afterId,afterId,limit+1);
  const items=rows.slice(0,limit).map(row=>getLiterature(row.literature_id));
  return {items,next_cursor:rows.length>limit?rows[limit-1].literature_id:null};
}
function currentFacts(id){
  db.exec("BEGIN");
  try {
    const literature=getLiterature(id);
    if(!literature){db.exec("COMMIT");return null;}
    const snapshot=db.prepare("SELECT metadata_revision AS revision,metadata_sha256 AS sha256 FROM literature_metadata WHERE literature_id=?").get(id);
    const asset=db.prepare("SELECT a.asset_id,a.sha256,a.size_bytes,a.media_type,a.relative_path AS path FROM literature_assets l JOIN assets a ON a.asset_id=l.asset_id WHERE l.literature_id=? AND l.role='primary-pdf'").get(id) || null;
    db.exec("COMMIT");
    return {literature,metadata_snapshot:snapshot,primary_asset:asset};
  } catch(error){db.exec("ROLLBACK");throw error;}
}
function assetByHash(hash){
  return db.prepare("SELECT asset_id,sha256,size_bytes,media_type,relative_path AS path FROM assets WHERE sha256=? ORDER BY asset_id LIMIT 1").get(hash) || null;
}
function putObservation(o){
  return transaction(()=>storeObservation(o));
}
function storeObservation(o){
    const old=getObservation(o.observation_id);
    if(old){
      const normalized=value=>{const {literature_id,...body}=value;return {...body,metadata:{...body.metadata,authors:body.metadata.authors.map(({ordinal,...a})=>a)},version_links:body.version_links||[],asset_hints:body.asset_hints||[]};};
      const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,stable(v)])):value;
      if(JSON.stringify(stable(normalized(old)))!==JSON.stringify(stable(normalized(o))) || (old.literature_id!==undefined && o.literature_id!==undefined && old.literature_id!==o.literature_id))fail();
      if(o.literature_id!==undefined)db.prepare("INSERT INTO literature_metadata_observations(literature_id,observation_id) VALUES(?,?) ON CONFLICT DO NOTHING").run(o.literature_id,o.observation_id);
      return true;
    }
    const p=o.provenance;
    insertExact("provenances",p,"provenance_id");
    db.prepare("INSERT INTO metadata_observations(observation_id,provenance_id,version_role,reference_count,cited_by_count,title,abstract,publication_date,publication_year,document_type,language,venue,publisher,volume,issue,pages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(observation_id) DO NOTHING").run(o.observation_id,p.provenance_id,o.version_role,o.reference_count,o.cited_by_count,o.metadata.title,o.metadata.abstract,o.metadata.publication_date,o.metadata.publication_year,o.metadata.document_type,o.metadata.language,o.metadata.venue,o.metadata.publisher,o.metadata.volume,o.metadata.issue,o.metadata.pages);
    const author=db.prepare("INSERT INTO metadata_observation_authors(observation_id,ordinal,kind,display_name,given_name,family_name,orcid) VALUES(?,?,?,?,?,?,?) ON CONFLICT(observation_id,ordinal) DO NOTHING");
    for(let i=0;i<o.metadata.authors.length;i++){const a=o.metadata.authors[i]; author.run(o.observation_id,i,a.kind,a.display_name,a.given_name,a.family_name,a.orcid); for(let j=0;j<a.affiliations.length;j++){const f=a.affiliations[j]; db.prepare("INSERT INTO metadata_observation_author_affiliations(observation_id,author_ordinal,affiliation_ordinal,name,ror) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING").run(o.observation_id,i,j,f.name,f.ror);}}
    const identifier=db.prepare("INSERT INTO metadata_observation_identifiers(observation_id,ordinal,namespace,value) VALUES(?,?,?,?) ON CONFLICT DO NOTHING"); for(let i=0;i<o.metadata.identifiers.length;i++){const x=o.metadata.identifiers[i]; identifier.run(o.observation_id,i,x.namespace,x.value);}
    const keyword=db.prepare("INSERT INTO metadata_observation_keywords(observation_id,ordinal,keyword) VALUES(?,?,?) ON CONFLICT DO NOTHING"); for(let i=0;i<o.metadata.keywords.length;i++) keyword.run(o.observation_id,i,o.metadata.keywords[i]);
    const declared=db.prepare("INSERT INTO metadata_observation_declared_keywords(observation_id,ordinal,keyword) VALUES(?,?,?) ON CONFLICT DO NOTHING"); for(let i=0;i<o.declared_keywords.length;i++) declared.run(o.observation_id,i,o.declared_keywords[i]);
    const reference=db.prepare("INSERT INTO metadata_observation_reference_texts(observation_id,reference_index,reference_text) VALUES(?,?,?) ON CONFLICT DO NOTHING"); for(let i=0;i<o.reference_texts.length;i++) reference.run(o.observation_id,i,o.reference_texts[i]);
    for(let i=0;i<(o.asset_hints||[]).length;i++){const h=o.asset_hints[i];db.prepare("INSERT INTO metadata_observation_asset_hints(observation_id,hint_ordinal,url,kind,media_type,asset_role,version_role,access_status,license) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING").run(o.observation_id,i,h.url,h.kind,h.media_type,h.asset_role,h.version_role,h.access_status,h.license);}
    for(let i=0;i<(o.version_links||[]).length;i++){const link=o.version_links[i];db.prepare("INSERT INTO metadata_observation_version_links(observation_id,link_ordinal,record_id) VALUES(?,?,?) ON CONFLICT DO NOTHING").run(o.observation_id,i,link.record_id);for(let j=0;j<link.identifiers.length;j++){const x=link.identifiers[j];db.prepare("INSERT INTO metadata_observation_version_link_identifiers(observation_id,link_ordinal,ordinal,namespace,value) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING").run(o.observation_id,i,j,x.namespace,x.value);}}
    if(o.literature_id!==undefined) db.prepare("INSERT INTO literature_metadata_observations(literature_id,observation_id) VALUES(?,?) ON CONFLICT DO NOTHING").run(o.literature_id,o.observation_id);
    return true;
}
function getObservation(id){
  const row=db.prepare("SELECT observation_id,provenance_id,version_role,reference_count,cited_by_count,title,abstract,publication_date,publication_year,document_type,language,venue,publisher,volume,issue,pages FROM metadata_observations WHERE observation_id=?").get(id); if(!row) return null;
  const p=db.prepare("SELECT provenance_id,source_kind,source_name,source_record_id,observed_at,input_sha256,parameters_sha256 FROM provenances WHERE provenance_id=(SELECT provenance_id FROM metadata_observations WHERE observation_id=?)").get(id);
  const authors=db.prepare("SELECT ordinal,kind,display_name,given_name,family_name,orcid FROM metadata_observation_authors WHERE observation_id=? ORDER BY ordinal").all(id).map(({ordinal,...a})=>({...a,affiliations:db.prepare("SELECT name,ror FROM metadata_observation_author_affiliations WHERE observation_id=? AND author_ordinal=? ORDER BY affiliation_ordinal").all(id,ordinal)}));
  const identifiers=db.prepare("SELECT namespace,value FROM metadata_observation_identifiers WHERE observation_id=? ORDER BY ordinal").all(id); const keywords=db.prepare("SELECT keyword FROM metadata_observation_keywords WHERE observation_id=? ORDER BY ordinal").all(id).map(x=>x.keyword); const declared_keywords=db.prepare("SELECT keyword FROM metadata_observation_declared_keywords WHERE observation_id=? ORDER BY ordinal").all(id).map(x=>x.keyword); const reference_texts=db.prepare("SELECT reference_text FROM metadata_observation_reference_texts WHERE observation_id=? ORDER BY reference_index").all(id).map(x=>x.reference_text);
  const owner=db.prepare("SELECT literature_id FROM literature_metadata_observations WHERE observation_id=?").get(id);
  const asset_hints=db.prepare("SELECT url,kind,media_type,asset_role,version_role,access_status,license FROM metadata_observation_asset_hints WHERE observation_id=? ORDER BY hint_ordinal").all(id);
  const version_links=db.prepare("SELECT link_ordinal,record_id FROM metadata_observation_version_links WHERE observation_id=? ORDER BY link_ordinal").all(id).map(link=>({record_id:link.record_id,identifiers:db.prepare("SELECT namespace,value FROM metadata_observation_version_link_identifiers WHERE observation_id=? AND link_ordinal=? ORDER BY ordinal").all(id,link.link_ordinal)}));
  return {observation_id:row.observation_id,provenance:p,literature_id:owner?.literature_id,version_role:row.version_role,reference_count:row.reference_count,cited_by_count:row.cited_by_count,metadata:{title:row.title,abstract:row.abstract,publication_date:row.publication_date,publication_year:row.publication_year,document_type:row.document_type,language:row.language,venue:row.venue,publisher:row.publisher,volume:row.volume,issue:row.issue,pages:row.pages,authors,identifiers,keywords},declared_keywords,reference_texts,asset_hints,version_links};
}
function identityRead(r){
  return readTransaction(()=>{
    if(!r || typeof r.observation_id!=="string" || !Array.isArray(r.stable_identifier_keys) || r.stable_identifier_keys.length>128 || !Array.isArray(r.version_link_keys) || r.version_link_keys.length>128)fail();
    const seeds=new Set();
    const addOwners=ids=>{
      for(const observationId of ids){
        const owner=db.prepare("SELECT literature_id FROM literature_metadata_observations WHERE observation_id=?").all(observationId);
        const exists=db.prepare("SELECT 1 FROM metadata_observations WHERE observation_id=?").get(observationId);
        if(owner.length>1 || (exists && owner.length!==1))fail();
        if(owner.length===1)seeds.add(owner[0].literature_id);
      }
    };
    addOwners([r.observation_id]);
    if(r.provider_record_key!==null){
      const k=r.provider_record_key;
      if(!k || typeof k.source_name!=="string" || typeof k.source_record_id!=="string")fail();
      addOwners(db.prepare("SELECT o.observation_id FROM metadata_observations o JOIN provenances p ON p.provenance_id=o.provenance_id WHERE p.source_kind='metadata-provider' AND p.source_name=? AND p.source_record_id=? ORDER BY o.observation_id").all(k.source_name,k.source_record_id).map(x=>x.observation_id));
    }
    for(const key of r.stable_identifier_keys){
      if(!Array.isArray(key) || key.length!==2 || typeof key[0]!=="string" || typeof key[1]!=="string")fail();
      for(const row of db.prepare("SELECT literature_id FROM literature_metadata_identifiers WHERE namespace=? AND value=? ORDER BY literature_id").all(key[0],key[1]))seeds.add(row.literature_id);
    }
    if(r.fallback_identity_sha256!==null){
      if(typeof r.fallback_identity_sha256!=="string")fail();
      for(const row of db.prepare("SELECT literature_id FROM literature_fallback_identity_indexes WHERE fallback_identity_sha256=? ORDER BY literature_id").all(r.fallback_identity_sha256))seeds.add(row.literature_id);
    }
    if(r.user_observation_semantic_sha256!==null){
      if(typeof r.user_observation_semantic_sha256!=="string")fail();
      addOwners(db.prepare("SELECT observation_id FROM user_observation_semantic_indexes WHERE semantic_sha256=? ORDER BY observation_id").all(r.user_observation_semantic_sha256).map(x=>x.observation_id));
    }
    for(const key of r.version_link_keys){
      if(!key || typeof key.source_name!=="string" || (key.record_id!==null && typeof key.record_id!=="string") || !Array.isArray(key.stable_identifier_keys) || key.stable_identifier_keys.length>128)fail();
      let candidates=null;
      if(key.record_id!==null)candidates=new Set(db.prepare("SELECT o.observation_id FROM metadata_observations o JOIN provenances p ON p.provenance_id=o.provenance_id WHERE p.source_kind='metadata-provider' AND p.source_name=? AND p.source_record_id=? ORDER BY o.observation_id").all(key.source_name,key.record_id).map(x=>x.observation_id));
      for(const stable of key.stable_identifier_keys){
        if(!Array.isArray(stable) || stable.length!==2 || typeof stable[0]!=="string" || typeof stable[1]!=="string")fail();
        const matches=new Set(db.prepare("SELECT observation_id FROM metadata_observation_identifiers WHERE namespace=? AND value=? ORDER BY observation_id").all(stable[0],stable[1]).map(x=>x.observation_id));
        candidates=candidates===null?matches:new Set([...candidates].filter(id=>matches.has(id)));
      }
      addOwners(candidates===null?[]:[...candidates]);
    }
    if(!seeds.size)return {literatures:[],meta_literatures:[],observations:[],facts:[]};
    const metaIds=new Set();
    for(const id of [...seeds].sort()){
      const row=db.prepare("SELECT meta_literature_id FROM literatures WHERE literature_id=?").get(id);
      if(!row)fail();
      metaIds.add(row.meta_literature_id);
    }
    const memberIds=[];
    for(const metaId of [...metaIds].sort())for(const row of db.prepare("SELECT literature_id FROM literatures WHERE meta_literature_id=? ORDER BY literature_id").all(metaId))memberIds.push(row.literature_id);
    const literatures=memberIds.map(getLiterature);
    if(literatures.some(x=>!x))fail();
    const meta_literatures=[...metaIds].sort().map(metaId=>db.prepare("SELECT meta_literature_id,representative_literature_id FROM meta_literatures WHERE meta_literature_id=?").get(metaId));
    if(meta_literatures.some(x=>!x))fail();
    const observations=[];
    for(const literatureId of memberIds)for(const row of db.prepare("SELECT observation_id FROM literature_metadata_observations WHERE literature_id=? ORDER BY observation_id").all(literatureId)){
      const stored=getObservation(row.observation_id);if(!stored)fail();const {literature_id,...observation}=stored;
      if(literature_id!==literatureId)fail();
      observations.push({literature_id:literatureId,observation});
    }
    const facts=literatures.map(literature=>{
      const metadata=db.prepare("SELECT metadata_revision,metadata_sha256 FROM literature_metadata WHERE literature_id=?").get(literature.literature_id);if(!metadata)fail();
      return {literature,metadata_revision:metadata.metadata_revision,metadata_sha256:metadata.metadata_sha256,content_ready:stateEvidence(literature.literature_id).status==='CONTENT_READY'};
    });
    return {literatures,meta_literatures,observations,facts};
  });
}
function checkIdentityToken(token){
  const row=db.prepare("SELECT l.meta_literature_id,m.metadata_revision,m.metadata_sha256 FROM literatures l JOIN literature_metadata m ON m.literature_id=l.literature_id WHERE l.literature_id=?").get(token.literature_id);
  if(!row || row.meta_literature_id!==token.meta_literature_id || row.metadata_revision!==token.metadata_revision || row.metadata_sha256!==token.metadata_sha256)fail();
}
function checkMetaIdentityToken(token){
  const row=db.prepare("SELECT representative_literature_id FROM meta_literatures WHERE meta_literature_id=?").get(token.meta_literature_id);
  const members=db.prepare("SELECT literature_id FROM literatures WHERE meta_literature_id=? ORDER BY literature_id").all(token.meta_literature_id).map(x=>x.literature_id);
  if(!row || row.representative_literature_id!==token.representative_literature_id || JSON.stringify(members)!==JSON.stringify(token.member_literature_ids))fail();
}
function normalizeDiscoveryMemberships(literatureIds,retiredMetaIds){
  const moved=new Set();
  for(const literatureId of literatureIds){
    const current=db.prepare("SELECT meta_literature_id FROM literatures WHERE literature_id=?").get(literatureId);if(!current)fail();
    for(const row of db.prepare("SELECT discovery_run_id,meta_literature_id,metadata_observation_id,actual_literature_id FROM topic_discovery_causes WHERE actual_literature_id=?").all(literatureId)){
      if(row.meta_literature_id===current.meta_literature_id)continue;
      db.prepare("INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES(?,?) ON CONFLICT DO NOTHING").run(row.discovery_run_id,current.meta_literature_id);
      db.prepare("UPDATE topic_discovery_causes SET meta_literature_id=? WHERE discovery_run_id=? AND meta_literature_id=? AND metadata_observation_id=? AND actual_literature_id=?").run(current.meta_literature_id,row.discovery_run_id,row.meta_literature_id,row.metadata_observation_id,row.actual_literature_id);
      moved.add(row.discovery_run_id+"\u0000"+row.meta_literature_id);
    }
    for(const row of db.prepare("SELECT discovery_run_id,meta_literature_id,source_literature_id,target_literature_id,actual_literature_id,depth FROM citation_discovery_causes WHERE actual_literature_id=?").all(literatureId)){
      if(row.meta_literature_id===current.meta_literature_id)continue;
      db.prepare("INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES(?,?) ON CONFLICT DO NOTHING").run(row.discovery_run_id,current.meta_literature_id);
      db.prepare("UPDATE citation_discovery_causes SET meta_literature_id=? WHERE discovery_run_id=? AND meta_literature_id=? AND source_literature_id=? AND target_literature_id=? AND actual_literature_id=? AND depth=?").run(current.meta_literature_id,row.discovery_run_id,row.meta_literature_id,row.source_literature_id,row.target_literature_id,row.actual_literature_id,row.depth);
      moved.add(row.discovery_run_id+"\u0000"+row.meta_literature_id);
    }
  }
  for(const value of [...moved].sort()){
    const [runId,oldMetaId]=value.split("\u0000");
    const remains=db.prepare("SELECT EXISTS(SELECT 1 FROM topic_discovery_causes WHERE discovery_run_id=? AND meta_literature_id=?) OR EXISTS(SELECT 1 FROM citation_discovery_causes WHERE discovery_run_id=? AND meta_literature_id=?) AS present").get(runId,oldMetaId,runId,oldMetaId);
    if(!remains.present)db.prepare("DELETE FROM discovery_results WHERE discovery_run_id=? AND meta_literature_id=?").run(runId,oldMetaId);
  }
  for(const metaId of retiredMetaIds)if(db.prepare("SELECT 1 FROM discovery_results WHERE meta_literature_id=?").get(metaId))fail();
}
function publishIdentityObservation(p){
  return transaction(()=>{
    if(!p || !Array.isArray(p.literatures) || !Array.isArray(p.meta_literatures) || !Array.isArray(p.expected_literatures) || !Array.isArray(p.expected_meta_literatures) || !Array.isArray(p.retired_meta_literature_ids) || !Array.isArray(p.clear_automatic_pdf_exhaustion_for))fail();
    const expectedLiteratures=new Map();
    for(const token of p.expected_literatures){if(expectedLiteratures.has(token.literature_id))fail();checkIdentityToken(token);expectedLiteratures.set(token.literature_id,token);}
    const expectedMetas=new Map();
    for(const token of p.expected_meta_literatures){if(expectedMetas.has(token.meta_literature_id))fail();checkMetaIdentityToken(token);expectedMetas.set(token.meta_literature_id,token);}
    const metas=new Set();
    for(const meta of p.meta_literatures){
      if(metas.has(meta.meta_literature_id))fail();metas.add(meta.meta_literature_id);
      const existing=db.prepare("SELECT representative_literature_id FROM meta_literatures WHERE meta_literature_id=?").get(meta.meta_literature_id);
      if(existing && !expectedMetas.has(meta.meta_literature_id))fail();
      if(existing)db.prepare("UPDATE meta_literatures SET representative_literature_id=? WHERE meta_literature_id=?").run(meta.representative_literature_id,meta.meta_literature_id);
      else db.prepare("INSERT INTO meta_literatures(meta_literature_id,representative_literature_id) VALUES(?,?)").run(meta.meta_literature_id,meta.representative_literature_id);
    }
    const changedIds=new Set();
    for(const item of p.literatures){
      const l=item.literature;if(changedIds.has(l.literature_id))fail();changedIds.add(l.literature_id);
      const existing=db.prepare("SELECT meta_literature_id,version_role FROM literatures WHERE literature_id=?").get(l.literature_id);
      if(existing && !expectedLiteratures.has(l.literature_id))fail();
      if(!existing && expectedLiteratures.has(l.literature_id))fail();
      if(existing)db.prepare("UPDATE literatures SET meta_literature_id=?,version_role=? WHERE literature_id=?").run(l.meta_literature_id,l.version_role,l.literature_id);
      else db.prepare("INSERT INTO literatures(literature_id,meta_literature_id,version_role) VALUES(?,?,?)").run(l.literature_id,l.meta_literature_id,l.version_role);
      writeMetadataAtRevision(l.literature_id,l.metadata,item.metadata_revision,item.metadata_sha256);
      replaceFallbackIndex(l.literature_id,item.fallback_identity_sha256);
    }
    normalizeDiscoveryMemberships([...changedIds],p.retired_meta_literature_ids);
    if(p.observation!==null){
      const link=p.observation;if(!db.prepare("SELECT 1 FROM literatures WHERE literature_id=?").get(link.literature_id))fail();
      storeObservation({...link.observation,literature_id:link.literature_id});
      if(link.user_semantic_sha256!==null){
        const existing=db.prepare("SELECT semantic_sha256 FROM user_observation_semantic_indexes WHERE observation_id=?").get(link.observation.observation_id);
        if(existing && existing.semantic_sha256!==link.user_semantic_sha256)fail();
        if(!existing)db.prepare("INSERT INTO user_observation_semantic_indexes(observation_id,semantic_sha256) VALUES(?,?)").run(link.observation.observation_id,link.user_semantic_sha256);
      }
    }
    for(const meta of p.meta_literatures)if(!db.prepare("SELECT 1 FROM literatures WHERE literature_id=? AND meta_literature_id=?").get(meta.representative_literature_id,meta.meta_literature_id))fail();
    for(const metaId of p.retired_meta_literature_ids){if(!expectedMetas.has(metaId) || db.prepare("SELECT 1 FROM literatures WHERE meta_literature_id=?").get(metaId))fail();db.prepare("DELETE FROM meta_literatures WHERE meta_literature_id=?").run(metaId);}
    for(const literatureId of p.clear_automatic_pdf_exhaustion_for){if(!db.prepare("SELECT 1 FROM literatures WHERE literature_id=?").get(literatureId))fail();db.prepare("DELETE FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?").run(literatureId);}
    return true;
  });
}
function acceptObservation(c){
  try {
    db.exec("BEGIN IMMEDIATE");
    const current=db.prepare("SELECT metadata_revision,metadata_sha256 FROM literature_metadata WHERE literature_id=?").get(c.literatureId);
    if(!current || current.metadata_revision!==c.expectedMetadataRevision || current.metadata_sha256!==c.expectedMetadataSha256) fail();
    const observation=db.prepare("SELECT title,abstract,publication_date,publication_year,document_type,language,venue,publisher,volume,issue,pages FROM metadata_observations WHERE observation_id=?").get(c.observationId); if(!observation) fail();
    db.prepare("UPDATE literature_metadata SET metadata_revision=metadata_revision+1,metadata_sha256=?,title=?,abstract=?,publication_date=?,publication_year=?,document_type=?,language=?,venue=?,publisher=?,volume=?,issue=?,pages=? WHERE literature_id=?").run(c.nextMetadataSha256,observation.title,observation.abstract,observation.publication_date,observation.publication_year,observation.document_type,observation.language,observation.venue,observation.publisher,observation.volume,observation.issue,observation.pages,c.literatureId);
    db.prepare("DELETE FROM literature_metadata_authors WHERE literature_id=?").run(c.literatureId); db.prepare("DELETE FROM literature_metadata_identifiers WHERE literature_id=?").run(c.literatureId); db.prepare("DELETE FROM literature_metadata_keywords WHERE literature_id=?").run(c.literatureId);
    db.prepare("INSERT INTO literature_metadata_authors(literature_id,ordinal,kind,display_name,given_name,family_name,orcid) SELECT ?,ordinal,kind,display_name,given_name,family_name,orcid FROM metadata_observation_authors WHERE observation_id=?").run(c.literatureId,c.observationId);
    db.prepare("INSERT INTO literature_metadata_author_affiliations(literature_id,author_ordinal,affiliation_ordinal,name,ror) SELECT ?,author_ordinal,affiliation_ordinal,name,ror FROM metadata_observation_author_affiliations WHERE observation_id=?").run(c.literatureId,c.observationId);
    db.prepare("INSERT INTO literature_metadata_identifiers(literature_id,ordinal,namespace,value) SELECT ?,ordinal,namespace,value FROM metadata_observation_identifiers WHERE observation_id=?").run(c.literatureId,c.observationId);
    db.prepare("INSERT INTO literature_metadata_keywords(literature_id,ordinal,keyword) SELECT ?,ordinal,keyword FROM metadata_observation_keywords WHERE observation_id=?").run(c.literatureId,c.observationId);
    db.prepare("INSERT INTO literature_metadata_observations(literature_id,observation_id) VALUES(?,?)").run(c.literatureId,c.observationId);
    indexMetadata(c.literatureId,getLiterature(c.literatureId).metadata);
    db.exec("COMMIT"); return true;
  } catch(e){ try{db.exec("ROLLBACK");}catch{} throw e; }
}
function insertExact(table, values, key) {
  const columns=Object.keys(values);
  db.prepare("INSERT INTO "+table+"("+columns.join(",")+") VALUES("+columns.map(()=>"?").join(",")+") ON CONFLICT("+key+") DO NOTHING").run(...Object.values(values));
  const row=db.prepare("SELECT * FROM "+table+" WHERE "+key+"=?").get(values[key]);
  if(!row || columns.some(column=>row[column]!==values[column])) fail();
}
function writeLiteratureAsset(p){
  insertExact("provenances",p.provenance,"provenance_id");
  const a=p.asset;
  const registered=db.prepare("SELECT sha256,byte_size,media_type FROM artifact_objects WHERE relative_path=?").get(a.path);
  if(registered){if(registered.sha256!==a.sha256 || registered.byte_size!==a.size_bytes || registered.media_type!==a.media_type)fail();}
  else insertExact("artifact_objects",{artifact_id:a.asset_id,sha256:a.sha256,byte_size:a.size_bytes,media_type:a.media_type,relative_path:a.path},"artifact_id");
  insertExact("assets",{asset_id:a.asset_id,sha256:a.sha256,size_bytes:a.size_bytes,media_type:a.media_type,relative_path:a.path},"asset_id");
  insertExact("literature_assets",{literature_asset_id:p.literature_asset_id,literature_id:p.literature_id,asset_id:a.asset_id,role:p.role,provenance_id:p.provenance.provenance_id,source_url:p.source_url},"literature_asset_id");
}
function transaction(operation){
  db.exec("BEGIN IMMEDIATE");
  try {const value=operation(); db.exec("COMMIT"); return value;}
  catch(error){db.exec("ROLLBACK"); throw error;}
}
function readTransaction(operation){
  db.exec("BEGIN");
  try {const value=operation(); db.exec("COMMIT"); return value;}
  catch(error){db.exec("ROLLBACK"); throw error;}
}
function requireCount(result,count){if(result.changes!==count)fail();}
function putLiteratureAsset(p){return transaction(()=>{writeLiteratureAsset(p); return true;});}
const executionSchema = ${JSON.stringify(EXECUTION_SCHEMA)};
const executionRuntimeSchema = ${JSON.stringify(EXECUTION_RUNTIME_SCHEMA)};
function requireExecution(){
  const row=db.prepare("SELECT version,fingerprint FROM execution_schema_identity WHERE singleton=1").get();
  if(!row || row.version!==${JSON.stringify(EXECUTION_SCHEMA_VERSION)} || row.fingerprint!==${JSON.stringify(EXECUTION_SCHEMA_FINGERPRINT)}) fail();
}
function runtimeTables(){
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'execution_%' ORDER BY name").all().map(row=>row.name);
}
function requireRuntime(){
  const row=db.prepare("SELECT version,fingerprint FROM execution_runtime_schema_identity WHERE singleton=1").get();
  if(!row || row.version!==${JSON.stringify(EXECUTION_RUNTIME_SCHEMA_VERSION)} || row.fingerprint!==${JSON.stringify(EXECUTION_RUNTIME_SCHEMA_FINGERPRINT)}) fail();
}
function runtimeInspect(){
  const catalog=db.prepare("SELECT schema_version,schema_fingerprint FROM schema_identity WHERE singleton=1").get();
  if(!catalog)fail();
  const row=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_runtime_schema_identity'").get();
  const identity=row?db.prepare("SELECT version,fingerprint FROM execution_runtime_schema_identity WHERE singleton=1").get():null;
  const names=runtimeTables();
  const counts={};
  for(const name of names){ if(name==='execution_runtime_schema_identity') continue; counts[name]=Number(db.prepare("SELECT count(*) AS count FROM "+name).get().count); }
  return {catalog_version:catalog.schema_version,catalog_fingerprint:catalog.schema_fingerprint,version:identity?.version??null,fingerprint:identity?.fingerprint??null,migrated:catalog.schema_version===${JSON.stringify(SCHEMA_V2_VERSION)} && catalog.schema_fingerprint===${JSON.stringify(SCHEMA_V2_FINGERPRINT)} && !!identity && identity.version===${JSON.stringify(EXECUTION_RUNTIME_SCHEMA_VERSION)} && identity.fingerprint===${JSON.stringify(EXECUTION_RUNTIME_SCHEMA_FINGERPRINT)},tables:names,counts};
}
function migrationReceipt(action, fromVersion){
  return {migration_id:"catalog-v2-"+randomUUID(),action,from_version:fromVersion,to_version:${JSON.stringify(SCHEMA_V2_VERSION)},manifest_fingerprint:${JSON.stringify(SCHEMA_V2_FINGERPRINT)},applied_at:new Date().toISOString(),inspection:runtimeInspect()};
}
function migrateRuntime(dryRun){
  const current=runtimeInspect();
  if(dryRun)return migrationReceipt("dry-run",current.catalog_version);
  if(current.migrated){
    const existing=db.prepare("SELECT migration_id,action,from_version,to_version,manifest_fingerprint,applied_at FROM execution_schema_migrations WHERE to_version=? AND action='migrate' ORDER BY applied_at DESC LIMIT 1").get(${JSON.stringify(SCHEMA_V2_VERSION)});
    if(existing)return {...existing,inspection:current};
  }
  if(current.catalog_version!==1 || current.catalog_fingerprint!==${JSON.stringify(SCHEMA_FINGERPRINT)})fail();
  return transaction(()=>{
    for(const statement of executionSchema) db.exec(statement);
    db.prepare("INSERT INTO execution_schema_identity(singleton,version,fingerprint) VALUES(1,?,?)").run(${JSON.stringify(EXECUTION_SCHEMA_VERSION)},${JSON.stringify(EXECUTION_SCHEMA_FINGERPRINT)});
    for(const statement of executionRuntimeSchema) db.exec(statement);
    db.prepare("INSERT INTO execution_runtime_schema_identity(singleton,version,fingerprint) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version,fingerprint=excluded.fingerprint").run(${JSON.stringify(EXECUTION_RUNTIME_SCHEMA_VERSION)},${JSON.stringify(EXECUTION_RUNTIME_SCHEMA_FINGERPRINT)});
    const createdAt=db.prepare("SELECT created_at FROM schema_identity WHERE singleton=1").get()?.created_at;
    if(typeof createdAt!=="string" || !createdAt.trim())fail();
    db.exec("DROP TABLE schema_identity");
    db.exec(${JSON.stringify(SCHEMA_IDENTITY_V2)});
    db.prepare("INSERT INTO schema_identity(singleton,product,schema_version,schema_fingerprint,created_at) VALUES(1,'sciretriever',?,?,?)").run(${JSON.stringify(SCHEMA_V2_VERSION)},${JSON.stringify(SCHEMA_V2_FINGERPRINT)},createdAt);
    const receipt=migrationReceipt("migrate",current.catalog_version);
    db.prepare("INSERT INTO execution_schema_migrations(migration_id,from_version,to_version,manifest_fingerprint,action,applied_at) VALUES(?,?,?,?,?,?)").run(receipt.migration_id,receipt.from_version,receipt.to_version,receipt.manifest_fingerprint,receipt.action,receipt.applied_at);
    return {...receipt,inspection:runtimeInspect()};
  });
}
function upgradeExecution(){
  migrateRuntime(false);
  requireExecution();
  requireRuntime();
  return true;
}
function backupExecution(path){
  if(typeof path!=="string" || !path.startsWith("/") || path===workerData.path) fail();
  const {existsSync}=require("node:fs");
  if(existsSync(path)) fail();
  const integrity=db.prepare("PRAGMA integrity_check").get();
  if(!integrity || integrity.integrity_check!=="ok") fail();
  db.prepare("VACUUM INTO ?").run(path);
  return {path,integrity:"ok"};
}
function restoreCheck(path){
  if(typeof path!=="string" || !path.startsWith("/") || path===workerData.path) fail();
  const {existsSync}=require("node:fs");
  if(!existsSync(path)) fail();
  const { DatabaseSync }=require("node:sqlite");
  const candidate=new DatabaseSync(path,{readOnly:true});
  try {
    const integrity=candidate.prepare("PRAGMA integrity_check").get();
    if(!integrity || integrity.integrity_check!=="ok") fail();
    const schema=candidate.prepare("SELECT schema_version,schema_fingerprint FROM schema_identity WHERE singleton=1").get();
    if(!schema || !((schema.schema_version===1 && schema.schema_fingerprint===${JSON.stringify(SCHEMA_FINGERPRINT)}) || (schema.schema_version===${JSON.stringify(SCHEMA_V2_VERSION)} && schema.schema_fingerprint===${JSON.stringify(SCHEMA_V2_FINGERPRINT)}))) fail();
    const runtime=candidate.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_runtime_schema_identity'").get();
    const identity=runtime?candidate.prepare("SELECT version,fingerprint FROM execution_runtime_schema_identity WHERE singleton=1").get():null;
    const names=candidate.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'execution_%' ORDER BY name").all().map(row=>row.name);
    const counts={};
    for(const name of names){if(name==='execution_runtime_schema_identity')continue; counts[name]=Number(candidate.prepare("SELECT count(*) AS count FROM "+name).get().count);}
    return {path,integrity:"ok",schema_version:schema.schema_version,schema_fingerprint:schema.schema_fingerprint,runtime:{catalog_version:schema.schema_version,catalog_fingerprint:schema.schema_fingerprint,version:identity?.version??null,fingerprint:identity?.fingerprint??null,migrated:schema.schema_version===${JSON.stringify(SCHEMA_V2_VERSION)} && schema.schema_fingerprint===${JSON.stringify(SCHEMA_V2_FINGERPRINT)} && !!identity && identity.version===${JSON.stringify(EXECUTION_RUNTIME_SCHEMA_VERSION)} && identity.fingerprint===${JSON.stringify(EXECUTION_RUNTIME_SCHEMA_FINGERPRINT)},tables:names,counts}};
  } finally { candidate.close(); }
}
function rollbackExecution(backupPath){
  requireExecution();
  backupExecution(backupPath);
  return transaction(()=>{
    const runtime=runtimeTables();
    for(const table of ["execution_leases","execution_interventions","execution_events","execution_attempts","execution_targets","execution_budgets","execution_policy_snapshots","execution_jobs","execution_schema_migrations","execution_runtime_schema_identity"]){ if(runtime.includes(table)) db.exec("DROP TABLE "+table); }
    db.exec("DROP TABLE execution_receipts; DROP TABLE execution_candidates; DROP TABLE execution_schema_identity;");
    const createdAt=db.prepare("SELECT created_at FROM schema_identity WHERE singleton=1").get()?.created_at;
    if(typeof createdAt!=="string" || !createdAt.trim())fail();
    db.exec("DROP TABLE schema_identity");
    db.exec(${JSON.stringify(SCHEMA_MANIFEST[0])});
    db.prepare("INSERT INTO schema_identity(singleton,product,schema_version,schema_fingerprint,created_at) VALUES(1,'sciretriever',1,?,?)").run(${JSON.stringify(SCHEMA_FINGERPRINT)},createdAt);
    return true;
  });
}
function createExecutionJob(job,policySha256,policyJson){
  requireRuntime();
  if(typeof policySha256!=="string" || !/^[0-9a-f]{64}$/.test(policySha256)) fail();
  return transaction(()=>{
    const policy=JSON.stringify(policyJson);
    db.prepare("INSERT INTO execution_policy_snapshots(policy_version,policy_sha256,policy_json,frozen_at) VALUES(?,?,?,?) ON CONFLICT(policy_version) DO NOTHING").run(job.policy_version,policySha256,policy,job.created_at);
    const existingPolicy=db.prepare("SELECT policy_sha256,policy_json FROM execution_policy_snapshots WHERE policy_version=?").get(job.policy_version); if(!existingPolicy || existingPolicy.policy_sha256!==policySha256 || existingPolicy.policy_json!==policy) fail();
    const selector=JSON.stringify(job.selector);
    db.prepare("INSERT INTO execution_jobs(job_id,target_kind,selector_json,policy_version,status,idempotency_key,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING").run(job.job_id,job.target_kind,selector,job.policy_version,job.status,job.idempotency_key,job.created_at,job.finished_at);
    const row=db.prepare("SELECT * FROM execution_jobs WHERE idempotency_key=?").get(job.idempotency_key); if(!row || row.target_kind!==job.target_kind || row.selector_json!==selector || row.policy_version!==job.policy_version) fail();
    db.prepare("INSERT INTO execution_budgets(job_id,max_attempts,max_network_bytes,max_model_calls,used_attempts,used_network_bytes,used_model_calls,updated_at) VALUES(?,?,?,?,0,0,0,?) ON CONFLICT(job_id) DO NOTHING").run(row.job_id,policyJson.max_attempts,policyJson.max_network_bytes,policyJson.max_model_calls,job.created_at);
    const budget=db.prepare("SELECT max_attempts,max_network_bytes,max_model_calls FROM execution_budgets WHERE job_id=?").get(row.job_id); if(!budget || budget.max_attempts!==policyJson.max_attempts || budget.max_network_bytes!==policyJson.max_network_bytes || budget.max_model_calls!==policyJson.max_model_calls)fail();
    return {job_id:row.job_id,target_kind:row.target_kind,selector:JSON.parse(row.selector_json),policy_version:row.policy_version,status:row.status,idempotency_key:row.idempotency_key,created_at:row.created_at,finished_at:row.finished_at};
  });
}
function getExecutionJob(jobId){
  requireRuntime();
  const row=db.prepare("SELECT * FROM execution_jobs WHERE job_id=?").get(jobId); if(!row)return null;
  return {job_id:row.job_id,target_kind:row.target_kind,selector:JSON.parse(row.selector_json),policy_version:row.policy_version,status:row.status,idempotency_key:row.idempotency_key,created_at:row.created_at,finished_at:row.finished_at};
}
function listExecutionJobs(limit){
  requireRuntime();
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000)fail();
  return db.prepare("SELECT * FROM execution_jobs ORDER BY created_at,job_id LIMIT ?").all(limit).map(row=>({job_id:row.job_id,target_kind:row.target_kind,selector:JSON.parse(row.selector_json),policy_version:row.policy_version,status:row.status,idempotency_key:row.idempotency_key,created_at:row.created_at,finished_at:row.finished_at}));
}
function getExecutionPolicy(jobId){
  requireRuntime();
  const row=db.prepare("SELECT p.policy_json FROM execution_jobs j JOIN execution_policy_snapshots p ON p.policy_version=j.policy_version WHERE j.job_id=?").get(jobId);
  return row?JSON.parse(row.policy_json):null;
}
function executionBudget(row){return row?{job_id:row.job_id,max_attempts:row.max_attempts,max_network_bytes:row.max_network_bytes,max_model_calls:row.max_model_calls,attempts:row.used_attempts,network_bytes:row.used_network_bytes,model_calls:row.used_model_calls,updated_at:row.updated_at}:null;}
function getExecutionBudget(jobId){
  requireRuntime();
  return executionBudget(db.prepare("SELECT * FROM execution_budgets WHERE job_id=?").get(jobId));
}
function consumeExecutionBudget(jobId,usage,now){
  requireRuntime();
  return transaction(()=>{
    const current=db.prepare("SELECT * FROM execution_budgets WHERE job_id=?").get(jobId);if(!current)fail();
    const nextAttempts=current.used_attempts+usage.attempts,nextBytes=current.used_network_bytes+usage.network_bytes,nextModels=current.used_model_calls+usage.model_calls;
    const accepted=nextAttempts<=current.max_attempts && nextBytes<=current.max_network_bytes && nextModels<=current.max_model_calls;
    if(accepted)db.prepare("UPDATE execution_budgets SET used_attempts=?,used_network_bytes=?,used_model_calls=?,updated_at=? WHERE job_id=?").run(nextAttempts,nextBytes,nextModels,now,jobId);
    return {accepted,budget:getExecutionBudget(jobId)};
  });
}
function listExecutionTargets(jobId,limit){
  requireRuntime();
  if(!Number.isSafeInteger(limit)||limit<1||limit>10000)fail();
  return db.prepare("SELECT * FROM execution_targets WHERE job_id=? ORDER BY ordinal,target_id LIMIT ?").all(jobId,limit).map(row=>({target_id:row.target_id,job_id:row.job_id,ordinal:row.ordinal,literature_id:row.literature_id,version_role:row.version_role,stage:row.stage,disposition:row.disposition,next_eligible_at:row.next_eligible_at}));
}
function listExecutionAttempts(targetId,limit){
  requireRuntime();
  if(!Number.isSafeInteger(limit)||limit<1||limit>10000)fail();
  return db.prepare("SELECT * FROM execution_attempts WHERE target_id=? ORDER BY started_at,attempt_id LIMIT ?").all(targetId,limit).map(row=>({attempt_id:row.attempt_id,target_id:row.target_id,stage:row.stage,status:row.status,started_at:row.started_at,finished_at:row.finished_at,failure:row.failure_code===null?null:{code:row.failure_code,reason:row.failure_reason,action:row.failure_action,retryable:Boolean(row.failure_retryable)},usage:row.usage_json===null?null:JSON.parse(row.usage_json)}));
}
function recoverExecution(bootId,now){
  requireRuntime();
  if(typeof bootId!=="string" || !bootId.trim() || typeof now!=="string" || !now.trim())fail();
  return transaction(()=>{
    const running=db.prepare("SELECT attempt_id,target_id FROM execution_attempts WHERE status='running'").all();
    for(const attempt of running){
      db.prepare("UPDATE execution_attempts SET status='unknown',finished_at=?,failure_code='execution-outcome-unknown',failure_reason='The process stopped before the attempt outcome was durable.',failure_action='Reconcile current facts and retry only when safe.',failure_retryable=1 WHERE attempt_id=? AND status='running'").run(now,attempt.attempt_id);
      db.prepare("UPDATE execution_targets SET stage='interrupted',disposition='interrupted',next_eligible_at=? WHERE target_id=? AND stage NOT IN ('completed','skipped','failed')").run(now,attempt.target_id);
    }
    const jobs=db.prepare("SELECT job_id FROM execution_jobs WHERE status='running'").all();
    for(const job of jobs)db.prepare("UPDATE execution_jobs SET status='interrupted',finished_at=? WHERE job_id=? AND status='running'").run(now,job.job_id);
    const releasedLeases=db.prepare("UPDATE execution_leases SET released_at=? WHERE released_at IS NULL").run(now).changes;
    const expiredInterventions=db.prepare("UPDATE execution_interventions SET status='expired',resolved_at=?,resolution_json=? WHERE status='open' AND expires_at<=?").run(now,JSON.stringify({kind:'timeout'}),now).changes;
    return {boot_id:bootId,recovered_attempts:running.length,recovered_targets:running.length,recovered_jobs:jobs.length,released_leases:releasedLeases,expired_interventions:expiredInterventions};
  });
}
function updateExecutionJob(jobId,status,finishedAt){
  requireRuntime();
  return transaction(()=>{ const result=db.prepare("UPDATE execution_jobs SET status=?,finished_at=? WHERE job_id=?").run(status,finishedAt,jobId); if(result.changes!==1)fail(); return getExecutionJob(jobId); });
}
function putExecutionTarget(target){
  requireRuntime();
  return transaction(()=>{
    if(!db.prepare("SELECT 1 FROM execution_jobs WHERE job_id=?").get(target.job_id))fail();
    db.prepare("INSERT INTO execution_targets(target_id,job_id,ordinal,literature_id,version_role,stage,disposition,next_eligible_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(target_id) DO NOTHING").run(target.target_id,target.job_id,target.ordinal,target.literature_id,target.version_role,target.stage,target.disposition,target.next_eligible_at);
    const row=db.prepare("SELECT * FROM execution_targets WHERE target_id=?").get(target.target_id); if(!row || row.job_id!==target.job_id || row.ordinal!==target.ordinal)fail();
    return {target_id:row.target_id,job_id:row.job_id,ordinal:row.ordinal,literature_id:row.literature_id,version_role:row.version_role,stage:row.stage,disposition:row.disposition,next_eligible_at:row.next_eligible_at};
  });
}
function getExecutionTarget(targetId){
  requireRuntime();
  const row=db.prepare("SELECT * FROM execution_targets WHERE target_id=?").get(targetId); if(!row)return null;
  return {target_id:row.target_id,job_id:row.job_id,ordinal:row.ordinal,literature_id:row.literature_id,version_role:row.version_role,stage:row.stage,disposition:row.disposition,next_eligible_at:row.next_eligible_at};
}
function claimExecutionTarget(jobId,now){
  requireRuntime();
  return transaction(()=>{ const row=db.prepare("SELECT target.* FROM execution_targets target JOIN execution_jobs job ON job.job_id=target.job_id WHERE target.job_id=? AND job.status IN ('queued','running') AND target.stage='queued' AND (target.next_eligible_at IS NULL OR target.next_eligible_at<=?) ORDER BY target.ordinal,target.target_id LIMIT 1").get(jobId,now); if(!row)return null; db.prepare("UPDATE execution_jobs SET status='running' WHERE job_id=? AND status='queued'").run(jobId); db.prepare("UPDATE execution_targets SET stage='acquisition',disposition='pending' WHERE target_id=?").run(row.target_id); return getExecutionTarget(row.target_id); });
}
function updateExecutionTarget(targetId,stage,disposition,nextEligibleAt){
  requireRuntime();
  return transaction(()=>{ const result=db.prepare("UPDATE execution_targets SET stage=?,disposition=?,next_eligible_at=? WHERE target_id=?").run(stage,disposition,nextEligibleAt,targetId); if(result.changes!==1)fail(); return getExecutionTarget(targetId); });
}
function startExecutionAttempt(attempt){
  requireRuntime();
  return transaction(()=>{ if(!db.prepare("SELECT 1 FROM execution_targets WHERE target_id=?").get(attempt.target_id))fail(); db.prepare("INSERT INTO execution_attempts(attempt_id,target_id,stage,status,started_at,finished_at,failure_code,failure_reason,failure_action,failure_retryable,usage_json) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id) DO NOTHING").run(attempt.attempt_id,attempt.target_id,attempt.stage,attempt.status,attempt.started_at,attempt.finished_at,attempt.failure?.code??null,attempt.failure?.reason??null,attempt.failure?.action??null,attempt.failure===null?null:Number(attempt.failure.retryable),attempt.usage===null?null:JSON.stringify(attempt.usage)); const row=db.prepare("SELECT * FROM execution_attempts WHERE attempt_id=?").get(attempt.attempt_id); if(!row)fail(); return {attempt_id:row.attempt_id,target_id:row.target_id,stage:row.stage,status:row.status,started_at:row.started_at,finished_at:row.finished_at,failure:row.failure_code===null?null:{code:row.failure_code,reason:row.failure_reason,action:row.failure_action,retryable:Boolean(row.failure_retryable)},usage:row.usage_json===null?null:JSON.parse(row.usage_json)}; });
}
function finishExecutionAttempt(attemptId,status,finishedAt,failure,usage){
  requireRuntime();
  return transaction(()=>{ const result=db.prepare("UPDATE execution_attempts SET status=?,finished_at=?,failure_code=?,failure_reason=?,failure_action=?,failure_retryable=?,usage_json=? WHERE attempt_id=?").run(status,finishedAt,failure?.code??null,failure?.reason??null,failure?.action??null,failure===null?null:Number(failure.retryable),usage===null?null:JSON.stringify(usage),attemptId); if(result.changes!==1)fail(); const row=db.prepare("SELECT * FROM execution_attempts WHERE attempt_id=?").get(attemptId); return {attempt_id:row.attempt_id,target_id:row.target_id,stage:row.stage,status:row.status,started_at:row.started_at,finished_at:row.finished_at,failure:row.failure_code===null?null:{code:row.failure_code,reason:row.failure_reason,action:row.failure_action,retryable:Boolean(row.failure_retryable)},usage:row.usage_json===null?null:JSON.parse(row.usage_json)}; });
}
function appendExecutionEvent(event){
  requireRuntime();
  return transaction(()=>{ if(!db.prepare("SELECT 1 FROM execution_jobs WHERE job_id=?").get(event.job_id))fail(); const last=db.prepare("SELECT max(sequence) AS sequence FROM execution_events WHERE job_id=?").get(event.job_id); const expected=last.sequence===null?0:Number(last.sequence)+1; if(event.sequence!==expected)fail(); db.prepare("INSERT INTO execution_events(event_id,job_id,sequence,kind,payload_json,created_at) VALUES(?,?,?,?,?,?)").run(event.event_id,event.job_id,event.sequence,event.kind,JSON.stringify(event.payload),event.created_at); return event; });
}
function listExecutionEvents(jobId,after,limit){
  requireRuntime();
  if(!Number.isSafeInteger(after)||after<-1||!Number.isSafeInteger(limit)||limit<1||limit>1000)fail();
  return db.prepare("SELECT * FROM execution_events WHERE job_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(jobId,after,limit).map(row=>({event_id:row.event_id,job_id:row.job_id,sequence:row.sequence,kind:row.kind,payload:JSON.parse(row.payload_json),created_at:row.created_at}));
}
function executionIntervention(row){return {intervention_id:row.intervention_id,job_id:row.job_id,target_id:row.target_id,mode:row.mode,status:row.status,failure:JSON.parse(row.failure_json),created_at:row.created_at,expires_at:row.expires_at,resolved_at:row.resolved_at,resolution:row.resolution_json===null?null:JSON.parse(row.resolution_json)};}
function putExecutionIntervention(value){
  requireRuntime();
  return transaction(()=>{
    if(!db.prepare("SELECT 1 FROM execution_jobs WHERE job_id=?").get(value.job_id))fail();
    if(value.target_id!==null && !db.prepare("SELECT 1 FROM execution_targets WHERE target_id=? AND job_id=?").get(value.target_id,value.job_id))fail();
    const failure=JSON.stringify(value.failure),resolution=value.resolution===null?null:JSON.stringify(value.resolution);
    db.prepare("INSERT INTO execution_interventions(intervention_id,job_id,target_id,mode,status,failure_json,created_at,expires_at,resolved_at,resolution_json) VALUES(?,?,?,?,?,?,?,?,?,?)").run(value.intervention_id,value.job_id,value.target_id,value.mode,value.status,failure,value.created_at,value.expires_at,value.resolved_at,resolution);
    if(value.mode==='pause' && value.status==='open')db.prepare("UPDATE execution_jobs SET status='paused' WHERE job_id=? AND status IN ('queued','running')").run(value.job_id);
    return executionIntervention(db.prepare("SELECT * FROM execution_interventions WHERE intervention_id=?").get(value.intervention_id));
  });
}
function listExecutionInterventions(jobId,limit){
  requireRuntime();
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000)fail();
  return db.prepare("SELECT * FROM execution_interventions WHERE job_id=? ORDER BY created_at,intervention_id LIMIT ?").all(jobId,limit).map(executionIntervention);
}
function resolveExecutionIntervention(interventionId,status,resolvedAt,resolution){
  requireRuntime();
  return transaction(()=>{
    const encoded=JSON.stringify(resolution);
    const result=db.prepare("UPDATE execution_interventions SET status=?,resolved_at=?,resolution_json=? WHERE intervention_id=? AND status='open'").run(status,resolvedAt,encoded,interventionId);if(result.changes!==1)fail();
    return executionIntervention(db.prepare("SELECT * FROM execution_interventions WHERE intervention_id=?").get(interventionId));
  });
}
function acquireExecutionLease(lease){
  requireRuntime();
  return transaction(()=>{ if(db.prepare("SELECT 1 FROM execution_leases WHERE job_id=? AND released_at IS NULL").get(lease.job_id))fail(); db.prepare("INSERT INTO execution_leases(lease_id,job_id,workspace_id,boot_id,control_epoch,acquired_at,released_at) VALUES(?,?,?,?,?,?,?)").run(lease.lease_id,lease.job_id,lease.workspace_id,lease.boot_id,lease.control_epoch,lease.acquired_at,lease.released_at); return lease; });
}
function releaseExecutionLease(leaseId,releasedAt){
  requireRuntime();
  return transaction(()=>{ const result=db.prepare("UPDATE execution_leases SET released_at=? WHERE lease_id=? AND released_at IS NULL").run(releasedAt,leaseId); if(result.changes!==1)fail(); return true; });
}
function putCandidate(candidate){
  requireExecution();
  insertExact("execution_candidates",{transfer_id:candidate.transfer_id,record_json:JSON.stringify(candidate)},"transfer_id");
  return true;
}
function retireCandidate(candidate){
  requireExecution();
  return transaction(()=>{
    const current=getCandidate(candidate.transfer_id);
    if(!current || JSON.stringify(current)!==JSON.stringify(candidate)) return null;
    if(db.prepare("SELECT 1 FROM execution_receipts WHERE transfer_id=? LIMIT 1").get(candidate.transfer_id)) return null;
    requireCount(db.prepare("DELETE FROM execution_candidates WHERE transfer_id=?").run(candidate.transfer_id),1);
    return current;
  });
}
function getCandidate(transferId){
  requireExecution();
  const row=db.prepare("SELECT record_json FROM execution_candidates WHERE transfer_id=?").get(transferId);
  return row?JSON.parse(row.record_json):null;
}
function getReceiptIntent(receiptId){
  requireExecution();
  const row=db.prepare("SELECT intent_json FROM execution_receipts WHERE receipt_id=?").get(receiptId);
  return row?JSON.parse(row.intent_json):null;
}
function getReceiptResult(receiptId){
  requireExecution();
  const row=db.prepare("SELECT result_json FROM execution_receipts WHERE receipt_id=?").get(receiptId);
  return row?.result_json?JSON.parse(row.result_json):null;
}
function listCandidates(articleId){
  requireExecution();
  return db.prepare("SELECT record_json FROM execution_candidates WHERE json_extract(record_json,'$.capture.article_id')=? ORDER BY transfer_id LIMIT 100").all(articleId).map(row=>JSON.parse(row.record_json));
}
function requireMetadataSnapshot(intent){
  const row=db.prepare("SELECT metadata_revision,metadata_sha256 FROM literature_metadata WHERE literature_id=?").get(intent.literature_id);
  if(!row || row.metadata_revision!==intent.metadata_snapshot.revision || row.metadata_sha256!==intent.metadata_snapshot.sha256) fail();
}
function prepareReceipt(intent){
  requireExecution();
  return transaction(()=>{
    const candidate=getCandidate(intent.candidate.transfer_id);
    if(!candidate || JSON.stringify(candidate)!==JSON.stringify(intent.candidate)) fail();
    if(!db.prepare("SELECT 1 FROM literatures WHERE literature_id=?").get(intent.literature_id)) fail();
    const record=JSON.stringify(intent);
    db.prepare("INSERT INTO execution_receipts(receipt_id,transfer_id,intent_json) VALUES(?,?,?) ON CONFLICT(receipt_id) DO NOTHING").run(intent.receipt_id,intent.candidate.transfer_id,record);
    const row=db.prepare("SELECT intent_json,result_json FROM execution_receipts WHERE receipt_id=?").get(intent.receipt_id);
    if(row.intent_json!==record) fail();
    if (!row.result_json) requireMetadataSnapshot(intent);
    return row.result_json ? JSON.parse(row.result_json) : null;
  });
}
function commitReceipt(intent,created){
  requireExecution();
  return transaction(()=>{
    const row=db.prepare("SELECT intent_json,result_json FROM execution_receipts WHERE receipt_id=?").get(intent.receipt_id);
    if(!row || row.intent_json!==JSON.stringify(intent)) fail();
    if(row.result_json) return JSON.parse(row.result_json);
    requireMetadataSnapshot(intent);
    const c=intent.candidate;
    const existing=db.prepare("SELECT a.asset_id,a.sha256,a.size_bytes,a.relative_path FROM literature_assets l JOIN assets a ON a.asset_id=l.asset_id WHERE l.literature_id=? AND l.role='primary-pdf'").get(intent.literature_id);
    if(existing){
      if(existing.asset_id!==intent.asset_id || existing.sha256!==c.sha256 || existing.size_bytes!==c.size_bytes || existing.relative_path!==intent.target) fail();
      insertExact("provenances",intent.provenance,"provenance_id");
    } else writeLiteratureAsset({literature_asset_id:intent.literature_asset_id,literature_id:intent.literature_id,asset:{asset_id:intent.asset_id,sha256:c.sha256,size_bytes:c.size_bytes,media_type:"application/pdf",path:intent.target},role:"primary-pdf",provenance:intent.provenance,source_url:intent.source_url});
    db.prepare("DELETE FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?").run(intent.literature_id);
    const result={receipt_id:intent.receipt_id,literature_id:intent.literature_id,asset_id:intent.asset_id,sha256:c.sha256,reference:intent.target,created};
    db.prepare("UPDATE execution_receipts SET result_json=? WHERE receipt_id=?").run(JSON.stringify(result),intent.receipt_id);
    return result;
  });
}
function pendingReceipts(){
  requireExecution();
  return db.prepare("SELECT intent_json FROM execution_receipts WHERE result_json IS NULL ORDER BY receipt_id").all().map(row=>JSON.parse(row.intent_json));
}
function currentParser(sourceId){
  const p=db.prepare("SELECT * FROM parser_results WHERE source_asset_id=?").get(sourceId);
  if(!p)return null;
  const provenance=(id)=>db.prepare("SELECT provenance_id,source_kind,source_name,source_record_id,observed_at,input_sha256,parameters_sha256 FROM provenances WHERE provenance_id=?").get(id);
  return {source_asset_id:p.source_asset_id,source_sha256:p.source_sha256,page_count:p.page_count,result_sha256:p.result_sha256,markdown:{sha256:p.markdown_sha256,media_type:p.markdown_media_type,byte_size:p.markdown_byte_size},resources:db.prepare("SELECT reference,artifact_sha256,artifact_media_type,artifact_byte_size FROM parser_result_resources WHERE source_asset_id=? ORDER BY reference").all(p.source_asset_id).map(r=>({reference:r.reference,artifact:{sha256:r.artifact_sha256,media_type:r.artifact_media_type,byte_size:r.artifact_byte_size}})),provenance:{provenance:provenance(p.provenance_id),parser_version:p.parser_version,mode:p.mode,model_identity:p.model_identity}};
}
function putParserResult(p,literatureId){
  try {
    db.exec("BEGIN IMMEDIATE");
    if(literatureId!==undefined){
      const primary=db.prepare("SELECT a.asset_id,a.sha256 FROM literature_assets l JOIN assets a ON a.asset_id=l.asset_id WHERE l.literature_id=? AND l.role='primary-pdf'").get(literatureId);
      if(!primary || primary.asset_id!==p.source_asset_id || primary.sha256!==p.source_sha256){db.exec("ROLLBACK");return null;}
      const previous=currentParser(p.source_asset_id);
      if(previous?.result_sha256===p.result_sha256){db.exec("COMMIT");return previous;}
    }
    const provenance=p.provenance;
    insertExact("provenances",provenance,"provenance_id");
    const register=(a)=>{
      const previous=db.prepare("SELECT * FROM artifact_objects WHERE sha256=?").get(a.sha256);
      if(previous){if(previous.byte_size!==a.byte_size || previous.media_type!==a.media_type || previous.relative_path!==a.relative_path)fail();return;}
      insertExact("artifact_objects",a,"artifact_id");
    };
    register({artifact_id:p.markdown_artifact_id,sha256:p.markdown_sha256,byte_size:p.markdown_byte_size,media_type:p.markdown_media_type,relative_path:p.markdown_artifact_path});
    for(const resource of (p.resources || []))register({artifact_id:resource.artifact_id,sha256:resource.artifact_sha256,byte_size:resource.artifact_byte_size,media_type:resource.artifact_media_type,relative_path:resource.artifact_path});
    db.prepare("INSERT INTO parser_results(source_asset_id,source_sha256,result_sha256,page_count,markdown_artifact_path,markdown_sha256,markdown_byte_size,markdown_media_type,provenance_id,parser_version,mode,model_identity) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_asset_id) DO UPDATE SET source_sha256=excluded.source_sha256,result_sha256=excluded.result_sha256,page_count=excluded.page_count,markdown_artifact_path=excluded.markdown_artifact_path,markdown_sha256=excluded.markdown_sha256,markdown_byte_size=excluded.markdown_byte_size,markdown_media_type=excluded.markdown_media_type,provenance_id=excluded.provenance_id,parser_version=excluded.parser_version,mode=excluded.mode,model_identity=excluded.model_identity").run(p.source_asset_id,p.source_sha256,p.result_sha256,p.page_count,p.markdown_artifact_path,p.markdown_sha256,p.markdown_byte_size,p.markdown_media_type,provenance.provenance_id,p.parser_version,p.mode,p.model_identity);
    db.prepare("DELETE FROM parser_result_resources WHERE source_asset_id=?").run(p.source_asset_id);
    const resourceInsert=db.prepare("INSERT INTO parser_result_resources(source_asset_id,ordinal,reference,artifact_path,artifact_sha256,artifact_byte_size,artifact_media_type) VALUES(?,?,?,?,?,?,?)");
    for(let i=0;i<(p.resources || []).length;i++){const resource=p.resources[i]; resourceInsert.run(p.source_asset_id,i,resource.reference,resource.artifact_path,resource.artifact_sha256,resource.artifact_byte_size,resource.artifact_media_type);}
    const committed=literatureId===undefined?true:currentParser(p.source_asset_id);db.exec("COMMIT"); return committed;
  } catch(e){ try{db.exec("ROLLBACK");}catch{} throw e; }
}
function writeLiteratureContent(c){
    const metadata=db.prepare("SELECT metadata_revision,metadata_sha256 FROM literature_metadata WHERE literature_id=?").get(c.literature_id);
    const asset=db.prepare("SELECT sha256 FROM assets WHERE asset_id=?").get(c.primary_asset_id);
    const parser=db.prepare("SELECT source_asset_id,source_sha256,result_sha256 FROM parser_results WHERE result_sha256=?").get(c.parser_result_sha256);
    if(!metadata || metadata.metadata_revision!==c.metadata_revision || metadata.metadata_sha256!==c.metadata_sha256 || !asset || asset.sha256!==c.primary_asset_sha256 || !parser || parser.source_asset_id!==c.primary_asset_id || parser.source_sha256!==c.primary_asset_sha256) fail();
    const provenance=c.provenance;
    insertExact("provenances",provenance,"provenance_id");
    const artifacts=[{artifact_id:c.structured_artifact_id,relative_path:c.structured_artifact_path,sha256:c.structured_artifact_sha256,byte_size:c.structured_artifact_byte_size,media_type:c.structured_artifact_media_type},{artifact_id:c.markdown_artifact_id,relative_path:c.markdown_artifact_path,sha256:c.markdown_artifact_sha256,byte_size:c.markdown_artifact_byte_size,media_type:c.markdown_artifact_media_type}];
    for(const a of artifacts){const prior=db.prepare("SELECT * FROM artifact_objects WHERE sha256=?").get(a.sha256);if(prior){if(prior.relative_path!==a.relative_path||prior.byte_size!==a.byte_size||prior.media_type!==a.media_type)fail();}else insertExact("artifact_objects",a,"artifact_id");}
    const old=db.prepare("SELECT literature_content_sha256 FROM literature_contents WHERE literature_id=?").get(c.literature_id);
    if(old && old.literature_content_sha256!==c.literature_content_sha256){
      const affected=db.prepare("SELECT DISTINCT s.reference_id FROM content_reference_text_supports s JOIN literature_references r ON r.reference_id=s.reference_id WHERE s.literature_content_sha256=? AND r.source_literature_id=?").all(old.literature_content_sha256,c.literature_id);
      for(const r of affected){
        db.prepare("DELETE FROM content_reference_text_supports WHERE reference_id=? AND literature_content_sha256=?").run(r.reference_id,old.literature_content_sha256);
        db.prepare("DELETE FROM literature_references WHERE reference_id=? AND NOT EXISTS(SELECT 1 FROM provider_relation_reference_supports s WHERE s.reference_id=literature_references.reference_id) AND NOT EXISTS(SELECT 1 FROM metadata_reference_text_supports s WHERE s.reference_id=literature_references.reference_id) AND NOT EXISTS(SELECT 1 FROM content_reference_text_supports s WHERE s.reference_id=literature_references.reference_id)").run(r.reference_id);
      }
      if(!db.prepare("SELECT 1 FROM literature_contents WHERE literature_content_sha256=? AND literature_id<>?").get(old.literature_content_sha256,c.literature_id))db.prepare("DELETE FROM literature_content_reference_texts WHERE literature_content_sha256=?").run(old.literature_content_sha256);
    }
    db.prepare("INSERT INTO literature_contents(literature_id,literature_content_sha256,metadata_revision,metadata_sha256,primary_asset_id,primary_asset_sha256,parser_result_sha256,structured_artifact_path,structured_artifact_sha256,structured_artifact_byte_size,structured_artifact_media_type,markdown_artifact_path,markdown_artifact_sha256,markdown_artifact_byte_size,markdown_artifact_media_type,analysis_provenance_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(literature_id) DO UPDATE SET literature_content_sha256=excluded.literature_content_sha256,metadata_revision=excluded.metadata_revision,metadata_sha256=excluded.metadata_sha256,primary_asset_id=excluded.primary_asset_id,primary_asset_sha256=excluded.primary_asset_sha256,parser_result_sha256=excluded.parser_result_sha256,structured_artifact_path=excluded.structured_artifact_path,structured_artifact_sha256=excluded.structured_artifact_sha256,structured_artifact_byte_size=excluded.structured_artifact_byte_size,structured_artifact_media_type=excluded.structured_artifact_media_type,markdown_artifact_path=excluded.markdown_artifact_path,markdown_artifact_sha256=excluded.markdown_artifact_sha256,markdown_artifact_byte_size=excluded.markdown_artifact_byte_size,markdown_artifact_media_type=excluded.markdown_artifact_media_type,analysis_provenance_id=excluded.analysis_provenance_id").run(c.literature_id,c.literature_content_sha256,c.metadata_revision,c.metadata_sha256,c.primary_asset_id,c.primary_asset_sha256,c.parser_result_sha256,c.structured_artifact_path,c.structured_artifact_sha256,c.structured_artifact_byte_size,c.structured_artifact_media_type,c.markdown_artifact_path,c.markdown_artifact_sha256,c.markdown_artifact_byte_size,c.markdown_artifact_media_type,provenance.provenance_id);
    const ref=db.prepare("INSERT INTO literature_content_reference_texts(literature_content_sha256,reference_index,reference_text) VALUES(?,?,?)");
    const existing=db.prepare("SELECT reference_text FROM literature_content_reference_texts WHERE literature_content_sha256=? ORDER BY reference_index").all(c.literature_content_sha256).map(r=>r.reference_text);
    if(existing.length){if(JSON.stringify(existing)!==JSON.stringify(c.reference_texts))fail();}else for(let i=0;i<c.reference_texts.length;i++)ref.run(c.literature_content_sha256,i,c.reference_texts[i]);
}
function putLiteratureContent(c){return transaction(()=>{writeLiteratureContent(c);return true;});}
function acceptLiteratureContent(command){
 return transaction(()=>{
  const c=command.content;
  const old=db.prepare("SELECT metadata_revision,metadata_sha256 FROM literature_metadata WHERE literature_id=?").get(c.literature_id);
  const primary=db.prepare("SELECT a.asset_id,a.sha256 FROM literature_assets l JOIN assets a ON a.asset_id=l.asset_id WHERE l.literature_id=? AND l.role='primary-pdf'").get(c.literature_id);
  const parser=primary?currentParser(primary.asset_id):null;
  if(!old||old.metadata_revision!==command.input_metadata_revision||old.metadata_sha256!==command.input_metadata_sha256||!primary||primary.asset_id!==c.primary_asset_id||primary.sha256!==c.primary_asset_sha256||!parser||parser.source_sha256!==primary.sha256||parser.result_sha256!==c.parser_result_sha256)return false;
  if(c.metadata_revision!==old.metadata_revision+1)fail();
  writeMetadata(c.literature_id,command.final_metadata,c.metadata_sha256);
  writeLiteratureContent(c);
  const count=db.prepare("SELECT count(*) AS count FROM literature_search_fts WHERE literature_id=?").get(c.literature_id).count;if(count!==1)fail();
  db.prepare("UPDATE literature_search_fts SET content_body=? WHERE literature_id=?").run(command.content_body,c.literature_id);
  return true;
 });
}
function getLiteratureContent(id){
  const row=db.prepare("SELECT literature_id,literature_content_sha256,metadata_revision,metadata_sha256,primary_asset_id,primary_asset_sha256,parser_result_sha256,structured_artifact_path,structured_artifact_sha256,structured_artifact_byte_size,structured_artifact_media_type,markdown_artifact_path,markdown_artifact_sha256,markdown_artifact_byte_size,markdown_artifact_media_type,analysis_provenance_id FROM literature_contents WHERE literature_id=?").get(id); if(!row) return null;
  const p=db.prepare("SELECT provenance_id,source_kind,source_name,source_record_id,observed_at,input_sha256,parameters_sha256 FROM provenances WHERE provenance_id=?").get(row.analysis_provenance_id); if(!p) fail();
  const refs=db.prepare("SELECT reference_text FROM literature_content_reference_texts WHERE literature_content_sha256=? ORDER BY reference_index").all(row.literature_content_sha256).map(x=>x.reference_text);
  const structured=db.prepare("SELECT artifact_id FROM artifact_objects WHERE relative_path=? AND sha256=? AND byte_size=? AND media_type=?").get(row.structured_artifact_path,row.structured_artifact_sha256,row.structured_artifact_byte_size,row.structured_artifact_media_type); if(!structured) fail();
  const markdown=db.prepare("SELECT artifact_id FROM artifact_objects WHERE relative_path=? AND sha256=? AND byte_size=? AND media_type=?").get(row.markdown_artifact_path,row.markdown_artifact_sha256,row.markdown_artifact_byte_size,row.markdown_artifact_media_type); if(!markdown) fail();
  return {literature_id:row.literature_id,literature_content_sha256:row.literature_content_sha256,metadata_revision:row.metadata_revision,metadata_sha256:row.metadata_sha256,primary_asset_id:row.primary_asset_id,primary_asset_sha256:row.primary_asset_sha256,parser_result_sha256:row.parser_result_sha256,structured_artifact_id:structured.artifact_id,structured_artifact_path:row.structured_artifact_path,structured_artifact_sha256:row.structured_artifact_sha256,structured_artifact_byte_size:row.structured_artifact_byte_size,structured_artifact_media_type:row.structured_artifact_media_type,markdown_artifact_id:markdown.artifact_id,markdown_artifact_path:row.markdown_artifact_path,markdown_artifact_sha256:row.markdown_artifact_sha256,markdown_artifact_byte_size:row.markdown_artifact_byte_size,markdown_artifact_media_type:row.markdown_artifact_media_type,provenance:p,reference_texts:refs};
}
function putProviderRelation(o){
  try {
    db.exec("BEGIN IMMEDIATE");
    const p=o.provenance;
    db.prepare("INSERT INTO provenances(provenance_id,source_kind,source_name,source_record_id,observed_at,input_sha256,parameters_sha256) VALUES(?,?,?,?,?,?,?) ON CONFLICT(provenance_id) DO NOTHING").run(p.provenance_id,p.source_kind,p.source_name,p.source_record_id,p.observed_at,p.input_sha256,p.parameters_sha256);
    db.prepare("INSERT INTO provider_relation_observations(observation_id,provenance_id) VALUES(?,?) ON CONFLICT(observation_id) DO NOTHING").run(o.observation_id,p.provenance_id);
    for (const [kind,endpoint] of [["citing",o.citing],["cited",o.cited]]) {
      db.prepare("INSERT INTO provider_relation_endpoints(observation_id,endpoint_kind,record_id) VALUES(?,?,?) ON CONFLICT(observation_id,endpoint_kind) DO NOTHING").run(o.observation_id,kind,endpoint.record_id);
      const insert=db.prepare("INSERT INTO provider_relation_endpoint_identifiers(observation_id,endpoint_kind,ordinal,namespace,value) VALUES(?,?,?,?,?) ON CONFLICT(observation_id,endpoint_kind,namespace,value) DO NOTHING");
      for(let i=0;i<endpoint.identifiers.length;i++){const identifier=endpoint.identifiers[i]; insert.run(o.observation_id,kind,i,identifier.namespace,identifier.value);}
    }
    db.exec("COMMIT"); return true;
  } catch(e){ try{db.exec("ROLLBACK");}catch{} throw e; }
}
function getProviderRelation(id){
  const row=db.prepare("SELECT observation_id,provenance_id FROM provider_relation_observations WHERE observation_id=?").get(id); if(!row) return null;
  const p=db.prepare("SELECT provenance_id,source_kind,source_name,source_record_id,observed_at,input_sha256,parameters_sha256 FROM provenances WHERE provenance_id=?").get(row.provenance_id);
  const endpoint=(kind)=>{const value=db.prepare("SELECT record_id FROM provider_relation_endpoints WHERE observation_id=? AND endpoint_kind=?").get(id,kind); if(!value) fail(); return {record_id:value.record_id,identifiers:db.prepare("SELECT namespace,value FROM provider_relation_endpoint_identifiers WHERE observation_id=? AND endpoint_kind=? ORDER BY ordinal").all(id,kind)};};
  return {observation_id:row.observation_id,provenance:p,citing:endpoint("citing"),cited:endpoint("cited")};
}
function putProviderReferenceSupport(referenceId,observationId){
  try {
    db.exec("BEGIN IMMEDIATE");
    const edge=db.prepare("SELECT reference_id,source_literature_id,target_literature_id FROM literature_references WHERE reference_id=?").get(referenceId);
    const observation=getProviderRelation(observationId);
    if(!edge || !observation) fail();
    const matches=(id,endpoint)=> endpoint.identifiers.some(identifier=>db.prepare("SELECT 1 FROM literature_metadata_identifiers WHERE literature_id=? AND namespace=? AND value=?").get(id,identifier.namespace,identifier.value)) || (endpoint.record_id!==null && db.prepare("SELECT 1 FROM literature_metadata_observations owner JOIN metadata_observations observation ON observation.observation_id=owner.observation_id JOIN provenances p ON p.provenance_id=observation.provenance_id WHERE owner.literature_id=? AND p.source_name=? AND p.source_record_id=?").get(id,observation.provenance.source_name,endpoint.record_id));
    if(!matches(edge.source_literature_id,observation.citing) || !matches(edge.target_literature_id,observation.cited)) fail();
    db.prepare("INSERT INTO provider_relation_reference_supports(reference_id,observation_id) VALUES(?,?) ON CONFLICT DO NOTHING").run(referenceId,observationId);
    db.exec("COMMIT"); return true;
  } catch(e){ try{db.exec("ROLLBACK");}catch{} throw e; }
}
function putMetadataReferenceSupport(referenceId,observationId,index){
  try { db.exec("BEGIN IMMEDIATE"); const valid=db.prepare("SELECT 1 FROM literature_references r JOIN literature_metadata_observations owner ON owner.literature_id=r.source_literature_id JOIN metadata_observation_reference_texts text ON text.observation_id=owner.observation_id AND text.reference_index=? WHERE r.reference_id=? AND owner.observation_id=?").get(index,referenceId,observationId); if(!valid) fail(); db.prepare("INSERT INTO metadata_reference_text_supports(reference_id,metadata_observation_id,reference_index) VALUES(?,?,?) ON CONFLICT DO NOTHING").run(referenceId,observationId,index); db.exec("COMMIT"); return true; } catch(e){ try{db.exec("ROLLBACK");}catch{} throw e; }
}
function putContentReferenceSupport(referenceId,contentSha,index){
  try { db.exec("BEGIN IMMEDIATE"); const valid=db.prepare("SELECT 1 FROM literature_references r JOIN literature_contents content ON content.literature_id=r.source_literature_id JOIN literature_content_reference_texts text ON text.literature_content_sha256=content.literature_content_sha256 AND text.reference_index=? WHERE r.reference_id=? AND content.literature_content_sha256=?").get(index,referenceId,contentSha); if(!valid) fail(); db.prepare("INSERT INTO content_reference_text_supports(reference_id,literature_content_sha256,reference_index) VALUES(?,?,?) ON CONFLICT DO NOTHING").run(referenceId,contentSha,index); db.exec("COMMIT"); return true; } catch(e){ try{db.exec("ROLLBACK");}catch{} throw e; }
}
function referenceSnapshot(){
  db.exec("BEGIN");
  try {
  const rows=db.prepare("SELECT reference_id,source_literature_id,target_literature_id FROM literature_references WHERE EXISTS(SELECT 1 FROM provider_relation_reference_supports s WHERE s.reference_id=literature_references.reference_id) OR EXISTS(SELECT 1 FROM metadata_reference_text_supports s WHERE s.reference_id=literature_references.reference_id) OR EXISTS(SELECT 1 FROM content_reference_text_supports s WHERE s.reference_id=literature_references.reference_id) ORDER BY source_literature_id,target_literature_id,reference_id").all();
  const result=rows.map(row=>{const supports=[]; for(const s of db.prepare("SELECT observation_id FROM provider_relation_reference_supports WHERE reference_id=? ORDER BY observation_id").all(row.reference_id)) supports.push({kind:"provider_relation",observation_id:s.observation_id}); for(const s of db.prepare("SELECT metadata_observation_id,reference_index FROM metadata_reference_text_supports WHERE reference_id=? ORDER BY metadata_observation_id,reference_index").all(row.reference_id)) supports.push({kind:"metadata_reference_text",metadata_observation_id:s.metadata_observation_id,reference_index:s.reference_index}); for(const s of db.prepare("SELECT literature_content_sha256,reference_index FROM content_reference_text_supports WHERE reference_id=? ORDER BY literature_content_sha256,reference_index").all(row.reference_id)) supports.push({kind:"content_reference_text",literature_content_sha256:s.literature_content_sha256,reference_index:s.reference_index}); return {reference:{reference_id:row.reference_id,source_literature_id:row.source_literature_id,target_literature_id:row.target_literature_id},supports};});
  db.exec("COMMIT"); return result;
  } catch(e){ db.exec("ROLLBACK"); throw e; }
}
function referenceQueryRows(selection){
    if("literature_id" in selection && !getLiterature(selection.literature_id))return null;
    const where="reference_id" in selection?"reference_id=?":selection.direction==="references"?"source_literature_id=?":"target_literature_id=?";
    const rows=db.prepare("SELECT reference_id,source_literature_id,target_literature_id FROM literature_references WHERE "+where).all(selection.reference_id ?? selection.literature_id);
    const result=[];
    for(const reference of rows){
      const source=searchItem(reference.source_literature_id),target=searchItem(reference.target_literature_id);
      if(!source || !target || reference.source_literature_id===reference.target_literature_id) fail();
      const supports=[];
      for(const s of db.prepare("SELECT observation_id FROM provider_relation_reference_supports WHERE reference_id=? ORDER BY observation_id").all(reference.reference_id)){
        const o=getProviderRelation(s.observation_id); if(!o) fail();
        const matches=(id,endpoint)=>endpoint.identifiers.some(identifier=>db.prepare("SELECT 1 FROM literature_metadata_identifiers WHERE literature_id=? AND namespace=? AND value=?").get(id,identifier.namespace,identifier.value)) || (endpoint.record_id!==null && db.prepare("SELECT 1 FROM literature_metadata_observations owner JOIN metadata_observations observation ON observation.observation_id=owner.observation_id JOIN provenances p ON p.provenance_id=observation.provenance_id WHERE owner.literature_id=? AND p.source_name=? AND p.source_record_id=?").get(id,o.provenance.source_name,endpoint.record_id));
        if(!matches(reference.source_literature_id,o.citing) || !matches(reference.target_literature_id,o.cited)) fail();
        supports.push({reference_id:reference.reference_id,source:{kind:"provider_relation",observation_id:s.observation_id}});
      }
      for(const s of db.prepare("SELECT metadata_observation_id,reference_index FROM metadata_reference_text_supports WHERE reference_id=? ORDER BY metadata_observation_id,reference_index").all(reference.reference_id)){
        if(!db.prepare("SELECT 1 FROM literature_metadata_observations owner JOIN metadata_observation_reference_texts text ON text.observation_id=owner.observation_id WHERE owner.literature_id=? AND owner.observation_id=? AND text.reference_index=?").get(reference.source_literature_id,s.metadata_observation_id,s.reference_index)) fail();
        supports.push({reference_id:reference.reference_id,source:{kind:"metadata_reference_text",...s}});
      }
      for(const s of db.prepare("SELECT literature_content_sha256,reference_index FROM content_reference_text_supports WHERE reference_id=? ORDER BY literature_content_sha256,reference_index").all(reference.reference_id)){
        if(!db.prepare("SELECT 1 FROM literature_contents c JOIN literature_content_reference_texts text ON text.literature_content_sha256=c.literature_content_sha256 WHERE c.literature_id=? AND c.literature_content_sha256=? AND text.reference_index=?").get(reference.source_literature_id,s.literature_content_sha256,s.reference_index)) fail();
        supports.push({reference_id:reference.reference_id,source:{kind:"content_reference_text",...s}});
      }
      if(supports.length)result.push({reference,source,target,supports});
    }
    return result;
}
function referenceQuerySnapshot(selection){
  db.exec("BEGIN");
  try{const result=referenceQueryRows(selection);db.exec("COMMIT");return result;}
  catch(error){db.exec("ROLLBACK");throw error;}
}
function literatureDetailSnapshot(id,nested=false){
  if(!nested)db.exec("BEGIN");
  try{
    const literature=getLiterature(id);if(!literature){if(!nested)db.exec("COMMIT");return null;}
    const meta_literature=db.prepare("SELECT meta_literature_id,representative_literature_id FROM meta_literatures WHERE meta_literature_id=?").get(literature.meta_literature_id);
    if(!meta_literature || !db.prepare("SELECT 1 FROM literatures WHERE literature_id=? AND meta_literature_id=?").get(meta_literature.representative_literature_id,meta_literature.meta_literature_id))fail();
    const metadata_observations=db.prepare("SELECT observation_id FROM literature_metadata_observations WHERE literature_id=?").all(id).map(({observation_id})=>{
      const {literature_id,...o}=getObservation(observation_id);if(literature_id!==id)fail();
      o.metadata.authors=o.metadata.authors.map(({ordinal,...a})=>a);
      o.asset_hints=db.prepare("SELECT url,kind,media_type,asset_role,version_role,access_status,license FROM metadata_observation_asset_hints WHERE observation_id=? ORDER BY hint_ordinal").all(observation_id);
      o.version_links=db.prepare("SELECT link_ordinal,record_id FROM metadata_observation_version_links WHERE observation_id=? ORDER BY link_ordinal").all(observation_id).map(link=>({record_id:link.record_id,identifiers:db.prepare("SELECT namespace,value FROM metadata_observation_version_link_identifiers WHERE observation_id=? AND link_ordinal=? ORDER BY ordinal").all(observation_id,link.link_ordinal)}));return o;
    });
    const provenance=id=>db.prepare("SELECT provenance_id,source_kind,source_name,source_record_id,observed_at,input_sha256,parameters_sha256 FROM provenances WHERE provenance_id=?").get(id);
    const assets=db.prepare("SELECT literature_asset_id,literature_id,asset_id,role,provenance_id,source_url FROM literature_assets WHERE literature_id=? ORDER BY role,literature_asset_id").all(id).map(({provenance_id,...relation})=>({asset:getAsset(relation.asset_id),literature_asset:{...relation,provenance:provenance(provenance_id)}}));
    const primary=assets.filter(a=>a.literature_asset.role==="primary-pdf");if(primary.length>1)fail();
    const primary_pdf=primary[0]||null;
    let parser_result=null;
    if(primary_pdf){
      const p=db.prepare("SELECT * FROM parser_results WHERE source_asset_id=? AND source_sha256=?").get(primary_pdf.asset.asset_id,primary_pdf.asset.sha256);
      if(p)parser_result={source_asset_id:p.source_asset_id,source_sha256:p.source_sha256,page_count:p.page_count,result_sha256:p.result_sha256,markdown:{sha256:p.markdown_sha256,media_type:p.markdown_media_type,byte_size:p.markdown_byte_size},resources:db.prepare("SELECT reference,artifact_sha256,artifact_media_type,artifact_byte_size FROM parser_result_resources WHERE source_asset_id=? ORDER BY reference").all(p.source_asset_id).map(r=>({reference:r.reference,artifact:{sha256:r.artifact_sha256,media_type:r.artifact_media_type,byte_size:r.artifact_byte_size}})),provenance:{provenance:provenance(p.provenance_id),parser_version:p.parser_version,mode:p.mode,model_identity:p.model_identity}};
    }
    const other_versions=db.prepare("SELECT literature_id FROM literatures WHERE meta_literature_id=? AND literature_id<>? ORDER BY CASE version_role WHEN 'published' THEN 0 WHEN 'accepted-manuscript' THEN 1 WHEN 'preprint' THEN 2 ELSE 3 END,literature_id").all(literature.meta_literature_id,id).map(row=>searchItem(row.literature_id));
    const content=getLiteratureContent(id);
    const detail={...searchItem(id),meta_literature,metadata_observations,primary_pdf,additional_assets:assets.filter(a=>a.literature_asset.role!=="primary-pdf"),parser_result,content:null,other_versions,reference_count:referenceQueryRows({literature_id:id,direction:"references"}).length,cited_by_count:referenceQueryRows({literature_id:id,direction:"cited-by"}).length};
    if(!nested)db.exec("COMMIT");return {detail,content};
  }catch(error){if(!nested)db.exec("ROLLBACK");throw error;}
}
function cleanupClosure(id){
 const snapshot=literatureDetailSnapshot(id,true);if(!snapshot)return null;
 const p=snapshot.detail.primary_pdf;if(!p || !snapshot.detail.parser_result)return null;
 const references=referenceQueryRows({literature_id:id,direction:"references"});
 const reference_count=db.prepare("SELECT count(*) AS n FROM literature_references WHERE source_literature_id=?").get(id).n;
 const fts=db.prepare("SELECT literature_id,title,abstract,authors,affiliations,identifiers,keywords,venue,publisher,volume,issue,pages,content_body FROM literature_search_fts WHERE literature_id=?").all(id);
 const parser=db.prepare("SELECT * FROM parser_results WHERE source_asset_id=?").get(p.asset.asset_id);
 const resources=db.prepare("SELECT * FROM parser_result_resources WHERE source_asset_id=? ORDER BY ordinal").all(p.asset.asset_id);
 const c=snapshot.content;
 const paths=[...new Set([p.asset.path,parser.markdown_artifact_path,...resources.map(r=>r.artifact_path),...(c?[c.structured_artifact_path,c.markdown_artifact_path]:[])])].sort();
 const artifacts=paths.map(path=>{const row=db.prepare("SELECT * FROM artifact_objects WHERE relative_path=?").get(path);if(!row)fail();return row;});
 const exhausted=db.prepare("SELECT * FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?").get(id)||null;
 const execution=candidateCleanupSnapshot();
 const closure={snapshot,references,reference_count,fts,parser,resources,artifacts,exhausted,execution};
 return {...closure,token:createHash("sha256").update(JSON.stringify(closure)).digest("hex")};
}
function contentCleanupSnapshot(id){return transaction(()=>{const c=cleanupClosure(id);return c?{token:c.token,snapshot:c.snapshot,references:c.references,reference_count:c.reference_count,fts:c.fts,artifacts:c.artifacts.map(a=>({reference:a.relative_path,artifact:{sha256:a.sha256,byte_size:a.byte_size,media_type:a.media_type}}))}:null;});}
function cleanupNoUsableContent(command){return transaction(()=>{
 const id=command.input.literature_id,c=cleanupClosure(id);
 if(!c || c.token!==command.token || c.exhausted)return null;
 const d=c.snapshot.detail,p=d.primary_pdf,parser=d.parser_result,old=c.snapshot.content;
 const input={literature_id:id,primary_asset_id:p.asset.asset_id,primary_pdf_sha256:p.asset.sha256,parser_result_sha256:parser.result_sha256,input_metadata_revision:d.metadata_revision,input_metadata_sha256:d.metadata_sha256};
 const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==="object"?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,stable(v)])):v;
 const same=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
 if(!same(input,command.input))return null;
 if(c.reference_count!==c.references.length)fail();
 // The Parser row is Asset-scoped; another current content binding must never be invalidated by this cleanup.
 if(db.prepare("SELECT 1 FROM literature_contents WHERE primary_asset_id=? AND literature_id<>? LIMIT 1").get(p.asset.asset_id,id))return null;
 const removed=c.references.flatMap(r=>r.supports.filter(s=>s.source.kind==="content_reference_text" && s.source.literature_content_sha256===old?.literature_content_sha256));
 const deleted=c.references.filter(r=>r.supports.length>0&&r.supports.every(s=>removed.includes(s))).map(r=>r.reference.reference_id).sort();
 if(!same(removed,command.removed_supports)||!same(deleted,command.deleted_reference_ids))fail();
 const execution=c.execution;
 const candidateMap=new Map(execution.candidates.map(r=>[r.transfer_id,JSON.parse(r.record_json)]));
 const removedReceipts=[],affectedTransfers=new Set(),retainedTransfers=new Set();
 for(const row of execution.receipts){
  const intent=JSON.parse(row.intent_json);
  if(intent.literature_id===id && intent.candidate.sha256===input.primary_pdf_sha256){removedReceipts.push(row.receipt_id);affectedTransfers.add(row.transfer_id);}
  else retainedTransfers.add(row.transfer_id);
 }
 const removedTransfers=[...candidateMap].filter(([tid,candidate])=>candidate.sha256===input.primary_pdf_sha256&&!retainedTransfers.has(tid)&&(candidate.capture?.article_id===id||(candidate.capture===null&&affectedTransfers.has(tid)))).map(([tid])=>tid).sort();
 const expectedCleanup={receipt_ids:removedReceipts.sort(),transfer_ids:removedTransfers};
 if(command.candidate_cleanup){if(!same(expectedCleanup,command.candidate_cleanup))fail();}
 else if(removedTransfers.length || removedReceipts.length)fail();
 for(const receipt of removedReceipts)requireCount(db.prepare("DELETE FROM execution_receipts WHERE receipt_id=?").run(receipt),1);
 for(const tid of removedTransfers)requireCount(db.prepare("DELETE FROM execution_candidates WHERE transfer_id=?").run(tid),1);
 for(const support of removed)requireCount(db.prepare("DELETE FROM content_reference_text_supports WHERE reference_id=? AND literature_content_sha256=? AND reference_index=?").run(support.reference_id,support.source.literature_content_sha256,support.source.reference_index),1);
 for(const ref of deleted)requireCount(db.prepare("DELETE FROM literature_references WHERE reference_id=? AND source_literature_id=? AND NOT EXISTS(SELECT 1 FROM provider_relation_reference_supports WHERE reference_id=?) AND NOT EXISTS(SELECT 1 FROM metadata_reference_text_supports WHERE reference_id=?) AND NOT EXISTS(SELECT 1 FROM content_reference_text_supports WHERE reference_id=?)").run(ref,id,ref,ref,ref),1);
 if(old){
  requireCount(db.prepare("DELETE FROM literature_contents WHERE literature_id=? AND literature_content_sha256=?").run(id,old.literature_content_sha256),1);
  if(!db.prepare("SELECT 1 FROM literature_contents WHERE literature_content_sha256=?").get(old.literature_content_sha256))requireCount(db.prepare("DELETE FROM literature_content_reference_texts WHERE literature_content_sha256=?").run(old.literature_content_sha256),old.reference_texts.length);
 }
 requireCount(db.prepare("DELETE FROM parser_result_resources WHERE source_asset_id=?").run(p.asset.asset_id),c.resources.length);
 requireCount(db.prepare("DELETE FROM parser_results WHERE source_asset_id=? AND result_sha256=?").run(p.asset.asset_id,parser.result_sha256),1);
 requireCount(db.prepare("DELETE FROM literature_assets WHERE literature_asset_id=? AND literature_id=? AND asset_id=? AND role='primary-pdf'").run(p.literature_asset.literature_asset_id,id,p.asset.asset_id),1);
 requireCount(db.prepare("UPDATE literature_search_fts SET content_body='' WHERE literature_id=?").run(id),1);
 db.prepare("DELETE FROM assets WHERE asset_id=? AND NOT EXISTS(SELECT 1 FROM literature_assets WHERE asset_id=?)").run(p.asset.asset_id,p.asset.asset_id);
 const retired=[];
 for(const a of c.artifacts){
  const path=a.relative_path;
  const used=db.prepare("SELECT EXISTS(SELECT 1 FROM assets WHERE relative_path=?) OR EXISTS(SELECT 1 FROM parser_results WHERE markdown_artifact_path=?) OR EXISTS(SELECT 1 FROM parser_result_resources WHERE artifact_path=?) OR EXISTS(SELECT 1 FROM literature_contents WHERE structured_artifact_path=? OR markdown_artifact_path=?) AS used").get(path,path,path,path,path).used;
  if(!used){requireCount(db.prepare("DELETE FROM artifact_objects WHERE relative_path=?").run(path),1);retired.push({reference:path,artifact:{sha256:a.sha256,byte_size:a.byte_size,media_type:a.media_type}});}
 }
 for(const tid of removedTransfers){const candidate=candidateMap.get(tid);if(!retired.some(r=>r.reference===candidate.reference))retired.push({reference:candidate.reference,artifact:{sha256:candidate.sha256,byte_size:candidate.size_bytes,media_type:"application/pdf"}});}
 const provenanceIds=[...new Set([p.literature_asset.provenance.provenance_id,parser.provenance.provenance.provenance_id,...(old?[old.provenance.provenance_id]:[])])];
 for(const pid of provenanceIds){
  const used=db.prepare("SELECT EXISTS(SELECT 1 FROM metadata_observations WHERE provenance_id=?) OR EXISTS(SELECT 1 FROM provider_relation_observations WHERE provenance_id=?) OR EXISTS(SELECT 1 FROM literature_assets WHERE provenance_id=?) OR EXISTS(SELECT 1 FROM parser_results WHERE provenance_id=?) OR EXISTS(SELECT 1 FROM literature_contents WHERE analysis_provenance_id=?) AS used").get(pid,pid,pid,pid,pid).used;
  if(!used)requireCount(db.prepare("DELETE FROM provenances WHERE provenance_id=?").run(pid),1);
 }
 return retired;
});}
function candidateCleanupSnapshot(){
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE name IN ('execution_schema_identity','execution_candidates','execution_receipts')").all();
 if(tables.length!==0 && tables.length!==3)fail();
 const execution=tables.length===3;if(execution)requireExecution();
 const candidates=execution?db.prepare("SELECT transfer_id,record_json FROM execution_candidates ORDER BY transfer_id").all():[];
 const receipts=execution?db.prepare("SELECT receipt_id,transfer_id,intent_json,result_json FROM execution_receipts ORDER BY receipt_id").all():[];
 return {candidates,receipts};
}
function artifactReclamationSnapshot(reference){return transaction(()=>{
 const registered=!!db.prepare("SELECT EXISTS(SELECT 1 FROM artifact_objects WHERE relative_path=?) OR EXISTS(SELECT 1 FROM assets WHERE relative_path=?) OR EXISTS(SELECT 1 FROM parser_results WHERE markdown_artifact_path=?) OR EXISTS(SELECT 1 FROM parser_result_resources WHERE artifact_path=?) OR EXISTS(SELECT 1 FROM literature_contents WHERE structured_artifact_path=? OR markdown_artifact_path=?) AS used").get(reference,reference,reference,reference,reference,reference).used;
 return {registered,...candidateCleanupSnapshot()};
});}
function putAsset(a){
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?) ON CONFLICT(artifact_id) DO NOTHING").run(a.asset_id,a.sha256,a.size_bytes,a.media_type,a.path);
    db.prepare("INSERT INTO assets(asset_id,sha256,size_bytes,media_type,relative_path) VALUES(?,?,?,?,?) ON CONFLICT(asset_id) DO NOTHING").run(a.asset_id,a.sha256,a.size_bytes,a.media_type,a.path);
    const stored=db.prepare("SELECT sha256,size_bytes,media_type,relative_path FROM assets WHERE asset_id=?").get(a.asset_id); if(!stored || stored.sha256!==a.sha256 || stored.size_bytes!==a.size_bytes || stored.media_type!==a.media_type || stored.relative_path!==a.path) fail();
    db.exec("COMMIT"); return true;
  } catch(e){ try{db.exec("ROLLBACK");}catch{} throw e; }
}
function putReference(r){ if(r.source_literature_id===r.target_literature_id) fail(); db.prepare("INSERT INTO literature_references(reference_id,source_literature_id,target_literature_id) VALUES(?,?,?) ON CONFLICT(reference_id) DO NOTHING").run(r.reference_id,r.source_literature_id,r.target_literature_id); return true; }
function getAsset(id){ return db.prepare("SELECT asset_id,sha256,size_bytes,media_type,relative_path AS path FROM assets WHERE asset_id=?").get(id) || null; }
function locateArtifact(value){
  if("asset_id" in value){const asset=getAsset(value.asset_id);if(!asset || ["asset_id","sha256","size_bytes","media_type","path"].some(key=>asset[key]!==value[key]))return null;}
  const row=db.prepare("SELECT relative_path AS reference,sha256,byte_size,media_type FROM artifact_objects WHERE sha256=? AND byte_size=? AND media_type=?").get(value.sha256,value.byte_size ?? value.size_bytes,value.media_type);
  if(!row || ("path" in value && row.reference!==value.path))return null;
  return {reference:row.reference,artifact:{sha256:row.sha256,byte_size:row.byte_size,media_type:row.media_type}};
}
function getDiscovery(id){
 const run=db.prepare("SELECT discovery_run_id,kind,status,started_at FROM discovery_runs WHERE discovery_run_id=?").get(id);if(!run)return null;
 const input=run.kind==="topic"?db.prepare("SELECT query,year_from,year_to FROM topic_discovery_inputs WHERE discovery_run_id=?").get(id):db.prepare("SELECT direction,max_depth,result_limit FROM citation_discovery_inputs WHERE discovery_run_id=?").get(id);if(!input)fail();
 const seeds=run.kind==="citation"?db.prepare("SELECT literature_id FROM citation_discovery_seeds WHERE discovery_run_id=? ORDER BY seed_ordinal").all(id).map(x=>x.literature_id):[];
 const providers=db.prepare("SELECT provider_name,scan_limit FROM discovery_run_providers WHERE discovery_run_id=? ORDER BY provider_ordinal").all(id);
 const source_results=db.prepare("SELECT provider_name,outcome,failure_code,failure_reason,failure_action,failure_retryable FROM discovery_source_results WHERE discovery_run_id=? ORDER BY provider_name").all(id).map(x=>({provider_name:x.provider_name,outcome:x.outcome,failure:x.failure_code===null?null:{code:x.failure_code,reason:x.failure_reason,action:x.failure_action,retryable:!!x.failure_retryable}}));
 const results=db.prepare("SELECT meta_literature_id FROM discovery_results WHERE discovery_run_id=? ORDER BY meta_literature_id").all(id);
 const topic_causes=db.prepare("SELECT meta_literature_id,metadata_observation_id,actual_literature_id FROM topic_discovery_causes WHERE discovery_run_id=? ORDER BY meta_literature_id,metadata_observation_id").all(id);
 const citation_causes=db.prepare("SELECT meta_literature_id,source_literature_id,target_literature_id,actual_literature_id,depth FROM citation_discovery_causes WHERE discovery_run_id=? ORDER BY depth,source_literature_id,target_literature_id").all(id);
 return {run:{...run,...input,...(run.kind==="citation"?{seed_literature_ids:seeds}:{})},providers,source_results,results,topic_causes,citation_causes};
}
function putDiscovery(p){return transaction(()=>{
 if(!p||!p.run||!Array.isArray(p.providers)||!Array.isArray(p.source_results)||!Array.isArray(p.results)||!Array.isArray(p.topic_causes)||!Array.isArray(p.citation_causes))fail();
 const r=p.run;
 db.prepare("INSERT INTO discovery_runs(discovery_run_id,kind,status,started_at) VALUES(?,?,?,?) ON CONFLICT(discovery_run_id) DO NOTHING").run(r.discovery_run_id,r.kind,r.status,r.started_at);
 const saved=db.prepare("SELECT kind,status,started_at FROM discovery_runs WHERE discovery_run_id=?").get(r.discovery_run_id);if(!saved||saved.kind!==r.kind||saved.status!==r.status||saved.started_at!==r.started_at)fail();
 if(r.kind==="topic"){
  db.prepare("INSERT INTO topic_discovery_inputs(discovery_run_id,kind,query,year_from,year_to) VALUES(?,'topic',?,?,?) ON CONFLICT(discovery_run_id) DO NOTHING").run(r.discovery_run_id,r.query,r.year_from??null,r.year_to??null);
 }else if(r.kind==="citation"){
  db.prepare("INSERT INTO citation_discovery_inputs(discovery_run_id,kind,direction,max_depth,result_limit) VALUES(?,'citation',?,?,?) ON CONFLICT(discovery_run_id) DO NOTHING").run(r.discovery_run_id,r.direction,r.max_depth,r.result_limit);
  for(let i=0;i<(r.seed_literature_ids||[]).length;i++)db.prepare("INSERT INTO citation_discovery_seeds(discovery_run_id,seed_ordinal,literature_id) VALUES(?,?,?) ON CONFLICT(discovery_run_id,seed_ordinal) DO NOTHING").run(r.discovery_run_id,i,r.seed_literature_ids[i]);
 }else fail();
 for(let i=0;i<p.providers.length;i++){const x=p.providers[i];db.prepare("INSERT INTO discovery_run_providers(discovery_run_id,provider_ordinal,provider_name,scan_limit) VALUES(?,?,?,?) ON CONFLICT(discovery_run_id,provider_ordinal) DO NOTHING").run(r.discovery_run_id,i,x.provider_name,x.scan_limit);}
 for(const x of p.source_results){const f=x.failure;db.prepare("INSERT INTO discovery_source_results(discovery_run_id,provider_name,outcome,failure_code,failure_reason,failure_action,failure_retryable) VALUES(?,?,?,?,?,?,?) ON CONFLICT(discovery_run_id,provider_name) DO NOTHING").run(r.discovery_run_id,x.provider_name,x.outcome,f?.code??null,f?.reason??null,f?.action??null,f?.retryable===undefined?null:Number(f.retryable));}
 for(const x of p.results)db.prepare("INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES(?,?) ON CONFLICT(discovery_run_id,meta_literature_id) DO NOTHING").run(r.discovery_run_id,x.meta_literature_id);
 for(const x of p.topic_causes)db.prepare("INSERT INTO topic_discovery_causes(discovery_run_id,meta_literature_id,metadata_observation_id,actual_literature_id) VALUES(?,?,?,?) ON CONFLICT(discovery_run_id,meta_literature_id,metadata_observation_id) DO NOTHING").run(r.discovery_run_id,x.meta_literature_id,x.metadata_observation_id,x.actual_literature_id);
 for(const x of p.citation_causes)db.prepare("INSERT INTO citation_discovery_causes(discovery_run_id,meta_literature_id,source_literature_id,target_literature_id,actual_literature_id,depth) VALUES(?,?,?,?,?,?) ON CONFLICT(discovery_run_id,meta_literature_id,source_literature_id,target_literature_id,depth) DO NOTHING").run(r.discovery_run_id,x.meta_literature_id,x.source_literature_id,x.target_literature_id,x.actual_literature_id,x.depth);
 validateDiscoveryCauses([r.discovery_run_id]);
 return getDiscovery(r.discovery_run_id);
});}
function counts(){ const names=["schema_identity","artifact_objects","provenances","meta_literatures","literatures","literature_metadata","literature_metadata_authors","literature_metadata_author_affiliations","literature_metadata_identifiers","literature_metadata_keywords","metadata_observations","provider_relation_observations","literature_references","assets","literature_assets","parser_results","parser_result_resources","literature_contents","discovery_runs"]; const result={}; for(const name of names) result[name]=Number(db.prepare("SELECT count(*) AS count FROM "+name).get().count); return {tables:result}; }
parentPort.on("message", message=>{ try{ if(message.command.kind==="close"){ db?.close(); parentPort.postMessage({id:message.id,ok:true,value:true}); return; } if(!db) initialize(); let value; switch(message.command.kind){case "execution_upgrade": value=upgradeExecution(); break;
case "execution_runtime_inspect": value=runtimeInspect(); break;
case "execution_runtime_migrate": value=migrateRuntime(message.command.dryRun); break;
case "execution_backup": value=backupExecution(message.command.path); break;
case "execution_restore_check": value=restoreCheck(message.command.path); break;
case "execution_rollback": value=rollbackExecution(message.command.backupPath); break;
case "execution_create_job": value=createExecutionJob(message.command.job,message.command.policy_sha256,message.command.policy_json); break;
case "execution_get_job": value=getExecutionJob(message.command.jobId); break;
case "execution_list_jobs": value=listExecutionJobs(message.command.limit); break;
case "execution_list_targets": value=listExecutionTargets(message.command.jobId,message.command.limit); break;
case "execution_list_attempts": value=listExecutionAttempts(message.command.targetId,message.command.limit); break;
case "execution_recover": value=recoverExecution(message.command.bootId,message.command.now); break;
case "execution_get_policy": value=getExecutionPolicy(message.command.jobId); break;
case "execution_get_budget": value=getExecutionBudget(message.command.jobId); break;
case "execution_consume_budget": value=consumeExecutionBudget(message.command.jobId,message.command.usage,message.command.now); break;
case "execution_update_job": value=updateExecutionJob(message.command.jobId,message.command.status,message.command.finishedAt); break;
case "execution_put_target": value=putExecutionTarget(message.command.target); break;
case "execution_get_target": value=getExecutionTarget(message.command.targetId); break;
case "execution_claim_target": value=claimExecutionTarget(message.command.jobId,message.command.now); break;
case "execution_update_target": value=updateExecutionTarget(message.command.targetId,message.command.stage,message.command.disposition,message.command.nextEligibleAt); break;
case "execution_start_attempt": value=startExecutionAttempt(message.command.attempt); break;
case "execution_finish_attempt": value=finishExecutionAttempt(message.command.attemptId,message.command.status,message.command.finishedAt,message.command.failure,message.command.usage); break;
case "execution_append_event": value=appendExecutionEvent(message.command.event); break;
case "execution_list_events": value=listExecutionEvents(message.command.jobId,message.command.after,message.command.limit); break;
case "execution_put_intervention": value=putExecutionIntervention(message.command.intervention); break;
case "execution_list_interventions": value=listExecutionInterventions(message.command.jobId,message.command.limit); break;
case "execution_resolve_intervention": value=resolveExecutionIntervention(message.command.interventionId,message.command.status,message.command.resolvedAt,message.command.resolution); break;
case "execution_acquire_lease": value=acquireExecutionLease(message.command.lease); break;
case "execution_release_lease": value=releaseExecutionLease(message.command.leaseId,message.command.releasedAt); break;
case "put_candidate": value=putCandidate(message.command.candidate); break;
case "retire_candidate": value=retireCandidate(message.command.candidate); break;
case "get_candidate": value=getCandidate(message.command.transferId); break;
case "prepare_receipt": value=prepareReceipt(message.command.intent); break;
case "get_receipt_intent": value=getReceiptIntent(message.command.receiptId); break;
case "get_receipt_result": value=getReceiptResult(message.command.receiptId); break;
case "library_snapshot": value=librarySnapshot(message.command.ftsQuery,message.command.discoveryRunIds); break;
case "candidate_cleanup_snapshot": value=transaction(candidateCleanupSnapshot); break;
case "artifact_reclamation_snapshot": value=artifactReclamationSnapshot(message.command.reference); break;
case "content_cleanup_snapshot": value=contentCleanupSnapshot(message.command.literatureId); break;
case "cleanup_no_usable_content": value=cleanupNoUsableContent(message.command.command); break;
case "literature_detail_snapshot": value=literatureDetailSnapshot(message.command.literatureId); break;
case "locate_artifact": value=locateArtifact(message.command.value); break;
case "reference_query_snapshot": value=referenceQuerySnapshot(message.command.selection); break;
case "put_discovery": value=putDiscovery(message.command.publication); break;
case "get_discovery": value=getDiscovery(message.command.discoveryRunId); break;
case "list_candidates": value=listCandidates(message.command.articleId); break;
case "current_facts": value=currentFacts(message.command.literatureId); break;
case "asset_by_hash": value=assetByHash(message.command.sha256); break;
case "commit_receipt": value=commitReceipt(message.command.intent,message.command.created); break;
case "pending_receipts": value=pendingReceipts(); break;
case "find_literature_by_identifiers": value=findLiteratureByIdentifiers(message.command.identifiers); break;
case "schema": value=db.prepare("SELECT product,schema_version,schema_fingerprint FROM schema_identity WHERE singleton=1").get(); break; case "put_literature": value=putLiterature(message.command.literature,message.command.metadataSha256,message.command.fallbackIdentitySha256); break; case "get_literature": value=getLiterature(message.command.literatureId); break; case "list_literature": value=listLiterature(message.command.afterLiteratureId,message.command.limit); break; case "put_asset": value=putAsset(message.command.asset); break; case "get_asset": value=getAsset(message.command.assetId); break; case "put_literature_asset": value=putLiteratureAsset(message.command.publication); break; case "commit_current_parser": value=putParserResult(message.command.result,message.command.literatureId); break; case "put_parser_result": value=putParserResult(message.command.result); break; case "accept_literature_content": value=acceptLiteratureContent(message.command.command); break; case "put_literature_content": value=putLiteratureContent(message.command.content); break; case "get_literature_content": value=getLiteratureContent(message.command.literatureId); break; case "put_reference": value=putReference(message.command.reference); break; case "put_provider_relation": value=putProviderRelation(message.command.observation); break; case "get_provider_relation": value=getProviderRelation(message.command.observationId); break; case "put_provider_reference_support": value=putProviderReferenceSupport(message.command.referenceId,message.command.observationId); break; case "put_metadata_reference_support": value=putMetadataReferenceSupport(message.command.referenceId,message.command.observationId,message.command.referenceIndex); break; case "put_content_reference_support": value=putContentReferenceSupport(message.command.referenceId,message.command.contentSha256,message.command.referenceIndex); break; case "reference_snapshot": value=referenceSnapshot(); break; case "put_observation": value=putObservation(message.command.observation); break; case "get_observation": value=getObservation(message.command.observationId); break; case "identity_read": value=identityRead(message.command.request); break; case "publish_identity_observation": value=publishIdentityObservation(message.command.publication); break; case "accept_observation": value=acceptObservation(message.command); break; case "snapshot_counts": value=counts(); break; default: fail();} parentPort.postMessage({id:message.id,ok:true,value}); }catch(e){ parentPort.postMessage({id:message.id,ok:false,value:null});}});
`;

export class SqliteWorker {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: SqliteWorkerError) => void;
    }
  >();
  private closed = false;
  private failed = false;

  private initialized = false;

  constructor(
    path = ":memory:",
    private readonly admission?: CatalogWriteAdmission,
  ) {
    if (
      typeof path !== "string" ||
      (!path.startsWith("/") && path !== ":memory:")
    )
      throw new SqliteWorkerError();
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      execArgv: process.execArgv.filter(
        (argument) => !argument.startsWith("--input-type"),
      ),
      workerData: { path },
    });
    this.worker.on("message", (reply: Reply) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.value);
      else pending.reject(new SqliteWorkerError());
    });
    this.worker.on("error", () => {
      this.failed = true;
      this.rejectAll();
    });
    this.worker.on("exit", () => {
      this.failed = true;
      this.rejectAll();
    });
  }

  run<T>(command: SqliteCommand): Promise<T> {
    const copy = structuredClone(command);
    const readOnly = new Set<string>([
      "schema",
      "execution_runtime_inspect",
      "execution_restore_check",
      "execution_get_job",
      "execution_list_jobs",
      "execution_list_targets",
      "execution_list_attempts",
      "execution_get_target",
      "execution_list_events",
      "get_literature",
      "list_literature",
      "find_literature_by_identifiers",
      "get_asset",
      "get_literature_content",
      "get_observation",
      "get_provider_relation",
      "reference_snapshot",
      "snapshot_counts",
      "get_candidate",
      "get_receipt_intent",
      "get_receipt_result",
      "list_candidates",
      "current_facts",
      "literature_detail_snapshot",
      "asset_by_hash",
      "locate_artifact",
      "pending_receipts",
      "reference_query_snapshot",
      "library_snapshot",
      "content_cleanup_snapshot",
      "artifact_reclamation_snapshot",
      "candidate_cleanup_snapshot",
    ]);
    if (this.admission && (!this.initialized || !readOnly.has(copy.kind)))
      return this.admission.run(() => this.send<T>(copy));
    return this.send<T>(copy);
  }
  private send<T>(command: SqliteCommand): Promise<T> {
    if (this.closed || this.failed)
      return Promise.reject(new SqliteWorkerError());
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (value) => {
          this.initialized = true;
          resolve(value as T);
        },
        reject,
      });
      this.worker.postMessage({ id, command });
    });
  }

  async upgradeExecutionSchema(): Promise<void> {
    await this.run({ kind: "execution_upgrade" });
  }
  async inspectExecutionRuntime(): Promise<ExecutionRuntimeInspection> {
    const value = await this.run<unknown>({
      kind: "execution_runtime_inspect",
    });
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new SqliteWorkerError();
    const result = value as Partial<ExecutionRuntimeInspection>;
    if (
      ![1, 2].includes(result.catalog_version as number) ||
      typeof result.catalog_fingerprint !== "string" ||
      (result.version !== null && typeof result.version !== "number") ||
      (result.fingerprint !== null && typeof result.fingerprint !== "string") ||
      typeof result.migrated !== "boolean" ||
      !Array.isArray(result.tables) ||
      !result.tables.every((item) => typeof item === "string") ||
      !result.counts ||
      typeof result.counts !== "object" ||
      Array.isArray(result.counts)
    )
      throw new SqliteWorkerError();
    return result as ExecutionRuntimeInspection;
  }
  async migrateExecutionRuntime(
    dryRun = false,
  ): Promise<ExecutionMigrationReceipt> {
    const value = await this.run<unknown>({
      kind: "execution_runtime_migrate",
      dryRun,
    });
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new SqliteWorkerError();
    const receipt = value as Partial<ExecutionMigrationReceipt>;
    if (
      typeof receipt.migration_id !== "string" ||
      !["migrate", "dry-run"].includes(receipt.action as string) ||
      (receipt.from_version !== null &&
        typeof receipt.from_version !== "number") ||
      receipt.to_version !== SCHEMA_V2_VERSION ||
      typeof receipt.manifest_fingerprint !== "string" ||
      typeof receipt.applied_at !== "string" ||
      !receipt.inspection
    )
      throw new SqliteWorkerError();
    return receipt as ExecutionMigrationReceipt;
  }
  async createExecutionJob(
    job: ExecutionJob,
    policySha256: string,
    policy: ExecutionPolicySnapshot,
  ): Promise<ExecutionJob> {
    const parsed = parseExecutionJob(job);
    const parsedPolicy = parseExecutionPolicy(policy);
    executionText(policySha256, 64);
    if (!/^[0-9a-f]{64}$/u.test(policySha256)) throw new SqliteWorkerError();
    return parseExecutionJob(
      await this.run({
        kind: "execution_create_job",
        job: parsed,
        policy_sha256: policySha256,
        policy_json: parsedPolicy,
      }),
    );
  }
  async getExecutionJob(jobId: string): Promise<ExecutionJob | null> {
    executionText(jobId);
    const value = await this.run<unknown>({ kind: "execution_get_job", jobId });
    return value === null ? null : parseExecutionJob(value);
  }
  async getExecutionPolicy(
    jobId: string,
  ): Promise<ExecutionPolicySnapshot | null> {
    executionText(jobId);
    const value = await this.run<unknown>({
      kind: "execution_get_policy",
      jobId,
    });
    return value === null ? null : parseExecutionPolicy(value);
  }
  async getExecutionBudget(jobId: string): Promise<ExecutionBudget | null> {
    executionText(jobId);
    const value = await this.run<unknown>({
      kind: "execution_get_budget",
      jobId,
    });
    return value === null ? null : parseExecutionBudget(value);
  }
  async consumeExecutionBudget(
    jobId: string,
    usage: ExecutionBudgetUsage,
    now = new Date().toISOString(),
  ): Promise<ExecutionBudgetClaim> {
    executionText(jobId);
    executionText(now, 64);
    for (const value of [
      usage.attempts,
      usage.network_bytes,
      usage.model_calls,
    ])
      if (!Number.isSafeInteger(value) || value < 0)
        throw new SqliteWorkerError();
    const result = await this.run<unknown>({
      kind: "execution_consume_budget",
      jobId,
      usage,
      now,
    });
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new SqliteWorkerError();
    const claim = result as Partial<ExecutionBudgetClaim>;
    if (typeof claim.accepted !== "boolean" || !claim.budget)
      throw new SqliteWorkerError();
    return {
      accepted: claim.accepted,
      budget: parseExecutionBudget(claim.budget),
    };
  }
  async listExecutionJobs(limit = 100): Promise<readonly ExecutionJob[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new SqliteWorkerError();
    const value = await this.run<unknown>({
      kind: "execution_list_jobs",
      limit,
    });
    if (!Array.isArray(value)) throw new SqliteWorkerError();
    return Object.freeze(value.map(parseExecutionJob));
  }
  async listExecutionTargets(
    jobId: string,
    limit = 1000,
  ): Promise<readonly ExecutionTarget[]> {
    executionText(jobId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
      throw new SqliteWorkerError();
    const value = await this.run<unknown>({
      kind: "execution_list_targets",
      jobId,
      limit,
    });
    if (!Array.isArray(value)) throw new SqliteWorkerError();
    return Object.freeze(value.map(parseExecutionTarget));
  }
  async listExecutionAttempts(
    targetId: string,
    limit = 1000,
  ): Promise<readonly ExecutionAttempt[]> {
    executionText(targetId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
      throw new SqliteWorkerError();
    const value = await this.run<unknown>({
      kind: "execution_list_attempts",
      targetId,
      limit,
    });
    if (!Array.isArray(value)) throw new SqliteWorkerError();
    return Object.freeze(value.map(parseExecutionAttempt));
  }
  async recoverExecution(
    bootId: string,
    now = new Date().toISOString(),
  ): Promise<ExecutionRecoveryResult> {
    executionText(bootId);
    executionText(now, 64);
    const value = await this.run<unknown>({
      kind: "execution_recover",
      bootId,
      now,
    });
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new SqliteWorkerError();
    return value as ExecutionRecoveryResult;
  }
  async updateExecutionJob(
    jobId: string,
    status: ExecutionJobStatus,
    finishedAt: string | null = null,
  ): Promise<ExecutionJob> {
    executionText(jobId);
    if (!executionJobStatuses.has(status)) throw new SqliteWorkerError();
    if (finishedAt !== null) executionText(finishedAt, 64);
    return parseExecutionJob(
      await this.run({
        kind: "execution_update_job",
        jobId,
        status,
        finishedAt,
      }),
    );
  }
  async putExecutionTarget(target: ExecutionTarget): Promise<ExecutionTarget> {
    const parsed = parseExecutionTarget(target);
    return parseExecutionTarget(
      await this.run({ kind: "execution_put_target", target: parsed }),
    );
  }
  async getExecutionTarget(targetId: string): Promise<ExecutionTarget | null> {
    executionText(targetId);
    const value = await this.run<unknown>({
      kind: "execution_get_target",
      targetId,
    });
    return value === null ? null : parseExecutionTarget(value);
  }
  async claimExecutionTarget(
    jobId: string,
    now = new Date().toISOString(),
  ): Promise<ExecutionTarget | null> {
    executionText(jobId);
    executionText(now, 64);
    const value = await this.run<unknown>({
      kind: "execution_claim_target",
      jobId,
      now,
    });
    return value === null ? null : parseExecutionTarget(value);
  }
  async updateExecutionTarget(
    targetId: string,
    stage: ExecutionTargetStage,
    disposition: ExecutionTarget["disposition"],
    nextEligibleAt: string | null = null,
  ): Promise<ExecutionTarget> {
    executionText(targetId);
    if (!executionTargetStages.has(stage)) throw new SqliteWorkerError();
    if (
      disposition !== null &&
      !["pending", "completed", "failed", "skipped", "interrupted"].includes(
        disposition,
      )
    )
      throw new SqliteWorkerError();
    if (nextEligibleAt !== null) executionText(nextEligibleAt, 64);
    return parseExecutionTarget(
      await this.run({
        kind: "execution_update_target",
        targetId,
        stage,
        disposition,
        nextEligibleAt,
      }),
    );
  }
  async startExecutionAttempt(
    attempt: ExecutionAttempt,
  ): Promise<ExecutionAttempt> {
    const parsed = parseExecutionAttempt(attempt);
    return parseExecutionAttempt(
      await this.run({ kind: "execution_start_attempt", attempt: parsed }),
    );
  }
  async finishExecutionAttempt(
    attemptId: string,
    status: ExecutionAttemptStatus,
    finishedAt = new Date().toISOString(),
    failure: ExecutionAttempt["failure"] = null,
    usage: unknown = null,
  ): Promise<ExecutionAttempt> {
    executionText(attemptId);
    if (!executionAttemptStatuses.has(status)) throw new SqliteWorkerError();
    executionText(finishedAt, 64);
    const value = await this.run({
      kind: "execution_finish_attempt",
      attemptId,
      status,
      finishedAt,
      failure,
      usage,
    });
    return parseExecutionAttempt(value);
  }
  async appendExecutionEvent(event: ExecutionEvent): Promise<ExecutionEvent> {
    if (
      !event ||
      typeof event.event_id !== "string" ||
      typeof event.job_id !== "string" ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence < 0 ||
      typeof event.kind !== "string" ||
      typeof event.created_at !== "string"
    )
      throw new SqliteWorkerError();
    executionText(event.event_id);
    executionText(event.job_id);
    executionText(event.kind);
    executionText(event.created_at, 64);
    return (await this.run({
      kind: "execution_append_event",
      event,
    })) as ExecutionEvent;
  }
  async listExecutionEvents(
    jobId: string,
    after = -1,
    limit = 100,
  ): Promise<readonly ExecutionEvent[]> {
    executionText(jobId);
    if (!Number.isSafeInteger(after) || after < -1)
      throw new SqliteWorkerError();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new SqliteWorkerError();
    const value = await this.run<unknown>({
      kind: "execution_list_events",
      jobId,
      after,
      limit,
    });
    if (!Array.isArray(value)) throw new SqliteWorkerError();
    return Object.freeze(value as ExecutionEvent[]);
  }
  async putExecutionIntervention(
    intervention: ExecutionIntervention,
  ): Promise<ExecutionIntervention> {
    const parsed = parseExecutionIntervention(intervention);
    return parseExecutionIntervention(
      await this.run({
        kind: "execution_put_intervention",
        intervention: parsed,
      }),
    );
  }
  async listExecutionInterventions(
    jobId: string,
    limit = 100,
  ): Promise<readonly ExecutionIntervention[]> {
    executionText(jobId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new SqliteWorkerError();
    const value = await this.run<unknown>({
      kind: "execution_list_interventions",
      jobId,
      limit,
    });
    if (!Array.isArray(value)) throw new SqliteWorkerError();
    return Object.freeze(value.map(parseExecutionIntervention));
  }
  async resolveExecutionIntervention(
    interventionId: string,
    status: "resolved" | "expired",
    resolution: unknown,
    resolvedAt = new Date().toISOString(),
  ): Promise<ExecutionIntervention> {
    executionText(interventionId);
    executionText(resolvedAt, 64);
    return parseExecutionIntervention(
      await this.run({
        kind: "execution_resolve_intervention",
        interventionId,
        status,
        resolvedAt,
        resolution,
      }),
    );
  }
  async acquireExecutionLease(lease: ExecutionLease): Promise<ExecutionLease> {
    if (
      !lease ||
      typeof lease.lease_id !== "string" ||
      typeof lease.job_id !== "string" ||
      (lease.workspace_id !== null && typeof lease.workspace_id !== "string") ||
      typeof lease.boot_id !== "string" ||
      !Number.isSafeInteger(lease.control_epoch) ||
      lease.control_epoch < 0 ||
      typeof lease.acquired_at !== "string" ||
      lease.released_at !== null
    )
      throw new SqliteWorkerError();
    executionText(lease.lease_id);
    executionText(lease.job_id);
    executionText(lease.boot_id);
    executionText(lease.acquired_at, 64);
    return (await this.run({
      kind: "execution_acquire_lease",
      lease,
    })) as ExecutionLease;
  }
  async releaseExecutionLease(
    leaseId: string,
    releasedAt = new Date().toISOString(),
  ): Promise<boolean> {
    executionText(leaseId);
    executionText(releasedAt, 64);
    return this.run({ kind: "execution_release_lease", leaseId, releasedAt });
  }
  async backup(path: string): Promise<void> {
    await this.run({ kind: "execution_backup", path });
  }
  async restoreCheck(path: string): Promise<ExecutionRestoreCheck> {
    const value = await this.run<unknown>({
      kind: "execution_restore_check",
      path,
    });
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new SqliteWorkerError();
    return value as ExecutionRestoreCheck;
  }
  async rollbackExecutionSchema(backupPath: string): Promise<void> {
    await this.run({ kind: "execution_rollback", backupPath });
  }
  async putCandidate(value: DurableCandidate): Promise<void> {
    await this.run({
      kind: "put_candidate",
      candidate: parseDurableCandidate(value),
    });
  }
  async retireCandidate(
    value: DurableCandidate,
  ): Promise<DurableCandidate | null> {
    const candidate = parseDurableCandidate(value);
    const result = await this.run<unknown>({
      kind: "retire_candidate",
      candidate,
    });
    return result === null ? null : parseDurableCandidate(result);
  }
  async getCandidate(transferId: string): Promise<DurableCandidate | null> {
    const value = await this.run<unknown>({
      kind: "get_candidate",
      transferId,
    });
    return value === null ? null : parseDurableCandidate(value);
  }
  async prepareReceipt(
    value: CandidatePublicationIntent,
  ): Promise<CandidatePublicationReceipt | null> {
    const result = await this.run<unknown>({
      kind: "prepare_receipt",
      intent: parseCandidatePublicationIntent(value),
    });
    return result === null ? null : parseCandidatePublicationReceipt(result);
  }
  async getReceiptIntent(
    receiptId: string,
  ): Promise<CandidatePublicationIntent | null> {
    const value = await this.run<unknown>({
      kind: "get_receipt_intent",
      receiptId,
    });
    return value === null ? null : parseCandidatePublicationIntent(value);
  }
  async getReceiptResult(
    receiptId: string,
  ): Promise<CandidatePublicationReceipt | null> {
    const value = await this.run<unknown>({
      kind: "get_receipt_result",
      receiptId,
    });
    return value === null ? null : parseCandidatePublicationReceipt(value);
  }
  async listCandidates(
    articleId: string,
  ): Promise<readonly DurableCandidate[]> {
    const value = await this.run<unknown>({
      kind: "list_candidates",
      articleId,
    });
    if (!Array.isArray(value)) throw new SqliteWorkerError();
    return value.map(parseDurableCandidate);
  }
  async currentFacts(
    literatureId: string,
  ): Promise<LiteratureCurrentFacts | null> {
    const value = await this.run<unknown>({
      kind: "current_facts",
      literatureId,
    });
    return value === null ? null : parseLiteratureCurrentFacts(value);
  }
  async assetByHash(sha256: string): Promise<Asset | null> {
    const value = await this.run<unknown>({ kind: "asset_by_hash", sha256 });
    return value === null ? null : parseAsset(value);
  }
  async commitReceipt(
    value: CandidatePublicationIntent,
    created: boolean,
  ): Promise<CandidatePublicationReceipt> {
    if (typeof created !== "boolean") throw new SqliteWorkerError();
    return parseCandidatePublicationReceipt(
      await this.run({
        kind: "commit_receipt",
        intent: parseCandidatePublicationIntent(value),
        created,
      }),
    );
  }
  async pendingReceipts(): Promise<readonly CandidatePublicationIntent[]> {
    const rows = await this.run<unknown>({ kind: "pending_receipts" });
    if (!Array.isArray(rows)) throw new SqliteWorkerError();
    return rows.map(parseCandidatePublicationIntent);
  }
  schema(): Promise<Readonly<Record<string, unknown>>> {
    return this.run({ kind: "schema" });
  }
  async putDiscovery(
    publication: DiscoveryPublication,
  ): Promise<DiscoveryPublication> {
    const parsed = parseDiscoveryPublication(publication);
    return parseDiscoveryPublication(
      await this.run({ kind: "put_discovery", publication: parsed }),
    );
  }
  async getDiscovery(
    discoveryRunId: string,
  ): Promise<DiscoveryPublication | null> {
    if (typeof discoveryRunId !== "string" || !discoveryRunId.trim())
      throw new SqliteWorkerError();
    const value = await this.run<unknown>({
      kind: "get_discovery",
      discoveryRunId,
    });
    return value === null ? null : parseDiscoveryPublication(value);
  }
  candidateCleanupSnapshot(): Promise<CandidateCleanupSnapshot> {
    return this.run({ kind: "candidate_cleanup_snapshot" });
  }
  async isArtifactUnregistered(value: RetiredArtifact): Promise<boolean> {
    const artifact = parseArtifactRef(value.artifact);
    const snapshot = await this.run<{
      registered: boolean;
      candidates: { transfer_id: string; record_json: string }[];
      receipts: {
        receipt_id: string;
        transfer_id: string;
        intent_json: string;
        result_json: string | null;
      }[];
    }>({ kind: "artifact_reclamation_snapshot", reference: value.reference });
    const candidates = new Map<string, DurableCandidate>();
    let protectedByExecution = false;
    for (const row of snapshot.candidates) {
      const candidate = parseDurableCandidate(JSON.parse(row.record_json));
      if (candidate.transfer_id !== row.transfer_id)
        throw new SqliteWorkerError();
      candidates.set(row.transfer_id, candidate);
      if (
        candidate.reference === value.reference ||
        candidate.sha256 === artifact.sha256
      )
        protectedByExecution = true;
    }
    for (const row of snapshot.receipts) {
      const intent = parseCandidatePublicationIntent(
        JSON.parse(row.intent_json),
      );
      if (
        intent.receipt_id !== row.receipt_id ||
        intent.candidate.transfer_id !== row.transfer_id ||
        JSON.stringify(candidates.get(row.transfer_id)) !==
          JSON.stringify(intent.candidate)
      )
        throw new SqliteWorkerError();
      if (
        intent.target === value.reference ||
        intent.candidate.sha256 === artifact.sha256
      )
        protectedByExecution = true;
      if (row.result_json !== null) {
        const result = parseCandidatePublicationReceipt(
          JSON.parse(row.result_json),
        );
        if (
          result.receipt_id !== intent.receipt_id ||
          result.literature_id !== intent.literature_id ||
          result.asset_id !== intent.asset_id ||
          result.sha256 !== intent.candidate.sha256 ||
          result.reference !== intent.target
        )
          throw new SqliteWorkerError();
        if (
          result.reference === value.reference ||
          result.sha256 === artifact.sha256
        )
          protectedByExecution = true;
      }
    }
    return !snapshot.registered && !protectedByExecution;
  }
  contentCleanupSnapshot(
    literatureId: string,
  ): Promise<ContentCleanupSnapshot | null> {
    return this.run({ kind: "content_cleanup_snapshot", literatureId });
  }
  cleanupNoUsableContent(
    command: ContentCleanupCommand,
  ): Promise<readonly RetiredArtifact[] | null> {
    return this.run({ kind: "cleanup_no_usable_content", command });
  }
  async literatureDetailSnapshot(literatureId: string): Promise<{
    readonly detail: unknown;
    readonly content: LiteratureContentPublication | null;
  } | null> {
    return this.run({ kind: "literature_detail_snapshot", literatureId });
  }
  async locateArtifact(value: Asset | ArtifactRef): Promise<{
    readonly reference: string;
    readonly artifact: ArtifactRef;
  } | null> {
    const parsed =
      "asset_id" in value ? parseAsset(value) : parseArtifactRef(value);
    const result = await this.run<{
      readonly reference: string;
      readonly artifact: unknown;
    } | null>({ kind: "locate_artifact", value: parsed });
    if (result === null) return null;
    if (typeof result.reference !== "string") throw new SqliteWorkerError();
    return {
      reference: result.reference,
      artifact: parseArtifactRef(result.artifact),
    };
  }
  async librarySnapshot(
    ftsQuery: string | null,
    discoveryRunIds: readonly string[] = [],
  ): Promise<
    readonly {
      readonly item: LiteratureSearchItem;
      readonly relevance: number | null;
      readonly discovery_run_ids: readonly string[];
      readonly has_pdf_exhaustion: boolean;
    }[]
  > {
    const value = await this.run<unknown>({
      kind: "library_snapshot",
      ftsQuery,
      discoveryRunIds,
    });
    if (!Array.isArray(value)) throw new SqliteWorkerError();
    return value.map((row) => {
      if (
        !row ||
        typeof row !== "object" ||
        typeof row.has_pdf_exhaustion !== "boolean" ||
        !Array.isArray(row.discovery_run_ids) ||
        row.discovery_run_ids.some((id: unknown) => typeof id !== "string") ||
        (row.relevance !== null &&
          (typeof row.relevance !== "number" ||
            !Number.isFinite(row.relevance)))
      )
        throw new SqliteWorkerError();
      return Object.freeze({
        item: parseLiteratureSearchItem(row.item),
        relevance: row.relevance as number | null,
        has_pdf_exhaustion: row.has_pdf_exhaustion as boolean,
        discovery_run_ids: Object.freeze(row.discovery_run_ids as string[]),
      });
    });
  }
  async putLiterature(literature: Literature): Promise<boolean> {
    const parsed = parseLiterature(literature);
    const metadataSha256 = await sha256(canonicalJsonBytes(parsed.metadata));
    const fallbackKey =
      stableIdentifierKeys(parsed.metadata).length === 0
        ? fallbackIdentityKey(parsed.metadata)
        : null;
    const fallbackDigest = fallbackKey
      ? await fallbackIdentitySha256(fallbackKey)
      : null;
    return this.run({
      kind: "put_literature",
      literature: parsed,
      metadataSha256,
      fallbackIdentitySha256: fallbackDigest,
    });
  }
  getLiterature(literatureId: string): Promise<Literature | null> {
    return this.run({ kind: "get_literature", literatureId });
  }
  async findLiteratureByIdentifiers(
    values: readonly Identifier[],
  ): Promise<readonly Literature[]> {
    if (!Array.isArray(values) || values.length > 128)
      throw new SqliteWorkerError();
    const identifiers = values.map(parseIdentifier);
    const result = await this.run<unknown>({
      kind: "find_literature_by_identifiers",
      identifiers,
    });
    if (!Array.isArray(result)) throw new SqliteWorkerError();
    return result.map(parseLiterature);
  }
  async listLiterature(
    afterCursor: string | null,
    limit: number,
  ): Promise<LiteraturePage> {
    if (
      (afterCursor !== null && typeof afterCursor !== "string") ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new SqliteWorkerError();
    let afterLiteratureId: string | null = null;
    if (afterCursor !== null) {
      try {
        const payload = await decodeCursor(afterCursor, "literature-page");
        if (
          typeof payload !== "object" ||
          payload === null ||
          Array.isArray(payload) ||
          typeof (payload as Record<string, unknown>).last_id !== "string"
        )
          throw new SqliteWorkerError();
        afterLiteratureId = (payload as { readonly last_id: string }).last_id;
      } catch {
        throw new SqliteWorkerError();
      }
    }
    const page = await this.run<{
      readonly items: readonly Literature[];
      readonly next_cursor: string | null;
    }>({ kind: "list_literature", afterLiteratureId, limit });
    return {
      items: page.items,
      next_cursor:
        page.next_cursor === null
          ? null
          : await encodeCursor("literature-page", {
              last_id: page.next_cursor,
            }),
    };
  }
  putAsset(asset: Asset): Promise<boolean> {
    return this.run({ kind: "put_asset", asset });
  }
  getAsset(assetId: string): Promise<Asset | null> {
    return this.run({ kind: "get_asset", assetId });
  }
  putLiteratureAsset(
    publication: LiteratureAssetPublication,
  ): Promise<boolean> {
    return this.run({ kind: "put_literature_asset", publication });
  }
  async commitCurrentParser(
    literatureId: string,
    result: ParserResultPublication,
  ): Promise<ParserResult | null> {
    const committed = await this.run<unknown>({
      kind: "commit_current_parser",
      literatureId,
      result,
    });
    return committed === null ? null : parseParserResult(committed);
  }
  acceptLiteratureContent(command: ContentAcceptanceCommit): Promise<boolean> {
    return this.run({ kind: "accept_literature_content", command });
  }
  putParserResult(result: ParserResultPublication): Promise<boolean> {
    return this.run({ kind: "put_parser_result", result });
  }
  putLiteratureContent(
    content: LiteratureContentPublication,
  ): Promise<boolean> {
    return this.run({ kind: "put_literature_content", content });
  }
  getLiteratureContent(
    literatureId: string,
  ): Promise<LiteratureContentPublication | null> {
    return this.run({ kind: "get_literature_content", literatureId });
  }
  putReference(reference: Reference): Promise<boolean> {
    return this.run({ kind: "put_reference", reference });
  }
  putProviderRelation(
    observation: ProviderRelationObservation,
  ): Promise<boolean> {
    return this.run({ kind: "put_provider_relation", observation });
  }
  getProviderRelation(
    observationId: string,
  ): Promise<ProviderRelationObservation | null> {
    return this.run({ kind: "get_provider_relation", observationId });
  }
  putProviderReferenceSupport(
    referenceId: string,
    observationId: string,
  ): Promise<boolean> {
    return this.run({
      kind: "put_provider_reference_support",
      referenceId,
      observationId,
    });
  }
  putMetadataReferenceSupport(
    referenceId: string,
    observationId: string,
    referenceIndex: number,
  ): Promise<boolean> {
    return this.run({
      kind: "put_metadata_reference_support",
      referenceId,
      observationId,
      referenceIndex,
    });
  }
  putContentReferenceSupport(
    referenceId: string,
    contentSha256: string,
    referenceIndex: number,
  ): Promise<boolean> {
    return this.run({
      kind: "put_content_reference_support",
      referenceId,
      contentSha256,
      referenceIndex,
    });
  }
  referenceSnapshot(): Promise<readonly ReferenceSnapshot[]> {
    return this.run({ kind: "reference_snapshot" });
  }
  async referenceQuerySnapshot(
    selection:
      | {
          readonly literature_id: string;
          readonly direction: "references" | "cited-by";
        }
      | { readonly reference_id: string },
  ): Promise<readonly ReferenceDetail[] | null> {
    const value = await this.run<unknown>({
      kind: "reference_query_snapshot",
      selection,
    });
    if (value === null) return null;
    if (!Array.isArray(value)) throw new SqliteWorkerError();
    return Object.freeze(value.map(parseReferenceDetail));
  }
  putObservation(observation: MetadataObservation): Promise<boolean> {
    return this.run({ kind: "put_observation", observation });
  }
  getObservation(observationId: string): Promise<MetadataObservation | null> {
    return this.run({ kind: "get_observation", observationId });
  }
  async readIdentity(
    request: IdentityReadRequest,
  ): Promise<IdentityReadContext> {
    const value = await this.run<unknown>({ kind: "identity_read", request });
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new SqliteWorkerError();
    const context = value as Partial<IdentityReadContext>;
    if (
      !Array.isArray(context.literatures) ||
      !Array.isArray(context.meta_literatures) ||
      !Array.isArray(context.observations) ||
      !Array.isArray(context.facts)
    )
      throw new SqliteWorkerError();
    return Object.freeze({
      literatures: Object.freeze(context.literatures.map(parseLiterature)),
      meta_literatures: Object.freeze(
        context.meta_literatures.map(parseMetaLiterature),
      ),
      observations: Object.freeze(
        context.observations.map((link) => {
          if (
            !link ||
            typeof link !== "object" ||
            typeof link.literature_id !== "string"
          )
            throw new SqliteWorkerError();
          return Object.freeze({
            literature_id: link.literature_id,
            observation: parseMetadataObservation(link.observation),
          });
        }),
      ),
      facts: Object.freeze(
        context.facts.map((fact) => {
          if (
            !fact ||
            typeof fact !== "object" ||
            !Number.isSafeInteger(fact.metadata_revision) ||
            (fact.metadata_revision as number) < 1 ||
            typeof fact.metadata_sha256 !== "string" ||
            typeof fact.content_ready !== "boolean"
          )
            throw new SqliteWorkerError();
          return Object.freeze({
            literature: parseLiterature(fact.literature),
            metadata_revision: fact.metadata_revision as number,
            metadata_sha256: fact.metadata_sha256,
            content_ready: fact.content_ready,
          });
        }),
      ),
    });
  }
  publishIdentityObservation(
    publication: IdentityPublicationCommand,
  ): Promise<boolean> {
    return this.run({ kind: "publish_identity_observation", publication });
  }
  async acceptObservation(
    observationId: string,
    literatureId: string,
    expectedMetadataRevision: number,
    expectedMetadataSha256: string,
  ): Promise<boolean> {
    const observation = await this.getObservation(observationId);
    if (!observation) throw new SqliteWorkerError();
    const nextMetadataSha256 = await sha256(
      canonicalJsonBytes(observation.metadata),
    );
    return this.run({
      kind: "accept_observation",
      observationId,
      literatureId,
      expectedMetadataRevision,
      expectedMetadataSha256,
      nextMetadataSha256,
    });
  }
  snapshotCounts(): Promise<SqliteSnapshotCounts> {
    return this.run({ kind: "snapshot_counts" });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll();
    if (this.failed) {
      await this.worker.terminate();
      return;
    }
    await new Promise<void>((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: () => resolve(),
        reject: () => resolve(),
      });
      this.worker.postMessage({ id, command: { kind: "close" } });
    });
    await this.worker.terminate();
  }

  private rejectAll(): void {
    for (const pending of this.pending.values())
      pending.reject(new SqliteWorkerError());
    this.pending.clear();
  }
}
