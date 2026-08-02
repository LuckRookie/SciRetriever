from __future__ import annotations

from sciretriever.core.literature.identity import resolve_identity
from sciretriever.core.literature.identity_acceptance import prepare_identity_acceptance
from sciretriever.model.literature import (
    BibliographicObservation,
    IdentityCandidateQuery,
    IdentityCandidateSet,
    PreparedBibliographyAcceptance,
    VersionFacts,
    WorkFacts,
)
from sciretriever.model.primitives import WorkId, WorkVersionId
from sciretriever.services.literature.ports import LiteratureRepository


def prepare_initial_ingest(
    repository: LiteratureRepository,
    observations: tuple[BibliographicObservation, ...],
) -> PreparedBibliographyAcceptance:
    records = repository.list_identity_records()
    resolution = resolve_identity(records, observations)
    candidate_observations = tuple(
        observation
        for record in resolution.compatible_records
        for observation in repository.list_observations(record.work_version_id)
    )
    existing_observations = (
        repository.list_observations(resolution.selected_record.work_version_id)
        if resolution.selected_record is not None
        else ()
    )
    return prepare_identity_acceptance(
        resolution,
        candidate_observations,
        existing_observations,
    )


class LiteratureService:
    def __init__(self, repository: LiteratureRepository) -> None:
        self._repository = repository

    def prepare_discovery(
        self,
        observation: BibliographicObservation,
    ) -> PreparedBibliographyAcceptance:
        return prepare_initial_ingest(self._repository, (observation,))

    def find_identity_candidates(self, query: IdentityCandidateQuery) -> IdentityCandidateSet:
        return self._repository.find_identity_candidates(query)

    def get_work_facts(self, work_id: WorkId) -> WorkFacts | None:
        return self._repository.get_work_facts(work_id)

    def get_version_facts(self, version_id: WorkVersionId) -> VersionFacts | None:
        return self._repository.get_version_facts(version_id)


__all__ = ("LiteratureService", "prepare_initial_ingest")
