import { FilterError } from "../../literature/filters.js";
import { FolderError } from "../../literature/folders.js";
import { MarkError } from "../../literature/marks.js";
import { IntakeWithdrawalError } from "../../literature/intake-withdrawal.js";
import { CatalogSchemaError } from "./schema-path.js";
import { CATALOG_BACKFILL_WRITE_MS } from "./catalog-backfill.js";
import { isIntakeWithdrawalRead } from "./intake-withdrawal-engine.js";
import {
  canonicalJsonBytes,
  ContractTextValidation,
  globalLibraryCountScope,
  LIBRARY_SORT_SCOPE_LIMIT,
  parseLibraryCounts,
  parseLibraryExactCount,
  parseLibrarySearchTotal,
  type LibraryExactCount,
  type LibraryExactCountRequest,
  type LibrarySearchTotal,
  type LibraryCounts,
  decodeCursor,
  encodeCursor,
  parseArticleIdentityAssessment,
  parseArtifactRef,
  parseAsset,
  parseAssetId,
  parseCandidatePublicationIntent,
  parseCandidatePublicationReceipt,
  parseDocumentMaterialRef,
  parseDocumentRef,
  parseDraftDocumentRef,
  parseDurableCandidate,
  parseIdentifier,
  parseLiterature,
  parseLiteratureCurrentFacts,
  parseLiteratureId,
  parseLiteratureSearchItem,
  parseMetadataFieldState,
  parseMetadataObservation,
  parseMetaLiterature,
  parseMetaLiteratureId,
  parseReference,
  parseReferenceDetail,
  parseTaskProgress,
  sha256,
  type ArticleIdentityAssessment,
  type ArtifactRef,
  type Asset,
  type CandidatePublicationIntent,
  type CandidatePublicationReceipt,
  type MetadataObservation as ContractMetadataObservation,
  type DocumentMaterialRef,
  type DocumentRef,
  type DurableCandidate,
  type Identifier,
  type Literature,
  type LiteratureCurrentFacts,
  type LiteratureSearchItem,
  type MetadataFieldState,
  type MetaLiterature,
  type Reference,
  type ReferenceDetail,
  type Sha256,
  type TaskProgress,
} from "@sciretriever/contracts";
import { Worker } from "node:worker_threads";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type Logger } from "../../logging/index.js";
import {
  needsLibraryState,
  sqliteReadRequest,
  SLOW_SHORT_READ,
} from "./read-lanes.js";
import type {
  TaskDetailRead,
  TaskDetailProbe,
  TaskDetailReplay,
  TaskHistoryTransfer,
} from "./task-detail-engine.js";
import type { CandidateCleanupSnapshot } from "../files/reclamation.js";
import { SnapshotError } from "../../analysis/snapshots.js";
import {
  fallbackIdentityKey,
  fallbackIdentitySha256,
  stableIdentifierKeys,
} from "../../literature/identity-rules.js";
import type {
  LibraryPageQuery,
  SearchSnapshotRow,
} from "../../literature/query.js";
import { LibrarySortScopeLimitError } from "../../literature/query.js";
import { MetadataTextNormalization } from "../../literature/unicode-casefold.js";
import { RetrievalStorageError } from "../../retrieval/model.js";
import { TagError } from "../../tags/rules.js";
import {
  acquireExecutionRuntime,
  ExecutionRuntimeOwner,
} from "../execution/runtime-owner.js";
import type { RetiredArtifact } from "../files/reclamation.js";
import {
  WriteAdmissionError,
  type CatalogWriteAdmission,
} from "../write-admission.js";
import type { ArchiveReferencePublication } from "./archive-reference-engine.js";
import {
  EXECUTION_RUNTIME_SCHEMA,
  EXECUTION_RUNTIME_SCHEMA_FINGERPRINT,
  EXECUTION_RUNTIME_SCHEMA_VERSION,
  EXECUTION_SCHEMA,
  EXECUTION_SCHEMA_FINGERPRINT,
  EXECUTION_SCHEMA_VERSION,
} from "./execution-schema.js";
import type {
  LiteratureAssetPublication,
  MetadataObservation,
  ProviderRelationObservation,
  ReferenceSnapshot,
} from "./repositories.js";
import {
  SCHEMA_FINGERPRINT,
  SCHEMA_MANIFEST,
  SCHEMA_VERSION,
} from "./schema.js";

import {
  CatalogCorruptionError,
  isDocumentCommitFailureCode,
  type DocumentCommitFailureCode,
} from "./errors.js";
export { CatalogCorruptionError } from "./errors.js";

