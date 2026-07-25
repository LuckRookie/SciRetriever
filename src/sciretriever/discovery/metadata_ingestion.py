"""Catalog ingestion collaborator for prepared discovery metadata."""

from __future__ import annotations

from sciretriever.catalog.library import WorkRepository
from sciretriever.catalog.records import WorkVersionRecord
from .metadata_preparation import PreparedMetadata
from .search_contracts import MetadataSearchResult


class MetadataIngestor:
    """Persist prepared metadata through the catalog-owned atomic APIs."""

    def __init__(self, repository: WorkRepository) -> None:
        self._repository = repository

    def ingest_many(
        self, prepared: tuple[PreparedMetadata, ...]
    ) -> tuple[MetadataSearchResult, ...]:
        versions = self._repository.ingest_metadata_batches(
            tuple(item.batch for item in prepared)
        )
        return tuple(
            self._result(item, version)
            for item, version in zip(prepared, versions)
        )

    def ingest_one(self, prepared: PreparedMetadata) -> MetadataSearchResult:
        batch = prepared.batch
        version = self._repository.ingest_metadata_batch(
            title=batch.title,
            identifiers_to_persist=batch.identifiers,
            observations=batch.observations,
            provider_precedence=batch.provider_precedence,
            review_reason=batch.review_reason,
        )
        return self._result(prepared, version)

    def _result(
        self, prepared: PreparedMetadata, version: WorkVersionRecord
    ) -> MetadataSearchResult:
        return MetadataSearchResult(
            version,
            prepared.providers,
            prepared.identifiers,
            self._repository.get_canonical_metadata(version.id),
        )


__all__ = ("MetadataIngestor",)
