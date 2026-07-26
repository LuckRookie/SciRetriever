from dataclasses import dataclass

from sciretriever.catalog.completion_facts import CompletionStage
from sciretriever.completion import (
    CompletionAction,
    CompletionResult,
    CompletionStop,
    OutcomeDisposition,
    OutcomeReason,
    StageOutcome,
    WorkVersionTarget,
)
from sciretriever.completion.counts import InvocationCounts
from sciretriever.errors import CatalogError
from sciretriever.expansion import (
    ExpansionEngine,
    ExpansionItem,
    ExpansionItemStatus,
    ExpansionLayerResult,
    ExpansionServices,
    FrontierNode,
    GraphDiscoveryResult,
)
from sciretriever.references import ReferenceResolutionResult
from sciretriever.integrations.graph import (
    CitationEdge,
    GraphDirection,
    GraphIdentifier,
    GraphIdentifierNamespace,
    GraphQuery,
)


WORK_A = "00000000-0000-4000-8000-000000000001"
WORK_B = "00000000-0000-4000-8000-000000000002"
WORK_C = "00000000-0000-4000-8000-000000000003"
VERSION_A = "10000000-0000-4000-8000-000000000001"
VERSION_B = "10000000-0000-4000-8000-000000000002"
VERSION_C = "10000000-0000-4000-8000-000000000003"


def identifier(value: str) -> GraphIdentifier:
    return GraphIdentifier(GraphIdentifierNamespace.DOI, f"10.1000/{value}")


NODES = {
    WORK_A: FrontierNode(WORK_A, VERSION_A, identifier("a")),
    WORK_B: FrontierNode(WORK_B, VERSION_B, identifier("b")),
    WORK_C: FrontierNode(WORK_C, VERSION_C, identifier("c")),
}


class FrontierFixture:
    def __init__(self, edges: dict[tuple[str, GraphDirection], tuple[str, ...]]) -> None:
        self.edges = edges
        self.events: list[str] = []

    def seed(self, work_version_id: str) -> FrontierNode:
        self.events.append(f"seed:{work_version_id}")
        return NODES[WORK_A]

    def preferred(self, work_id: str) -> FrontierNode | None:
        self.events.append(f"preferred:{work_id}")
        return NODES.get(work_id)

    def neighbors(self, node: FrontierNode, direction: GraphDirection):
        self.events.append(f"local:{node.work_id}:{direction.value}")
        yield from self.edges.get((node.work_id, direction), ())


class CompletionFixture:
    def __init__(
        self,
        events: list[str],
        incomplete: frozenset[str] = frozenset(),
        failed: frozenset[str] = frozenset(),
    ) -> None:
        self.events = events
        self.incomplete = incomplete
        self.failed = failed
        self.calls: list[str] = []

    async def complete_layer(self, nodes):
        items = []
        for node in nodes:
            items.append(await self._complete(node))
        statuses = tuple(item.status for item in items)
        return ExpansionLayerResult(
            tuple(items),
            InvocationCounts(
                selected=len(items), unique_targets=len(items),
                succeeded=statuses.count(ExpansionItemStatus.COMPLETE),
                exhausted=statuses.count(ExpansionItemStatus.INCOMPLETE),
                failed=statuses.count(ExpansionItemStatus.FAILED),
                duplicates=0,
                interrupted=statuses.count(ExpansionItemStatus.INTERRUPTED),
            ),
        )

    async def _complete(self, node):
        target = WorkVersionTarget(node.work_version_id)
        self.calls.append(target.work_version_id)
        self.events.append(f"complete:{target.work_version_id}")
        if target.work_version_id in self.failed:
            return ExpansionItem(node, ExpansionItemStatus.FAILED)
        stage = (
            CompletionStage.ANALYSIS_PENDING
            if target.work_version_id in self.incomplete
            else CompletionStage.COMPLETE
        )
        outcomes = (
            StageOutcome(
                CompletionAction.PROMOTE_ANALYSIS,
                OutcomeDisposition.NOT_ADVANCED,
                OutcomeReason.EXHAUSTED,
                stage,
                stage,
            ),
        ) if stage is CompletionStage.ANALYSIS_PENDING else ()
        result = CompletionResult(
            target, target.work_version_id, CompletionStop.COMPLETE, stage, stage, outcomes
        )
        status = (
            ExpansionItemStatus.COMPLETE
            if result.final_stage is CompletionStage.COMPLETE
            else ExpansionItemStatus.INCOMPLETE
        )
        return ExpansionItem(node, status)


class GraphFixture:
    def __init__(
        self,
        frontier: FrontierFixture,
        edges: dict[str, tuple[str, ...]],
        failed_providers: tuple[str, ...] = (),
    ) -> None:
        self.frontier = frontier
        self.edges = edges
        self.calls: list[str] = []
        self.failed_providers = failed_providers

    async def discover(self, query: GraphQuery) -> GraphDiscoveryResult:
        seed = query.seed.value.rsplit("/", 1)[-1]
        self.calls.append(seed)
        self.frontier.events.append(f"provider:{seed}")
        edges = tuple(
            CitationEdge(query.seed, identifier(target))
            for target in self.edges.get(seed, ())
        )
        return GraphDiscoveryResult(edges, self.failed_providers)


class ResolverFixture:
    def __init__(self, frontier: FrontierFixture) -> None:
        self.frontier = frontier
        self.calls: list[str] = []

    def resolve_graph(
        self, seed_work_version_id: str, edges: tuple[CitationEdge, ...]
    ) -> ReferenceResolutionResult:
        self.calls.append(seed_work_version_id)
        seed_node = next(
            node for node in NODES.values()
            if node.work_version_id == seed_work_version_id
        )
        for edge in edges:
            endpoint = edge.target if edge.source == seed_node.identifier else edge.source
            target = endpoint.value.rsplit("/", 1)[-1]
            work_id = {"a": WORK_A, "b": WORK_B, "c": WORK_C}.get(target)
            if work_id is None:
                continue
            direction = (
                GraphDirection.REFERENCES
                if edge.source == seed_node.identifier
                else GraphDirection.CITED_BY
            )
            key = (seed_node.work_id, direction)
            existing = self.frontier.edges.get(key, ())
            self.frontier.edges[key] = tuple(sorted(set((*existing, work_id))))
        return ReferenceResolutionResult(resolved=len(edges))


@dataclass(frozen=True, slots=True)
class Fixture:
    frontier: FrontierFixture
    completion: CompletionFixture
    graph: GraphFixture
    resolver: ResolverFixture

    def engine(self) -> ExpansionEngine:
        return ExpansionEngine(ExpansionServices(
            self.frontier, self.completion, self.resolver, self.graph
        ))


def fixture(
    edges: dict[tuple[str, GraphDirection], tuple[str, ...]],
    provider_edges: dict[str, tuple[str, ...]] | None = None,
    incomplete: frozenset[str] = frozenset(),
    failed: frozenset[str] = frozenset(),
    failed_providers: tuple[str, ...] = (),
) -> Fixture:
    frontier = FrontierFixture(edges)
    return Fixture(
        frontier,
        CompletionFixture(frontier.events, incomplete, failed),
        GraphFixture(frontier, provider_edges or {}, failed_providers),
        ResolverFixture(frontier),
    )
