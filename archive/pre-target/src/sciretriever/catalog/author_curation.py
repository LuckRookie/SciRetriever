from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Final
from uuid import uuid4

from sqlalchemy.engine import Connection

from sciretriever.catalog.author_curation_state import author_capture, author_topology_bytes
from sciretriever.catalog.curation_contracts import CurationCapture, CurationStep
from sciretriever.catalog.curation_records import footprint_sha256
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.core.curation import CurationAction, CurationSubjectKind
from sciretriever.core.ids import validate_uuid
from sciretriever.core.snapshots import SafeSnapshot


_ORCID: Final = re.compile(r"^(?:https?://orcid\.org/)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$", re.IGNORECASE)


class AuthorCurationConflictError(Exception):
    __slots__ = ("code",)

    def __init__(self, code: str) -> None:
        self.code = code

    def __str__(self) -> str:
        return f"author curation conflict: {self.code}"


@dataclass(frozen=True, slots=True)
class _AuthorState:
    orcid: str | None
    status: str
    merged_into: str | None


def _author_state(connection: Connection, author_id: str) -> _AuthorState:
    row = connection.exec_driver_sql(
        "SELECT orcid,status,merged_into_author_id FROM authors WHERE id=?", (author_id,)
    ).one_or_none()
    if row is None:
        raise AuthorCurationConflictError("unknown_author")
    return _AuthorState(row[0], str(row[1]), row[2])


def _normalized_orcid(value: str | None) -> str | None:
    if value is None:
        return None
    matched = _ORCID.fullmatch(value.strip())
    if matched is None:
        raise AuthorCurationConflictError("invalid_orcid")
    return matched.group(1).upper()


def _manual_evidence(evidence: SafeSnapshot, source_id: str, target_id: str) -> bool:
    values = evidence.to_dict()
    return (
        values.get("decision") == "manual_author_identity"
        and values.get("source_author_id") == source_id
        and values.get("target_author_id") == target_id
        and isinstance(values.get("value"), str)
        and isinstance(values.get("manual_value"), str)
        and values["value"] != values["manual_value"]
    )


@dataclass(frozen=True, slots=True)
class AuthorMergeHandler:
    catalog: CatalogEngine
    source_author_id: str
    target_author_id: str
    operation_id: str
    expected_before_sha256: str
    evidence: SafeSnapshot
    source_state: _AuthorState
    target_state: _AuthorState
    source_authorship_ids: tuple[str, ...]
    collision_count: int

    action = CurationAction.MERGE_AUTHOR
    subject_kind = CurationSubjectKind.AUTHOR

    @property
    def subject_id(self) -> str:
        return self.source_author_id

    @classmethod
    def load(
        cls,
        catalog: CatalogEngine,
        source_author_id: str,
        target_author_id: str,
        evidence: SafeSnapshot,
    ) -> AuthorMergeHandler:
        source = validate_uuid(source_author_id, "source_author_id")
        target = validate_uuid(target_author_id, "target_author_id")
        if source == target:
            raise AuthorCurationConflictError("self_merge")
        with catalog.connect() as connection:
            source_state, target_state = _author_state(connection, source), _author_state(connection, target)
            if source_state.status != "active" or target_state.status != "active":
                raise AuthorCurationConflictError("merged_author")
            cycle = connection.exec_driver_sql(
                "WITH RECURSIVE chain(id) AS (SELECT ? UNION ALL SELECT target_author_id "
                "FROM author_merge_lineage JOIN chain ON source_author_id=chain.id) "
                "SELECT EXISTS(SELECT 1 FROM author_merge_lineage WHERE source_author_id IN (?,?)) "
                "OR EXISTS(SELECT 1 FROM chain WHERE id=?)",
                (target, source, target, source),
            ).scalar_one()
            if cycle:
                raise AuthorCurationConflictError("merge_cycle")
            source_orcid, target_orcid = _normalized_orcid(source_state.orcid), _normalized_orcid(target_state.orcid)
            if source_orcid is not None and target_orcid is not None and source_orcid != target_orcid:
                raise AuthorCurationConflictError("orcid_conflict")
            if source_orcid is None and target_orcid is None and not _manual_evidence(evidence, source, target):
                raise AuthorCurationConflictError("missing_evidence")
            source_links = tuple(str(value) for value in connection.exec_driver_sql(
                "SELECT id FROM authorships WHERE author_id=? ORDER BY work_version_id,position,id", (source,)
            ).scalars())
            collision_count = int(connection.exec_driver_sql(
                "SELECT count(DISTINCT s.work_version_id) FROM authorships s JOIN authorships t "
                "ON t.work_version_id=s.work_version_id WHERE s.author_id=? AND t.author_id=?",
                (source, target),
            ).scalar_one())
            expected = footprint_sha256(author_topology_bytes(connection, source, target))
        return cls(catalog, source, target, str(uuid4()), expected, evidence, source_state,
                   target_state, source_links, collision_count)

    def capture(self, connection: Connection) -> CurationCapture:
        source = _author_state(connection, self.source_author_id)
        target_links = int(connection.exec_driver_sql(
            "SELECT count(*) FROM authorships WHERE author_id=?", (self.target_author_id,)
        ).scalar_one())
        value = (
            f"reassigned:{target_links}:collisions:{self.collision_count}"
            if source.status == "merged"
            else f"active:{len(self.source_authorship_ids)}:collisions:{self.collision_count}"
        )
        return author_capture(connection, self.source_author_id, self.target_author_id,
                              SafeSnapshot.from_pairs((("source_author_id", self.source_author_id),
                                                       ("target_author_id", self.target_author_id),
                                                       ("value", value))))

    def steps(self) -> tuple[CurationStep, ...]:
        return (
            CurationStep("author_lineage", self._apply_lineage, self._undo_lineage),
            CurationStep("authorships", self._apply_authorships, self._undo_authorships),
            CurationStep("authors", self._apply_authors, self._undo_authors),
        )

    def _apply_lineage(self, connection: Connection) -> None:
        connection.exec_driver_sql("PRAGMA defer_foreign_keys=ON")
        connection.exec_driver_sql(
            "INSERT INTO author_merge_lineage (source_author_id,target_author_id,operation_id) VALUES (?,?,?)",
            (self.source_author_id, self.target_author_id, self.operation_id),
        )

    def _undo_lineage(self, connection: Connection) -> None:
        connection.exec_driver_sql("SELECT 1")

    def _apply_authorships(self, connection: Connection) -> None:
        connection.exec_driver_sql("UPDATE authorships SET author_id=? WHERE author_id=?",
                                   (self.target_author_id, self.source_author_id))

    def _undo_authorships(self, connection: Connection) -> None:
        for authorship_id in self.source_authorship_ids:
            connection.exec_driver_sql("UPDATE authorships SET author_id=? WHERE id=?",
                                       (self.source_author_id, authorship_id))

    def _apply_authors(self, connection: Connection) -> None:
        connection.exec_driver_sql(
            "UPDATE authors SET status='merged',merged_into_author_id=? WHERE id=?",
            (self.target_author_id, self.source_author_id),
        )

    def _undo_authors(self, connection: Connection) -> None:
        connection.exec_driver_sql(
            "UPDATE authors SET status=?,merged_into_author_id=? WHERE id=?",
            (self.source_state.status, self.source_state.merged_into, self.source_author_id),
        )


__all__ = ("AuthorCurationConflictError", "AuthorMergeHandler")
