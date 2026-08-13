"""Read-only SQLite snapshots for Entry selectors and bounded relation candidates.

The adapter expands the six frozen Entry selectors, exact current facts, and
one bounded provider-relation page.  It reconstructs committed neutral Models
from one query-only transaction and never decides Literature identity,
candidate priority, goal satisfaction, version fallback, or a next step.
Those decisions remain in the owning feature modules.

The connection-bound Literature matcher and current-facts builders are reused
so ``QuerySelector`` has exactly the local ``LibraryQuery`` semantics and the
PDF/ParserResult/LiteratureContent alignment rules have one implementation.
No sqlite row or query text crosses the Entry Port boundary.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from typing import Literal, TypeVar, cast

from sciretriever.entry.ports import (
    CurrentFactsSnapshot,
    ExecutionCurrentFacts,
    LiteratureSelectorSnapshot,
    MetaSelectorSnapshot,
    ProviderRelationCandidatePage,
    ProviderRelationCandidateReadRequest,
    ProviderRelationCandidateRef,
    ProviderRelationSeedFacts,
    SelectorSnapshot,
)
from sciretriever.literature.ports import CurrentLiteratureFacts
from sciretriever.model.acquisition import AutomaticPdfAcquisitionExhaustion
from sciretriever.model.execution import (
    AllPendingSelector,
    BatchSelector,
    DiscoveryRunSelector,
    ImportReportSelector,
    LiteratureSelector,
    MetaLiteratureSelector,
    QuerySelector,
)
from sciretriever.model.library import LibraryQuery
from sciretriever.model.literature import MetaLiterature
from sciretriever.model.metadata import MetadataObservation, ProviderLiteratureKey
from sciretriever.model.primitives import LiteratureId, MetaLiteratureId, ObservationId, SourceKind
from sciretriever.storage.files.reader import VerifiedReader

from .engine import CatalogEngine
from .literature_preconditions import (
    LiteraturePreconditionReadError,
    _facts,
    _facts_for_ids,
    _metadata_observation,
    _provider_relation,
)
from .literature_reader import (
    LiteratureReaderError,
    _select_matching_literature_ids,
)

_T = TypeVar("_T")

_SELECTOR_TYPES = (
    AllPendingSelector,
    DiscoveryRunSelector,
    ImportReportSelector,
    QuerySelector,
    MetaLiteratureSelector,
    LiteratureSelector,
)
_DISCOVERY_KINDS = frozenset({"topic", "citation"})
_DISCOVERY_STATUSES = frozenset({"RUNNING", "COMPLETED", "PARTIAL", "FAILED", "INTERRUPTED"})


class EntryReaderError(RuntimeError):
    """A selector/current-facts snapshot cannot be reconstructed safely."""

    _MESSAGE = "entry current facts read failed"

    def __init__(self, _message: object | None = None) -> None:
        super().__init__(self._MESSAGE)


class EntryReaderNotFoundError(EntryReaderError):
    """An explicit selector identity is not present in the Catalog."""

    _MESSAGE = "entry selector object was not found"


def _text(value: object) -> str:
    if type(value) is not str:
        raise EntryReaderError()
    return cast(str, value)


def _placeholders(values: tuple[object, ...]) -> str:
    if not values:
        raise EntryReaderError()
    return ",".join("?" for _ in values)


def _unique(values: tuple[_T, ...]) -> tuple[_T, ...]:
    result: list[_T] = []
    for value in values:
        if value in result:
            raise EntryReaderError()
        result.append(value)
    return tuple(result)


def _execution_facts(
    connection: sqlite3.Connection,
    current: CurrentLiteratureFacts,
) -> ExecutionCurrentFacts:
    literature_id = current.literature.literature_id
    observations = _metadata_observation_closures(
        connection,
        (literature_id,),
    )[literature_id]
    exhaustion_rows = connection.execute(
        "SELECT literature_id FROM automatic_pdf_acquisition_exhaustions WHERE literature_id=?",
        (literature_id.root,),
    ).fetchall()
    if len(exhaustion_rows) > 1:
        raise EntryReaderError()
    exhaustion: AutomaticPdfAcquisitionExhaustion | None = None
    if exhaustion_rows:
        stored_id = LiteratureId(_text(exhaustion_rows[0][0]))
        if stored_id != literature_id or current.current_primary_pdfs:
            raise EntryReaderError()
        exhaustion = AutomaticPdfAcquisitionExhaustion(literature_id=stored_id)
    return ExecutionCurrentFacts(
        current=current,
        metadata_observations=observations,
        automatic_pdf_exhaustion=exhaustion,
    )


def _exact_facts_by_id(
    connection: sqlite3.Connection,
    verified_reader: VerifiedReader,
    literature_ids: tuple[LiteratureId, ...],
) -> dict[LiteratureId, ExecutionCurrentFacts]:
    _unique(literature_ids)
    if not literature_ids:
        return {}
    values = _facts_for_ids(
        connection,
        verified_reader,
        {item.root for item in literature_ids},
    )
    result: dict[LiteratureId, ExecutionCurrentFacts] = {}
    for current in values:
        identity = current.literature.literature_id
        if identity in result or identity not in literature_ids:
            raise EntryReaderError()
        result[identity] = _execution_facts(connection, current)
    if set(result) != set(literature_ids):
        raise EntryReaderNotFoundError()
    return result


def _all_meta_scope(connection: sqlite3.Connection) -> tuple[MetaLiteratureId, ...]:
    rows = connection.execute(
        "SELECT meta_literature_id FROM meta_literatures ORDER BY meta_literature_id"
    ).fetchall()
    return _unique(tuple(MetaLiteratureId(_text(row[0])) for row in rows))


def _discovery_scope(
    connection: sqlite3.Connection,
    selector: DiscoveryRunSelector,
) -> tuple[MetaLiteratureId, ...]:
    run_rows = connection.execute(
        "SELECT kind,status FROM discovery_runs WHERE discovery_run_id=?",
        (selector.discovery_run_id.root,),
    ).fetchall()
    if not run_rows:
        raise EntryReaderNotFoundError()
    if len(run_rows) != 1:
        raise EntryReaderError()
    kind = _text(run_rows[0][0])
    status = _text(run_rows[0][1])
    if kind not in _DISCOVERY_KINDS or status not in _DISCOVERY_STATUSES:
        raise EntryReaderError()

    rows = connection.execute(
        "SELECT result.meta_literature_id,meta.meta_literature_id "
        "FROM discovery_results AS result "
        "LEFT JOIN meta_literatures AS meta "
        "ON meta.meta_literature_id=result.meta_literature_id "
        "WHERE result.discovery_run_id=? ORDER BY result.meta_literature_id",
        (selector.discovery_run_id.root,),
    ).fetchall()
    scope: list[MetaLiteratureId] = []
    for row in rows:
        result_id = _text(row[0])
        if _text(row[1]) != result_id:
            raise EntryReaderError()
        scope.append(MetaLiteratureId(result_id))
    result_scope = _unique(tuple(scope))

    # The shared matcher validates that every DiscoveryResult has a valid
    # concrete topic/citation cause.  Comparing its concrete hits with the
    # result rows prevents a broken historical cause from silently widening
    # or shrinking the MetaLiterature selector scope.
    concrete_ids = _select_matching_literature_ids(
        connection,
        LibraryQuery(discovery_run_ids=(selector.discovery_run_id,)),
    )
    concrete_meta_scope = _meta_scope_for_literatures(connection, concrete_ids)
    if set(concrete_meta_scope) != set(result_scope):
        raise EntryReaderError()
    return result_scope


def _meta_scope_for_literatures(
    connection: sqlite3.Connection,
    literature_ids: tuple[LiteratureId, ...],
) -> tuple[MetaLiteratureId, ...]:
    if not literature_ids:
        return ()
    parameters = tuple(item.root for item in literature_ids)
    rows = connection.execute(
        "SELECT literature_id,meta_literature_id FROM literatures "
        f"WHERE literature_id IN ({_placeholders(cast(tuple[object, ...], parameters))})",
        parameters,
    ).fetchall()
    meta_by_literature: dict[LiteratureId, MetaLiteratureId] = {}
    for row in rows:
        literature_id = LiteratureId(_text(row[0]))
        if literature_id in meta_by_literature:
            raise EntryReaderError()
        meta_by_literature[literature_id] = MetaLiteratureId(_text(row[1]))
    if set(meta_by_literature) != set(literature_ids):
        raise EntryReaderError()
    result: list[MetaLiteratureId] = []
    for literature_id in literature_ids:
        meta_literature_id = meta_by_literature[literature_id]
        if meta_literature_id not in result:
            result.append(meta_literature_id)
    return tuple(result)


def _query_scope(
    connection: sqlite3.Connection,
    selector: QuerySelector,
) -> tuple[MetaLiteratureId, ...]:
    concrete_ids = _select_matching_literature_ids(connection, selector.query)
    return _meta_scope_for_literatures(connection, concrete_ids)


def _meta_rows(
    connection: sqlite3.Connection,
    scope: tuple[MetaLiteratureId, ...],
) -> dict[MetaLiteratureId, MetaLiterature]:
    _unique(scope)
    if not scope:
        return {}
    parameters = tuple(item.root for item in scope)
    rows = connection.execute(
        "SELECT meta_literature_id,representative_literature_id FROM meta_literatures "
        f"WHERE meta_literature_id IN ({_placeholders(cast(tuple[object, ...], parameters))})",
        parameters,
    ).fetchall()
    result: dict[MetaLiteratureId, MetaLiterature] = {}
    for row in rows:
        meta_literature = MetaLiterature(
            meta_literature_id=MetaLiteratureId(_text(row[0])),
            representative_literature_id=LiteratureId(_text(row[1])),
        )
        if meta_literature.meta_literature_id in result:
            raise EntryReaderError()
        result[meta_literature.meta_literature_id] = meta_literature
    if set(result) != set(scope):
        raise EntryReaderNotFoundError()
    return result


def _member_ids(
    connection: sqlite3.Connection,
    scope: tuple[MetaLiteratureId, ...],
) -> dict[MetaLiteratureId, tuple[LiteratureId, ...]]:
    if not scope:
        return {}
    parameters = tuple(item.root for item in scope)
    rows = connection.execute(
        "SELECT meta_literature_id,literature_id FROM literatures "
        f"WHERE meta_literature_id IN ({_placeholders(cast(tuple[object, ...], parameters))}) "
        "ORDER BY meta_literature_id,literature_id",
        parameters,
    ).fetchall()
    values: dict[MetaLiteratureId, list[LiteratureId]] = {identity: [] for identity in scope}
    seen: set[LiteratureId] = set()
    for row in rows:
        meta_literature_id = MetaLiteratureId(_text(row[0]))
        literature_id = LiteratureId(_text(row[1]))
        if meta_literature_id not in values or literature_id in seen:
            raise EntryReaderError()
        values[meta_literature_id].append(literature_id)
        seen.add(literature_id)
    if any(not members for members in values.values()):
        raise EntryReaderError()
    return {identity: tuple(members) for identity, members in values.items()}


def _meta_snapshot(
    connection: sqlite3.Connection,
    verified_reader: VerifiedReader,
    scope: tuple[MetaLiteratureId, ...],
) -> MetaSelectorSnapshot:
    _unique(scope)
    if not scope:
        return MetaSelectorSnapshot(
            meta_literature_ids=(),
            meta_literatures=(),
            current_facts=(),
        )
    meta_by_id = _meta_rows(connection, scope)
    members_by_meta = _member_ids(connection, scope)
    ordered_member_ids = tuple(
        literature_id
        for meta_literature_id in scope
        for literature_id in members_by_meta[meta_literature_id]
    )
    facts_by_id = _exact_facts_by_id(
        connection,
        verified_reader,
        ordered_member_ids,
    )

    for meta_literature_id in scope:
        meta_literature = meta_by_id[meta_literature_id]
        members = members_by_meta[meta_literature_id]
        if meta_literature.representative_literature_id not in members:
            raise EntryReaderError()
        if any(
            facts_by_id[member_id].current.literature.meta_literature_id != meta_literature_id
            for member_id in members
        ):
            raise EntryReaderError()
    return MetaSelectorSnapshot(
        meta_literature_ids=scope,
        meta_literatures=tuple(meta_by_id[identity] for identity in scope),
        current_facts=tuple(facts_by_id[identity] for identity in ordered_member_ids),
    )


def _literature_snapshot(
    connection: sqlite3.Connection,
    verified_reader: VerifiedReader,
    selector: LiteratureSelector,
) -> LiteratureSelectorSnapshot:
    identities = selector.literature_ids
    facts_by_id = _exact_facts_by_id(connection, verified_reader, identities)
    return LiteratureSelectorSnapshot(
        literature_ids=identities,
        current_facts=tuple(facts_by_id[identity] for identity in identities),
    )


def _metadata_observation_closures(
    connection: sqlite3.Connection,
    literature_ids: tuple[LiteratureId, ...],
) -> dict[LiteratureId, tuple[MetadataObservation, ...]]:
    """Rebuild complete ordered closures or reject broken ownership."""

    _unique(literature_ids)
    if not literature_ids:
        return {}
    parameters = tuple(item.root for item in literature_ids)
    placeholders = _placeholders(cast(tuple[object, ...], parameters))
    seed_rows = connection.execute(
        f"SELECT literature_id FROM literatures WHERE literature_id IN ({placeholders})",
        parameters,
    ).fetchall()
    stored_ids = _unique(tuple(LiteratureId(_text(row[0])) for row in seed_rows))
    if set(stored_ids) != set(literature_ids):
        raise EntryReaderNotFoundError()

    # Every durable MetadataObservation has exactly one concrete Literature
    # owner.  Checking the global invariant is the only way a read can detect
    # an ownership row that disappeared entirely rather than silently treating
    # the surviving subset as a complete closure.
    broken_ownership = connection.execute(
        "SELECT observation.observation_id "
        "FROM metadata_observations AS observation "
        "LEFT JOIN literature_metadata_observations AS ownership "
        "ON ownership.observation_id=observation.observation_id "
        "GROUP BY observation.observation_id "
        "HAVING count(ownership.literature_id)<>1 LIMIT 1"
    ).fetchone()
    if broken_ownership is not None:
        raise EntryReaderError()

    ownership_rows = connection.execute(
        "SELECT ownership.literature_id,ownership.observation_id,observation.observation_id "
        "FROM literature_metadata_observations AS ownership "
        "LEFT JOIN metadata_observations AS observation "
        "ON observation.observation_id=ownership.observation_id "
        f"WHERE ownership.literature_id IN ({placeholders}) "
        "ORDER BY ownership.literature_id,ownership.observation_id",
        parameters,
    ).fetchall()
    observations_by_seed: dict[LiteratureId, list[MetadataObservation]] = {
        literature_id: [] for literature_id in literature_ids
    }
    observation_owners: dict[ObservationId, LiteratureId] = {}
    for row in ownership_rows:
        literature_id = LiteratureId(_text(row[0]))
        association_id = ObservationId(_text(row[1]))
        stored_observation_id = ObservationId(_text(row[2]))
        if (
            literature_id not in observations_by_seed
            or association_id != stored_observation_id
            or association_id in observation_owners
        ):
            raise EntryReaderError()
        observation = _metadata_observation(connection, association_id.root)
        if observation is None or observation.observation_id != association_id:
            raise EntryReaderError()
        observations_by_seed[literature_id].append(observation)
        observation_owners[association_id] = literature_id

    if any(not observations_by_seed[literature_id] for literature_id in literature_ids):
        raise EntryReaderError()
    return {
        literature_id: tuple(observations_by_seed[literature_id])
        for literature_id in literature_ids
    }


def _provider_relation_seed_facts(
    connection: sqlite3.Connection,
    literature_ids: tuple[LiteratureId, ...],
) -> tuple[ProviderRelationSeedFacts, ...]:
    """Rebuild every observation currently owned by the requested seeds."""

    observations_by_seed = _metadata_observation_closures(connection, literature_ids)
    return tuple(
        ProviderRelationSeedFacts(
            literature_id=literature_id,
            metadata_observations=observations_by_seed[literature_id],
        )
        for literature_id in literature_ids
    )


def _candidate_seed_ids(
    endpoint: ProviderLiteratureKey,
    seed_facts: tuple[ProviderRelationSeedFacts, ...],
    provider_name: str,
) -> tuple[LiteratureId, ...]:
    """Return raw exact-equality candidates without deciding Literature identity."""

    endpoint_identifiers = {
        (identifier.namespace, identifier.value) for identifier in endpoint.identifiers
    }
    matches: list[LiteratureId] = []
    for seed in seed_facts:
        matched = False
        for observation in seed.metadata_observations:
            provenance = observation.provenance
            provider_record_match = (
                endpoint.record_id is not None
                and provenance.source_kind is SourceKind.METADATA_PROVIDER
                and provenance.source_name == provider_name
                and provenance.source_record_id == endpoint.record_id
            )
            observation_identifiers = {
                (identifier.namespace, identifier.value)
                for identifier in observation.metadata.identifiers
            }
            if provider_record_match or endpoint_identifiers.intersection(observation_identifiers):
                matched = True
                break
        if matched:
            matches.append(seed.literature_id)
    return tuple(matches)


def _provider_relation_ids(
    connection: sqlite3.Connection,
    request: ProviderRelationCandidateReadRequest,
) -> tuple[tuple[ObservationId, ...], bool]:
    """Select at most one logical page plus a one-row continuation lookahead."""

    row_limit = request.limit + 1
    if request.after_observation_id is None:
        rows = connection.execute(
            "SELECT relation.observation_id "
            "FROM provider_relation_observations AS relation "
            "LEFT JOIN provenances AS provenance "
            "ON provenance.provenance_id=relation.provenance_id "
            "WHERE provenance.source_name=? OR provenance.provenance_id IS NULL "
            "OR provenance.source_name IS NULL "
            "ORDER BY relation.observation_id LIMIT ?",
            (request.provider_name, row_limit),
        ).fetchall()
    else:
        rows = connection.execute(
            "SELECT relation.observation_id "
            "FROM provider_relation_observations AS relation "
            "LEFT JOIN provenances AS provenance "
            "ON provenance.provenance_id=relation.provenance_id "
            "WHERE relation.observation_id>? AND (provenance.source_name=? "
            "OR provenance.provenance_id IS NULL OR provenance.source_name IS NULL) "
            "ORDER BY relation.observation_id LIMIT ?",
            (
                request.after_observation_id.root,
                request.provider_name,
                row_limit,
            ),
        ).fetchall()
    observation_ids = _unique(tuple(ObservationId(_text(row[0])) for row in rows))
    return observation_ids[: request.limit], len(observation_ids) > request.limit


class SqliteEntryReader:
    """Implement Entry's selector, current-facts, and relation-candidate Ports."""

    __slots__ = ("_engine", "_verified_reader")

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
        except EntryReaderError:
            raise
        except (LiteraturePreconditionReadError, LiteratureReaderError):
            raise EntryReaderError() from None
        except Exception:
            raise EntryReaderError() from None

    def read_selector(self, selector: BatchSelector) -> SelectorSnapshot:
        """Expand one typed selector and rebuild all facts in one snapshot."""

        if not isinstance(selector, _SELECTOR_TYPES):
            raise TypeError("selector must be a supported BatchSelector")
        return self._read(lambda connection: self._read_selector(connection, selector))

    def _read_selector(
        self,
        connection: sqlite3.Connection,
        selector: BatchSelector,
    ) -> SelectorSnapshot:
        if isinstance(selector, LiteratureSelector):
            return _literature_snapshot(connection, self._verified_reader, selector)
        if isinstance(selector, AllPendingSelector):
            scope = _all_meta_scope(connection)
        elif isinstance(selector, DiscoveryRunSelector):
            scope = _discovery_scope(connection, selector)
        elif isinstance(selector, (ImportReportSelector, MetaLiteratureSelector)):
            scope = selector.meta_literature_ids
        elif isinstance(selector, QuerySelector):
            scope = _query_scope(connection, selector)
        else:  # pragma: no cover - the public type check closes this branch.
            raise TypeError("selector must be a supported BatchSelector")
        return _meta_snapshot(connection, self._verified_reader, scope)

    def read_current(self, literature_id: LiteratureId) -> CurrentFactsSnapshot:
        """Read zero or one exact current-facts hit for a concrete Literature."""

        if not isinstance(literature_id, LiteratureId):
            raise TypeError("literature_id must be a LiteratureId")
        return self._read(lambda connection: self._read_current(connection, literature_id))

    def _read_current(
        self,
        connection: sqlite3.Connection,
        literature_id: LiteratureId,
    ) -> CurrentFactsSnapshot:
        current = _facts(
            connection,
            self._verified_reader,
            literature_id.root,
        )
        if current is None:
            return CurrentFactsSnapshot(
                literature_id=literature_id,
                current_facts=(),
            )
        return CurrentFactsSnapshot(
            literature_id=literature_id,
            current_facts=(_execution_facts(connection, current),),
        )

    def read_provider_relation_candidates(
        self,
        request: ProviderRelationCandidateReadRequest,
    ) -> ProviderRelationCandidatePage:
        """Read one provider-scoped relation page from one Catalog snapshot."""

        if not isinstance(request, ProviderRelationCandidateReadRequest):
            raise TypeError("request must be a ProviderRelationCandidateReadRequest")
        return self._read(
            lambda connection: self._read_provider_relation_candidates(connection, request)
        )

    def _read_provider_relation_candidates(
        self,
        connection: sqlite3.Connection,
        request: ProviderRelationCandidateReadRequest,
    ) -> ProviderRelationCandidatePage:
        seed_facts = _provider_relation_seed_facts(
            connection,
            request.seed_literature_ids,
        )
        observation_ids, has_more = _provider_relation_ids(connection, request)
        candidates: list[ProviderRelationCandidateRef] = []
        for observation_id in observation_ids:
            relation = _provider_relation(connection, observation_id.root)
            if (
                relation is None
                or relation.observation_id != observation_id
                or relation.provenance.source_name != request.provider_name
            ):
                raise EntryReaderError()
            endpoint_values: tuple[tuple[Literal["citing", "cited"], ProviderLiteratureKey], ...]
            if request.direction == "references":
                endpoint_values = (("citing", relation.citing),)
            elif request.direction == "cited-by":
                endpoint_values = (("cited", relation.cited),)
            else:
                endpoint_values = (
                    ("citing", relation.citing),
                    ("cited", relation.cited),
                )
            for endpoint_name, endpoint in endpoint_values:
                candidate_seed_ids = _candidate_seed_ids(
                    endpoint,
                    seed_facts,
                    request.provider_name,
                )
                if candidate_seed_ids:
                    candidates.append(
                        ProviderRelationCandidateRef(
                            observation_id=observation_id,
                            seed_endpoint=endpoint_name,
                            candidate_seed_literature_ids=candidate_seed_ids,
                        )
                    )
        return ProviderRelationCandidatePage(
            seed_facts=seed_facts,
            candidates=tuple(candidates),
            next_after_observation_id=(
                observation_ids[-1] if has_more and observation_ids else None
            ),
        )


__all__ = (
    "EntryReaderError",
    "EntryReaderNotFoundError",
    "SqliteEntryReader",
)
