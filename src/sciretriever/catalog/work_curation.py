from __future__ import annotations

from dataclasses import dataclass
import json
from uuid import uuid4

from sqlalchemy.engine import Connection

from sciretriever.catalog.curation_contracts import CurationCapture, CurationStep
from sciretriever.catalog.curation_records import footprint_sha256
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.work_curation_state import (
    parse_candidate_work_ids,
    preferred,
    recompute_preferred,
    topology_bytes,
    topology_capture,
)
from sciretriever.core.curation import CurationAction, CurationSubjectKind
from sciretriever.core.ids import validate_uuid
from sciretriever.core.snapshots import SafeSnapshot


class WorkCurationConflictError(Exception):
    __slots__ = ("code",)

    def __init__(self, code: str) -> None:
        self.code = code

    def __str__(self) -> str:
        return f"work curation conflict: {self.code}"


@dataclass(frozen=True, slots=True)
class _WorkState:
    status: str
    merged_into: str | None
    preferred_id: str | None
    preferred_manual: int
    needs_review: int
    review_reason: str | None
    updated_at: str


def _work_state(connection: Connection, work_id: str) -> _WorkState:
    row = connection.exec_driver_sql(
        "SELECT status,merged_into_work_id,preferred_work_version_id,preferred_version_is_manual,"
        "needs_review,review_reason,updated_at FROM works WHERE id=?", (work_id,),
    ).one_or_none()
    if row is None:
        raise WorkCurationConflictError("unknown_work")
    return _WorkState(str(row[0]), row[1], row[2], int(row[3]), int(row[4]), row[5], str(row[6]))


def _restore_work(connection: Connection, work_id: str, state: _WorkState) -> None:
    connection.exec_driver_sql(
        "UPDATE works SET status=?,merged_into_work_id=?,preferred_work_version_id=?,"
        "preferred_version_is_manual=?,needs_review=?,review_reason=?,updated_at=? WHERE id=?",
        (state.status, state.merged_into, state.preferred_id, state.preferred_manual,
         state.needs_review, state.review_reason, state.updated_at, work_id),
    )


