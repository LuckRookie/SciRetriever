"""Catalog-writing metadata search and exact DOI resolution services."""

from __future__ import annotations

from typing import Mapping

from sciretriever.catalog.diagnostics import CatalogDiagnosticService
from sciretriever.catalog.library import WorkRepository
from sciretriever.diagnostics.owners import MetadataFailureOwner
from .metadata_ingestion import MetadataIngestor
from .metadata_preparation import MetadataRecordPreparer
from .normalize import normalize_query
from .provider_collection import (
    ProviderCollectionRequest,
    ProviderCollector,
)
from .providers.base import DiscoveryProvider
from .search_contracts import (
    DEFAULT_MAX_CONCURRENCY,
    DEFAULT_PROVIDER_TIMEOUT_SECONDS,
    DEFAULT_SEARCH_LIMIT,
    ExactMetadataOutput,
    ExactMetadataRequest,
    MetadataSearchFailure,
    MetadataSearchOutput,
    MetadataSearchRequest,
    MetadataSearchResult,
)
from sciretriever.errors import SearchError


class MetadataSearchService:
    def __init__(
        self,
        providers: Mapping[str, DiscoveryProvider],
        repository: WorkRepository,
    ) -> None:
        self._collector = ProviderCollector(providers)
        self._preparer = MetadataRecordPreparer()
        self._ingestor = MetadataIngestor(repository)
        self._failures = MetadataFailureOwner(CatalogDiagnosticService(repository.catalog))

    def search(self, request: MetadataSearchRequest) -> MetadataSearchOutput:
        collected = self._collector.collect(ProviderCollectionRequest(
            request.query,
            request.providers,
            request.limit,
            request.provider_timeout_seconds,
            request.max_concurrency,
        ))
        if len(collected.failures) == len(request.providers):
            self._failures.provider_total_failure(
                normalize_query(request.query),
                tuple(failure.provider for failure in collected.failures),
                {"categories": tuple(failure.category for failure in collected.failures)},
            )
            detail = "; ".join(
                f"{failure.provider}:{failure.category}"
                for failure in collected.failures
            )
            raise SearchError(f"all metadata search providers failed: {detail}")
        prepared = self._preparer.prepare_search(
            collected.records,
            request.precedence,
            request.limit,
        )
        return MetadataSearchOutput(
            self._ingestor.ingest_many(prepared),
            collected.failures,
        )


class ExactMetadataResolver:
    """Resolve and atomically ingest metadata carrying one exact DOI."""

    def __init__(
        self,
        providers: Mapping[str, DiscoveryProvider],
        repository: WorkRepository,
    ) -> None:
        self._collector = ProviderCollector(providers)
        self._preparer = MetadataRecordPreparer()
        self._ingestor = MetadataIngestor(repository)
        self._failures = MetadataFailureOwner(CatalogDiagnosticService(repository.catalog))

    def resolve(self, request: ExactMetadataRequest) -> ExactMetadataOutput:
        collected = self._collector.collect(ProviderCollectionRequest(
            request.doi,
            request.providers,
            DEFAULT_SEARCH_LIMIT,
            request.provider_timeout_seconds,
            request.max_concurrency,
        ))
        prepared = self._preparer.prepare_exact(
            collected.records,
            request.doi,
            request.precedence,
        )
        result = None if prepared is None else self._ingestor.ingest_one(prepared)
        if len(collected.failures) == len(request.providers):
            self._failures.provider_total_failure(
                normalize_query(request.doi),
                tuple(failure.provider for failure in collected.failures),
                {"categories": tuple(failure.category for failure in collected.failures)},
            )
        return ExactMetadataOutput(request.doi, result, collected.failures)


__all__ = (
    "DEFAULT_MAX_CONCURRENCY",
    "DEFAULT_PROVIDER_TIMEOUT_SECONDS",
    "DEFAULT_SEARCH_LIMIT",
    "ExactMetadataOutput",
    "ExactMetadataRequest",
    "ExactMetadataResolver",
    "MetadataSearchFailure",
    "MetadataSearchOutput",
    "MetadataSearchRequest",
    "MetadataSearchResult",
    "MetadataSearchService",
)
