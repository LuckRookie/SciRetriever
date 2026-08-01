from __future__ import annotations

from sciretriever.bibliography.api import (
    BibliographicObservation, BibliographyRepository, IdentityCandidateQuery,
    IdentityCandidateSet, PreparedBibliographyAcceptance, VersionFacts, WorkFacts,
    prepare_initial_ingest,
)
from sciretriever.kernel import WorkId, WorkVersionId


class InitialBibliographyIngestion:
    def __init__(self, repository: BibliographyRepository) -> None:
        self._repository = repository

    def prepare_discovery(
        self, observation: BibliographicObservation,
    ) -> PreparedBibliographyAcceptance:
        return prepare_initial_ingest(self._repository, (observation,))

    def find_identity_candidates(self, query: IdentityCandidateQuery) -> IdentityCandidateSet:
        return self._repository.find_identity_candidates(query)

    def get_work_facts(self, work_id: WorkId) -> WorkFacts | None:
        return self._repository.get_work_facts(work_id)

    def get_version_facts(self, version_id: WorkVersionId) -> VersionFacts | None:
        return self._repository.get_version_facts(version_id)


__all__ = ("InitialBibliographyIngestion",)
