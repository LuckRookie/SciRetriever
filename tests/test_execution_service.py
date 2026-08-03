from __future__ import annotations

import unittest

from execution_service_support import (
    FakeGuard,
    FakeRepository,
    FakeStepProcessor,
    ToggleInterruption,
    recovery_batch,
)

from sciretriever.model.execution import (
    ProcessBatchScope,
    ProcessSelector,
    RecoveryTarget,
    StateCounts,
    TargetResult,
)
from sciretriever.model.primitives import (
    BatchRunId,
    BatchStatus,
    MissingStep,
    UtcTimestamp,
    WorkVersionId,
    WorkVersionState,
)
from sciretriever.services.execution import ExecutionService, ExecutionServiceDependencies

BATCH_ID = BatchRunId("10000000-0000-0000-0000-000000000001")
VERSION_A = WorkVersionId("20000000-0000-0000-0000-000000000001")
VERSION_B = WorkVersionId("20000000-0000-0000-0000-000000000002")
VERSION_C = WorkVersionId("20000000-0000-0000-0000-000000000003")


def scope(*version_ids: WorkVersionId) -> ProcessBatchScope:
    return ProcessBatchScope(
        kind="process",
        selector=ProcessSelector(kind="versions", ids=tuple(map(str, version_ids)), query=None),
        trigger_collection_run_id=None,
        selected_version_ids=version_ids,
        include_all_versions=False,
        target_state="completed",
        limit=100,
    )


def clock() -> UtcTimestamp:
    return UtcTimestamp("2026-08-03T00:00:00Z")


