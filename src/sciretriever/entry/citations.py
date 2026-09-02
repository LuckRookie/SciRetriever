"""Bounded citation discovery over persisted neutral source facts.

The operation deliberately separates three stages: Metadata publishes every
provider relation as an immutable source fact, Entry selects persisted
relations through its E3 reader, and Literature alone accepts endpoints and
publishes authoritative References.  A DiscoveryResult/cause is appended only
after Literature confirms that the directed Reference has support.
"""

from __future__ import annotations

import time
import unicodedata
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Literal, TypeAlias
from uuid import uuid4

from sciretriever.analysis.api import AnalysisApi, ReferenceLookupFailure
from sciretriever.entry.ports import (
    ClockPort,
    DiscoveryPublicationPort,
    DiscoveryRunRecoveryPort,
    DiscoveryRunRepositoryPort,
    ProviderRelationCandidatePage,
    ProviderRelationCandidateReadPort,
    ProviderRelationCandidateReadRequest,
    WriteAdmissionFailure,
    WriteAdmissionPort,
)
from sciretriever.literature.api import (
    ContentReferenceEvidence,
    LiteratureApi,
    MetadataReferenceEvidence,
    ObservationAcceptanceResult,
    ProviderRelationEvidence,
    ProviderRelationObservationReadRequest,
    provider_key_matches_seed,
)
from sciretriever.logging.api import get_logger
from sciretriever.metadata.api import (
    MAX_PROVIDER_RELATION_PUBLICATION_BATCH,
    CancellationEvent,
    MetadataApi,
    MetadataLookupRequest,
    MetadataProviderInvocation,
    MetadataPublication,
    MetadataReferenceQueryRequest,
    ProviderReferenceQuery,
)
from sciretriever.model.analysis import LiteratureContent, ReferenceLookup
from sciretriever.model.discovery import (
    CitationDiscoveryCause,
    CitationDiscoveryInput,
    DiscoveryResult,
    DiscoveryRun,
    DiscoverySourceResult,
    ProviderDiscoveryLimit,
    TopicDiscoveryInput,
)
from sciretriever.model.library import (
    LibraryQuery,
    LibrarySearchPage,
    LibrarySearchRequest,
    LiteratureDetail,
)
from sciretriever.model.literature import Literature, Reference, ReferenceSupport
from sciretriever.model.metadata import (
    MetadataObservation,
    ProviderLiteratureKey,
    ProviderRelationObservation,
)
from sciretriever.model.primitives import DiscoveryRunId, LiteratureId, MetaLiteratureId
from sciretriever.model.report import (
    DiscoveryProviderReport,
    DiscoveryReport,
    FailedReportEnd,
    FinishedReportEnd,
    InterruptedReportEnd,
    StableFailure,
)

DiscoveryRunIdFactory: TypeAlias = Callable[[], DiscoveryRunId]

_LOCAL_PAGE_SIZE = 200
_RELATION_PAGE_SIZE = 200
_LOGGER = get_logger(__name__)


class _ControlledInterruption(BaseException):
    pass


class _CitationContractError(RuntimeError):
    pass


@dataclass(slots=True)
class _ProviderState:
    limit: ProviderDiscoveryLimit
    raw_item_count: int = 0
    accepted_observation_count: int = 0
    terminal_outcome: Literal["SCAN_LIMIT_REACHED", "FAILED"] | None = None
    failure: StableFailure | None = None
    started: bool = False
    interrupted: bool = False
    source_published: bool = False

    @property
    def remaining(self) -> int:
        return max(0, self.limit.scan_limit - self.raw_item_count)

    @property
    def available(self) -> bool:
        return not self.interrupted and self.terminal_outcome is None and self.remaining > 0

    @property
    def source_outcome(self) -> Literal["EXHAUSTED", "SCAN_LIMIT_REACHED", "FAILED"]:
        return "EXHAUSTED" if self.terminal_outcome is None else self.terminal_outcome


@dataclass(slots=True)
class _RunStats:
    result_meta_ids: set[MetaLiteratureId]
    new_meta_literature_count: int = 0
    new_literature_count: int = 0
    new_metadata_observation_count: int = 0


@dataclass(frozen=True, slots=True)
class _Resolution:
    outcome: Literal["hit", "miss", "ambiguous"]
    literature: Literature | None = None


@dataclass(frozen=True, slots=True)
class _TextEvidence:
    source: Literature
    observation: MetadataObservation | None = None
    content: LiteratureContent | None = None


