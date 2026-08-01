import json
import unittest
from dataclasses import FrozenInstanceError

from sciretriever.catalog import CompletionStage
from sciretriever.completion import (
    AnalysisPromotionRequest,
    BatchItemResult,
    BatchItemStatus,
    BatchPolicy,
    BatchResult,
    CompletionAction,
    CompletionResult,
    CompletionStop,
    DoiTarget,
    ForceAnalysisRequest,
    ForceAnalysisResult,
    OptionalAssetKind,
    OptionalAssetRequest,
    OptionalAssetResult,
    OutcomeDisposition,
    OutcomeReason,
    StageOutcome,
    TargetKind,
    WorkVersionTarget,
    required_actions,
)


VERSION_A = "11111111-1111-4111-8111-111111111111"
VERSION_B = "22222222-2222-4222-8222-222222222222"


class CompletionTargetTests(unittest.TestCase):
    def test_doi_target_normalizes_once_and_is_tagged(self) -> None:
        target = DoiTarget(" HTTPS://DOI.ORG/10.1234/Example ")

        self.assertEqual(target.kind, TargetKind.DOI)
        self.assertEqual(target.doi, "10.1234/example")
        with self.assertRaises(FrozenInstanceError):
            setattr(target, "doi", "10.1234/changed")

    def test_targets_reject_invalid_boundary_values(self) -> None:
        with self.assertRaises(ValueError):
            DoiTarget("not-a-doi")
        with self.assertRaises(ValueError):
            WorkVersionTarget("not-a-uuid")

    def test_work_version_target_is_canonical_and_tagged(self) -> None:
        target = WorkVersionTarget(VERSION_A)

        self.assertEqual(target.kind, TargetKind.WORK_VERSION)
        self.assertEqual(target.work_version_id, VERSION_A)


