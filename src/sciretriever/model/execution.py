# noqa: SIZE_OK - declarative execution contracts remain with one Model owner
from __future__ import annotations

from typing import Annotated, Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, SkipValidation, StringConstraints

from sciretriever.model.canonical_json import CanonicalJsonObject
from sciretriever.model.library_query import QueryFilterV1
from sciretriever.model.literature import (
    PreparedBibliographyAcceptance,
    ReferenceSetFact,
    TagSetFact,
)
from sciretriever.model.primitives import (
    BatchRunId,
    BatchStatus,
    BatchType,
    BibliographyFormat,
    CollectionRunId,
    MissingStep,
    PublicationPhase,
    UtcTimestamp,
    WorkVersionId,
    WorkVersionState,
)

NonBlankText: TypeAlias = Annotated[str, StringConstraints(pattern=r".*\S.*")]
TargetOutcome: TypeAlias = Literal[
    "completed",
    "partially-advanced",
    "missing",
    "skipped",
    "failed",
    "not-started",
]
TargetState: TypeAlias = Literal[
    "unreviewed",
    "asset-ready",
    "light-text-ready",
    "completed",
]
ExecutionStage: TypeAlias = Literal[
    "metadata",
    "asset",
    "light-document",
    "analysis",
    "completion",
    "acquisition",
    "parsing",
    "feedback",
]
ImportOutcome: TypeAlias = Literal["created", "enriched", "duplicate", "rejected"]
ExportOutcome: TypeAlias = Literal["exported", "skipped", "failed"]


class _ExecutionModel(BaseModel):
    model_config = ConfigDict(
        arbitrary_types_allowed=True,
        extra="forbid",
        frozen=True,
        strict=True,
    )


class Reason(_ExecutionModel):
    value: NonBlankText


class Action(_ExecutionModel):
    value: NonBlankText


class FailureEvidence(_ExecutionModel):
    code: NonBlankText
    reason: Reason
    action: Action
    retryable: bool


class ExecutionCandidate(_ExecutionModel):
    work_version_id: WorkVersionId
    state: WorkVersionState


class ActualProcessTarget(_ExecutionModel):
    work_version_id: WorkVersionId
    initial_state: WorkVersionState
    target_state: WorkVersionState
    missing_step: MissingStep


class TargetStepRequest(_ExecutionModel):
    batch_run_id: BatchRunId
    work_version_id: WorkVersionId
    initial_state: WorkVersionState
    target_state: WorkVersionState


import sciretriever.model.assets as asset_models  # noqa: E402
import sciretriever.model.documents as document_models  # noqa: E402

ContentAcceptance: TypeAlias = (
    asset_models.PrimaryPdfAcceptance
    | asset_models.SupplementaryAssetAcceptance
    | document_models.LightDocumentAcceptance
)


class CurrentFailure(_ExecutionModel):
    stage: NonBlankText
    code: NonBlankText
    reason: NonBlankText
    action: NonBlankText
    retryable: bool
    updated_at: UtcTimestamp


class TargetResult(_ExecutionModel):
    subject_type: NonBlankText
    subject_id: NonBlankText
    outcome: TargetOutcome
    initial_state: TargetState
    target_state: TargetState
    final_state: TargetState
    stage: ExecutionStage | None
    failure: CurrentFailure | None


class TargetResultEnvelope(_ExecutionModel):
    result: TargetResult
    details: SkipValidation[CanonicalJsonObject]


class RecoveryTarget(_ExecutionModel):
    batch_run_id: BatchRunId
    work_version_id: WorkVersionId
    initial_state: WorkVersionState
    target_state: WorkVersionState
    current_state: WorkVersionState | None
    started: bool
    result: TargetResult | None


class TargetProjection(_ExecutionModel):
    batch_run_id: BatchRunId
    work_version_id: WorkVersionId
    result: TargetResult
    details: SkipValidation[CanonicalJsonObject]
    failure_stages_to_clear: tuple[ExecutionStage, ...]


class ImportResult(_ExecutionModel):
    record_index: int = Field(strict=True, ge=0)
    work_id: NonBlankText | None
    work_version_id: WorkVersionId | None
    outcome: ImportOutcome
    omissions: tuple[NonBlankText, ...]
    failure: FailureEvidence | CurrentFailure | None


class ExportResult(_ExecutionModel):
    record_index: int = Field(strict=True, ge=0)
    work_id: NonBlankText
    work_version_id: WorkVersionId
    outcome: ExportOutcome
    omissions: tuple[NonBlankText, ...]
    failure: CurrentFailure | None


class ImportRecordProjection(_ExecutionModel):
    batch_run_id: BatchRunId
    work_version_id: WorkVersionId
    input_ordinal: int = Field(strict=True, ge=0)
    result: ImportResult
    details: SkipValidation[CanonicalJsonObject]


