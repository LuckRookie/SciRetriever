from __future__ import annotations

import sqlite3

from sciretriever.kernel import BoundaryError
from sciretriever.model.library_pages import LibraryPage, LibraryPageRequest
from sciretriever.model.library_query import QueryFilterV1
from sciretriever.model.library_views import WorkSummary, WorkVersionSummary
from sciretriever.model.primitives import (
    VersionRole,
    WorkId,
    WorkVersionId,
    WorkVersionState,
)

SqlParameter = str | int | float | bytes | None


def _placeholders(values: tuple[SqlParameter, ...]) -> str:
    return ",".join("?" for _ in values)


def _literal(value: str) -> str:
    escaped = value.casefold().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return "%" + escaped + "%"


def _where(  # noqa: C901
    filters: QueryFilterV1,
) -> tuple[str, tuple[SqlParameter, ...]]:
    clauses: list[str] = []
    parameters: list[SqlParameter] = []
    values = "json_extract(s.values_json, '$')"
    scalar_filters = (
        (filters.title, f"lower(json_extract({values},'$.title')) LIKE ? ESCAPE '\\'"),
    )
    for value, clause in scalar_filters:
        if value is not None:
            clauses.append(clause)
            parameters.append(_literal(value))
    repeated = (
        (
            filters.authors,
            f"EXISTS(SELECT 1 FROM json_each({values},'$.authors') j WHERE "
            "lower(CASE WHEN j.type='object' THEN json_extract(j.value,'$.display_name') "
            "ELSE j.value END) LIKE ? ESCAPE '\\')",
        ),
        (filters.venues, f"lower(json_extract({values},'$.venue')) LIKE ? ESCAPE '\\'"),
        (
            filters.document_types,
            f"COALESCE(json_extract({values},'$.document_type'),json_extract({values},'$.item_type'))=?",
        ),
        (filters.languages, f"json_extract({values},'$.language')=?"),
    )
    for requested, clause in repeated:
        if requested:
            clauses.append("(" + " OR ".join(clause for _ in requested) + ")")
            parameters.extend(_literal(value) if "LIKE" in clause else value for value in requested)
    if filters.identifiers:
        options: list[str] = []
        for identifier in filters.identifiers:
            options.append("(i.namespace=? AND i.value=?)")
            parameters.extend((identifier.namespace, identifier.value))
        clauses.append(
            "EXISTS(SELECT 1 FROM stable_identifiers i WHERE i.work_version_id=v.id AND ("
            + " OR ".join(options)
            + "))"
        )
    year = f"COALESCE(json_extract({values},'$.publication_year'),json_extract({values},'$.year'))"
    if filters.year_from is not None:
        clauses.append(f"{year}>=?")
        parameters.append(filters.year_from)
    if filters.year_to is not None:
        clauses.append(f"{year}<=?")
        parameters.append(filters.year_to)
    if filters.states:
        clauses.append(f"st.state IN ({_placeholders(filters.states)})")
        parameters.extend(filters.states)
    missing = tuple(
        "completion" if value == "analysis" else value for value in filters.missing_steps
    )
    if missing:
        clauses.append(f"st.missing_step IN ({_placeholders(missing)})")
        parameters.extend(missing)
    if filters.has_current_failure is not None:
        clauses.append(
            ("" if filters.has_current_failure else "NOT ")
            + "EXISTS(SELECT 1 FROM current_failures f WHERE "
            "f.subject_kind='work-version' AND f.subject_id=v.id)"
        )
    availability = (
        (filters.asset_available, "accepted_primary_assets", "work_version_id"),
        (
            filters.light_document_available,
            "work_version_current_light_document",
            "work_version_id",
        ),
        (filters.analysis_available, "completion_bundles", "work_version_id"),
    )
    for expected, table, column in availability:
        if expected is not None:
            clauses.append(
                ("" if expected else "NOT ")
                + f"EXISTS(SELECT 1 FROM {table} a WHERE a.{column}=v.id)"
            )
    if filters.collection_ids:
        clauses.append(
            "EXISTS(SELECT 1 FROM collection_memberships cm WHERE cm.work_id=v.work_id AND "
            f"cm.collection_id IN ({_placeholders(filters.collection_ids)}))"
        )
        parameters.extend(filters.collection_ids)
    if filters.collection_modes:
        clauses.append(
            "EXISTS(SELECT 1 FROM collection_memberships cm JOIN collection_runs cr ON "
            "cr.id=cm.first_collection_run_id WHERE cm.work_id=v.work_id AND "
            f"cr.mode IN ({_placeholders(filters.collection_modes)}))"
        )
        parameters.extend(filters.collection_modes)
    if filters.discovery_relations:
        relation_clauses: list[str] = []
        for relation in filters.discovery_relations:
            if relation == "member":
                relation_clauses.append(
                    "EXISTS(SELECT 1 FROM collection_memberships cm WHERE cm.work_id=v.work_id)"
                )
            else:
                relation_clauses.append(
                    "EXISTS(SELECT 1 FROM collection_memberships cm JOIN collection_causes cc "
                    "ON cc.membership_id=cm.id WHERE cm.work_id=v.work_id AND cc.kind=?)"
                )
                parameters.append(relation)
        clauses.append("(" + " OR ".join(relation_clauses) + ")")
    for namespace in filters.extension_namespaces:
        clauses.append(
            "EXISTS(SELECT 1 FROM opaque_extension_records x WHERE x.namespace=? AND "
            "json_extract(x.payload_json,'$.work_version_id')=v.id)"
        )
        parameters.append(namespace)
    if filters.query is not None:
        clauses.append(
            "EXISTS(SELECT 1 FROM (SELECT work_version_id FROM metadata_fts WHERE metadata_fts "
            "MATCH ? UNION SELECT work_version_id FROM light_text_fts WHERE light_text_fts "
            "MATCH ? UNION SELECT work_version_id FROM analysis_fts WHERE analysis_fts MATCH ?) "
            "q WHERE q.work_version_id=v.id)"
        )
        parameters.extend((filters.query, filters.query, filters.query))
    return (" AND ".join(clauses) if clauses else "1=1", tuple(parameters))


