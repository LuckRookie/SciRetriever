from __future__ import annotations

import unittest
from types import TracebackType
from uuid import uuid4

from target_publisher_support import ScenarioFactory

from sciretriever.core.execution import (
    nonexecuted_target_result,
    select_actual_targets,
    state_counts,
)
from sciretriever.literature_store.sqlite import (
    SqliteExecutionRepository,
    open_read_only_snapshot,
)
from sciretriever.model.canonical_json import CanonicalJsonObject
from sciretriever.model.collection import CollectionAcceptance
from sciretriever.model.execution import (
    BatchDetail,
    CurrentFailure,
    ProcessBatchScope,
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
from sciretriever.services.execution import ExecutionService, ExecutionServiceDependencies

NOW = UtcTimestamp("2026-08-03T00:00:00Z")


class Guard:
    def __enter__(self) -> Guard:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        return None


class ExecutionSqliteSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.factory = ScenarioFactory()
        self.addCleanup(self.factory.cleanup)
        scenario = self.factory.collection()
        scenario.invoke()
        self.catalog = scenario.path
        assert isinstance(scenario.command, CollectionAcceptance)
        self.version_id = scenario.command.bibliography.work_version_id
        self.repository = SqliteExecutionRepository(self.catalog)

    def scope(self, *, selector_kind: str = "versions", selected: bool = True) -> ProcessBatchScope:
        selected_ids = (self.version_id,) if selected else ()
        return ProcessBatchScope.model_validate(
            {
                "kind": "process",
                "selector": {
                    "kind": selector_kind,
                    "ids": tuple(map(str, selected_ids)),
                    "query": None,
                },
                "trigger_collection_run_id": None,
                "selected_version_ids": selected_ids,
                "include_all_versions": False,
                "target_state": "completed",
                "limit": 10,
            }
        )

    def target(self):
        return select_actual_targets(
            self.repository.select_process_candidates(self.scope()),
            WorkVersionState.COMPLETED,
            1,
        )[0]

    def test_empty_explicit_scope_is_no_target_while_all_missing_scans_catalog(self) -> None:
        explicit = self.scope(selected=False)
        all_missing = self.scope(selector_kind="all-missing", selected=False)

        self.assertEqual(self.repository.select_process_candidates(explicit), ())
        self.assertEqual(len(self.repository.select_process_candidates(all_missing)), 1)

        detail = ExecutionService(
            ExecutionServiceDependencies(
                repository=self.repository,
                acquire_core_write=Guard,
                clock=lambda: NOW,
                processors=(),
            )
        ).run_process(explicit)
        self.assertIs(detail.status, BatchStatus.NO_TARGET)
        self.assertIsNone(detail.started_at)

    def test_result_write_preserves_started_persists_failure_and_rejects_late_update(self) -> None:
        batch_id = BatchRunId(str(uuid4()))
        target = self.target()
        self.repository.create_process_batch(batch_id, self.scope(), (target,))
        self.repository.mark_process_started(batch_id, NOW)
        not_started = nonexecuted_target_result(target, "not-started")
        self.repository.save_target_result(
            batch_id,
            TargetResultEnvelope(result=not_started, details=CanonicalJsonObject(())),
            started=False,
        )
        with open_read_only_snapshot(self.catalog) as connection:
            not_started_row = connection.execute(
                "SELECT started,result_json FROM batch_targets WHERE batch_run_id=?",
                (str(batch_id),),
            ).fetchone()
        self.assertEqual(not_started_row[0], 0)
        self.assertIn('"outcome":"not-started"', not_started_row[1])
        failure = CurrentFailure(
            stage="asset",
            code="download-failed",
            reason="no accepted candidate",
            action="retry acquisition",
            retryable=True,
            updated_at=NOW,
        )
        failed = TargetResult(
            subject_type="work-version",
            subject_id=str(self.version_id),
            outcome="failed",
            initial_state="unreviewed",
            target_state="completed",
            final_state="unreviewed",
            stage="asset",
            failure=failure,
        )
        self.repository.save_target_result(
            batch_id,
            TargetResultEnvelope(result=failed, details=CanonicalJsonObject(())),
            started=True,
        )
        detail = BatchDetail(
            kind="batch-detail",
            batch_run_id=batch_id,
            batch_type=BatchType.PROCESS,
            status=BatchStatus.FAILED,
            publication_phase=PublicationPhase.NONE,
            scope=self.scope(),
            target_state="completed",
            stop_reason="target-failed",
            common_error=None,
            counts=state_counts((failed,)),
            results=(failed,),
            started_at=NOW,
            finished_at=NOW,
        )
        self.repository.finish_process_batch(detail)

        with open_read_only_snapshot(self.catalog) as connection:
            target_row = connection.execute(
                "SELECT started,result_json FROM batch_targets WHERE batch_run_id=?",
                (str(batch_id),),
            ).fetchone()
            failure_row = connection.execute(
                "SELECT code,retryable FROM current_failures WHERE subject_id=? AND stage='asset'",
                (str(self.version_id),),
            ).fetchone()
        self.assertEqual(target_row[0], 1)
        self.assertIn('"outcome":"failed"', target_row[1])
        self.assertEqual(failure_row, ("download-failed", 1))
        with self.assertRaises(LookupError):
            self.repository.save_target_result(
                batch_id,
                TargetResultEnvelope(result=not_started, details=CanonicalJsonObject(())),
                started=False,
            )
        with self.assertRaises(LookupError):
            self.repository.mark_target_started(batch_id, self.version_id)

    def test_target_writes_require_running_parent(self) -> None:
        batch_id = BatchRunId(str(uuid4()))
        target = self.target()
        self.repository.create_process_batch(batch_id, self.scope(), (target,))

        with self.assertRaises(LookupError):
            self.repository.mark_target_started(batch_id, self.version_id)

        result = nonexecuted_target_result(target, "not-started")
        with self.assertRaises(LookupError):
            self.repository.save_target_result(
                batch_id,
                TargetResultEnvelope(result=result, details=CanonicalJsonObject(())),
                started=False,
            )

        with open_read_only_snapshot(self.catalog) as connection:
            row = connection.execute(
                "SELECT b.status,t.started,t.result_json FROM batch_runs b JOIN batch_targets t "
                "ON t.batch_run_id=b.id WHERE b.id=?",
                (str(batch_id),),
            ).fetchone()
        self.assertEqual(row, ("created", 0, None))

    def test_finish_rejects_target_write_before_terminalizing_parent(self) -> None:
        batch_id = BatchRunId(str(uuid4()))
        target = self.target()
        self.repository.create_process_batch(batch_id, self.scope(), (target,))
        result = nonexecuted_target_result(target, "not-started")

        with self.assertRaises(LookupError):
            self.repository.finish_process_batch(
                BatchDetail(
                    kind="batch-detail",
                    batch_run_id=batch_id,
                    batch_type=BatchType.PROCESS,
                    status=BatchStatus.NO_TARGET,
                    publication_phase=PublicationPhase.NONE,
                    scope=self.scope(),
                    target_state="completed",
                    stop_reason=None,
                    common_error=None,
                    counts=state_counts((result,)),
                    results=(result,),
                    started_at=None,
                    finished_at=NOW,
                )
            )

        with open_read_only_snapshot(self.catalog) as connection:
            row = connection.execute(
                "SELECT b.status,t.started,t.result_json FROM batch_runs b JOIN batch_targets t "
                "ON t.batch_run_id=b.id WHERE b.id=?",
                (str(batch_id),),
            ).fetchone()
        self.assertEqual(row, ("created", 0, None))

    def test_abandoned_run_persists_synthesized_target_result(self) -> None:
        abandoned_id = BatchRunId(str(uuid4()))
        target = self.target()
        self.repository.create_process_batch(abandoned_id, self.scope(), (target,))
        self.repository.mark_process_started(abandoned_id, NOW)
        self.repository.mark_target_started(abandoned_id, self.version_id)

        ExecutionService(
            ExecutionServiceDependencies(
                repository=self.repository,
                acquire_core_write=Guard,
                clock=lambda: NOW,
                processors=(),
            )
        ).run_process(self.scope(selected=False))

        with open_read_only_snapshot(self.catalog) as connection:
            row = connection.execute(
                "SELECT b.status,t.started,t.result_json FROM batch_runs b JOIN batch_targets t "
                "ON t.batch_run_id=b.id WHERE b.id=?",
                (str(abandoned_id),),
            ).fetchone()
        self.assertEqual((row[0], row[1]), ("interrupted", 1))
        self.assertIn('"outcome":"failed"', row[2])


if __name__ == "__main__":
    unittest.main()
