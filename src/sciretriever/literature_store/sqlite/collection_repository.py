from __future__ import annotations

import os
import sqlite3

from sciretriever.collection.citation_input import citation_run_input_from_validated
from sciretriever.collection.run_results import validate_finish_collection_run
from sciretriever.collection.topic import validate_topic_condition_set
from sciretriever.kernel import (
    BoundaryError,
    CanonicalJsonObject,
    parse_canonical_json,
)
from sciretriever.literature_store.sqlite.engine import (
    create_or_open_catalog,
    open_read_only_snapshot,
)
from sciretriever.model.collection import (
    CausePage,
    CausePageRequest,
    CitationRunInput,
    CollectionCauseFact,
    CollectionCounts,
    CollectionDefinition,
    CollectionMember,
    CollectionPathFact,
    CollectionRunRecord,
    CollectionSourceResult,
    CreateCollectionDefinition,
    FinishCollectionRun,
    MembershipPage,
    MembershipPageRequest,
    PathPage,
    PathPageRequest,
    StartCollectionRun,
    ValidatedCitationInput,
    ValidatedTopicConditionSet,
)
from sciretriever.model.primitives import (
    CitationDirection,
    CollectionCauseId,
    CollectionCauseKind,
    CollectionId,
    CollectionPathId,
    CollectionRunId,
    CollectionRunStatus,
    MembershipId,
    UtcTimestamp,
    WorkId,
    sha256_digest,
)


def _timestamp(value: str) -> UtcTimestamp:
    normalized = value.replace(" ", "T")
    return UtcTimestamp(normalized if normalized.endswith("Z") else normalized + "Z")


def _required_count(value: int | None) -> int:
    if value is None:
        raise sqlite3.DatabaseError("collection run has incomplete aggregate counts")
    return value


def _definition(row: tuple[str, str, str | None, str | None, str]) -> CollectionDefinition:
    identifier, name, description, conditions, created_at = row
    validated = None
    if conditions is not None:
        validated = ValidatedTopicConditionSet(
            canonical_json=conditions,
            sha256=sha256_digest(conditions.encode("ascii")),
        )
        validate_topic_condition_set(validated)
    return CollectionDefinition(
        collection_id=CollectionId(identifier),
        name=name,
        description=description,
        topic_conditions=validated,
        created_at=_timestamp(created_at),
    )


def _run(
    row: tuple[
        str,
        str,
        str,
        str,
        str,
        str | None,
        str,
        int | None,
        int | None,
        int | None,
        int | None,
        int | None,
        int | None,
    ],
    sources: tuple[CollectionSourceResult, ...],
) -> CollectionRunRecord:
    identifier, collection_id, mode, target, status, reason, created_at = row[:7]
    count_values = row[7:]
    counts = None
    if count_values[0] is not None:
        discovered, accepted, new_members, existing_members, missing, failures = count_values
        counts = CollectionCounts(
            discovered=_required_count(discovered),
            accepted=_required_count(accepted),
            new_members=_required_count(new_members),
            existing_members=_required_count(existing_members),
            missing=_required_count(missing),
            source_failures=_required_count(failures),
        )
    return CollectionRunRecord(
        run_id=CollectionRunId(identifier),
        collection_id=CollectionId(collection_id),
        mode=mode,
        requested_advance_to=target,
        status=CollectionRunStatus(status),
        stop_reason=reason,
        created_at=_timestamp(created_at),
        counts=counts,
        source_results=sources,
    )


def _source(
    row: tuple[int, str, int, int, int, str | None, str | None, str | None, int | None],
) -> CollectionSourceResult:
    ordinal, name, discovered, accepted, missing, code, reason, action, retryable = row
    return CollectionSourceResult(
        ordinal=ordinal,
        source=name,
        discovered=discovered,
        accepted=accepted,
        missing=missing,
        failure_code=code,
        failure_reason=reason,
        failure_action=action,
        retryable=None if retryable is None else bool(retryable),
    )


def _path_work_ids(payload: str) -> tuple[WorkId, ...]:
    value = parse_canonical_json(payload)
    if not isinstance(value, tuple):
        raise sqlite3.DatabaseError("collection path Work IDs are invalid")
    identifiers: list[WorkId] = []
    for item in value:
        if not isinstance(item, str):
            raise sqlite3.DatabaseError("collection path Work IDs are invalid")
        identifiers.append(WorkId(item))
    return tuple(identifiers)


