"""Catalog ingestion collaborator for prepared discovery metadata."""

from __future__ import annotations

from sciretriever.catalog.library import (
    MetadataIngestionBatch,
    MetadataIngestionObservation,
    WorkRepository,
)
from .models import CandidateObservation, RetrievedCandidate
from .search_contracts import MetadataSearchResult


class MetadataIngestor:
    """Persist prepared metadata through the catalog-owned atomic APIs."""

    def __init__(self, repository: WorkRepository) -> None:
        self._repository = repository

    def ingest_candidates(
        self,
        candidates: tuple[RetrievedCandidate, ...],
        precedence: tuple[str, ...],
    ) -> tuple[MetadataSearchResult, ...]:
        projected = tuple(
            (
                candidate,
                MetadataIngestionBatch(
                    title,
                    candidate.identifiers,
                    tuple(self._observation(item) for item in candidate.observations),
                    precedence,
                    "; ".join(candidate.identity_ambiguity_reasons) or None,
                ),
            )
            for candidate in candidates
            if (title := candidate.metadata.title) is not None
        )
        versions = self._repository.ingest_metadata_batches(tuple(
            batch for _, batch in projected
        ))
        return tuple(
            MetadataSearchResult(
                version,
                candidate.providers,
                candidate.identifiers,
                self._repository.get_canonical_metadata(version.id),
            )
            for (candidate, _), version in zip(projected, versions)
        )

    @staticmethod
    def _observation(item: CandidateObservation) -> MetadataIngestionObservation:
        fields = (
            ("title", item.metadata.title),
            ("abstract", item.metadata.abstract),
            ("authors", item.metadata.authors),
            ("year", item.metadata.year),
            ("venue", item.metadata.venue),
            ("publisher", item.publisher),
            ("publication_date", item.publication_date),
            ("open_access_status", item.open_access_status),
            ("keywords", item.metadata.keywords),
        )
        present = tuple(
            (name, value) for name, value in fields
            if value is not None and value != ()
        )
        identifiers = tuple(
            (identifier.namespace, identifier.value) for identifier in item.identifiers
        )
        return MetadataIngestionObservation(
            item.provider,
            item.provider_record_id,
            tuple(sorted((*present, *identifiers), key=lambda pair: (pair[0], str(pair[1])))),
            (("provider", item.provider), ("provider_record_id", item.provider_record_id)),
        )


__all__ = ("MetadataIngestor",)
