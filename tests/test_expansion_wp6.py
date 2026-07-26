from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import IsolatedAsyncioTestCase, TestCase

from graph_expansion_fixture import VERSION_A, WORK_A, WORK_B, WORK_C, fixture
from sciretriever.expansion import (
    ExpansionItem,
    ExpansionItemStatus,
    ExpansionLayerResult,
    ExpansionPolicy,
    ExpansionSeed,
)
from sciretriever.integrations.graph import ExpansionDepth, GraphDirection
from sciretriever.completion.counts import InvocationCounts
from wp6_acceptance_fixture import run_acceptance


class CanonicalExpansionContractTests(IsolatedAsyncioTestCase):
    async def test_cyclic_graph_expands_references_cited_by_and_both_truthfully(self) -> None:
        edges = {
            (WORK_A, GraphDirection.REFERENCES): (WORK_B,),
            (WORK_A, GraphDirection.CITED_BY): (WORK_C,),
            (WORK_B, GraphDirection.REFERENCES): (WORK_A,),
            (WORK_C, GraphDirection.CITED_BY): (WORK_A,),
        }

        for direction, expected in (
            (GraphDirection.REFERENCES, (WORK_B,)),
            (GraphDirection.CITED_BY, (WORK_C,)),
            (GraphDirection.BOTH, (WORK_B, WORK_C)),
        ):
            with self.subTest(direction=direction):
                value = fixture(edges)
                result = await value.engine().expand(
                    ExpansionSeed(VERSION_A),
                    ExpansionPolicy(direction, ExpansionDepth(2), 2, 100),
                )
                layer = result.layers[1]
                self.assertEqual(tuple(item.node.work_id for item in layer.items), expected)
                self.assertEqual(layer.counts.discovered, len(expected))
                self.assertEqual(
                    layer.counts.selected,
                    layer.counts.succeeded + layer.counts.exhausted
                    + layer.counts.failed + layer.counts.duplicates
                    + layer.counts.interrupted,
                )
                self.assertEqual(
                    layer.counts.unique_targets,
                    layer.counts.selected - layer.counts.duplicates,
                )

    async def test_failed_branch_is_isolated_and_interruption_rerun_converges(self) -> None:
        value = fixture(
            {(WORK_A, GraphDirection.REFERENCES): (WORK_B, WORK_C)},
            failed=frozenset({"10000000-0000-4000-8000-000000000002"}),
        )
        first = value.frontier.seed(VERSION_A)
        second = value.frontier.preferred(WORK_B)
        third = value.frontier.preferred(WORK_C)
        self.assertIsNotNone(second)
        self.assertIsNotNone(third)
        assert second is not None and third is not None

        original = value.completion.complete_layer

        async def interrupt(nodes):
            if nodes == (first,):
                return await original(nodes)
            return ExpansionLayerResult(
                (
                    ExpansionItem(second, ExpansionItemStatus.FAILED),
                    ExpansionItem(third, ExpansionItemStatus.INTERRUPTED),
                ),
                InvocationCounts(2, 2, 0, 0, 1, 0, 1),
            )

        value.completion.complete_layer = interrupt
        interrupted = await value.engine().expand(
            ExpansionSeed(VERSION_A),
            ExpansionPolicy(GraphDirection.REFERENCES, ExpansionDepth(2), 1, 100),
        )
        rerun = await fixture(
            {(WORK_A, GraphDirection.REFERENCES): (WORK_B, WORK_C)},
            failed=frozenset({"10000000-0000-4000-8000-000000000002"}),
        ).engine().expand(
            ExpansionSeed(VERSION_A),
            ExpansionPolicy(GraphDirection.REFERENCES, ExpansionDepth(2), 1, 100),
        )

        self.assertTrue(interrupted.interrupted)
        self.assertEqual(
            tuple(item.status for item in rerun.layers[1].items),
            (ExpansionItemStatus.FAILED, ExpansionItemStatus.COMPLETE),
        )


class CanonicalExpansionPersistenceTests(TestCase):
    def test_offline_lifecycle_persists_cycle_failure_interruption_and_rerun(self) -> None:
        with TemporaryDirectory(prefix="sciretriever-expansion-release-") as temporary:
            root = Path(temporary) / "run"
            summary = run_acceptance(root)
            rendered = json.loads(summary.to_json())

            self.assertEqual(rendered["status"], "passed")
            self.assertEqual(rendered["failures"], 3)
            self.assertEqual(rendered["references"], 3)
            self.assertEqual(rendered["complete_versions"], 4)
            self.assertTrue((root / "catalog.sqlite").is_file())
            self.assertTrue((root / "storage").is_dir())


if __name__ == "__main__":
    import unittest

    unittest.main()
