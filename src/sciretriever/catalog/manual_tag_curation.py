from __future__ import annotations

from dataclasses import dataclass
import json
from uuid import uuid4

from sqlalchemy.engine import Connection

from sciretriever.catalog.curation_contracts import CurationCapture, CurationStep
from sciretriever.catalog.curation_records import footprint_sha256
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.core.curation import CurationAction, CurationSubjectKind
from sciretriever.core.ids import validate_uuid
from sciretriever.core.snapshots import SafeSnapshot
from sciretriever.core.timestamps import utc_now_rfc3339


class ManualTagCurationConflictError(Exception):
    __slots__ = ("code",)

    def __init__(self, code: str) -> None:
        self.code = code

    def __str__(self) -> str:
        return f"manual tag curation conflict: {self.code}"


@dataclass(frozen=True, slots=True)
class _TagState:
    linked_at: str | None


def _validated_id(value: str, field_name: str) -> str:
    try:
        return validate_uuid(value, field_name)
    except (TypeError, ValueError):
        raise ManualTagCurationConflictError("malformed_id") from None


def _state(connection: Connection, work_id: str, tag_id: str) -> _TagState:
    status = connection.exec_driver_sql(
        "SELECT status FROM works WHERE id=?", (work_id,),
    ).scalar_one_or_none()
    if status is None:
        raise ManualTagCurationConflictError("unknown_work")
    if status != "active":
        raise ManualTagCurationConflictError("merged_work")
    if connection.exec_driver_sql("SELECT id FROM tags WHERE id=?", (tag_id,)).scalar_one_or_none() is None:
        raise ManualTagCurationConflictError("unknown_tag")
    linked_at = connection.exec_driver_sql(
        "SELECT linked_at FROM manual_work_tags WHERE work_id=? AND tag_id=?",
        (work_id, tag_id),
    ).scalar_one_or_none()
    return _TagState(None if linked_at is None else str(linked_at))


def _footprint(state: _TagState) -> bytes:
    return json.dumps((state.linked_at,), separators=(",", ":")).encode("ascii")


@dataclass(frozen=True, slots=True)
class _ManualTagHandler:
    work_id: str
    tag_id: str
    operation_id: str
    expected_before_sha256: str
    before: _TagState
    present: bool

    subject_kind = CurationSubjectKind.WORK

    @property
    def subject_id(self) -> str:
        return self.work_id

    @classmethod
    def _load_values(cls, catalog: CatalogEngine, work_id: str, tag_id: str) -> tuple[str, str, _TagState]:
        work, tag = _validated_id(work_id, "work_id"), _validated_id(tag_id, "tag_id")
        with catalog.connect() as connection:
            before = _state(connection, work, tag)
        return work, tag, before

    def capture(self, connection: Connection) -> CurationCapture:
        state = _state(connection, self.work_id, self.tag_id)
        return CurationCapture(
            SafeSnapshot.from_pairs((("tag_id", self.tag_id), ("value", state.linked_at is not None))),
            _footprint(state),
        )

    def steps(self) -> tuple[CurationStep, ...]:
        return (CurationStep("manual_work_tags", self._apply, self._compensate),)

    def _apply(self, connection: Connection) -> None:
        if self.present:
            connection.exec_driver_sql(
                "INSERT OR IGNORE INTO manual_work_tags (work_id,tag_id,linked_at) VALUES (?,?,?)",
                (self.work_id, self.tag_id, utc_now_rfc3339()),
            )
            return
        connection.exec_driver_sql(
            "DELETE FROM manual_work_tags WHERE work_id=? AND tag_id=?",
            (self.work_id, self.tag_id),
        )

    def _compensate(self, connection: Connection) -> None:
        connection.exec_driver_sql(
            "DELETE FROM manual_work_tags WHERE work_id=? AND tag_id=?",
            (self.work_id, self.tag_id),
        )
        if self.before.linked_at is not None:
            connection.exec_driver_sql(
                "INSERT INTO manual_work_tags (work_id,tag_id,linked_at) VALUES (?,?,?)",
                (self.work_id, self.tag_id, self.before.linked_at),
            )


@dataclass(frozen=True, slots=True)
class ManualTagAddHandler(_ManualTagHandler):
    action = CurationAction.ADD_TAG

    @classmethod
    def load(cls, catalog: CatalogEngine, work_id: str, tag_id: str) -> ManualTagAddHandler:
        work, tag, before = cls._load_values(catalog, work_id, tag_id)
        return cls(work, tag, str(uuid4()), footprint_sha256(_footprint(before)), before, True)


@dataclass(frozen=True, slots=True)
class ManualTagRemoveHandler(_ManualTagHandler):
    action = CurationAction.REMOVE_TAG

    @classmethod
    def load(cls, catalog: CatalogEngine, work_id: str, tag_id: str) -> ManualTagRemoveHandler:
        work, tag, before = cls._load_values(catalog, work_id, tag_id)
        return cls(work, tag, str(uuid4()), footprint_sha256(_footprint(before)), before, False)


__all__ = (
    "ManualTagAddHandler", "ManualTagCurationConflictError", "ManualTagRemoveHandler",
)
