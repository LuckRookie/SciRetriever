from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from sciretriever.catalog import WorkRepository
from sciretriever.config import CredentialsConfig, get_credential
from sciretriever.discovery import (
    MetadataSearchOutput,
    MetadataSearchRequest,
    MetadataSearchService,
)
from sciretriever.discovery.search import ExactMetadataResolver
from sciretriever.discovery.providers import (
    DEFAULT_MAX_RESPONSE_BYTES,
    DiscoveryProvider,
    build_arxiv_provider,
    build_crossref_provider,
    build_elsevier_provider,
    build_europe_pmc_provider,
    build_openalex_provider,
    build_semantic_scholar_provider,
    build_springer_provider,
)
from sciretriever.network import SecureHttpsTransport


DEFAULT_METADATA_PROVIDERS = ("crossref", "europe-pmc", "arxiv")
ALL_METADATA_PROVIDERS = DEFAULT_METADATA_PROVIDERS + (
    "openalex", "semantic-scholar", "elsevier", "springer",
)
_CREDENTIALS = {
    "semantic-scholar": ("SCIRETRIEVER_SEMANTIC_SCHOLAR_API_KEY", "semantic_scholar_api_key"),
    "elsevier": ("SCIRETRIEVER_ELSEVIER_API_KEY", "elsevier_api_key"),
    "springer": ("SCIRETRIEVER_SPRINGER_API_KEY", "springer_api_key"),
}


@dataclass(frozen=True, slots=True)
class MetadataCliConfig:
    query: str
    providers: tuple[str, ...]
    precedence: tuple[str, ...]
    limit: int
    provider_timeout: float
    max_concurrency: int
    crossref_mailto: str | None
    credentials: CredentialsConfig = CredentialsConfig()

    def request(self) -> MetadataSearchRequest:
        return MetadataSearchRequest(
            self.query, self.providers, self.precedence, self.limit,
            self.provider_timeout, self.max_concurrency,
        )


def build_metadata_providers(config: MetadataCliConfig) -> Mapping[str, DiscoveryProvider]:
    transport = SecureHttpsTransport(max_bytes=DEFAULT_MAX_RESPONSE_BYTES)

    def credential(source: str) -> str | None:
        env_name, field = _CREDENTIALS[source]
        return get_credential(env_name) or config.credentials.get(field)

    builders = {
        "crossref": lambda: build_crossref_provider(
            transport, mailto=config.crossref_mailto, timeout=config.provider_timeout),
        "europe-pmc": lambda: build_europe_pmc_provider(transport, timeout=config.provider_timeout),
        "arxiv": lambda: build_arxiv_provider(transport, timeout=config.provider_timeout),
        "openalex": lambda: build_openalex_provider(transport, timeout=config.provider_timeout),
        "semantic-scholar": lambda: build_semantic_scholar_provider(
            transport, api_key=credential("semantic-scholar"), timeout=config.provider_timeout),
        "elsevier": lambda: build_elsevier_provider(
            transport, api_key=credential("elsevier"), timeout=config.provider_timeout),
        "springer": lambda: build_springer_provider(
            transport, api_key=credential("springer"), timeout=config.provider_timeout),
    }
    return {name: builders[name]() for name in config.providers}


def run_metadata_search(
    config: MetadataCliConfig,
    providers: Mapping[str, DiscoveryProvider],
    repository: WorkRepository,
) -> MetadataSearchOutput:
    return MetadataSearchService(providers, repository).search(config.request())


def build_exact_resolver(
    providers: Mapping[str, DiscoveryProvider], repository: WorkRepository,
) -> ExactMetadataResolver:
    return ExactMetadataResolver(providers, repository)


__all__ = (
    "ALL_METADATA_PROVIDERS", "DEFAULT_METADATA_PROVIDERS", "MetadataCliConfig",
    "MetadataSearchOutput", "build_exact_resolver", "build_metadata_providers",
    "run_metadata_search",
)