def search(
    connection: sqlite3.Connection, filters: QueryFilterV1, request: LibraryPageRequest
) -> LibraryPage:
    where, parameters = _where(filters)
    cursor_clause = ""
    if request.cursor is not None:
        cursor_clause = " AND (lower(json_extract(s.values_json,'$.title')),v.work_id,v.id)>(?,?,?)"
        parts = request.cursor.split("\0")
        if len(parts) != 3:
            raise BoundaryError.for_field("cursor", "must encode a library ordering key")
        parameters += tuple(parts)
    representative = (
        ""
        if request.include_all_versions
        else " JOIN work_representative_versions r ON r.work_id=v.work_id AND "
        "r.work_version_id=v.id"
    )
    rows = connection.execute(
        "SELECT v.work_id,v.id,v.version_role,json_extract(s.values_json,'$.title'),st.state,"
        "CASE WHEN r2.work_version_id=v.id THEN 1 ELSE 0 END "
        "FROM work_versions v JOIN work_version_current_metadata c ON c.work_version_id=v.id "
        "JOIN metadata_snapshots s ON s.id=c.metadata_snapshot_id JOIN work_version_state_view "
        "st ON st.work_version_id=v.id "
        f"{representative} LEFT JOIN work_representative_versions r2 ON r2.work_id=v.work_id "
        f"WHERE {where}{cursor_clause} "
        "ORDER BY lower(json_extract(s.values_json,'$.title')),v.work_id,CASE v.version_role "
        "WHEN 'formal' THEN 0 WHEN 'accepted-manuscript' THEN 1 WHEN 'preprint' THEN 2 ELSE 3 "
        "END,v.id LIMIT ?",
        (*parameters, request.limit + 1),
    ).fetchall()
    visible = rows[: request.limit]
    items = tuple(
        WorkVersionSummary(
            kind="work-version",
            work_id=WorkId(row[0]),
            work_version_id=WorkVersionId(row[1]),
            version_role=VersionRole(row[2]),
            title=row[3],
            state=WorkVersionState(row[4]),
            is_preferred=bool(row[5]),
        )
        if request.include_all_versions
        else WorkSummary(
            kind="work",
            work_id=WorkId(row[0]),
            work_version_id=WorkVersionId(row[1]),
            preferred_work_version_id=WorkVersionId(row[1]),
            title=row[3],
            state=WorkVersionState(row[4]),
        )
        for row in visible
    )
    next_cursor = None
    if len(rows) > request.limit:
        last = visible[-1]
        next_cursor = "\0".join((last[3].casefold(), last[0], last[1]))
    return LibraryPage(items=items, next_cursor=next_cursor)


__all__ = ("search",)
