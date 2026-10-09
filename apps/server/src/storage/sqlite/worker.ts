import {
  acquireExecutionRuntime,
  ExecutionRuntimeOwner,
} from "../execution/runtime-owner.js";
import {
  SCHEMA_V9_FINGERPRINT,
  SCHEMA_V9_MANIFEST,
  SCHEMA_V9_VERSION,
} from "./schema-v9.js";
import {
  parseArticleIdentityAssessment,
  type ArticleIdentityAssessment,
} from "@sciretriever/contracts";
import type { CandidateCleanupSnapshot } from "../../acquisition/candidate-cleanup.js";
import {
  WriteAdmissionError,
  type CatalogWriteAdmission,
} from "../write-admission.js";
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
import { RetrievalStorageError } from "../../retrieval/model.js";
import { CASE_FOLD } from "../../literature/unicode-casefold.js";
import { SCHEMA_FINGERPRINT, SCHEMA_MANIFEST } from "./schema.js";
import {
  SCHEMA_IDENTITY_V2,
  SCHEMA_V2_FINGERPRINT,
  SCHEMA_V2_VERSION,
} from "./schema-v2.js";
import {
  SCHEMA_V3_FINGERPRINT,
  SCHEMA_V3_MANIFEST,
  SCHEMA_V3_VERSION,
} from "./schema-v3.js";
import {
  SCHEMA_V4_FINGERPRINT,
  SCHEMA_V4_MANIFEST,
  SCHEMA_V4_VERSION,
} from "./schema-v4.js";
import {
  SCHEMA_V5_FINGERPRINT,
  SCHEMA_V5_MANIFEST,
  SCHEMA_V5_VERSION,
} from "./schema-v5.js";
import {
  SCHEMA_V6_FINGERPRINT,
  SCHEMA_V6_MANIFEST,
  SCHEMA_V6_VERSION,
} from "./schema-v6.js";
import {
  SCHEMA_V7_FINGERPRINT,
  SCHEMA_V7_MANIFEST,
  SCHEMA_V7_VERSION,
} from "./schema-v7.js";
import {
  SCHEMA_V8_FINGERPRINT,
  SCHEMA_V8_MANIFEST,
  SCHEMA_V8_VERSION,
} from "./schema-v8.js";
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
  parseDocumentMaterialRef,
  parseDocumentRef,
  parseLiteratureId,
  parseAssetId,
  type DocumentMaterialRef,
  type DocumentRef,
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
export class ExtractionStorageError extends Error {
  constructor(readonly code: string) {
    super("extraction storage operation failed");
  }
}
export class KnowledgeStorageError extends Error {
  constructor(readonly code: string) {
    super("knowledge storage operation failed");
  }
}

export interface DocumentInputSnapshot {
  readonly source_artifact_path: string;
  readonly parser: {
    readonly result: ParserResult;
    readonly provenance_id: string;
    readonly markdown_artifact_path: string;
    readonly resource_artifact_paths: Readonly<Record<string, string>>;
  } | null;
}

export interface DocumentVersionPublication {
  readonly version: DocumentRef;
  readonly source_artifact_path: string;
  readonly markdown_artifact_path: string;
  readonly structure_artifact_path: string;
  readonly resource_artifact_paths: Readonly<Record<string, string>>;
  readonly expected_default_revision: number | null;
}