class CitationDiscoveryOperation:
    """Run one breadth-first, bounded citation DiscoveryRun."""

    __slots__ = (
        "_metadata",
        "_relation_publication",
        "_literature",
        "_analysis",
        "_candidate_reader",
        "_run_repository",
        "_discovery_publication",
        "_write_admission",
        "_recovery",
        "_clock",
        "_run_id_factory",
        "_provider_precedence",
        "_cancel_event",
    )

    def __init__(  # noqa: C901
        self,
        *,
        metadata: MetadataApi,
        relation_publication: MetadataPublication,
        literature: LiteratureApi,
        analysis: AnalysisApi,
        candidate_reader: ProviderRelationCandidateReadPort,
        run_repository: DiscoveryRunRepositoryPort,
        discovery_publication: DiscoveryPublicationPort,
        write_admission: WriteAdmissionPort,
        recovery: DiscoveryRunRecoveryPort,
        clock: ClockPort,
        run_id_factory: DiscoveryRunIdFactory = lambda: DiscoveryRunId(str(uuid4())),
        provider_precedence: Iterable[str] = (),
        cancel_event: CancellationEvent | None = None,
    ) -> None:
        if not isinstance(metadata, MetadataApi):
            raise TypeError("metadata must be a MetadataApi")
        if not isinstance(relation_publication, MetadataPublication):
            raise TypeError("relation_publication must be a MetadataPublication")
        if not isinstance(literature, LiteratureApi):
            raise TypeError("literature must be a LiteratureApi")
        if not isinstance(analysis, AnalysisApi):
            raise TypeError("analysis must be an AnalysisApi")
        if not isinstance(candidate_reader, ProviderRelationCandidateReadPort):
            raise TypeError("candidate_reader must implement provider relation reads")
        if not isinstance(run_repository, DiscoveryRunRepositoryPort):
            raise TypeError("run_repository must implement DiscoveryRunRepositoryPort")
        if not isinstance(discovery_publication, DiscoveryPublicationPort):
            raise TypeError("discovery_publication must implement DiscoveryPublicationPort")
        if not isinstance(write_admission, WriteAdmissionPort):
            raise TypeError("write_admission must implement WriteAdmissionPort")
        if not isinstance(recovery, DiscoveryRunRecoveryPort):
            raise TypeError("recovery must implement DiscoveryRunRecoveryPort")
        if not isinstance(clock, ClockPort):
            raise TypeError("clock must implement ClockPort")
        if not callable(run_id_factory):
            raise TypeError("run_id_factory must be callable")
        precedence = tuple(provider_precedence)
        if any(not isinstance(value, str) or not value.strip() for value in precedence):
            raise ValueError("provider_precedence must contain nonblank provider names")
        if cancel_event is not None and not callable(getattr(cancel_event, "is_set", None)):
            raise TypeError("cancel_event must expose is_set")
        self._metadata = metadata
        self._relation_publication = relation_publication
        self._literature = literature
        self._analysis = analysis
        self._candidate_reader = candidate_reader
        self._run_repository = run_repository
        self._discovery_publication = discovery_publication
        self._write_admission = write_admission
        self._recovery = recovery
        self._clock = clock
        self._run_id_factory = run_id_factory
        self._provider_precedence = precedence
        self._cancel_event = cancel_event

    def __call__(self, request: CitationDiscoveryInput) -> DiscoveryReport:
        if not isinstance(request, CitationDiscoveryInput):
            raise TypeError("request must be a CitationDiscoveryInput")
        diagnostic_started_ns = time.monotonic_ns()
        run_id = self._run_id_factory()
        started_at = self._clock.now()
        if not isinstance(run_id, DiscoveryRunId):
            raise TypeError("run_id_factory must return DiscoveryRunId")
        run = DiscoveryRun(
            discovery_run_id=run_id,
            input=request,
            status="RUNNING",
            started_at=started_at,
        )
        states = {item.provider_name: _ProviderState(limit=item) for item in request.providers}
        stats = _RunStats(result_meta_ids=set())
        created = False
        try:
            with self._write_admission.acquire_nowait():
                interrupted = self._recovery.interrupt_visible_running()
                if not isinstance(interrupted, tuple) or any(
                    not isinstance(item, DiscoveryRunId) for item in interrupted
                ):
                    raise _CitationContractError()
                seed_details = self._seed_details(request.seed_literature_ids)
                self._run_repository.create(run)
                created = True
                _LOGGER.info(
                    "event=citation-discovery-started discovery_run_id=%s seed_count=%d "
                    "provider_count=%d max_depth=%d result_limit=%d",
                    run_id,
                    len(request.seed_literature_ids),
                    len(request.providers),
                    request.max_depth,
                    request.result_limit,
                )
                self._check_cancelled()
                seed_meta_ids = {
                    detail.literature.meta_literature_id for detail in seed_details.values()
                }
                self._execute(
                    request=request,
                    run_id=run_id,
                    seed_details=seed_details,
                    seed_meta_ids=seed_meta_ids,
                    states=states,
                    stats=stats,
                )
                self._check_cancelled()
                source_results = self._publish_source_results(run_id, states)
                status = _terminal_status(source_results)
                finalized = self._run_repository.finalize(run_id, status)
                _validate_finalized(finalized, run_id, status)
                return self._report(
                    run_id=run_id,
                    status=status,
                    states=states,
                    stats=stats,
                    end=FinishedReportEnd(kind="finished"),
                    started_ns=diagnostic_started_ns,
                )
        except (_ControlledInterruption, KeyboardInterrupt):
            if not created:
                raise
            finalized = self._run_repository.finalize(run_id, "INTERRUPTED")
            _validate_finalized(finalized, run_id, "INTERRUPTED")
            return self._report(
                run_id=run_id,
                status="INTERRUPTED",
                states=states,
                stats=stats,
                end=InterruptedReportEnd(kind="interrupted"),
                unfinished=True,
                started_ns=diagnostic_started_ns,
            )
        except WriteAdmissionFailure as error:
            if not created:
                return self._report(
                    run_id=run_id,
                    status="FAILED",
                    states=states,
                    stats=stats,
                    end=FailedReportEnd(kind="failed", failure=error.failure),
                    unfinished=True,
                    started_ns=diagnostic_started_ns,
                )
            return self._report(
                run_id=run_id,
                status=_terminal_report_status(states),
                states=states,
                stats=stats,
                end=FailedReportEnd(kind="failed", failure=error.failure),
                started_ns=diagnostic_started_ns,
            )
        except Exception:
            if not created:
                raise
            failure = _operation_failure()
            finalized = self._run_repository.finalize(run_id, "FAILED")
            _validate_finalized(finalized, run_id, "FAILED")
            return self._report(
                run_id=run_id,
                status="FAILED",
                states=states,
                stats=stats,
                end=FailedReportEnd(kind="failed", failure=failure),
                unfinished=True,
                started_ns=diagnostic_started_ns,
            )

    def _execute(  # noqa: C901
        self,
        *,
        request: CitationDiscoveryInput,
        run_id: DiscoveryRunId,
        seed_details: dict[LiteratureId, LiteratureDetail],
        seed_meta_ids: set[MetaLiteratureId],
        states: dict[str, _ProviderState],
        stats: _RunStats,
    ) -> None:
        known_details = dict(seed_details)
        visited = set(request.seed_literature_ids)
        frontier = request.seed_literature_ids
        processed: set[tuple[object, str, LiteratureId]] = set()
        ignored_relation_ids: set[object] = set()
        for depth in range(1, request.max_depth + 1):
            if not frontier or len(stats.result_meta_ids) >= request.result_limit:
                break
            self._check_cancelled()
            _LOGGER.debug(
                "event=citation-depth-started discovery_run_id=%s depth=%d "
                "frontier_count=%d result_count=%d",
                run_id,
                depth,
                len(frontier),
                len(stats.result_meta_ids),
            )
            next_frontier: list[LiteratureId] = []
            for provider_limit in request.providers:
                provider_name = provider_limit.provider_name
                state = states[provider_name]
                inline: tuple[MetadataObservation, ...] = ()
                self._scan_persisted_relations(
                    request=request,
                    run_id=run_id,
                    provider_name=provider_name,
                    frontier=frontier,
                    depth=depth,
                    inline_observations=inline,
                    seed_meta_ids=seed_meta_ids,
                    known_details=known_details,
                    visited=visited,
                    next_frontier=next_frontier,
                    processed=processed,
                    ignored_relation_ids=ignored_relation_ids,
                    states=states,
                    stats=stats,
                )
                if state.available and len(stats.result_meta_ids) < request.result_limit:
                    invocation = self._query_provider_relations(
                        provider_name=provider_name,
                        direction=request.direction,
                        frontier=frontier,
                        known_details=known_details,
                        state=state,
                    )
                    if invocation is not None:
                        inline = invocation.observations
                        self._publish_returned_relations(invocation.relations)
                        if invocation.outcome == "INTERRUPTED":
                            raise _ControlledInterruption()
                self._scan_persisted_relations(
                    request=request,
                    run_id=run_id,
                    provider_name=provider_name,
                    frontier=frontier,
                    depth=depth,
                    inline_observations=inline,
                    seed_meta_ids=seed_meta_ids,
                    known_details=known_details,
                    visited=visited,
                    next_frontier=next_frontier,
                    processed=processed,
                    ignored_relation_ids=ignored_relation_ids,
                    states=states,
                    stats=stats,
                )
            if request.direction in ("references", "both"):
                for literature_id in frontier:
                    self._process_text_sources(
                        request=request,
                        run_id=run_id,
                        depth=depth,
                        detail=known_details[literature_id],
                        seed_meta_ids=seed_meta_ids,
                        known_details=known_details,
                        visited=visited,
                        next_frontier=next_frontier,
                        states=states,
                        stats=stats,
                        ignored_relation_ids=ignored_relation_ids,
                    )
            frontier = tuple(dict.fromkeys(next_frontier))

    def _query_provider_relations(
        self,
        *,
        provider_name: str,
        direction: Literal["references", "cited-by", "both"],
        frontier: tuple[LiteratureId, ...],
        known_details: dict[LiteratureId, LiteratureDetail],
        state: _ProviderState,
    ) -> MetadataProviderInvocation | None:
        keys = _provider_query_keys(
            provider_name,
            tuple(known_details[item] for item in frontier),
        )
        if not keys:
            return None
        state.started = True
        try:
            invocation = self._metadata.query_references_provider(
                MetadataReferenceQueryRequest(
                    direction=direction,
                    providers=(
                        ProviderReferenceQuery(
                            provider_name=provider_name,
                            keys=keys,
                            scan_limit=state.remaining,
                        ),
                    ),
                ),
                cancel_event=self._cancel_event,
            )
        except Exception:
            state.terminal_outcome = "FAILED"
            failure = _provider_failure()
            state.failure = failure
            _log_citation_provider_failure(provider_name, failure)
            return None
        self._consume_provider_invocation(state, invocation)
        return invocation

    def _scan_persisted_relations(  # noqa: C901
        self,
        *,
        request: CitationDiscoveryInput,
        run_id: DiscoveryRunId,
        provider_name: str,
        frontier: tuple[LiteratureId, ...],
        depth: int,
        inline_observations: tuple[MetadataObservation, ...],
        seed_meta_ids: set[MetaLiteratureId],
        known_details: dict[LiteratureId, LiteratureDetail],
        visited: set[LiteratureId],
        next_frontier: list[LiteratureId],
        processed: set[tuple[object, str, LiteratureId]],
        ignored_relation_ids: set[object],
        states: dict[str, _ProviderState],
        stats: _RunStats,
    ) -> None:
        cursor = None
        while True:
            self._check_cancelled()
            page = self._candidate_reader.read_provider_relation_candidates(
                ProviderRelationCandidateReadRequest(
                    seed_literature_ids=frontier,
                    direction=request.direction,
                    provider_name=provider_name,
                    limit=_RELATION_PAGE_SIZE,
                    after_observation_id=cursor,
                )
            )
            _validate_candidate_page(page, frontier)
            relation_by_id = self._exact_relations(page)
            seed_facts = {item.literature_id: item for item in page.seed_facts}
            for candidate in page.candidates:
                if candidate.observation_id in ignored_relation_ids:
                    continue
                relation = relation_by_id[candidate.observation_id]
                endpoint = (
                    relation.citing if candidate.seed_endpoint == "citing" else relation.cited
                )
                matches = tuple(
                    literature_id
                    for literature_id in candidate.candidate_seed_literature_ids
                    if provider_key_matches_seed(
                        provider_name=provider_name,
                        key=endpoint,
                        seed_observations=seed_facts[literature_id].metadata_observations,
                    )
                )
                if len(matches) != 1:
                    continue
                seed_id = matches[0]
                identity = (candidate.observation_id, candidate.seed_endpoint, seed_id)
                if identity in processed:
                    continue
                seed = known_details[seed_id].literature
                opposite = (
                    relation.cited if candidate.seed_endpoint == "citing" else relation.citing
                )
                resolved = self._resolve_relation_target(
                    provider_name=provider_name,
                    key=opposite,
                    inline_observations=inline_observations,
                    state=states[provider_name],
                    stats=stats,
                    allow_external=len(stats.result_meta_ids) < request.result_limit,
                    ignored_relation_ids=ignored_relation_ids,
                )
                if resolved.outcome != "hit" or resolved.literature is None:
                    continue
                discovered = resolved.literature
                if not _inside_result_boundary(
                    discovered,
                    seed_meta_ids=seed_meta_ids,
                    stats=stats,
                    result_limit=request.result_limit,
                ):
                    continue
                known_details.setdefault(discovered.literature_id, self._detail(discovered))
                if candidate.seed_endpoint == "citing":
                    source, target = seed, discovered
                else:
                    source, target = discovered, seed
                decision = self._literature.publish_reference(
                    source=source,
                    target=target,
                    provider_relations=(
                        ProviderRelationEvidence(
                            observation=relation,
                            source=source,
                            target=target,
                        ),
                    ),
                )
                if not _reference_published(decision):
                    continue
                processed.add(identity)
                self._publish_discovery(
                    run_id=run_id,
                    discovered=discovered,
                    source=source,
                    target=target,
                    depth=depth,
                    seed_meta_ids=seed_meta_ids,
                    stats=stats,
                )
                _queue_discovered(
                    discovered,
                    seed_meta_ids=seed_meta_ids,
                    visited=visited,
                    next_frontier=next_frontier,
                )
            next_cursor = page.next_after_observation_id
            if next_cursor is None:
                return
            if next_cursor == cursor:
                raise _CitationContractError()
            cursor = next_cursor

    def _exact_relations(
        self,
        page: ProviderRelationCandidatePage,
    ) -> dict[object, ProviderRelationObservation]:
        observation_ids = tuple(dict.fromkeys(item.observation_id for item in page.candidates))
        if not observation_ids:
            return {}
        context = self._literature.read_provider_relation_observations(
            ProviderRelationObservationReadRequest(observation_ids=observation_ids)
        )
        observations = context.observations
        if len(observations) != len(observation_ids) or {
            item.observation_id for item in observations
        } != set(observation_ids):
            raise _CitationContractError()
        return {item.observation_id: item for item in observations}

    def _resolve_relation_target(
        self,
        *,
        provider_name: str,
        key: ProviderLiteratureKey,
        inline_observations: tuple[MetadataObservation, ...],
        state: _ProviderState,
        stats: _RunStats,
        allow_external: bool,
        ignored_relation_ids: set[object],
    ) -> _Resolution:
        local = self._local_relation_target(provider_name, key)
        if local.outcome != "miss":
            return local
        inline = tuple(
            item
            for item in inline_observations
            if provider_key_matches_seed(
                provider_name=provider_name,
                key=key,
                seed_observations=(item,),
            )
        )
        if len(inline) > 1:
            return _Resolution("ambiguous")
        if len(inline) == 1:
            if not allow_external:
                return _Resolution("miss")
            return self._accept_target(inline[0], state, stats)
        if not allow_external or not state.available:
            return _Resolution("miss")
        state.started = True
        try:
            invocation = self._metadata.lookup_provider(
                MetadataLookupRequest(
                    provider_name=provider_name,
                    key=key,
                    scan_limit=state.remaining,
                ),
                cancel_event=self._cancel_event,
            )
        except Exception:
            state.terminal_outcome = "FAILED"
            failure = _provider_failure()
            state.failure = failure
            _log_citation_provider_failure(provider_name, failure)
            return _Resolution("miss")
        self._consume_provider_invocation(state, invocation)
        self._publish_returned_relations(invocation.relations)
        ignored_relation_ids.update(item.observation_id for item in invocation.relations)
        matches = tuple(
            item
            for item in invocation.observations
            if provider_key_matches_seed(
                provider_name=provider_name,
                key=key,
                seed_observations=(item,),
            )
        )
        if invocation.outcome == "INTERRUPTED":
            if len(matches) == 1:
                self._accept_target(matches[0], state, stats)
            raise _ControlledInterruption()
        if len(matches) != 1:
            return _Resolution("ambiguous" if len(matches) > 1 else "miss")
        return self._accept_target(matches[0], state, stats)

    def _local_relation_target(
        self,
        provider_name: str,
        key: ProviderLiteratureKey,
    ) -> _Resolution:
        query = LibraryQuery(identifiers=key.identifiers) if key.identifiers else LibraryQuery()
        matches: dict[LiteratureId, Literature] = {}
        for candidate in self._search_all(query):
            detail = self._detail(candidate)
            if provider_key_matches_seed(
                provider_name=provider_name,
                key=key,
                seed_observations=detail.metadata_observations,
            ):
                matches[candidate.literature_id] = candidate
        if len(matches) == 1:
            return _Resolution("hit", next(iter(matches.values())))
        return _Resolution("ambiguous" if matches else "miss")

    def _process_text_sources(  # noqa: C901
        self,
        *,
        request: CitationDiscoveryInput,
        run_id: DiscoveryRunId,
        depth: int,
        detail: LiteratureDetail,
        seed_meta_ids: set[MetaLiteratureId],
        known_details: dict[LiteratureId, LiteratureDetail],
        visited: set[LiteratureId],
        next_frontier: list[LiteratureId],
        states: dict[str, _ProviderState],
        stats: _RunStats,
        ignored_relation_ids: set[object],
    ) -> None:
        sources: list[tuple[tuple[str, ...], _TextEvidence]] = []
        for observation in detail.metadata_observations:
            if observation.reference_texts:
                sources.append(
                    (
                        observation.reference_texts,
                        _TextEvidence(source=detail.literature, observation=observation),
                    )
                )
        if detail.content is not None and detail.content.references:
            sources.append(
                (
                    detail.content.references,
                    _TextEvidence(source=detail.literature, content=detail.content),
                )
            )
        for texts, evidence in sources:
            self._check_cancelled()
            try:
                lookups = self._analysis.extract_reference_lookups(
                    texts,
                    cancel_event=self._cancel_event,  # type: ignore[arg-type]
                )
            except ReferenceLookupFailure:
                continue
            for lookup in lookups:
                resolved = self._resolve_lookup_target(
                    lookup,
                    states,
                    stats,
                    allow_external=len(stats.result_meta_ids) < request.result_limit,
                    ignored_relation_ids=ignored_relation_ids,
                )
                if resolved.outcome != "hit" or resolved.literature is None:
                    continue
                target = resolved.literature
                if not _inside_result_boundary(
                    target,
                    seed_meta_ids=seed_meta_ids,
                    stats=stats,
                    result_limit=request.result_limit,
                ):
                    continue
                known_details.setdefault(target.literature_id, self._detail(target))
                kwargs: dict[str, object]
                if evidence.observation is not None:
                    kwargs = {
                        "metadata_references": (
                            MetadataReferenceEvidence(
                                literature=evidence.source,
                                observation=evidence.observation,
                                reference_index=lookup.reference_index,
                            ),
                        )
                    }
                else:
                    assert evidence.content is not None
                    kwargs = {
                        "content_references": (
                            ContentReferenceEvidence(
                                literature=evidence.source,
                                content=evidence.content,
                                reference_index=lookup.reference_index,
                            ),
                        )
                    }
                decision = self._literature.publish_reference(
                    source=evidence.source,
                    target=target,
                    **kwargs,  # type: ignore[arg-type]
                )
                if not _reference_published(decision):
                    continue
                self._publish_discovery(
                    run_id=run_id,
                    discovered=target,
                    source=evidence.source,
                    target=target,
                    depth=depth,
                    seed_meta_ids=seed_meta_ids,
                    stats=stats,
                )
                _queue_discovered(
                    target,
                    seed_meta_ids=seed_meta_ids,
                    visited=visited,
                    next_frontier=next_frontier,
                )

    def _resolve_lookup_target(
        self,
        lookup: ReferenceLookup,
        states: dict[str, _ProviderState],
        stats: _RunStats,
        *,
        allow_external: bool,
        ignored_relation_ids: set[object],
    ) -> _Resolution:
        local = self._local_lookup_target(lookup)
        if local.outcome != "miss":
            return local
        if not allow_external:
            return _Resolution("miss")
        for provider_name, state in states.items():
            if not state.available:
                continue
            invocation = self._lookup_reference(
                provider_name,
                lookup,
                state,
                ignored_relation_ids,
            )
            if invocation is None:
                continue
            if invocation.outcome == "INTERRUPTED":
                self._accept_matching_lookup_observations(
                    lookup,
                    invocation.observations,
                    state,
                    stats,
                )
                raise _ControlledInterruption()
            matches = tuple(
                item for item in invocation.observations if _lookup_matches_metadata(lookup, item)
            )
            if len(matches) > 1:
                return _Resolution("ambiguous")
            if len(matches) == 1:
                return self._accept_target(matches[0], state, stats)
        return _Resolution("miss")

    def _lookup_reference(
        self,
        provider_name: str,
        lookup: ReferenceLookup,
        state: _ProviderState,
        ignored_relation_ids: set[object],
    ) -> MetadataProviderInvocation | None:
        state.started = True
        try:
            if lookup.identifiers:
                invocation = self._metadata.lookup_provider(
                    MetadataLookupRequest(
                        provider_name=provider_name,
                        key=ProviderLiteratureKey(identifiers=lookup.identifiers),
                        scan_limit=state.remaining,
                    ),
                    cancel_event=self._cancel_event,
                )
            else:
                assert lookup.title is not None
                invocation = self._metadata.search_topic_provider(
                    TopicDiscoveryInput(
                        kind="topic",
                        query=lookup.title,
                        year_from=lookup.publication_year,
                        year_to=lookup.publication_year,
                        providers=(
                            ProviderDiscoveryLimit(
                                provider_name=provider_name,
                                scan_limit=state.remaining,
                            ),
                        ),
                    ),
                    cancel_event=self._cancel_event,
                )
        except Exception:
            state.terminal_outcome = "FAILED"
            failure = _provider_failure()
            state.failure = failure
            _log_citation_provider_failure(provider_name, failure)
            return None
        self._consume_provider_invocation(state, invocation)
        self._publish_returned_relations(invocation.relations)
        ignored_relation_ids.update(item.observation_id for item in invocation.relations)
        return invocation

    def _local_lookup_target(self, lookup: ReferenceLookup) -> _Resolution:
        if lookup.identifiers:
            query = LibraryQuery(identifiers=lookup.identifiers)
        else:
            query = LibraryQuery(
                title=lookup.title,
                publication_year_from=lookup.publication_year,
                publication_year_to=lookup.publication_year,
            )
        matches = {
            item.literature_id: item
            for item in self._search_all(query)
            if _lookup_matches_literature(lookup, item)
        }
        if len(matches) == 1:
            return _Resolution("hit", next(iter(matches.values())))
        return _Resolution("ambiguous" if matches else "miss")

    def _accept_target(
        self,
        observation: MetadataObservation,
        state: _ProviderState,
        stats: _RunStats,
    ) -> _Resolution:
        accepted = self._literature.accept_observation(
            observation,
            provider_precedence=self._provider_precedence,
        )
        if not isinstance(accepted, ObservationAcceptanceResult):
            raise _CitationContractError()
        if accepted.decision == "rejected":
            _LOGGER.debug(
                "event=citation-observation-rejected observation_id=%s",
                observation.observation_id,
            )
            return _Resolution("miss")
        if accepted.literature is None or accepted.meta_literature is None:
            raise _CitationContractError()
        state.accepted_observation_count += 1
        if not accepted.deduplicated:
            stats.new_metadata_observation_count += 1
        if accepted.decision == "created":
            stats.new_literature_count += 1
        if _accepted_meta_was_created(accepted):
            stats.new_meta_literature_count += 1
        _LOGGER.debug(
            "event=citation-observation-accepted observation_id=%s literature_id=%s "
            "meta_literature_id=%s decision=%s deduplicated=%s",
            observation.observation_id,
            accepted.literature.literature_id,
            accepted.meta_literature.meta_literature_id,
            accepted.decision,
            str(accepted.deduplicated).lower(),
        )
        return _Resolution("hit", accepted.literature)

    def _consume_provider_invocation(
        self,
        state: _ProviderState,
        result: MetadataProviderInvocation,
    ) -> None:
        if result.raw_item_count > state.remaining:
            raise _CitationContractError()
        state.raw_item_count += result.raw_item_count
        if result.outcome == "INTERRUPTED":
            state.interrupted = True
        elif result.outcome == "FAILED":
            state.terminal_outcome = "FAILED"
            state.failure = result.failure
        elif result.outcome == "SCAN_LIMIT_REACHED" or state.remaining == 0:
            state.terminal_outcome = "SCAN_LIMIT_REACHED"

    def _publish_returned_relations(
        self,
        relations: tuple[ProviderRelationObservation, ...],
    ) -> None:
        for offset in range(0, len(relations), MAX_PROVIDER_RELATION_PUBLICATION_BATCH):
            self._relation_publication.publish_relation_observations(
                relations[offset : offset + MAX_PROVIDER_RELATION_PUBLICATION_BATCH]
            )

    def _accept_matching_lookup_observations(
        self,
        lookup: ReferenceLookup,
        observations: tuple[MetadataObservation, ...],
        state: _ProviderState,
        stats: _RunStats,
    ) -> None:
        matches = tuple(item for item in observations if _lookup_matches_metadata(lookup, item))
        if len(matches) == 1:
            self._accept_target(matches[0], state, stats)

    def _publish_discovery(
        self,
        *,
        run_id: DiscoveryRunId,
        discovered: Literature,
        source: Literature,
        target: Literature,
        depth: int,
        seed_meta_ids: set[MetaLiteratureId],
        stats: _RunStats,
    ) -> None:
        meta_id = discovered.meta_literature_id
        if meta_id in seed_meta_ids:
            return
        self._discovery_publication.publish_result_and_cause(
            DiscoveryResult(discovery_run_id=run_id, meta_literature_id=meta_id),
            CitationDiscoveryCause(
                kind="citation",
                discovery_run_id=run_id,
                meta_literature_id=meta_id,
                source_literature_id=source.literature_id,
                target_literature_id=target.literature_id,
                depth=depth,
            ),
        )
        stats.result_meta_ids.add(meta_id)
        _LOGGER.debug(
            "event=citation-result-published discovery_run_id=%s meta_literature_id=%s "
            "depth=%d source_literature_id=%s target_literature_id=%s",
            run_id,
            meta_id,
            depth,
            source.literature_id,
            target.literature_id,
        )

    def _seed_details(
        self,
        literature_ids: tuple[LiteratureId, ...],
    ) -> dict[LiteratureId, LiteratureDetail]:
        values: dict[LiteratureId, LiteratureDetail] = {}
        for literature_id in literature_ids:
            detail = self._literature.read_detail(literature_id)
            if detail.literature.literature_id != literature_id:
                raise _CitationContractError()
            values[literature_id] = detail
        return values

    def _detail(self, literature: Literature) -> LiteratureDetail:
        detail = self._literature.read_detail(literature.literature_id)
        if detail.literature != literature:
            raise _CitationContractError()
        return detail

    def _search_all(self, query: LibraryQuery) -> tuple[Literature, ...]:
        cursor = None
        values: dict[LiteratureId, Literature] = {}
        seen_cursors: set[str] = set()
        while True:
            page = self._literature.search(
                LibrarySearchRequest(
                    query=query,
                    sort="publication-year-desc",
                    limit=_LOCAL_PAGE_SIZE,
                    cursor=cursor,
                )
            )
            if not isinstance(page, LibrarySearchPage):
                raise _CitationContractError()
            for item in page.items:
                values[item.literature.literature_id] = item.literature
            if page.next_cursor is None:
                return tuple(values.values())
            if page.next_cursor in seen_cursors:
                raise _CitationContractError()
            seen_cursors.add(page.next_cursor)
            cursor = page.next_cursor

    def _publish_source_results(
        self,
        run_id: DiscoveryRunId,
        states: dict[str, _ProviderState],
    ) -> tuple[DiscoverySourceResult, ...]:
        values: list[DiscoverySourceResult] = []
        for provider_name, state in states.items():
            self._check_cancelled()
            result = DiscoverySourceResult(
                discovery_run_id=run_id,
                provider_name=provider_name,
                outcome=state.source_outcome,
                failure=state.failure,
            )
            self._discovery_publication.publish_source_result(result)
            state.source_published = True
            values.append(result)
        return tuple(values)

    def _report(
        self,
        *,
        run_id: DiscoveryRunId,
        status: Literal["RUNNING", "COMPLETED", "PARTIAL", "FAILED", "INTERRUPTED"],
        states: dict[str, _ProviderState],
        stats: _RunStats,
        end: FinishedReportEnd | InterruptedReportEnd | FailedReportEnd,
        started_ns: int,
        unfinished: bool = False,
    ) -> DiscoveryReport:
        providers = tuple(
            DiscoveryProviderReport(
                provider_name=name,
                raw_item_count=state.raw_item_count,
                accepted_observation_count=state.accepted_observation_count,
                outcome=(
                    state.source_outcome
                    if state.source_published or not unfinished
                    else "INTERRUPTED"
                    if state.started
                    else "NOT_STARTED"
                ),
                failure=state.failure if state.source_published or not unfinished else None,
            )
            for name, state in states.items()
        )
        report = DiscoveryReport(
            kind="discovery",
            end=end,
            discovery_run_id=run_id,
            run_status=status,
            providers=providers,
            discovery_result_count=len(stats.result_meta_ids),
            new_meta_literature_count=stats.new_meta_literature_count,
            new_literature_count=stats.new_literature_count,
            new_metadata_observation_count=stats.new_metadata_observation_count,
        )
        _log_citation_report(report, started_ns=started_ns)
        return report

    def _check_cancelled(self) -> None:
        if self._cancel_event is not None and self._cancel_event.is_set():
            raise _ControlledInterruption()


