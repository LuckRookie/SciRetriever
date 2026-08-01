from __future__ import annotations

import os
import sqlite3

from sciretriever.interoperability.api import (
    AssetView,
    CollectionCause,
    CollectionMembershipPage,
    CollectionPath,
    CurrentFailure,
    ExtensionResultView,
    GraphEdge,
    GraphPage,
    LibraryPage,
    LibraryPageRequest,
    ObservationView,
    QueryFilterV1,
    ReferenceSetView,
    TagSetView,
    TagView,
    UnresolvedReferenceItem,
    WorkCollectionMembership,
    WorkDetail,
    WorkVersionDetail,
)
from sciretriever.kernel import (
    BoundaryError,
    CollectionId,
    Identifier,
    Provenance,
    ProvenanceId,
    UtcTimestamp,
    WorkId,
    WorkVersionId,
    parse_canonical_json,
)
from sciretriever.kernel.enums import AssetRole, SourceKind, WorkVersionState
from sciretriever.literature_store.sqlite.engine import (
    open_read_only_snapshot,
)
from sciretriever.literature_store.sqlite.library_maintenance import (
    authority_fingerprint,
    clear_search_indexes,
    rebuild_search_indexes,
)
from sciretriever.literature_store.sqlite.library_parse import (
    analysis_view,
    extension_fields,
    json_value,
    light_view,
    metadata_view,
    reference,
)
from sciretriever.literature_store.sqlite.library_query import search as search_page


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
    return CollectionCause(identifier, run, kind, source, condition, seed)


def _path(row: tuple[str, str, str, str | None, int, str]) -> CollectionPath:
    identifier, _membership, run, direction, depth, work_ids = row
    return CollectionPath(identifier, run, direction, depth, _path_ids(work_ids))