export interface DocumentVersionCommit {
  readonly published: boolean;
  readonly default_updated: boolean;
  readonly default_revision: number | null;
}
export interface DocumentVersionSnapshot {
  readonly version: DocumentRef;
  readonly is_default: boolean;
  readonly default_revision: number | null;
  readonly source_artifact_path: string;
  readonly markdown_artifact_path: string;
  readonly structure_artifact_path: string;
  readonly resource_artifact_paths: Readonly<Record<string, string>>;
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
  | {
      readonly kind: "article_identity_put";
      readonly assessment: ArticleIdentityAssessment;
    }
  | { readonly kind: "article_identity_get"; readonly assessmentId: string }
  | {
      readonly kind: "article_identity_current";
      readonly literatureId: string;
      readonly assetId: string;
    }
  | {
      readonly kind: "knowledge";
      readonly action:
        | "id"
        | "comparison"
        | "default"
        | "list"
        | "list-synthesis"
        | "publish"
        | "publish-synthesis"
        | "update-default";
      readonly args: unknown;
    }
  | {
      readonly kind: "retrieval";
      readonly operation:
        | "revision"
        | "metadataPage"
        | "documentPage"
        | "beginGeneration"
        | "insertEntries"
        | "publish"
        | "active"
        | "search"
        | "documentCoverage"
        | "metadataSource"
        | "hasDefault"
        | "knowledgeRevision"
        | "knowledgeSourcePage"
        | "knowledgeBegin"
        | "knowledgeInsert"
        | "knowledgePublish"
        | "knowledgeActive"
        | "knowledgeCoverage"
        | "knowledgeSearch";
      readonly args: readonly unknown[];
    }
  | {
      readonly kind: "extraction";
      readonly action:
        | "create"
        | "operation"
        | "receipt"
        | "receipt-key"
        | "submit"
        | "close"
        | "cancel"
        | "cleanup";
      readonly args: unknown;
    }
  | {
      readonly kind: "document_material";
      readonly literatureId: string;
      readonly assetId: string;
    }
  | { readonly kind: "document_input"; readonly material: DocumentMaterialRef }
  | { readonly kind: "document_version"; readonly versionId: string }
  | {
      readonly kind: "document_default";
      readonly literatureId: string;
      readonly assetId: string;
      readonly assetSha256: string;
    }
  | {
      readonly kind: "document_commit";
      readonly publication: DocumentVersionPublication;
    }
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
      readonly targets?: readonly ExecutionTarget[];
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
      readonly onlyIfActive: boolean;
    }
  | {
      readonly kind: "execution_control_job";
      readonly jobId: string;
      readonly status: "paused" | "cancelled";
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
      readonly targetId: string | null;
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
      readonly kind: "execution_put_intervention_if_active";
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
      readonly kind: "set_automatic_pdf_exhaustion";
      readonly literatureId: string;
    }
  | {
      readonly kind: "clear_automatic_pdf_exhaustion";
      readonly literatureId: string;
    }
  | {
      readonly kind: "read_automatic_pdf_exhaustion";
      readonly literatureId: string;
    }
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
  | { readonly kind: "query_preflight" }
  | {
      readonly kind: "library_snapshot";
      readonly ftsQuery: string | null;
      readonly discoveryRunIds: readonly string[];
      readonly includeOtherVersions: boolean;
      readonly literatureIds: readonly string[];
      readonly metaLiteratureIds: readonly string[];
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
  readonly catalog_version: 1 | 2 | 3 | 4 | 5 | 6 | 7;
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

function sqliteWorkerRuntimeEntry(): {
  readonly url: URL;
  readonly source: boolean;
} {
  const source = import.meta.url.endsWith(".ts");
  return {
    url: new URL(
      source ? "./worker-runtime.ts" : "./worker-runtime.js",
      import.meta.url,
    ),
    source,
  };
}

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
  private readonly readOnly: boolean;
  private readonly executionRuntime: ExecutionRuntimeOwner;

  constructor(
    path = ":memory:",
    private readonly admission?: CatalogWriteAdmission,
    options: { readonly readOnly?: boolean } = {},
  ) {
    if (
      typeof path !== "string" ||
      (!path.startsWith("/") && path !== ":memory:")
    )
      throw new SqliteWorkerError();
    this.readOnly = options.readOnly ?? false;
    this.executionRuntime = new ExecutionRuntimeOwner(() =>
      path === ":memory:"
        ? Promise.resolve({ release: async () => {} })
        : acquireExecutionRuntime(path),
    );
    const runtime = sqliteWorkerRuntimeEntry();
    this.worker = new Worker(runtime.url, {
      execArgv: [
        ...process.execArgv.filter(
          (argument) =>
            !argument.startsWith("--input-type") &&
            argument !== "--experimental-strip-types",
        ),
        ...(runtime.source ? ["--experimental-strip-types"] : []),
      ],
      workerData: {
        path,
        read_only: this.readOnly,
        case_fold: CASE_FOLD,
        schema_manifest: SCHEMA_MANIFEST,
        schema_fingerprint: SCHEMA_FINGERPRINT,
        schema_identity_v2: SCHEMA_IDENTITY_V2,
        schema_v2_version: SCHEMA_V2_VERSION,
        schema_v2_fingerprint: SCHEMA_V2_FINGERPRINT,
        schema_v3_version: SCHEMA_V3_VERSION,
        schema_v3_fingerprint: SCHEMA_V3_FINGERPRINT,
        schema_v3_manifest: SCHEMA_V3_MANIFEST,
        schema_v4_version: SCHEMA_V4_VERSION,
        schema_v4_fingerprint: SCHEMA_V4_FINGERPRINT,
        schema_v4_manifest: SCHEMA_V4_MANIFEST,
        schema_v5_version: SCHEMA_V5_VERSION,
        schema_v5_fingerprint: SCHEMA_V5_FINGERPRINT,
        schema_v5_manifest: SCHEMA_V5_MANIFEST,
        schema_v6_version: SCHEMA_V6_VERSION,
        schema_v6_fingerprint: SCHEMA_V6_FINGERPRINT,
        schema_v6_manifest: SCHEMA_V6_MANIFEST,
        schema_v7_version: SCHEMA_V7_VERSION,
        schema_v7_fingerprint: SCHEMA_V7_FINGERPRINT,
        schema_v7_manifest: SCHEMA_V7_MANIFEST,
        schema_v9_version: SCHEMA_V9_VERSION,
        schema_v9_fingerprint: SCHEMA_V9_FINGERPRINT,
        schema_v9_manifest: SCHEMA_V9_MANIFEST,
        schema_v8_version: SCHEMA_V8_VERSION,
        schema_v8_fingerprint: SCHEMA_V8_FINGERPRINT,
        schema_v8_manifest: SCHEMA_V8_MANIFEST,
        execution_schema: EXECUTION_SCHEMA,
        execution_schema_version: EXECUTION_SCHEMA_VERSION,
        execution_schema_fingerprint: EXECUTION_SCHEMA_FINGERPRINT,
        execution_runtime_schema: EXECUTION_RUNTIME_SCHEMA,
        execution_runtime_schema_version: EXECUTION_RUNTIME_SCHEMA_VERSION,
        execution_runtime_schema_fingerprint:
          EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
      },
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

  /** Protect the full external-work lifetime, independently from short business writes. */
  withExecutionRuntime<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.failed || this.readOnly)
      return Promise.reject(new SqliteWorkerError());
    return this.executionRuntime.run(operation);
  }

  run<T>(command: SqliteCommand, signal?: AbortSignal): Promise<T> {
    const copy = structuredClone(command);
    const readOnly = new Set<string>([
      "article_identity_get",
      "article_identity_current",
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
      "read_automatic_pdf_exhaustion",
      "literature_detail_snapshot",
      "asset_by_hash",
      "locate_artifact",
      "pending_receipts",
      "reference_query_snapshot",
      "library_snapshot",
      "content_cleanup_snapshot",
      "artifact_reclamation_snapshot",
      "candidate_cleanup_snapshot",
      "query_preflight",
      "document_material",
      "document_input",
      "document_version",
      "document_default",
    ]);
    if (this.readOnly && !readOnly.has(copy.kind))
      return Promise.reject(new SqliteWorkerError());
    const send = () => {
      if (signal?.aborted)
        return Promise.reject(
          new WriteAdmissionError("write-admission-cancelled"),
        );
      return this.send<T>(copy);
    };
    // A running Entry operation retains catalog write admission for its whole
    // frozen scope. Operator pause/cancel must still reach the same SQLite
    // worker immediately; its single-threaded, transactional command is the
    // control lane that can stop later target admission.
    if (copy.kind === "execution_control_job") return send();
    if (this.admission && (!this.initialized || !readOnly.has(copy.kind)))
      return this.admission.run(send, signal);
    return send();
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

  /** Retrieval owns its SQL engine inside this worker; writes share catalog admission. */
  async retrieval<T>(
    operation: Extract<SqliteCommand, { kind: "retrieval" }>["operation"],
    args: readonly unknown[] = [],
    signal?: AbortSignal,
  ): Promise<T> {
    const write = [
      "beginGeneration",
      "insertEntries",
      "publish",
      "knowledgeBegin",
      "knowledgeInsert",
      "knowledgePublish",
    ].includes(operation);
    if (this.readOnly && write) throw new SqliteWorkerError();
    if (write && !this.admission) throw new SqliteWorkerError();
    const send = async () => {
      if (signal?.aborted)
        throw new WriteAdmissionError("write-admission-cancelled");
      // Once sent, wait for the durable worker result even if the signal aborts.
      const reply = await this.send<{ ok: boolean; value?: T; code?: string }>({
        kind: "retrieval",
        operation,
        args,
      });
      if (!reply.ok)
        throw new RetrievalStorageError(
          reply.code === "index-stale" ? "index-stale" : "index-corrupt",
        );
      return reply.value as T;
    };
    return write ? this.admission!.run(send, signal) : send();
  }

  /** Extraction writes use the same catalog admission and SQLite worker as other facts. */
  async extraction<T>(
    action: Extract<SqliteCommand, { kind: "extraction" }>["action"],
    args: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const read =
      action === "operation" ||
      action === "receipt" ||
      action === "receipt-key";
    if (this.readOnly && !read) throw new ExtractionStorageError("read-only");
    if (!read && !this.admission)
      throw new ExtractionStorageError("write-admission-required");
    const copy = structuredClone(args);
    const send = async () => {
      if (signal?.aborted)
        throw new WriteAdmissionError("write-admission-cancelled");
      // Once posted, always settle the real transaction before reporting cancellation.
      const reply = await this.send<{ ok: boolean; value?: T; code?: string }>({
        kind: "extraction",
        action,
        args: copy,
      });
      if (!reply.ok)
        throw new ExtractionStorageError(reply.code ?? "storage-failed");
      return reply.value as T;
    };
    return read ? send() : this.admission!.run(send, signal);
  }

  async knowledge<T>(
    action: Extract<SqliteCommand, { kind: "knowledge" }>["action"],
    args: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const read = [
      "id",
      "comparison",
      "default",
      "list",
      "list-synthesis",
    ].includes(action);
    if (this.readOnly && !read) throw new KnowledgeStorageError("read-only");
    if (!read && !this.admission)
      throw new KnowledgeStorageError("write-admission-required");
    const copy = structuredClone(args);
    const send = async () => {
      if (signal?.aborted)
        throw new WriteAdmissionError("write-admission-cancelled");
      const reply = await this.send<{ ok: boolean; value?: T; code?: string }>({
        kind: "knowledge",
        action,
        args: copy,
      });
      if (!reply.ok)
        throw new KnowledgeStorageError(reply.code ?? "storage-failed");
      return reply.value as T;
    };
    return read ? send() : this.admission!.run(send, signal);
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
      ![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(result.catalog_version as number) ||
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
    targets: readonly ExecutionTarget[] = [],
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
        targets: targets.map((target) => parseExecutionTarget(target)),
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
    onlyIfActive = false,
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
        onlyIfActive,
      }),
    );
  }
  async controlExecutionJob(
    jobId: string,
    status: "paused" | "cancelled",
    finishedAt: string | null = null,
  ): Promise<ExecutionJob> {
    executionText(jobId);
    if (status !== "paused" && status !== "cancelled")
      throw new SqliteWorkerError();
    if (finishedAt !== null) executionText(finishedAt, 64);
    return parseExecutionJob(
      await this.run({
        kind: "execution_control_job",
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
    targetId: string | null = null,
  ): Promise<ExecutionTarget | null> {
    executionText(jobId);
    executionText(now, 64);
    if (targetId !== null) executionText(targetId);
    const value = await this.run<unknown>({
      kind: "execution_claim_target",
      jobId,
      now,
      targetId,
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
      event.sequence < -1 ||
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
  async putExecutionInterventionIfActive(
    intervention: ExecutionIntervention,
  ): Promise<ExecutionIntervention | null> {
    const parsed = parseExecutionIntervention(intervention);
    const value = await this.run<unknown>({
      kind: "execution_put_intervention_if_active",
      intervention: parsed,
    });
    return value === null ? null : parseExecutionIntervention(value);
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
  async documentInput(
    material: DocumentMaterialRef,
  ): Promise<DocumentInputSnapshot | null> {
    const value = await this.run<DocumentInputSnapshot | null>({
      kind: "document_input",
      material: parseDocumentMaterialRef(material),
    });
    if (value === null) return null;
    if (typeof value.source_artifact_path !== "string")
      throw new SqliteWorkerError();
    return {
      source_artifact_path: value.source_artifact_path,
      parser:
        value.parser === null
          ? null
          : {
              result: await parseParserResult(value.parser.result),
              provenance_id: value.parser.provenance_id,
              markdown_artifact_path: value.parser.markdown_artifact_path,
              resource_artifact_paths: value.parser.resource_artifact_paths,
            },
    };
  }
  async documentMaterial(
    literatureId: string,
    assetId: string,
  ): Promise<{
    readonly material: DocumentMaterialRef;
    readonly path: string;
  } | null> {
    const value = await this.run<unknown>({
      kind: "document_material",
      literatureId: String(parseLiteratureId(literatureId)),
      assetId: String(parseAssetId(assetId)),
    });
    if (value === null) return null;
    if (
      !value ||
      typeof value !== "object" ||
      !("material" in value) ||
      !("path" in value) ||
      typeof value.path !== "string"
    )
      throw new SqliteWorkerError();
    return {
      material: parseDocumentMaterialRef(value.material),
      path: value.path,
    };
  }
  async commitDocumentVersion(
    publication: DocumentVersionPublication,
    signal?: AbortSignal,
  ): Promise<DocumentVersionCommit> {
    const value = await this.run<DocumentVersionCommit>(
      {
        kind: "document_commit",
        publication: {
          ...publication,
          version: parseDocumentRef(publication.version),
        },
      },
      signal,
    );
    if (
      typeof value.published !== "boolean" ||
      typeof value.default_updated !== "boolean" ||
      (value.default_revision !== null &&
        !Number.isSafeInteger(value.default_revision))
    )
      throw new SqliteWorkerError();
    return value;
  }
  async publishArticleIdentity(
    assessment: ArticleIdentityAssessment,
  ): Promise<boolean> {
    return this.run<boolean>({
      kind: "article_identity_put",
      assessment: parseArticleIdentityAssessment(assessment),
    });
  }
  async articleIdentity(
    assessmentId: string,
  ): Promise<ArticleIdentityAssessment | null> {
    const result = await this.run<unknown>({
      kind: "article_identity_get",
      assessmentId,
    });
    return result === null ? null : parseArticleIdentityAssessment(result);
  }
  async currentArticleIdentity(
    literatureId: string,
    assetId: string,
  ): Promise<ArticleIdentityAssessment | null> {
    const result = await this.run<unknown>({
      kind: "article_identity_current",
      literatureId,
      assetId,
    });
    return result === null ? null : parseArticleIdentityAssessment(result);
  }
  async documentVersion(
    versionId: string,
  ): Promise<DocumentVersionSnapshot | null> {
    const value = await this.run<unknown>({
      kind: "document_version",
      versionId,
    });
    if (value === null) return null;
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      !("source_artifact_path" in value) ||
      !("markdown_artifact_path" in value) ||
      !("structure_artifact_path" in value) ||
      !("resource_artifact_paths" in value)
    )
      throw new SqliteWorkerError();
    const snapshot = value as DocumentVersionSnapshot;
    if (
      typeof snapshot.is_default !== "boolean" ||
      (snapshot.default_revision !== null &&
        (!Number.isSafeInteger(snapshot.default_revision) ||
          snapshot.default_revision < 1))
    )
      throw new SqliteWorkerError();
    return { ...snapshot, version: parseDocumentRef(snapshot.version) };
  }
  async documentDefault(
    literatureId: string,
    assetId: string,
    assetSha256: string,
  ): Promise<{
    readonly document_version_id: string;
    readonly revision: number;
  } | null> {
    const value = await this.run<unknown>({
      kind: "document_default",
      literatureId,
      assetId,
      assetSha256,
    });
    if (value === null) return null;
    if (
      !value ||
      typeof value !== "object" ||
      !("document_version_id" in value) ||
      !("revision" in value) ||
      typeof value.document_version_id !== "string" ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 1
    )
      throw new SqliteWorkerError();
    return {
      document_version_id: value.document_version_id,
      revision: value.revision as number,
    };
  }
  /**
   * Sets the minimal automatic PDF acquisition exhaustion fact for one Literature.
   *
   * Only a business owner that observed every current automatic acquisition route end normally
   * without a usable PDF may call this. A system, network, permission, configuration, storage,
   * parser/model, cancellation or uncertain outcome is not an exhaustion fact and must never be
   * recorded as one. The fact carries no reason, provider, candidate, configuration, time or
   * attempt state, and it does not change the Literature status. Setting is idempotent.
   */
  async setAutomaticPdfExhaustion(literatureId: string): Promise<void> {
    if (typeof literatureId !== "string") throw new SqliteWorkerError();
    const value = await this.run<unknown>({
      kind: "set_automatic_pdf_exhaustion",
      literatureId,
    });
    if (value !== true) throw new SqliteWorkerError();
  }
  /**
   * Clears the fact for one Literature. Clearing is reserved for a newly accepted
   * MetadataObservation, a successfully accepted primary PDF, or an explicit user retry of that
   * exact Literature; wide selectors never clear another Literature's fact. Clearing is
   * idempotent and an unknown Literature is rejected.
   */
  async clearAutomaticPdfExhaustion(literatureId: string): Promise<void> {
    if (typeof literatureId !== "string") throw new SqliteWorkerError();
    const value = await this.run<unknown>({
      kind: "clear_automatic_pdf_exhaustion",
      literatureId,
    });
    if (value !== true) throw new SqliteWorkerError();
  }
  /**
   * Reads the fact for one Literature. `false` only means no exhaustion fact is stored; it is not
   * a promise that an automatic route can still deliver a PDF.
   */
  async hasAutomaticPdfExhaustion(literatureId: string): Promise<boolean> {
    if (typeof literatureId !== "string") throw new SqliteWorkerError();
    const value = await this.run<unknown>({
      kind: "read_automatic_pdf_exhaustion",
      literatureId,
    });
    if (typeof value !== "boolean") throw new SqliteWorkerError();
    return value;
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
  async queryPreflight(): Promise<{
    readonly status: "ready" | "not-initialized" | "unavailable";
    readonly schema: Readonly<Record<string, unknown>> | null;
  }> {
    const value = await this.run<unknown>({ kind: "query_preflight" });
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new SqliteWorkerError();
    const result = value as {
      status?: unknown;
      schema?: unknown;
    };
    if (
      (result.status !== "ready" &&
        result.status !== "not-initialized" &&
        result.status !== "unavailable") ||
      (result.schema !== null &&
        (!result.schema ||
          typeof result.schema !== "object" ||
          Array.isArray(result.schema)))
    )
      throw new SqliteWorkerError();
    return result as {
      readonly status: "ready" | "not-initialized" | "unavailable";
      readonly schema: Readonly<Record<string, unknown>> | null;
    };
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
    includeOtherVersions = false,
    literatureIds: readonly string[] = [],
    metaLiteratureIds: readonly string[] = [],
  ): Promise<
    readonly {
      readonly item: LiteratureSearchItem;
      readonly relevance: number | null;
      readonly discovery_run_ids: readonly string[];
      readonly has_pdf_exhaustion: boolean;
    }[]
  > {
    if (
      !Array.isArray(literatureIds) ||
      !Array.isArray(metaLiteratureIds) ||
      literatureIds.length > 10_000 ||
      metaLiteratureIds.length > 10_000 ||
      (literatureIds.length > 0 && metaLiteratureIds.length > 0)
    )
      throw new SqliteWorkerError();
    const value = await this.run<unknown>({
      kind: "library_snapshot",
      ftsQuery,
      discoveryRunIds,
      includeOtherVersions,
      literatureIds,
      metaLiteratureIds,
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
