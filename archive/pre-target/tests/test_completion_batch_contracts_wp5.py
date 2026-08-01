import json
import unittest

from sciretriever.catalog import CompletionStage
from sciretriever.completion import (
    AnalysisPromotionRequest, BatchItemResult, BatchItemStatus, BatchPolicy,
    BatchResult, CompletionAction, CompletionResult, CompletionStop, DoiTarget,
    ForceAnalysisRequest, ForceAnalysisResult, OptionalAssetKind,
    OptionalAssetRequest, OptionalAssetResult, OutcomeDisposition,
    OutcomeReason, StageOutcome, WorkVersionTarget,
)

VERSION_A = "11111111-1111-4111-8111-111111111111"
VERSION_B = "22222222-2222-4222-8222-222222222222"


class BatchContractTests(unittest.TestCase):
    def _completion_result(self) -> CompletionResult:
        outcome = StageOutcome(
            CompletionAction.ACQUIRE_PRIMARY, OutcomeDisposition.ADVANCED,
            OutcomeReason.SUCCEEDED, CompletionStage.ASSET_PENDING,
            CompletionStage.ANALYSIS_PENDING,
        )
        return CompletionResult(
            WorkVersionTarget(VERSION_A), VERSION_A, CompletionStop.ASSET,
            CompletionStage.ASSET_PENDING, CompletionStage.ANALYSIS_PENDING, (outcome,),
        )

    def test_batch_preserves_order_and_deduplicates_resolved_versions(self) -> None:
        first = BatchItemResult.succeeded(
            DoiTarget("10.1234/a"), VERSION_A, CompletionStage.ASSET_PENDING,
        )
        duplicate = BatchItemResult.duplicate(
            WorkVersionTarget(VERSION_A), VERSION_A, 0,
        )
        failed = BatchItemResult.failed(
            WorkVersionTarget(VERSION_B), OutcomeReason.UNEXPECTED_FAILURE,
        )
        result = BatchResult(BatchPolicy(), (first, duplicate, failed))

        self.assertEqual(tuple(item.target for item in result.items),
                         (first.target, duplicate.target, failed.target))
        self.assertEqual(result.succeeded, 1)
        self.assertEqual(result.failed, 1)
        self.assertEqual(result.duplicates, 1)
        self.assertEqual(json.loads(json.dumps(result.to_dict()))["failed"], 1)

    def test_interruption_requires_current_and_unstarted_suffix(self) -> None:
        interrupted = BatchItemResult.interrupted(WorkVersionTarget(VERSION_A))
        unstarted = BatchItemResult.interrupted(WorkVersionTarget(VERSION_B))
        result = BatchResult(BatchPolicy(), (interrupted, unstarted))

        self.assertTrue(result.interrupted)
        self.assertTrue(all(item.status is BatchItemStatus.INTERRUPTED for item in result.items))
        with self.assertRaises(ValueError):
            BatchResult(BatchPolicy(), (interrupted, BatchItemResult.failed(
                WorkVersionTarget(VERSION_B), OutcomeReason.UNEXPECTED_FAILURE,
            )))

    def test_status_fields_are_mutually_exclusive(self) -> None:
        invalid = (
            lambda: BatchItemResult(
                WorkVersionTarget(VERSION_A), BatchItemStatus.SUCCEEDED,
                VERSION_A, CompletionStage.COMPLETE,
                reason=OutcomeReason.ALREADY_SATISFIED,
            ),
            lambda: BatchItemResult(
                WorkVersionTarget(VERSION_A), BatchItemStatus.DUPLICATE,
                VERSION_A, final_stage=CompletionStage.COMPLETE, duplicate_of=0,
            ),
            lambda: BatchItemResult(
                WorkVersionTarget(VERSION_A), BatchItemStatus.FAILED,
                VERSION_A, CompletionStage.COMPLETE,
                reason=OutcomeReason.UNEXPECTED_FAILURE, duplicate_of=0,
            ),
            lambda: BatchItemResult(
                WorkVersionTarget(VERSION_A), BatchItemStatus.INTERRUPTED,
                VERSION_A, CompletionStage.COMPLETE,
                reason=OutcomeReason.INTERRUPTED,
            ),
        )
        for constructor in invalid:
            with self.subTest(constructor=constructor), self.assertRaises(ValueError):
                constructor()

    def test_successful_nested_result_must_align(self) -> None:
        result = self._completion_result()
        BatchItemResult.succeeded(result.target, VERSION_A,
                                  CompletionStage.ANALYSIS_PENDING, result)
        mismatches = (
            (WorkVersionTarget(VERSION_B), VERSION_A, CompletionStage.ANALYSIS_PENDING),
            (result.target, VERSION_B, CompletionStage.ANALYSIS_PENDING),
            (result.target, VERSION_A, CompletionStage.COMPLETE),
        )
        for target, version_id, stage in mismatches:
            with self.subTest(target=target, version_id=version_id, stage=stage):
                with self.assertRaises(ValueError):
                    BatchItemResult.succeeded(target, version_id, stage, result)

    def test_duplicate_has_only_version_and_prior_index(self) -> None:
        duplicate = BatchItemResult.duplicate(
            WorkVersionTarget(VERSION_A), VERSION_A, 0,
        )
        self.assertIsNone(duplicate.reason)
        self.assertIsNone(duplicate.final_stage)
        self.assertIsNone(duplicate.result)

    def test_batch_item_rejects_fields_owned_by_other_statuses(self) -> None:
        target = WorkVersionTarget(VERSION_A)
        complete = CompletionResult(target, VERSION_A, CompletionStop.COMPLETE,
                                    CompletionStage.COMPLETE, CompletionStage.COMPLETE, ())
        with self.assertRaises(ValueError):
            BatchItemResult(target, BatchItemStatus.FAILED, VERSION_A,
                            reason=OutcomeReason.UNEXPECTED_FAILURE)
        with self.assertRaises(ValueError):
            BatchItemResult(target, BatchItemStatus.INTERRUPTED,
                            final_stage=CompletionStage.COMPLETE, reason=OutcomeReason.INTERRUPTED)
        with self.assertRaises(ValueError):
            BatchItemResult(target, BatchItemStatus.DUPLICATE, VERSION_A,
                            CompletionStage.COMPLETE, complete,
                            OutcomeReason.ALREADY_SATISFIED, 0)
        with self.assertRaises(ValueError):
            BatchItemResult(target, BatchItemStatus.SUCCEEDED, VERSION_A,
                            CompletionStage.COMPLETE, duplicate_of=0)

    def test_successful_batch_item_requires_aligned_completion_result(self) -> None:
        target = WorkVersionTarget(VERSION_A)
        result = CompletionResult(target, VERSION_A, CompletionStop.COMPLETE,
                                  CompletionStage.COMPLETE, CompletionStage.COMPLETE, ())
        with self.assertRaises(ValueError):
            BatchItemResult.succeeded(target, VERSION_B, CompletionStage.COMPLETE, result)
        with self.assertRaises(ValueError):
            BatchItemResult.succeeded(target, VERSION_A, CompletionStage.ANALYSIS_PENDING, result)


