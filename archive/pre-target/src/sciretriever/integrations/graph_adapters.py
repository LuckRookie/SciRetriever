from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Iterator, Mapping

import anyio

from sciretriever.errors import ProviderErrorCategory, classify_provider_http_status

from .common import IntegrationError
from .graph import (
    GraphCapability,
    GraphDirection,
    GraphPage,
    GraphQuery,
    GraphRequest,
    GraphResult,
)
from .openalex import OpenAlexClient
from .openalex_graph import OpenAlexGraphAdapter
from .semantic_scholar import SemanticScholarClient
from .semantic_scholar_graph import SemanticScholarGraphAdapter


@dataclass(frozen=True, slots=True, order=True)
class GraphProviderFailure:
    provider: str
    category: ProviderErrorCategory
    retryable: bool
    status: int | None = None

    @property
    def message(self) -> str:
        return f"{self.provider} graph request failed ({self.category.value})"


@dataclass(frozen=True, slots=True)
class GraphProviderBatch:
    results: tuple[GraphResult, ...]
    failures: tuple[GraphProviderFailure, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "results", tuple(sorted(self.results, key=lambda result: result.provider)))
        object.__setattr__(self, "failures", tuple(sorted(self.failures, key=lambda failure: failure.provider)))


class GraphCapabilityRegistry(Mapping[str, GraphCapability]):
    def __init__(self, capabilities: tuple[GraphCapability, ...]) -> None:
        values = {capability.name: capability for capability in capabilities}
        if len(values) != len(capabilities):
            raise GraphCapabilityRegistrationError
        self._values = MappingProxyType(dict(sorted(values.items())))

    def __getitem__(self, name: str) -> GraphCapability:
        return self._values[name]

    def __iter__(self) -> Iterator[str]:
        return iter(self._values)

    def __len__(self) -> int:
        return len(self._values)


class GraphCapabilityRegistrationError(Exception):
    def __str__(self) -> str:
        return "graph capability names must be unique"


def graph_capability_registry(
    openalex: OpenAlexClient | None = None,
    semantic_scholar: SemanticScholarClient | None = None,
) -> GraphCapabilityRegistry:
    capabilities: list[GraphCapability] = []
    if openalex is not None:
        capabilities.append(OpenAlexGraphAdapter(openalex))
    if semantic_scholar is not None:
        capabilities.append(SemanticScholarGraphAdapter(semantic_scholar))
    return GraphCapabilityRegistry(tuple(capabilities))


async def query_graph_providers(
    capabilities: tuple[GraphCapability, ...],
    query: GraphQuery,
) -> GraphProviderBatch:
    results: list[GraphResult] = []
    failures: list[GraphProviderFailure] = []

    async def run(capability: GraphCapability) -> None:
        required = (
            frozenset({GraphDirection.REFERENCES, GraphDirection.CITED_BY})
            if query.direction is GraphDirection.BOTH
            else frozenset({query.direction})
        )
        if not required.issubset(capability.graph_directions):
            failures.append(_unsupported_failure(capability.name))
            return
        try:
            pages = await _query_provider(capability, query)
            results.append(GraphResult(capability.name, query, pages))
        except IntegrationError as error:
            failures.append(_integration_failure(capability.name, error))
        except (OSError, TimeoutError):
            failures.append(_transport_failure(capability.name))
        except (TypeError, ValueError):
            failures.append(_invalid_response_failure(capability.name))

    async with anyio.create_task_group() as task_group:
        for capability in capabilities:
            task_group.start_soon(run, capability)
    return GraphProviderBatch(tuple(results), tuple(failures))


async def _query_provider(
    capability: GraphCapability,
    query: GraphQuery,
) -> tuple[GraphPage, ...]:
    pages: list[GraphPage] = []
    directions = (
        (GraphDirection.REFERENCES, GraphDirection.CITED_BY)
        if query.direction is GraphDirection.BOTH
        else (query.direction,)
    )
    for direction in directions:
        if direction not in capability.graph_directions:
            raise IntegrationError("graph direction is unsupported")
        cursor = None
        seen = set()
        for call_number in range(1, query.max_provider_calls + 1):
            page = await capability.graph_page(GraphRequest(query, direction, cursor, call_number))
            pages.append(page)
            if page.next_cursor is None:
                break
            if page.next_cursor == cursor or page.next_cursor in seen:
                raise IntegrationError("graph pagination cursor cycled")
            seen.add(page.next_cursor)
            cursor = page.next_cursor
    return tuple(pages)


def _integration_failure(provider: str, error: IntegrationError) -> GraphProviderFailure:
    if error.status is None or not 300 <= error.status < 600:
        return _invalid_response_failure(provider)
    category, retryable = classify_provider_http_status(error.status)
    return GraphProviderFailure(provider, category, retryable, error.status)


def _transport_failure(provider: str) -> GraphProviderFailure:
    return GraphProviderFailure(provider, ProviderErrorCategory.TRANSPORT, True)


def _invalid_response_failure(provider: str) -> GraphProviderFailure:
    return GraphProviderFailure(provider, ProviderErrorCategory.INVALID_RESPONSE, False)


def _unsupported_failure(provider: str) -> GraphProviderFailure:
    return GraphProviderFailure(provider, ProviderErrorCategory.CONFIGURATION, False)


__all__ = (
    "GraphCapabilityRegistry",
    "GraphProviderBatch",
    "GraphProviderFailure",
    "OpenAlexGraphAdapter",
    "SemanticScholarGraphAdapter",
    "graph_capability_registry",
    "query_graph_providers",
)
