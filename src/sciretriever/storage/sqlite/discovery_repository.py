"""SQLite persistence for Entry-owned DiscoveryRun facts.

The adapter implements the four Entry persistence Ports as one path-bound
object.  Every mutation is a short ``BEGIN IMMEDIATE`` transaction and every
public read is reconstructed from one read-only snapshot.  SQLite-only closure
columns never cross the Port boundary.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from typing import Final, TypeAlias, TypeVar

from sciretriever.entry.ports import DiscoveryRunSnapshot, TerminalDiscoveryRunStatus
from sciretriever.model.discovery import (
    CitationDiscoveryCause,
    CitationDiscoveryInput,
    DiscoveryCause,
    DiscoveryResult,
    DiscoveryRun,
    DiscoverySourceResult,
    ProviderDiscoveryLimit,
    TopicDiscoveryCause,
    TopicDiscoveryInput,
)
from sciretriever.model.primitives import (
    DiscoveryRunId,
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    UtcTimestamp,
)
from sciretriever.model.report import StableFailure

from .engine import CatalogEngine

Checkpoint: TypeAlias = Callable[[str], None]

_T = TypeVar("_T")
_TERMINAL_STATUSES: Final[frozenset[str]] = frozenset(
    {"COMPLETED", "PARTIAL", "FAILED", "INTERRUPTED"}
)
_RUN_STATUSES: Final[frozenset[str]] = frozenset({"RUNNING", *_TERMINAL_STATUSES})
_RUN_KINDS: Final[frozenset[str]] = frozenset({"topic", "citation"})
_SOURCE_OUTCOMES: Final[frozenset[str]] = frozenset({"EXHAUSTED", "SCAN_LIMIT_REACHED", "FAILED"})
_CITATION_DIRECTIONS: Final[frozenset[str]] = frozenset({"references", "cited-by", "both"})


class DiscoveryRepositoryError(RuntimeError):
    """Stable, redacted failure at the DiscoveryRun storage boundary."""

    _MESSAGE = "discovery repository failed"

    def __init__(self, _message: object | None = None) -> None:
        super().__init__(self._MESSAGE)


class DiscoveryRunNotFoundError(DiscoveryRepositoryError):
    """The requested DiscoveryRun identity does not exist."""

    _MESSAGE = "discovery run was not found"


class DiscoveryRepositoryConflictError(DiscoveryRepositoryError):
    """The requested publication conflicts with current immutable facts."""

    _MESSAGE = "discovery repository conflicts with current facts"


class DiscoveryRepositoryIntegrityError(DiscoveryRepositoryError):
    """A requested or stored DiscoveryRun fact cannot be represented safely."""

    _MESSAGE = "discovery repository contains invalid facts"


def _text(value: object) -> str:
    if type(value) is not str:
        raise DiscoveryRepositoryIntegrityError()
    return value


def _integer(value: object) -> int:
    if type(value) is not int:
        raise DiscoveryRepositoryIntegrityError()
    return value


def _model(factory: Callable[[], _T]) -> _T:
    try:
        return factory()
    except DiscoveryRepositoryError:
        raise
    except (TypeError, ValueError):
        raise DiscoveryRepositoryIntegrityError() from None


def _require_run_id(value: object) -> DiscoveryRunId:
    if not isinstance(value, DiscoveryRunId):
        raise TypeError("discovery_run_id must be a DiscoveryRunId")
    return value


def _revalidate_run(run: DiscoveryRun) -> DiscoveryRun:
    """Rebuild a possibly copied Model so every nested validator runs again."""

    try:
        return DiscoveryRun.model_validate_json(run.model_dump_json())
    except (TypeError, ValueError):
        raise DiscoveryRepositoryIntegrityError() from None


def _run_row(
    connection: sqlite3.Connection,
    discovery_run_id: str,
) -> tuple[str, str, str]:
    rows = connection.execute(
        "SELECT kind,status,started_at FROM discovery_runs WHERE discovery_run_id=?",
        (discovery_run_id,),
    ).fetchall()
    if not rows:
        raise DiscoveryRunNotFoundError()
    if len(rows) != 1:
        raise DiscoveryRepositoryIntegrityError()
    row = rows[0]
    kind = _text(row[0])
    status = _text(row[1])
    started_at = _text(row[2])
    if kind not in _RUN_KINDS or status not in _RUN_STATUSES:
        raise DiscoveryRepositoryIntegrityError()
    return kind, status, started_at


def _require_running_run(
    connection: sqlite3.Connection,
    discovery_run_id: str,
) -> str:
    kind, status, _started_at = _run_row(connection, discovery_run_id)
    if status != "RUNNING":
        raise DiscoveryRepositoryConflictError()
    return kind


def _provider_limits(
    connection: sqlite3.Connection,
    discovery_run_id: str,
) -> tuple[ProviderDiscoveryLimit, ...]:
    rows = connection.execute(
        "SELECT provider_ordinal,provider_name,scan_limit "
        "FROM discovery_run_providers WHERE discovery_run_id=? "
        "ORDER BY provider_ordinal",
        (discovery_run_id,),
    ).fetchall()
    if not rows:
        raise DiscoveryRepositoryIntegrityError()
    values: list[ProviderDiscoveryLimit] = []
    for expected_ordinal, row in enumerate(rows):
        if _integer(row[0]) != expected_ordinal:
            raise DiscoveryRepositoryIntegrityError()
        provider_name = _text(row[1])
        scan_limit = _integer(row[2])
        values.append(
            _model(
                lambda provider_name=provider_name, scan_limit=scan_limit: ProviderDiscoveryLimit(
                    provider_name=provider_name,
                    scan_limit=scan_limit,
                )
            )
        )
    return tuple(values)


def _topic_input(
    connection: sqlite3.Connection,
    discovery_run_id: str,
    providers: tuple[ProviderDiscoveryLimit, ...],
) -> TopicDiscoveryInput:
    topic_rows = connection.execute(
        "SELECT kind,query,year_from,year_to FROM topic_discovery_inputs WHERE discovery_run_id=?",
        (discovery_run_id,),
    ).fetchall()
    citation_count = _integer(
        connection.execute(
            "SELECT count(*) FROM citation_discovery_inputs WHERE discovery_run_id=?",
            (discovery_run_id,),
        ).fetchone()[0]
    )
    seed_count = _integer(
        connection.execute(
            "SELECT count(*) FROM citation_discovery_seeds WHERE discovery_run_id=?",
            (discovery_run_id,),
        ).fetchone()[0]
    )
    if len(topic_rows) != 1 or citation_count != 0 or seed_count != 0:
        raise DiscoveryRepositoryIntegrityError()
    row = topic_rows[0]
    kind = _text(row[0])
    query = _text(row[1])
    year_from = None if row[2] is None else _integer(row[2])
    year_to = None if row[3] is None else _integer(row[3])
    return _model(
        lambda: TopicDiscoveryInput(
            kind=kind,  # type: ignore[arg-type]
            query=query,
            year_from=year_from,
            year_to=year_to,
            providers=providers,
        )
    )


def _citation_seed_rows(
    connection: sqlite3.Connection,
    discovery_run_id: str,
) -> tuple[tuple[int, str, str], ...]:
    rows = connection.execute(
        "SELECT seed.seed_ordinal,seed.literature_id,literature.meta_literature_id "
        "FROM citation_discovery_seeds AS seed "
        "LEFT JOIN literatures AS literature "
        "ON literature.literature_id=seed.literature_id "
        "WHERE seed.discovery_run_id=? ORDER BY seed.seed_ordinal",
        (discovery_run_id,),
    ).fetchall()
    values: list[tuple[int, str, str]] = []
    for expected_ordinal, row in enumerate(rows):
        ordinal = _integer(row[0])
        literature_id = _text(row[1])
        meta_literature_id = _text(row[2])
        if ordinal != expected_ordinal:
            raise DiscoveryRepositoryIntegrityError()
        values.append((ordinal, literature_id, meta_literature_id))
    if not values:
        raise DiscoveryRepositoryIntegrityError()
    return tuple(values)


def _citation_input(
    connection: sqlite3.Connection,
    discovery_run_id: str,
    providers: tuple[ProviderDiscoveryLimit, ...],
) -> CitationDiscoveryInput:
    citation_rows = connection.execute(
        "SELECT kind,direction,max_depth,result_limit FROM citation_discovery_inputs "
        "WHERE discovery_run_id=?",
        (discovery_run_id,),
    ).fetchall()
    topic_count = _integer(
        connection.execute(
            "SELECT count(*) FROM topic_discovery_inputs WHERE discovery_run_id=?",
            (discovery_run_id,),
        ).fetchone()[0]
    )
    if len(citation_rows) != 1 or topic_count != 0:
        raise DiscoveryRepositoryIntegrityError()
    row = citation_rows[0]
    kind = _text(row[0])
    direction = _text(row[1])
    max_depth = _integer(row[2])
    result_limit = _integer(row[3])
    seeds = tuple(
        _model(lambda literature_id=literature_id: LiteratureId(literature_id))
        for _ordinal, literature_id, _meta_literature_id in _citation_seed_rows(
            connection, discovery_run_id
        )
    )
    return _model(
        lambda: CitationDiscoveryInput(
            kind=kind,  # type: ignore[arg-type]
            seed_literature_ids=seeds,
            direction=direction,  # type: ignore[arg-type]
            max_depth=max_depth,
            result_limit=result_limit,
            providers=providers,
        )
    )


def _read_run(
    connection: sqlite3.Connection,
    discovery_run_id: DiscoveryRunId,
) -> DiscoveryRun:
    identifier = discovery_run_id.root
    kind, status, started_at = _run_row(connection, identifier)
    providers = _provider_limits(connection, identifier)
    if kind == "topic":
        discovery_input = _topic_input(connection, identifier, providers)
    else:
        discovery_input = _citation_input(connection, identifier, providers)
    return _model(
        lambda: DiscoveryRun(
            discovery_run_id=discovery_run_id,
            input=discovery_input,
            status=status,  # type: ignore[arg-type]
            started_at=UtcTimestamp(started_at),
        )
    )


def _source_results(
    connection: sqlite3.Connection,
    run: DiscoveryRun,
) -> tuple[DiscoverySourceResult, ...]:
    identifier = run.discovery_run_id.root
    provider_order = {
        provider.provider_name: ordinal for ordinal, provider in enumerate(run.input.providers)
    }
    rows = connection.execute(
        "SELECT provider_name,outcome,failure_code,failure_reason,failure_action,"
        "failure_retryable FROM discovery_source_results WHERE discovery_run_id=?",
        (identifier,),
    ).fetchall()
    by_provider: dict[str, DiscoverySourceResult] = {}
    for row in rows:
        provider_name = _text(row[0])
        outcome = _text(row[1])
        if provider_name not in provider_order or provider_name in by_provider:
            raise DiscoveryRepositoryIntegrityError()
        if outcome not in _SOURCE_OUTCOMES:
            raise DiscoveryRepositoryIntegrityError()
        failure_values = tuple(row[index] for index in range(2, 6))
        if outcome == "FAILED":
            failure_code = _text(failure_values[0])
            failure_reason = _text(failure_values[1])
            failure_action = _text(failure_values[2])
            retryable_value = _integer(failure_values[3])
            if retryable_value not in (0, 1):
                raise DiscoveryRepositoryIntegrityError()
            failure = _model(
                lambda: StableFailure(
                    code=failure_code,
                    reason=failure_reason,
                    action=failure_action,
                    retryable=bool(retryable_value),
                )
            )
        else:
            if any(value is not None for value in failure_values):
                raise DiscoveryRepositoryIntegrityError()
            failure = None
        by_provider[provider_name] = _model(
            lambda provider_name=provider_name, outcome=outcome, failure=failure: (
                DiscoverySourceResult(
                    discovery_run_id=run.discovery_run_id,
                    provider_name=provider_name,
                    outcome=outcome,  # type: ignore[arg-type]
                    failure=failure,
                )
            )
        )
    return tuple(
        by_provider[name] for name in sorted(by_provider, key=lambda value: provider_order[value])
    )


def _validate_terminal_source_closure(
    status: str,
    provider_count: int,
    outcomes: tuple[str, ...],
) -> None:
    if status == "INTERRUPTED" or status == "RUNNING":
        return
    if len(outcomes) != provider_count:
        raise DiscoveryRepositoryConflictError()
    failed_count = outcomes.count("FAILED")
    valid = (
        (status == "COMPLETED" and failed_count == 0)
        or (status == "PARTIAL" and 0 < failed_count < provider_count)
        or (status == "FAILED" and failed_count == provider_count)
    )
    if not valid:
        raise DiscoveryRepositoryConflictError()


def _validate_stored_terminal_source_closure(
    run: DiscoveryRun,
    source_results: tuple[DiscoverySourceResult, ...],
) -> None:
    try:
        _validate_terminal_source_closure(
            run.status,
            len(run.input.providers),
            tuple(result.outcome for result in source_results),
        )
    except DiscoveryRepositoryConflictError:
        raise DiscoveryRepositoryIntegrityError() from None


def _result_rows(
    connection: sqlite3.Connection,
    run: DiscoveryRun,
) -> tuple[tuple[str, DiscoveryResult], ...]:
    rows = connection.execute(
        "SELECT result.meta_literature_id,meta.meta_literature_id "
        "FROM discovery_results AS result "
        "LEFT JOIN meta_literatures AS meta "
        "ON meta.meta_literature_id=result.meta_literature_id "
        "WHERE result.discovery_run_id=? ORDER BY result.meta_literature_id",
        (run.discovery_run_id.root,),
    ).fetchall()
    values: list[tuple[str, DiscoveryResult]] = []
    seen: set[str] = set()
    for row in rows:
        meta_literature_id = _text(row[0])
        if _text(row[1]) != meta_literature_id or meta_literature_id in seen:
            raise DiscoveryRepositoryIntegrityError()
        seen.add(meta_literature_id)
        values.append(
            (
                meta_literature_id,
                _model(
                    lambda meta_literature_id=meta_literature_id: DiscoveryResult(
                        discovery_run_id=run.discovery_run_id,
                        meta_literature_id=MetaLiteratureId(meta_literature_id),
                    )
                ),
            )
        )
    return tuple(values)


def _topic_actual_literature(
    connection: sqlite3.Connection,
    metadata_observation_id: str,
    meta_literature_id: str,
) -> str:
    rows = connection.execute(
        "SELECT ownership.literature_id "
        "FROM literature_metadata_observations AS ownership "
        "JOIN literatures AS literature "
        "ON literature.literature_id=ownership.literature_id "
        "WHERE ownership.observation_id=? "
        "AND literature.meta_literature_id=?",
        (metadata_observation_id, meta_literature_id),
    ).fetchall()
    if len(rows) != 1:
        raise DiscoveryRepositoryConflictError()
    return _text(rows[0][0])


def _topic_causes(
    connection: sqlite3.Connection,
    run: DiscoveryRun,
    result_ids: frozenset[str],
) -> tuple[TopicDiscoveryCause, ...]:
    identifier = run.discovery_run_id.root
    if (
        _integer(
            connection.execute(
                "SELECT count(*) FROM citation_discovery_causes WHERE discovery_run_id=?",
                (identifier,),
            ).fetchone()[0]
        )
        != 0
    ):
        raise DiscoveryRepositoryIntegrityError()
    rows = connection.execute(
        "SELECT meta_literature_id,metadata_observation_id,actual_literature_id "
        "FROM topic_discovery_causes WHERE discovery_run_id=? "
        "ORDER BY meta_literature_id,metadata_observation_id",
        (identifier,),
    ).fetchall()
    values: list[TopicDiscoveryCause] = []
    caused_results: set[str] = set()
    seen_observations: set[str] = set()
    for row in rows:
        meta_literature_id = _text(row[0])
        observation_id = _text(row[1])
        actual_literature_id = _text(row[2])
        if meta_literature_id not in result_ids or observation_id in seen_observations:
            raise DiscoveryRepositoryIntegrityError()
        try:
            expected_actual = _topic_actual_literature(
                connection, observation_id, meta_literature_id
            )
        except DiscoveryRepositoryConflictError:
            raise DiscoveryRepositoryIntegrityError() from None
        if actual_literature_id != expected_actual:
            raise DiscoveryRepositoryIntegrityError()
        caused_results.add(meta_literature_id)
        seen_observations.add(observation_id)
        values.append(
            _model(
                lambda meta_literature_id=meta_literature_id, observation_id=observation_id: (
                    TopicDiscoveryCause(
                        kind="topic",
                        discovery_run_id=run.discovery_run_id,
                        meta_literature_id=MetaLiteratureId(meta_literature_id),
                        metadata_observation_id=ObservationId(observation_id),
                    )
                )
            )
        )
    if caused_results != set(result_ids):
        raise DiscoveryRepositoryIntegrityError()
    return tuple(values)


def _citation_context(
    connection: sqlite3.Connection,
    discovery_run_id: str,
) -> tuple[str, int, int]:
    rows = connection.execute(
        "SELECT direction,max_depth,result_limit FROM citation_discovery_inputs "
        "WHERE discovery_run_id=?",
        (discovery_run_id,),
    ).fetchall()
    if len(rows) != 1:
        raise DiscoveryRepositoryIntegrityError()
    direction = _text(rows[0][0])
    max_depth = _integer(rows[0][1])
    result_limit = _integer(rows[0][2])
    if direction not in _CITATION_DIRECTIONS or max_depth < 0 or result_limit < 1:
        raise DiscoveryRepositoryIntegrityError()
    return direction, max_depth, result_limit


def _citation_endpoint_rows(
    connection: sqlite3.Connection,
    source_literature_id: str,
    target_literature_id: str,
) -> dict[str, str]:
    rows = connection.execute(
        "SELECT literature_id,meta_literature_id FROM literatures WHERE literature_id IN (?,?)",
        (source_literature_id, target_literature_id),
    ).fetchall()
    values: dict[str, str] = {}
    for row in rows:
        literature_id = _text(row[0])
        meta_literature_id = _text(row[1])
        if literature_id in values:
            raise DiscoveryRepositoryIntegrityError()
        values[literature_id] = meta_literature_id
    if set(values) != {source_literature_id, target_literature_id}:
        raise DiscoveryRepositoryConflictError()
    return values


def _validate_citation_direction(
    direction: str,
    actual_literature_id: str,
    source_literature_id: str,
    target_literature_id: str,
) -> str:
    if direction == "references":
        if actual_literature_id != target_literature_id:
            raise DiscoveryRepositoryConflictError()
        return source_literature_id
    if direction == "cited-by":
        if actual_literature_id != source_literature_id:
            raise DiscoveryRepositoryConflictError()
        return target_literature_id
    if direction == "both":
        return (
            target_literature_id
            if actual_literature_id == source_literature_id
            else source_literature_id
        )
    raise DiscoveryRepositoryIntegrityError()


def _validate_citation_predecessor(
    connection: sqlite3.Connection,
    discovery_run_id: str,
    predecessor_literature_id: str,
    depth: int,
) -> None:
    if depth == 1:
        row = connection.execute(
            "SELECT 1 FROM citation_discovery_seeds WHERE discovery_run_id=? AND literature_id=?",
            (discovery_run_id, predecessor_literature_id),
        ).fetchone()
    else:
        row = connection.execute(
            "SELECT 1 FROM citation_discovery_causes "
            "WHERE discovery_run_id=? AND actual_literature_id=? AND depth=? LIMIT 1",
            (discovery_run_id, predecessor_literature_id, depth - 1),
        ).fetchone()
    if row is None:
        raise DiscoveryRepositoryConflictError()


def _supported_reference_id(
    connection: sqlite3.Connection,
    source_literature_id: str,
    target_literature_id: str,
) -> str:
    rows = connection.execute(
        "SELECT reference_id FROM literature_references "
        "WHERE source_literature_id=? AND target_literature_id=?",
        (source_literature_id, target_literature_id),
    ).fetchall()
    if len(rows) != 1:
        raise DiscoveryRepositoryConflictError()
    reference_id = _text(rows[0][0])
    supported = connection.execute(
        "SELECT EXISTS("
        "SELECT 1 FROM provider_relation_reference_supports WHERE reference_id=? "
        "UNION ALL "
        "SELECT 1 FROM metadata_reference_text_supports WHERE reference_id=? "
        "UNION ALL "
        "SELECT 1 FROM content_reference_text_supports WHERE reference_id=?"
        ")",
        (reference_id, reference_id, reference_id),
    ).fetchone()
    if supported is None or _integer(supported[0]) != 1:
        raise DiscoveryRepositoryConflictError()
    return reference_id


def _citation_actual_literature(
    connection: sqlite3.Connection,
    meta_literature_id: str,
    source_literature_id: str,
    target_literature_id: str,
) -> str:
    endpoints = _citation_endpoint_rows(
        connection,
        source_literature_id,
        target_literature_id,
    )
    matches = tuple(
        literature_id
        for literature_id, endpoint_meta_id in endpoints.items()
        if endpoint_meta_id == meta_literature_id
    )
    if len(matches) != 1:
        raise DiscoveryRepositoryConflictError()
    return matches[0]


def _stored_citation_cause(
    connection: sqlite3.Connection,
    run: DiscoveryRun,
    row: tuple[object, ...],
    result_ids: frozenset[str],
    direction: str,
    max_depth: int,
    public_identities: set[tuple[str, str, int]],
) -> tuple[CitationDiscoveryCause, str, str, int, tuple[str, str, int]]:
    meta_literature_id = _text(row[0])
    source_literature_id = _text(row[1])
    target_literature_id = _text(row[2])
    actual_literature_id = _text(row[3])
    depth = _integer(row[4])
    identity = (source_literature_id, target_literature_id, depth)
    invalid_identity = (
        meta_literature_id not in result_ids
        or identity in public_identities
        or depth < 1
        or depth > max_depth
        or source_literature_id == target_literature_id
    )
    if invalid_identity:
        raise DiscoveryRepositoryIntegrityError()
    try:
        endpoints = _citation_endpoint_rows(
            connection,
            source_literature_id,
            target_literature_id,
        )
        if (
            actual_literature_id not in endpoints
            or endpoints[actual_literature_id] != meta_literature_id
        ):
            raise DiscoveryRepositoryIntegrityError()
        predecessor = _validate_citation_direction(
            direction,
            actual_literature_id,
            source_literature_id,
            target_literature_id,
        )
    except DiscoveryRepositoryConflictError:
        raise DiscoveryRepositoryIntegrityError() from None
    cause = _model(
        lambda: CitationDiscoveryCause(
            kind="citation",
            discovery_run_id=run.discovery_run_id,
            meta_literature_id=MetaLiteratureId(meta_literature_id),
            source_literature_id=LiteratureId(source_literature_id),
            target_literature_id=LiteratureId(target_literature_id),
            depth=depth,
        )
    )
    return cause, actual_literature_id, predecessor, depth, identity


def _citation_causes(
    connection: sqlite3.Connection,
    run: DiscoveryRun,
    result_ids: frozenset[str],
) -> tuple[CitationDiscoveryCause, ...]:
    identifier = run.discovery_run_id.root
    if (
        _integer(
            connection.execute(
                "SELECT count(*) FROM topic_discovery_causes WHERE discovery_run_id=?",
                (identifier,),
            ).fetchone()[0]
        )
        != 0
    ):
        raise DiscoveryRepositoryIntegrityError()
    direction, max_depth, result_limit = _citation_context(connection, identifier)
    seed_rows = _citation_seed_rows(connection, identifier)
    seed_ids = frozenset(row[1] for row in seed_rows)
    if len(result_ids) > result_limit:
        raise DiscoveryRepositoryIntegrityError()
    rows = connection.execute(
        "SELECT meta_literature_id,source_literature_id,target_literature_id,"
        "actual_literature_id,depth FROM citation_discovery_causes "
        "WHERE discovery_run_id=? "
        "ORDER BY meta_literature_id,depth,source_literature_id,target_literature_id",
        (identifier,),
    ).fetchall()
    values: list[CitationDiscoveryCause] = []
    caused_results: set[str] = set()
    actuals_by_depth: dict[int, set[str]] = {}
    public_identities: set[tuple[str, str, int]] = set()
    for raw_row in sorted(rows, key=lambda value: _integer(value[4])):
        cause, actual_literature_id, predecessor, depth, identity = _stored_citation_cause(
            connection,
            run,
            tuple(raw_row),
            result_ids,
            direction,
            max_depth,
            public_identities,
        )
        if actual_literature_id in seed_ids:
            raise DiscoveryRepositoryIntegrityError()
        if depth == 1:
            if predecessor not in seed_ids:
                raise DiscoveryRepositoryIntegrityError()
        elif predecessor not in actuals_by_depth.get(depth - 1, set()):
            raise DiscoveryRepositoryIntegrityError()
        actuals_by_depth.setdefault(depth, set()).add(actual_literature_id)
        caused_results.add(cause.meta_literature_id.root)
        public_identities.add(identity)
        values.append(cause)
    if caused_results != set(result_ids):
        raise DiscoveryRepositoryIntegrityError()
    values.sort(
        key=lambda cause: (
            cause.meta_literature_id.root,
            cause.depth,
            cause.source_literature_id.root,
            cause.target_literature_id.root,
        )
    )
    return tuple(values)


def _snapshot(
    connection: sqlite3.Connection,
    discovery_run_id: DiscoveryRunId,
) -> DiscoveryRunSnapshot:
    run = _read_run(connection, discovery_run_id)
    source_results = _source_results(connection, run)
    _validate_stored_terminal_source_closure(run, source_results)
    result_rows = _result_rows(connection, run)
    result_ids = frozenset(row[0] for row in result_rows)
    if isinstance(run.input, TopicDiscoveryInput):
        causes: tuple[DiscoveryCause, ...] = _topic_causes(
            connection,
            run,
            result_ids,
        )
    elif isinstance(run.input, CitationDiscoveryInput):
        causes = _citation_causes(connection, run, result_ids)
    else:  # pragma: no cover - the closed Model union makes this unreachable.
        raise DiscoveryRepositoryIntegrityError()
    return DiscoveryRunSnapshot(
        run=run,
        source_results=source_results,
        results=tuple(row[1] for row in result_rows),
        causes=causes,
    )


class SqliteDiscoveryRepository:
    """Implement Discovery repository, publication, read, and recovery Ports."""

    __slots__ = ("_engine", "_failpoint")

    def __init__(
        self,
        engine: CatalogEngine,
        *,
        failpoint: Checkpoint | None = None,
    ) -> None:
        if not isinstance(engine, CatalogEngine):
            raise TypeError("engine must be a CatalogEngine")
        if failpoint is not None and not callable(failpoint):
            raise TypeError("failpoint must be callable")
        self._engine = engine
        self._failpoint = failpoint

    def _checkpoint(self, name: str) -> None:
        if self._failpoint is None:
            return
        try:
            self._failpoint(name)
        except DiscoveryRepositoryError:
            raise
        except Exception:
            raise DiscoveryRepositoryError() from None

    def _write(self, operation: Callable[[sqlite3.Connection], _T]) -> _T:
        try:
            with self._engine.write_transaction() as connection:
                return operation(connection)
        except DiscoveryRepositoryError:
            raise
        except sqlite3.IntegrityError:
            raise DiscoveryRepositoryConflictError() from None
        except Exception:
            raise DiscoveryRepositoryError() from None

    def create(self, run: DiscoveryRun) -> None:
        """Atomically create one RUNNING run and its exact typed input."""

        if not isinstance(run, DiscoveryRun):
            raise TypeError("run must be a DiscoveryRun")
        run = _revalidate_run(run)
        if run.status != "RUNNING":
            raise DiscoveryRepositoryIntegrityError()

        def operation(connection: sqlite3.Connection) -> None:
            identifier = run.discovery_run_id.root
            if (
                connection.execute(
                    "SELECT 1 FROM discovery_runs WHERE discovery_run_id=?",
                    (identifier,),
                ).fetchone()
                is not None
            ):
                raise DiscoveryRepositoryConflictError()
            connection.execute(
                "INSERT INTO discovery_runs(discovery_run_id,kind,status,started_at) "
                "VALUES (?,?,?,?)",
                (identifier, run.input.kind, run.status, run.started_at.root),
            )
            self._checkpoint("create-after-run")
            if isinstance(run.input, TopicDiscoveryInput):
                connection.execute(
                    "INSERT INTO topic_discovery_inputs("
                    "discovery_run_id,kind,query,year_from,year_to) VALUES (?,?,?,?,?)",
                    (
                        identifier,
                        run.input.kind,
                        run.input.query,
                        run.input.year_from,
                        run.input.year_to,
                    ),
                )
            elif isinstance(run.input, CitationDiscoveryInput):
                connection.execute(
                    "INSERT INTO citation_discovery_inputs("
                    "discovery_run_id,kind,direction,max_depth,result_limit) "
                    "VALUES (?,?,?,?,?)",
                    (
                        identifier,
                        run.input.kind,
                        run.input.direction,
                        run.input.max_depth,
                        run.input.result_limit,
                    ),
                )
            else:  # pragma: no cover - the closed Model union makes this unreachable.
                raise DiscoveryRepositoryIntegrityError()
            self._checkpoint("create-after-input")
            if isinstance(run.input, CitationDiscoveryInput):
                connection.executemany(
                    "INSERT INTO citation_discovery_seeds("
                    "discovery_run_id,seed_ordinal,literature_id) VALUES (?,?,?)",
                    (
                        (identifier, ordinal, literature_id.root)
                        for ordinal, literature_id in enumerate(run.input.seed_literature_ids)
                    ),
                )
                self._checkpoint("create-after-seeds")
            connection.executemany(
                "INSERT INTO discovery_run_providers("
                "discovery_run_id,provider_ordinal,provider_name,scan_limit) "
                "VALUES (?,?,?,?)",
                (
                    (identifier, ordinal, provider.provider_name, provider.scan_limit)
                    for ordinal, provider in enumerate(run.input.providers)
                ),
            )
            self._checkpoint("create-after-providers")
            self._checkpoint("create-before-commit")

        self._write(operation)

    def publish_source_result(self, result: DiscoverySourceResult) -> None:
        """Publish one provider's unique terminal result for a running run."""

        if not isinstance(result, DiscoverySourceResult):
            raise TypeError("result must be a DiscoverySourceResult")

        def operation(connection: sqlite3.Connection) -> None:
            identifier = result.discovery_run_id.root
            _require_running_run(connection, identifier)
            provider = connection.execute(
                "SELECT 1 FROM discovery_run_providers "
                "WHERE discovery_run_id=? AND provider_name=?",
                (identifier, result.provider_name),
            ).fetchone()
            if provider is None:
                raise DiscoveryRepositoryConflictError()
            if (
                connection.execute(
                    "SELECT 1 FROM discovery_source_results "
                    "WHERE discovery_run_id=? AND provider_name=?",
                    (identifier, result.provider_name),
                ).fetchone()
                is not None
            ):
                raise DiscoveryRepositoryConflictError()
            failure = result.failure
            connection.execute(
                "INSERT INTO discovery_source_results("
                "discovery_run_id,provider_name,outcome,failure_code,failure_reason,"
                "failure_action,failure_retryable) VALUES (?,?,?,?,?,?,?)",
                (
                    identifier,
                    result.provider_name,
                    result.outcome,
                    None if failure is None else failure.code,
                    None if failure is None else failure.reason,
                    None if failure is None else failure.action,
                    None if failure is None else int(failure.retryable),
                ),
            )
            self._checkpoint("source-after-insert")
            self._checkpoint("source-before-commit")

        self._write(operation)

    def _existing_cause_is_exact(
        self,
        connection: sqlite3.Connection,
        result: DiscoveryResult,
        cause: DiscoveryCause,
    ) -> bool:
        identifier = result.discovery_run_id.root
        meta_literature_id = result.meta_literature_id.root
        if isinstance(cause, TopicDiscoveryCause):
            rows = connection.execute(
                "SELECT meta_literature_id FROM topic_discovery_causes "
                "WHERE discovery_run_id=? AND metadata_observation_id=?",
                (identifier, cause.metadata_observation_id.root),
            ).fetchall()
        else:
            rows = connection.execute(
                "SELECT meta_literature_id FROM citation_discovery_causes "
                "WHERE discovery_run_id=? AND source_literature_id=? "
                "AND target_literature_id=? AND depth=?",
                (
                    identifier,
                    cause.source_literature_id.root,
                    cause.target_literature_id.root,
                    cause.depth,
                ),
            ).fetchall()
        if not rows:
            return False
        if len(rows) != 1 or _text(rows[0][0]) != meta_literature_id:
            raise DiscoveryRepositoryConflictError()
        return True

    @staticmethod
    def _result_exists(
        connection: sqlite3.Connection,
        result: DiscoveryResult,
    ) -> bool:
        return (
            connection.execute(
                "SELECT 1 FROM discovery_results WHERE discovery_run_id=? AND meta_literature_id=?",
                (result.discovery_run_id.root, result.meta_literature_id.root),
            ).fetchone()
            is not None
        )

    @staticmethod
    def _ensure_existing_result_has_cause(
        connection: sqlite3.Connection,
        result: DiscoveryResult,
        kind: str,
    ) -> None:
        table = "topic_discovery_causes" if kind == "topic" else "citation_discovery_causes"
        count = connection.execute(
            f"SELECT count(*) FROM {table} WHERE discovery_run_id=? AND meta_literature_id=?",
            (result.discovery_run_id.root, result.meta_literature_id.root),
        ).fetchone()
        if count is None or _integer(count[0]) == 0:
            raise DiscoveryRepositoryIntegrityError()

    @staticmethod
    def _validate_citation_result_not_seed(
        connection: sqlite3.Connection,
        result: DiscoveryResult,
    ) -> None:
        seed = connection.execute(
            "SELECT 1 FROM citation_discovery_seeds AS seed "
            "JOIN literatures AS literature ON literature.literature_id=seed.literature_id "
            "WHERE seed.discovery_run_id=? AND literature.meta_literature_id=? LIMIT 1",
            (result.discovery_run_id.root, result.meta_literature_id.root),
        ).fetchone()
        if seed is not None:
            raise DiscoveryRepositoryConflictError()

    @staticmethod
    def _validate_citation_result_limit(
        connection: sqlite3.Connection,
        result: DiscoveryResult,
        result_limit: int,
    ) -> None:
        count = connection.execute(
            "SELECT count(*) FROM discovery_results WHERE discovery_run_id=?",
            (result.discovery_run_id.root,),
        ).fetchone()
        if count is None or _integer(count[0]) >= result_limit:
            raise DiscoveryRepositoryConflictError()

    def _publish_topic_cause(
        self,
        connection: sqlite3.Connection,
        result: DiscoveryResult,
        cause: TopicDiscoveryCause,
    ) -> None:
        actual_literature_id = _topic_actual_literature(
            connection,
            cause.metadata_observation_id.root,
            result.meta_literature_id.root,
        )
        connection.execute(
            "INSERT INTO topic_discovery_causes("
            "discovery_run_id,meta_literature_id,metadata_observation_id,"
            "actual_literature_id) VALUES (?,?,?,?)",
            (
                result.discovery_run_id.root,
                result.meta_literature_id.root,
                cause.metadata_observation_id.root,
                actual_literature_id,
            ),
        )

    def _publish_citation_cause(
        self,
        connection: sqlite3.Connection,
        result: DiscoveryResult,
        cause: CitationDiscoveryCause,
    ) -> None:
        identifier = result.discovery_run_id.root
        direction, max_depth, _result_limit = _citation_context(connection, identifier)
        if cause.depth > max_depth:
            raise DiscoveryRepositoryConflictError()
        actual_literature_id = _citation_actual_literature(
            connection,
            result.meta_literature_id.root,
            cause.source_literature_id.root,
            cause.target_literature_id.root,
        )
        predecessor = _validate_citation_direction(
            direction,
            actual_literature_id,
            cause.source_literature_id.root,
            cause.target_literature_id.root,
        )
        _validate_citation_predecessor(
            connection,
            identifier,
            predecessor,
            cause.depth,
        )
        _supported_reference_id(
            connection,
            cause.source_literature_id.root,
            cause.target_literature_id.root,
        )
        connection.execute(
            "INSERT INTO citation_discovery_causes("
            "discovery_run_id,meta_literature_id,source_literature_id,"
            "target_literature_id,actual_literature_id,depth) VALUES (?,?,?,?,?,?)",
            (
                identifier,
                result.meta_literature_id.root,
                cause.source_literature_id.root,
                cause.target_literature_id.root,
                actual_literature_id,
                cause.depth,
            ),
        )

    def _ensure_result_for_cause(
        self,
        connection: sqlite3.Connection,
        result: DiscoveryResult,
        cause: DiscoveryCause,
        *,
        result_exists: bool,
    ) -> None:
        identifier = result.discovery_run_id.root
        if isinstance(cause, CitationDiscoveryCause):
            self._validate_citation_result_not_seed(connection, result)
            _direction, _max_depth, result_limit = _citation_context(connection, identifier)
            if not result_exists:
                self._validate_citation_result_limit(connection, result, result_limit)
        if result_exists:
            return
        connection.execute(
            "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES (?,?)",
            (identifier, result.meta_literature_id.root),
        )
        self._checkpoint("result-after-result")

    def _publish_result_transaction(
        self,
        connection: sqlite3.Connection,
        result: DiscoveryResult,
        cause: DiscoveryCause,
    ) -> None:
        identifier = result.discovery_run_id.root
        kind = _require_running_run(connection, identifier)
        if cause.kind != kind:
            raise DiscoveryRepositoryConflictError()
        result_exists = self._result_exists(connection, result)
        if self._existing_cause_is_exact(connection, result, cause):
            if not result_exists:
                raise DiscoveryRepositoryIntegrityError()
            return
        if result_exists:
            self._ensure_existing_result_has_cause(connection, result, kind)
        self._ensure_result_for_cause(
            connection,
            result,
            cause,
            result_exists=result_exists,
        )
        if isinstance(cause, TopicDiscoveryCause):
            self._publish_topic_cause(connection, result, cause)
        else:
            self._publish_citation_cause(connection, result, cause)
        self._checkpoint("result-after-cause")
        self._checkpoint("result-before-commit")

    def publish_result_and_cause(
        self,
        result: DiscoveryResult,
        cause: DiscoveryCause,
    ) -> None:
        """Atomically publish one accepted result and one direct typed cause."""

        if not isinstance(result, DiscoveryResult):
            raise TypeError("result must be a DiscoveryResult")
        if not isinstance(cause, (TopicDiscoveryCause, CitationDiscoveryCause)):
            raise TypeError("cause must be a DiscoveryCause")
        if (
            cause.discovery_run_id != result.discovery_run_id
            or cause.meta_literature_id != result.meta_literature_id
        ):
            raise DiscoveryRepositoryIntegrityError()
        self._write(
            lambda connection: self._publish_result_transaction(
                connection,
                result,
                cause,
            )
        )

    def finalize(
        self,
        discovery_run_id: DiscoveryRunId,
        status: TerminalDiscoveryRunStatus,
    ) -> DiscoveryRun:
        """Atomically move one RUNNING run to exactly one terminal status."""

        identifier = _require_run_id(discovery_run_id).root
        if type(status) is not str or status not in _TERMINAL_STATUSES:
            raise TypeError("status must be a terminal DiscoveryRun status")

        def operation(connection: sqlite3.Connection) -> DiscoveryRun:
            _require_running_run(connection, identifier)
            provider_count_row = connection.execute(
                "SELECT count(*) FROM discovery_run_providers WHERE discovery_run_id=?",
                (identifier,),
            ).fetchone()
            outcome_rows = connection.execute(
                "SELECT outcome FROM discovery_source_results WHERE discovery_run_id=?",
                (identifier,),
            ).fetchall()
            if provider_count_row is None:
                raise DiscoveryRepositoryIntegrityError()
            outcomes = tuple(_text(row[0]) for row in outcome_rows)
            if any(outcome not in _SOURCE_OUTCOMES for outcome in outcomes):
                raise DiscoveryRepositoryIntegrityError()
            _validate_terminal_source_closure(
                status,
                _integer(provider_count_row[0]),
                outcomes,
            )
            cursor = connection.execute(
                "UPDATE discovery_runs SET status=? WHERE discovery_run_id=? AND status='RUNNING'",
                (status, identifier),
            )
            if cursor.rowcount != 1:
                raise DiscoveryRepositoryConflictError()
            self._checkpoint("finalize-after-update")
            finalized = _snapshot(connection, discovery_run_id).run
            self._checkpoint("finalize-before-commit")
            return finalized

        return self._write(operation)

    def read(self, discovery_run_id: DiscoveryRunId) -> DiscoveryRunSnapshot:
        """Reconstruct one complete immutable run from one SQLite snapshot."""

        identifier = _require_run_id(discovery_run_id)
        try:
            with self._engine.read_snapshot() as connection:
                # The run query establishes the SQLite snapshot before a test or
                # diagnostic callback can arrange a concurrent committed writer.
                run = _read_run(connection, identifier)
                self._checkpoint("read-after-run")
                source_results = _source_results(connection, run)
                _validate_stored_terminal_source_closure(run, source_results)
                result_rows = _result_rows(connection, run)
                result_ids = frozenset(row[0] for row in result_rows)
                if isinstance(run.input, TopicDiscoveryInput):
                    causes: tuple[DiscoveryCause, ...] = _topic_causes(
                        connection,
                        run,
                        result_ids,
                    )
                else:
                    causes = _citation_causes(connection, run, result_ids)
                return DiscoveryRunSnapshot(
                    run=run,
                    source_results=source_results,
                    results=tuple(row[1] for row in result_rows),
                    causes=causes,
                )
        except (DiscoveryRunNotFoundError, DiscoveryRepositoryIntegrityError):
            raise
        except DiscoveryRepositoryError:
            raise
        except (TypeError, ValueError):
            raise DiscoveryRepositoryIntegrityError() from None
        except Exception:
            raise DiscoveryRepositoryError() from None

    def interrupt_visible_running(self) -> tuple[DiscoveryRunId, ...]:
        """Atomically mark all currently visible RUNNING runs as INTERRUPTED."""

        def operation(connection: sqlite3.Connection) -> tuple[DiscoveryRunId, ...]:
            rows = connection.execute(
                "SELECT discovery_run_id FROM discovery_runs "
                "WHERE status='RUNNING' ORDER BY discovery_run_id"
            ).fetchall()
            identifiers = tuple(
                _model(lambda value=_text(row[0]): DiscoveryRunId(value)) for row in rows
            )
            if not identifiers:
                return ()
            cursor = connection.execute(
                "UPDATE discovery_runs SET status='INTERRUPTED' WHERE status='RUNNING'"
            )
            if cursor.rowcount != len(identifiers):
                raise DiscoveryRepositoryIntegrityError()
            self._checkpoint("recovery-after-update")
            self._checkpoint("recovery-before-commit")
            return identifiers

        return self._write(operation)


__all__ = (
    "Checkpoint",
    "DiscoveryRepositoryConflictError",
    "DiscoveryRepositoryError",
    "DiscoveryRepositoryIntegrityError",
    "DiscoveryRunNotFoundError",
    "SqliteDiscoveryRepository",
)
