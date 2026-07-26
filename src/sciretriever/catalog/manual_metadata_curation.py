from __future__ import annotations

from dataclasses import dataclass
import json
from uuid import uuid4

from sqlalchemy.engine import Connection

from sciretriever.catalog.analysis_validation import validate_canonical_value
from sciretriever.catalog.canonical_projection import CANONICAL_FIELDS, recompute_canonical_projection
from sciretriever.catalog.curation_contracts import CurationCapture, CurationStep
from sciretriever.catalog.curation_records import footprint_sha256
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.repository import canonical_json
from sciretriever.core.curation import CurationAction, CurationSubjectKind
from sciretriever.core.ids import validate_uuid
from sciretriever.core.snapshots import SafeSnapshot
from sciretriever.core.timestamps import utc_now_rfc3339


class ManualMetadataCurationConflictError(Exception):
    __slots__ = ("code",)

    def __init__(self, code: str) -> None:
        self.code = code

    def __str__(self) -> str:
        return f"manual metadata curation conflict: {self.code}"


@dataclass(frozen=True, slots=True)
class _MetadataState:
    override_json: str | None
    override_updated_at: str | None
    canonical_value: str | int | None
    normalized_title: str | None
    version_updated_at: str


def _validated_id(value: str) -> str:
    try:
        return validate_uuid(value, "work_version_id")
    except (TypeError, ValueError):
        raise ManualMetadataCurationConflictError("malformed_id") from None


def _validated_field(value: str) -> str:
    if not isinstance(value, str) or value not in CANONICAL_FIELDS:
        raise ManualMetadataCurationConflictError("unsupported_field")
    return value


def _state(connection: Connection, version_id: str, field_name: str) -> _MetadataState:
    version = connection.exec_driver_sql(
        f"SELECT w.status,v.{field_name},v.normalized_title,v.updated_at "
        "FROM work_versions v JOIN works w ON w.id=v.work_id WHERE v.id=?",
        (version_id,),
    ).one_or_none()
    if version is None:
        raise ManualMetadataCurationConflictError("unknown_version")
    if version[0] != "active":
        raise ManualMetadataCurationConflictError("merged_work")
    override = connection.exec_driver_sql(
        "SELECT value_json,updated_at FROM manual_metadata_overrides "
        "WHERE work_version_id=? AND field_name=?", (version_id, field_name),
    ).one_or_none()
    return _MetadataState(
        None if override is None else str(override[0]),
        None if override is None else str(override[1]),
        version[1], str(version[2]) if field_name == "title" else None, str(version[3]),
    )


def _footprint(state: _MetadataState) -> bytes:
    return json.dumps(
        (state.override_json, state.override_updated_at, state.canonical_value,
         state.normalized_title, state.version_updated_at),
        ensure_ascii=True, separators=(",", ":"),
    ).encode("ascii")


@dataclass(frozen=True, slots=True)
class _ManualMetadataHandler:
    work_version_id: str
    field_name: str
    operation_id: str
    expected_before_sha256: str
    before: _MetadataState
    value_json: str | None

    subject_kind = CurationSubjectKind.WORK_VERSION

    @property
    def subject_id(self) -> str:
        return self.work_version_id

    def capture(self, connection: Connection) -> CurationCapture:
        state = _state(connection, self.work_version_id, self.field_name)
        value = None if state.override_json is None else json.loads(state.override_json)
        return CurationCapture(
            SafeSnapshot.from_pairs((("field_name", self.field_name), ("value", value))),
            _footprint(state),
        )

    def steps(self) -> tuple[CurationStep, ...]:
        return (
            CurationStep("manual_metadata_overrides", self._apply_override, self._restore_override),
            CurationStep("work_versions", self._recompute, self._restore_projection),
        )

    def _apply_override(self, connection: Connection) -> None:
        if self.value_json == self.before.override_json:
            return
        if self.value_json is None:
            connection.exec_driver_sql(
                "DELETE FROM manual_metadata_overrides WHERE work_version_id=? AND field_name=?",
                (self.work_version_id, self.field_name),
            )
            return
        connection.exec_driver_sql(
            "INSERT INTO manual_metadata_overrides "
            "(work_version_id,field_name,value_json,updated_at) VALUES (?,?,?,?) "
            "ON CONFLICT(work_version_id,field_name) DO UPDATE SET "
            "value_json=excluded.value_json,updated_at=excluded.updated_at",
            (self.work_version_id, self.field_name, self.value_json, utc_now_rfc3339()),
        )

    def _recompute(self, connection: Connection) -> None:
        if self.value_json == self.before.override_json:
            return
        recompute_canonical_projection(connection, self.work_version_id, frozenset({self.field_name}))

    def _restore_override(self, connection: Connection) -> None:
        connection.exec_driver_sql(
            "DELETE FROM manual_metadata_overrides WHERE work_version_id=? AND field_name=?",
            (self.work_version_id, self.field_name),
        )
        if self.before.override_json is not None:
            connection.exec_driver_sql(
                "INSERT INTO manual_metadata_overrides "
                "(work_version_id,field_name,value_json,updated_at) VALUES (?,?,?,?)",
                (self.work_version_id, self.field_name, self.before.override_json,
                 self.before.override_updated_at),
            )

    def _restore_projection(self, connection: Connection) -> None:
        assignments = f"{self.field_name}=?,updated_at=?"
        values: tuple[str | int | None, ...] = (
            self.before.canonical_value, self.before.version_updated_at, self.work_version_id,
        )
        if self.field_name == "title":
            assignments = "title=?,normalized_title=?,updated_at=?"
            values = (self.before.canonical_value, self.before.normalized_title,
                      self.before.version_updated_at, self.work_version_id)
        connection.exec_driver_sql(
            f"UPDATE work_versions SET {assignments} WHERE id=?", values,
        )


@dataclass(frozen=True, slots=True)
class ManualMetadataSetHandler(_ManualMetadataHandler):
    action = CurationAction.SET_METADATA

    @classmethod
    def load(
        cls, catalog: CatalogEngine, work_version_id: str, field_name: str,
        value: str | int,
    ) -> ManualMetadataSetHandler:
        version, field = _validated_id(work_version_id), _validated_field(field_name)
        with catalog.connect() as connection:
            before = _state(connection, version, field)
            try:
                parsed = validate_canonical_value(connection, field, value)
            except (TypeError, ValueError):
                raise ManualMetadataCurationConflictError("invalid_value") from None
        return cls(version, field, str(uuid4()), footprint_sha256(_footprint(before)),
                   before, canonical_json(parsed))


@dataclass(frozen=True, slots=True)
class ManualMetadataClearHandler(_ManualMetadataHandler):
    action = CurationAction.CLEAR_METADATA

    @classmethod
    def load(
        cls, catalog: CatalogEngine, work_version_id: str, field_name: str,
    ) -> ManualMetadataClearHandler:
        version, field = _validated_id(work_version_id), _validated_field(field_name)
        with catalog.connect() as connection:
            before = _state(connection, version, field)
        return cls(version, field, str(uuid4()), footprint_sha256(_footprint(before)), before, None)


__all__ = (
    "ManualMetadataClearHandler", "ManualMetadataCurationConflictError",
    "ManualMetadataSetHandler",
)
