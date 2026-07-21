"""Transactional catalog operations for immutable raw assets."""

from __future__ import annotations

from typing import Any, Mapping

from sqlalchemy import Connection, insert, select, update

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import (
    acquisition_attempts,
    acquisition_jobs,
    asset_intents,
    failures,
    raw_assets,
    work_assets,
)
from sciretriever.catalog.records import (
    AssetIntentRecord,
    FailureRecord,
    RawAssetRecord,
    WorkAssetRecord,
)
from sciretriever.catalog.repository import (
    _append_event,
    _failure_record,
    _required_text,
    canonical_json,
    catalog_operation,
)
from sciretriever.core.enums import AssetIntentState, AssetRole
from sciretriever.core.ids import new_uuid4, validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.core.validation import validate_media_type, validate_sha256, validate_token
from sciretriever.errors import CatalogError


def _asset_role(value: AssetRole | str) -> AssetRole:
    try:
        return value if isinstance(value, AssetRole) else AssetRole(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"unsupported asset role: {value!r}") from error


def _positive_int(value: int, field_name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{field_name} must be an integer")
    if value <= 0:
        raise ValueError(f"{field_name} must be positive")
    return value


def _intent_record(row: Mapping[Any, Any]) -> AssetIntentRecord:
    return AssetIntentRecord.from_row(row)


def _raw_asset_record(row: Mapping[Any, Any]) -> RawAssetRecord:
    return RawAssetRecord.from_row(row)


def _work_asset_record(row: Mapping[Any, Any]) -> WorkAssetRecord:
    return WorkAssetRecord.from_row(row)


def _select_intent(connection: Any, intent_id: str) -> AssetIntentRecord | None:
    row = (
        connection.execute(select(asset_intents).where(asset_intents.c.id == intent_id))
        .mappings()
        .one_or_none()
    )
    return None if row is None else _intent_record(row)


_REPLAY_FIELDS = (
    "work_id",
    "job_id",
    "attempt_id",
    "asset_role",
    "storage_path",
    "expected_sha256",
    "media_type",
    "format",
    "expected_byte_size",
    "provenance_json",
)


def _compatible_replay(row: Mapping[Any, Any], values: Mapping[str, object]) -> bool:
    return all(row[field] == values[field] for field in _REPLAY_FIELDS)


def _failure_details_json(intent_id: str, details: object | None) -> str:
    failure_details: dict[str, object] = {"intent_id": intent_id}
    if details is not None:
        failure_details["details"] = details
    return canonical_json(failure_details)


def _record_intent_failure(
    connection: Connection,
    intent: Mapping[Any, Any],
    *,
    category: str,
    message: str,
    retryable: bool,
    details_json: str,
) -> tuple[FailureRecord, bool]:
    existing = (
        connection.execute(
            select(failures)
            .where(
                failures.c.work_id == intent["work_id"],
                failures.c.job_id == intent["job_id"],
                failures.c.attempt_id == intent["attempt_id"],
                failures.c.processing_run_id.is_(None),
                failures.c.category == category,
                failures.c.message == message,
                failures.c.retryable == int(retryable),
                failures.c.details_json == details_json,
            )
            .order_by(failures.c.occurred_at, failures.c.id)
        )
        .mappings()
        .first()
    )
    if existing is not None:
        return _failure_record(existing), False
    values = {
        "id": new_uuid4(),
        "work_id": intent["work_id"],
        "job_id": intent["job_id"],
        "attempt_id": intent["attempt_id"],
        "processing_run_id": None,
        "category": category,
        "message": message,
        "retryable": int(retryable),
        "details_json": details_json,
        "occurred_at": utc_now_rfc3339(),
    }
    connection.execute(insert(failures).values(**values))
    return _failure_record(values), True


class AssetRepository:
    """Manage replayable asset publication records and immutable raw assets."""

    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine):
            raise TypeError("catalog must be a CatalogEngine")
        if catalog.read_only:
            raise CatalogError("AssetRepository requires a writable catalog")
        self.__catalog = catalog

    def get_intent(self, intent_id: str) -> AssetIntentRecord | None:
        intent_id = validate_uuid(intent_id, "intent_id")
        with catalog_operation("asset intent lookup"):
            with self.__catalog.connect() as connection:
                return _select_intent(connection, intent_id)

    def list_reconcilable_intents(self) -> tuple[AssetIntentRecord, ...]:
        with catalog_operation("reconcilable asset intent listing"):
            with self.__catalog.connect() as connection:
                rows = (
                    connection.execute(
                        select(asset_intents)
                        .where(
                            asset_intents.c.state.in_(
                                (AssetIntentState.PENDING.value, AssetIntentState.PUBLISHED.value)
                            )
                        )
                        .order_by(asset_intents.c.created_at, asset_intents.c.id)
                    )
                    .mappings()
                    .all()
                )
        return tuple(_intent_record(row) for row in rows)

    def list_all_intents(self) -> tuple[AssetIntentRecord, ...]:
        """Return every intent in deterministic reconciliation order."""

        with catalog_operation("asset intent listing"):
            with self.__catalog.connect() as connection:
                rows = (
                    connection.execute(
                        select(asset_intents).order_by(
                            asset_intents.c.created_at, asset_intents.c.id
                        )
                    )
                    .mappings()
                    .all()
                )
        return tuple(_intent_record(row) for row in rows)

    def get_raw_asset(self, raw_asset_id: str) -> RawAssetRecord | None:
        raw_asset_id = validate_uuid(raw_asset_id, "raw_asset_id")
        with catalog_operation("raw asset lookup"):
            with self.__catalog.connect() as connection:
                row = (
                    connection.execute(select(raw_assets).where(raw_assets.c.id == raw_asset_id))
                    .mappings()
                    .one_or_none()
                )
        return None if row is None else _raw_asset_record(row)

    def get_raw_asset_by_sha256(self, sha256: str) -> RawAssetRecord | None:
        sha256 = validate_sha256(sha256)
        with catalog_operation("raw asset hash lookup"):
            with self.__catalog.connect() as connection:
                row = (
                    connection.execute(select(raw_assets).where(raw_assets.c.sha256 == sha256))
                    .mappings()
                    .one_or_none()
                )
        return None if row is None else _raw_asset_record(row)

    def get_work_assets(self, work_id: str) -> tuple[WorkAssetRecord, ...]:
        work_id = validate_uuid(work_id, "work_id")
        with catalog_operation("work asset lookup"):
            with self.__catalog.connect() as connection:
                rows = (
                    connection.execute(
                        select(work_assets)
                        .where(work_assets.c.work_id == work_id)
                        .order_by(work_assets.c.asset_role, work_assets.c.raw_asset_id)
                    )
                    .mappings()
                    .all()
                )
        return tuple(_work_asset_record(row) for row in rows)

    def create_intent(
        self,
        intent_id: str,
        work_id: str,
        job_id: str,
        asset_role: AssetRole | str,
        expected_sha256: str,
        media_type: str,
        format: str,
        expected_byte_size: int,
        provenance: object,
        *,
        attempt_id: str | None = None,
    ) -> AssetIntentRecord:
        intent_id = validate_uuid(intent_id, "intent_id")
        work_id = validate_uuid(work_id, "work_id")
        job_id = validate_uuid(job_id, "job_id")
        if attempt_id is not None:
            attempt_id = validate_uuid(attempt_id, "attempt_id")
        role = _asset_role(asset_role)
        expected_sha256 = validate_sha256(expected_sha256, "expected_sha256")
        media_type = validate_media_type(media_type)
        format = validate_token(format, "format")
        expected_byte_size = _positive_int(expected_byte_size, "expected_byte_size")
        provenance_json = canonical_json(provenance)
        now = utc_now_rfc3339()
        values = {
            "id": intent_id,
            "work_id": work_id,
            "job_id": job_id,
            "attempt_id": attempt_id,
            "raw_asset_id": None,
            "asset_role": role.value,
            "state": AssetIntentState.PENDING.value,
            "temporary_path": f"staging/{intent_id}.part",
            "storage_path": f"raw/{expected_sha256[:2]}/{expected_sha256}",
            "expected_sha256": expected_sha256,
            "media_type": media_type,
            "format": format,
            "expected_byte_size": expected_byte_size,
            "provenance_json": provenance_json,
            "created_at": now,
            "updated_at": now,
        }
        with catalog_operation("asset intent creation"):
            with self.__catalog.critical_transaction() as connection:
                job = (
                    connection.execute(
                        select(acquisition_jobs).where(acquisition_jobs.c.id == job_id)
                    )
                    .mappings()
                    .one_or_none()
                )
                if job is None:
                    raise CatalogError(f"acquisition job does not exist: {job_id}")
                if job["work_id"] != work_id:
                    raise CatalogError("acquisition job does not belong to the requested work")
                if job["asset_role"] != role.value:
                    raise CatalogError("acquisition job asset role does not match the intent")
                if attempt_id is not None:
                    attempt = (
                        connection.execute(
                            select(acquisition_attempts).where(
                                acquisition_attempts.c.id == attempt_id
                            )
                        )
                        .mappings()
                        .one_or_none()
                    )
                    if attempt is None:
                        raise CatalogError(f"acquisition attempt does not exist: {attempt_id}")
                    if attempt["job_id"] != job_id:
                        raise CatalogError("acquisition attempt does not belong to the intent job")
                existing = (
                    connection.execute(
                        select(asset_intents).where(
                            (asset_intents.c.id == intent_id)
                            | (
                                (asset_intents.c.job_id == job_id)
                                & (asset_intents.c.asset_role == role.value)
                                & (asset_intents.c.expected_sha256 == expected_sha256)
                            )
                        )
                    )
                    .mappings()
                    .all()
                )
                if existing:
                    exact_id = next((row for row in existing if row["id"] == intent_id), None)
                    candidate = exact_id or existing[0]
                    if not _compatible_replay(candidate, values):
                        raise CatalogError("asset intent replay metadata conflicts with an existing intent")
                    return _intent_record(candidate)
                connection.execute(insert(asset_intents).values(**values))
                _append_event(
                    connection,
                    subject_type="asset_intent",
                    subject_id=intent_id,
                    event_type="asset_intent.created",
                )
        return _intent_record(values)

    def register_verified_published_intent(self, intent_id: str) -> AssetIntentRecord:
        """Register bytes already verified by the coordinator or reconciler."""

        intent_id = validate_uuid(intent_id, "intent_id")
        with catalog_operation("asset intent publication"):
            with self.__catalog.critical_transaction() as connection:
                row = (
                    connection.execute(select(asset_intents).where(asset_intents.c.id == intent_id))
                    .mappings()
                    .one_or_none()
                )
                if row is None:
                    raise CatalogError(f"asset intent does not exist: {intent_id}")
                state = AssetIntentState(row["state"])
                if state in {AssetIntentState.PUBLISHED, AssetIntentState.FINALIZED}:
                    return _intent_record(row)
                if state is not AssetIntentState.PENDING:
                    raise CatalogError(f"cannot publish an asset intent in state {state.value}")

                raw_row = (
                    connection.execute(
                        select(raw_assets).where(raw_assets.c.sha256 == row["expected_sha256"])
                    )
                    .mappings()
                    .one_or_none()
                )
                reused = raw_row is not None
                if raw_row is None:
                    raw_values = {
                        "id": new_uuid4(),
                        "sha256": row["expected_sha256"],
                        "storage_path": row["storage_path"],
                        "media_type": row["media_type"],
                        "format": row["format"],
                        "byte_size": row["expected_byte_size"],
                        "provenance_json": row["provenance_json"],
                        "created_at": utc_now_rfc3339(),
                    }
                    connection.execute(insert(raw_assets).values(**raw_values))
                    raw_row = raw_values
                else:
                    expected = (
                        row["storage_path"],
                        row["expected_byte_size"],
                        row["media_type"],
                        row["format"],
                    )
                    actual = (
                        raw_row["storage_path"],
                        raw_row["byte_size"],
                        raw_row["media_type"],
                        raw_row["format"],
                    )
                    if actual != expected:
                        raise CatalogError("existing raw asset metadata conflicts with published intent")

                link = (
                    connection.execute(
                        select(work_assets).where(
                            work_assets.c.work_id == row["work_id"],
                            work_assets.c.raw_asset_id == raw_row["id"],
                            work_assets.c.asset_role == row["asset_role"],
                        )
                    )
                    .mappings()
                    .one_or_none()
                )
                if link is None:
                    connection.execute(
                        insert(work_assets).values(
                            work_id=row["work_id"],
                            raw_asset_id=raw_row["id"],
                            asset_role=row["asset_role"],
                            linked_at=utc_now_rfc3339(),
                        )
                    )
                changes = {
                    "state": AssetIntentState.PUBLISHED.value,
                    "raw_asset_id": raw_row["id"],
                    "updated_at": utc_now_rfc3339(),
                }
                connection.execute(
                    update(asset_intents).where(asset_intents.c.id == intent_id).values(**changes)
                )
                updated = {**dict(row), **changes}
                _append_event(
                    connection,
                    subject_type="asset_intent",
                    subject_id=intent_id,
                    event_type="asset_intent.published",
                    details={"raw_asset_id": raw_row["id"], "reused": reused},
                )
                return _intent_record(updated)

    def finalize_intent(self, intent_id: str) -> AssetIntentRecord:
        intent_id = validate_uuid(intent_id, "intent_id")
        with catalog_operation("asset intent finalization"):
            with self.__catalog.critical_transaction() as connection:
                row = (
                    connection.execute(select(asset_intents).where(asset_intents.c.id == intent_id))
                    .mappings()
                    .one_or_none()
                )
                if row is None:
                    raise CatalogError(f"asset intent does not exist: {intent_id}")
                state = AssetIntentState(row["state"])
                if state is AssetIntentState.FINALIZED:
                    return _intent_record(row)
                if state is not AssetIntentState.PUBLISHED:
                    raise CatalogError(f"cannot finalize an asset intent in state {state.value}")
                changes = {
                    "state": AssetIntentState.FINALIZED.value,
                    "updated_at": utc_now_rfc3339(),
                }
                connection.execute(
                    update(asset_intents).where(asset_intents.c.id == intent_id).values(**changes)
                )
                updated = {**dict(row), **changes}
                _append_event(
                    connection,
                    subject_type="asset_intent",
                    subject_id=intent_id,
                    event_type="asset_intent.finalized",
                )
                return _intent_record(updated)

    def record_intent_failure(
        self,
        intent_id: str,
        category: str,
        message: str,
        *,
        retryable: bool = False,
        details: object | None = None,
    ) -> FailureRecord:
        intent_id = validate_uuid(intent_id, "intent_id")
        category = _required_text(category, "category")
        message = _required_text(message, "message")
        if not isinstance(retryable, bool):
            raise TypeError("retryable must be a boolean")
        details_json = _failure_details_json(intent_id, details)
        with catalog_operation("asset intent failure recording"):
            with self.__catalog.critical_transaction() as connection:
                row = (
                    connection.execute(select(asset_intents).where(asset_intents.c.id == intent_id))
                    .mappings()
                    .one_or_none()
                )
                if row is None:
                    raise CatalogError(f"asset intent does not exist: {intent_id}")
                failure, created = _record_intent_failure(
                    connection,
                    row,
                    category=category,
                    message=message,
                    retryable=retryable,
                    details_json=details_json,
                )
                if created:
                    _append_event(
                        connection,
                        subject_type="asset_intent",
                        subject_id=intent_id,
                        event_type="asset_intent.failure_recorded",
                        details={"failure_id": failure.id},
                    )
                return failure

    def abandon_pending_intent(
        self,
        intent_id: str,
        category: str,
        message: str,
        *,
        retryable: bool = False,
        details: object | None = None,
    ) -> AssetIntentRecord:
        intent_id = validate_uuid(intent_id, "intent_id")
        category = _required_text(category, "category")
        message = _required_text(message, "message")
        if not isinstance(retryable, bool):
            raise TypeError("retryable must be a boolean")
        details_json = _failure_details_json(intent_id, details)
        with catalog_operation("asset intent abandonment"):
            with self.__catalog.critical_transaction() as connection:
                row = (
                    connection.execute(select(asset_intents).where(asset_intents.c.id == intent_id))
                    .mappings()
                    .one_or_none()
                )
                if row is None:
                    raise CatalogError(f"asset intent does not exist: {intent_id}")
                state = AssetIntentState(row["state"])
                if state is AssetIntentState.ABANDONED:
                    return _intent_record(row)
                if state is not AssetIntentState.PENDING:
                    raise CatalogError(f"cannot abandon an asset intent in state {state.value}")
                now = utc_now_rfc3339()
                changes = {"state": AssetIntentState.ABANDONED.value, "updated_at": now}
                connection.execute(
                    update(asset_intents).where(asset_intents.c.id == intent_id).values(**changes)
                )
                _record_intent_failure(
                    connection,
                    row,
                    category=category,
                    message=message,
                    retryable=retryable,
                    details_json=details_json,
                )
                updated = {**dict(row), **changes}
                _append_event(
                    connection,
                    subject_type="asset_intent",
                    subject_id=intent_id,
                    event_type="asset_intent.abandoned",
                    details={"category": category, "retryable": retryable},
                )
                return _intent_record(updated)


__all__ = ("AssetRepository",)
