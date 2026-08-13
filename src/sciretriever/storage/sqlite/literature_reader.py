"""Consistent SQLite read projections for the local Literature library.

Every public operation owns exactly one read-only Catalog snapshot.  The
adapter reconstructs temporary immutable Model projections from authoritative
rows and, for current structured content, delegates to the same strict
``VerifiedReader`` path used by Literature publication preconditions.

The package-private :func:`_select_matching_literature_ids` function is the
connection-bound matcher shared by local search and Entry query selectors.  It
never opens a connection, sorts, paginates, interprets a cursor, or persists a
query result.
"""

from __future__ import annotations

import math
import sqlite3
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from functools import cmp_to_key
from typing import TypeVar, cast

from sciretriever.literature.ports import (
    CurrentLiteratureFacts,
    LiteratureCursorError,
    MetaLiteratureReadContext,
    MetaLiteratureReadRequest,
    ProviderRelationObservationReadContext,
    ProviderRelationObservationReadRequest,
    ReferenceCursorPosition,
    SearchCursorPosition,
    decode_reference_cursor,
    decode_search_cursor,
    encode_reference_cursor,
    encode_search_cursor,
    first_missing_step,
    normalize_contains_text,
    normalized_contains,
    quoted_fts5_and_query,
    reference_sort_key,
    relevance_sort_key,
)
from sciretriever.model.acquisition import Asset, AssetRole, LiteratureAsset
from sciretriever.model.library import (
    LibraryQuery,
    LibrarySearchPage,
    LibrarySearchRequest,
    LibrarySort,
    LiteratureAssetView,
    LiteratureDetail,
    LiteratureReferenceItem,
    LiteratureReferencePage,
    LiteratureReferenceRequest,
    LiteratureSearchItem,
    ReferenceDetail,
)
from sciretriever.model.literature import Reference
from sciretriever.model.primitives import (
    AssetId,
    LiteratureAssetId,
    LiteratureId,
    ReferenceId,
)
from sciretriever.storage.files.reader import VerifiedReader

from .engine import CatalogEngine
from .literature_preconditions import (
    LiteraturePreconditionReadError,
    _catalog_artifact,
    _facts,
    _facts_for_ids,
    _meta_literatures,
    _observations_for_literatures,
    _provenance,
    _provider_relation,
    _references,
    _supports,
)

_T = TypeVar("_T")
_Comparable = TypeVar("_Comparable", int, str)


class LiteratureReaderError(RuntimeError):
    """A local query could not be reconstructed from committed facts."""

    _DEFAULT_MESSAGE = "literature query read failed"

    def __init__(self, _message: object | None = None) -> None:
        super().__init__(self._DEFAULT_MESSAGE)


class LiteratureReaderNotFoundError(LiteratureReaderError):
    """An explicitly requested local Literature object does not exist."""

    _DEFAULT_MESSAGE = "literature query object was not found"


def _sqlite_contains(candidate: object, query: object) -> int:
    """SQLite callback for the authoritative Unicode contains rule."""

    if not isinstance(candidate, str) or not isinstance(query, str):
        return 0
    return int(normalized_contains(candidate, query))


def _register_query_functions(connection: sqlite3.Connection) -> None:
    connection.create_function(
        "sciretriever_contains",
        2,
        _sqlite_contains,
        deterministic=True,
    )


