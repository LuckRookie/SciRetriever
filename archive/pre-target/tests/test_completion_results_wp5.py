import json
import unittest
from dataclasses import FrozenInstanceError

from sciretriever.catalog import CompletionStage
from sciretriever.completion import (
    CompletionAction, CompletionResult, CompletionStop, DoiTarget,
    OutcomeDisposition, OutcomeReason, StageOutcome, WorkVersionTarget,
)

VERSION_A = "11111111-1111-4111-8111-111111111111"
VERSION_B = "22222222-2222-4222-8222-222222222222"


class CompletionResultTests(unittest.TestCase):
    def test_result_is_immutable_and_json_ready_without_secrets(self) -> None:
        target = WorkVersionTarget(VERSION_A)
        outcome = StageOutcome(
            CompletionAction.ACQUIRE_PRIMARY,
            OutcomeDisposition.ADVANCED,
            OutcomeReason.SUCCEEDED,
            CompletionStage.ASSET_PENDING,
            CompletionStage.ANALYSIS_PENDING,
        )
        result = CompletionResult(
            target=target,
            work_version_id=VERSION_A,
            requested_stop=CompletionStop.ASSET,
            initial_stage=CompletionStage.ASSET_PENDING,
            final_stage=CompletionStage.ANALYSIS_PENDING,
            outcomes=(outcome,),
        )

        rendered = json.dumps(result.to_dict(), sort_keys=True)
        self.assertIn('"final_stage": "analysis_pending"', rendered)
        self.assertNotIn("token", rendered.lower())
        with self.assertRaises(FrozenInstanceError):
            setattr(result, "final_stage", CompletionStage.COMPLETE)

    def test_result_rejects_non_monotonic_stage(self) -> None:
        with self.assertRaises(ValueError):
            CompletionResult(
                WorkVersionTarget(VERSION_A), VERSION_A, CompletionStop.COMPLETE,
                CompletionStage.COMPLETE, CompletionStage.ANALYSIS_PENDING, (),
            )

    def test_work_version_target_must_match_resolved_version(self) -> None:
        with self.assertRaises(ValueError):
            CompletionResult(
                WorkVersionTarget(VERSION_A), VERSION_B, CompletionStop.METADATA,
                CompletionStage.ASSET_PENDING, CompletionStage.ASSET_PENDING, (),
            )
        result = CompletionResult(
            DoiTarget("10.1234/new-version"), VERSION_B, CompletionStop.METADATA,
            CompletionStage.ASSET_PENDING, CompletionStage.ASSET_PENDING, (),
        )
        self.assertEqual(result.work_version_id, VERSION_B)

    def test_outcomes_must_be_exact_action_prefix(self) -> None:
        wrong_action = StageOutcome(
            CompletionAction.ACQUIRE_PRIMARY, OutcomeDisposition.ADVANCED,
            OutcomeReason.SUCCEEDED, CompletionStage.ASSET_PENDING,
            CompletionStage.ANALYSIS_PENDING,
        )
        extra_action = StageOutcome(
            CompletionAction.PROMOTE_ANALYSIS, OutcomeDisposition.ADVANCED,
            OutcomeReason.SUCCEEDED, CompletionStage.ANALYSIS_PENDING,
            CompletionStage.COMPLETE,
        )
        with self.assertRaises(ValueError):
            CompletionResult(
                WorkVersionTarget(VERSION_A), VERSION_A, CompletionStop.METADATA,
                CompletionStage.ASSET_PENDING, CompletionStage.ANALYSIS_PENDING,
                (wrong_action,),
            )
        with self.assertRaises(ValueError):
            CompletionResult(
                WorkVersionTarget(VERSION_A), VERSION_A, CompletionStop.ASSET,
                CompletionStage.ASSET_PENDING, CompletionStage.COMPLETE,
                (wrong_action, extra_action),
            )

    def test_non_exhausted_result_must_reach_stop_ceiling(self) -> None:
        cases = (
            (CompletionStop.METADATA, CompletionStage.METADATA_PENDING),
            (CompletionStop.ASSET, CompletionStage.ASSET_PENDING),
            (CompletionStop.COMPLETE, CompletionStage.ANALYSIS_PENDING),
        )
        for stop, final_stage in cases:
            with self.subTest(stop=stop), self.assertRaises(ValueError):
                CompletionResult(
                    WorkVersionTarget(VERSION_A), VERSION_A, stop,
                    final_stage, final_stage, (),
                )

    def test_empty_result_is_only_an_already_satisfied_no_op(self) -> None:
        CompletionResult(
            WorkVersionTarget(VERSION_A), VERSION_A, CompletionStop.ASSET,
            CompletionStage.ANALYSIS_PENDING, CompletionStage.ANALYSIS_PENDING, (),
        )
        with self.assertRaises(ValueError):
            CompletionResult(
                WorkVersionTarget(VERSION_A), VERSION_A, CompletionStop.COMPLETE,
                CompletionStage.ANALYSIS_PENDING, CompletionStage.ANALYSIS_PENDING, (),
            )

    def test_expected_exhaustion_may_end_an_exact_action_prefix(self) -> None:
        exhausted = StageOutcome(
            CompletionAction.ACQUIRE_PRIMARY, OutcomeDisposition.NOT_ADVANCED,
            OutcomeReason.EXHAUSTED, CompletionStage.ASSET_PENDING,
            CompletionStage.ASSET_PENDING,
        )
        result = CompletionResult(
            WorkVersionTarget(VERSION_A), VERSION_A, CompletionStop.COMPLETE,
            CompletionStage.ASSET_PENDING, CompletionStage.ASSET_PENDING, (exhausted,),
        )
        self.assertEqual(result.outcomes, (exhausted,))

    def test_not_advanced_outcome_must_be_terminal(self) -> None:
        already = StageOutcome(
            CompletionAction.RESOLVE_METADATA, OutcomeDisposition.NOT_ADVANCED,
            OutcomeReason.ALREADY_SATISFIED, CompletionStage.METADATA_PENDING,
            CompletionStage.METADATA_PENDING,
        )
        advanced = StageOutcome(
            CompletionAction.ACQUIRE_PRIMARY, OutcomeDisposition.ADVANCED,
            OutcomeReason.SUCCEEDED, CompletionStage.ASSET_PENDING,
            CompletionStage.ANALYSIS_PENDING,
        )
        with self.assertRaises(ValueError):
            CompletionResult(
                DoiTarget("10.1234/terminal"), VERSION_A, CompletionStop.ASSET,
                CompletionStage.METADATA_PENDING, CompletionStage.ANALYSIS_PENDING,
                (already, advanced),
            )

    def test_result_rejects_incomplete_empty_and_extra_action_chains(self) -> None:
        metadata = StageOutcome(CompletionAction.RESOLVE_METADATA, OutcomeDisposition.ADVANCED,
                                OutcomeReason.SUCCEEDED, CompletionStage.METADATA_PENDING,
                                CompletionStage.ASSET_PENDING)
        asset = StageOutcome(CompletionAction.ACQUIRE_PRIMARY, OutcomeDisposition.ADVANCED,
                             OutcomeReason.SUCCEEDED, CompletionStage.ASSET_PENDING,
                             CompletionStage.ANALYSIS_PENDING)
        invalid = (
            (CompletionStop.COMPLETE, CompletionStage.METADATA_PENDING, CompletionStage.METADATA_PENDING, ()),
            (CompletionStop.METADATA, CompletionStage.METADATA_PENDING, CompletionStage.ANALYSIS_PENDING,
             (metadata, asset)),
            (CompletionStop.COMPLETE, CompletionStage.METADATA_PENDING, CompletionStage.ASSET_PENDING,
             (metadata,)),
        )
        for stop, initial, final, outcomes in invalid:
            with self.subTest(stop=stop, final=final), self.assertRaises(ValueError):
                CompletionResult(WorkVersionTarget(VERSION_A), VERSION_A, stop, initial, final, outcomes)

    def test_result_accepts_expected_exhaustion_and_already_satisfied_noop(self) -> None:
        exhausted = StageOutcome(CompletionAction.ACQUIRE_PRIMARY, OutcomeDisposition.NOT_ADVANCED,
                                 OutcomeReason.EXHAUSTED, CompletionStage.ASSET_PENDING,
                                 CompletionStage.ASSET_PENDING)
        result = CompletionResult(WorkVersionTarget(VERSION_A), VERSION_A, CompletionStop.COMPLETE,
                                  CompletionStage.ASSET_PENDING, CompletionStage.ASSET_PENDING, (exhausted,))
        noop = CompletionResult(WorkVersionTarget(VERSION_A), VERSION_A, CompletionStop.METADATA,
                                CompletionStage.COMPLETE, CompletionStage.COMPLETE, ())
        self.assertEqual(result.outcomes[-1].reason, OutcomeReason.EXHAUSTED)
        self.assertEqual(noop.outcomes, ())

    def test_result_enforces_existing_target_identity_but_allows_doi_resolution(self) -> None:
        with self.assertRaises(ValueError):
            CompletionResult(WorkVersionTarget(VERSION_A), VERSION_B, CompletionStop.COMPLETE,
                             CompletionStage.COMPLETE, CompletionStage.COMPLETE, ())
        metadata = StageOutcome(CompletionAction.RESOLVE_METADATA, OutcomeDisposition.ADVANCED,
                                OutcomeReason.SUCCEEDED, CompletionStage.METADATA_PENDING,
                                CompletionStage.ASSET_PENDING)
        resolved = CompletionResult(DoiTarget("10.1234/new"), VERSION_B, CompletionStop.METADATA,
                                    CompletionStage.METADATA_PENDING, CompletionStage.ASSET_PENDING,
                                    (metadata,))
        self.assertEqual(resolved.work_version_id, VERSION_B)
