from __future__ import annotations

from types import TracebackType
from typing import Protocol, TypeVar

from sciretriever.model.library import (
    CurationCommit,
    CurationTopology,
    ValidatedCurationPlan,
)
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

    def load_curation_topology(self) -> CurationTopology: ...

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


class CurationTransactionPort(Protocol):
    def apply(self, validated_plan: ValidatedCurationPlan) -> CurationCommit: ...


class CoreWriteGuard(Protocol):
    def __enter__(self) -> CoreWriteGuard: ...

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None: ...


class CoreWriteAcquirer(Protocol):
    def __call__(self) -> CoreWriteGuard: ...


class GuardedArtifactReconciler(Protocol):
    def reconcile_guarded(self) -> None: ...


__all__ = (
    "CompletionFactsRepository",
    "CompletionPublisher",
    "CoreWriteAcquirer",
    "CoreWriteGuard",
    "CurationTransactionPort",
    "GuardedArtifactReconciler",
    "LiteratureRepository",
)
