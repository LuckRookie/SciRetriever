from __future__ import annotations

import unittest
from uuid import uuid4

import anyio

from sciretriever.catalog import CompletionFactsRepository, CompletionStage
from sciretriever.errors import CatalogError
from sciretriever.completion import (
    BatchItemStatus,
    CompletionResult,
    CompletionStop,
    DoiTarget,
    WorkVersionTarget,
    MetadataUnavailableResult,
    run_completion_batch,
)

from test_completion_acceptance_fixture import DOI, RealCompletionFixture


def completed(value: CompletionResult | MetadataUnavailableResult) -> CompletionResult:
    if isinstance(value, MetadataUnavailableResult):
        raise AssertionError("offline metadata fixture did not resolve")
    return value


class CompletionAcceptanceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.fixture = RealCompletionFixture.create()
        self.addCleanup(self.fixture.close)

    async def test_real_sqlite_storage_all_entry_paths_converge_with_exact_facts(self) -> None:
        runtime = self.fixture.runtime
        self.assertIsInstance(runtime.facts, CompletionFactsRepository)

        doi_result = completed(await runtime.pipeline.ensure_complete(
            DoiTarget(DOI), CompletionStop.COMPLETE
        ))
        doi_id = doi_result.work_version_id
        doi_facts = runtime.facts.get(doi_id)
        self.assertEqual(doi_facts.stage, CompletionStage.COMPLETE)
        self.assertEqual(doi_facts.current_revision, 1)
        self.assertEqual(doi_facts.primary_pdf_sha256, "017fae11f450fa2a7c4071ad6fc877ef5aae3b04dd3c7455c2c55afbb6126d17")
        doi_persisted = self.fixture.persisted_ids(doi_id)
        self.assertEqual(doi_persisted[0], doi_facts.primary_pdf_id)
        self.assertEqual(doi_persisted[1], doi_facts.primary_pdf_sha256)
        self.assertEqual(doi_persisted[2], doi_facts.current_analysis_id)
        self.assertEqual(doi_persisted[4], doi_facts.current_revision)
        self.assertEqual(self.fixture.counts(), (1, 1, 3, 2, 1, 1, 1, 3, 6))

        existing_id = self.fixture.ingest("10.1234/wp5-existing")
        existing = completed(await runtime.pipeline.ensure_complete(
            WorkVersionTarget(existing_id), CompletionStop.COMPLETE
        ))
        self.assertEqual(existing.final_stage, CompletionStage.COMPLETE)
        self.assertEqual(self.fixture.persisted_ids(existing_id)[4], 1)
        self.assertEqual(self.fixture.counts(), (2, 2, 6, 4, 2, 2, 2, 6, 12))

        pdf_id = self.fixture.ingest("10.1234/wp5-pdf")
        await runtime.pipeline.ensure_complete(
            WorkVersionTarget(pdf_id), CompletionStop.ASSET
        )
        accepted = runtime.facts.get(pdf_id)
        self.assertEqual(accepted.stage, CompletionStage.ANALYSIS_PENDING)
        pdf_result = completed(await runtime.pipeline.ensure_complete(
            WorkVersionTarget(pdf_id), CompletionStop.COMPLETE
        ))
        self.assertEqual(pdf_result.final_stage, CompletionStage.COMPLETE)
        pdf_facts = runtime.facts.get(pdf_id)
        self.assertEqual(self.fixture.persisted_ids(pdf_id)[:3], (
            pdf_facts.primary_pdf_id,
            pdf_facts.primary_pdf_sha256,
            pdf_facts.current_analysis_id,
        ))

        complete_before = runtime.facts.get(doi_id)
        replay = completed(await runtime.pipeline.ensure_complete(
            WorkVersionTarget(doi_id), CompletionStop.COMPLETE
        ))
        self.assertEqual(replay.outcomes, ())
        self.assertEqual(runtime.facts.get(doi_id), complete_before)
        self.assertEqual(self.fixture.persisted_ids(doi_id), doi_persisted)
        self.assertEqual(self.fixture.counts(), (3, 3, 9, 6, 3, 3, 3, 9, 18))

    async def test_real_restart_partial_failure_and_two_pipeline_race_converge(self) -> None:
        runtime = self.fixture.runtime
        first_id = self.fixture.ingest("10.1234/wp5-restart")
        self.fixture.analysis.fail_next = True
        with self.assertRaisesRegex(RuntimeError, "offline analysis failure"):
            await runtime.pipeline.ensure_complete(
                WorkVersionTarget(first_id), CompletionStop.COMPLETE
            )
        interrupted = runtime.facts.get(first_id)
        self.assertEqual(interrupted.stage, CompletionStage.ANALYSIS_PENDING)
        resumed = completed(await runtime.pipeline.ensure_complete(
            WorkVersionTarget(first_id), CompletionStop.COMPLETE
        ))
        self.assertEqual(resumed.final_stage, CompletionStage.COMPLETE)
        self.assertEqual(runtime.facts.get(first_id).current_revision, 1)

        failed_id = self.fixture.ingest("10.1234/wp5-failed")
        sibling_id = self.fixture.ingest("10.1234/wp5-sibling")
        await runtime.pipeline.ensure_complete(
            WorkVersionTarget(sibling_id), CompletionStop.COMPLETE
        )
        self.fixture.acquisition.raise_next = True
        batch = await run_completion_batch(
            runtime.pipeline,
            (WorkVersionTarget(failed_id), WorkVersionTarget(sibling_id)),
            CompletionStop.COMPLETE,
        )
        self.assertEqual(
            tuple(item.status for item in batch.items),
            (BatchItemStatus.FAILED, BatchItemStatus.SUCCEEDED),
        )
        self.assertEqual(runtime.facts.get(failed_id).stage, CompletionStage.ASSET_PENDING)
        self.assertEqual(runtime.facts.get(sibling_id).stage, CompletionStage.COMPLETE)
        repaired = completed(await runtime.pipeline.ensure_complete(
            WorkVersionTarget(failed_id), CompletionStop.COMPLETE
        ))
        self.assertEqual(repaired.final_stage, CompletionStage.COMPLETE)

        raced_id = self.fixture.ingest("10.1234/wp5-race")
        self.fixture.acquisition.race_gate = True
        results = []

        async def complete_once() -> None:
            results.append(await runtime.pipeline.ensure_complete(
                WorkVersionTarget(raced_id), CompletionStop.ASSET
            ))

        async with anyio.create_task_group() as group:
            group.start_soon(complete_once)
            group.start_soon(complete_once)
        self.assertEqual(runtime.facts.get(raced_id).stage, CompletionStage.ANALYSIS_PENDING)
        self.assertEqual(len(results), 2)

    def test_valid_missing_work_version_has_exactly_zero_side_effects(self) -> None:
        before = self.fixture.counts()
        with self.assertRaisesRegex(CatalogError, "unknown WorkVersion"):
            self.fixture.runtime.facts.get(str(uuid4()))
        self.assertEqual(self.fixture.counts(), before)


if __name__ == "__main__":
    unittest.main()
