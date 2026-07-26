"""Transactional catalog operations for immutable raw assets."""

from __future__ import annotations

from typing import Any, Mapping

from sqlalchemy import insert, select, update

from sciretriever.catalog.asset_diagnostics import AssetDiagnosticRepository
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import (
    asset_intents,
    raw_assets,
    work_versions,
    work_version_assets,
)
from sciretriever.catalog.records import (
    AssetIntentRecord,
    RawAssetRecord,
    WorkVersionAssetRecord,
)
from sciretriever.catalog.repository import (
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


def _work_asset_record(row: Mapping[Any, Any]) -> WorkVersionAssetRecord:
    return WorkVersionAssetRecord.from_row(row)


def _select_intent(connection: Any, intent_id: str) -> AssetIntentRecord | None:
    row = (
        connection.execute(select(asset_intents).where(asset_intents.c.id == intent_id))
        .mappings()
        .one_or_none()
    )
    return None if row is None else _intent_record(row)


_REPLAY_FIELDS = (
    "work_version_id",
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


class AssetRepository(AssetDiagnosticRepository):
    """Manage replayable asset publication records and immutable raw assets."""

    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine):
            raise TypeError("catalog must be a CatalogEngine")
        if catalog.read_only:
            raise CatalogError("AssetRepository requires a writable catalog")
        self._catalog = catalog

    def get_intent(self, intent_id: str) -> AssetIntentRecord | None:
        intent_id = validate_uuid(intent_id, "intent_id")
        with catalog_operation("asset intent lookup"):
            with self._catalog.connect() as connection:
                return _select_intent(connection, intent_id)

    def list_reconcilable_intents(self) -> tuple[AssetIntentRecord, ...]:
        with catalog_operation("reconcilable asset intent listing"):
            with self._catalog.connect() as connection:
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
            with self._catalog.connect() as connection:
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
            with self._catalog.connect() as connection:
                row = (
                    connection.execute(select(raw_assets).where(raw_assets.c.id == raw_asset_id))
                    .mappings()
                    .one_or_none()
                )
        return None if row is None else _raw_asset_record(row)

    def work_version_exists(self, work_version_id: str) -> bool:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        with catalog_operation("WorkVersion lookup"):
            with self._catalog.connect() as connection:
                return connection.execute(
                    select(work_versions.c.id).where(work_versions.c.id == work_version_id)
                ).scalar_one_or_none() is not None

    def get_raw_asset_by_sha256(self, sha256: str) -> RawAssetRecord | None:
        sha256 = validate_sha256(sha256)
        with catalog_operation("raw asset hash lookup"):
            with self._catalog.connect() as connection:
                row = (
                    connection.execute(select(raw_assets).where(raw_assets.c.sha256 == sha256))
                    .mappings()
                    .one_or_none()
                )
        return None if row is None else _raw_asset_record(row)

    def get_work_version_assets(
        self,
        work_version_id: str,
    ) -> tuple[WorkVersionAssetRecord, ...]:
        work_version_id = validate_uuid(work_version_id, "work_id")
        with catalog_operation("work asset lookup"):
            with self._catalog.connect() as connection:
                rows = (
                    connection.execute(
                        select(work_version_assets)
                        .where(work_version_assets.c.work_version_id == work_version_id)
                        .order_by(work_version_assets.c.asset_role, work_version_assets.c.raw_asset_id)
                    )
                    .mappings()
                    .all()
                )
        return tuple(_work_asset_record(row) for row in rows)

    def create_intent(
        self,
        intent_id: str,
        work_version_id: str,
        asset_role: AssetRole | str,
        expected_sha256: str,
        media_type: str,
        format: str,
        expected_byte_size: int,
        provenance: object,
    ) -> AssetIntentRecord:
        intent_id = validate_uuid(intent_id, "intent_id")
        work_version_id = validate_uuid(work_version_id, "work_id")
        role = _asset_role(asset_role)
        expected_sha256 = validate_sha256(expected_sha256, "expected_sha256")
        media_type = validate_media_type(media_type)
        format = validate_token(format, "format")
        expected_byte_size = _positive_int(expected_byte_size, "expected_byte_size")
        provenance_json = canonical_json(provenance)
        now = utc_now_rfc3339()
        values = {
            "id": intent_id,
            "work_version_id": work_version_id,
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
            with self._catalog.critical_transaction() as connection:
                existing = (
                    connection.execute(
                        select(asset_intents).where(
                            (asset_intents.c.id == intent_id)
                            | (
                                (asset_intents.c.work_version_id == work_version_id)
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
        return _intent_record(values)

    def register_verified_published_intent(self, intent_id: str) -> AssetIntentRecord:
        """Register bytes already verified by the coordinator or reconciler."""

        intent_id = validate_uuid(intent_id, "intent_id")
        with catalog_operation("asset intent publication"):
            with self._catalog.critical_transaction() as connection:
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
                        select(work_version_assets).where(
                            work_version_assets.c.work_version_id == row["work_version_id"],
                            work_version_assets.c.raw_asset_id == raw_row["id"],
                            work_version_assets.c.asset_role == row["asset_role"],
                        )
                    )
                    .mappings()
                    .one_or_none()
                )
                if link is None:
                    connection.execute(
                        insert(work_version_assets).values(
                            work_version_id=row["work_version_id"],
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
                return _intent_record(updated)

    def finalize_intent(self, intent_id: str) -> AssetIntentRecord:
        intent_id = validate_uuid(intent_id, "intent_id")
        with catalog_operation("asset intent finalization"):
            with self._catalog.critical_transaction() as connection:
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
                return _intent_record(updated)

__all__ = ("AssetRepository",)
