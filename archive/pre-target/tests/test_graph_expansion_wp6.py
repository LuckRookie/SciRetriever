import sys
from pathlib import Path
from unittest import IsolatedAsyncioTestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from graph_expansion_fixture import (
    NODES,
    VERSION_A,
    VERSION_B,
    VERSION_C,
    WORK_A,
    WORK_B,
    WORK_C,
    fixture,
    identifier,
)
from sciretriever.expansion import (
    ExpansionItemStatus,
    ExpansionPolicy,
    ExpansionSeed,
    FrontierNode,
)
from sciretriever.integrations.graph import ExpansionDepth, GraphDirection


class GraphExpansionTests(IsolatedAsyncioTestCase):
    async def test_depth_zero_processes_only_explicit_work_version_seed(self) -> None:
        # Given
        value = fixture({(WORK_A, GraphDirection.REFERENCES): (WORK_B,)})

        # When
        result = await value.engine().expand(
            ExpansionSeed(VERSION_A),
            ExpansionPolicy(GraphDirection.REFERENCES, ExpansionDepth(0), 1, 200),
        )

        # Then
        self.assertEqual(tuple(item.node.work_id for item in result.layers[0].items), (WORK_A,))
        self.assertEqual(value.completion.calls, [VERSION_A])
        self.assertEqual(value.graph.calls, [])

    async def test_breadth_first_cycles_and_provider_duplicates_are_stable(self) -> None:
        # Given
        edges = {
            (WORK_A, GraphDirection.REFERENCES): (WORK_C, WORK_B, WORK_B),
            (WORK_B, GraphDirection.REFERENCES): (WORK_A, WORK_C),
            (WORK_C, GraphDirection.REFERENCES): (WORK_A,),
        }
        value = fixture(edges, {"a": ("c", "b")})
        policy = ExpansionPolicy(GraphDirection.REFERENCES, ExpansionDepth(2), 1, 200)

        # When
        first = await value.engine().expand(ExpansionSeed(VERSION_A), policy)
        second = await fixture(edges, {"a": ("b", "c")}).engine().expand(
            ExpansionSeed(VERSION_A), policy
        )

        # Then
        self.assertEqual(first, second)
        self.assertEqual(
            tuple(tuple(item.node.work_id for item in layer.items) for layer in first.layers),
            ((WORK_A,), (WORK_B, WORK_C)),
        )
        self.assertEqual(value.completion.calls, [VERSION_A, VERSION_B, VERSION_C])
        self.assertLess(
            value.frontier.events.index(f"complete:{VERSION_C}"),
            value.frontier.events.index(f"local:{WORK_B}:references"),
        )
        self.assertLess(
            value.frontier.events.index(f"local:{WORK_A}:references"),
            value.frontier.events.index("provider:a"),
        )

    async def test_incomplete_preferred_version_stops_only_its_branch(self) -> None:
        # Given
        value = fixture(
            {
                (WORK_A, GraphDirection.REFERENCES): (WORK_B, WORK_C),
                (WORK_B, GraphDirection.REFERENCES): (WORK_A,),
                (WORK_C, GraphDirection.REFERENCES): (WORK_A,),
            },
            incomplete=frozenset({VERSION_B}),
        )

        # When
        result = await value.engine().expand(
            ExpansionSeed(VERSION_A),
            ExpansionPolicy(GraphDirection.REFERENCES, ExpansionDepth(2), 1, 200),
        )

        # Then
        statuses = {item.node.work_id: item.status for item in result.layers[1].items}
        self.assertEqual(statuses[WORK_B], ExpansionItemStatus.INCOMPLETE)
        self.assertEqual(statuses[WORK_C], ExpansionItemStatus.COMPLETE)
        self.assertNotIn(f"local:{WORK_B}:references", value.frontier.events)
        self.assertIn(f"local:{WORK_C}:references", value.frontier.events)

    async def test_high_fanout_has_no_hidden_document_cap(self) -> None:
        # Given
        work_ids = tuple(
            f"00000000-0000-4000-8000-{index:012d}" for index in range(10, 131)
        )
        NODES.update({
            work_id: FrontierNode(
                work_id, f"10000000-0000-4000-8000-{index:012d}",
                identifier(f"fan-{index}"),
            )
            for index, work_id in enumerate(work_ids, 10)
        })
        value = fixture({(WORK_A, GraphDirection.REFERENCES): tuple(reversed(work_ids))})

        # When
        result = await value.engine().expand(
            ExpansionSeed(VERSION_A),
            ExpansionPolicy(GraphDirection.REFERENCES, ExpansionDepth(1), 1, 200),
        )

        # Then
        self.assertEqual(len(result.layers[1].items), 121)
        self.assertEqual(
            tuple(item.node.work_id for item in result.layers[1].items), tuple(sorted(work_ids))
        )

    async def test_provider_fills_unknown_and_preserves_sibling_failure(self) -> None:
        # Given
        value = fixture(
            {}, {"a": ("b",)}, failed_providers=("failed-provider",)
        )

        # When
        result = await value.engine().expand(
            ExpansionSeed(VERSION_A),
            ExpansionPolicy(GraphDirection.REFERENCES, ExpansionDepth(1), 1, 200),
        )

        # Then
        self.assertEqual(
            tuple(item.node.work_id for item in result.layers[1].items), (WORK_B,)
        )
        self.assertEqual(result.layers[0].failed_providers, ("failed-provider",))
        self.assertLess(
            value.frontier.events.index(f"local:{WORK_A}:references"),
            value.frontier.events.index("provider:a"),
        )


if __name__ == "__main__":
    import unittest

    unittest.main()
