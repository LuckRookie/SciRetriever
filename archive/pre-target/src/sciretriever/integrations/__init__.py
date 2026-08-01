"""Vendor API clients and provider-neutral response DTOs."""

from .common import IntegrationError
from .arxiv import ArxivClient
from .crossref import CrossrefClient
from .elsevier import ElsevierClient
from .europe_pmc import EuropePmcClient
from .graph_adapters import (
    GraphCapabilityRegistry,
    GraphProviderBatch,
    GraphProviderFailure,
    OpenAlexGraphAdapter,
    SemanticScholarGraphAdapter,
    graph_capability_registry,
    query_graph_providers,
)
from .models import VendorPage, VendorWork
from .openalex import OpenAlexClient
from .semantic_scholar import SemanticScholarClient
from .springer import SpringerClient

__all__ = (
    "ArxivClient", "CrossrefClient", "ElsevierClient", "EuropePmcClient",
    "GraphCapabilityRegistry", "GraphProviderBatch", "GraphProviderFailure",
    "IntegrationError", "OpenAlexClient", "OpenAlexGraphAdapter",
    "SemanticScholarClient", "SemanticScholarGraphAdapter", "SpringerClient",
    "VendorPage", "VendorWork", "graph_capability_registry",
    "query_graph_providers",
)