class OrthogonalOperationContractTests(unittest.TestCase):
    def test_analysis_replacement_requires_expected_current_id(self) -> None:
        AnalysisPromotionRequest(VERSION_A)
        AnalysisPromotionRequest(VERSION_A, VERSION_B, replace_current=True)
        with self.assertRaises(ValueError):
            AnalysisPromotionRequest(VERSION_A, replace_current=True)
        with self.assertRaises(ValueError):
            AnalysisPromotionRequest(VERSION_A, VERSION_B, replace_current=False)

    def test_analysis_promotion_request_preserves_compare_and_swap_intent(self) -> None:
        valid = AnalysisPromotionRequest(VERSION_A, VERSION_B, replace_current=True)
        self.assertTrue(valid.replace_current)
        with self.assertRaises(ValueError):
            AnalysisPromotionRequest(VERSION_A, VERSION_B, replace_current=False)
        with self.assertRaises(ValueError):
            AnalysisPromotionRequest(VERSION_A, replace_current=True)

    def test_force_analysis_is_complete_revision_replacement(self) -> None:
        request = ForceAnalysisRequest(WorkVersionTarget(VERSION_A), expected_revision=3)
        result = ForceAnalysisResult(request, previous_revision=3, current_revision=4,
                                     current_analysis_id=VERSION_B)

        self.assertEqual(result.stage_before, CompletionStage.COMPLETE)
        self.assertEqual(result.stage_after, CompletionStage.COMPLETE)
        self.assertEqual(result.to_dict()["current_revision"], 4)
        with self.assertRaises(ValueError):
            ForceAnalysisResult(request, 3, 3, VERSION_B)

    def test_optional_asset_result_never_changes_completion_stage(self) -> None:
        request = OptionalAssetRequest(WorkVersionTarget(VERSION_A), OptionalAssetKind.XML)
        result = OptionalAssetResult(request, OutcomeDisposition.ADVANCED,
                                     OutcomeReason.SUCCEEDED, CompletionStage.COMPLETE)

        self.assertEqual(result.stage_before, result.stage_after)
        self.assertEqual(request.kind, OptionalAssetKind.XML)
        self.assertEqual(result.to_dict()["stage_after"], "complete")

    def test_optional_asset_result_enforces_disposition_reason_pairs(self) -> None:
        request = OptionalAssetRequest(WorkVersionTarget(VERSION_A), OptionalAssetKind.HTML)
        valid = (
            (OutcomeDisposition.ADVANCED, OutcomeReason.SUCCEEDED),
            (OutcomeDisposition.NOT_ADVANCED, OutcomeReason.EXHAUSTED),
            (OutcomeDisposition.NOT_ADVANCED, OutcomeReason.ALREADY_SATISFIED),
        )
        for disposition, reason in valid:
            with self.subTest(disposition=disposition, reason=reason):
                OptionalAssetResult(request, disposition, reason,
                                    CompletionStage.ANALYSIS_PENDING)
        invalid = (
            (OutcomeDisposition.ADVANCED, OutcomeReason.EXHAUSTED),
            (OutcomeDisposition.ADVANCED, OutcomeReason.UNEXPECTED_FAILURE),
            (OutcomeDisposition.NOT_ADVANCED, OutcomeReason.SUCCEEDED),
            (OutcomeDisposition.NOT_ADVANCED, OutcomeReason.INTERRUPTED),
        )
        for disposition, reason in invalid:
            with self.subTest(disposition=disposition, reason=reason):
                with self.assertRaises(ValueError):
                    OptionalAssetResult(request, disposition, reason,
                                        CompletionStage.ANALYSIS_PENDING)

    def test_optional_asset_result_rejects_invalid_reason_disposition_pairs(self) -> None:
        request = OptionalAssetRequest(WorkVersionTarget(VERSION_A), OptionalAssetKind.HTML)
        invalid = (
            (OutcomeDisposition.ADVANCED, OutcomeReason.EXHAUSTED),
            (OutcomeDisposition.NOT_ADVANCED, OutcomeReason.SUCCEEDED),
            (OutcomeDisposition.NOT_ADVANCED, OutcomeReason.INTERRUPTED),
            (OutcomeDisposition.NOT_ADVANCED, OutcomeReason.UNEXPECTED_FAILURE),
        )
        for disposition, reason in invalid:
            with self.subTest(disposition=disposition, reason=reason), self.assertRaises(ValueError):
                OptionalAssetResult(request, disposition, reason, CompletionStage.COMPLETE)


if __name__ == "__main__":
    unittest.main()