def _validate_candidate_page(
    page: object,
    frontier: tuple[LiteratureId, ...],
) -> None:
    if not isinstance(page, ProviderRelationCandidatePage):
        raise _CitationContractError()
    if tuple(item.literature_id for item in page.seed_facts) != frontier:
        raise _CitationContractError()


def _provider_query_keys(
    provider_name: str,
    details: tuple[LiteratureDetail, ...],
) -> tuple[ProviderLiteratureKey, ...]:
    result: list[ProviderLiteratureKey] = []
    for detail in details:
        for observation in detail.metadata_observations:
            record_id = (
                observation.provenance.source_record_id
                if observation.provenance.source_name == provider_name
                else None
            )
            identifiers = observation.metadata.identifiers
            if record_id is None and not identifiers:
                continue
            key = ProviderLiteratureKey(record_id=record_id, identifiers=identifiers)
            if key not in result:
                result.append(key)
        if detail.literature.metadata.identifiers:
            key = ProviderLiteratureKey(identifiers=detail.literature.metadata.identifiers)
            if key not in result:
                result.append(key)
    return tuple(result)


def _reference_published(decision: object) -> bool:
    kind = getattr(decision, "decision", None)
    reference = getattr(decision, "reference", None)
    supports = getattr(decision, "supports", None)
    return (
        kind in ("created", "matched")
        and isinstance(reference, Reference)
        and isinstance(supports, tuple)
        and bool(supports)
        and all(isinstance(item, ReferenceSupport) for item in supports)
    )