class SqliteCollectionRepository:
    def __init__(self, catalog_path: str | os.PathLike[str]) -> None:
        self._catalog_path = catalog_path

    def create_definition(self, command: CreateCollectionDefinition) -> CollectionDefinition:
        value = command.definition
        conditions = (
            None if value.topic_conditions is None else value.topic_conditions.canonical_json
        )
        with create_or_open_catalog(self._catalog_path) as connection:
            connection.execute(
                "INSERT INTO collections(id,name,description,topic_conditions_json,created_at) "
                "VALUES(?,?,?,?,?)",
                (
                    str(value.collection_id),
                    value.name,
                    value.description,
                    conditions,
                    str(value.created_at),
                ),
            )
            connection.commit()
        return value

    def get_definition(self, collection_id: CollectionId) -> CollectionDefinition | None:
        with open_read_only_snapshot(self._catalog_path) as connection:
            row = connection.execute(
                "SELECT id,name,description,topic_conditions_json,created_at FROM collections "
                "WHERE id=?",
                (str(collection_id),),
            ).fetchone()
        return None if row is None else _definition(row)

    def start_run(self, command: StartCollectionRun) -> CollectionRunRecord:
        topic = (
            None if command.topic_conditions is None else command.topic_conditions.canonical_json
        )
        citation = None if command.citation_input is None else command.citation_input.canonical_json
        with create_or_open_catalog(self._catalog_path) as connection:
            row = connection.execute(
                "INSERT INTO collection_runs(id,collection_id,mode,topic_conditions_json,"
                "citation_input_json,requested_advance_to,status) VALUES(?,?,?,?,?,?,'running') "
                "RETURNING created_at",
                (
                    str(command.run_id),
                    str(command.collection_id),
                    command.mode,
                    topic,
                    citation,
                    command.requested_advance_to,
                ),
            ).fetchone()
            connection.commit()
        if row is None:
            raise sqlite3.DatabaseError("collection run insert returned no timestamp")
        return CollectionRunRecord(
            run_id=command.run_id,
            collection_id=command.collection_id,
            mode=command.mode,
            requested_advance_to=command.requested_advance_to,
            status=CollectionRunStatus.RUNNING,
            stop_reason=None,
            created_at=_timestamp(row[0]),
            counts=None,
            source_results=(),
        )

    def get_run(self, run_id: CollectionRunId) -> CollectionRunRecord | None:
        with open_read_only_snapshot(self._catalog_path) as connection:
            row = connection.execute(
                "SELECT id,collection_id,mode,requested_advance_to,status,stop_reason,"
                "created_at,discovered_count,accepted_count,new_member_count,"
                "existing_member_count,missing_count,source_failure_count FROM collection_runs "
                "WHERE id=?",
                (str(run_id),),
            ).fetchone()
            sources = tuple(
                _source(item)
                for item in connection.execute(
                    "SELECT source_ordinal,source_name,discovered_count,accepted_count,"
                    "missing_count,failure_code,failure_reason,failure_action,retryable FROM "
                    "collection_source_results WHERE collection_run_id=? ORDER BY "
                    "source_ordinal",
                    (str(run_id),),
                ).fetchall()
            )
        return None if row is None else _run(row, sources)

    def get_citation_input(self, run_id: CollectionRunId) -> CitationRunInput | None:
        with open_read_only_snapshot(self._catalog_path) as connection:
            row = connection.execute(
                "SELECT citation_input_json FROM collection_runs WHERE id=? AND mode='citation'",
                (str(run_id),),
            ).fetchone()
        if row is None:
            return None
        value = ValidatedCitationInput(
            canonical_json=row[0], sha256=sha256_digest(row[0].encode("ascii"))
        )
        return citation_run_input_from_validated(value)

    def finish_run(self, command: FinishCollectionRun) -> CollectionRunRecord:
        validate_finish_collection_run(command)
        with create_or_open_catalog(self._catalog_path) as connection:
            row = connection.execute(
                "SELECT collection_id,mode,requested_advance_to,created_at FROM collection_runs "
                "WHERE id=? AND status='running'",
                (str(command.run_id),),
            ).fetchone()
            if row is None:
                raise sqlite3.IntegrityError("collection run is missing or not running")
            counts = command.counts
            cursor = connection.execute(
                "UPDATE collection_runs SET status=?,stop_reason=?,discovered_count=?,"
                "accepted_count=?,new_member_count=?,existing_member_count=?,missing_count=?,"
                "source_failure_count=? WHERE id=? AND status='running'",
                (
                    command.status.value,
                    command.stop_reason,
                    counts.discovered,
                    counts.accepted,
                    counts.new_members,
                    counts.existing_members,
                    counts.missing,
                    counts.source_failures,
                    str(command.run_id),
                ),
            )
            if cursor.rowcount != 1:
                connection.rollback()
                raise sqlite3.IntegrityError("collection run is missing or not running")
            connection.executemany(
                "INSERT INTO collection_source_results(collection_run_id,source_ordinal,"
                "source_name,discovered_count,accepted_count,missing_count,failure_code,"
                "failure_reason,failure_action,retryable) VALUES(?,?,?,?,?,?,?,?,?,?)",
                tuple(
                    (
                        str(command.run_id),
                        item.ordinal,
                        item.source,
                        item.discovered,
                        item.accepted,
                        item.missing,
                        item.failure_code,
                        item.failure_reason,
                        item.failure_action,
                        item.retryable,
                    )
                    for item in command.source_results
                ),
            )
            connection.commit()
        collection_id, mode, target, created_at = row
        return CollectionRunRecord(
            run_id=command.run_id,
            collection_id=CollectionId(collection_id),
            mode=mode,
            requested_advance_to=target,
            status=command.status,
            stop_reason=command.stop_reason,
            created_at=_timestamp(created_at),
            counts=command.counts,
            source_results=command.source_results,
        )

    def list_memberships(self, request: MembershipPageRequest) -> MembershipPage:
        if not 1 <= request.limit <= 1000:
            raise BoundaryError.for_field("limit", "must be from 1 through 1000")
        after = "" if request.after_work_id is None else str(request.after_work_id)
        with open_read_only_snapshot(self._catalog_path) as connection:
            rows = connection.execute(
                "SELECT work_id,first_collection_run_id FROM collection_memberships WHERE "
                "collection_id=? AND work_id>? ORDER BY work_id LIMIT ?",
                (str(request.collection_id), after, request.limit + 1),
            ).fetchall()
        visible = rows[: request.limit]
        members = tuple(
            CollectionMember(
                work_id=WorkId(row[0]),
                first_collection_run_id=CollectionRunId(row[1]),
            )
            for row in visible
        )
        cursor = members[-1].work_id if len(rows) > request.limit else None
        return MembershipPage(members=members, next_after_work_id=cursor)

    def list_causes(self, request: CausePageRequest) -> CausePage:
        after = "" if request.after_cause_id is None else str(request.after_cause_id)
        with open_read_only_snapshot(self._catalog_path) as connection:
            rows = connection.execute(
                "SELECT c.id,c.membership_id,c.collection_run_id,c.kind,c.source,c.seed_work_id "
                "FROM collection_causes c JOIN collection_memberships m ON m.id=c.membership_id "
                "WHERE m.collection_id=? AND c.id>? ORDER BY c.id LIMIT ?",
                (str(request.collection_id), after, request.limit + 1),
            ).fetchall()
        visible = rows[: request.limit]
        causes: list[CollectionCauseFact] = []
        for identifier, membership, run, kind, evidence_json, seed in visible:
            evidence = parse_canonical_json(evidence_json)
            if not isinstance(evidence, CanonicalJsonObject):
                raise sqlite3.DatabaseError("collection cause evidence is not an object")
            causes.append(
                CollectionCauseFact(
                    cause_id=CollectionCauseId(identifier),
                    membership_id=MembershipId(membership),
                    run_id=CollectionRunId(run),
                    kind=CollectionCauseKind(kind),
                    evidence=evidence_json,
                    seed_work_id=None if seed is None else WorkId(seed),
                )
            )
        cursor = causes[-1].cause_id if len(rows) > request.limit else None
        return CausePage(causes=tuple(causes), next_after_cause_id=cursor)

    def list_paths(self, request: PathPageRequest) -> PathPage:
        after = "" if request.after_path_id is None else str(request.after_path_id)
        with open_read_only_snapshot(self._catalog_path) as connection:
            rows = connection.execute(
                "SELECT p.id,p.membership_id,p.collection_run_id,p.direction,p.depth,"
                "p.work_ids_json FROM collection_paths p JOIN collection_memberships m ON "
                "m.id=p.membership_id WHERE m.collection_id=? AND p.id>? ORDER BY p.id LIMIT ?",
                (str(request.collection_id), after, request.limit + 1),
            ).fetchall()
        visible = rows[: request.limit]
        paths: list[CollectionPathFact] = []
        for identifier, membership, run, direction, depth, work_ids_json in visible:
            paths.append(
                CollectionPathFact(
                    path_id=CollectionPathId(identifier),
                    membership_id=MembershipId(membership),
                    run_id=CollectionRunId(run),
                    direction=None if direction is None else CitationDirection(direction),
                    depth=depth,
                    work_ids=_path_work_ids(work_ids_json),
                )
            )
        cursor = paths[-1].path_id if len(rows) > request.limit else None
        return PathPage(paths=tuple(paths), next_after_path_id=cursor)
