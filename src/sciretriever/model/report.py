"""Typed, non-persistent reports returned by Entry operations.

Reports are operation-specific return values.  They are intentionally not
database entities, checkpoints, log containers, or a generic envelope.  This
module contains the one stable failure contract shared by reports and durable
discovery source results; all external exceptions must be translated before
they cross this boundary.
"""

from __future__ import annotations

import re
import unicodedata
from enum import Enum, unique
from typing import Annotated, Literal, TypeAlias, TypeVar

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sciretriever.model.acquisition import AcceptedManualPdf
from sciretriever.model.execution import BatchGoal as _BatchGoal
from sciretriever.model.primitives import (
    DiscoveryRunId,
    LiteratureId,
    MetaLiteratureId,
)


class _ReportModel(BaseModel):
    """Frozen, closed, strict base for all report-side structures."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


_T = TypeVar("_T")
_CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")
_URL = re.compile(r"(?:https?|ftp|file)://", re.IGNORECASE)
_ABSOLUTE_PATH = re.compile(r"(?:^|[\s(])/(?:[^\s/]*/)*[^\s]*")
_WINDOWS_PATH = re.compile(r"(?:^|[\s(])[A-Za-z]:[\\/]")
_TRACEBACK = re.compile(
    r"(?:traceback\s*\(|traceback\s+most\s+recent|\b(?:ValueError|TypeError|RuntimeError|"
    r"KeyError|IndexError|OSError|Exception)\s*[:(]|\bfile\s+\")",
    re.IGNORECASE,
)
_SECRET_ASSIGNMENT = re.compile(
    r"\b(?:api[_ -]?key|access[_ -]?token|auth(?:orization)?|bearer|cookie|password|"
    r"secret|token|signature|sig)\s*[:=]\s*\S+",
    re.IGNORECASE,
)


def _nonblank_text(value: object, *, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    normalized = unicodedata.normalize("NFC", value.strip())
    if not normalized:
        raise ValueError(f"{field_name} must be nonblank")
    return normalized


def _stable_text(value: object, *, field_name: str) -> str:
    """Normalize a stable user-facing field and reject raw diagnostic material."""

    normalized = _nonblank_text(value, field_name=field_name)
    if (
        _CONTROL_CHARACTER.search(normalized) is not None
        or _URL.search(normalized) is not None
        or _ABSOLUTE_PATH.search(normalized) is not None
        or _WINDOWS_PATH.search(normalized) is not None
        or _TRACEBACK.search(normalized) is not None
        or _SECRET_ASSIGNMENT.search(normalized) is not None
    ):
        raise ValueError(f"{field_name} must be a stable redacted value")
    return normalized


def _as_tuple(value: object, *, field_name: str) -> tuple[object, ...]:
    if isinstance(value, tuple):
        return value
    if isinstance(value, list):
        return tuple(value)
    raise TypeError(f"{field_name} must be a list or tuple")


def _deduplicate(values: tuple[_T, ...]) -> tuple[_T, ...]:
    result: list[_T] = []
    for value in values:
        if value not in result:
            result.append(value)
    return tuple(result)


@unique
class BibliographyFormat(str, Enum):
    """The closed bibliography interchange formats supported by Entry."""

    BIBTEX = "bibtex"
    RIS = "ris"
    CSL_JSON = "csl-json"


def _normalize_bibliography_format(value: object) -> BibliographyFormat:
    if isinstance(value, BibliographyFormat):
        return value
    if isinstance(value, str):
        try:
            return BibliographyFormat(value.strip())
        except ValueError as error:
            raise ValueError("format must be a supported bibliography format") from error
    raise TypeError("format must be a supported bibliography format")


class StableFailure(_ReportModel):
    """A small, stable, redacted failure suitable for user-facing output."""

    code: str
    reason: str
    action: str
    retryable: bool

    @field_validator("code", "reason", "action", mode="before")
    @classmethod
    def validate_stable_text(cls, value: object, info: object) -> str:
        # The field name is intentionally not interpolated into an error value;
        # hide_input_in_errors also prevents rejected sentinel values leaking.
        return _stable_text(value, field_name="stable failure field")


class FinishedReportEnd(_ReportModel):
    kind: Literal["finished"]


class InterruptedReportEnd(_ReportModel):
    kind: Literal["interrupted"]


class FailedReportEnd(_ReportModel):
    kind: Literal["failed"]
    failure: StableFailure


ReportEnd: TypeAlias = Annotated[
    FinishedReportEnd | InterruptedReportEnd | FailedReportEnd,
    Field(discriminator="kind"),
]


DiscoveryProviderReportOutcome: TypeAlias = Literal[
    "EXHAUSTED",
    "SCAN_LIMIT_REACHED",
    "FAILED",
    "INTERRUPTED",
    "NOT_STARTED",
]


class DiscoveryProviderReport(_ReportModel):
    """The volatile per-provider view used by one DiscoveryReport."""

    provider_name: str
    raw_item_count: int = Field(strict=True, ge=0)
    accepted_observation_count: int = Field(strict=True, ge=0)
    outcome: DiscoveryProviderReportOutcome
    failure: StableFailure | None = None

    @field_validator("provider_name", mode="before")
    @classmethod
    def validate_provider_name(cls, value: object) -> str:
        return _nonblank_text(value, field_name="provider_name")

    @model_validator(mode="after")
    def validate_failure_pairing(self) -> "DiscoveryProviderReport":
        is_failed = self.outcome == "FAILED"
        if is_failed != (self.failure is not None):
            raise ValueError("failure is required only for a failed provider outcome")
        return self


def _target_key(value: object) -> tuple[str, str]:
    if isinstance(value, MetaLiteratureCompletionTarget):
        return (value.kind, str(value.meta_literature_id))
    if isinstance(value, LiteratureCompletionTarget):
        return (value.kind, str(value.literature_id))
    raise TypeError("value must be a completion target")


class DiscoveryReport(_ReportModel):
    kind: Literal["discovery"]
    end: ReportEnd
    discovery_run_id: DiscoveryRunId
    run_status: Literal[
        "RUNNING",
        "COMPLETED",
        "PARTIAL",
        "FAILED",
        "INTERRUPTED",
    ]
    providers: tuple[DiscoveryProviderReport, ...]
    discovery_result_count: int = Field(strict=True, ge=0)
    new_meta_literature_count: int = Field(strict=True, ge=0)
    new_literature_count: int = Field(strict=True, ge=0)
    new_metadata_observation_count: int = Field(strict=True, ge=0)

    @field_validator("providers", mode="before")
    @classmethod
    def normalize_providers(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="providers")

    @field_validator("providers")
    @classmethod
    def validate_provider_order_and_uniqueness(
        cls,
        value: tuple[DiscoveryProviderReport, ...],
    ) -> tuple[DiscoveryProviderReport, ...]:
        names = tuple(item.provider_name for item in value)
        if len(names) != len(set(names)):
            raise ValueError("providers must have unique provider names")
        return value


class MetaLiteratureCompletionTarget(_ReportModel):
    kind: Literal["meta-literature"]
    meta_literature_id: MetaLiteratureId


class LiteratureCompletionTarget(_ReportModel):
    kind: Literal["literature"]
    literature_id: LiteratureId


CompletionTarget: TypeAlias = Annotated[
    MetaLiteratureCompletionTarget | LiteratureCompletionTarget,
    Field(discriminator="kind"),
]

CompletionStage: TypeAlias = Literal["acquisition", "parsing", "analysis", "literature"]


class GoalReachedTarget(_ReportModel):
    target: CompletionTarget
    literature_id: LiteratureId


class NeedsManualPdfTarget(_ReportModel):
    target: CompletionTarget
    literature_ids: tuple[LiteratureId, ...]

    @field_validator("literature_ids", mode="before")
    @classmethod
    def normalize_literature_ids(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="literature_ids")

    @field_validator("literature_ids")
    @classmethod
    def validate_literature_ids(
        cls,
        value: tuple[LiteratureId, ...],
    ) -> tuple[LiteratureId, ...]:
        if not value:
            raise ValueError("literature_ids must be non-empty")
        if len(value) != len(set(value)):
            raise ValueError("literature_ids must be unique")
        return value


class FailedCompletionTarget(_ReportModel):
    target: CompletionTarget
    literature_id: LiteratureId | None = None
    stage: CompletionStage
    failure: StableFailure


class InterruptedCompletionTarget(_ReportModel):
    target: CompletionTarget
    literature_id: LiteratureId | None = None


class NotStartedCompletionTarget(_ReportModel):
    target: CompletionTarget


class DatabaseCompletionReport(_ReportModel):
    kind: Literal["database-completion"]
    end: ReportEnd
    goal: _BatchGoal
    goal_reached: tuple[GoalReachedTarget, ...]
    needs_manual_pdf: tuple[NeedsManualPdfTarget, ...]
    failed: tuple[FailedCompletionTarget, ...]
    interrupted: tuple[InterruptedCompletionTarget, ...]
    not_started: tuple[NotStartedCompletionTarget, ...]
    no_usable_content_literature_ids: tuple[LiteratureId, ...]

    @field_validator(
        "goal_reached",
        "needs_manual_pdf",
        "failed",
        "interrupted",
        "not_started",
        mode="before",
    )
    @classmethod
    def normalize_target_partitions(cls, value: object, info: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="completion partition")

    @field_validator("no_usable_content_literature_ids", mode="before")
    @classmethod
    def normalize_no_usable_content_ids(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="no_usable_content_literature_ids")

    @field_validator("no_usable_content_literature_ids")
    @classmethod
    def deduplicate_no_usable_content_ids(
        cls,
        value: tuple[LiteratureId, ...],
    ) -> tuple[LiteratureId, ...]:
        return _deduplicate(value)

    @model_validator(mode="after")
    def validate_target_partition(self) -> "DatabaseCompletionReport":
        partitions = (
            self.goal_reached,
            self.needs_manual_pdf,
            self.failed,
            self.interrupted,
            self.not_started,
        )
        seen: set[tuple[str, str]] = set()
        for partition in partitions:
            for item in partition:
                key = _target_key(item.target)
                if key in seen:
                    raise ValueError("completion target partitions must be disjoint")
                seen.add(key)
        return self


class AcceptedManualPdfReportResult(_ReportModel):
    kind: Literal["accepted"]
    accepted: AcceptedManualPdf


class RejectedManualPdfReportResult(_ReportModel):
    kind: Literal["rejected"]
    failure: StableFailure


ManualPdfReportResult: TypeAlias = Annotated[
    AcceptedManualPdfReportResult | RejectedManualPdfReportResult,
    Field(discriminator="kind"),
]


class ManualPdfReport(_ReportModel):
    kind: Literal["manual-pdf"]
    end: ReportEnd
    literature_id: LiteratureId
    result: ManualPdfReportResult | None = None

    @model_validator(mode="after")
    def validate_result_pairing(self) -> "ManualPdfReport":
        is_finished = self.end.kind == "finished"
        if is_finished != (self.result is not None):
            raise ValueError("finished manual PDF reports require exactly one result")
        return self


ImportAcceptanceOutcome: TypeAlias = Literal["created", "enriched", "matched"]


class AcceptedImportRecord(_ReportModel):
    kind: Literal["accepted"]
    record_index: int = Field(strict=True, ge=0)
    outcome: ImportAcceptanceOutcome
    meta_literature_id: MetaLiteratureId
    literature_id: LiteratureId


class RejectedImportRecord(_ReportModel):
    kind: Literal["rejected"]
    record_index: int = Field(strict=True, ge=0)
    failure: StableFailure


ImportRecordReport: TypeAlias = Annotated[
    AcceptedImportRecord | RejectedImportRecord,
    Field(discriminator="kind"),
]


class ImportReport(_ReportModel):
    kind: Literal["import"]
    end: ReportEnd
    format: BibliographyFormat
    input_record_count: int = Field(strict=True, ge=0)
    records: tuple[ImportRecordReport, ...]
    not_processed_record_indexes: tuple[int, ...]
    accepted_meta_literature_ids: tuple[MetaLiteratureId, ...]

    @field_validator("format", mode="before")
    @classmethod
    def normalize_format(cls, value: object) -> BibliographyFormat:
        return _normalize_bibliography_format(value)

    @field_validator("records", mode="before")
    @classmethod
    def normalize_records(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="records")

    @field_validator("not_processed_record_indexes", mode="before")
    @classmethod
    def normalize_not_processed_indexes(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="not_processed_record_indexes")

    @field_validator("accepted_meta_literature_ids", mode="before")
    @classmethod
    def normalize_accepted_ids(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="accepted_meta_literature_ids")

    @field_validator("not_processed_record_indexes")
    @classmethod
    def validate_not_processed_indexes(cls, value: tuple[int, ...]) -> tuple[int, ...]:
        if len(value) != len(set(value)):
            raise ValueError("not_processed_record_indexes must be unique")
        return value

    @field_validator("accepted_meta_literature_ids")
    @classmethod
    def validate_accepted_ids(
        cls,
        value: tuple[MetaLiteratureId, ...],
    ) -> tuple[MetaLiteratureId, ...]:
        return _deduplicate(value)

    @model_validator(mode="after")
    def validate_record_partition(self) -> "ImportReport":
        expected = set(range(self.input_record_count))
        record_indexes = tuple(record.record_index for record in self.records)
        if len(record_indexes) != len(set(record_indexes)):
            raise ValueError("records must have unique record indexes")
        if set(record_indexes).intersection(self.not_processed_record_indexes):
            raise ValueError("records and not_processed_record_indexes must be disjoint")
        if set(record_indexes) | set(self.not_processed_record_indexes) != expected:
            raise ValueError("records and not_processed_record_indexes must cover all records")

        accepted_ids = tuple(
            record.meta_literature_id
            for record in self.records
            if isinstance(record, AcceptedImportRecord)
        )
        if _deduplicate(accepted_ids) != self.accepted_meta_literature_ids:
            raise ValueError("accepted_meta_literature_ids must match accepted records")
        if self.end.kind == "finished" and self.not_processed_record_indexes:
            raise ValueError("finished import reports cannot leave records unprocessed")
        return self


class SkippedExportRecord(_ReportModel):
    literature_id: LiteratureId
    failure: StableFailure


class ExportFieldOmission(_ReportModel):
    literature_id: LiteratureId
    field: str
    reason: str

    @field_validator("field", mode="before")
    @classmethod
    def validate_field(cls, value: object) -> str:
        return _nonblank_text(value, field_name="field")

    @field_validator("reason", mode="before")
    @classmethod
    def validate_reason(cls, value: object) -> str:
        return _stable_text(value, field_name="omission reason")


class ExportReport(_ReportModel):
    kind: Literal["export"]
    end: ReportEnd
    format: BibliographyFormat
    selected_literature_ids: tuple[LiteratureId, ...]
    published_literature_ids: tuple[LiteratureId, ...]
    skipped: tuple[SkippedExportRecord, ...]
    not_published_literature_ids: tuple[LiteratureId, ...]
    omissions: tuple[ExportFieldOmission, ...]
    bytes_written: int | None

    @field_validator("format", mode="before")
    @classmethod
    def normalize_format(cls, value: object) -> BibliographyFormat:
        return _normalize_bibliography_format(value)

    @field_validator(
        "selected_literature_ids",
        "published_literature_ids",
        "skipped",
        "not_published_literature_ids",
        "omissions",
        mode="before",
    )
    @classmethod
    def normalize_collections(cls, value: object, info: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="export collection")

    @field_validator("selected_literature_ids", mode="after")
    @classmethod
    def deduplicate_selected_ids(
        cls,
        value: tuple[LiteratureId, ...],
    ) -> tuple[LiteratureId, ...]:
        return _deduplicate(value)

    @field_validator("published_literature_ids", "not_published_literature_ids")
    @classmethod
    def validate_unique_ids(cls, value: tuple[LiteratureId, ...]) -> tuple[LiteratureId, ...]:
        if len(value) != len(set(value)):
            raise ValueError("export literature IDs must be unique")
        return value

    @field_validator("skipped")
    @classmethod
    def validate_unique_skipped(
        cls,
        value: tuple[SkippedExportRecord, ...],
    ) -> tuple[SkippedExportRecord, ...]:
        ids = tuple(item.literature_id for item in value)
        if len(ids) != len(set(ids)):
            raise ValueError("skipped literature IDs must be unique")
        return value

    @field_validator("bytes_written")
    @classmethod
    def validate_bytes_written(cls, value: int | None) -> int | None:
        if value is not None and value < 0:
            raise ValueError("bytes_written must be non-negative")
        return value

    @model_validator(mode="after")
    def validate_publication_partition(self) -> "ExportReport":
        selected = set(self.selected_literature_ids)
        published = set(self.published_literature_ids)
        skipped = {item.literature_id for item in self.skipped}
        not_published = set(self.not_published_literature_ids)
        partitions = (published, skipped, not_published)
        if any(len(partition) != len(tuple(partition)) for partition in partitions):
            raise ValueError("export partitions must be unique")
        if any(not partition <= selected for partition in partitions):
            raise ValueError("export partitions must contain only selected literature")
        if any(
            left.intersection(right)
            for index, left in enumerate(partitions)
            for right in partitions[index + 1 :]
        ):
            raise ValueError("export partitions must be disjoint")
        if published | skipped | not_published != selected:
            raise ValueError("export partitions must cover all selected literature")

        if self.end.kind in {"interrupted", "failed"}:
            if self.published_literature_ids or self.bytes_written is not None:
                raise ValueError("interrupted or failed exports cannot report publication")
        elif self.bytes_written is None:
            raise ValueError("finished exports require bytes_written after atomic publication")

        if any(item.literature_id not in selected for item in self.omissions):
            raise ValueError("omissions must refer to selected literature")
        omission_keys = tuple((item.literature_id, item.field) for item in self.omissions)
        if len(omission_keys) != len(set(omission_keys)):
            raise ValueError("omissions must identify each field at most once")
        return self


EntryReport: TypeAlias = Annotated[
    DiscoveryReport | DatabaseCompletionReport | ManualPdfReport | ImportReport | ExportReport,
    Field(discriminator="kind"),
]


__all__ = (
    "AcceptedImportRecord",
    "AcceptedManualPdfReportResult",
    "BibliographyFormat",
    "CompletionTarget",
    "CompletionStage",
    "DatabaseCompletionReport",
    "DiscoveryProviderReport",
    "DiscoveryProviderReportOutcome",
    "DiscoveryReport",
    "EntryReport",
    "ExportFieldOmission",
    "ExportReport",
    "FailedCompletionTarget",
    "FailedReportEnd",
    "FinishedReportEnd",
    "GoalReachedTarget",
    "ImportAcceptanceOutcome",
    "ImportRecordReport",
    "ImportReport",
    "InterruptedCompletionTarget",
    "InterruptedReportEnd",
    "LiteratureCompletionTarget",
    "ManualPdfReport",
    "ManualPdfReportResult",
    "MetaLiteratureCompletionTarget",
    "NeedsManualPdfTarget",
    "NotStartedCompletionTarget",
    "RejectedImportRecord",
    "RejectedManualPdfReportResult",
    "ReportEnd",
    "SkippedExportRecord",
    "StableFailure",
)