_MATCHER_CTES = """
WITH base_projection AS (
    SELECT
        l.literature_id,
        l.meta_literature_id,
        l.version_role,
        m.metadata_revision,
        m.metadata_sha256,
        m.title,
        m.publication_year,
        m.document_type,
        m.language,
        m.venue,
        m.publisher,
        (
            SELECT la.asset_id
            FROM literature_assets AS la
            WHERE la.literature_id = l.literature_id
              AND la.role = 'primary-pdf'
        ) AS primary_asset_id,
        (
            SELECT asset.sha256
            FROM literature_assets AS relation
            JOIN assets AS asset ON asset.asset_id = relation.asset_id
            WHERE relation.literature_id = l.literature_id
              AND relation.role = 'primary-pdf'
        ) AS primary_asset_sha256,
        EXISTS (
            SELECT 1
            FROM automatic_pdf_acquisition_exhaustions AS exhaustion
            WHERE exhaustion.literature_id = l.literature_id
        ) AS has_pdf_exhaustion
    FROM literatures AS l
    LEFT JOIN literature_metadata AS m
      ON m.literature_id = l.literature_id
),
parser_projection AS (
    SELECT
        base_projection.*,
        (
            SELECT parser.result_sha256
            FROM parser_results AS parser
            WHERE parser.source_asset_id = base_projection.primary_asset_id
              AND parser.source_sha256 = base_projection.primary_asset_sha256
        ) AS parser_result_sha256
    FROM base_projection
),
content_projection AS (
    SELECT
        parser_projection.*,
        EXISTS (
            SELECT 1
            FROM literature_contents AS content
            JOIN assets AS primary_asset
              ON primary_asset.asset_id = content.primary_asset_id
            WHERE content.literature_id = parser_projection.literature_id
              AND content.primary_asset_id = parser_projection.primary_asset_id
              AND content.primary_asset_sha256 = primary_asset.sha256
              AND content.primary_asset_sha256 = parser_projection.primary_asset_sha256
              AND content.metadata_revision = parser_projection.metadata_revision
              AND content.metadata_sha256 = parser_projection.metadata_sha256
        ) AS has_current_content
    FROM parser_projection
),
query_projection AS (
    SELECT
        content_projection.*,
        CASE
            WHEN has_current_content THEN 'CONTENT_READY'
            WHEN primary_asset_id IS NOT NULL THEN 'ASSET_READY'
            ELSE 'UNREVIEWED'
        END AS literature_status,
        CASE
            WHEN primary_asset_id IS NULL THEN 'primary-pdf'
            WHEN parser_result_sha256 IS NULL THEN 'parser-result'
            WHEN NOT has_current_content THEN 'literature-content'
            ELSE NULL
        END AS missing_step
    FROM content_projection
)
"""


def _in_clause(values: tuple[object, ...]) -> str:
    if not values:
        raise LiteratureReaderError()
    return ",".join("?" for _ in values)


def _validate_discovery_cause_closure(
    connection: sqlite3.Connection,
    discovery_run_ids: tuple[str, ...],
) -> None:
    """Fail closed unless every requested result has a valid concrete cause."""

    if not discovery_run_ids:
        return
    placeholders = _in_clause(cast(tuple[object, ...], discovery_run_ids))
    result_rows = connection.execute(
        "SELECT result.discovery_run_id,result.meta_literature_id,run.kind "
        "FROM discovery_results AS result "
        "LEFT JOIN discovery_runs AS run "
        "ON run.discovery_run_id=result.discovery_run_id "
        f"WHERE result.discovery_run_id IN ({placeholders})",
        discovery_run_ids,
    ).fetchall()

    topic_counts: Counter[tuple[str, str]] = Counter()
    topic_rows = connection.execute(
        "SELECT cause.discovery_run_id,cause.meta_literature_id,"
        "cause.metadata_observation_id,cause.actual_literature_id,run.kind,"
        "result.meta_literature_id,owner.literature_id,actual.meta_literature_id "
        "FROM topic_discovery_causes AS cause "
        "LEFT JOIN discovery_runs AS run "
        "ON run.discovery_run_id=cause.discovery_run_id "
        "LEFT JOIN discovery_results AS result "
        "ON result.discovery_run_id=cause.discovery_run_id "
        "AND result.meta_literature_id=cause.meta_literature_id "
        "LEFT JOIN literature_metadata_observations AS owner "
        "ON owner.observation_id=cause.metadata_observation_id "
        "LEFT JOIN literatures AS actual "
        "ON actual.literature_id=cause.actual_literature_id "
        f"WHERE cause.discovery_run_id IN ({placeholders})",
        discovery_run_ids,
    ).fetchall()
    for row in topic_rows:
        run_id, meta_id, _observation_id, actual_id = map(str, row[:4])
        if row[4] != "topic" or row[5] != meta_id or row[6] != actual_id or row[7] != meta_id:
            raise LiteratureReaderError()
        topic_counts[(run_id, meta_id)] += 1

    citation_counts: Counter[tuple[str, str]] = Counter()
    citation_rows = connection.execute(
        "SELECT cause.discovery_run_id,cause.meta_literature_id,"
        "cause.source_literature_id,cause.target_literature_id,"
        "cause.actual_literature_id,run.kind,result.meta_literature_id,"
        "source.literature_id,target.literature_id,actual.meta_literature_id "
        "FROM citation_discovery_causes AS cause "
        "LEFT JOIN discovery_runs AS run "
        "ON run.discovery_run_id=cause.discovery_run_id "
        "LEFT JOIN discovery_results AS result "
        "ON result.discovery_run_id=cause.discovery_run_id "
        "AND result.meta_literature_id=cause.meta_literature_id "
        "LEFT JOIN literatures AS source "
        "ON source.literature_id=cause.source_literature_id "
        "LEFT JOIN literatures AS target "
        "ON target.literature_id=cause.target_literature_id "
        "LEFT JOIN literatures AS actual "
        "ON actual.literature_id=cause.actual_literature_id "
        f"WHERE cause.discovery_run_id IN ({placeholders})",
        discovery_run_ids,
    ).fetchall()
    for row in citation_rows:
        run_id, meta_id, source_id, target_id, actual_id = map(str, row[:5])
        if (
            row[5] != "citation"
            or row[6] != meta_id
            or row[7] != source_id
            or row[8] != target_id
            or actual_id not in {source_id, target_id}
            or row[9] != meta_id
        ):
            raise LiteratureReaderError()
        citation_counts[(run_id, meta_id)] += 1

    for row in result_rows:
        run_id, meta_id = str(row[0]), str(row[1])
        kind = row[2]
        if kind == "topic":
            count = topic_counts[(run_id, meta_id)]
        elif kind == "citation":
            count = citation_counts[(run_id, meta_id)]
        else:
            raise LiteratureReaderError()
        if count < 1:
            raise LiteratureReaderError()