def _inside_result_boundary(
    literature: Literature,
    *,
    seed_meta_ids: set[MetaLiteratureId],
    stats: _RunStats,
    result_limit: int,
) -> bool:
    meta_id = literature.meta_literature_id
    return (
        meta_id in seed_meta_ids
        or meta_id in stats.result_meta_ids
        or len(stats.result_meta_ids) < result_limit
    )


def _accepted_meta_was_created(result: ObservationAcceptanceResult) -> bool:
    value = getattr(result, "meta_literature_created", None)
    if type(value) is not bool:
        raise _CitationContractError()
    return value


def _validate_finalized(
    run: object,
    run_id: DiscoveryRunId,
    status: Literal["COMPLETED", "PARTIAL", "FAILED", "INTERRUPTED"],
) -> None:
    if not isinstance(run, DiscoveryRun) or run.discovery_run_id != run_id or run.status != status:
        raise _CitationContractError()


def _queue_discovered(
    literature: Literature,
    *,
    seed_meta_ids: set[MetaLiteratureId],
    visited: set[LiteratureId],
    next_frontier: list[LiteratureId],
) -> None:
    if literature.meta_literature_id in seed_meta_ids or literature.literature_id in visited:
        return
    visited.add(literature.literature_id)
    next_frontier.append(literature.literature_id)


