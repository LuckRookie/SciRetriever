from __future__ import annotations

import os
import sqlite3

from sciretriever.kernel import BoundaryError, parse_canonical_json
from sciretriever.literature_store.sqlite.engine import open_read_only_snapshot
from sciretriever.literature_store.sqlite.library_maintenance import (
    authority_fingerprint,
    clear_search_indexes,
    rebuild_search_indexes,
)
from sciretriever.literature_store.sqlite.library_parse import reference
from sciretriever.model.library_details import (
    CollectionCause,
    CollectionMembershipPage,
    CollectionPath,
    GraphEdge,
    GraphPage,
    UnresolvedReferenceItem,
    WorkCollectionMembership,
)
from sciretriever.model.primitives import (
    CitationDirection,
    CollectionCauseId,
    CollectionCauseKind,
    CollectionId,
    CollectionPathId,
    CollectionRunId,
    WorkId,
    WorkVersionId,
)


def _path_ids(payload: str) -> tuple[str, ...]:
    value = parse_canonical_json(payload)
    if not isinstance(value, tuple):
        raise sqlite3.DatabaseError("collection path is invalid")
    identifiers: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise sqlite3.DatabaseError("collection path is invalid")
        identifiers.append(item)
    return tuple(identifiers)


def _cause(row: tuple[str, str, str, str, str | None, str | None, str | None]) -> CollectionCause:
    identifier, _membership, run, kind, source, condition, seed = row
    return CollectionCause(
        cause_id=CollectionCauseId(identifier),
        collection_run_id=CollectionRunId(run),
        kind=CollectionCauseKind(kind),
        source=source,
        condition=condition,
        seed_work_id=None if seed is None else WorkId(seed),
    )


def _path(row: tuple[str, str, str, str | None, int, str]) -> CollectionPath:
    identifier, _membership, run, direction, depth, work_ids = row
    return CollectionPath(
        path_id=CollectionPathId(identifier),
        collection_run_id=CollectionRunId(run),
        direction=None if direction is None else CitationDirection(direction),
        depth=depth,
        work_ids=tuple(WorkId(value) for value in _path_ids(work_ids)),
    )


