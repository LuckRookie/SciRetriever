from typing import Protocol

from sciretriever.bibliography.model import (
    ValidatedCurationPlan,
    ValidatedVersionRelation,
)
from sciretriever.model.library import (
    CurationCommit,
    CurationScope,
    CurationSnapshot,
    CurationTopology,
)
from sciretriever.model.literature import (
    IdentityCandidateQuery,
    IdentityCandidateSet,
    IdentityRecord,
    StoredObservation,
    VersionFacts,
    WorkFacts,
)
from sciretriever.model.primitives import WorkId, WorkVersionId


class BibliographyRepository(Protocol):
    def find_identity_candidates(self, query: IdentityCandidateQuery) -> IdentityCandidateSet: ...
    def get_work_facts(self, work_id: WorkId) -> WorkFacts | None: ...
    def get_version_facts(self, version_id: WorkVersionId) -> VersionFacts | None: ...
    def load_curation_snapshot(self, scope: CurationScope) -> CurationSnapshot: ...
    def load_curation_topology(self) -> CurationTopology: ...
    def add_version_relation(self, relation: ValidatedVersionRelation) -> None: ...
    def list_identity_records(self) -> tuple[IdentityRecord, ...]: ...
    def list_observations(self, version_id: WorkVersionId) -> tuple[StoredObservation, ...]: ...


class CurationTransactionPort(Protocol):
    def apply(self, validated_plan: ValidatedCurationPlan) -> CurationCommit: ...


__all__ = ("BibliographyRepository", "CurationTransactionPort")
