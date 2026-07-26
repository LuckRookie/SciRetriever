from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Protocol, assert_never

from sciretriever.core.ids import validate_uuid
from sciretriever.errors import CatalogError
from sciretriever.integrations.graph import (
    CitationEdge,
    ExpansionDepth,
    GraphDirection,
    GraphIdentifier,
    GraphIdentifierNamespace,
    GraphQuery,
)
from sciretriever.references import ReferenceResolutionResult

from .report import (
    ExpansionItem,
    ExpansionItemStatus,
    ExpansionLayer,
    ExpansionLayerCounts,
    ExpansionLayerResult,
    FrontierNode,
    JsonObject,
)


@dataclass(frozen=True, slots=True)
class ExpansionContractError(ValueError):
    reason: str

    def __str__(self) -> str:
        return self.reason


@dataclass(frozen=True, slots=True)
class ExpansionSeed:
    work_version_id: str

    def __post_init__(self) -> None:
        validate_uuid(self.work_version_id, "work_version_id")


@dataclass(frozen=True, slots=True)
class ExpansionPolicy:
    direction: GraphDirection
    depth: ExpansionDepth
    max_provider_calls: int
    provider_page_size: int

    def __post_init__(self) -> None:
        if not isinstance(self.direction, GraphDirection):
            raise ExpansionContractError("expansion direction is invalid")
        if not isinstance(self.depth, ExpansionDepth):
            raise ExpansionContractError("expansion depth must be ExpansionDepth")
        GraphQuery(
            GraphIdentifier(GraphIdentifierNamespace.DOI, "10.1000/expansion-policy"),
            self.direction,
            self.depth,
            self.max_provider_calls,
            self.provider_page_size,
        )


@dataclass(frozen=True, slots=True)
class ExpansionResult:
    seed: ExpansionSeed
    policy: ExpansionPolicy
    layers: tuple[ExpansionLayer, ...]

    @property
    def interrupted(self) -> bool:
        return any(layer.counts.interrupted > 0 for layer in self.layers)

    def to_dict(self) -> JsonObject:
        return {
            "seed": {"work_version_id": self.seed.work_version_id},
            "direction": self.policy.direction.value,
            "depth": int(self.policy.depth),
            "interrupted": self.interrupted,
            "layers": [layer.to_dict() for layer in self.layers],
        }


class FrontierCatalog(Protocol):
    def seed(self, work_version_id: str) -> FrontierNode: ...

    def preferred(self, work_id: str) -> FrontierNode | None: ...

    def neighbors(
        self, node: FrontierNode, direction: GraphDirection
    ) -> Iterable[str]: ...


class GraphResolver(Protocol):
    def resolve_graph(
        self, seed_work_version_id: str, edges: tuple[CitationEdge, ...]
    ) -> ReferenceResolutionResult: ...


@dataclass(frozen=True, slots=True)
class GraphDiscoveryResult:
    edges: tuple[CitationEdge, ...]
    failed_providers: tuple[str, ...] = ()
    provider_returned: int | None = None

    def __post_init__(self) -> None:
        provider_returned = len(self.edges) if self.provider_returned is None else self.provider_returned
        if provider_returned < len(self.edges):
            raise ExpansionContractError("provider_returned cannot be less than graph edges")
        object.__setattr__(self, "edges", tuple(sorted(set(self.edges))))
        object.__setattr__(
            self, "failed_providers", tuple(sorted(set(self.failed_providers)))
        )
        object.__setattr__(self, "provider_returned", provider_returned)


class GraphDiscovery(Protocol):
    async def discover(self, query: GraphQuery) -> GraphDiscoveryResult: ...


class CompletionOrchestrator(Protocol):
    async def complete_layer(
        self, nodes: tuple[FrontierNode, ...]
    ) -> ExpansionLayerResult: ...


@dataclass(frozen=True, slots=True)
class ExpansionServices:
    frontier: FrontierCatalog
    completion: CompletionOrchestrator
    resolver: GraphResolver
    graph: GraphDiscovery


class ExpansionEngine:
    def __init__(
        self,
        services: ExpansionServices,
    ) -> None:
        self._frontier = services.frontier
        self._completion = services.completion
        self._resolver = services.resolver
        self._graph = services.graph

    async def expand(
        self, seed: ExpansionSeed, policy: ExpansionPolicy
    ) -> ExpansionResult:
        current = (self._frontier.seed(seed.work_version_id),)
        visited: set[str] = {current[0].work_id}
        layers: list[ExpansionLayer] = []
        discovered = existing = reused = 1
        created = provider_returned = 0
        for depth in range(int(policy.depth) + 1):
            completion = await self._complete_layer(current)
            items = completion.items
            next_work_ids: set[str] = set()
            failed_providers: set[str] = set()
            next_reused = next_provider_returned = 0
            interrupted = completion.counts.interrupted > 0
            if not interrupted:
                for item in items:
                    node = item.node
                    if item.status is not ExpansionItemStatus.COMPLETE or depth == policy.depth:
                        continue
                    local = tuple(self._local_neighbors(node, policy.direction))
                    next_work_ids.update(local)
                    next_reused += len(set(local) - visited)
                    graph_result = await self._graph.discover(
                        GraphQuery(
                            node.identifier, policy.direction, policy.depth,
                            policy.max_provider_calls, policy.provider_page_size,
                        )
                    )
                    next_provider_returned += graph_result.provider_returned or 0
                    failed_providers.update(graph_result.failed_providers)
                    if graph_result.edges:
                        try:
                            self._resolver.resolve_graph(node.work_version_id, graph_result.edges)
                        except (CatalogError, OSError, TimeoutError):
                            continue
                        next_work_ids.update(self._local_neighbors(node, policy.direction))
            completed = sum(item.status is ExpansionItemStatus.COMPLETE for item in items)
            counts = ExpansionLayerCounts(
                provider_returned, discovered, created, reused, discovered, existing,
                completion.counts, completed,
            )
            layers.append(ExpansionLayer(
                depth, items, counts, tuple(sorted(failed_providers))
            ))
            if interrupted:
                break
            queued = tuple(sorted(next_work_ids - visited))
            visited.update(queued)
            current = tuple(
                node
                for work_id in queued
                if (node := self._frontier.preferred(work_id)) is not None
            )
            if not current:
                break
            discovered = len(current)
            existing = min(discovered, next_reused)
            created = discovered - existing
            reused = existing
            provider_returned = next_provider_returned
        return ExpansionResult(seed, policy, tuple(layers))

    async def _complete_layer(
        self, nodes: tuple[FrontierNode, ...]
    ) -> ExpansionLayerResult:
        return await self._completion.complete_layer(nodes)

    def _local_neighbors(
        self, node: FrontierNode, direction: GraphDirection
    ) -> Iterable[str]:
        match direction:
            case GraphDirection.REFERENCES | GraphDirection.CITED_BY:
                yield from self._frontier.neighbors(node, direction)
            case GraphDirection.BOTH:
                yield from self._frontier.neighbors(node, GraphDirection.REFERENCES)
                yield from self._frontier.neighbors(node, GraphDirection.CITED_BY)
            case unreachable:
                assert_never(unreachable)
