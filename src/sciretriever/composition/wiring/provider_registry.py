from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

from sciretriever.composition.configuration.validation import validate_configuration
from sciretriever.infrastructure.sources.assets import (
    AssetFetcherAdapter,
    AssetResolverAdapter,
    BoundedTransportPort,
    ResolverClient,
)
from sciretriever.infrastructure.sources.citations import (
    CitationClient,
    CitationProviderAdapter,
)
from sciretriever.infrastructure.sources.metadata import (
    MetadataClient,
    MetadataProviderAdapter,
)
from sciretriever.infrastructure.sources.registry import ProviderRegistry
from sciretriever.model.configuration import TargetConfig

METADATA_PROVIDERS: Final = (
    "crossref",
    "europe-pmc",
    "arxiv",
    "openalex",
    "semantic-scholar",
    "elsevier",
    "springer",
)
CITATION_PROVIDERS: Final = ("openalex", "semantic-scholar")
ACQUISITION_PROVIDERS: Final = (
    "direct",
    "arxiv",
    "crossref",
    "unpaywall",
    "europe-pmc",
    "openalex",
    "semantic-scholar",
    "elsevier",
    "wiley",
    "springer",
)


@dataclass(frozen=True, slots=True)
class ProviderRuntimeConfig:
    sci_hub_enabled: bool
    timeout_seconds: float
    max_asset_bytes: int


@dataclass(frozen=True, slots=True)
class ProviderSelection:
    metadata: tuple[str, ...]
    citations: tuple[str, ...]
    assets: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ProviderDependencies:
    metadata_clients: Mapping[str, MetadataClient]
    citation_clients: Mapping[str, CitationClient]
    resolver_clients: Mapping[str, ResolverClient]
    transport: BoundedTransportPort


@dataclass(frozen=True, slots=True)
class CapabilityConstructionError(OSError):
    provider: str
    capability: str

    def __str__(self) -> str:
        return f"{self.provider} {self.capability} capability is unavailable"


def build_provider_registry(
    config: ProviderRuntimeConfig,
    dependencies: ProviderDependencies,
) -> ProviderRegistry:
    """Build lazy source factories without constructing external clients."""
    selection = ProviderSelection(
        metadata=METADATA_PROVIDERS,
        citations=CITATION_PROVIDERS,
        assets=ACQUISITION_PROVIDERS + (("sci-hub",) if config.sci_hub_enabled else ()),
    )
    return _build_provider_registry(config, dependencies, selection)


def _build_provider_registry(
    config: ProviderRuntimeConfig,
    dependencies: ProviderDependencies,
    selection: ProviderSelection,
) -> ProviderRegistry:
    registry = ProviderRegistry()
    for provider in selection.metadata:
        registry.register_metadata(
            provider,
            lambda provider=provider: _metadata_factory(provider, dependencies),
        )
    for provider in selection.citations:
        registry.register_citation(
            provider,
            lambda provider=provider: _citation_factory(provider, dependencies),
        )
    for provider in selection.assets:
        registry.register_asset_resolver(
            provider,
            lambda provider=provider: _resolver_factory(provider, dependencies),
        )
        registry.register_asset_fetcher(
            provider,
            lambda: AssetFetcherAdapter(
                dependencies.transport,
                timeout_seconds=config.timeout_seconds,
                max_response_bytes=config.max_asset_bytes,
            ),
        )
    return registry


def build_provider_registry_from_configuration(
    config: TargetConfig,
    dependencies: ProviderDependencies,
) -> ProviderRegistry:
    """Adapt target asset settings to the existing provider registry contract."""
    validated = validate_configuration(config)
    runtime = ProviderRuntimeConfig(
        sci_hub_enabled="sci-hub" in validated.assets.providers,
        timeout_seconds=validated.assets.timeout_seconds,
        max_asset_bytes=validated.assets.max_asset_bytes,
    )
    selection = ProviderSelection(
        metadata=validated.sources.providers,
        citations=validated.collection.citation_providers,
        assets=validated.assets.providers,
    )
    return _build_provider_registry(runtime, dependencies, selection)


def _metadata_factory(
    provider: str,
    dependencies: ProviderDependencies,
) -> MetadataProviderAdapter:
    try:
        client = dependencies.metadata_clients[provider]
    except KeyError:
        raise CapabilityConstructionError(provider, "metadata") from None
    return MetadataProviderAdapter(provider, client)


def _citation_factory(
    provider: str,
    dependencies: ProviderDependencies,
) -> CitationProviderAdapter:
    try:
        client = dependencies.citation_clients[provider]
    except KeyError:
        raise CapabilityConstructionError(provider, "citation") from None
    return CitationProviderAdapter(provider, client)


def _resolver_factory(
    provider: str,
    dependencies: ProviderDependencies,
) -> AssetResolverAdapter:
    try:
        client = dependencies.resolver_clients[provider]
    except KeyError:
        raise CapabilityConstructionError(provider, "asset-resolver") from None
    return AssetResolverAdapter(provider, client)


__all__ = (
    "ACQUISITION_PROVIDERS",
    "CITATION_PROVIDERS",
    "METADATA_PROVIDERS",
    "CapabilityConstructionError",
    "ProviderDependencies",
    "ProviderRuntimeConfig",
    "build_provider_registry",
    "build_provider_registry_from_configuration",
)