def _select_matching_literature_ids(  # noqa: C901
    connection: sqlite3.Connection,
    query: LibraryQuery,
) -> tuple[LiteratureId, ...]:
    """Return every concrete Literature ID matching ``query``.

    The caller owns the connection and its snapshot.  Result order is the
    stable LiteratureId order only; user-facing ordering, limit and cursor are
    intentionally outside this matcher so Entry can reuse the exact same
    matching semantics when expanding a ``QuerySelector``.
    """

    if not isinstance(connection, sqlite3.Connection):
        raise TypeError("connection must be a sqlite3 Connection")
    if not isinstance(query, LibraryQuery):
        raise TypeError("query must be a LibraryQuery")

    _register_query_functions(connection)
    conditions: list[str] = []
    parameters: list[object] = []

    if query.text is not None:
        fts_query = quoted_fts5_and_query(query.text)
        if fts_query is None:
            return ()
        conditions.append(
            "p.literature_id IN ("
            "SELECT literature_id FROM literature_search_fts "
            "WHERE literature_search_fts MATCH ?)"
        )
        parameters.append(fts_query)
    if query.title is not None:
        conditions.append("sciretriever_contains(p.title, ?) = 1")
        parameters.append(query.title)
    if query.author is not None:
        conditions.append(
            "EXISTS (SELECT 1 FROM literature_metadata_authors AS author "
            "WHERE author.literature_id=p.literature_id "
            "AND (sciretriever_contains(author.display_name, ?)=1 "
            "OR sciretriever_contains(author.given_name, ?)=1 "
            "OR sciretriever_contains(author.family_name, ?)=1))"
        )
        parameters.extend((query.author, query.author, query.author))
    if query.author_orcids:
        values = cast(tuple[object, ...], query.author_orcids)
        conditions.append(
            "EXISTS (SELECT 1 FROM literature_metadata_authors AS author "
            "WHERE author.literature_id=p.literature_id "
            f"AND author.orcid IN ({_in_clause(values)}))"
        )
        parameters.extend(values)
    if query.identifiers:
        identifier_conditions: list[str] = []
        for identifier in query.identifiers:
            identifier_conditions.append("(identifier.namespace=? AND identifier.value=?)")
            parameters.extend((identifier.namespace, identifier.value))
        conditions.append(
            "EXISTS (SELECT 1 FROM literature_metadata_identifiers AS identifier "
            "WHERE identifier.literature_id=p.literature_id AND ("
            + " OR ".join(identifier_conditions)
            + "))"
        )
    if query.publication_year_from is not None:
        conditions.append("p.publication_year>=?")
        parameters.append(query.publication_year_from)
    if query.publication_year_to is not None:
        conditions.append("p.publication_year<=?")
        parameters.append(query.publication_year_to)
    if query.venue is not None:
        conditions.append("sciretriever_contains(p.venue, ?)=1")
        parameters.append(query.venue)
    if query.publisher is not None:
        conditions.append("sciretriever_contains(p.publisher, ?)=1")
        parameters.append(query.publisher)
    if query.document_types:
        values = cast(tuple[object, ...], query.document_types)
        conditions.append(f"p.document_type IN ({_in_clause(values)})")
        parameters.extend(values)
    if query.languages:
        values = cast(tuple[object, ...], query.languages)
        conditions.append(f"p.language IN ({_in_clause(values)})")
        parameters.extend(values)
    for keyword in query.keywords:
        conditions.append(
            "EXISTS (SELECT 1 FROM literature_metadata_keywords AS keyword "
            "WHERE keyword.literature_id=p.literature_id AND keyword.keyword=?)"
        )
        parameters.append(keyword)
    if query.version_roles:
        values = tuple(item.value for item in query.version_roles)
        conditions.append(f"p.version_role IN ({_in_clause(cast(tuple[object, ...], values))})")
        parameters.extend(values)
    if query.statuses:
        values = tuple(item.value for item in query.statuses)
        conditions.append(
            f"p.literature_status IN ({_in_clause(cast(tuple[object, ...], values))})"
        )
        parameters.extend(values)
    if query.missing_steps:
        values = cast(tuple[object, ...], query.missing_steps)
        conditions.append(f"p.missing_step IN ({_in_clause(values)})")
        parameters.extend(values)
    if query.needs_manual_pdf is not None:
        if query.needs_manual_pdf:
            conditions.append("p.primary_asset_id IS NULL AND p.has_pdf_exhaustion")
        else:
            conditions.append("NOT p.has_pdf_exhaustion")
    if query.discovery_run_ids:
        values = tuple(item.root for item in query.discovery_run_ids)
        _validate_discovery_cause_closure(connection, values)
        placeholders = _in_clause(cast(tuple[object, ...], values))
        conditions.append(
            "(EXISTS ("
            "SELECT 1 FROM topic_discovery_causes AS topic_cause "
            f"WHERE topic_cause.discovery_run_id IN ({placeholders}) "
            "AND topic_cause.actual_literature_id=p.literature_id"
            ") OR EXISTS ("
            "SELECT 1 FROM citation_discovery_causes AS citation_cause "
            f"WHERE citation_cause.discovery_run_id IN ({placeholders}) "
            "AND citation_cause.actual_literature_id=p.literature_id"
            "))"
        )
        parameters.extend(values)
        parameters.extend(values)

    where = "" if not conditions else " WHERE " + " AND ".join(conditions)
    rows = connection.execute(
        _MATCHER_CTES
        + "SELECT DISTINCT p.literature_id FROM query_projection AS p"
        + where
        + " ORDER BY p.literature_id",
        tuple(parameters),
    ).fetchall()
    return tuple(LiteratureId(str(row[0])) for row in rows)


