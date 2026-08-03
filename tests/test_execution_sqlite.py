from __future__ import annotations

import unittest
from uuid import uuid4

from target_publisher_support import ScenarioFactory

from sciretriever.core.execution import select_actual_targets, state_counts
from sciretriever.infrastructure.storage.sqlite import (
    SqliteExecutionRepository,
    open_read_only_snapshot,
)
from sciretriever.model.canonical_json import CanonicalJsonObject
from sciretriever.model.collection import CollectionAcceptance
from sciretriever.model.execution import (
    BatchDetail,
    ProcessBatchScope,
    ProcessSelector,
    TargetResult,
    TargetResultEnvelope,
)
from sciretriever.model.primitives import (
    BatchRunId,
    BatchStatus,
    BatchType,
    PublicationPhase,
    UtcTimestamp,
    WorkVersionState,
)


class ExecutionSqliteTests(unittest.TestCase):
    def test_repository_persists_lifecycle_and_reconstructs_running_targets(self) -> None:
        factory = ScenarioFactory()
        self.addCleanup(factory.cleanup)
        scenario = factory.collection()
        scenario.invoke()
        catalog = scenario.path
        assert isinstance(scenario.command, CollectionAcceptance)
        prepared = scenario.command.bibliography
        repository = SqliteExecutionRepository(catalog)
        scope = ProcessBatchScope(
            kind="process",
            selector=ProcessSelector(
                kind="versions",
                ids=(str(prepared.work_version_id),),
                query=None,
            ),
            trigger_collection_run_id=None,
            selected_version_ids=(prepared.work_version_id,),
            include_all_versions=False,
            target_state="completed",
            limit=10,
        )
        candidates = repository.select_process_candidates(scope)
        targets = select_actual_targets(candidates, WorkVersionState.COMPLETED, scope.limit)
        self.assertEqual(len(targets), 1)
        batch_run_id = BatchRunId(str(uuid4()))
        started_at = UtcTimestamp("2026-08-03T00:00:00Z")
        result = TargetResult(
            subject_type="work-version",
            subject_id=str(prepared.work_version_id),
            outcome="failed",
            initial_state="unreviewed",
            target_state="completed",
            final_state="unreviewed",
            stage="asset",
            failure=None,
        )

        repository.create_process_batch(batch_run_id, scope, targets)
        repository.mark_process_started(batch_run_id, started_at)
        repository.mark_target_started(batch_run_id, prepared.work_version_id)
        repository.save_target_result(
            batch_run_id,
            TargetResultEnvelope(result=result, details=CanonicalJsonObject(())),
            started=True,
        )
        counts = state_counts((result,))
        repository.finish_process_batch(
            BatchDetail(
                kind="batch-detail",
                batch_run_id=batch_run_id,
                batch_type=BatchType.PROCESS,
                status=BatchStatus.FAILED,
                publication_phase=PublicationPhase.NONE,
                scope=scope,
                target_state="completed",
                stop_reason="target-failed",
                common_error=None,
                counts=counts,
                results=(result,),
                started_at=started_at,
                finished_at=UtcTimestamp("2026-08-03T00:01:00Z"),
            )
        )

        with open_read_only_snapshot(catalog) as connection:
            batch = connection.execute(
                "SELECT status,counts_json,started_at,finished_at FROM batch_runs WHERE id=?",
                (str(batch_run_id),),
            ).fetchone()
            target = connection.execute(
                "SELECT started,result_json FROM batch_targets WHERE batch_run_id=?",
                (str(batch_run_id),),
            ).fetchone()
            persisted_counts = connection.execute(
                "SELECT counts_json FROM batch_counts WHERE batch_run_id=?",
                (str(batch_run_id),),
            ).fetchone()
        self.assertEqual((batch[0], target[0]), ("failed", 1))
        self.assertIn('"stop_reason":"target-failed"', batch[1])
        self.assertIn(str(prepared.work_version_id), target[1])
        self.assertIn('"selected":1', persisted_counts[0])

        abandoned_id = BatchRunId(str(uuid4()))
        repository.create_process_batch(abandoned_id, scope, targets)
        repository.mark_process_started(abandoned_id, started_at)
        repository.mark_target_started(abandoned_id, prepared.work_version_id)

        recoverable = repository.list_recoverable_process_batches()

        abandoned = next(item for item in recoverable if item.batch_run_id == abandoned_id)
        self.assertEqual(abandoned.scope, scope)
        self.assertEqual(len(abandoned.targets), 1)
        self.assertTrue(abandoned.targets[0].started)
        self.assertIs(abandoned.targets[0].current_state, WorkVersionState.UNREVIEWED)
        self.assertIsNone(abandoned.targets[0].result)


if __name__ == "__main__":
    unittest.main()