@dataclass(frozen=True, slots=True)
class WorkMergeHandler:
    catalog: CatalogEngine
    source_work_id: str
    target_work_id: str
    operation_id: str
    expected_before_sha256: str
    source_state: _WorkState
    target_state: _WorkState
    source_version_ids: tuple[str, ...]
    source_identifier_ids: tuple[str, ...]
    source_tags: tuple[tuple[str, str], ...]
    target_tags: tuple[tuple[str, str], ...]
    reference_ids: tuple[str, ...]
    review_rows: tuple[tuple[str, str, tuple[str, ...]], ...]

    @property
    def action(self) -> CurationAction:
        return CurationAction.MERGE_WORK

    @property
    def subject_kind(self) -> CurationSubjectKind:
        return CurationSubjectKind.WORK

    @property
    def subject_id(self) -> str:
        return self.source_work_id

    @classmethod
    def load(cls, catalog: CatalogEngine, source_work_id: str, target_work_id: str) -> WorkMergeHandler:
        source = validate_uuid(source_work_id, "source_work_id")
        target = validate_uuid(target_work_id, "target_work_id")
        if source == target:
            raise WorkCurationConflictError("self_merge")
        with catalog.connect() as connection:
            source_state, target_state = _work_state(connection, source), _work_state(connection, target)
            if source_state.status != "active" or target_state.status != "active":
                raise WorkCurationConflictError("merged_work")
            lineage_conflict = connection.exec_driver_sql(
                "WITH RECURSIVE chain(id) AS (SELECT ? UNION ALL SELECT target_work_id "
                "FROM work_merge_lineage JOIN chain ON source_work_id=chain.id) "
                "SELECT EXISTS(SELECT 1 FROM work_merge_lineage WHERE source_work_id=?) "
                "OR EXISTS(SELECT 1 FROM chain WHERE id=?)",
                (target, source, source),
            ).scalar_one()
            if lineage_conflict:
                raise WorkCurationConflictError("merge_cycle")
            identifiers = connection.exec_driver_sql(
                "SELECT work_id,namespace,value FROM identifiers WHERE work_id IN (?,?) ORDER BY work_id,namespace,value",
                (source, target),
            ).all()
            by_work = {source: {}, target: {}}
            for work_id, namespace, value in identifiers:
                by_work[str(work_id)].setdefault(str(namespace), set()).add(str(value))
            for namespace in by_work[source].keys() & by_work[target].keys():
                if by_work[source][namespace] != by_work[target][namespace]:
                    raise WorkCurationConflictError("stable_identifier")
            source_version_ids = tuple(str(value) for value in connection.exec_driver_sql("SELECT id FROM work_versions WHERE work_id=? ORDER BY id", (source,)).scalars())
            source_identifier_ids = tuple(str(value) for value in connection.exec_driver_sql("SELECT id FROM identifiers WHERE work_id=? ORDER BY id", (source,)).scalars())
            source_tags = tuple((str(row[0]), str(row[1])) for row in connection.exec_driver_sql("SELECT tag_id,linked_at FROM manual_work_tags WHERE work_id=? ORDER BY tag_id", (source,)).all())
            target_tags = tuple((str(row[0]), str(row[1])) for row in connection.exec_driver_sql("SELECT tag_id,linked_at FROM manual_work_tags WHERE work_id=? ORDER BY tag_id", (target,)).all())
            reference_ids = tuple(connection.exec_driver_sql("SELECT id FROM version_references WHERE cited_work_id=? ORDER BY id", (source,)).scalars())
            try:
                review_rows = tuple(
                    (str(row[0]), str(row[1]), parse_candidate_work_ids(str(row[1])))
                    for row in connection.exec_driver_sql(
                        "SELECT id,candidate_work_ids_json FROM identity_reviews ORDER BY id"
                    ).all()
                )
            except ValueError:
                raise WorkCurationConflictError("candidate_work_ids_json") from None
            expected_before_sha256 = footprint_sha256(topology_bytes(connection, source, target))
        return cls(catalog, source, target, str(uuid4()), expected_before_sha256, source_state, target_state, source_version_ids, source_identifier_ids, source_tags, target_tags, reference_ids, review_rows)

    def capture(self, connection: Connection) -> CurationCapture:
        source = _work_state(connection, self.source_work_id)
        return topology_capture(connection, self.source_work_id, self.target_work_id, SafeSnapshot.from_pairs((
            ("preferred_work_version_id", preferred(connection, self.target_work_id)),
            ("source_work_id", self.source_work_id), ("target_work_id", self.target_work_id),
            ("value", source.status),
        )))

    def steps(self) -> tuple[CurationStep, ...]:
        return (
            CurationStep("work_lineage", self._apply_lineage, self._undo_lineage),
            CurationStep("work_versions", self._apply_versions, self._undo_versions),
            CurationStep("work_identifiers", self._apply_identifiers, self._undo_identifiers),
            CurationStep("manual_work_tags", self._apply_tags, self._undo_tags),
            CurationStep("reference_targets", self._apply_references, self._undo_references),
            CurationStep("review_links", self._apply_reviews, self._undo_reviews),
            CurationStep("works", self._apply_works, self._undo_works),
        )

    def _apply_lineage(self, connection: Connection) -> None:
        connection.exec_driver_sql("PRAGMA defer_foreign_keys=ON")
        connection.exec_driver_sql(
            "INSERT INTO work_merge_lineage (source_work_id,target_work_id,operation_id) VALUES (?,?,?)",
            (self.source_work_id, self.target_work_id, self.operation_id),
        )

    def _undo_lineage(self, connection: Connection) -> None:
        connection.exec_driver_sql("SELECT 1")

    def _apply_versions(self, connection: Connection) -> None:
        connection.exec_driver_sql("UPDATE work_versions SET work_id=? WHERE work_id=?", (self.target_work_id, self.source_work_id))

    def _undo_versions(self, connection: Connection) -> None:
        for version_id in self.source_version_ids:
            connection.exec_driver_sql("UPDATE work_versions SET work_id=? WHERE id=?", (self.source_work_id, version_id))
        _restore_work(connection, self.source_work_id, self.source_state)
        _restore_work(connection, self.target_work_id, self.target_state)

    def _apply_identifiers(self, connection: Connection) -> None:
        connection.exec_driver_sql("UPDATE identifiers SET work_id=? WHERE work_id=?", (self.target_work_id, self.source_work_id))

    def _undo_identifiers(self, connection: Connection) -> None:
        for identifier_id in self.source_identifier_ids:
            connection.exec_driver_sql("UPDATE identifiers SET work_id=? WHERE id=?", (self.source_work_id, identifier_id))

    def _apply_tags(self, connection: Connection) -> None:
        connection.exec_driver_sql("DELETE FROM manual_work_tags WHERE work_id=? AND tag_id IN (SELECT tag_id FROM manual_work_tags WHERE work_id=?)", (self.source_work_id, self.target_work_id))
        connection.exec_driver_sql("UPDATE manual_work_tags SET work_id=? WHERE work_id=?", (self.target_work_id, self.source_work_id))

    def _undo_tags(self, connection: Connection) -> None:
        connection.exec_driver_sql("DELETE FROM manual_work_tags WHERE work_id IN (?,?)", (self.source_work_id, self.target_work_id))
        for work_id, rows in ((self.source_work_id, self.source_tags), (self.target_work_id, self.target_tags)):
            for tag_id, linked_at in rows:
                connection.exec_driver_sql("INSERT INTO manual_work_tags (work_id,tag_id,linked_at) VALUES (?,?,?)", (work_id, tag_id, linked_at))

    def _apply_references(self, connection: Connection) -> None:
        connection.exec_driver_sql("UPDATE version_references SET cited_work_id=? WHERE cited_work_id=?", (self.target_work_id, self.source_work_id))

    def _undo_references(self, connection: Connection) -> None:
        for reference_id in self.reference_ids:
            connection.exec_driver_sql("UPDATE version_references SET cited_work_id=? WHERE id=?", (self.source_work_id, reference_id))

    def _apply_reviews(self, connection: Connection) -> None:
        for review_id, _payload, candidates in self.review_rows:
            replaced = sorted({self.target_work_id if value == self.source_work_id else value for value in candidates})
            connection.exec_driver_sql("UPDATE identity_reviews SET candidate_work_ids_json=? WHERE id=?", (json.dumps(replaced, separators=(",", ":")), review_id))

    def _undo_reviews(self, connection: Connection) -> None:
        for review_id, payload, _candidates in self.review_rows:
            connection.exec_driver_sql("UPDATE identity_reviews SET candidate_work_ids_json=? WHERE id=?", (payload, review_id))

    def _apply_works(self, connection: Connection) -> None:
        recompute_preferred(connection, self.target_work_id)
        connection.exec_driver_sql("UPDATE works SET status='merged',merged_into_work_id=?,preferred_work_version_id=NULL,preferred_version_is_manual=0,needs_review=0,review_reason=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", (self.target_work_id, self.source_work_id))

    def _undo_works(self, connection: Connection) -> None:
        connection.exec_driver_sql(
            "UPDATE works SET preferred_work_version_id=NULL WHERE id IN (?,?)",
            (self.source_work_id, self.target_work_id),
        )