export class SqliteWorkerError extends Error {
  constructor(
    readonly code:
      | "sqlite-worker"
      | "execution-job-terminal"
      | DocumentCommitFailureCode = "sqlite-worker",
  ) {
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
export class DraftTextStorageError extends Error {
  constructor(readonly code: string) {
    super("draft text storage operation failed");
  }
}

export interface DocumentVersionPublication {
  readonly version: DocumentRef;
  readonly source_artifact_path: string;
  readonly markdown_artifact_path: string;
  readonly structure_artifact_path: string;
  readonly resource_artifact_paths: Readonly<Record<string, string>>;
  readonly expected_default_revision: number | null;
  readonly expected_manual_revision?: number;
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
  readonly draft_content_artifact_path?: string;
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
    readonly result_limit?: number | null;
    readonly seed_literature_ids?: readonly string[];
  };
  readonly providers: readonly {
    readonly provider_name: string;
    readonly scan_limit: number | null;
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

type CitationPublicationHeader = Omit<
  DiscoveryPublication,
  "results" | "topic_causes" | "citation_causes"
>;

export interface CitationCheckpointEvent {
  readonly sequence: number;
  readonly payload: unknown;
}

export interface IdentityReadRequest {
  readonly target_literature_id?: string;
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
    readonly withdrawn?: boolean;
    readonly field_states: readonly MetadataFieldState[];
  }[];
}

export interface IdentityPublicationCommand {
  readonly intake_member?: import("./intake-engine.js").IntakeMember;
  readonly document_condition?: {
    readonly literature_id: string;
    readonly document_version_id: string;
    readonly default_revision: number;
    readonly annotation_id: string;
  };
  readonly literatures: readonly {
    readonly literature: Literature;
    readonly metadata_revision: number;
    readonly metadata_sha256: string;
    readonly fallback_identity_sha256: string | null;
    readonly field_states: readonly MetadataFieldState[];
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
      readonly kind: "metadata_write_begin" | "metadata_write_rollback";
    }
  | {
      readonly kind: "metadata_write_commit";
      readonly events: readonly ExecutionEvent[];
    }
  | {
      readonly kind: "citation_checkpoints";
      readonly jobId: string;
      readonly targetId: string;
      readonly range?: { readonly after: number; readonly through: number };
    }
  | {
      readonly kind: "citation_publication";
      readonly part:
        | {
            readonly kind: "header";
            readonly publication: CitationPublicationHeader;
            readonly resume: boolean;
          }
        | {
            readonly kind: "causes";
            readonly causes: DiscoveryPublication["citation_causes"];
          };
    }
  | { readonly kind: "intake_withdrawn"; readonly literature_id: string }
  | {
      readonly kind: "intake_withdrawal_read" | "intake_withdrawal_write";
      readonly command: import("./intake-withdrawal-engine.js").IntakeWithdrawalCommand;
    }
  | {
      readonly kind: "draft_text_read";
      readonly request: import("./draft-text-engine.js").DraftTextRead;
    }
  | {
      readonly kind: "draft_text_write";
      readonly request: import("./draft-text-engine.js").DraftTextWrite;
    }
  | {
      readonly kind: "capture_read";
      readonly action: import("./capture-engine.js").CaptureRead;
    }
  | {
      readonly kind: "capture_write";
      readonly action: import("./capture-engine.js").CaptureWrite;
    }
  | {
      readonly kind: "import_read";
      readonly action: import("./import-engine.js").ImportRead;
    }
  | {
      readonly kind: "import_write";
      readonly action: import("./import-engine.js").ImportWrite;
    }
  | {
      readonly kind: "device_connections";
      readonly command: import("./device-connection-engine.js").DeviceStorageCommand;
    }
  | { readonly kind: "intake_read"; readonly value: unknown }
  | {
      readonly kind: "intake_write";
      readonly action: import("./intake-engine.js").IntakeWrite;
    }
  | {
      readonly kind: "library_facets";
      readonly request: import("@sciretriever/contracts").LibraryQuery;
      readonly limit: number;
      readonly ftsQuery: string | null;
    }
  | {
      readonly kind: "acquire_pdf_selection";
      readonly request: import("../../literature/query.js").PdfSelectionRequest;
    }
  | {
      readonly kind: "parse_document_selection";
      readonly request: import("../../literature/query.js").PdfSelectionRequest;
    }
  | { readonly kind: "folders"; readonly value: unknown }
  | { readonly kind: "filters"; readonly value: unknown }
  | { readonly kind: "marks"; readonly value: unknown }
  | {
      readonly kind: "snapshot";
      readonly action: import("./snapshot-engine.js").SnapshotStorageAction;
      readonly args: unknown;
    }
  | {
      readonly kind: "archive";
      readonly action: import("./archive-engine.js").ArchiveStorageAction;
      readonly args: unknown;
    }
  | {
      readonly kind: "tags";
      readonly action: import("./tag-engine.js").TagStorageAction;
      readonly args: unknown;
    }
  | {
      readonly kind: "archive_reference_publish";
      readonly publication: ArchiveReferencePublication;
    }
  | { readonly kind: "metadata_fields_read"; readonly literatureId: string }
  | {
      readonly kind: "annotation";
      readonly action: import("./structure-annotation-engine.js").AnnotationStorageAction;
      readonly args: unknown;
    }
  | {
      readonly kind: "review";
      readonly action: import("./review-engine.js").ReviewStorageAction;
      readonly args: unknown;
    }
  | {
      readonly kind: "proofread";
      readonly action: import("./proofread-engine.js").ProofreadStorageAction;
      readonly args: unknown;
    }
  | {
      readonly kind: "raw_parse";
      readonly action: import("./raw-parsing-engine.js").RawParseStorageAction;
      readonly args: unknown;
    }
  | {
      readonly kind: "processor";
      readonly action: import("./processor-engine.js").ProcessorStorageAction;
      readonly args: unknown;
    }
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
      readonly kind: "retrieval";
      readonly operation:
        | "revision"
        | "sourceCount"
        | "metadataPage"
        | "documentPage"
        | "beginGeneration"
        | "insertEntries"
        | "publish"
        | "active"
        | "state"
        | "search"
        | "documentCoverage"
        | "metadataSource"
        | "hasDefault"
        | "markCorrupt"
        | "pruneGenerationBatch"
        | "scanChanges"
        | "changesSnapshot"
        | "changePage"
        | "pruneChangeBatch"
        | "literatureSources"
        | "ensureActive"
        | "beginLiteratureUpdate"
        | "commitLiteratureUpdate"
        | "commitLiteratureBatch"
        | "finishIncremental"
        | "verificationEntries"
        | "verify"
        | "verifyCatalog"
        | "recordVerification";
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
  | {
      readonly kind: "document_parts";
      readonly literatureId: string;
      readonly offset: number;
      readonly limit: number;
    }
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
  | { readonly kind: "execution_runtime_inspect" }
  | { readonly kind: "execution_backup"; readonly path: string }
  | { readonly kind: "execution_restore_check"; readonly path: string }
  | {
      readonly kind: "execution_create_job";
      readonly origin: {
        readonly actor: string;
        readonly operation: string;
      } | null;
      readonly job: ExecutionJob;
      readonly policy_sha256: string;
      readonly policy_json: unknown;
      readonly targets?: readonly ExecutionTarget[];
    }
  | { readonly kind: "execution_get_job"; readonly jobId: string }
  | {
      readonly kind: "execution_request_start";
      readonly jobId: string;
      readonly eventId: string;
      readonly actor: string;
      readonly now: string;
    }
  | { readonly kind: "execution_list_requested_jobs" }
  | {
      readonly kind: "execution_list_jobs";
      readonly before: ExecutionJobCursor | null;
      readonly statuses: readonly ExecutionJobStatus[];
      readonly limit: number;
      readonly order: "oldest" | "newest" | "finished";
    }
  | {
      readonly kind: "execution_list_targets";
      readonly visibleOnly?: boolean;
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
      readonly acquisitionOnly?: boolean;
      readonly order: "oldest" | "newest";
      readonly jobId: string;
      readonly after: number;
      readonly limit: number;
    }
  | {
      readonly kind: "execution_task_detail_events";
      readonly jobId: string;
      readonly through: string;
      readonly withActivity: boolean;
      readonly incrementalOnly?: true;
    }
  | {
      readonly kind: "execution_task_detail_replay";
      readonly jobId: string;
      readonly through: string;
      readonly withActivity: boolean;
      readonly scratchPath: string;
    }
  | {
      readonly kind: "execution_task_detail_install";
      readonly transfer: TaskHistoryTransfer;
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
  | { readonly kind: "idle_wal_checkpoint" }
  | { readonly kind: "schema" }
  | { readonly kind: "query_preflight" }
  | {
      readonly kind: "library_state_configure";
      readonly settings: import("./library-state.js").StateSettings;
    }
  | { readonly kind: "library_state_pending" }
  | {
      readonly kind: "library_state_refresh";
      readonly budget?: {
        readonly deadline: number;
        readonly foregroundWaiting: SharedArrayBuffer;
      };
    }
  | { readonly kind: "library_collect"; readonly ids: readonly string[] }
  | {
      readonly kind: "library_counts";
      readonly query: LibraryPageQuery["query"];
      readonly ftsQuery: string | null;
      readonly counterRead?: "defer";
    }
  | {
      readonly kind: "library_exact_count";
      readonly request: LibraryExactCountRequest;
      readonly ftsQuery: string | null;
    }
  | {
      readonly kind: "library_search_page";
      readonly request: LibraryPageQuery;
      readonly stateRead?: "defer" | "fallback";
    }
  | {
      readonly kind: "library_snapshot";
      readonly ftsQuery: string | null;
      readonly discoveryRunIds: readonly string[];
      readonly includeOtherVersions: boolean;
      readonly literatureIds: readonly string[];
      readonly metaLiteratureIds: readonly string[];
      readonly tags?: import("@sciretriever/contracts").LibraryQuery["tags"];
      readonly scope?: LibraryPageQuery["query"];
    }
  | {
      readonly kind: "put_literature";
      readonly literature: Literature;
      readonly metadataSha256: Sha256;
      readonly fallbackIdentitySha256: string | null;
    }
  | { readonly kind: "get_literature"; readonly literatureId: string }
  | { readonly kind: "get_literature_ids"; readonly literatureId: string }
  | { readonly kind: "begin_read_snapshot" }
  | {
      readonly kind: "literature_bibliographies";
      readonly ids: readonly string[];
    }
  | {
      readonly kind: "find_literature_by_identifiers";
      readonly identifiers: readonly Identifier[];
      readonly idsOnly?: boolean;
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
  | { readonly kind: "put_reference"; readonly reference: Reference }
  | {
      readonly kind: "publish_provider_reference";
      readonly reference: Reference;
      readonly observationId: string;
    }
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
      readonly resumeCitation?: boolean;
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
export interface ExecutionJobCursor {
  readonly timestamp: string;
  readonly job_id: string;
}

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
/** A list projection, not an additional persisted execution fact. */
export interface ExecutionJobListItem extends ExecutionJob {
  readonly progress: TaskProgress;
  readonly start_requested: boolean;
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
  readonly catalog_version:
    | 1
    | 2
    | 3
    | 4
    | 5
    | 6
    | 7
    | 8
    | 9
    | 10
    | 11
    | 12
    | 12
    | 13
    | 14
    | 15
    | 16
    | 17
    | 18
    | 19;
  readonly catalog_fingerprint: string;
  readonly version: number | null;
  readonly fingerprint: string | null;
  readonly migrated: boolean;
  readonly tables: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
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
  readonly cancelled?: boolean;
  readonly value?: unknown;
  readonly code?: string;
  readonly addition?: string;
  readonly sqlite_code?: "SQLITE_CORRUPT" | "SQLITE_NOTADB" | null;
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

// Only the catalog operations used by a metadata segment can share its SQLite
// transaction. Unrelated reads and control commands wait for it to settle.
const METADATA_WRITE_COMMANDS = new Set<string>([
  "metadata_write_begin",
  "metadata_write_commit",
  "metadata_write_rollback",
  "identity_read",
  "publish_identity_observation",
  "get_literature_ids",
  "find_literature_by_identifiers",
  "put_provider_relation",
  "publish_provider_reference",
  "intake_write",
  "put_discovery",
  "citation_publication",
]);
const LIBRARY_SELECTION_COMMANDS = new Set<string>([
  "metadata_write_begin",
  "metadata_write_commit",
  "metadata_write_rollback",
  "library_snapshot",
  "library_search_page",
  "literature_detail_snapshot",
  "get_literature",
  "raw_parse",
  "library_collect",
]);
// Leave room for the last indivisible record and the durable commit.
const METADATA_WRITE_BUDGET_MS = 150;
interface LibraryStateRefreshResult {
  readonly rebuilt: number;
  readonly repaired: number;
  readonly more: boolean;
}
type MetadataWriteScope = {
  readonly done: Promise<void>;
  readonly events: ExecutionEvent[];
  readonly commands: ReadonlySet<string>;
  readonly textValidation?: ContractTextValidation;
  readonly textNormalization?: MetadataTextNormalization;
};

function validateExecutionEvent(event: ExecutionEvent): void {
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
}

export class SqliteWorker {
  private readonly worker: Worker;
  private nextId = 1;
  private inFlight = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      cancel?: () => void;
    }
  >();
  private closed = false;
  private closing: Promise<void> | undefined;
  private failed = false;

  private initialized = false;
  private readonly readOnly: boolean;
  private readonly snapshotReader: () => SqliteWorker;
  private readonly executionRuntime: ExecutionRuntimeOwner;
  private readonly metadataWrites = new AsyncLocalStorage<MetadataWriteScope>();
  private metadataWrite: MetadataWriteScope | undefined;
  private readonly readLogger: Pick<Logger, "warn">;
  private readonly stopReads = new AbortController();

  constructor(
    private readonly path = ":memory:",
    private readonly admission?: CatalogWriteAdmission,
    private readonly options: SqliteWorkerOptions = {},
  ) {
    if (
      typeof path !== "string" ||
      (!path.startsWith("/") && path !== ":memory:")
    )
      throw new SqliteWorkerError();
    this.readOnly = options.readOnly ?? false;
    this.snapshotReader = () =>
      new SqliteWorker(path, undefined, {
        readOnly: true,
        maxTags: options.maxTags,
        archiveProfile: options.archiveProfile,
      });
    this.readLogger = options.readLogger ?? createLogger("sqlite-read");
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
        long_read_lane: options.longReadWorker === true,
        max_tags: options.maxTags ?? 6,
        archive_profile: options.archiveProfile ?? "vlm-engine",
        schema_version: SCHEMA_VERSION,
        schema_manifest: SCHEMA_MANIFEST,
        schema_fingerprint: SCHEMA_FINGERPRINT,
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
      this.inFlight--;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.value);
      else
        pending.reject(
          reply.cancelled
            ? new DOMException("Library query cancelled", "AbortError")
            : reply.code === "catalog-corrupt"
              ? new CatalogCorruptionError(reply.sqlite_code ?? null)
              : reply.code === "catalog-addition-required"
                ? new CatalogSchemaError(reply.code, undefined, reply.addition)
                : reply.code === LIBRARY_SORT_SCOPE_LIMIT
                  ? new LibrarySortScopeLimitError()
                  : new SqliteWorkerError(
                      isDocumentCommitFailureCode(reply.code)
                        ? reply.code
                        : "sqlite-worker",
                    ),
        );
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
    // A closed, never-used worker must reject before trying its first admission.
    if (this.closed || this.failed)
      return Promise.reject(new SqliteWorkerError());
    if (this.metadataWrites.getStore()) {
      if (signal?.aborted)
        return Promise.reject(
          new WriteAdmissionError("write-admission-cancelled"),
        );
      // postMessage takes the snapshot immediately inside the admitted segment.
      return this.send<T>(command);
    }
    const copy = structuredClone(command);
    const read = sqliteReadRequest(copy);
    if (this.readOnly && !read) return Promise.reject(new SqliteWorkerError());
    const cancellableQuery = [
      "library_counts",
      "library_exact_count",
      "library_search_page",
      "library_facets",
      "acquire_pdf_selection",
      "parse_document_selection",
    ].includes(copy.kind);
    const send = () => {
      if (signal?.aborted)
        return Promise.reject(
          cancellableQuery
            ? new DOMException("Library query cancelled", "AbortError")
            : new WriteAdmissionError("write-admission-cancelled"),
        );
      return this.dispatch<T>(
        copy,
        read,
        cancellableQuery ? signal : undefined,
      );
    };
    // A running Entry operation retains catalog write admission for its whole
    // frozen scope. Operator pause/cancel must still reach the same SQLite
    // worker immediately; its single-threaded, transactional command is the
    // control lane that can stop later target admission.
    if (
      copy.kind === "execution_control_job" ||
      copy.kind === "idle_wal_checkpoint"
    )
      return send();
    return this.timeRead(read, () =>
      this.admission &&
      (!read || (!this.initialized && !this.longReader(copy, read)))
        ? this.admission.run(send, signal)
        : send(),
    );
  }
  async writeMetadataSegment<T>(
    write: (expired: () => boolean) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.writeSegment(write, METADATA_WRITE_COMMANDS, signal);
  }
  writeLibrarySelection<T>(
    write: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.writeSegment(write, LIBRARY_SELECTION_COMMANDS, signal);
  }
  private async writeSegment<T>(
    write: (expired: () => boolean) => Promise<T>,
    commands: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<T> {
    const admission = this.admission;
    if (this.readOnly || !admission || this.metadataWrites.getStore())
      throw new SqliteWorkerError();
    return admission.run(async () => {
      if (this.metadataWrite) throw new SqliteWorkerError();
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      const scope: MetadataWriteScope = {
        done,
        events: [],
        commands,
        ...(commands === METADATA_WRITE_COMMANDS
          ? {
              textValidation: new ContractTextValidation(),
              textNormalization: new MetadataTextNormalization(),
            }
          : {}),
      };
      this.metadataWrite = scope;
      try {
        return await this.metadataWrites.run(scope, async () => {
          const deadline = performance.now() + METADATA_WRITE_BUDGET_MS;
          await this.send({ kind: "metadata_write_begin" });
          try {
            // Incoming foreground writes get the next slot without waiting
            // for the remainder of the time budget.
            const result = await write(
              () => admission.hasQueuedWrites || performance.now() >= deadline,
            );
            await this.send({
              kind: "metadata_write_commit",
              events: scope.events,
            });
            return result;
          } catch (error) {
            await this.send({ kind: "metadata_write_rollback" }).catch(() => {
              this.failed = true;
              this.rejectAll();
              void this.worker.terminate();
            });
            throw error;
          }
        });
      } finally {
        this.metadataWrite = undefined;
        release();
      }
    }, signal);
  }
  withMetadataValidation<T>(validate: () => T): T {
    const { textValidation, textNormalization } =
      this.metadataWrites.getStore() ?? {};
    return textValidation && textNormalization
      ? textValidation.run(() => textNormalization.run(validate))
      : validate();
  }
  citationCheckpoints(
    jobId: string,
    targetId: string,
    range?: { readonly after: number; readonly through: number },
  ): Promise<readonly CitationCheckpointEvent[]> {
    return this.run({
      kind: "citation_checkpoints",
      jobId,
      targetId,
      ...(range ? { range } : {}),
    });
  }
  private send<T>(command: SqliteCommand, signal?: AbortSignal): Promise<T> {
    const policy = sqliteReadRequest(command);
    return this.timeRead(policy, () =>
      this.dispatch<T>(command, policy, signal),
    );
  }

  private longReader(
    command: SqliteCommand,
    policy: ReturnType<typeof sqliteReadRequest>,
  ): SqliteReadLane | undefined {
    if (
      policy?.lane === "long" &&
      this.path !== ":memory:" &&
      command.kind !== "begin_read_snapshot" &&
      !this.admission?.ownsWriteAdmission
    )
      return this.options.readLane;
    return undefined;
  }

  private dispatch<T>(
    command: SqliteCommand,
    policy: ReturnType<typeof sqliteReadRequest>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed || this.failed)
      return Promise.reject(new SqliteWorkerError());
    const lane = this.longReader(command, policy);
    if (lane) {
      const send = async () => {
        if (this.closed || this.failed) throw new SqliteWorkerError();
        return lane
          .reader(this.path, this.options)
          .sendLocal<T>(command, signal, this.stopReads.signal);
      };
      if (this.initialized || this.readOnly) return send();
      const open = () => this.sendLocal({ kind: "schema" });
      return (this.admission ? this.admission.run(open, signal) : open()).then(
        send,
      );
    }
    return this.sendLocal<T>(command, signal);
  }

  private timeRead<T>(
    policy: ReturnType<typeof sqliteReadRequest>,
    send: () => Promise<T>,
  ): Promise<T> {
    if (!policy || policy.limit_ms === null) return send();
    const { name, limit_ms } = policy;
    const started = performance.now();
    return send().finally(() => {
      const elapsed = performance.now() - started;
      if (elapsed > limit_ms)
        this.readLogger.warn("Short SQLite read exceeded its budget", {
          code: SLOW_SHORT_READ,
          operation: name,
          elapsed_ms: Math.round(elapsed),
        });
    });
  }
  private sendLocal<T>(
    command: SqliteCommand,
    callerSignal?: AbortSignal,
    ownerStop?: AbortSignal,
  ): Promise<T> {
    if (this.closed || this.failed)
      return Promise.reject(new SqliteWorkerError());
    const scope = this.metadataWrites.getStore();
    if (scope) {
      if (scope !== this.metadataWrite || !scope.commands.has(command.kind))
        return Promise.reject(new SqliteWorkerError());
    } else if (this.metadataWrite) {
      return this.metadataWrite.done.then(() =>
        this.sendLocal(command, callerSignal, ownerStop),
      );
    }
    const signal =
      ownerStop && callerSignal
        ? AbortSignal.any([ownerStop, callerSignal])
        : (ownerStop ?? callerSignal);
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const cancellation = signal
        ? new Int32Array(new SharedArrayBuffer(4))
        : undefined;
      const flag = () => {
        if (cancellation) Atomics.store(cancellation, 0, 1);
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const abort = () => {
        flag();
        this.pending.delete(id);
        cleanup();
        reject(
          ownerStop?.aborted
            ? new SqliteWorkerError()
            : new DOMException("Library query cancelled", "AbortError"),
        );
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        cancel: flag,
        resolve: (value) => {
          cleanup();
          this.initialized = true;
          resolve(value as T);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      this.worker.postMessage({
        id,
        command,
        ...(cancellation ? { cancellation: cancellation.buffer } : {}),
      });
      this.inFlight++;
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
      "ensureActive",
      "beginLiteratureUpdate",
      "pruneGenerationBatch",
      "commitLiteratureUpdate",
      "commitLiteratureBatch",
      "finishIncremental",
      "pruneChangeBatch",
      "recordVerification",
      "markCorrupt",
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
      if (!reply.ok && reply.code === "catalog-corrupt")
        throw new CatalogCorruptionError(null);
      if (!reply.ok)
        throw new RetrievalStorageError(
          reply.code === "index-stale" ||
          reply.code === "index-storage-full" ||
          reply.code === "index-reconcile-required" ||
          reply.code === "index-unavailable"
            ? reply.code
            : "index-corrupt",
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

  async marks(
    value: {
      operation: string;
      request: unknown;
      now?: string;
      actor?: string;
      mark_id?: string;
      intake_batch_id?: string;
      check_only?: boolean;
      page_count?: number;
    },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const read =
      ["list", "export"].includes(value.operation) ||
      (value.operation === "place" && value.check_only === true);
    if (!read && (this.readOnly || !this.admission))
      throw new MarkError("mark-write-unavailable");
    const copy = structuredClone(value),
      send = async () => {
        if (signal?.aborted) throw new MarkError("mark-cancelled");
        const reply = await this.send<{
          ok: boolean;
          value?: unknown;
          code?: string;
        }>({ kind: "marks", value: copy });
        if (!reply.ok) throw new MarkError(reply.code ?? "mark-storage-failed");
        return reply.value;
      };
    return read ? send() : this.admission!.run(send, signal);
  }

  async folders(
    value: {
      operation: string;
      request: unknown;
      now?: string;
      actor?: string;
      folder_id?: string;
      intake_batch_id?: string;
      export_after?: readonly [string, string] | null;
      export_folder_id?: string;
      export_tree_only?: boolean;
      export_include_tree?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const read = ["list", "delete-preview", "export"].includes(value.operation);
    if (!read && (this.readOnly || !this.admission))
      throw new FolderError("folder-write-unavailable");
    const copy = structuredClone(value),
      send = async () => {
        if (signal?.aborted) throw new FolderError("folder-cancelled");
        const reply = await this.send<{
          ok: boolean;
          value?: unknown;
          code?: string;
        }>({ kind: "folders", value: copy });
        if (!reply.ok)
          throw new FolderError(reply.code ?? "folder-storage-failed");
        return reply.value;
      };
    return read ? send() : this.admission!.run(send, signal);
  }
  async filters(
    value: {
      operation: string;
      request: unknown;
      now?: string;
      import_ids?: readonly string[];
      filter_id?: string;
    },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const read = ["list", "export"].includes(value.operation);
    if (!read && (this.readOnly || !this.admission))
      throw new FilterError("filter-write-unavailable");
    const copy = structuredClone(value),
      send = async () => {
        if (signal?.aborted) throw new FilterError("filter-cancelled");
        const reply = await this.send<{
          ok: boolean;
          value?: unknown;
          code?: string;
        }>({ kind: "filters", value: copy });
        if (!reply.ok)
          throw new FilterError(reply.code ?? "filter-storage-failed");
        return reply.value;
      };
    return read ? send() : this.admission!.run(send, signal);
  }
  /** An isolated file-backed read transaction; closing releases it on success or abort. */
  async withReadSnapshot<T>(
    consume: (reader: SqliteWorker) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (this.closed || this.failed) throw new SqliteWorkerError();
    const reader = this.snapshotReader();
    try {
      await reader.run({ kind: "begin_read_snapshot" }, signal);
      return await consume(reader);
    } finally {
      await reader.close();
    }
  }
  literatureBibliographies(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly unknown[]> {
    if (ids.length > 1000) throw new SqliteWorkerError();
    return this.run({ kind: "literature_bibliographies", ids }, signal);
  }
  async snapshot<T>(
    action: import("./snapshot-engine.js").SnapshotStorageAction,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const write = action === "publish" || action === "rename";
    if (write && (this.readOnly || !this.admission))
      throw new SnapshotError("snapshot-write-unavailable");
    const copy = structuredClone(args),
      send = async () => {
        if (signal?.aborted) throw new SnapshotError("snapshot-cancelled");
        const reply = await this.send<{
          ok: boolean;
          value?: T;
          code?: string;
        }>({ kind: "snapshot", action, args: copy });
        if (!reply.ok)
          throw new SnapshotError(reply.code ?? "snapshot-storage-failed");
        return reply.value as T;
      };
    return write ? this.admission!.run(send, signal) : send();
  }
  async archive<T>(
    action: import("./archive-engine.js").ArchiveStorageAction,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const read = ["state", "issues", "events", "stats", "revision"].includes(
      action,
    );
    if (this.readOnly && !read)
      throw new KnowledgeStorageError("archive-read-only");
    if (!read && !this.admission)
      throw new KnowledgeStorageError("archive-write-admission-required");
    const copy = structuredClone(args);
    const send = async () => {
      if (signal?.aborted)
        throw new WriteAdmissionError("write-admission-cancelled");
      const reply = await this.send<{ ok: boolean; value?: T; code?: string }>({
        kind: "archive",
        action,
        args: copy,
      });
      if (!reply.ok)
        throw new KnowledgeStorageError(reply.code ?? "archive-storage-failed");
      return reply.value as T;
    };
    return read ? send() : this.admission!.run(send, signal);
  }

  async tags<T>(
    action: import("./tag-engine.js").TagStorageAction,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const read = [
      "state",
      "list",
      "get",
      "resolve",
      "assignment",
      "changes",
      "backfill-candidates",
      "undo-preview",
    ].includes(action);
    if (this.readOnly && !read) throw new TagError("tag-read-only");
    if (!read && !this.admission)
      throw new TagError("tag-write-admission-required");
    const copy = structuredClone(args);
    const send = async () => {
      if (signal?.aborted)
        throw new WriteAdmissionError("write-admission-cancelled");
      const reply = await this.send<{
        ok: boolean;
        value?: T;
        code?: string;
        details?: Record<string, unknown>;
      }>({ kind: "tags", action, args: copy });
      if (!reply.ok)
        throw new TagError(reply.code ?? "tag-storage-failed", reply.details);
      return reply.value as T;
    };
    return read ? send() : this.admission!.run(send, signal);
  }

  async annotation<T>(
    action: import("./structure-annotation-engine.js").AnnotationStorageAction,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const read = ["get", "state", "find"].includes(action);
    if (this.readOnly && !read) throw new KnowledgeStorageError("read-only");
    if (!read && !this.admission)
      throw new KnowledgeStorageError("write-admission-required");
    const copy = structuredClone(args);
    const send = async () => {
      if (signal?.aborted)
        throw new WriteAdmissionError("write-admission-cancelled");
      const reply = await this.send<{ ok: boolean; value?: T; code?: string }>({
        kind: "annotation",
        action,
        args: copy,
      });
      if (!reply.ok)
        throw new KnowledgeStorageError(
          reply.code ?? "annotation-storage-failed",
        );
      return reply.value as T;
    };
    return read ? send() : this.admission!.run(send, signal);
  }
  async proofread<T>(
    action: import("./proofread-engine.js").ProofreadStorageAction,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const read = [
      "get",
      "document-source",
      "current",
      "state",
      "resources",
      "cache-read",
      "binding",
    ].includes(action);
    if (this.readOnly && !read) throw new KnowledgeStorageError("read-only");
    if (!read && !this.admission)
      throw new KnowledgeStorageError("write-admission-required");
    const copy = structuredClone(args);
    const send = async () => {
      if (signal?.aborted)
        throw new WriteAdmissionError("write-admission-cancelled");
      const reply = await this.send<{ ok: boolean; value?: T; code?: string }>({
        kind: "proofread",
        action,
        args: copy,
      });
      if (!reply.ok)
        throw new KnowledgeStorageError(
          reply.code ?? "proofread-storage-failed",
        );
      return reply.value as T;
    };
    return read ? send() : this.admission!.run(send, signal);
  }
  async review<T = unknown>(
    action: import("./review-engine.js").ReviewStorageAction,
    args: unknown,
  ): Promise<T> {
    const read = [
      "audit-list",
      "job-origin-get",
      "session-list",
      "session-read",
      "session-revision",
      "task-run",
      "source-records-page",
      "usage-history",
      "processor-runs",
      "literature-results",
      "estimate-issues",
    ].includes(action);
    if (this.readOnly && !read) throw new KnowledgeStorageError("read-only");
    if (!read && !this.admission)
      throw new KnowledgeStorageError("write-admission-required");
    const copy = structuredClone(args);
    const send = async () => {
      const reply = await this.send<{ ok: boolean; value?: T; code?: string }>({
        kind: "review",
        action,
        args: copy,
      });
      if (!reply.ok)
        throw new KnowledgeStorageError(reply.code ?? "review-storage-failed");
      return reply.value as T;
    };
    return read ? send() : this.admission!.run(send);
  }
  draftVersionFacts(
    versionId: string,
  ): Promise<import("./draft-text-engine.js").DraftVersionFacts | null> {
    return this.run({
      kind: "draft_text_read",
      request: { kind: "facts", document_version_id: versionId },
    });
  }
  draftCurrent(assetId: string): Promise<{
    part_asset_id: string;
    part_sha256: string;
    document_version_id: string;
    revision: number;
  } | null> {
    return this.run({
      kind: "draft_text_read",
      request: { kind: "current", asset_id: assetId },
    });
  }
  draftBackfillCandidates(
    selector: import("@sciretriever/contracts").AcquirePdfSelector,
    profile: string,
    ftsQuery: string | null,
    signal?: AbortSignal,
  ): Promise<
    readonly import("./draft-text-engine.js").DraftBackfillCandidate[]
  > {
    return this.run(
      {
        kind: "draft_text_read",
        request: { kind: "backfill-candidates", selector, profile, ftsQuery },
      },
      signal,
    );
  }
  primaryDocumentDefaults(
    literatureIds: readonly string[],
  ): Promise<
    readonly import("./draft-text-engine.js").PrimaryDocumentDefault[]
  > {
    return this.run({
      kind: "draft_text_read",
      request: { kind: "primary-defaults", literature_ids: literatureIds },
    });
  }
  private async draftTextWrite<T>(
    request: import("./draft-text-engine.js").DraftTextWrite,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.readOnly || !this.admission)
      throw new DraftTextStorageError("write-admission-required");
    const copy = structuredClone(request);
    return this.admission.run(async () => {
      signal?.throwIfAborted();
      const reply = await this.send<{ ok: boolean; value?: T; code?: string }>({
        kind: "draft_text_write",
        request: copy,
      });
      if (!reply.ok)
        throw new DraftTextStorageError(
          reply.code ?? "draft-text-storage-failed",
        );
      return reply.value as T;
    }, signal);
  }
  commitDraftVersion(
    publication: import("./draft-text-engine.js").DraftVersionPublication,
    signal?: AbortSignal,
  ): Promise<import("./draft-text-engine.js").DraftVersionCommit> {
    return this.draftTextWrite({ kind: "commit", publication }, signal);
  }
  recomputeDocumentDefault(
    request: import("./document-defaults.js").DocumentDefaultRequest,
    signal?: AbortSignal,
  ): Promise<
    ReturnType<typeof import("./document-defaults.js").recomputeDocumentDefault>
  > {
    return this.draftTextWrite({ kind: "recompute-default", request }, signal);
  }
  async rawParse<T>(
    action: import("./raw-parsing-engine.js").RawParseStorageAction,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const read = ["get", "current", "resources"].includes(action);
    if (this.readOnly && !read) throw new KnowledgeStorageError("read-only");
    if (!read && !this.admission)
      throw new KnowledgeStorageError("write-admission-required");
    const copy = structuredClone(args);
    const send = async () => {
      if (signal?.aborted)
        throw new WriteAdmissionError("write-admission-cancelled");
      const reply = await this.send<{ ok: boolean; value?: T; code?: string }>({
        kind: "raw_parse",
        action,
        args: copy,
      });
      if (!reply.ok)
        throw new KnowledgeStorageError(
          reply.code ?? "raw-parse-storage-failed",
        );
      return reply.value as T;
    };
    return read ? send() : this.admission!.run(send, signal);
  }

  async processor<T>(
    action: import("./processor-engine.js").ProcessorStorageAction,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const read = ![
      "publish",
      "project",
      "collection-put",
      "repair-projections",
      "collection-project",
    ].includes(action);
    if (this.readOnly && !read) throw new KnowledgeStorageError("read-only");
    if (!read && !this.admission)
      throw new KnowledgeStorageError("write-admission-required");
    const copy = structuredClone(args);
    const send = async () => {
      if (signal?.aborted)
        throw new WriteAdmissionError("write-admission-cancelled");
      const reply = await this.send<{ ok: boolean; value?: T; code?: string }>({
        kind: "processor",
        action,
        args: copy,
      });
      if (!reply.ok)
        throw new KnowledgeStorageError(
          reply.code ?? "processor-storage-failed",
        );
      return reply.value as T;
    };
    return read ? send() : this.admission!.run(send, signal);
  }
  async inspectExecutionRuntime(): Promise<ExecutionRuntimeInspection> {
    const value = await this.run<unknown>({
      kind: "execution_runtime_inspect",
    });
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new SqliteWorkerError();
    const result = value as Partial<ExecutionRuntimeInspection>;
    if (
      result.catalog_version !== SCHEMA_VERSION ||
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
  async createExecutionJob(
    job: ExecutionJob,
    policySha256: string,
    policy: ExecutionPolicySnapshot,
    targets: readonly ExecutionTarget[] = [],
    origin: {
      readonly actor: string;
      readonly operation: string;
    } | null = null,
  ): Promise<ExecutionJob> {
    const parsed = parseExecutionJob(job);
    const parsedPolicy = parseExecutionPolicy(policy);
    if (origin) {
      executionText(origin.actor, 256);
      executionText(origin.operation, 256);
    }
    executionText(policySha256, 64);
    if (!/^[0-9a-f]{64}$/u.test(policySha256)) throw new SqliteWorkerError();
    return parseExecutionJob(
      await this.run({
        kind: "execution_create_job",
        origin,
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
  async requestExecutionStart(
    jobId: string,
    eventId: string,
    actor: string,
    now: string,
  ): Promise<ExecutionJob | null> {
    executionText(jobId);
    executionText(eventId);
    executionText(actor);
    executionText(now, 64);
    const value = await this.run<unknown>({
      kind: "execution_request_start",
      jobId,
      eventId,
      actor,
      now,
    });
    return value === null ? null : parseExecutionJob(value);
  }
  async listRequestedExecutionJobs(): Promise<readonly string[]> {
    const value = await this.run<unknown>({
      kind: "execution_list_requested_jobs",
    });
    if (!Array.isArray(value)) throw new SqliteWorkerError();
    for (const id of value) executionText(id);
    return Object.freeze(value as string[]);
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
  async listExecutionJobs(
    limit = 100,
    order: "oldest" | "newest" | "finished" = "oldest",
    before: ExecutionJobCursor | null = null,
    statuses: readonly ExecutionJobStatus[] = [],
  ): Promise<readonly ExecutionJobListItem[]> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      !["oldest", "newest", "finished"].includes(order)
    )
      throw new SqliteWorkerError();
    if (before !== null) {
      if (order === "oldest") throw new SqliteWorkerError();
      executionText(before.timestamp, 64);
      executionText(before.job_id);
    }
    if (
      !Array.isArray(statuses) ||
      statuses.length > 7 ||
      statuses.some((status) => !executionJobStatuses.has(status))
    )
      throw new SqliteWorkerError();
    const value = await this.run<unknown>({
      kind: "execution_list_jobs",
      statuses,
      before,
      limit,
      order,
    });
    if (!Array.isArray(value)) throw new SqliteWorkerError();
    return Object.freeze(
      value.map((item: unknown) => {
        const job = parseExecutionJob(item);
        const { progress, start_requested } = item as Record<string, unknown>;
        if (typeof start_requested !== "boolean") throw new SqliteWorkerError();
        return {
          ...job,
          progress: parseTaskProgress(progress),
          start_requested,
        };
      }),
    );
  }
  async listExecutionTargets(
    jobId: string,
    limit = 1000,
    visibleOnly = false,
  ): Promise<readonly ExecutionTarget[]> {
    executionText(jobId);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > Number.MAX_SAFE_INTEGER
    )
      throw new SqliteWorkerError();
    const value = await this.run<unknown>({
      kind: "execution_list_targets",
      jobId,
      limit,
      visibleOnly,
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
    const controlled = await this.run<{ job: unknown; changed: boolean }>({
      kind: "execution_control_job",
      jobId,
      status,
      finishedAt,
    });
    const job = parseExecutionJob(controlled.job);
    if (
      !controlled.changed &&
      ["completed", "cancelled", "failed"].includes(job.status)
    )
      throw new SqliteWorkerError("execution-job-terminal");
    return job;
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
    validateExecutionEvent(event);
    return (await this.run({
      kind: "execution_append_event",
      event,
    })) as ExecutionEvent;
  }
  async appendMetadataEvent(event: ExecutionEvent): Promise<void> {
    const scope = this.metadataWrites.getStore();
    if (!scope) {
      await this.appendExecutionEvent(event);
      return;
    }
    validateExecutionEvent(event);
    if (
      scope !== this.metadataWrite ||
      event.sequence !== -1 ||
      ![
        "metadata-source",
        "citation-write-checkpoint",
        "citation-response-replaced",
        "citation-source-cooldown",
        "citation-source-deferred",
      ].includes(event.kind)
    )
      throw new SqliteWorkerError();
    // These events cannot be observed before commit. The worker inserts each
    // event in its original order, after the segment's writes have succeeded.
    scope.events.push(structuredClone(event));
  }
  async listExecutionEvents(
    jobId: string,
    after = -1,
    limit = 100,
    order: "oldest" | "newest" = "oldest",
    acquisitionOnly = false,
  ): Promise<readonly ExecutionEvent[]> {
    executionText(jobId);
    if (!["oldest", "newest"].includes(order)) throw new SqliteWorkerError();
    if (!Number.isSafeInteger(after) || after < -1)
      throw new SqliteWorkerError();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new SqliteWorkerError();
    const value = await this.run<unknown>({
      kind: "execution_list_events",
      acquisitionOnly,
      order,
      jobId,
      after,
      limit,
    });
    if (!Array.isArray(value)) throw new SqliteWorkerError();
    return Object.freeze(value as ExecutionEvent[]);
  }
  async taskDetailEvents(
    jobId: string,
    through: string,
    withActivity: boolean,
  ): Promise<TaskDetailRead> {
    executionText(jobId);
    const incrementalOnly =
      this.options.readLane &&
      this.path !== ":memory:" &&
      !this.admission?.ownsWriteAdmission;
    const detail = await this.run<TaskDetailProbe>({
      kind: "execution_task_detail_events",
      jobId,
      through,
      withActivity,
      ...(incrementalOnly ? { incrementalOnly: true as const } : {}),
    });
    if (detail.status !== "replay-required") return detail;
    const directory = await mkdtemp(
      join(tmpdir(), "sciretriever-task-history-"),
    );
    const scratchPath = join(directory, "history.sqlite");
    let installed = false;
    try {
      const { result, transfer } = await this.send<TaskDetailReplay>({
        kind: "execution_task_detail_replay",
        jobId,
        through,
        withActivity,
        scratchPath,
      });
      if (transfer) {
        installed = await this.sendLocal<boolean>({
          kind: "execution_task_detail_install",
          transfer,
        });
      }
      return result;
    } finally {
      if (!installed) await rm(directory, { recursive: true, force: true });
    }
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
  async documentParts(
    literatureId: string,
    offset: number,
    limit: number,
  ): Promise<{
    total: number;
    items: readonly {
      asset_id: string;
      asset_sha256: string;
      role: "main" | "supplementary";
    }[];
  }> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new SqliteWorkerError();
    const value = await this.run<{
      total: number;
      items: readonly {
        asset_id: string;
        asset_sha256: string;
        role: "main" | "supplementary";
      }[];
    }>({
      kind: "document_parts",
      literatureId: String(parseLiteratureId(literatureId)),
      offset,
      limit,
    });
    if (
      !Number.isSafeInteger(value.total) ||
      value.total < 0 ||
      !Array.isArray(value.items) ||
      value.items.length > limit
    )
      throw new SqliteWorkerError();
    for (const item of value.items) {
      parseAssetId(item.asset_id);
      if (
        !/^[a-f0-9]{64}$/.test(item.asset_sha256) ||
        !["main", "supplementary"].includes(item.role)
      )
        throw new SqliteWorkerError();
    }
    return value;
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
    if (
      snapshot.version.schema_version === 3 &&
      typeof snapshot.draft_content_artifact_path !== "string"
    )
      throw new SqliteWorkerError();
    return {
      ...snapshot,
      version:
        snapshot.version.schema_version === 3
          ? parseDraftDocumentRef(snapshot.version)
          : parseDocumentRef(snapshot.version),
    };
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
  intakeBatches(value: unknown) {
    return this.run<
      | import("@sciretriever/contracts").IntakeBatchPage
      | import("@sciretriever/contracts").IntakeBatch
    >({ kind: "intake_read", value });
  }
  async intakeWithdrawal(
    command: import("./intake-withdrawal-engine.js").IntakeWithdrawalCommand,
  ): Promise<unknown> {
    const result = await this.run<{
      ok: boolean;
      value?: unknown;
      code?: string;
    }>({
      kind: isIntakeWithdrawalRead(command.operation)
        ? "intake_withdrawal_read"
        : "intake_withdrawal_write",
      command,
    });
    if (!result.ok)
      throw new IntakeWithdrawalError(result.code ?? "intake-unavailable");
    return result.value;
  }
  literatureWithdrawn(id: string) {
    return this.run<boolean>({
      kind: "intake_withdrawn",
      literature_id: parseLiteratureId(id),
    });
  }
  writeIntake(action: import("./intake-engine.js").IntakeWrite) {
    return this.run<boolean>({ kind: "intake_write", action });
  }
  libraryFacets(
    query: import("@sciretriever/contracts").LibraryQuery,
    limit: number,
    ftsQuery: string | null,
    signal?: AbortSignal,
  ) {
    return this.run<import("@sciretriever/contracts").LibraryFacets>(
      { kind: "library_facets", request: query, limit, ftsQuery },
      signal,
    );
  }
  acquirePdfSelection(
    request: import("../../literature/query.js").PdfSelectionRequest,
    signal?: AbortSignal,
  ) {
    return this.run<import("../../literature/query.js").PdfSelection>(
      { kind: "acquire_pdf_selection", request },
      signal,
    );
  }
  parseDocumentSelection(
    request: import("../../literature/query.js").PdfSelectionRequest,
    signal?: AbortSignal,
  ) {
    return this.run<import("../../literature/query.js").ParseDocumentSelection>(
      { kind: "parse_document_selection", request },
      signal,
    );
  }
  async putDiscovery(
    publication: DiscoveryPublication,
    resumeCitation = false,
  ): Promise<DiscoveryPublication> {
    const parsed = parseDiscoveryPublication(publication);
    return parseDiscoveryPublication(
      await this.run({
        kind: "put_discovery",
        publication: parsed,
        resumeCitation,
      }),
    );
  }
  async putCitationDiscovery(
    publication: CitationPublicationHeader,
    pages: Iterable<DiscoveryPublication["citation_causes"]>,
    resume: boolean,
  ): Promise<void> {
    if (!this.metadataWrites.getStore() || publication.run.kind !== "citation")
      throw new SqliteWorkerError();
    parseDiscoveryPublication({
      ...publication,
      results: [],
      topic_causes: [],
      citation_causes: [],
    });
    await this.run({
      kind: "citation_publication",
      part: { kind: "header", publication, resume },
    });
    for (const causes of pages)
      await this.run({
        kind: "citation_publication",
        part: { kind: "causes", causes },
      });
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
  async literatureDetailSnapshot(literatureId: string): Promise<{
    readonly detail: unknown;
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
  async libraryCounts(
    query: LibraryPageQuery["query"],
    ftsQuery: string | null,
    signal?: AbortSignal,
  ): Promise<LibraryCounts> {
    const command = { kind: "library_counts" as const, query, ftsQuery };
    if (
      this.options.readLane &&
      ftsQuery === null &&
      globalLibraryCountScope(query, true)
    ) {
      const value = await this.run<LibraryCounts | { defer: true }>(
        { ...command, counterRead: "defer" },
        signal,
      );
      if (!("defer" in value)) return parseLibraryCounts(value);
    }
    return parseLibraryCounts(await this.run(command, signal));
  }
  async libraryExactCount(
    request: LibraryExactCountRequest,
    ftsQuery: string | null,
    signal?: AbortSignal,
  ): Promise<LibraryExactCount> {
    return parseLibraryExactCount(
      await this.run(
        { kind: "library_exact_count", request, ftsQuery },
        signal,
      ),
    );
  }
  async configureLibraryState(
    maxTags: number,
    profile: "pipeline" | "vlm-engine",
  ) {
    if (
      !Number.isSafeInteger(maxTags) ||
      maxTags < 1 ||
      maxTags > 64 ||
      !["pipeline", "vlm-engine"].includes(profile)
    )
      throw new SqliteWorkerError();
    await this.run({
      kind: "library_state_configure",
      settings: { max_tags: maxTags, archive_profile: profile },
    });
  }
  libraryStatePending(): Promise<boolean> {
    return this.run({ kind: "library_state_pending" });
  }
  refreshLibraryState(): Promise<LibraryStateRefreshResult> {
    return this.run({ kind: "library_state_refresh" });
  }
  refreshLibraryStateWhenIdle(): Promise<
    LibraryStateRefreshResult | undefined
  > {
    if (!this.admission || this.readOnly || this.closed || this.failed)
      return Promise.reject(new SqliteWorkerError());
    return this.admission.runWhenIdle(async (foregroundWaiting) => {
      // A local read, including a cancelled read that is still unwinding, can
      // occupy the worker without owning write admission.
      if (this.inFlight) return undefined;
      return this.send<LibraryStateRefreshResult>({
        kind: "library_state_refresh",
        budget: {
          deadline: performance.now() + CATALOG_BACKFILL_WRITE_MS,
          foregroundWaiting,
        },
      });
    });
  }
  async collectLiteratures(ids: readonly string[], signal?: AbortSignal) {
    if (ids.length)
      await this.run(
        {
          kind: "library_collect",
          ids: ids.map(parseLiteratureId),
        },
        signal,
      );
  }
  async librarySearchPage(
    request: LibraryPageQuery,
    signal?: AbortSignal,
  ): Promise<
    LibrarySearchTotal & {
      readonly rows: readonly SearchSnapshotRow[];
      readonly tag_backfill_pending?: number;
      readonly ranking_id?: string;
    }
  > {
    type Page = {
      rows: unknown;
      tag_backfill_pending?: number;
      ranking_id?: string;
    } & Record<string, unknown>;
    const result = await this.run<Page | { defer: true }>(
      {
        kind: "library_search_page",
        request,
        ...(this.options.readLane &&
        !this.metadataWrites.getStore() &&
        (needsLibraryState(request.query) ||
          request.sort === "collected-desc" ||
          request.query.folder ||
          request.query.intake_batch_ids.length ||
          request.query.discovery_run_ids.length ||
          request.query.collection_scope === "collected" ||
          (!request.after?.total &&
            globalLibraryCountScope(request.query) !== null)) &&
        !request.fullRelevance &&
        request.limit <= 200 &&
        request.sort !== "relevance" &&
        !request.relevanceForLargeScope
          ? { stateRead: "defer" as const }
          : {}),
      },
      signal,
    );
    const page =
      "defer" in result
        ? await this.run<Page>(
            { kind: "library_search_page", request, stateRead: "fallback" },
            signal,
          )
        : result;
    const {
      rows: rawRows,
      tag_backfill_pending,
      ranking_id,
      ...summary
    } = page;
    let total: LibrarySearchTotal;
    try {
      total = parseLibrarySearchTotal(summary);
    } catch {
      throw new SqliteWorkerError();
    }
    const rows = this.parseSearchRows(rawRows);
    if (
      rows.length > request.limit + 1 ||
      (!total.count_truncated &&
        (!request.after?.total || request.fullRelevance) &&
        rows.length > total.total_count)
    )
      throw new SqliteWorkerError();
    if (
      tag_backfill_pending !== undefined &&
      (!Number.isSafeInteger(tag_backfill_pending) || tag_backfill_pending < 0)
    )
      throw new SqliteWorkerError();
    if (
      ranking_id !== undefined &&
      ((request.sort !== "relevance" && !request.relevanceForLargeScope) ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(ranking_id))
    )
      throw new SqliteWorkerError();
    return {
      rows,
      ...total,
      ...(tag_backfill_pending === undefined ? {} : { tag_backfill_pending }),
      ...(ranking_id === undefined ? {} : { ranking_id }),
    };
  }
  async librarySnapshot(
    ftsQuery: string | null,
    discoveryRunIds: readonly string[] = [],
    includeOtherVersions = false,
    literatureIds: readonly string[] = [],
    metaLiteratureIds: readonly string[] = [],
    tags?: import("@sciretriever/contracts").LibraryQuery["tags"],
    scope?: LibraryPageQuery["query"],
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
      ...(tags ? { tags } : {}),
      ...(scope ? { scope } : {}),
    });
    return this.parseSearchRows(value);
  }
  private parseSearchRows(value: unknown): readonly SearchSnapshotRow[] {
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
        ...(row.scope_match === undefined
          ? {}
          : { scope_match: row.scope_match === true }),
        ...(row.tag_match === undefined
          ? {}
          : { tag_match: row.tag_match === true }),
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
  private parseLiteratureIds(value: unknown) {
    if (!value || typeof value !== "object") throw new SqliteWorkerError();
    const row = value as Record<string, unknown>;
    return {
      literature_id: parseLiteratureId(row.literature_id),
      meta_literature_id: parseMetaLiteratureId(row.meta_literature_id),
    };
  }
  async getLiteratureIds(literatureId: string) {
    const result = await this.run<unknown>({
      kind: "get_literature_ids",
      literatureId,
    });
    return result === null ? null : this.parseLiteratureIds(result);
  }
  private async readIdentityMatches(
    values: readonly Identifier[],
    idsOnly: boolean,
  ) {
    if (!Array.isArray(values) || values.length > 128)
      throw new SqliteWorkerError();
    const identifiers = values.map(parseIdentifier);
    const result = await this.run<unknown>({
      kind: "find_literature_by_identifiers",
      identifiers,
      idsOnly,
    });
    if (!Array.isArray(result)) throw new SqliteWorkerError();
    return result;
  }
  async findLiteratureByIdentifiers(
    values: readonly Identifier[],
  ): Promise<readonly Literature[]> {
    return (await this.readIdentityMatches(values, false)).map(parseLiterature);
  }
  async findLiteratureIdsByIdentifiers(values: readonly Identifier[]) {
    return (await this.readIdentityMatches(values, true)).map((value) =>
      this.parseLiteratureIds(value),
    );
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
  putReference(reference: Reference): Promise<boolean> {
    return this.run({ kind: "put_reference", reference });
  }
  async publishProviderReference(
    reference: Reference,
    observationId: string,
  ): Promise<Reference> {
    return parseReference(
      await this.run({
        kind: "publish_provider_reference",
        reference: parseReference(reference),
        observationId,
      }),
    );
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
    const { literatures, meta_literatures, observations, facts } =
      value as Partial<IdentityReadContext>;
    if (
      !Array.isArray(literatures) ||
      !Array.isArray(meta_literatures) ||
      !Array.isArray(observations) ||
      !Array.isArray(facts)
    )
      throw new SqliteWorkerError();
    return this.withMetadataValidation(() =>
      Object.freeze({
        literatures: Object.freeze(literatures.map(parseLiterature)),
        meta_literatures: Object.freeze(
          meta_literatures.map(parseMetaLiterature),
        ),
        observations: Object.freeze(
          observations.map((link) => {
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
          facts.map((fact) => {
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
              withdrawn: fact.withdrawn === true,
              field_states: Object.freeze(
                fact.field_states.map(parseMetadataFieldState),
              ),
            });
          }),
        ),
      }),
    );
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

  idleWalCheckpoint(): Promise<boolean> {
    return this.run({ kind: "idle_wal_checkpoint" });
  }

  close(): Promise<void> {
    return (this.closing ??= this.closeWorker());
  }
  private async closeWorker(): Promise<void> {
    this.closed = true;
    this.stopReads.abort();
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
      this.inFlight++;
    });
    await this.worker.terminate();
  }

  private rejectAll(): void {
    for (const pending of this.pending.values()) {
      pending.cancel?.();
      pending.reject(new SqliteWorkerError());
    }
    this.pending.clear();
  }
}

interface SqliteWorkerOptions {
  readonly readOnly?: boolean;
  readonly maxTags?: number | undefined;
  readonly archiveProfile?: "pipeline" | "vlm-engine" | undefined;
  readonly readLane?: SqliteReadLane;
  readonly longReadWorker?: boolean;
  readonly readLogger?: Pick<Logger, "warn">;
}
/** Shared by the two application graphs of one Workbench, created on demand. */
export class SqliteReadLane {
  private worker: SqliteWorker | undefined;
  private catalog: string | undefined;
  private closed = false;
  reader(path: string, options: SqliteWorkerOptions) {
    if (this.closed || (this.catalog !== undefined && this.catalog !== path))
      throw new SqliteWorkerError();
    this.catalog = path;
    return (this.worker ??= new SqliteWorker(path, undefined, {
      readOnly: true,
      longReadWorker: true,
      maxTags: options.maxTags,
      archiveProfile: options.archiveProfile,
    }));
  }
  async close() {
    this.closed = true;
    await this.worker?.close();
  }
}
