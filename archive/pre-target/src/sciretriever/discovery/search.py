"""Catalog-writing metadata search and exact DOI resolution services."""

from __future__ import annotations

from typing import Mapping

from sciretriever.catalog.diagnostics import CatalogDiagnosticService
from sciretriever.catalog.library import WorkRepository
from sciretriever.core.contracts import SearchSpec
from sciretriever.diagnostics.owners import MetadataFailureOwner
from .candidate_retrieval import CandidatePreparer
from .metadata_ingestion import MetadataIngestor
from .normalize import normalize_query
from .provider_collection import (
    ProviderCollectionRequest,
    ProviderCollector,
)
from .providers.base import DiscoveryProvider
from .models import CandidateRetrievalRequest, ProviderFailure
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
        self._candidate_preparer = CandidatePreparer()
        self._ingestor = MetadataIngestor(repository)
        self._failures = MetadataFailureOwner(CatalogDiagnosticService(repository.catalog))

    def search(self, request: MetadataSearchRequest) -> MetadataSearchOutput:
        collected = self._collector.collect(ProviderCollectionRequest(
            request.query,
            request.providers,
            request.limit,
            request.provider_timeout_seconds,
            request.max_concurrency,
            filters=request.filters,
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
        retrieved = self._candidate_preparer.prepare(
            CandidateRetrievalRequest(
                SearchSpec(
                    request.query,
                    request.providers,
                    request.limit,
                    request.filters,
                ),
                request.precedence,
                request.provider_timeout_seconds,
                request.max_concurrency,
            ),
            collected.records,
            tuple(
                ProviderFailure(failure.provider, failure.category, failure.message)
                for failure in collected.failures
            ),
            all_providers_failed=collected.all_failed,
        )
        return MetadataSearchOutput(
            self._ingestor.ingest_candidates(retrieved.candidates, request.precedence),
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
        self._candidate_preparer = CandidatePreparer()
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
        candidate = self._candidate_preparer.prepare_exact(
            collected.records,
            request.doi,
            request.precedence,
        )
        result = None
        if candidate is not None:
            result = self._ingestor.ingest_candidates(
                (candidate,), request.precedence
            )[0]
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