def _needs_manual_pdf(connection: sqlite3.Connection, literature_id: LiteratureId) -> bool:
    row = connection.execute(
        "SELECT "
        "NOT EXISTS(SELECT 1 FROM literature_assets "
        "WHERE literature_id=? AND role='primary-pdf') "
        "AND EXISTS(SELECT 1 FROM automatic_pdf_acquisition_exhaustions "
        "WHERE literature_id=?)",
        (literature_id.root, literature_id.root),
    ).fetchone()
    if row is None or type(row[0]) is not int:
        raise LiteratureReaderError()
    return bool(row[0])


def _search_item(
    connection: sqlite3.Connection,
    facts: CurrentLiteratureFacts,
) -> LiteratureSearchItem:
    return LiteratureSearchItem(
        literature=facts.literature,
        metadata_revision=facts.metadata_revision,
        metadata_sha256=facts.metadata_sha256,
        missing_step=first_missing_step(facts),
        needs_manual_pdf=_needs_manual_pdf(connection, facts.literature.literature_id),
    )


@dataclass(frozen=True, slots=True)
class _SearchProjection:
    item: LiteratureSearchItem
    relevance: float | None = None


def _search_position(
    projection: _SearchProjection,
    sort: LibrarySort,
) -> SearchCursorPosition:
    literature = projection.item.literature
    if sort in {"publication-year-desc", "publication-year-asc"}:
        return SearchCursorPosition(
            literature_id=literature.literature_id,
            publication_year=literature.metadata.publication_year,
        )
    if sort in {"title-asc", "title-desc"}:
        return SearchCursorPosition(
            literature_id=literature.literature_id,
            normalized_title=(
                None
                if literature.metadata.title is None
                else normalize_contains_text(literature.metadata.title)
            ),
        )
    if projection.relevance is None:
        raise LiteratureReaderError()
    return SearchCursorPosition(
        literature_id=literature.literature_id,
        relevance=projection.relevance,
    )


