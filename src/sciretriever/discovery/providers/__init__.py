"""Stable discovery provider and transport APIs."""

from .arxiv import ArxivProvider, build_arxiv_provider
from .base import DiscoveryProvider
from .crossref import CrossrefProvider, build_crossref_provider
from .europe_pmc import EuropePMCProvider, build_europe_pmc_provider
from .http import DEFAULT_MAX_RESPONSE_BYTES, HttpResponse, Transport, UrllibTransport
from .vendor import (
    ElsevierProvider, OpenAlexProvider, SemanticScholarProvider, SpringerProvider,
    build_elsevier_provider, build_openalex_provider,
    build_semantic_scholar_provider, build_springer_provider,
)


__all__ = (
    "DEFAULT_MAX_RESPONSE_BYTES",
    "ArxivProvider",
    "CrossrefProvider",
    "DiscoveryProvider",
    "EuropePMCProvider",
    "ElsevierProvider",
    "HttpResponse",
    "OpenAlexProvider",
    "SemanticScholarProvider",
    "SpringerProvider",
    "Transport",
    "UrllibTransport",
    "build_arxiv_provider",
    "build_crossref_provider",
    "build_europe_pmc_provider",
    "build_elsevier_provider",
    "build_openalex_provider",
    "build_semantic_scholar_provider",
    "build_springer_provider",
)