class CompletionActionTests(unittest.TestCase):
    def test_stop_set_is_exact(self) -> None:
        self.assertEqual(
            tuple(CompletionStop),
            (CompletionStop.METADATA, CompletionStop.ASSET, CompletionStop.COMPLETE),
        )

    def test_action_truth_table_is_executable(self) -> None:
        metadata = CompletionAction.RESOLVE_METADATA
        asset = CompletionAction.ACQUIRE_PRIMARY
        analysis = CompletionAction.PROMOTE_ANALYSIS
        expected = {
            (CompletionStage.METADATA_PENDING, CompletionStop.METADATA): (metadata,),
            (CompletionStage.ASSET_PENDING, CompletionStop.METADATA): (),
            (CompletionStage.ANALYSIS_PENDING, CompletionStop.METADATA): (),
            (CompletionStage.COMPLETE, CompletionStop.METADATA): (),
            (CompletionStage.METADATA_PENDING, CompletionStop.ASSET): (metadata, asset),
            (CompletionStage.ASSET_PENDING, CompletionStop.ASSET): (asset,),
            (CompletionStage.ANALYSIS_PENDING, CompletionStop.ASSET): (),
            (CompletionStage.COMPLETE, CompletionStop.ASSET): (),
            (CompletionStage.METADATA_PENDING, CompletionStop.COMPLETE): (metadata, asset, analysis),
            (CompletionStage.ASSET_PENDING, CompletionStop.COMPLETE): (asset, analysis),
            (CompletionStage.ANALYSIS_PENDING, CompletionStop.COMPLETE): (analysis,),
            (CompletionStage.COMPLETE, CompletionStop.COMPLETE): (),
        }
        self.assertEqual(
            {(stage, stop): required_actions(stage, stop) for stage, stop in expected},
            expected,
        )

    def test_stage_outcome_rejects_false_progress(self) -> None:
        with self.assertRaises(ValueError):
            StageOutcome(
                action=CompletionAction.ACQUIRE_PRIMARY,
                disposition=OutcomeDisposition.ADVANCED,
                reason=OutcomeReason.SUCCEEDED,
                before=CompletionStage.ASSET_PENDING,
                after=CompletionStage.ASSET_PENDING,
            )

    def test_stage_outcome_accepts_only_exact_success_transitions(self) -> None:
        valid = (
            (CompletionAction.RESOLVE_METADATA, CompletionStage.METADATA_PENDING,
             CompletionStage.ASSET_PENDING),
            (CompletionAction.ACQUIRE_PRIMARY, CompletionStage.ASSET_PENDING,
             CompletionStage.ANALYSIS_PENDING),
            (CompletionAction.PROMOTE_ANALYSIS, CompletionStage.ANALYSIS_PENDING,
             CompletionStage.COMPLETE),
        )
        for action, before, after in valid:
            with self.subTest(action=action):
                StageOutcome(action, OutcomeDisposition.ADVANCED,
                             OutcomeReason.SUCCEEDED, before, after)

        invalid = (
            (CompletionAction.RESOLVE_METADATA, CompletionStage.METADATA_PENDING,
             CompletionStage.ANALYSIS_PENDING, OutcomeReason.SUCCEEDED),
            (CompletionAction.ACQUIRE_PRIMARY, CompletionStage.METADATA_PENDING,
             CompletionStage.ANALYSIS_PENDING, OutcomeReason.SUCCEEDED),
            (CompletionAction.PROMOTE_ANALYSIS, CompletionStage.ANALYSIS_PENDING,
             CompletionStage.COMPLETE, OutcomeReason.UNEXPECTED_FAILURE),
            (CompletionAction.PROMOTE_ANALYSIS, CompletionStage.ANALYSIS_PENDING,
             CompletionStage.COMPLETE, OutcomeReason.INTERRUPTED),
        )
        for action, before, after, reason in invalid:
            with self.subTest(action=action, before=before, after=after, reason=reason):
                with self.assertRaises(ValueError):
                    StageOutcome(action, OutcomeDisposition.ADVANCED, reason, before, after)

    def test_stage_outcome_rejects_invalid_not_advanced_reasons(self) -> None:
        for reason in (OutcomeReason.SUCCEEDED, OutcomeReason.UNEXPECTED_FAILURE,
                       OutcomeReason.INTERRUPTED):
            with self.subTest(reason=reason), self.assertRaises(ValueError):
                StageOutcome(CompletionAction.ACQUIRE_PRIMARY,
                             OutcomeDisposition.NOT_ADVANCED, reason,
                             CompletionStage.ASSET_PENDING,
                             CompletionStage.ASSET_PENDING)

    def test_expected_exhaustion_is_a_non_exception_outcome(self) -> None:
        outcome = StageOutcome(
            action=CompletionAction.ACQUIRE_PRIMARY,
            disposition=OutcomeDisposition.NOT_ADVANCED,
            reason=OutcomeReason.EXHAUSTED,
            before=CompletionStage.ASSET_PENDING,
            after=CompletionStage.ASSET_PENDING,
        )

        self.assertEqual(outcome.reason, OutcomeReason.EXHAUSTED)

    def test_stage_outcome_rejects_wrong_action_transition_and_leap(self) -> None:
        invalid = (
            (CompletionAction.ACQUIRE_PRIMARY, CompletionStage.METADATA_PENDING, CompletionStage.ASSET_PENDING),
            (CompletionAction.RESOLVE_METADATA, CompletionStage.ASSET_PENDING, CompletionStage.ANALYSIS_PENDING),
            (CompletionAction.PROMOTE_ANALYSIS, CompletionStage.METADATA_PENDING, CompletionStage.COMPLETE),
        )
        for action, before, after in invalid:
            with self.subTest(action=action, before=before, after=after), self.assertRaises(ValueError):
                StageOutcome(action, OutcomeDisposition.ADVANCED, OutcomeReason.SUCCEEDED, before, after)

    def test_stage_outcome_rejects_invalid_reason_for_disposition(self) -> None:
        for reason in (OutcomeReason.EXHAUSTED, OutcomeReason.ALREADY_SATISFIED):
            with self.subTest(disposition="advanced", reason=reason), self.assertRaises(ValueError):
                StageOutcome(CompletionAction.RESOLVE_METADATA, OutcomeDisposition.ADVANCED, reason,
                             CompletionStage.METADATA_PENDING, CompletionStage.ASSET_PENDING)
        for reason in (OutcomeReason.SUCCEEDED, OutcomeReason.INTERRUPTED, OutcomeReason.UNEXPECTED_FAILURE):
            with self.subTest(disposition="not_advanced", reason=reason), self.assertRaises(ValueError):
                StageOutcome(CompletionAction.RESOLVE_METADATA, OutcomeDisposition.NOT_ADVANCED, reason,
                             CompletionStage.METADATA_PENDING, CompletionStage.METADATA_PENDING)

