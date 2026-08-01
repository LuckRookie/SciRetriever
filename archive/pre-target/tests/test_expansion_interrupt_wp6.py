from __future__ import annotations

from unittest import IsolatedAsyncioTestCase, TestCase

from graph_expansion_fixture import VERSION_A, WORK_A, WORK_B, WORK_C, fixture
from sciretriever.completion.counts import InvocationCounts
from sciretriever.expansion import (
    ExpansionItem,
    ExpansionItemStatus,
    ExpansionLayerCounts,
    ExpansionLayerResult,
    ExpansionPolicy,
    ExpansionSeed,
)
from sciretriever.integrations.graph import ExpansionDepth, GraphDirection


class ExpansionLayerCountContractTests(TestCase):
    def test_canonical_layer_counts_reconcile(self) -> None:
        # Given / When
        counts = ExpansionLayerCounts(
            provider_returned=3,
            deduplicated_works=2,
            created=1,
            reused=1,
            discovered=2,
            existing=1,
            completion=InvocationCounts(2, 2, 1, 0, 0, 0, 1),
            completed=1,
        )

        # Then
        self.assertEqual(tuple(counts.to_dict()), (
            "provider_returned", "deduplicated_works", "created", "reused",
            "discovered", "existing", "selected", "unique_targets", "succeeded",
            "completed", "exhausted", "failed", "duplicates", "interrupted",
            "analysis_succeeded", "analysis_failed",
        ))
        self.assertEqual(counts.selected, counts.succeeded + counts.exhausted
                         + counts.failed + counts.duplicates + counts.interrupted)
        self.assertEqual(counts.unique_targets, counts.selected - counts.duplicates)


class ExpansionInterruptTests(IsolatedAsyncioTestCase):
    async def test_mid_layer_interrupt_stops_before_next_frontier(self) -> None:
        # Given
        value = fixture({(WORK_A, GraphDirection.REFERENCES): (WORK_B, WORK_C)})
        first = value.frontier.seed(VERSION_A)
        second = value.frontier.preferred(WORK_B)
        third = value.frontier.preferred(WORK_C)
        self.assertIsNotNone(second)
        self.assertIsNotNone(third)
        if second is None or third is None:
            self.fail("fixture preferred WorkVersion is missing")

        async def interrupted_layer(nodes):
            if nodes == (first,):
                return ExpansionLayerResult(
                    (ExpansionItem(first, ExpansionItemStatus.COMPLETE),),
                    InvocationCounts(1, 1, 1, 0, 0, 0, 0),
                )
            self.assertEqual(nodes, (second, third))
            return ExpansionLayerResult(
                (
                    ExpansionItem(second, ExpansionItemStatus.COMPLETE),
                    ExpansionItem(third, ExpansionItemStatus.INTERRUPTED),
                ),
                InvocationCounts(2, 2, 1, 0, 0, 0, 1),
            )

        value.completion.complete_layer = interrupted_layer

        # When
        result = await value.engine().expand(
            ExpansionSeed(VERSION_A),
            ExpansionPolicy(GraphDirection.REFERENCES, ExpansionDepth(2), 1, 200),
        )

        # Then
        self.assertEqual(len(result.layers), 2)
        self.assertTrue(result.interrupted)
        self.assertEqual(result.layers[1].counts.interrupted, 1)
        self.assertEqual(value.graph.calls, ["a"])


if __name__ == "__main__":
    import unittest

    unittest.main()