class _LibraryRelations:
    def __init__(self, catalog_path: str | os.PathLike[str]) -> None:
        self._catalog_path = catalog_path

    @staticmethod
    def _memberships(
        connection: sqlite3.Connection,
        work_id: WorkId,
        collection_id: CollectionId | None = None,
    ) -> tuple[WorkCollectionMembership, ...]:
        collection_clause = "" if collection_id is None else " AND collection_id=?"
        parameters = (
            (str(work_id),)
            if collection_id is None
            else (str(work_id), str(collection_id))
        )
        memberships: list[WorkCollectionMembership] = []
        for membership_id, row_collection_id, run_id in connection.execute(
            "SELECT id,collection_id,first_collection_run_id FROM collection_memberships WHERE "
            f"work_id=?{collection_clause} ORDER BY collection_id",
            parameters,
        ).fetchall():
            causes = tuple(
                _cause(row)
                for row in connection.execute(
                    "SELECT id,membership_id,collection_run_id,kind,source,condition,"
                    "seed_work_id FROM collection_causes WHERE membership_id=? ORDER BY id",
                    (membership_id,),
                ).fetchall()
            )
            paths = tuple(
                _path(row)
                for row in connection.execute(
                    "SELECT id,membership_id,collection_run_id,direction,depth,work_ids_json "
                    "FROM collection_paths WHERE membership_id=? ORDER BY id",
                    (membership_id,),
                ).fetchall()
            )
            memberships.append(
                WorkCollectionMembership(
                    collection_id=CollectionId(row_collection_id),
                    first_collection_run_id=CollectionRunId(run_id),
                    causes=causes,
                    paths=paths,
                )
            )
        return tuple(memberships)

    @staticmethod
    def _work_edges(connection: sqlite3.Connection, work_id: WorkId) -> tuple[GraphEdge, ...]:
        rows = connection.execute(
            "SELECT v.work_id,s.work_version_id,m.target_work_id,m.target_work_version_id,"
            "m.reference_json "
            "FROM reference_members m JOIN reference_sets s ON s.id=m.reference_set_id JOIN "
            "work_versions v ON v.id=s.work_version_id "
            "WHERE v.work_id=? ORDER BY v.work_id,m.target_work_id,m.target_work_version_id,m.id",
            (str(work_id),),
        ).fetchall()
        return tuple(
            GraphEdge(
                kind="graph-edge",
                source_work_id=WorkId(row[0]),
                source_work_version_id=WorkVersionId(row[1]),
                target_work_id=WorkId(row[2]),
                target_work_version_id=(None if row[3] is None else WorkVersionId(row[3])),
                relation="references",
                reference=reference(row[4]),
            )
            for row in rows
        )

    def references(
        self, version_id: WorkVersionId, unresolved: bool, limit: int, cursor: str | None
    ) -> GraphPage:
        if not 1 <= limit <= 1000:
            raise BoundaryError.for_field("limit", "must be from 1 through 1000")
        after = "" if cursor is None else cursor
        with open_read_only_snapshot(self._catalog_path) as connection:
            source = connection.execute(
                "SELECT work_id FROM work_versions WHERE id=?", (str(version_id),)
            ).fetchone()
            if source is None:
                raise LookupError(str(version_id))
            resolved_rows = connection.execute(
                "SELECT m.id,m.target_work_id,m.target_work_version_id,m.reference_json FROM "
                "reference_members m JOIN reference_sets s ON s.id=m.reference_set_id WHERE "
                "s.work_version_id=? AND m.id>? ORDER BY m.target_work_id,"
                "m.target_work_version_id,m.id LIMIT ?",
                (str(version_id), after, limit + 1),
            ).fetchall()
            unresolved_rows = (
                ()
                if not unresolved
                else connection.execute(
                    "SELECT u.id,u.reference_json FROM unresolved_references u JOIN "
                    "reference_sets s ON s.id=u.reference_set_id WHERE s.work_version_id=? AND "
                    "u.id>? ORDER BY u.id LIMIT ?",
                    (str(version_id), after, limit + 1),
                ).fetchall()
            )
        edges = tuple(
            GraphEdge(
                kind="graph-edge",
                source_work_id=WorkId(source[0]),
                source_work_version_id=version_id,
                target_work_id=WorkId(row[1]),
                target_work_version_id=None if row[2] is None else WorkVersionId(row[2]),
                relation="references",
                reference=reference(row[3]),
            )
            for row in resolved_rows[:limit]
        )
        missing = tuple(
            UnresolvedReferenceItem(
                kind="unresolved-reference",
                source_work_id=WorkId(source[0]),
                source_work_version_id=version_id,
                reference=reference(row[1]),
            )
            for row in unresolved_rows[:limit]
        )
        page_ids = tuple(row[0] for row in (*resolved_rows[:limit], *unresolved_rows[:limit]))
        has_more = len(resolved_rows) > limit or len(unresolved_rows) > limit
        return GraphPage(
            edges=edges,
            unresolved=missing,
            next_cursor=max(page_ids) if has_more and page_ids else None,
        )

    def collection_memberships(
        self, collection_id: CollectionId, after: WorkId | None, limit: int
    ) -> CollectionMembershipPage:
        if not 1 <= limit <= 1000:
            raise BoundaryError.for_field("limit", "must be from 1 through 1000")
        after_id = "" if after is None else str(after)
        with open_read_only_snapshot(self._catalog_path) as connection:
            rows = connection.execute(
                "SELECT work_id FROM collection_memberships WHERE collection_id=? AND work_id>? "
                "ORDER BY work_id LIMIT ?",
                (str(collection_id), after_id, limit + 1),
            ).fetchall()
            visible = rows[:limit]
            memberships = tuple(
                (
                    row[0],
                    self._memberships(connection, WorkId(row[0]), collection_id)[0],
                )
                for row in visible
            )
        return CollectionMembershipPage(
            memberships=tuple((WorkId(item), membership) for item, membership in memberships),
            next_after_work_id=(None if len(rows) <= limit else WorkId(visible[-1][0])),
        )

    def authority_fingerprint(self) -> str:
        return authority_fingerprint(self._catalog_path)

    def drop_search_indexes(self) -> None:
        clear_search_indexes(self._catalog_path)

    def rebuild_search_indexes(self) -> None:
        rebuild_search_indexes(self._catalog_path)


__all__ = ("_LibraryRelations",)
