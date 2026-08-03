from __future__ import annotations

from typing import Protocol, TypeVar

from sciretriever.model.literature import (
    CompletionSubmission,
    IdentityCandidateQuery,
    IdentityCandidateSet,
    IdentityRecord,
    StoredObservation,
    VersionFacts,
    WorkFacts,
)
from sciretriever.model.primitives import WorkId, WorkVersionId


class LiteratureRepository(Protocol):
    def find_identity_candidates(self, query: IdentityCandidateQuery) -> IdentityCandidateSet: ...

    def get_work_facts(self, work_id: WorkId) -> WorkFacts | None: ...

    def get_version_facts(self, version_id: WorkVersionId) -> VersionFacts | None: ...

    def list_identity_records(self) -> tuple[IdentityRecord, ...]: ...

    def list_observations(self, version_id: WorkVersionId) -> tuple[StoredObservation, ...]: ...


class CompletionFactsRepository(Protocol):
    def get_work_facts(self, work_id: WorkId) -> WorkFacts | None: ...

    def get_version_facts(self, version_id: WorkVersionId) -> VersionFacts | None: ...


ProjectionT = TypeVar("ProjectionT", contravariant=True)
ResultT = TypeVar("ResultT", covariant=True)


class CompletionPublisher(Protocol[ProjectionT, ResultT]):
    def publish_completion(
        self, validated_submission: CompletionSubmission, target_projection: ProjectionT
    ) -> ResultT: ...


__all__ = (
    "CompletionFactsRepository",
    "CompletionPublisher",
    "LiteratureRepository",
)
