from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from sciretriever.bibliography.api import InitialMetadata, PreparedBibliographyAcceptance
from sciretriever.interoperability.model import ImportedBibliographicRecord, RecordParseResult
from sciretriever.interoperability.publisher_contracts import ImportResult
from sciretriever.kernel import FailureEvidence, Identifier, WorkId, WorkVersionId


@dataclass(frozen=True, slots=True)
class ImportPreparationRequest:
    metadata: InitialMetadata
    identifiers: tuple[Identifier, ...]
    references: tuple[str, ...]
    tags: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ImportIdentityResolution:
    work_id: WorkId
    work_version_id: WorkVersionId
    result: ImportResult
    completed: bool
    prepared: PreparedBibliographyAcceptance | None


class ImportIdentityService(Protocol):
    def prepare_import(self, request: ImportPreparationRequest) -> ImportIdentityResolution: ...


@dataclass(frozen=True, slots=True)
class ImportPreparationOutcome:
    ordinal: int
    result: ImportResult
    work_id: WorkId | None
    work_version_id: WorkVersionId | None
    prepared: PreparedBibliographyAcceptance | None
    references: tuple[str, ...]
    tags: tuple[str, ...]
    failure: FailureEvidence | None


def _request(record: ImportedBibliographicRecord) -> ImportPreparationRequest:
    return ImportPreparationRequest(
        InitialMetadata(
            record.title, record.authors, record.year, record.item_type, record.abstract,
            record.venue, record.language, record.keywords,
        ),
        record.identifiers, record.references, record.tags,
    )


def prepare_import_record(
    identity: ImportIdentityService, parsed: RecordParseResult,
) -> ImportPreparationOutcome:
    if parsed.failure is not None:
        return ImportPreparationOutcome(
            parsed.ordinal, ImportResult.REJECTED, None, None, None, (), (), parsed.failure,
        )
    resolution = identity.prepare_import(_request(parsed.record))
    if resolution.completed:
        return ImportPreparationOutcome(
            parsed.ordinal, ImportResult.DUPLICATE, resolution.work_id,
            resolution.work_version_id, None, (), (), None,
        )
    return ImportPreparationOutcome(
        parsed.ordinal, resolution.result, resolution.work_id, resolution.work_version_id,
        resolution.prepared, parsed.record.references, parsed.record.tags, None,
    )


__all__ = (
    "ImportIdentityResolution", "ImportIdentityService", "ImportPreparationOutcome",
    "ImportPreparationRequest", "prepare_import_record",
)
