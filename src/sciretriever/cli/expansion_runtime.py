from __future__ import annotations

import argparse
from dataclasses import dataclass

import anyio

from sciretriever.acquisition.pacing import DocumentStartGate
from sciretriever.catalog import LibraryFilters
from sciretriever.catalog.analysis_selection import WorkVersionAnalysisRepository
from sciretriever.catalog.diagnostics import CatalogDiagnosticService
from sciretriever.cli.acquisition_runtime import (
    DEFAULT_ACQUISITION_PROVIDERS,
    AcquisitionCliConfig,
)
from sciretriever.cli.analysis_runtime import AnalysisCliRuntime
from sciretriever.cli.metadata_runtime import DEFAULT_METADATA_PROVIDERS, MetadataCliConfig
from sciretriever.cli.search_completion_runtime import (
    SearchCliRuntime,
    SearchCompletionRuntime,
    build_search_completion_runtime,
)
from sciretriever.config import SciRetrieverConfig, get_credential
from sciretriever.errors import ConfigError
from sciretriever.expansion import (
    CatalogFrontier,
    ExpansionCompletionServices,
    ExpansionEngine,
    ExpansionPolicy,
    ExpansionResult,
    ExpansionSeed,
    ExpansionServices,
    GraphDiscoveryResult,
    PipelineLayerCompletion,
)
from sciretriever.integrations.graph import ExpansionDepth, GraphDirection, GraphQuery
from sciretriever.integrations.graph_adapters import (
    GraphCapabilityRegistry,
    graph_capability_registry,
    query_graph_providers,
)
from sciretriever.integrations.openalex import OpenAlexClient
from sciretriever.integrations.semantic_scholar import SemanticScholarClient
from sciretriever.network import DEFAULT_MAX_RESPONSE_BYTES, SecureHttpsTransport
from sciretriever.references import ReferenceResolutionPolicy, ReferenceResolutionService


@dataclass(frozen=True, slots=True)
class ProviderGraphDiscovery:
    registry: GraphCapabilityRegistry
    providers: tuple[str, ...]

    async def discover(self, query: GraphQuery) -> GraphDiscoveryResult:
        batch = await query_graph_providers(
            tuple(self.registry[name] for name in self.providers), query
        )
        edges = tuple(
            edge
            for result in batch.results
            for page in result.pages
            for edge in page.edges
        )
        provider_returned = sum(
            page.provider_returned for result in batch.results for page in result.pages
        )
        return GraphDiscoveryResult(
            edges,
            tuple(failure.provider for failure in batch.failures),
            provider_returned,
        )


@dataclass(frozen=True, slots=True)
class ExpandRuntime:
    completion: SearchCompletionRuntime
    engine: ExpansionEngine

    def execute(self, args: argparse.Namespace) -> ExpansionResult:
        seed = _select_seed(self.completion, args)
        policy = ExpansionPolicy(
            GraphDirection(args.direction),
            ExpansionDepth(args.depth),
            args.max_provider_calls,
            args.provider_page_size,
        )
        return anyio.run(self.engine.expand, ExpansionSeed(seed), policy)

    def close(self) -> None:
        self.completion.close()


def _select_seed(runtime: SearchCompletionRuntime, args: argparse.Namespace) -> str:
    repository = WorkVersionAnalysisRepository(runtime.catalog)
    if args.work_version_id is not None or args.work_id is not None:
        selected = repository.select_exact(
            work_version_id=args.work_version_id, work_id=args.work_id, force=True
        ).work_version_ids
    else:
        selected = repository.select_library(
            args.query,
            filters=LibraryFilters(),
            limit=2,
            force=True,
        ).work_version_ids
    if len(selected) != 1:
        raise ConfigError("expansion seed selector must resolve exactly one WorkVersion")
    return selected[0]


def _acquisition(config: SciRetrieverConfig) -> AcquisitionCliConfig:
    values = config.acquisition
    return AcquisitionCliConfig(
        values.providers or DEFAULT_ACQUISITION_PROVIDERS,
        values.provider_concurrency or 4,
        values.host_concurrency or 2,
        values.host_min_interval or 0.0,
        values.max_asset_bytes or DEFAULT_MAX_RESPONSE_BYTES,
        values.forbidden_urls,
        config.credentials,
        values.sci_hub,
        values.translator,
        values.browser,
        config.document_start_interval_seconds,
    )


def _metadata(config: SciRetrieverConfig) -> MetadataCliConfig:
    values = config.search
    providers = values.providers or DEFAULT_METADATA_PROVIDERS
    precedence = values.precedence or providers
    return MetadataCliConfig(
        "expansion",
        providers,
        precedence,
        values.limit or 100,
        values.provider_timeout or 30.0,
        values.max_concurrency or 8,
        values.crossref_mailto,
        config.credentials,
    )


def _graph_registry(config: SciRetrieverConfig) -> GraphCapabilityRegistry:
    transport = SecureHttpsTransport(max_bytes=DEFAULT_MAX_RESPONSE_BYTES)
    timeout = config.search.provider_timeout
    semantic_key = get_credential("SCIRETRIEVER_SEMANTIC_SCHOLAR_API_KEY")
    if semantic_key is None:
        semantic_key = config.credentials.semantic_scholar_api_key
    return graph_capability_registry(
        OpenAlexClient(transport, timeout=timeout),
        SemanticScholarClient(transport, api_key=semantic_key, timeout=timeout),
    )


def build_expand_runtime(args: argparse.Namespace) -> ExpandRuntime:
    config: SciRetrieverConfig | None = getattr(args, "_loaded_config", None)
    if config is None and args.depth > 0:
        raise ConfigError("expand requires runtime configuration")
    if config is None:
        config = SciRetrieverConfig(schema_version=1)
    fact_only = args.depth == 0
    completion = build_search_completion_runtime(SearchCliRuntime(
        args.catalog,
        "metadata" if fact_only else "analyze",
        _metadata(config),
        None if fact_only else args.storage_root,
        None if fact_only else _acquisition(config),
        config.acquisition.timeout or 30.0,
        None if fact_only else AnalysisCliRuntime(config.analysis),
        True,
    ))
    try:
        resolver = ReferenceResolutionService(
            completion.catalog,
            completion.exact_metadata,
            ReferenceResolutionPolicy(
                completion.metadata_config.providers,
                completion.metadata_config.precedence,
                completion.metadata_config.provider_timeout,
                completion.metadata_config.max_concurrency,
            ),
        )
        services = ExpansionServices(
            CatalogFrontier(completion.catalog),
            PipelineLayerCompletion(ExpansionCompletionServices(
                completion.completion.pipeline,
                DocumentStartGate(config.document_start_interval_seconds),
                CatalogDiagnosticService(completion.catalog),
            )),
            resolver,
            ProviderGraphDiscovery(_graph_registry(config), tuple(args.graph_provider)),
        )
        return ExpandRuntime(completion, ExpansionEngine(services))
    except (OSError, TypeError, ValueError):
        completion.close()
        raise


__all__ = ("ExpandRuntime", "ProviderGraphDiscovery", "build_expand_runtime")
