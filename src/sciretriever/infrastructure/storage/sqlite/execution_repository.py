from __future__ import annotations

import os
from uuid import uuid4

from sciretriever.infrastructure.storage import target_result_envelope_json
from sciretriever.infrastructure.storage.sqlite.engine import open_read_only_snapshot
from sciretriever.infrastructure.storage.sqlite.publisher_support import immediate
from sciretriever.model.execution import (
    ActualProcessTarget,
    BatchDetail,
    ExecutionCandidate,
    ProcessBatchScope,
    RecoverableProcessBatch,
    TargetResult,
    TargetResultEnvelope,
)
from sciretriever.model.primitives import (
    BatchRunId,
    BatchStatus,
    UtcTimestamp,
    WorkVersionId,
)

from .execution_repository_support import (
    ExecutionPersistenceError,
    InvalidProcessBatchDetailError,
    _candidate_from_state,
    _canonical_model,
    _chunks,
    _empty_process_counts,
    _execution_candidates,
    _recovery_targets,
)


class SqliteExecutionRepository:
    def __init__(self, catalog_path: str | os.PathLike[str]) -> None:
        self._catalog_path = catalog_path

    def select_process_candidates(self, scope: ProcessBatchScope) -> tuple[ExecutionCandidate, ...]:
        rows: list[tuple[str, str]] = []
        with open_read_only_snapshot(self._catalog_path) as connection:
            if scope.selected_version_ids:
                for chunk in _chunks(scope.selected_version_ids):
                    placeholders = ",".join("?" for _item in chunk)
                    rows.extend(
                        connection.execute(
                            "SELECT work_version_id,state FROM work_version_state_view WHERE "
                            f"work_version_id IN ({placeholders}) ORDER BY work_version_id",
                            tuple(map(str, chunk)),
                        ).fetchall()
                    )
            elif scope.selector.kind == "all-missing":
                rows.extend(
                    connection.execute(
                        "SELECT work_version_id,state FROM work_version_state_view ORDER BY "
                        "work_version_id"
                    ).fetchall()
                )
        return _execution_candidates(rows)

    def create_process_batch(
        self,
        batch_run_id: BatchRunId,
        scope: ProcessBatchScope,
        targets: tuple[ActualProcessTarget, ...],
    ) -> None:
        empty_counts = _empty_process_counts(len(targets))
        with immediate(self._catalog_path) as connection:
            connection.execute(
                "INSERT INTO batch_runs(id,batch_type,status,scope_json,counts_json,"
                "trigger_collection_run_id) VALUES(?,'process','created',?,?,?)",
                (
                    str(batch_run_id),
                    _canonical_model(scope),
                    _canonical_model(empty_counts),
                    None
                    if scope.trigger_collection_run_id is None
                    else str(scope.trigger_collection_run_id),
                ),
            )
            for target in targets:
                connection.execute(
                    "INSERT INTO batch_targets(id,batch_run_id,target_kind,target_id,"
                    "initial_state,target_state) VALUES(?,?,'work-version',?,?,?)",
                    (
                        str(uuid4()),
                        str(batch_run_id),
                        str(target.work_version_id),
                        target.initial_state.value,
                        target.target_state.value,
                    ),
                )
            connection.commit()

    def mark_process_started(self, batch_run_id: BatchRunId, started_at: UtcTimestamp) -> None:
        with immediate(self._catalog_path) as connection:
            cursor = connection.execute(
                "UPDATE batch_runs SET status='running',started_at=? WHERE id=? AND "
                "batch_type='process' AND status='created'",
                (str(started_at), str(batch_run_id)),
            )
            if cursor.rowcount != 1:
                raise LookupError(str(batch_run_id))
            connection.commit()

    def mark_target_started(self, batch_run_id: BatchRunId, work_version_id: WorkVersionId) -> None:
        with immediate(self._catalog_path) as connection:
            cursor = connection.execute(
                "UPDATE batch_targets SET started=1 WHERE batch_run_id=? AND target_kind="
                "'work-version' AND target_id=? AND EXISTS(SELECT 1 FROM batch_runs b WHERE "
                "b.id=? AND b.batch_type='process' AND b.status='running')",
                (str(batch_run_id), str(work_version_id), str(batch_run_id)),
            )
            if cursor.rowcount != 1:
                raise LookupError(str(work_version_id))
            connection.commit()

    def get_process_candidate(self, work_version_id: WorkVersionId) -> ExecutionCandidate | None:
        with open_read_only_snapshot(self._catalog_path) as connection:
            row = connection.execute(
                "SELECT state FROM work_version_state_view WHERE work_version_id=?",
                (str(work_version_id),),
            ).fetchone()
        return _candidate_from_state(work_version_id, None if row is None else str(row[0]))

    def save_target_result(
        self,
        batch_run_id: BatchRunId,
        result: TargetResultEnvelope,
        *,
        started: bool,
    ) -> None:
        with immediate(self._catalog_path) as connection:
            cursor = connection.execute(
                "UPDATE batch_targets SET started=?,result_json=? WHERE batch_run_id=? AND "
                "target_kind='work-version' AND target_id=? AND EXISTS(SELECT 1 FROM batch_runs "
                "b WHERE b.id=? AND b.batch_type='process' AND b.status='running')",
                (
                    int(started),
                    target_result_envelope_json(result),
                    str(batch_run_id),
                    result.result.subject_id,
                    str(batch_run_id),
                ),
            )
            if cursor.rowcount != 1:
                raise LookupError(result.result.subject_id)
            failure = result.result.failure
            if failure is not None:
                connection.execute(
                    "INSERT INTO current_failures(id,subject_kind,subject_id,stage,code,reason,"
                    "action,retryable,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT("
                    "subject_kind,subject_id,stage) DO UPDATE SET code=excluded.code,reason="
                    "excluded.reason,action=excluded.action,retryable=excluded.retryable,"
                    "updated_at=excluded.updated_at",
                    (
                        str(uuid4()),
                        result.result.subject_type,
                        result.result.subject_id,
                        failure.stage,
                        failure.code,
                        failure.reason,
                        failure.action,
                        int(failure.retryable),
                        str(failure.updated_at),
                    ),
                )
            connection.commit()

    def finish_process_batch(self, detail: BatchDetail) -> None:
        counts_json = _canonical_model(detail.counts)
        expected_status = (
            BatchStatus.CREATED if detail.status is BatchStatus.NO_TARGET else BatchStatus.RUNNING
        )
        with immediate(self._catalog_path) as connection:
            if any(not isinstance(result, TargetResult) for result in detail.results):
                raise InvalidProcessBatchDetailError(
                    "process batch detail must contain target results"
                )
            cursor = connection.execute(
                "UPDATE batch_runs SET status=?,counts_json=?,publication_phase=?,started_at=?,"
                "finished_at=? WHERE id=? AND batch_type='process' AND status=? AND NOT EXISTS("
                "SELECT 1 FROM batch_targets WHERE batch_run_id=? AND target_kind='work-version' "
                "AND result_json IS NULL)",
                (
                    detail.status.value,
                    _canonical_model(detail),
                    detail.publication_phase.value,
                    None if detail.started_at is None else str(detail.started_at),
                    None if detail.finished_at is None else str(detail.finished_at),
                    str(detail.batch_run_id),
                    expected_status.value,
                    str(detail.batch_run_id),
                ),
            )
            if cursor.rowcount != 1:
                raise LookupError(str(detail.batch_run_id))
            connection.execute(
                "INSERT INTO batch_counts(batch_run_id,counts_json) VALUES(?,?) ON CONFLICT("
                "batch_run_id) DO UPDATE SET counts_json=excluded.counts_json",
                (str(detail.batch_run_id), counts_json),
            )
            connection.commit()

    def list_recoverable_process_batches(self) -> tuple[RecoverableProcessBatch, ...]:
        recovered: list[RecoverableProcessBatch] = []
        with open_read_only_snapshot(self._catalog_path) as connection:
            batches = connection.execute(
                "SELECT id,scope_json,started_at FROM batch_runs WHERE batch_type='process' AND "
                "status='running' ORDER BY id"
            ).fetchall()
            for batch_id, scope_json, started_at in batches:
                run_id = BatchRunId(str(batch_id))
                scope = ProcessBatchScope.model_validate_json(str(scope_json))
                rows = connection.execute(
                    "SELECT t.target_id,t.initial_state,t.target_state,t.started,t.result_json,"
                    "s.state FROM batch_targets t LEFT JOIN work_version_state_view s ON "
                    "s.work_version_id=t.target_id WHERE t.batch_run_id=? AND t.target_kind="
                    "'work-version' ORDER BY t.target_id",
                    (str(run_id),),
                ).fetchall()
                targets = _recovery_targets(run_id, rows)
                recovered.append(
                    RecoverableProcessBatch(
                        batch_run_id=run_id,
                        scope=scope,
                        targets=targets,
                        started_at=UtcTimestamp(str(started_at)),
                    )
                )
        return tuple(recovered)


__all__ = (
    "ExecutionPersistenceError",
    "InvalidProcessBatchDetailError",
    "SqliteExecutionRepository",
)
