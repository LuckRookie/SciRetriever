from __future__ import annotations

from dataclasses import dataclass
from enum import Enum, unique

from sciretriever.kernel import BatchRunId, BoundaryError, CanonicalJsonObject, WorkVersionId


@unique
class ImportResult(str, Enum):
    CREATED = "created"
    ENRICHED = "enriched"
    DUPLICATE = "duplicate"
    REJECTED = "rejected"


@dataclass(frozen=True, slots=True)
class ImportResultEnvelope:
    result: ImportResult
    details: CanonicalJsonObject

    def __post_init__(self) -> None:
        if any(key == "result" for key, _value in self.details.entries):
            raise BoundaryError.for_field("details", "must not contain a result discriminator")

    def canonical(self) -> CanonicalJsonObject:
        return CanonicalJsonObject((("result", self.result.value), ("details", self.details)))


@dataclass(frozen=True, slots=True)
class ImportRecordProjection:
    batch_run_id: BatchRunId
    work_version_id: WorkVersionId
    input_ordinal: int
    result: ImportResult
    details: CanonicalJsonObject

    def __post_init__(self) -> None:
        ImportResultEnvelope(self.result, self.details)

    def result_envelope(self) -> ImportResultEnvelope:
        return ImportResultEnvelope(self.result, self.details)


__all__ = ("ImportRecordProjection", "ImportResult", "ImportResultEnvelope")