@dataclass(frozen=True, slots=True)
class WorkVersionRegroupHandler:
    catalog: CatalogEngine
    work_version_id: str
    source_work_id: str
    target_work_id: str
    operation_id: str
    expected_before_sha256: str
    source_state: _WorkState
    target_state: _WorkState

    action = CurationAction.REGROUP_WORK_VERSION
    subject_kind = CurationSubjectKind.WORK_VERSION

    @property
    def subject_id(self) -> str:
        return self.work_version_id

    @classmethod
    def load(cls, catalog: CatalogEngine, work_version_id: str, target_work_id: str) -> WorkVersionRegroupHandler:
        version = validate_uuid(work_version_id, "work_version_id")
        target = validate_uuid(target_work_id, "target_work_id")
        with catalog.connect() as connection:
            row = connection.exec_driver_sql("SELECT work_id,stable_version_key FROM work_versions WHERE id=?", (version,)).one_or_none()
            if row is None:
                raise WorkCurationConflictError("unknown_version")
            source = str(row[0])
            if source == target:
                raise WorkCurationConflictError("no_change")
            source_state, target_state = _work_state(connection, source), _work_state(connection, target)
            if source_state.status != "active" or target_state.status != "active":
                raise WorkCurationConflictError("merged_work")
            duplicate = connection.exec_driver_sql("SELECT 1 FROM work_versions WHERE work_id=? AND stable_version_key=?", (target, row[1])).scalar_one_or_none()
            if duplicate is not None:
                raise WorkCurationConflictError("stable_version_key")
            expected_before_sha256 = footprint_sha256(topology_bytes(connection, source, target))
        return cls(catalog, version, source, target, str(uuid4()), expected_before_sha256, source_state, target_state)

    def capture(self, connection: Connection) -> CurationCapture:
        owner = connection.exec_driver_sql("SELECT work_id FROM work_versions WHERE id=?", (self.work_version_id,)).scalar_one()
        return topology_capture(connection, self.source_work_id, self.target_work_id, SafeSnapshot.from_pairs((
            ("source_work_id", self.source_work_id), ("target_work_id", self.target_work_id),
            ("work_id", str(owner)), ("work_version_id", self.work_version_id),
        )))

    def steps(self) -> tuple[CurationStep, ...]:
        return (CurationStep("work_versions", self._apply_version, self._undo_version), CurationStep("works", self._apply_works, self._undo_works))

    def _apply_version(self, connection: Connection) -> None:
        connection.exec_driver_sql("UPDATE work_versions SET work_id=? WHERE id=?", (self.target_work_id, self.work_version_id))

    def _undo_version(self, connection: Connection) -> None:
        connection.exec_driver_sql("UPDATE work_versions SET work_id=? WHERE id=?", (self.source_work_id, self.work_version_id))
        _restore_work(connection, self.source_work_id, self.source_state)
        _restore_work(connection, self.target_work_id, self.target_state)

    def _apply_works(self, connection: Connection) -> None:
        recompute_preferred(connection, self.source_work_id)
        recompute_preferred(connection, self.target_work_id)

    def _undo_works(self, connection: Connection) -> None:
        connection.exec_driver_sql(
            "UPDATE works SET preferred_work_version_id=NULL WHERE id IN (?,?)",
            (self.source_work_id, self.target_work_id),
        )


__all__ = ("WorkCurationConflictError", "WorkMergeHandler", "WorkVersionRegroupHandler")
