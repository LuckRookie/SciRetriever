from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from typing import TypeAlias, TypeVar, assert_never

from sciretriever.content.ports import AssetFetcherPort, AssetResolverPort
from sciretriever.services.collection.ports import CitationDiscoveryPort, MetadataDiscoveryPort


class Capability(str, Enum):
    METADATA = "metadata"
    CITATION = "citation"
    ASSET_RESOLVER = "asset-resolver"
    ASSET_FETCHER = "asset-fetcher"


MetadataFactory: TypeAlias = Callable[[], MetadataDiscoveryPort]
CitationFactory: TypeAlias = Callable[[], CitationDiscoveryPort]
ResolverFactory: TypeAlias = Callable[[], AssetResolverPort]
FetcherFactory: TypeAlias = Callable[[], AssetFetcherPort]
FactoryT = TypeVar("FactoryT")


@dataclass(frozen=True, slots=True)
class UnsupportedCapability(Exception):
    provider: str
    capability: Capability

    def __str__(self) -> str:
        return f"provider {self.provider!r} does not support {self.capability.value}"


@dataclass(frozen=True, slots=True)
class DuplicateProviderCapability(Exception):
    provider: str
    capability: Capability

    def __str__(self) -> str:
        return f"provider {self.provider!r} already supplies {self.capability.value}"


class ProviderRegistry:
    def __init__(self) -> None:
        self._metadata: dict[str, MetadataFactory] = {}
        self._citation: dict[str, CitationFactory] = {}
        self._resolvers: dict[str, ResolverFactory] = {}
        self._fetchers: dict[str, FetcherFactory] = {}

    @staticmethod
    def _add(
        values: dict[str, FactoryT],
        name: str,
        factory: FactoryT,
        capability: Capability,
    ) -> None:
        if name in values:
            raise DuplicateProviderCapability(name, capability)
        values[name] = factory

    def register_metadata(self, name: str, factory: MetadataFactory) -> ProviderRegistry:
        self._add(self._metadata, name, factory, Capability.METADATA)
        return self

    def register_citation(self, name: str, factory: CitationFactory) -> ProviderRegistry:
        self._add(self._citation, name, factory, Capability.CITATION)
        return self

    def register_asset_resolver(self, name: str, factory: ResolverFactory) -> ProviderRegistry:
        self._add(self._resolvers, name, factory, Capability.ASSET_RESOLVER)
        return self

    def register_asset_fetcher(self, name: str, factory: FetcherFactory) -> ProviderRegistry:
        self._add(self._fetchers, name, factory, Capability.ASSET_FETCHER)
        return self

    def metadata(self, name: str) -> MetadataDiscoveryPort:
        return self._get(self._metadata, name, Capability.METADATA)()

    def citation(self, name: str) -> CitationDiscoveryPort:
        return self._get(self._citation, name, Capability.CITATION)()

    def asset_resolver(self, name: str) -> AssetResolverPort:
        return self._get(self._resolvers, name, Capability.ASSET_RESOLVER)()

    def asset_fetcher(self, name: str) -> AssetFetcherPort:
        return self._get(self._fetchers, name, Capability.ASSET_FETCHER)()

    @staticmethod
    def _get(
        values: dict[str, FactoryT],
        name: str,
        capability: Capability,
    ) -> FactoryT:
        try:
            return values[name]
        except KeyError:
            raise UnsupportedCapability(name, capability) from None

    def names(self, capability: Capability) -> tuple[str, ...]:
        match capability:
            case Capability.METADATA:
                values = self._metadata
            case Capability.CITATION:
                values = self._citation
            case Capability.ASSET_RESOLVER:
                values = self._resolvers
            case Capability.ASSET_FETCHER:
                values = self._fetchers
            case unreachable:
                assert_never(unreachable)
        return tuple(sorted(values))

    def require(self, capability: Capability, providers: tuple[str, ...]) -> None:
        supported = frozenset(self.names(capability))
        for provider in providers:
            if provider not in supported:
                raise UnsupportedCapability(provider, capability)


__all__ = (
    "Capability",
    "DuplicateProviderCapability",
    "ProviderRegistry",
    "UnsupportedCapability",
)
