from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from sciretriever.model.execution import FailureEvidence, ImportOutcome, ImportResult
from sciretriever.model.literature import (
    Identifier,
    InitialMetadata,
    PreparedBibliographyAcceptance,
)
from sciretriever.model.primitives import WorkId, WorkVersionId


class _RecordModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class ImportedBibliographicRecord(_RecordModel):
    title: str
    authors: tuple[str, ...]
    identifiers: tuple[Identifier, ...]
    abstract: str | None
    keywords: tuple[str, ...]
    tags: tuple[str, ...]
    references: tuple[str, ...]
    institutions: tuple[str, ...] = ()
    year: int | None = None
    month: int | None = Field(default=None, ge=1, le=12)
    venue: str | None = None
    volume: str | None = None
    issue: str | None = None
    pages: str | None = None
    item_type: str | None = None
    language: str | None = None


class ImportPreparationRequest(_RecordModel):
    metadata: InitialMetadata
    identifiers: tuple[Identifier, ...]
    references: tuple[str, ...]
    tags: tuple[str, ...]


class ImportIdentityResolution(_RecordModel):
    work_id: WorkId
    work_version_id: WorkVersionId
    result: ImportOutcome
    completed: bool
    prepared: PreparedBibliographyAcceptance | None


class ImportPreparationOutcome(_RecordModel):
    ordinal: int = Field(strict=True, ge=0)
    result: ImportResult
    work_id: WorkId | None
    work_version_id: WorkVersionId | None
    prepared: PreparedBibliographyAcceptance | None
    references: tuple[str, ...]
    tags: tuple[str, ...]
    failure: FailureEvidence | None


class RecordParseResult(_RecordModel):
    ordinal: int = Field(ge=0)
    record: ImportedBibliographicRecord
    failure: FailureEvidence | None


class ExportOmission(_RecordModel):
    field: str
    reason: str


class ExportEncodingResult(_RecordModel):
    record_count: int = Field(ge=0)
    bytes_written: int = Field(ge=0)
    omissions: tuple[ExportOmission, ...]


__all__ = (
    "ExportEncodingResult",
    "ExportOmission",
    "ImportIdentityResolution",
    "ImportPreparationOutcome",
    "ImportPreparationRequest",
    "ImportedBibliographicRecord",
    "RecordParseResult",
)