def _normalized_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).split()).casefold()


def _lookup_matches_literature(lookup: ReferenceLookup, literature: Literature) -> bool:
    metadata = literature.metadata
    if lookup.identifiers and not set(lookup.identifiers).issubset(metadata.identifiers):
        return False
    if lookup.title is not None and (
        metadata.title is None or _normalized_text(metadata.title) != _normalized_text(lookup.title)
    ):
        return False
    if lookup.publication_year is not None and metadata.publication_year != lookup.publication_year:
        return False
    if lookup.authors:
        candidates = {_normalized_text(item.display_name) for item in metadata.authors}
        if not {_normalized_text(item) for item in lookup.authors}.issubset(candidates):
            return False
    return bool(lookup.identifiers or lookup.title)


def _lookup_matches_metadata(
    lookup: ReferenceLookup,
    observation: MetadataObservation,
) -> bool:
    synthetic = Literature.model_construct(metadata=observation.metadata)
    return _lookup_matches_literature(lookup, synthetic)


def _terminal_status(
    results: tuple[DiscoverySourceResult, ...],
) -> Literal["COMPLETED", "PARTIAL", "FAILED"]:
    failures = sum(item.outcome == "FAILED" for item in results)
    if failures == 0:
        return "COMPLETED"
    if failures == len(results):
        return "FAILED"
    return "PARTIAL"


