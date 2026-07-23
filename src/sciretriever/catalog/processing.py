"""Deterministic transactional lifecycle for processing stages."""

from __future__ import annotations

import json

from sqlalchemy import insert, select, update

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import failures, processing_runs
from sciretriever.catalog.records import ProcessingRunRecord
from sciretriever.catalog.repository import _append_event, _required_text, canonical_json, catalog_operation
from sciretriever.core.derivation import canonical_sha256, stable_derivation_id
from sciretriever.core.enums import ProcessingRunState, ProcessingStage
from sciretriever.core.ids import validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.errors import CatalogError


def _stage(value: ProcessingStage | str) -> ProcessingStage:
    try:
        return value if isinstance(value, ProcessingStage) else ProcessingStage(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"unsupported processing stage: {value!r}") from error


class ProcessingRunRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine):
            raise TypeError("catalog must be a CatalogEngine")
        if catalog.read_only:
            raise CatalogError("ProcessingRunRepository requires a writable catalog")
        self._catalog = catalog

    def get(self, run_id: str) -> ProcessingRunRecord | None:
        run_id = validate_uuid(run_id, "run_id")
        with catalog_operation("processing run lookup"):
            with self._catalog.connect() as connection:
                row = connection.execute(select(processing_runs).where(processing_runs.c.id == run_id)).mappings().one_or_none()
        return None if row is None else ProcessingRunRecord.from_row(row)

    def claim_or_resume(
        self,
        work_version_id: str,
        stage: ProcessingStage | str,
        producer: str,
        producer_version: str,
        parameters: object,
        *,
        input_raw_asset_ids: tuple[str, ...] = (),
        input_artifact_ids: tuple[str, ...] = (),
    ) -> ProcessingRunRecord:
        work_version_id = validate_uuid(work_version_id, "work_id")
        normalized_stage = _stage(stage)
        producer = _required_text(producer, "producer")
        producer_version = _required_text(producer_version, "producer_version")
        raw_ids = tuple(sorted(validate_uuid(value, "input_raw_asset_id") for value in input_raw_asset_ids))
        artifact_ids = tuple(sorted(validate_uuid(value, "input_artifact_id") for value in input_artifact_ids))
        key = {"work_version_id": work_version_id, "stage": normalized_stage.value,
        "producer": producer,
        "producer_version": producer_version,
        "parameters": parameters,
        "input_raw_asset_ids": list(raw_ids),
        "input_artifact_ids": list(artifact_ids),}
        run_id = stable_derivation_id("processing_run", key)
        details = {
            **key,
            "parameters_sha256": canonical_sha256(parameters),
            "output_artifact_ids": [],
        }
        details_json = canonical_json(details)
        with catalog_operation("processing run claim"):
            with self._catalog.critical_transaction() as connection:
                row = connection.execute(select(processing_runs).where(processing_runs.c.id == run_id)).mappings().one_or_none()
                if row is not None:
                    existing = json.loads(row["details_json"])
                    if {key_: existing[key_] for key_ in key} != key:
                        raise CatalogError("processing run replay metadata conflicts")
                    state = ProcessingRunState(row["state"])
                    if state is ProcessingRunState.SUCCEEDED or state is ProcessingRunState.ACTIVE:
                        return ProcessingRunRecord.from_row(row)
                    if state is not ProcessingRunState.FAILED:
                        raise CatalogError(f"cannot resume processing run in state {state.value}")
                    now = utc_now_rfc3339()
                    connection.execute(update(processing_runs).where(processing_runs.c.id == run_id).values(state="active", started_at=now, finished_at=None))
                    return ProcessingRunRecord.from_row({**dict(row), "state": "active", "started_at": now, "finished_at": None})
                now = utc_now_rfc3339()
                values = {
                    "id": run_id, "work_version_id": work_version_id, "stage": normalized_stage.value,
                    "state": "active", "input_raw_asset_id": raw_ids[0] if raw_ids else None,
                    "input_artifact_id": artifact_ids[0] if artifact_ids else None,
                    "output_artifact_id": None, "details_json": details_json,
                    "started_at": now, "finished_at": None,
                }
                connection.execute(insert(processing_runs).values(**values))
                _append_event(connection, subject_type="processing_run", subject_id=run_id, event_type="processing_run.claimed")
                return ProcessingRunRecord.from_row(values)

    def succeed(self, run_id: str, *, output_artifact_ids: tuple[str, ...] = ()) -> ProcessingRunRecord:
        run_id = validate_uuid(run_id, "run_id")
        outputs = tuple(sorted(validate_uuid(value, "output_artifact_id") for value in output_artifact_ids))
        with catalog_operation("processing run success"):
            with self._catalog.critical_transaction() as connection:
                row = connection.execute(select(processing_runs).where(processing_runs.c.id == run_id)).mappings().one_or_none()
                if row is None:
                    raise CatalogError(f"processing run does not exist: {run_id}")
                state = ProcessingRunState(row["state"])
                details = json.loads(row["details_json"])
                if state is ProcessingRunState.SUCCEEDED:
                    if tuple(details.get("output_artifact_ids", ())) != outputs:
                        raise CatalogError("processing run success replay conflicts")
                    return ProcessingRunRecord.from_row(row)
                if state is not ProcessingRunState.ACTIVE:
                    raise CatalogError(f"cannot succeed processing run in state {state.value}")
                details["output_artifact_ids"] = list(outputs)
                now = utc_now_rfc3339()
                changes = {"state": "succeeded", "output_artifact_id": outputs[0] if outputs else None, "details_json": canonical_json(details), "finished_at": now}
                connection.execute(update(processing_runs).where(processing_runs.c.id == run_id).values(**changes))
                _append_event(connection, subject_type="processing_run", subject_id=run_id, event_type="processing_run.succeeded", details={"output_artifact_ids": outputs})
                return ProcessingRunRecord.from_row({**dict(row), **changes})

    def fail(self, run_id: str, category: str, message: str, *, retryable: bool = False, details: object | None = None) -> ProcessingRunRecord:
        run_id = validate_uuid(run_id, "run_id")
        category = _required_text(category, "category")
        message = _required_text(message, "message")
        details_json = canonical_json(details) if details is not None else None
        with catalog_operation("processing run failure"):
            with self._catalog.critical_transaction() as connection:
                row = connection.execute(select(processing_runs).where(processing_runs.c.id == run_id)).mappings().one_or_none()
                if row is None:
                    raise CatalogError(f"processing run does not exist: {run_id}")
                if ProcessingRunState(row["state"]) is ProcessingRunState.FAILED:
                    return ProcessingRunRecord.from_row(row)
                if ProcessingRunState(row["state"]) is not ProcessingRunState.ACTIVE:
                    raise CatalogError("only an active processing run can fail")
                now = utc_now_rfc3339()
                connection.execute(update(processing_runs).where(processing_runs.c.id == run_id).values(state="failed", finished_at=now))
                failure_values = {
                    "id": stable_derivation_id("processing_failure", {"run_id": run_id, "category": category, "message": message, "details": details}),
                    "work_version_id": row["work_version_id"], "job_id": None, "attempt_id": None,
                    "processing_run_id": run_id, "category": category, "message": message,
                    "retryable": int(retryable), "details_json": details_json, "occurred_at": now,
                }
                existing = connection.execute(select(failures).where(failures.c.id == failure_values["id"])).mappings().one_or_none()
                if existing is None:
                    connection.execute(insert(failures).values(**failure_values))
                    _append_event(connection, subject_type="processing_run", subject_id=run_id, event_type="processing_run.failed", details={"failure_id": failure_values["id"]})
                return ProcessingRunRecord.from_row({**dict(row), "state": "failed", "finished_at": now})

    def record_nonblocking_failure(
        self,
        run_id: str,
        category: str,
        message: str,
        *,
        details: object | None = None,
    ) -> None:
        run_id = validate_uuid(run_id, "run_id")
        category = _required_text(category, "category")
        message = _required_text(message, "message")
        failure_id = stable_derivation_id(
            "processing_failure",
            {"run_id": run_id, "category": category, "message": message, "details": details},
        )
        with catalog_operation("nonblocking processing failure"):
            with self._catalog.critical_transaction() as connection:
                run = connection.execute(select(processing_runs).where(processing_runs.c.id == run_id)).mappings().one_or_none()
                if run is None:
                    raise CatalogError(f"processing run does not exist: {run_id}")
                existing = connection.execute(select(failures.c.id).where(failures.c.id == failure_id)).scalar_one_or_none()
                if existing is not None:
                    return
                now = utc_now_rfc3339()
                connection.execute(insert(failures).values(
                    id=failure_id, work_version_id=run["work_version_id"], job_id=None, attempt_id=None,
                    processing_run_id=run_id, category=category, message=message,
                    retryable=0, details_json=None if details is None else canonical_json(details),
                    occurred_at=now,
                ))
                _append_event(connection, subject_type="processing_run", subject_id=run_id, event_type="processing_run.nonblocking_failure", details={"failure_id": failure_id})


__all__ = ("ProcessingRunRepository",)