class ExecutionServiceTests(unittest.TestCase):
    def test_satisfied_scope_finishes_no_target_without_entering_running(self) -> None:
        repository = FakeRepository({VERSION_A: WorkVersionState.COMPLETED})
        service = ExecutionService(
            ExecutionServiceDependencies(
                repository=repository,
                acquire_core_write=lambda: FakeGuard(repository.events),
                clock=clock,
                processors=(),
            )
        )

        detail = service.run_process(scope(VERSION_A))

        self.assertIs(detail.status, BatchStatus.NO_TARGET)
        self.assertIsNone(detail.started_at)
        self.assertFalse(any(event.startswith("batch-start:") for event in repository.events))

    def test_missing_shared_capability_fails_batch_without_starting_targets(self) -> None:
        repository = FakeRepository(
            {
                VERSION_A: WorkVersionState.UNREVIEWED,
                VERSION_B: WorkVersionState.UNREVIEWED,
            }
        )
        service = ExecutionService(
            ExecutionServiceDependencies(
                repository=repository,
                acquire_core_write=lambda: FakeGuard(repository.events),
                clock=clock,
                processors=(FakeStepProcessor(MissingStep.PRIMARY_PDF, repository),),
            )
        )

        detail = service.run_process(scope(VERSION_A, VERSION_B))

        self.assertIs(detail.status, BatchStatus.FAILED)
        self.assertEqual(detail.common_error.code, "required-capability-unavailable")
        self.assertTrue(detail.common_error.retryable)
        self.assertEqual(
            tuple(item.outcome for item in detail.results), ("not-started", "not-started")
        )
        self.assertEqual(
            tuple(started for _batch_id, _envelope, started in repository.results), (False, False)
        )
        self.assertFalse(any(event.startswith("target-start:") for event in repository.events))

    def test_target_specific_missing_capability_does_not_block_runnable_target(self) -> None:
        repository = FakeRepository(
            {
                VERSION_A: WorkVersionState.ASSET_READY,
                VERSION_B: WorkVersionState.UNREVIEWED,
            }
        )
        run_scope = scope(VERSION_A, VERSION_B).model_copy(
            update={"target_state": "light-text-ready"}
        )
        service = ExecutionService(
            ExecutionServiceDependencies(
                repository=repository,
                acquire_core_write=lambda: FakeGuard(repository.events),
                clock=clock,
                processors=(FakeStepProcessor(MissingStep.LIGHT_DOCUMENT, repository),),
            )
        )

        detail = service.run_process(run_scope)

        self.assertIs(detail.status, BatchStatus.PARTIAL)
        self.assertIsNone(detail.common_error)
        self.assertEqual(
            tuple(item.outcome for item in detail.results), ("completed", "not-started")
        )
        self.assertEqual(
            tuple(
                (str(envelope.result.subject_id), started)
                for _batch_id, envelope, started in repository.results
            ),
            ((str(VERSION_B), False),),
        )
        self.assertIs(repository.states[VERSION_A], WorkVersionState.LIGHT_TEXT_READY)
        self.assertIs(repository.states[VERSION_B], WorkVersionState.UNREVIEWED)

    def test_partial_success_commits_each_stage_and_closes_abandoned_run(self) -> None:
        repository = FakeRepository(
            {
                VERSION_A: WorkVersionState.UNREVIEWED,
                VERSION_B: WorkVersionState.COMPLETED,
                VERSION_C: WorkVersionState.ASSET_READY,
            }
        )
        run_scope = scope(VERSION_A, VERSION_B, VERSION_C)
        repository.recoverable = (
            recovery_batch(
                BATCH_ID,
                run_scope,
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
                ),
            ),
        )
        processors = (
            FakeStepProcessor(MissingStep.PRIMARY_PDF, repository),
            FakeStepProcessor(
                MissingStep.LIGHT_DOCUMENT,
                repository,
                missing=frozenset({VERSION_C}),
            ),
            FakeStepProcessor(MissingStep.COMPLETION, repository),
        )
        service = ExecutionService(
            ExecutionServiceDependencies(
                repository=repository,
                acquire_core_write=lambda: FakeGuard(repository.events),
                clock=clock,
                processors=processors,
            )
        )

        detail = service.run_process(run_scope)

        self.assertEqual(repository.events[:3], ["admission-enter", "recover", "select"])
        self.assertIs(repository.details[0].status, BatchStatus.INTERRUPTED)
        self.assertIs(detail.status, BatchStatus.PARTIAL)
        assert isinstance(detail.counts, StateCounts)
        self.assertEqual(detail.counts.completed, 1)
        self.assertEqual(detail.counts.missing, 1)
        target_results = tuple(item for item in detail.results if isinstance(item, TargetResult))
        self.assertEqual(len(target_results), len(detail.results))
        self.assertEqual(
            tuple(item.subject_id for item in target_results), (str(VERSION_A), str(VERSION_C))
        )
        self.assertEqual(len(repository.results), 2)
        self.assertIs(repository.states[VERSION_A], WorkVersionState.COMPLETED)
        self.assertIs(repository.states[VERSION_C], WorkVersionState.ASSET_READY)

    def test_interruption_stops_new_targets_and_rerun_selects_only_remaining_work(self) -> None:
        repository = FakeRepository(
            {
                VERSION_A: WorkVersionState.UNREVIEWED,
                VERSION_B: WorkVersionState.UNREVIEWED,
            }
        )
        interruption = ToggleInterruption()
        first_processors = (
            FakeStepProcessor(MissingStep.PRIMARY_PDF, repository),
            FakeStepProcessor(MissingStep.LIGHT_DOCUMENT, repository),
            FakeStepProcessor(
                MissingStep.COMPLETION,
                repository,
                interruption=interruption,
                interrupt_after=VERSION_A,
            ),
        )
        first = ExecutionService(
            ExecutionServiceDependencies(
                repository=repository,
                acquire_core_write=lambda: FakeGuard(repository.events),
                clock=clock,
                processors=first_processors,
            )
        ).run_process(scope(VERSION_A, VERSION_B), interruption)

        self.assertIs(first.status, BatchStatus.INTERRUPTED)
        self.assertEqual(
            tuple(item.outcome for item in first.results), ("completed", "not-started")
        )
        self.assertIs(repository.states[VERSION_B], WorkVersionState.UNREVIEWED)

        second_processors = (
            FakeStepProcessor(MissingStep.PRIMARY_PDF, repository),
            FakeStepProcessor(MissingStep.LIGHT_DOCUMENT, repository),
            FakeStepProcessor(MissingStep.COMPLETION, repository),
        )
        second = ExecutionService(
            ExecutionServiceDependencies(
                repository=repository,
                acquire_core_write=lambda: FakeGuard(repository.events),
                clock=clock,
                processors=second_processors,
            )
        ).run_process(scope(VERSION_A, VERSION_B))

        self.assertIs(second.status, BatchStatus.COMPLETED)
        target_results = tuple(item for item in second.results if isinstance(item, TargetResult))
        self.assertEqual(len(target_results), len(second.results))
        self.assertEqual(tuple(item.subject_id for item in target_results), (str(VERSION_B),))
        self.assertIs(repository.states[VERSION_B], WorkVersionState.COMPLETED)


if __name__ == "__main__":
    unittest.main()
