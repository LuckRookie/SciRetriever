from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

from sciretriever.adapters.assets import (
    AssetFetcherAdapter,
    AssetResolverAdapter,
    ResolverClient,
)
from sciretriever.adapters.providers import (
    CitationClient,
    CitationProviderAdapter,
    MetadataClient,
    MetadataProviderAdapter,
)
from sciretriever.adapters.registry import ProviderRegistry
from sciretriever.content.ports import BoundedTransportPort

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
    timeout_seconds: int
    max_asset_bytes: int


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


def build_provider_registry(
    config: ProviderRuntimeConfig,
    dependencies: ProviderDependencies,
) -> ProviderRegistry:
    registry = ProviderRegistry()
    for provider in METADATA_PROVIDERS:
        registry.register_metadata(
            provider,
            lambda provider=provider: _metadata_factory(provider, dependencies),
        )
    for provider in CITATION_PROVIDERS:
        registry.register_citation(
            provider,
            lambda provider=provider: _citation_factory(provider, dependencies),
        )
    acquisition = ACQUISITION_PROVIDERS + (("sci-hub",) if config.sci_hub_enabled else ())
    for provider in acquisition:
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


__all__ = (
    "ACQUISITION_PROVIDERS",
    "CITATION_PROVIDERS",
    "METADATA_PROVIDERS",
    "CapabilityConstructionError",
    "ProviderDependencies",
    "ProviderRuntimeConfig",
    "build_provider_registry",
)
