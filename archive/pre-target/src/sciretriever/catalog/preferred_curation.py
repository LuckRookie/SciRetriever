from __future__ import annotations

from dataclasses import dataclass
import json
from uuid import uuid4

from sqlalchemy.engine import Connection

from sciretriever.catalog.curation_contracts import CurationCapture, CurationStep
from sciretriever.catalog.curation_records import footprint_sha256
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.work_curation_state import recompute_preferred
from sciretriever.core.curation import CurationAction, CurationSubjectKind
from sciretriever.core.ids import validate_uuid
from sciretriever.core.snapshots import SafeSnapshot


class PreferredCurationConflictError(Exception):
    __slots__ = ("code",)

    def __init__(self, code: str) -> None:
        self.code = code

    def __str__(self) -> str:
        return f"preferred curation conflict: {self.code}"


@dataclass(frozen=True, slots=True)
class _PreferredState:
    preferred_id: str | None
    manual: int
    updated_at: str


def _validated_id(value: str, field_name: str) -> str:
    try:
        return validate_uuid(value, field_name)
    except (TypeError, ValueError):
        raise PreferredCurationConflictError("malformed_id") from None


def _state(connection: Connection, work_id: str) -> _PreferredState:
    row = connection.exec_driver_sql(
        "SELECT status,preferred_work_version_id,preferred_version_is_manual,updated_at "
        "FROM works WHERE id=?", (work_id,),
    ).one_or_none()
    if row is None:
        raise PreferredCurationConflictError("unknown_work")
    if row[0] != "active":
        raise PreferredCurationConflictError("merged_work")
    return _PreferredState(row[1], int(row[2]), str(row[3]))


def _footprint(state: _PreferredState) -> bytes:
    return json.dumps(
        (state.preferred_id, state.manual, state.updated_at),
        ensure_ascii=True, separators=(",", ":"),
    ).encode("ascii")


def _capture(connection: Connection, work_id: str) -> CurationCapture:
    state = _state(connection, work_id)
    return CurationCapture(
        snapshot=SafeSnapshot.from_pairs((
            ("preferred_work_version_id", state.preferred_id),
            ("value", bool(state.manual)),
        )),
        footprint=_footprint(state),
    )


def _restore(connection: Connection, work_id: str, state: _PreferredState) -> None:
    connection.exec_driver_sql(
        "UPDATE works SET preferred_work_version_id=?,preferred_version_is_manual=?,updated_at=? "
        "WHERE id=?", (state.preferred_id, state.manual, state.updated_at, work_id),
    )


@dataclass(frozen=True, slots=True)
class PreferredSetHandler:
    work_id: str
    work_version_id: str
    operation_id: str
    expected_before_sha256: str
    before: _PreferredState

    action = CurationAction.SET_PREFERRED
    subject_kind = CurationSubjectKind.WORK

    @property
    def subject_id(self) -> str:
        return self.work_id

    @classmethod
    def load(
        cls, catalog: CatalogEngine, work_id: str, work_version_id: str,
    ) -> PreferredSetHandler:
        work = _validated_id(work_id, "work_id")
        version = _validated_id(work_version_id, "work_version_id")
        with catalog.connect() as connection:
            before = _state(connection, work)
            owner = connection.exec_driver_sql(
                "SELECT work_id FROM work_versions WHERE id=?", (version,),
            ).scalar_one_or_none()
            if owner is None:
                raise PreferredCurationConflictError("unknown_version")
            if owner != work:
                raise PreferredCurationConflictError("foreign_version")
        return cls(work, version, str(uuid4()), footprint_sha256(_footprint(before)), before)

    def capture(self, connection: Connection) -> CurationCapture:
        return _capture(connection, self.work_id)

    def steps(self) -> tuple[CurationStep, ...]:
        return (CurationStep("works", self._apply, self._compensate),)

    def _apply(self, connection: Connection) -> None:
        if self.before.preferred_id == self.work_version_id and self.before.manual:
            return
        connection.exec_driver_sql(
            "UPDATE works SET preferred_work_version_id=?,preferred_version_is_manual=1,"
            "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
            (self.work_version_id, self.work_id),
        )

    def _compensate(self, connection: Connection) -> None:
        _restore(connection, self.work_id, self.before)


@dataclass(frozen=True, slots=True)
class PreferredClearHandler:
    work_id: str
    operation_id: str
    expected_before_sha256: str
    before: _PreferredState

    action = CurationAction.CLEAR_PREFERRED
    subject_kind = CurationSubjectKind.WORK

    @property
    def subject_id(self) -> str:
        return self.work_id

    @classmethod
    def load(cls, catalog: CatalogEngine, work_id: str) -> PreferredClearHandler:
        work = _validated_id(work_id, "work_id")
        with catalog.connect() as connection:
            before = _state(connection, work)
        return cls(work, str(uuid4()), footprint_sha256(_footprint(before)), before)

    def capture(self, connection: Connection) -> CurationCapture:
        return _capture(connection, self.work_id)

    def steps(self) -> tuple[CurationStep, ...]:
        return (CurationStep("works", self._apply, self._compensate),)

    def _apply(self, connection: Connection) -> None:
        if not self.before.manual:
            return
        connection.exec_driver_sql(
            "UPDATE works SET preferred_version_is_manual=0 WHERE id=?", (self.work_id,),
        )
        recompute_preferred(connection, self.work_id)

    def _compensate(self, connection: Connection) -> None:
        _restore(connection, self.work_id, self.before)


__all__ = (
    "PreferredClearHandler", "PreferredCurationConflictError", "PreferredSetHandler",
)