def _compare_nullable(
    first: _Comparable | None,
    second: _Comparable | None,
    *,
    descending: bool,
) -> int:
    if first is None:
        return 0 if second is None else 1
    if second is None:
        return -1
    if first == second:
        return 0
    before = first < second
    if descending:
        return 1 if before else -1
    return -1 if before else 1


def _compare_search_positions(
    first: SearchCursorPosition,
    second: SearchCursorPosition,
    sort: LibrarySort,
) -> int:
    if sort in {"publication-year-desc", "publication-year-asc"}:
        comparison = _compare_nullable(
            first.publication_year,
            second.publication_year,
            descending=sort == "publication-year-desc",
        )
    elif sort in {"title-asc", "title-desc"}:
        comparison = _compare_nullable(
            first.normalized_title,
            second.normalized_title,
            descending=sort == "title-desc",
        )
    else:
        if first.relevance is None or second.relevance is None:
            raise LiteratureReaderError()
        first_key = relevance_sort_key(first.relevance, first.literature_id)
        second_key = relevance_sort_key(second.relevance, second.literature_id)
        return (first_key > second_key) - (first_key < second_key)
    if comparison:
        return comparison
    first_id = first.literature_id.root
    second_id = second.literature_id.root
    return (first_id > second_id) - (first_id < second_id)


def _relevance_scores(
    connection: sqlite3.Connection,
    query: LibraryQuery,
    literature_ids: tuple[LiteratureId, ...],
) -> dict[LiteratureId, float]:
    if not literature_ids or query.text is None:
        return {}
    fts_query = quoted_fts5_and_query(query.text)
    if fts_query is None:
        return {}
    requested = set(literature_ids)
    scores: dict[LiteratureId, float] = {}
    rows = connection.execute(
        "SELECT literature_id,bm25(literature_search_fts) "
        "FROM literature_search_fts WHERE literature_search_fts MATCH ?",
        (fts_query,),
    ).fetchall()
    for row in rows:
        literature_id = LiteratureId(str(row[0]))
        if literature_id not in requested:
            continue
        if literature_id in scores or not isinstance(row[1], (int, float)):
            raise LiteratureReaderError()
        score = float(row[1])
        if not math.isfinite(score):
            raise LiteratureReaderError()
        relevance_sort_key(score, literature_id)
        scores[literature_id] = score
    if set(scores) != requested:
        raise LiteratureReaderError()
    return scores


def _facts_exact(
    connection: sqlite3.Connection,
    verified_reader: VerifiedReader,
    literature_ids: tuple[LiteratureId, ...],
) -> tuple[CurrentLiteratureFacts, ...]:
    facts = _facts_for_ids(
        connection,
        verified_reader,
        {item.root for item in literature_ids},
    )
    if {item.literature.literature_id for item in facts} != set(literature_ids):
        raise LiteratureReaderNotFoundError()
    return facts


def _asset_views(
    connection: sqlite3.Connection,
    literature_id: LiteratureId,
) -> tuple[LiteratureAssetView, ...]:
    rows = connection.execute(
        "SELECT la.literature_asset_id,la.literature_id,la.asset_id,la.role,"
        "la.provenance_id,la.source_url,a.sha256,a.size_bytes,a.media_type,a.relative_path "
        "FROM literature_assets AS la JOIN assets AS a ON a.asset_id=la.asset_id "
        "WHERE la.literature_id=? ORDER BY la.role,la.literature_asset_id",
        (literature_id.root,),
    ).fetchall()
    values: list[LiteratureAssetView] = []
    for row in rows:
        artifact = _catalog_artifact(connection, row[9], row[6], row[7], row[8])
        asset = Asset(
            asset_id=AssetId(str(row[2])),
            sha256=artifact.sha256,
            size_bytes=artifact.byte_size,
            media_type=artifact.media_type,
            path=artifact.path,
        )
        relation = LiteratureAsset(
            literature_asset_id=LiteratureAssetId(str(row[0])),
            literature_id=LiteratureId(str(row[1])),
            asset_id=asset.asset_id,
            role=AssetRole(str(row[3])),
            provenance=_provenance(connection, str(row[4])),
            source_url=None if row[5] is None else str(row[5]),
        )
        values.append(LiteratureAssetView(asset=asset, literature_asset=relation))
    return tuple(values)