class ProcessSelector(_ExecutionModel):
    kind: Literal[
        "collection",
        "collection-run",
        "import-batch",
        "works",
        "versions",
        "query",
        "all-missing",
    ]
    ids: tuple[NonBlankText, ...]
    query: QueryFilterV1 | None


class ProcessBatchScope(_ExecutionModel):
    kind: Literal["process"]
    selector: ProcessSelector
    trigger_collection_run_id: CollectionRunId | None
    selected_version_ids: tuple[WorkVersionId, ...]
    include_all_versions: bool
    target_state: TargetState
    limit: int = Field(strict=True, ge=1)


class RecoverableProcessBatch(_ExecutionModel):
    batch_run_id: BatchRunId
    scope: ProcessBatchScope
    targets: tuple[RecoveryTarget, ...]
    started_at: UtcTimestamp


class ImportBatchScope(_ExecutionModel):
    kind: Literal["import"]
    format: BibliographyFormat
    record_count: int = Field(strict=True, ge=0)


class ExportBatchScope(_ExecutionModel):
    kind: Literal["export"]
    format: BibliographyFormat
    selector: ProcessSelector
    selected_version_ids: tuple[WorkVersionId, ...]
    all_versions: bool
    output_path: NonBlankText


BatchScope: TypeAlias = ProcessBatchScope | ImportBatchScope | ExportBatchScope
BatchResult: TypeAlias = TargetResult | ImportResult | ExportResult


class StateCounts(_ExecutionModel):
    kind: Literal["state"]
    selected: int = Field(strict=True, ge=0)
    completed: int = Field(strict=True, ge=0)
    partially_advanced: int = Field(strict=True, ge=0)
    missing: int = Field(strict=True, ge=0)
    skipped: int = Field(strict=True, ge=0)
    failed: int = Field(strict=True, ge=0)
    not_started: int = Field(strict=True, ge=0)


class ImportCounts(_ExecutionModel):
    kind: Literal["import"]
    selected: int = Field(strict=True, ge=0)
    created: int = Field(strict=True, ge=0)
    enriched: int = Field(strict=True, ge=0)
    duplicate: int = Field(strict=True, ge=0)
    rejected: int = Field(strict=True, ge=0)


class ExportCounts(_ExecutionModel):
    kind: Literal["export"]
    selected: int = Field(strict=True, ge=0)
    exported: int = Field(strict=True, ge=0)
    skipped: int = Field(strict=True, ge=0)
    failed: int = Field(strict=True, ge=0)


BatchCounts: TypeAlias = StateCounts | ImportCounts | ExportCounts


class BatchSummary(_ExecutionModel):
    kind: Literal["batch-summary"]
    batch_run_id: BatchRunId
    batch_type: BatchType
    status: BatchStatus
    publication_phase: PublicationPhase
    counts: BatchCounts
    started_at: UtcTimestamp | None
    finished_at: UtcTimestamp | None


class BatchDetail(_ExecutionModel):
    kind: Literal["batch-detail"]
    batch_run_id: BatchRunId
    batch_type: BatchType
    status: BatchStatus
    publication_phase: PublicationPhase
    scope: BatchScope
    target_state: TargetState | None
    stop_reason: NonBlankText | None
    common_error: CurrentFailure | None
    counts: BatchCounts
    results: tuple[BatchResult, ...]
    started_at: UtcTimestamp | None
    finished_at: UtcTimestamp | None


class ImportAcceptanceCommand(_ExecutionModel):
    bibliography: PreparedBibliographyAcceptance
    references: ReferenceSetFact
    tags: TagSetFact
    record: ImportRecordProjection


class ContentAcceptanceCommand(_ExecutionModel):
    acceptance: SkipValidation[ContentAcceptance]
    target: TargetProjection


__all__ = (
    "Action",
    "ActualProcessTarget",
    "BatchCounts",
    "BatchDetail",
    "BatchResult",
    "BatchScope",
    "BatchSummary",
    "ContentAcceptance",
    "ContentAcceptanceCommand",
    "CurrentFailure",
    "ExecutionCandidate",
    "ExecutionStage",
    "ExportBatchScope",
    "ExportCounts",
    "ExportResult",
    "FailureEvidence",
    "ImportAcceptanceCommand",
    "ImportBatchScope",
    "ImportCounts",
    "ImportOutcome",
    "ImportRecordProjection",
    "ImportResult",
    "ProcessBatchScope",
    "ProcessSelector",
    "Reason",
    "RecoverableProcessBatch",
    "RecoveryTarget",
    "StateCounts",
    "TargetProjection",
    "TargetResult",
    "TargetResultEnvelope",
    "TargetStepRequest",
    "TargetState",
)
