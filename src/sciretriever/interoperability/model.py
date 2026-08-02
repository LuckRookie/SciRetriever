from __future__ import annotations

from dataclasses import dataclass

from sciretriever.kernel.errors import FailureEvidence
from sciretriever.model.literature import Identifier


@dataclass(frozen=True, slots=True)
class ImportedBibliographicRecord:
    title: str
    authors: tuple[str, ...]
    identifiers: tuple[Identifier, ...]
    abstract: str | None
    keywords: tuple[str, ...]
    tags: tuple[str, ...]
    references: tuple[str, ...]
    institutions: tuple[str, ...] = ()
    year: int | None = None
    month: int | None = None
    venue: str | None = None
    volume: str | None = None
    issue: str | None = None
    pages: str | None = None
    item_type: str | None = None
    language: str | None = None


@dataclass(frozen=True, slots=True)
class RecordParseResult:
    ordinal: int
    record: ImportedBibliographicRecord
    failure: FailureEvidence | None


@dataclass(frozen=True, slots=True)
class ExportOmission:
    field: str
    reason: str


@dataclass(frozen=True, slots=True)
class ExportEncodingResult:
    record_count: int
    bytes_written: int
    omissions: tuple[ExportOmission, ...]


__all__ = (
    "ExportEncodingResult",
    "ExportOmission",
    "ImportedBibliographicRecord",
    "RecordParseResult",
)
