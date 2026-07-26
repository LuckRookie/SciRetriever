from __future__ import annotations

import sys
from pathlib import Path
from unittest import IsolatedAsyncioTestCase

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition.pacing import DocumentStartGate
from sciretriever.catalog.diagnostics import CatalogDiagnosticService
from sciretriever.completion import CompletionResult, CompletionStop, DoiTarget
from sciretriever.completion.counts import InvocationCounts
from sciretriever.expansion import ExpansionItemStatus, FrontierNode
from sciretriever.expansion.completion import (
    ExpansionCompletionServices,
    PipelineLayerCompletion,
)
from sciretriever.integrations.graph import GraphIdentifier, GraphIdentifierNamespace

from test_completion_acceptance_fixture import RealCompletionFixture


class RecordingPacer:
    def __init__(self, gate: DocumentStartGate) -> None:
        self._gate = gate
        self.timestamps: list[float] = []

    async def wait(self, applicable_interval: float = 0.0) -> float:
        timestamp = await self._gate.wait(applicable_interval)
        self.timestamps.append(timestamp)
        return timestamp


class InterruptingPacer:
    async def wait(self, applicable_interval: float = 0.0) -> float:
        raise KeyboardInterrupt


class ExpansionCompletionAcceptanceTests(IsolatedAsyncioTestCase):
    async def test_fixed_hook_marks_current_suffix_interrupted_and_rerun_converges(self) -> None:
        # Given
        fixture = RealCompletionFixture.create()
        self.addCleanup(fixture.close)
        completed = await fixture.runtime.pipeline.ensure_complete(
            DoiTarget("10.1234/wp6-interrupt-complete"), CompletionStop.COMPLETE
        )
        self.assertIsInstance(completed, CompletionResult)
        if not isinstance(completed, CompletionResult):
            self.fail("fixture DOI did not resolve")
        pending = (
            fixture.ingest("10.1234/wp6-interrupt-b"),
            fixture.ingest("10.1234/wp6-interrupt-c"),
        )
        version_ids = (completed.work_version_id, *pending)
        dois = dict(zip(version_ids, (
            "10.1234/wp6-interrupt-complete", "10.1234/wp6-interrupt-b",
            "10.1234/wp6-interrupt-c",
        ), strict=True))
        with fixture.catalog.connect() as connection:
            rows = connection.exec_driver_sql(
                "SELECT id, work_id FROM work_versions WHERE id IN (?, ?, ?)",
                version_ids,
            ).all()
        by_version = {str(row[0]): str(row[1]) for row in rows}
        nodes = tuple(
            FrontierNode(
                by_version[version_id], version_id,
                GraphIdentifier(GraphIdentifierNamespace.DOI, dois[version_id]),
            )
            for version_id in version_ids
        )
        completed_snapshot = fixture.persisted_ids(completed.work_version_id)
        interrupted_adapter = PipelineLayerCompletion(ExpansionCompletionServices(
            fixture.runtime.pipeline, InterruptingPacer(),
            CatalogDiagnosticService(fixture.catalog),
        ))

        rerun_now = [0.0]

        async def immediate_sleep(delay: float) -> None:
            rerun_now[0] += delay

        # When
        interrupted = await interrupted_adapter.complete_layer(nodes)
        preserved = fixture.counts()
        converging_adapter = PipelineLayerCompletion(ExpansionCompletionServices(
            fixture.runtime.pipeline,
            RecordingPacer(DocumentStartGate(
                1.0, monotonic=lambda: rerun_now[0], sleep=immediate_sleep,
            )),
            CatalogDiagnosticService(fixture.catalog),
        ))
        rerun = await converging_adapter.complete_layer(nodes)
        converged = fixture.counts()
        replay = await converging_adapter.complete_layer(nodes)
        with fixture.catalog.connect() as connection:
            diagnostic_count = connection.exec_driver_sql(
                "SELECT count(*) FROM diagnostic_records WHERE reason = 'interrupted'"
            ).scalar_one()

        # Then
        self.assertEqual(
            tuple(item.status for item in interrupted),
            (ExpansionItemStatus.COMPLETE, ExpansionItemStatus.INTERRUPTED,
             ExpansionItemStatus.INTERRUPTED),
        )
        self.assertEqual(interrupted.counts, InvocationCounts(3, 3, 1, 0, 0, 0, 2))
        self.assertEqual(preserved, (3, 3, 9, 6, 1, 1, 1, 3, 6))
        self.assertEqual(converged, (3, 3, 9, 6, 3, 3, 3, 9, 18))
        self.assertEqual(diagnostic_count, 2)
        self.assertEqual(fixture.persisted_ids(completed.work_version_id), completed_snapshot)
        self.assertTrue(all(item.status is ExpansionItemStatus.COMPLETE for item in rerun))
        self.assertTrue(all(item.status is ExpansionItemStatus.COMPLETE for item in replay))
        self.assertEqual(preserved[:4], converged[:4])
        self.assertEqual(converged, fixture.counts())

    async def test_layer_retries_pending_and_reuses_complete_without_duplicate_facts(self) -> None:
        # Given
        fixture = RealCompletionFixture.create()
        self.addCleanup(fixture.close)
        first = await fixture.runtime.pipeline.ensure_complete(
            DoiTarget("10.1234/wp6-layer-a"), CompletionStop.COMPLETE
        )
        self.assertIsInstance(first, CompletionResult)
        if not isinstance(first, CompletionResult):
            self.fail("fixture DOI did not resolve")
        first_version = first.work_version_id
        second_version = fixture.ingest("10.1234/wp6-layer-b")
        third_version = fixture.ingest("10.1234/wp6-layer-c")
        with fixture.catalog.connect() as connection:
            rows = connection.exec_driver_sql(
                "SELECT id, work_id FROM work_versions WHERE id IN (?, ?, ?)",
                (first_version, second_version, third_version),
            ).all()
        work_ids: dict[str, str] = {}
        for row in rows:
            work_ids[str(row[0])] = str(row[1])
        nodes = (
            FrontierNode(
                work_ids[first_version],
                first_version,
                GraphIdentifier(GraphIdentifierNamespace.DOI, "10.1234/wp6-layer-a"),
            ),
            FrontierNode(
                work_ids[second_version],
                second_version,
                GraphIdentifier(GraphIdentifierNamespace.DOI, "10.1234/wp6-layer-b"),
            ),
            FrontierNode(
                work_ids[third_version],
                third_version,
                GraphIdentifier(GraphIdentifierNamespace.DOI, "10.1234/wp6-layer-c"),
            ),
        )
        starts: list[float] = []
        now = [0.0]

        async def sleep(delay: float) -> None:
            starts.append(delay)
            now[0] += delay

        pacer = RecordingPacer(
            DocumentStartGate(30.0, monotonic=lambda: now[0], sleep=sleep)
        )
        adapter = PipelineLayerCompletion(ExpansionCompletionServices(
            fixture.runtime.pipeline, pacer, CatalogDiagnosticService(fixture.catalog)
        ))
        before = fixture.counts()
        fixture.acquisition.fail_next = True
        fixture.analysis.fail_next = True

        # When
        exhausted = await adapter.complete_layer(nodes)
        after_exhausted = fixture.counts()
        completed = await adapter.complete_layer(nodes)
        after_completed = fixture.counts()
        replayed = await adapter.complete_layer(nodes)

        # Then
        self.assertEqual(
            tuple(item.status for item in exhausted),
            (
                ExpansionItemStatus.COMPLETE,
                ExpansionItemStatus.INCOMPLETE,
                ExpansionItemStatus.FAILED,
            ),
        )
        self.assertEqual(
            tuple(item.status for item in completed),
            (
                ExpansionItemStatus.COMPLETE,
                ExpansionItemStatus.COMPLETE,
                ExpansionItemStatus.COMPLETE,
            ),
        )
        self.assertTrue(all(item.status is ExpansionItemStatus.COMPLETE for item in replayed))
        self.assertEqual(before[:4], after_exhausted[:4])
        self.assertEqual(after_completed, fixture.counts())
        self.assertEqual(starts, [30.0, 30.0, 30.0])
        self.assertEqual(pacer.timestamps, [0.0, 30.0, 60.0, 90.0])
        with fixture.catalog.connect() as connection:
            diagnostic_count = connection.exec_driver_sql(
                "SELECT count(*) FROM diagnostic_records WHERE work_id IN (?, ?)",
                (work_ids[second_version], work_ids[third_version]),
            ).scalar_one()
        self.assertEqual(diagnostic_count, 2)


if __name__ == "__main__":
    import unittest

    unittest.main()
