from __future__ import annotations

from dataclasses import dataclass
from enum import Enum, unique
from typing import Protocol

from sciretriever.bibliography.api import PreparedBibliographyAcceptance, ReferenceSetFact, TagSetFact
from sciretriever.collection.api import CollectionAcceptance
from sciretriever.content.api import ContentAcceptance
from sciretriever.interoperability.ports import ImportRecordProjection
from sciretriever.kernel import BatchRunId, BoundaryError, CanonicalJsonObject, WorkVersionId


@unique
class FailureStage(str, Enum):
    ACQUISITION = "acquisition"
    PARSING = "parsing"
    ANALYSIS = "analysis"
    FEEDBACK = "feedback"


@unique
class TargetResult(str, Enum):
    COMPLETED = "completed"
    PARTIALLY_ADVANCED = "partially-advanced"
    MISSING = "missing"
    FAILED = "failed"
    NOT_STARTED = "not-started"
    SKIPPED = "skipped"


@dataclass(frozen=True, slots=True)
class TargetResultEnvelope:
    result: TargetResult
    details: CanonicalJsonObject

    def __post_init__(self) -> None:
        if any(key == "result" for key, _value in self.details.entries):
            raise BoundaryError.for_field("details", "must not contain a result discriminator")

    def canonical(self) -> CanonicalJsonObject:
        return CanonicalJsonObject((("result", self.result.value), ("details", self.details)))


@dataclass(frozen=True, slots=True)
class TargetProjection:
    batch_run_id: BatchRunId
    work_version_id: WorkVersionId
    result: TargetResult
    details: CanonicalJsonObject
    failure_stages_to_clear: tuple[FailureStage, ...]

    def __post_init__(self) -> None:
        TargetResultEnvelope(self.result, self.details)

    def result_envelope(self) -> TargetResultEnvelope:
        return TargetResultEnvelope(self.result, self.details)

    def canonical(self) -> CanonicalJsonObject:
        return CanonicalJsonObject((
            ("batch_run_id", str(self.batch_run_id)),
            ("work_version_id", str(self.work_version_id)),
            ("result", self.result.value),
            ("details", self.details),
            ("failure_stages_to_clear", tuple(
                stage.value for stage in self.failure_stages_to_clear
            )),
        ))


@dataclass(frozen=True, slots=True)
class ImportAcceptanceCommand:
    bibliography: PreparedBibliographyAcceptance
    references: ReferenceSetFact
    tags: TagSetFact
    record: ImportRecordProjection

    def __post_init__(self) -> None:
        expected = self.bibliography.work_version_id
        if any(value != expected for value in (
            self.references.work_version_id, self.tags.work_version_id,
            self.record.work_version_id,
        )):
            raise BoundaryError.for_field("import", "facts and result must share one WorkVersion")


@dataclass(frozen=True, slots=True)
class ContentAcceptanceCommand:
    acceptance: ContentAcceptance
    target: TargetProjection

    def __post_init__(self) -> None:
        if self.acceptance.work_version_id != self.target.work_version_id:
            raise BoundaryError.for_field("content", "acceptance and target must share one WorkVersion")


class CollectionAcceptancePublisher(Protocol):
    def publish(self, command: CollectionAcceptance) -> None: ...


class ImportAcceptancePublisher(Protocol):
    def publish(self, command: ImportAcceptanceCommand) -> None: ...


class ContentAcceptancePublisher(Protocol):
    def publish(self, command: ContentAcceptanceCommand) -> None: ...


__all__ = (
    "CollectionAcceptancePublisher", "ContentAcceptanceCommand", "ContentAcceptancePublisher",
    "FailureStage", "ImportAcceptanceCommand", "ImportAcceptancePublisher",
    "TargetProjection", "TargetResult", "TargetResultEnvelope",
)
