import json
import unittest
from dataclasses import FrozenInstanceError

from completion_pipeline_fixture import VERSION_A, VERSION_B, pipeline
from sciretriever.catalog import CompletionFacts, CompletionStage
from sciretriever.completion import (
    BatchItemResult,
    BatchPolicy,
    BatchResult,
    CompletionStop,
    DoiTarget,
    OutcomeDisposition,
    OutcomeReason,
    WorkVersionTarget,
    run_completion_batch,
)
from sciretriever.completion.counts import CatalogCounts, InvocationCounts, ProgressCount


class TruthfulRunnerOutcomeTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_resolved_target_retains_identity_for_later_duplicate(self) -> None:
        # Given
        completion, _, owners = pipeline(CompletionStage.ASSET_PENDING)
        owners[2].fail = True
        target = WorkVersionTarget(VERSION_A)

        # When
        result = await run_completion_batch(
            completion,
            (target, target),
            CompletionStop.COMPLETE,
        )
        rendered = result.to_dict()

        # Then
        self.assertEqual(result.counts, InvocationCounts(2, 1, 0, 0, 1, 1, 0))
        self.assertEqual(rendered["items"], [
            {
                "target": target.to_dict(),
                "status": "failed",
                "work_version_id": VERSION_A,
                "final_stage": "analysis_pending",
                "result": None,
                "reason": "unexpected_failure",
                "duplicate_of": None,
            },
            {
                "target": target.to_dict(),
                "status": "duplicate",
                "work_version_id": VERSION_A,
                "final_stage": None,
                "result": None,
                "reason": None,
                "duplicate_of": 0,
            },
        ])

    async def test_resolved_target_exhausted_before_stop_is_not_succeeded(self) -> None:
        # Given
        completion, _, owners = pipeline(CompletionStage.ASSET_PENDING)
        owners[1].disposition = OutcomeDisposition.NOT_ADVANCED

        # When
        result = await run_completion_batch(
            completion,
            (WorkVersionTarget(VERSION_A),),
            CompletionStop.COMPLETE,
        )

        # Then
        self.assertEqual(result.counts, InvocationCounts(1, 1, 0, 1, 0, 0, 0))
        self.assertEqual(result.items[0].status.value, "exhausted")
        self.assertEqual(result.items[0].work_version_id, VERSION_A)
        self.assertEqual(result.items[0].final_stage, CompletionStage.ASSET_PENDING)

    async def test_unresolved_target_remains_distinct_exhaustion(self) -> None:
        # Given
        completion, _, owners = pipeline(CompletionStage.ASSET_PENDING)
        owners[0].version = None

        # When
        result = await run_completion_batch(
            completion,
            (DoiTarget("10.1234/missing"),),
            CompletionStop.COMPLETE,
        )

        # Then
        self.assertEqual(result.counts.exhausted, 1)
        self.assertIsNone(result.items[0].work_version_id)
        self.assertIsNone(result.items[0].result)

    async def test_failure_before_resolved_facts_remains_identityless(self) -> None:
        # Given
        completion, _, _ = pipeline(CompletionStage.ASSET_PENDING)

        # When
        result = await run_completion_batch(
            completion,
            (WorkVersionTarget(VERSION_B),),
            CompletionStop.COMPLETE,
        )

        # Then
        self.assertEqual(result.counts.failed, 1)
        self.assertIsNone(result.items[0].work_version_id)
        self.assertIsNone(result.items[0].final_stage)


