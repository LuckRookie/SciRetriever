from __future__ import annotations

import unittest

from sciretriever.core.execution import (
    derive_process_batch_status,
    nonexecuted_target_result,
    recover_interrupted_target,
    select_actual_targets,
    state_counts,
    steps_to_target,
)
from sciretriever.model.execution import (
    ExecutionCandidate,
    RecoveryTarget,
    TargetResult,
)
from sciretriever.model.primitives import (
    BatchRunId,
    BatchStatus,
    MissingStep,
    WorkVersionId,
    WorkVersionState,
)

BATCH_ID = BatchRunId("10000000-0000-0000-0000-000000000001")
VERSION_A = WorkVersionId("20000000-0000-0000-0000-000000000001")
VERSION_B = WorkVersionId("20000000-0000-0000-0000-000000000002")
VERSION_C = WorkVersionId("20000000-0000-0000-0000-000000000003")


def result(
    version_id: WorkVersionId,
    outcome: str,
    initial: str = "unreviewed",
    final: str = "unreviewed",
) -> TargetResult:
    return TargetResult.model_validate(
        {
            "subject_type": "work-version",
            "subject_id": str(version_id),
            "outcome": outcome,
            "initial_state": initial,
            "target_state": "completed",
            "final_state": final,
            "stage": None,
            "failure": None,
        }
    )


class ExecutionCoreTests(unittest.TestCase):
    def test_actual_targets_are_deduplicated_sorted_and_filtered_before_limit(self) -> None:
        candidates = (
            ExecutionCandidate(work_version_id=VERSION_C, state=WorkVersionState.COMPLETED),
            ExecutionCandidate(work_version_id=VERSION_B, state=WorkVersionState.UNREVIEWED),
            ExecutionCandidate(work_version_id=VERSION_A, state=WorkVersionState.ASSET_READY),
            ExecutionCandidate(work_version_id=VERSION_A, state=WorkVersionState.ASSET_READY),
        )

        actual = select_actual_targets(candidates, WorkVersionState.COMPLETED, limit=2)

        self.assertEqual(
            tuple((item.work_version_id, item.initial_state, item.missing_step) for item in actual),
            (
                (VERSION_A, WorkVersionState.ASSET_READY, MissingStep.LIGHT_DOCUMENT),
                (VERSION_B, WorkVersionState.UNREVIEWED, MissingStep.PRIMARY_PDF),
            ),
        )

    def test_steps_to_target_stops_at_requested_state(self) -> None:
        self.assertEqual(
            steps_to_target(WorkVersionState.UNREVIEWED, WorkVersionState.LIGHT_TEXT_READY),
            (MissingStep.PRIMARY_PDF, MissingStep.LIGHT_DOCUMENT),
        )
        self.assertEqual(
            steps_to_target(WorkVersionState.ASSET_READY, WorkVersionState.ASSET_READY),
            (),
        )

    def test_counts_and_status_distinguish_partial_failure_and_interruption(self) -> None:
        partial_counts = state_counts(
            (
                result(VERSION_A, "completed", final="completed"),
                result(VERSION_B, "failed"),
            )
        )
        failed_counts = state_counts((result(VERSION_A, "missing"), result(VERSION_B, "failed")))

        self.assertEqual((partial_counts.selected, partial_counts.completed), (2, 1))
        self.assertIs(
            derive_process_batch_status(partial_counts, interrupted=False, common_error=False),
            BatchStatus.PARTIAL,
        )
        self.assertIs(
            derive_process_batch_status(failed_counts, interrupted=False, common_error=False),
            BatchStatus.FAILED,
        )
        self.assertIs(
            derive_process_batch_status(partial_counts, interrupted=True, common_error=False),
            BatchStatus.INTERRUPTED,
        )

    def test_recovery_uses_committed_state_without_resuming_old_work(self) -> None:
        cases = (
            (
                RecoveryTarget(
                    batch_run_id=BATCH_ID,
                    work_version_id=VERSION_A,
                    initial_state=WorkVersionState.UNREVIEWED,
                    target_state=WorkVersionState.COMPLETED,
                    current_state=WorkVersionState.UNREVIEWED,
                    started=False,
                    result=None,
                ),
                "not-started",
            ),
            (
                RecoveryTarget(
                    batch_run_id=BATCH_ID,
                    work_version_id=VERSION_A,
                    initial_state=WorkVersionState.UNREVIEWED,
                    target_state=WorkVersionState.COMPLETED,
                    current_state=WorkVersionState.ASSET_READY,
                    started=True,
                    result=None,
                ),
                "partially-advanced",
            ),
            (
                RecoveryTarget(
                    batch_run_id=BATCH_ID,
                    work_version_id=VERSION_A,
                    initial_state=WorkVersionState.UNREVIEWED,
                    target_state=WorkVersionState.COMPLETED,
                    current_state=WorkVersionState.COMPLETED,
                    started=True,
                    result=None,
                ),
                "completed",
            ),
            (
                RecoveryTarget(
                    batch_run_id=BATCH_ID,
                    work_version_id=VERSION_A,
                    initial_state=WorkVersionState.UNREVIEWED,
                    target_state=WorkVersionState.COMPLETED,
                    current_state=WorkVersionState.UNREVIEWED,
                    started=True,
                    result=None,
                ),
                "failed",
            ),
            (
                RecoveryTarget(
                    batch_run_id=BATCH_ID,
                    work_version_id=VERSION_A,
                    initial_state=WorkVersionState.UNREVIEWED,
                    target_state=WorkVersionState.COMPLETED,
                    current_state=None,
                    started=True,
                    result=None,
                ),
                "skipped",
            ),
        )
        for target, expected in cases:
            with self.subTest(started=target.started, current=target.current_state):
                self.assertEqual(recover_interrupted_target(target).outcome, expected)

        persisted = result(VERSION_B, "missing")
        preserved = recover_interrupted_target(
            RecoveryTarget(
                batch_run_id=BATCH_ID,
                work_version_id=VERSION_B,
                initial_state=WorkVersionState.UNREVIEWED,
                target_state=WorkVersionState.COMPLETED,
                current_state=WorkVersionState.UNREVIEWED,
                started=True,
                result=persisted,
            )
        )
        self.assertIs(preserved, persisted)

    def test_nonexecuted_target_distinguishes_skipped_from_not_started(self) -> None:
        target = select_actual_targets(
            (ExecutionCandidate(work_version_id=VERSION_A, state=WorkVersionState.UNREVIEWED),),
            WorkVersionState.COMPLETED,
            limit=1,
        )[0]

        self.assertEqual(nonexecuted_target_result(target, "skipped").outcome, "skipped")
        self.assertEqual(
            nonexecuted_target_result(target, "not-started").outcome,
            "not-started",
        )


if __name__ == "__main__":
    unittest.main()