class SqliteLibraryReadRepository:
    def __init__(self, catalog_path: str | os.PathLike[str]) -> None:
        self._catalog_path = catalog_path

    def search(self, filters: QueryFilterV1, request: LibraryPageRequest) -> LibraryPage:
        with open_read_only_snapshot(self._catalog_path) as connection:
            return search_page(connection, filters, request)

    def get_work(
        self, work_id: WorkId, observations: bool, namespaces: tuple[str, ...]
    ) -> WorkDetail:
        requested = self._namespaces(namespaces)
        with open_read_only_snapshot(self._catalog_path) as connection:
            representative = connection.execute(
                "SELECT work_version_id FROM work_representative_versions WHERE work_id=?",
                (str(work_id),),
            ).fetchone()
            if representative is None:
                raise LookupError(str(work_id))
            version_rows = connection.execute(
                "SELECT id FROM work_versions WHERE work_id=? ORDER BY CASE version_role WHEN "
                "'formal' THEN 0 WHEN 'accepted-manuscript' THEN 1 WHEN 'preprint' THEN 2 ELSE "
                "3 END,id",
                (str(work_id),),
            ).fetchall()
            versions = tuple(
                self._version(connection, WorkVersionId(row[0]), observations, requested)
                for row in version_rows
            )
            memberships = self._memberships(connection, work_id)
            edges = self._work_edges(connection, work_id)
        return WorkDetail(
            "work-detail",
            str(work_id),
            representative[0],
            any(item.state is WorkVersionState.COMPLETED for item in versions),
            versions,
            memberships,
            edges,
        )

    def get_version(
        self, version_id: WorkVersionId, observations: bool, namespaces: tuple[str, ...]
    ) -> WorkVersionDetail:
        requested = self._namespaces(namespaces)
        with open_read_only_snapshot(self._catalog_path) as connection:
            return self._version(connection, version_id, observations, requested)

    @staticmethod
    def _namespaces(namespaces: tuple[str, ...]) -> tuple[str, ...]:
        if any(not item.strip() for item in namespaces) or len(namespaces) != len(set(namespaces)):
            raise BoundaryError.for_field("extension_namespaces", "must be nonblank and unique")
        return tuple(sorted(namespaces))

    def _version(
        self,
        connection: sqlite3.Connection,
        version_id: WorkVersionId,
        observations: bool,
        namespaces: tuple[str, ...],
    ) -> WorkVersionDetail:
        row = connection.execute(
            "SELECT v.work_id,st.state,st.missing_step,s.revision,s.sha256,s.values_json,"
            "s.provenance_json "
            "FROM work_versions v JOIN work_version_state_view st ON st.work_version_id=v.id "
            "JOIN work_version_current_metadata c ON c.work_version_id=v.id JOIN "
            "metadata_snapshots s ON s.id=c.metadata_snapshot_id WHERE v.id=?",
            (str(version_id),),
        ).fetchone()
        if row is None:
            raise LookupError(str(version_id))
        work_id, state, missing = row[:3]
        identifiers = tuple(
            Identifier(item[0], item[1])
            for item in connection.execute(
                "SELECT namespace,value FROM stable_identifiers WHERE work_version_id=? ORDER "
                "BY namespace,value",
                (str(version_id),),
            ).fetchall()
        )
        assets = tuple(
            AssetView(
                item[0],
                AssetRole(item[1]),
                item[2],
                item[3] or "application/octet-stream",
                item[4],
                item[5],
                (),
            )
            for item in connection.execute(
                "SELECT a.id,w.role,a.sha256,a.media_type,a.byte_size,a.storage_path FROM "
                "work_version_assets w JOIN artifacts a ON a.id=w.artifact_id WHERE "
                "w.work_version_id=? ORDER BY w.role,a.id",
                (str(version_id),),
            ).fetchall()
        )
        light = light_view(
            connection.execute(
                "SELECT d.artifact_id,d.sha256,d.document_json,d.provenance_json FROM "
                "work_version_current_light_document c JOIN light_documents d ON "
                "d.id=c.light_document_id WHERE c.work_version_id=?",
                (str(version_id),),
            ).fetchone()
        )
        analysis = analysis_view(
            connection.execute(
                "SELECT a.artifact_id,a.sha256,a.input_sha256,a.proposal_json,a.provenance_json "
                "FROM completion_bundles b JOIN analysis_artifacts a ON "
                "a.id=b.analysis_artifact_id WHERE b.work_version_id=?",
                (str(version_id),),
            ).fetchone()
        )
        references, tags = self._sets(connection, version_id)
        failure_row = connection.execute(
            "SELECT stage,code,reason,action,retryable,updated_at FROM current_failures WHERE "
            "subject_kind='work-version' AND subject_id=? ORDER BY updated_at DESC,stage LIMIT "
            "1",
            (str(version_id),),
        ).fetchone()
        failure = (
            None
            if failure_row is None
            else CurrentFailure(
                failure_row[0],
                failure_row[1],
                failure_row[2],
                failure_row[3],
                bool(failure_row[4]),
                failure_row[5],
            )
        )
        observation_items = self._observations(connection, version_id) if observations else ()
        extensions = self._extensions(connection, version_id, namespaces)
        return WorkVersionDetail(
            "work-version-detail",
            work_id,
            str(version_id),
            identifiers,
            metadata_view((row[3], row[4], row[5], row[6])),
            assets,
            light,
            analysis,
            references,
            tags,
            WorkVersionState(state),
            missing,
            failure,
            observations,
            observation_items,
            namespaces,
            extensions,
            (),
        )

    @staticmethod
    def _sets(
        connection: sqlite3.Connection, version_id: WorkVersionId
    ) -> tuple[ReferenceSetView, TagSetView]:
        reference_set = connection.execute(
            "SELECT id,complete FROM reference_sets WHERE work_version_id=? ORDER BY revision "
            "DESC LIMIT 1",
            (str(version_id),),
        ).fetchone()
        references = (
            ()
            if reference_set is None
            else tuple(
                reference(row[0])
                for row in connection.execute(
                    "SELECT reference_json FROM (SELECT ordinal,reference_json FROM "
                    "reference_members WHERE reference_set_id=? UNION ALL SELECT ordinal,"
                    "reference_json FROM unresolved_references WHERE reference_set_id=?) ORDER "
                    "BY ordinal",
                    (reference_set[0], reference_set[0]),
                ).fetchall()
            )
        )
        tag_set = connection.execute(
            "SELECT id,complete FROM tag_sets WHERE work_version_id=? ORDER BY revision DESC "
            "LIMIT 1",
            (str(version_id),),
        ).fetchone()
        tags = (
            ()
            if tag_set is None
            else tuple(
                TagView(row[0], json_value(row[1]))
                for row in connection.execute(
                    "SELECT name,evidence_json FROM tag_members WHERE tag_set_id=? ORDER BY "
                    "lower(name),name",
                    (tag_set[0],),
                ).fetchall()
            )
        )
        return ReferenceSetView(
            reference_set is not None and bool(reference_set[1]), references
        ), TagSetView(tag_set is not None and bool(tag_set[1]), tags)

    @staticmethod
    def _observations(
        connection: sqlite3.Connection, version_id: WorkVersionId
    ) -> tuple[ObservationView, ...]:
        rows = connection.execute(
            "SELECT id,provider,provider_record_id,payload_json,observed_at FROM "
            "metadata_observations WHERE work_version_id=? ORDER BY observed_at,id",
            (str(version_id),),
        ).fetchall()
        return tuple(
            ObservationView(
                row[0],
                row[1],
                "metadata",
                json_value(row[3]),
                row[4],
                Provenance(
                    ProvenanceId(row[0]),
                    SourceKind.METADATA_PROVIDER,
                    row[1],
                    row[2],
                    UtcTimestamp(row[4]),
                    None,
                    None,
                ),
            )
            for row in rows
        )

    @staticmethod
    def _extensions(
        connection: sqlite3.Connection, version_id: WorkVersionId, namespaces: tuple[str, ...]
    ) -> tuple[ExtensionResultView, ...]:
        results: list[ExtensionResultView] = []
        for namespace in namespaces:
            for (payload,) in connection.execute(
                "SELECT payload_json FROM opaque_extension_records WHERE namespace=? AND "
                "json_extract(payload_json,'$.work_version_id')=? ORDER BY json_extract("
                "payload_json,'$.schema_version'),record_id",
                (namespace, str(version_id)),
            ).fetchall():
                schema, artifact, digest, value = extension_fields(payload)
                results.append(ExtensionResultView(namespace, schema, artifact, digest, value))
        return tuple(results)

    @staticmethod
    def _memberships(
        connection: sqlite3.Connection, work_id: WorkId
    ) -> tuple[WorkCollectionMembership, ...]:
        memberships: list[WorkCollectionMembership] = []
        for membership_id, collection_id, run_id in connection.execute(
            "SELECT id,collection_id,first_collection_run_id FROM collection_memberships WHERE "
            "work_id=? ORDER BY collection_id",
            (str(work_id),),
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
            memberships.append(WorkCollectionMembership(collection_id, run_id, causes, paths))
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
            GraphEdge("graph-edge", row[0], row[1], row[2], row[3], "references", reference(row[4]))
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
                "graph-edge",
                source[0],
                str(version_id),
                row[1],
                row[2],
                "references",
                reference(row[3]),
            )
            for row in resolved_rows[:limit]
        )
        missing = tuple(
            UnresolvedReferenceItem(
                "unresolved-reference", source[0], str(version_id), reference(row[1])
            )
            for row in unresolved_rows[:limit]
        )
        page_ids = tuple(row[0] for row in (*resolved_rows[:limit], *unresolved_rows[:limit]))
        has_more = len(resolved_rows) > limit or len(unresolved_rows) > limit
        return GraphPage(edges, missing, max(page_ids) if has_more and page_ids else None)

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
                (row[0], self._memberships(connection, WorkId(row[0]))[0]) for row in visible
            )
        return CollectionMembershipPage(
            memberships,
            visible[-1][0] if len(rows) > limit else None,
        )

    def authority_fingerprint(self) -> str:
        return authority_fingerprint(self._catalog_path)

    def drop_search_indexes(self) -> None:
        clear_search_indexes(self._catalog_path)

    def rebuild_search_indexes(self) -> None:
        rebuild_search_indexes(self._catalog_path)


__all__ = ("SqliteLibraryReadRepository",)