def _observed_at(value: str) -> datetime:
    return datetime.fromisoformat(value[:-1] + "+00:00")


_VERSION_ORDER = {
    "published": 0,
    "accepted-manuscript": 1,
    "preprint": 2,
    "other": 3,
}


class LiteratureReader:
    """Implement Literature's unified SQLite query Port."""

    def __init__(self, engine: CatalogEngine, verified_reader: VerifiedReader) -> None:
        if not isinstance(engine, CatalogEngine):
            raise TypeError("engine must be a CatalogEngine")
        if not isinstance(verified_reader, VerifiedReader):
            raise TypeError("verified_reader must be a VerifiedReader")
        self._engine = engine
        self._verified_reader = verified_reader

    def _read(self, operation: Callable[[sqlite3.Connection], _T]) -> _T:
        try:
            with self._engine.read_snapshot() as connection:
                return operation(connection)
        except (LiteratureCursorError, LiteratureReaderError):
            raise
        except LiteraturePreconditionReadError:
            raise LiteratureReaderError() from None
        except Exception:
            raise LiteratureReaderError() from None

    def search(self, request: LibrarySearchRequest) -> LibrarySearchPage:
        if not isinstance(request, LibrarySearchRequest):
            raise TypeError("request must be a LibrarySearchRequest")
        return self._read(lambda connection: self._search(connection, request))

    def _search(
        self,
        connection: sqlite3.Connection,
        request: LibrarySearchRequest,
    ) -> LibrarySearchPage:
        cursor_position = (
            None
            if request.cursor is None
            else decode_search_cursor(request.cursor, request.query, request.sort)
        )
        literature_ids = _select_matching_literature_ids(connection, request.query)
        facts = _facts_exact(
            connection,
            self._verified_reader,
            literature_ids,
        )
        facts_by_id = {item.literature.literature_id: item for item in facts}
        relevance = (
            _relevance_scores(connection, request.query, literature_ids)
            if request.sort == "relevance"
            else {}
        )
        projections = [
            _SearchProjection(
                item=_search_item(connection, facts_by_id[literature_id]),
                relevance=relevance.get(literature_id),
            )
            for literature_id in literature_ids
        ]
        projections.sort(
            key=cmp_to_key(
                lambda first, second: _compare_search_positions(
                    _search_position(first, request.sort),
                    _search_position(second, request.sort),
                    request.sort,
                )
            )
        )
        if cursor_position is not None:
            projections = [
                item
                for item in projections
                if _compare_search_positions(
                    _search_position(item, request.sort),
                    cursor_position,
                    request.sort,
                )
                > 0
            ]
        page_values = projections[: request.limit]
        has_more = len(projections) > request.limit
        next_cursor = None
        if has_more and page_values:
            next_cursor = encode_search_cursor(
                request.query,
                request.sort,
                _search_position(page_values[-1], request.sort),
            )
        return LibrarySearchPage(
            items=tuple(item.item for item in page_values),
            total_count=len(literature_ids),
            next_cursor=next_cursor,
        )

    def read_detail(self, literature_id: LiteratureId) -> LiteratureDetail:
        if not isinstance(literature_id, LiteratureId):
            raise TypeError("literature_id must be a LiteratureId")
        return self._read(lambda connection: self._read_detail(connection, literature_id))

    def _read_detail(
        self,
        connection: sqlite3.Connection,
        literature_id: LiteratureId,
    ) -> LiteratureDetail:
        facts = _facts(connection, self._verified_reader, literature_id.root)
        if facts is None:
            raise LiteratureReaderNotFoundError()
        meta_values = _meta_literatures(
            connection,
            {facts.literature.meta_literature_id.root},
        )
        if len(meta_values) != 1:
            raise LiteratureReaderError()
        observation_values = _observations_for_literatures(
            connection,
            {literature_id.root},
        )
        observation_values = tuple(
            sorted(
                sorted(
                    observation_values,
                    key=lambda item: item.observation.observation_id.root,
                ),
                key=lambda item: _observed_at(item.observation.provenance.observed_at.root),
                reverse=True,
            )
        )
        assets = _asset_views(connection, literature_id)
        primary_values = tuple(
            item for item in assets if item.literature_asset.role is AssetRole.PRIMARY_PDF
        )
        if len(primary_values) > 1:
            raise LiteratureReaderError()
        additional_assets = tuple(
            item for item in assets if item.literature_asset.role is not AssetRole.PRIMARY_PDF
        )

        member_rows = connection.execute(
            "SELECT literature_id FROM literatures WHERE meta_literature_id=? "
            "AND literature_id<>? ORDER BY literature_id",
            (facts.literature.meta_literature_id.root, literature_id.root),
        ).fetchall()
        other_ids = tuple(LiteratureId(str(row[0])) for row in member_rows)
        other_facts = _facts_exact(
            connection,
            self._verified_reader,
            other_ids,
        )
        other_versions = tuple(
            _search_item(connection, item)
            for item in sorted(
                other_facts,
                key=lambda item: (
                    _VERSION_ORDER[item.literature.version_role.value],
                    item.literature.literature_id.root,
                ),
            )
        )

        incident_references = _references(connection, incident_id=literature_id.root)
        _supports(connection, incident_references)
        reference_count = sum(
            item.source_literature_id == literature_id for item in incident_references
        )
        cited_by_count = sum(
            item.target_literature_id == literature_id for item in incident_references
        )
        return LiteratureDetail(
            literature=facts.literature,
            meta_literature=meta_values[0],
            metadata_revision=facts.metadata_revision,
            metadata_sha256=facts.metadata_sha256,
            missing_step=first_missing_step(facts),
            needs_manual_pdf=_needs_manual_pdf(connection, literature_id),
            metadata_observations=tuple(item.observation for item in observation_values),
            primary_pdf=None if not primary_values else primary_values[0],
            additional_assets=additional_assets,
            parser_result=facts.current_parser_result,
            content=facts.current_content,
            other_versions=other_versions,
            reference_count=reference_count,
            cited_by_count=cited_by_count,
        )

    def read_references(
        self,
        request: LiteratureReferenceRequest,
    ) -> LiteratureReferencePage:
        if not isinstance(request, LiteratureReferenceRequest):
            raise TypeError("request must be a LiteratureReferenceRequest")
        return self._read(lambda connection: self._read_references(connection, request))

    def _read_references(
        self,
        connection: sqlite3.Connection,
        request: LiteratureReferenceRequest,
    ) -> LiteratureReferencePage:
        requested_facts = _facts(
            connection,
            self._verified_reader,
            request.literature_id.root,
        )
        if requested_facts is None:
            raise LiteratureReaderNotFoundError()
        cursor_position = (
            None if request.cursor is None else decode_reference_cursor(request.cursor, request)
        )
        incident = _references(connection, incident_id=request.literature_id.root)
        if request.direction == "references":
            references = tuple(
                item for item in incident if item.source_literature_id == request.literature_id
            )
            related_ids = tuple(item.target_literature_id for item in references)
        else:
            references = tuple(
                item for item in incident if item.target_literature_id == request.literature_id
            )
            related_ids = tuple(item.source_literature_id for item in references)
        supports = _supports(connection, references)
        support_counts = Counter(item.reference_id for item in supports)
        related_facts = _facts_exact(
            connection,
            self._verified_reader,
            related_ids,
        )
        facts_by_id = {item.literature.literature_id: item for item in related_facts}
        values: list[tuple[tuple[bool, int, bool, str, str], LiteratureReferenceItem]] = []
        for reference, related_id in zip(references, related_ids, strict=True):
            facts = facts_by_id[related_id]
            metadata = facts.literature.metadata
            values.append(
                (
                    reference_sort_key(
                        metadata.publication_year,
                        metadata.title,
                        related_id,
                    ),
                    LiteratureReferenceItem(
                        reference=reference,
                        related_literature=_search_item(connection, facts),
                        support_count=support_counts[reference.reference_id],
                    ),
                )
            )
        values.sort(key=lambda item: item[0])
        if cursor_position is not None:
            cursor_key = reference_sort_key(
                cursor_position.publication_year,
                cursor_position.normalized_title,
                cursor_position.related_literature_id,
            )
            values = [item for item in values if item[0] > cursor_key]
        page_values = values[: request.limit]
        has_more = len(values) > request.limit
        next_cursor = None
        if has_more and page_values:
            last = page_values[-1][1].related_literature.literature
            next_cursor = encode_reference_cursor(
                request,
                ReferenceCursorPosition(
                    related_literature_id=last.literature_id,
                    publication_year=last.metadata.publication_year,
                    normalized_title=(
                        None
                        if last.metadata.title is None
                        else normalize_contains_text(last.metadata.title)
                    ),
                ),
            )
        return LiteratureReferencePage(
            items=tuple(item[1] for item in page_values),
            total_count=len(references),
            next_cursor=next_cursor,
        )

    def read_reference_detail(self, reference_id: ReferenceId) -> ReferenceDetail:
        if not isinstance(reference_id, ReferenceId):
            raise TypeError("reference_id must be a ReferenceId")
        return self._read(lambda connection: self._read_reference_detail(connection, reference_id))

    def _read_reference_detail(
        self,
        connection: sqlite3.Connection,
        reference_id: ReferenceId,
    ) -> ReferenceDetail:
        row = connection.execute(
            "SELECT reference_id,source_literature_id,target_literature_id "
            "FROM literature_references WHERE reference_id=?",
            (reference_id.root,),
        ).fetchone()
        if row is None:
            raise LiteratureReaderNotFoundError()
        reference = Reference(
            reference_id=ReferenceId(str(row[0])),
            source_literature_id=LiteratureId(str(row[1])),
            target_literature_id=LiteratureId(str(row[2])),
        )
        facts = _facts_exact(
            connection,
            self._verified_reader,
            (reference.source_literature_id, reference.target_literature_id),
        )
        facts_by_id = {item.literature.literature_id: item for item in facts}
        return ReferenceDetail(
            reference=reference,
            source=_search_item(
                connection,
                facts_by_id[reference.source_literature_id],
            ),
            target=_search_item(
                connection,
                facts_by_id[reference.target_literature_id],
            ),
            supports=_supports(connection, (reference,)),
        )

    def read_meta_literatures(
        self,
        request: MetaLiteratureReadRequest,
    ) -> MetaLiteratureReadContext:
        if not isinstance(request, MetaLiteratureReadRequest):
            raise TypeError("request must be a MetaLiteratureReadRequest")
        return self._read(lambda connection: self._read_meta_literatures(connection, request))

    def _read_meta_literatures(
        self,
        connection: sqlite3.Connection,
        request: MetaLiteratureReadRequest,
    ) -> MetaLiteratureReadContext:
        requested = {item.root for item in request.meta_literature_ids}
        try:
            meta_literatures = _meta_literatures(connection, requested)
        except LiteraturePreconditionReadError:
            raise LiteratureReaderNotFoundError() from None
        placeholders = _in_clause(cast(tuple[object, ...], tuple(sorted(requested))))
        rows = connection.execute(
            "SELECT literature_id FROM literatures "
            f"WHERE meta_literature_id IN ({placeholders}) ORDER BY literature_id",
            tuple(sorted(requested)),
        ).fetchall()
        literature_ids = tuple(LiteratureId(str(row[0])) for row in rows)
        facts = _facts_exact(
            connection,
            self._verified_reader,
            literature_ids,
        )
        return MetaLiteratureReadContext(
            meta_literatures=meta_literatures,
            facts=facts,
        )

    def read_provider_relation_observations(
        self,
        request: ProviderRelationObservationReadRequest,
    ) -> ProviderRelationObservationReadContext:
        if not isinstance(request, ProviderRelationObservationReadRequest):
            raise TypeError("request must be a ProviderRelationObservationReadRequest")
        return self._read(
            lambda connection: self._read_provider_relation_observations(
                connection,
                request,
            )
        )

    @staticmethod
    def _read_provider_relation_observations(
        connection: sqlite3.Connection,
        request: ProviderRelationObservationReadRequest,
    ) -> ProviderRelationObservationReadContext:
        values = []
        for observation_id in sorted(request.observation_ids, key=str):
            value = _provider_relation(connection, observation_id.root)
            if value is not None:
                values.append(value)
        return ProviderRelationObservationReadContext(observations=tuple(values))


SQLiteLiteratureQueryReader = LiteratureReader


__all__ = (
    "LiteratureReader",
    "LiteratureReaderError",
    "LiteratureReaderNotFoundError",
    "SQLiteLiteratureQueryReader",
)