def _terminal_report_status(
    states: dict[str, _ProviderState],
) -> Literal["COMPLETED", "PARTIAL", "FAILED"]:
    outcomes = tuple(state.source_outcome for state in states.values())
    failures = sum(outcome == "FAILED" for outcome in outcomes)
    if failures == 0:
        return "COMPLETED"
    if failures == len(outcomes):
        return "FAILED"
    return "PARTIAL"


def _provider_failure() -> StableFailure:
    return StableFailure(
        code="citation-provider-failed",
        reason="A metadata provider could not complete citation discovery.",
        action="Check provider readiness and retry the discovery.",
        retryable=True,
    )


def _operation_failure() -> StableFailure:
    return StableFailure(
        code="citation-discovery-failed",
        reason="Citation discovery could not safely complete its local operation.",
        action="Check the local catalog and retry the discovery.",
        retryable=True,
    )


def _log_citation_provider_failure(provider_name: str, failure: StableFailure) -> None:
    _LOGGER.warning(
        "event=citation-provider-failed provider=%s code=%s retryable=%s reason=%s action=%s",
        provider_name,
        failure.code,
        str(failure.retryable).lower(),
        failure.reason,
        failure.action,
    )


def _log_citation_report(report: DiscoveryReport, *, started_ns: int) -> None:
    elapsed_ms = max(0, (time.monotonic_ns() - started_ns) // 1_000_000)
    if isinstance(report.end, FailedReportEnd):
        failure = report.end.failure
        _LOGGER.error(
            "event=citation-discovery-failed outcome=failed discovery_run_id=%s "
            "status=%s elapsed_ms=%d code=%s retryable=%s reason=%s action=%s",
            report.discovery_run_id,
            report.run_status,
            elapsed_ms,
            failure.code,
            str(failure.retryable).lower(),
            failure.reason,
            failure.action,
        )
    elif isinstance(report.end, InterruptedReportEnd):
        _LOGGER.warning(
            "event=citation-discovery-interrupted outcome=interrupted discovery_run_id=%s "
            "result_count=%d elapsed_ms=%d "
            "reason=The citation discovery operation was interrupted. "
            "action=Retry citation discovery when the operation can continue.",
            report.discovery_run_id,
            report.discovery_result_count,
            elapsed_ms,
        )
    else:
        completed = report.run_status == "COMPLETED"
        log = _LOGGER.info if completed else _LOGGER.warning
        log(
            "event=citation-discovery-finished outcome=%s discovery_run_id=%s status=%s "
            "provider_count=%d result_count=%d new_literature_count=%d elapsed_ms=%d",
            "completed" if completed else "action-required",
            report.discovery_run_id,
            report.run_status,
            len(report.providers),
            report.discovery_result_count,
            report.new_literature_count,
            elapsed_ms,
        )


__all__ = ("CitationDiscoveryOperation", "DiscoveryRunIdFactory")
