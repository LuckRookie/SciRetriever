"""External parser attempt persistence."""

from __future__ import annotations

from sqlalchemy import func, insert, select, update

from .engine import CatalogEngine
from .models import external_parser_attempts, processing_runs
from .records import ExternalParserAttemptRecord
from .repository import canonical_json, catalog_operation
from sciretriever.core.ids import new_uuid4, validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.errors import CatalogError


class ExternalParserAttemptRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine) or catalog.read_only:
            raise CatalogError("ExternalParserAttemptRepository requires a writable catalog")
        self._catalog = catalog

    def create(self, processing_run_id: str, metadata: object, *,
               external_task_id: str | None = None) -> ExternalParserAttemptRecord:
        run_id = validate_uuid(processing_run_id, "processing_run_id")
        task_id = None if external_task_id is None else validate_uuid(external_task_id, "external_task_id")
        with catalog_operation("external parser attempt creation"):
            with self._catalog.critical_transaction() as connection:
                run = connection.execute(select(processing_runs.c.stage, processing_runs.c.state).where(
                    processing_runs.c.id == run_id)).one_or_none()
                if run is None:
                    raise CatalogError(f"processing run does not exist: {run_id}")
                if run != ("parsing", "active"):
                    raise CatalogError("external parser attempts require an active parsing run")
                active_id = connection.execute(select(external_parser_attempts.c.id).where(
                    external_parser_attempts.c.processing_run_id == run_id,
                    external_parser_attempts.c.state == "active")).scalar_one_or_none()
                if active_id is not None:
                    raise CatalogError("processing run already has an active external parser attempt")
                sequence = connection.execute(select(
                    func.coalesce(func.max(external_parser_attempts.c.sequence), 0) + 1
                ).where(external_parser_attempts.c.processing_run_id == run_id)).scalar_one()
                now = utc_now_rfc3339()
                values = {"id": new_uuid4(), "processing_run_id": run_id,
                          "sequence": sequence, "state": "active",
                          "external_task_id": task_id, "metadata_json": canonical_json(metadata),
                          "started_at": now, "finished_at": None}
                connection.execute(insert(external_parser_attempts).values(**values))
                return ExternalParserAttemptRecord.from_row(values)

    def finish(self, attempt_id: str, state: str) -> ExternalParserAttemptRecord:
        attempt_id = validate_uuid(attempt_id, "attempt_id")
        if state not in {"succeeded", "failed", "expired", "cancelled"}:
            raise ValueError("state must be a terminal parser attempt state")
        with catalog_operation("external parser attempt completion"):
            with self._catalog.critical_transaction() as connection:
                row = connection.execute(select(external_parser_attempts).where(
                    external_parser_attempts.c.id == attempt_id)).mappings().one_or_none()
                if row is None:
                    raise CatalogError(f"external parser attempt does not exist: {attempt_id}")
                if row["state"] != "active":
                    if row["state"] != state:
                        raise CatalogError("external parser attempt terminal replay conflicts")
                    return ExternalParserAttemptRecord.from_row(row)
                now = utc_now_rfc3339()
                connection.execute(update(external_parser_attempts).where(
                    external_parser_attempts.c.id == attempt_id).values(state=state, finished_at=now))
                return ExternalParserAttemptRecord.from_row({**dict(row), "state": state, "finished_at": now})

    def active_for_run(self, processing_run_id: str) -> ExternalParserAttemptRecord | None:
        run_id = validate_uuid(processing_run_id, "processing_run_id")
        with self._catalog.connect() as connection:
            row = connection.execute(select(external_parser_attempts).where(
                external_parser_attempts.c.processing_run_id == run_id,
                external_parser_attempts.c.state == "active")).mappings().one_or_none()
        return None if row is None else ExternalParserAttemptRecord.from_row(row)

    def attach_task(self, attempt_id: str, external_task_id: str) -> ExternalParserAttemptRecord:
        attempt_id = validate_uuid(attempt_id, "attempt_id")
        task_id = validate_uuid(external_task_id, "external_task_id")
        with catalog_operation("external parser task attachment"):
            with self._catalog.critical_transaction() as connection:
                row = connection.execute(select(external_parser_attempts).where(
                    external_parser_attempts.c.id == attempt_id)).mappings().one_or_none()
                if row is None:
                    raise CatalogError(f"external parser attempt does not exist: {attempt_id}")
                if row["state"] != "active":
                    raise CatalogError("external parser task requires an active attempt")
                existing = row["external_task_id"]
                if existing is not None and existing != task_id:
                    raise CatalogError("external parser task attachment conflicts")
                if existing is None:
                    connection.execute(update(external_parser_attempts).where(
                        external_parser_attempts.c.id == attempt_id).values(external_task_id=task_id))
                return ExternalParserAttemptRecord.from_row({**dict(row), "external_task_id": task_id})

    def list_for_run(self, processing_run_id: str) -> tuple[ExternalParserAttemptRecord, ...]:
        run_id = validate_uuid(processing_run_id, "processing_run_id")
        with self._catalog.connect() as connection:
            rows = connection.execute(select(external_parser_attempts).where(
                external_parser_attempts.c.processing_run_id == run_id).order_by(
                    external_parser_attempts.c.sequence)).mappings().all()
        return tuple(ExternalParserAttemptRecord.from_row(row) for row in rows)


__all__ = ("ExternalParserAttemptRepository",)