class ProgressCountContractTests(unittest.TestCase):
    def test_progress_count_has_canonical_ordered_vocabulary(self) -> None:
        # Given / When
        values = tuple(item.value for item in ProgressCount)

        # Then
        self.assertEqual(values, (
            "provider_returned", "deduplicated_works", "created", "reused",
            "selected", "unique_targets", "succeeded", "exhausted", "failed",
            "duplicates", "interrupted", "accepted", "missing",
            "analysis_succeeded", "analysis_failed", "discovered", "existing", "completed",
        ))

    def test_invocation_counts_reconcile_and_project_aliases(self) -> None:
        # Given / When
        counts = InvocationCounts(
            selected=5,
            unique_targets=4,
            succeeded=1,
            exhausted=1,
            failed=1,
            duplicates=1,
            interrupted=1,
        )

        # Then
        self.assertEqual(counts.selected,
                         counts.succeeded + counts.exhausted + counts.failed
                         + counts.duplicates + counts.interrupted)
        self.assertEqual(counts.unique_targets, counts.selected - counts.duplicates)
        self.assertEqual((counts.accepted, counts.missing), (1, 1))
        self.assertEqual((counts.analysis_succeeded, counts.analysis_failed), (1, 2))
        self.assertEqual(tuple(counts.to_dict()), (
            "selected", "unique_targets", "succeeded", "exhausted", "failed",
            "duplicates", "interrupted", "accepted", "missing",
            "analysis_succeeded", "analysis_failed",
        ))

    def test_stop_specific_count_projection_uses_shared_vocabulary(self) -> None:
        # Given
        counts = InvocationCounts(2, 2, 0, 1, 1, 0, 0)

        # When
        asset = counts.to_dict(CompletionStop.ASSET)
        analysis = counts.to_dict(CompletionStop.COMPLETE)
        metadata = counts.to_dict(CompletionStop.METADATA)

        # Then
        self.assertEqual((asset["accepted"], asset["missing"]), (0, 1))
        self.assertNotIn("analysis_succeeded", asset)
        self.assertEqual((analysis["analysis_succeeded"], analysis["analysis_failed"]), (0, 2))
        self.assertNotIn("accepted", analysis)
        self.assertNotIn("accepted", metadata)
        self.assertNotIn("analysis_succeeded", metadata)

    def test_invocation_counts_reject_malformed_equations_and_negative_values(self) -> None:
        # Given
        invalid = (
            (4, 4, 1, 1, 0, 1, 0),
            (5, 5, 1, 1, 1, 1, 1),
            (0, 0, 0, -1, 0, 0, 1),
        )

        # When / Then
        for values in invalid:
            with self.subTest(values=values), self.assertRaises(ValueError):
                InvocationCounts(*values)

    def test_batch_result_uses_one_immutable_count_projection(self) -> None:
        # Given
        items = (
            BatchItemResult.succeeded(
                WorkVersionTarget(VERSION_A), VERSION_A, CompletionStage.COMPLETE,
            ),
            BatchItemResult.exhausted(WorkVersionTarget(VERSION_B)),
            BatchItemResult.duplicate(WorkVersionTarget(VERSION_A), VERSION_A, 0),
            BatchItemResult.failed(
                DoiTarget("10.1234/failed"), OutcomeReason.UNEXPECTED_FAILURE,
            ),
            BatchItemResult.interrupted(DoiTarget("10.1234/interrupted")),
        )

        # When
        result = BatchResult(BatchPolicy(), items)
        rendered = json.dumps(result.to_dict(), sort_keys=True)

        # Then
        self.assertEqual(result.counts, InvocationCounts(5, 4, 1, 1, 1, 1, 1))
        self.assertEqual(json.loads(rendered)["exhausted"], 1)
        with self.assertRaises(FrozenInstanceError):
            setattr(result.counts, "succeeded", 2)

    def test_duplicate_rejects_malformed_failed_identity_reference(self) -> None:
        # Given
        failed = BatchItemResult.failed(
            WorkVersionTarget(VERSION_A), OutcomeReason.UNEXPECTED_FAILURE,
            VERSION_A, CompletionStage.ANALYSIS_PENDING,
        )
        malformed = BatchItemResult.duplicate(
            WorkVersionTarget(VERSION_B), VERSION_B, 0,
        )

        # When / Then
        with self.assertRaisesRegex(
            ValueError, "duplicate must resolve to the earlier WorkVersion",
        ):
            BatchResult(BatchPolicy(), (failed, malformed))


class CatalogCountSnapshotTests(unittest.TestCase):
    def test_catalog_counts_derive_from_one_passed_fact_snapshot(self) -> None:
        # Given
        snapshot = (
            self._facts(VERSION_A, CompletionStage.METADATA_PENDING),
            self._facts(VERSION_B, CompletionStage.COMPLETE),
        )

        # When
        counts = CatalogCounts.from_snapshot(snapshot)

        # Then
        self.assertEqual(counts.to_dict(), {
            "metadata_pending": 1,
            "asset_pending": 0,
            "analysis_pending": 0,
            "complete": 1,
            "total": 2,
        })

    @staticmethod
    def _facts(work_version_id: str, stage: CompletionStage) -> CompletionFacts:
        ready = stage is CompletionStage.COMPLETE
        return CompletionFacts(
            work_version_id,
            stage,
            stage is not CompletionStage.METADATA_PENDING,
            ready,
            ready,
            VERSION_A if ready else None,
            "a" * 64 if ready else None,
            VERSION_B if ready else None,
            1 if ready else 0,
        )


if __name__ == "__main__":
    unittest.main()
