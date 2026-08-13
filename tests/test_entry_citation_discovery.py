from __future__ import annotations

import unittest
from collections.abc import Generator, Iterable
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal

from sciretriever.analysis.api import AnalysisApi
from sciretriever.entry.citations import CitationDiscoveryOperation
from sciretriever.entry.ports import (
    ProviderRelationCandidatePage,
    ProviderRelationCandidateReadRequest,
    ProviderRelationCandidateRef,
    ProviderRelationSeedFacts,
    WriteAdmissionFailure,
)
from sciretriever.literature.api import (
    ContentReferenceEvidence,
    LiteratureApi,
    MetadataReferenceEvidence,
    ObservationAcceptanceResult,
    ProviderRelationEvidence,
    ProviderRelationObservationReadContext,
    ProviderRelationObservationReadRequest,
    ReferenceAcceptanceDecision,
    provider_key_matches_seed,
)
from sciretriever.literature.content import metadata_sha256
from sciretriever.literature.metadata import MetadataProjectionDecision
from sciretriever.literature.ports import (
    CurrentLiteratureFacts,
    IdentityObservationPublicationCommand,
    LiteratureObservation,
)
from sciretriever.literature.service import LiteratureService
from sciretriever.metadata.api import (
    MetadataApi,
    MetadataLookupRequest,
    MetadataProviderInvocation,
    MetadataProviderResult,
    MetadataPublication,
    MetadataReferenceQueryRequest,
)
from sciretriever.model.analysis import ReferenceLookup
from sciretriever.model.discovery import (
    CitationDiscoveryCause,
    CitationDiscoveryInput,
    DiscoveryCause,
    DiscoveryResult,
    DiscoveryRun,
    DiscoverySourceResult,
    ProviderDiscoveryLimit,
    TopicDiscoveryInput,
)
from sciretriever.model.library import (
    LibrarySearchPage,
    LibrarySearchRequest,
    LiteratureDetail,
    LiteratureSearchItem,
)
from sciretriever.model.literature import (
    ContentReferenceTextSupport,
    Identifier,
    Literature,
    LiteratureStatus,
    MetadataReferenceTextSupport,
    MetaLiterature,
    ProviderRelationSupport,
    Reference,
    ReferenceSupport,
    ReferenceSupportSource,
    VersionRole,
)
from sciretriever.model.metadata import (
    LiteratureMetadata,
    MetadataObservation,
    ProviderLiteratureKey,
    ProviderRelationObservation,
)
from sciretriever.model.primitives import (
    DiscoveryRunId,
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    ReferenceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import FailedReportEnd, StableFailure
from sciretriever.storage.files.paths import StorageRoot
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactStore
from sciretriever.storage.sqlite.content_publication import SqliteContentPublication
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.entry_reader import SqliteEntryReader
from sciretriever.storage.sqlite.literature_preconditions import LiteraturePreconditionReader
from sciretriever.storage.sqlite.literature_reader import LiteratureReader
from sciretriever.storage.sqlite.literature_writer import LiteratureWriter
from sciretriever.storage.sqlite.metadata_publication import (
    SqliteProviderRelationObservationPublication,
)

_TIME = UtcTimestamp("2026-08-12T12:00:00Z")
_HASH = Sha256("a" * 64)


def _uuid(index: int) -> str:
    return f"{index:08x}-0000-4000-8000-{index:012x}"


def _metadata(index: int) -> LiteratureMetadata:
    return LiteratureMetadata(
        title=f"Citation fixture {index}",
        publication_year=2020 + index % 5,
        document_type="journal-article",
        identifiers=(Identifier(namespace="doi", value=f"10.1000/citation-{index}"),),
    )


def _literature(index: int) -> Literature:
    return Literature(
        literature_id=LiteratureId(_uuid(index)),
        meta_literature_id=MetaLiteratureId(_uuid(1_000 + index)),
        version_role=VersionRole.OTHER,
        metadata=_metadata(index),
        status=LiteratureStatus.UNREVIEWED,
    )


def _observation(
    index: int,
    literature: Literature,
    *,
    provider: str,
    record_id: str,
) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_uuid(10_000 + index)),
        provenance=Provenance(
            provenance_id=ProvenanceId(_uuid(20_000 + index)),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=provider,
            source_record_id=record_id,
            observed_at=_TIME,
            input_sha256=_HASH,
            parameters_sha256=None,
        ),
        metadata=literature.metadata,
        version_role=literature.version_role,
    )


def _relation(
    index: int,
    *,
    provider: str,
    citing_record_id: str,
    cited_record_id: str,
) -> ProviderRelationObservation:
    return ProviderRelationObservation(
        observation_id=ObservationId(_uuid(30_000 + index)),
        provenance=Provenance(
            provenance_id=ProvenanceId(_uuid(40_000 + index)),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=provider,
            source_record_id=f"relation-response-{index}",
            observed_at=_TIME,
            input_sha256=_HASH,
            parameters_sha256=None,
        ),
        citing=ProviderLiteratureKey(record_id=citing_record_id),
        cited=ProviderLiteratureKey(record_id=cited_record_id),
    )


def _detail(
    literature: Literature,
    observations: tuple[MetadataObservation, ...],
) -> LiteratureDetail:
    return LiteratureDetail(
        literature=literature,
        meta_literature=MetaLiterature(
            meta_literature_id=literature.meta_literature_id,
            representative_literature_id=literature.literature_id,
        ),
        metadata_revision=1,
        metadata_sha256=metadata_sha256(literature.metadata),
        missing_step="primary-pdf",
        needs_manual_pdf=False,
        metadata_observations=observations,
        reference_count=0,
        cited_by_count=0,
    )


def _provider_failure() -> StableFailure:
    return StableFailure(
        code="offline-provider-failure",
        reason="The offline provider fixture failed.",
        action="Retry the offline provider fixture.",
        retryable=True,
    )


def _citation_cause(value: DiscoveryCause) -> CitationDiscoveryCause:
    if not isinstance(value, CitationDiscoveryCause):
        raise AssertionError("expected a CitationDiscoveryCause")
    return value


def _provider_result(
    provider_name: str,
    *,
    observations: tuple[MetadataObservation, ...] = (),
    relations: tuple[ProviderRelationObservation, ...] = (),
    raw_item_count: int = 0,
    outcome: Literal["EXHAUSTED", "SCAN_LIMIT_REACHED", "FAILED"] = "EXHAUSTED",
) -> MetadataProviderResult:
    return MetadataProviderResult(
        provider_name=provider_name,
        observations=observations,
        relations=relations,
        raw_item_count=raw_item_count,
        outcome=outcome,
        failure=_provider_failure() if outcome == "FAILED" else None,
    )


class _Literature(LiteratureApi):
    def __init__(
        self,
        *,
        details: dict[LiteratureId, LiteratureDetail] | None = None,
        relations: dict[ObservationId, ProviderRelationObservation] | None = None,
        reader: LiteratureReader | None = None,
        events: list[str] | None = None,
        omit_relation_ids: set[ObservationId] | None = None,
    ) -> None:
        self.details = {} if details is None else details
        self.relations = {} if relations is None else relations
        self.reader = reader
        self.events = [] if events is None else events
        self.omit_relation_ids = set() if omit_relation_ids is None else omit_relation_ids
        self.reference_calls: list[tuple[Literature, Literature, tuple[ReferenceSupport, ...]]] = []
        self.references: dict[tuple[LiteratureId, LiteratureId], Reference] = {}
        self.supports: dict[ReferenceId, list[ReferenceSupport]] = {}
        self.accepted_observations: list[MetadataObservation] = []

    def read_detail(self, literature_id: LiteratureId) -> LiteratureDetail:
        if self.reader is not None:
            return self.reader.read_detail(literature_id)
        return self.details[literature_id]

    def search(self, request: LibrarySearchRequest) -> LibrarySearchPage:
        if self.reader is not None:
            return self.reader.search(request)
        items = tuple(
            LiteratureSearchItem(
                literature=detail.literature,
                metadata_revision=detail.metadata_revision,
                metadata_sha256=detail.metadata_sha256,
                missing_step=detail.missing_step,
                needs_manual_pdf=detail.needs_manual_pdf,
            )
            for detail in self.details.values()
        )
        return LibrarySearchPage(items=items, total_count=len(items))

    def read_provider_relation_observations(
        self,
        request: ProviderRelationObservationReadRequest,
    ) -> ProviderRelationObservationReadContext:
        if self.reader is not None:
            return self.reader.read_provider_relation_observations(request)
        return ProviderRelationObservationReadContext(
            observations=tuple(
                self.relations[item]
                for item in request.observation_ids
                if item in self.relations and item not in self.omit_relation_ids
            )
        )

    def accept_observation(
        self,
        observation: MetadataObservation,
        *,
        provider_precedence: Iterable[str] = (),
    ) -> ObservationAcceptanceResult:
        del provider_precedence
        self.events.append("accept")
        self.accepted_observations.append(observation)
        identifiers = set(observation.metadata.identifiers)
        existing = next(
            (
                detail
                for detail in self.details.values()
                if identifiers and identifiers.intersection(detail.literature.metadata.identifiers)
            ),
            None,
        )
        created = existing is None
        if existing is None:
            index = 50_000 + len(self.details)
            literature = Literature(
                literature_id=LiteratureId(_uuid(index)),
                meta_literature_id=MetaLiteratureId(_uuid(index + 1_000)),
                version_role=observation.version_role or VersionRole.OTHER,
                metadata=observation.metadata,
                status=LiteratureStatus.UNREVIEWED,
            )
            meta = MetaLiterature(
                meta_literature_id=literature.meta_literature_id,
                representative_literature_id=literature.literature_id,
            )
            self.details[literature.literature_id] = _detail(literature, (observation,))
        else:
            literature = existing.literature
            meta = existing.meta_literature
        return ObservationAcceptanceResult(
            decision="created" if created else "matched",
            literature=literature,
            meta_literature=meta,
            observation=observation,
            projection=MetadataProjectionDecision(
                outcome="unchanged",
                metadata=literature.metadata,
                metadata_revision=1,
            ),
            metadata_revision=1,
            deduplicated=False,
            meta_literature_created=created,
        )

    def publish_reference(
        self,
        *,
        source: Literature,
        target: Literature,
        provider_relations: Iterable[ProviderRelationEvidence] = (),
        metadata_references: Iterable[MetadataReferenceEvidence] = (),
        content_references: Iterable[ContentReferenceEvidence] = (),
        reference_id: ReferenceId | None = None,
    ) -> ReferenceAcceptanceDecision:
        self.events.append("reference")
        key = (source.literature_id, target.literature_id)
        reference = self.references.get(key)
        created = reference is None
        if reference is None:
            reference = Reference(
                reference_id=reference_id or ReferenceId(_uuid(60_000 + len(self.references))),
                source_literature_id=source.literature_id,
                target_literature_id=target.literature_id,
            )
            self.references[key] = reference
            self.supports[reference.reference_id] = []
        new_sources: list[ReferenceSupportSource] = [
            ProviderRelationSupport(
                kind="provider_relation",
                observation_id=item.observation.observation_id,
            )
            for item in provider_relations
        ]
        new_sources.extend(
            MetadataReferenceTextSupport(
                kind="metadata_reference_text",
                metadata_observation_id=item.observation.observation_id,
                reference_index=item.reference_index,
            )
            for item in metadata_references
        )
        new_sources.extend(
            ContentReferenceTextSupport(
                kind="content_reference_text",
                literature_content_sha256=item.content.literature_content_sha256,
                reference_index=item.reference_index,
            )
            for item in content_references
        )
        current = self.supports[reference.reference_id]
        changed = created
        for support_source in new_sources:
            support = ReferenceSupport(reference_id=reference.reference_id, source=support_source)
            if support not in current:
                current.append(support)
                changed = True
        supports = tuple(current)
        self.reference_calls.append((source, target, supports))
        return ReferenceAcceptanceDecision(
            decision="created" if created else "matched",
            reference=reference,
            supports=supports,
            changed=changed,
        )


class _Metadata(MetadataApi):
    def __init__(
        self,
        *,
        query_results: list[MetadataProviderResult] | None = None,
        lookup_results: list[MetadataProviderResult] | None = None,
        query_invocations: list[MetadataProviderInvocation] | None = None,
        lookup_invocations: list[MetadataProviderInvocation] | None = None,
    ) -> None:
        self.query_results = [] if query_results is None else query_results
        self.lookup_results = [] if lookup_results is None else lookup_results
        self.query_invocations = [] if query_invocations is None else query_invocations
        self.lookup_invocations = [] if lookup_invocations is None else lookup_invocations
        self.query_requests: list[MetadataReferenceQueryRequest] = []
        self.lookup_requests: list[MetadataLookupRequest] = []
        self.topic_requests: list[TopicDiscoveryInput] = []

    def query_references_provider(
        self,
        request: MetadataReferenceQueryRequest,
        *,
        cancel_event: object | None = None,
    ) -> MetadataProviderInvocation:
        del cancel_event
        self.query_requests.append(request)
        provider_name = request.providers[0].provider_name
        if self.query_invocations:
            return self.query_invocations.pop(0)
        result = (
            self.query_results.pop(0) if self.query_results else _provider_result(provider_name)
        )
        return MetadataProviderInvocation.model_validate(result.model_dump())

    def lookup_provider(
        self,
        request: MetadataLookupRequest,
        *,
        cancel_event: object | None = None,
    ) -> MetadataProviderInvocation:
        del cancel_event
        self.lookup_requests.append(request)
        if self.lookup_invocations:
            return self.lookup_invocations.pop(0)
        result = (
            self.lookup_results.pop(0)
            if self.lookup_results
            else _provider_result(request.provider_name)
        )
        return MetadataProviderInvocation.model_validate(result.model_dump())

    def search_topic_provider(
        self,
        request: TopicDiscoveryInput,
        *,
        cancel_event: object | None = None,
    ) -> MetadataProviderInvocation:
        del cancel_event
        self.topic_requests.append(request)
        return MetadataProviderInvocation.model_validate(
            _provider_result(request.providers[0].provider_name).model_dump()
        )


class _Analysis(AnalysisApi):
    def __init__(self) -> None:
        pass

    def extract_reference_lookups(
        self,
        reference_texts: tuple[str, ...],
        *,
        cancel_event: object | None = None,
    ) -> tuple[ReferenceLookup, ...]:
        del reference_texts, cancel_event
        return ()


class _CandidateReader:
    def __init__(
        self,
        details: dict[LiteratureId, LiteratureDetail],
        relations: dict[ObservationId, ProviderRelationObservation],
    ) -> None:
        self.details = details
        self.relations = relations
        self.requests: list[ProviderRelationCandidateReadRequest] = []

    def read_provider_relation_candidates(
        self,
        request: ProviderRelationCandidateReadRequest,
    ) -> ProviderRelationCandidatePage:
        self.requests.append(request)
        seed_facts = tuple(
            ProviderRelationSeedFacts(
                literature_id=item,
                metadata_observations=self.details[item].metadata_observations,
            )
            for item in request.seed_literature_ids
        )
        candidates: list[ProviderRelationCandidateRef] = []
        for relation in sorted(self.relations.values(), key=lambda item: str(item.observation_id)):
            if relation.provenance.source_name != request.provider_name:
                continue
            endpoints: tuple[tuple[Literal["citing", "cited"], ProviderLiteratureKey], ...]
            if request.direction == "references":
                endpoints = (("citing", relation.citing),)
            elif request.direction == "cited-by":
                endpoints = (("cited", relation.cited),)
            else:
                endpoints = (("citing", relation.citing), ("cited", relation.cited))
            for endpoint_name, endpoint in endpoints:
                matches = tuple(
                    item.literature_id
                    for item in seed_facts
                    if provider_key_matches_seed(
                        provider_name=request.provider_name,
                        key=endpoint,
                        seed_observations=item.metadata_observations,
                    )
                )
                if matches:
                    candidates.append(
                        ProviderRelationCandidateRef(
                            observation_id=relation.observation_id,
                            seed_endpoint=endpoint_name,
                            candidate_seed_literature_ids=matches,
                        )
                    )
        return ProviderRelationCandidatePage(
            seed_facts=seed_facts,
            candidates=tuple(candidates),
            next_after_observation_id=None,
        )


class _RelationPublication:
    def __init__(
        self,
        relations: dict[ObservationId, ProviderRelationObservation],
        *,
        fail: bool = False,
    ) -> None:
        self.relations = relations
        self.fail = fail
        self.published: list[ProviderRelationObservation] = []

    def publish_provider_relation_observation(
        self,
        observation: ProviderRelationObservation,
    ) -> None:
        if self.fail:
            raise RuntimeError("offline relation publication failure")
        self.published.append(observation)
        self.relations[observation.observation_id] = observation


class _Repository:
    def __init__(self) -> None:
        self.runs: list[DiscoveryRun] = []
        self.finalized: list[str] = []

    def create(self, run: DiscoveryRun) -> None:
        self.runs.append(run)

    def finalize(self, discovery_run_id: DiscoveryRunId, status: str) -> DiscoveryRun:
        self.finalized.append(status)
        run = next(item for item in self.runs if item.discovery_run_id == discovery_run_id)
        return run.model_copy(update={"status": status})


class _Publication:
    def __init__(
        self,
        events: list[str] | None = None,
        *,
        event: "_Event | None" = None,
        cancel_after_sources: int | None = None,
    ) -> None:
        self.events = [] if events is None else events
        self.sources: list[DiscoverySourceResult] = []
        self.results: list[tuple[DiscoveryResult, DiscoveryCause]] = []
        self.event = event
        self.cancel_after_sources = cancel_after_sources

    def publish_source_result(self, result: DiscoverySourceResult) -> None:
        self.sources.append(result)
        if (
            self.event is not None
            and self.cancel_after_sources is not None
            and len(self.sources) == self.cancel_after_sources
        ):
            self.event.value = True

    def publish_result_and_cause(
        self,
        result: DiscoveryResult,
        cause: DiscoveryCause,
    ) -> None:
        self.events.append("cause")
        self.results.append((result, cause))


class _Admission:
    def __init__(self, failure: BaseException | None = None) -> None:
        self.failure = failure

    @contextmanager
    def acquire_nowait(self) -> Generator[None, None, None]:
        if self.failure is not None:
            raise self.failure
        yield


class _Recovery:
    def interrupt_visible_running(self) -> tuple[DiscoveryRunId, ...]:
        return ()


class _Clock:
    def now(self) -> UtcTimestamp:
        return _TIME


class _Event:
    def __init__(self, value: bool = False) -> None:
        self.value = value

    def is_set(self) -> bool:
        return self.value


class _LiteratureIds:
    def __init__(self) -> None:
        self.next_value = 90_000

    def _next(self) -> str:
        value = _uuid(self.next_value)
        self.next_value += 1
        return value

    def new_literature_id(self) -> LiteratureId:
        return LiteratureId(self._next())

    def new_meta_literature_id(self) -> MetaLiteratureId:
        return MetaLiteratureId(self._next())

    def new_reference_id(self) -> ReferenceId:
        return ReferenceId(self._next())


class CitationDiscoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-citation-discovery-")
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.catalog_path = root / "catalog.sqlite"
        self.storage_root = StorageRoot(root / "artifacts")
        self.engine = CatalogEngine(self.catalog_path)
        self.writer = LiteratureWriter(self.engine)
        self.next_run = 0

    def _publish_literatures(
        self,
        values: tuple[tuple[Literature, MetadataObservation], ...],
    ) -> None:
        self.writer.publish_identity_and_observation(
            IdentityObservationPublicationCommand(
                literatures=tuple(item[0] for item in values),
                meta_literatures=tuple(
                    MetaLiterature(
                        meta_literature_id=literature.meta_literature_id,
                        representative_literature_id=literature.literature_id,
                    )
                    for literature, _ in values
                ),
                observations=tuple(
                    LiteratureObservation(
                        literature_id=literature.literature_id,
                        observation=observation,
                    )
                    for literature, observation in values
                ),
                facts=tuple(
                    CurrentLiteratureFacts(
                        literature=literature,
                        metadata_revision=1,
                        metadata_sha256=metadata_sha256(literature.metadata),
                    )
                    for literature, _ in values
                ),
                expected_tokens=(),
                expected_meta_tokens=(),
            )
        )

    def _new_readers(self) -> tuple[SqliteEntryReader, LiteratureReader]:
        entry_engine = CatalogEngine(self.catalog_path, create=False)
        literature_engine = CatalogEngine(self.catalog_path, create=False)
        verified = VerifiedReader(self.storage_root)
        return (
            SqliteEntryReader(entry_engine, verified),
            LiteratureReader(literature_engine, verified),
        )

    def _operation(
        self,
        *,
        literature: _Literature,
        candidate_reader: object,
        metadata: _Metadata | None = None,
        relation_publication: _RelationPublication | None = None,
        publication: _Publication | None = None,
        repository: _Repository | None = None,
        event: _Event | None = None,
        admission_failure: BaseException | None = None,
    ) -> tuple[CitationDiscoveryOperation, _Repository, _Metadata, _Publication]:
        self.next_run += 1
        metadata = metadata or _Metadata()
        publication = publication or _Publication(literature.events)
        repository = repository or _Repository()
        relation_port = relation_publication or _RelationPublication(literature.relations)
        metadata_publication = MetadataPublication(literature, relation_port)
        operation = CitationDiscoveryOperation(
            metadata=metadata,
            relation_publication=metadata_publication,
            literature=literature,
            analysis=_Analysis(),
            candidate_reader=candidate_reader,  # type: ignore[arg-type]
            run_repository=repository,
            discovery_publication=publication,
            write_admission=_Admission(admission_failure),
            recovery=_Recovery(),
            clock=_Clock(),
            run_id_factory=lambda: DiscoveryRunId(_uuid(70_000 + self.next_run)),
            cancel_event=event,
        )
        return operation, repository, metadata, publication

    def test_write_admission_failure_returns_stable_report_without_creating_run(self) -> None:
        failure = StableFailure(
            code="write-admission-failed",
            reason="The local write boundary was unavailable.",
            action="Retry the operation.",
            retryable=True,
        )
        literature = _Literature()
        operation, repository, metadata, publication = self._operation(
            literature=literature,
            candidate_reader=_CandidateReader({}, {}),
            admission_failure=WriteAdmissionFailure(failure),
        )

        report = operation(self._request((_literature(1).literature_id,)))

        end = report.end
        self.assertEqual(end.kind, "failed")
        if not isinstance(end, FailedReportEnd):
            self.fail("expected a failed Report end")
        self.assertEqual(end.failure, failure)
        self.assertEqual(report.run_status, "FAILED")
        self.assertTrue(all(item.outcome == "NOT_STARTED" for item in report.providers))
        self.assertEqual(repository.runs, [])
        self.assertEqual(metadata.query_requests, [])
        self.assertEqual(metadata.lookup_requests, [])
        self.assertEqual(metadata.topic_requests, [])
        self.assertEqual(publication.results, [])

    def _request(
        self,
        seeds: tuple[LiteratureId, ...],
        *,
        direction: Literal["references", "cited-by", "both"] = "references",
        max_depth: int = 1,
        result_limit: int = 10,
        providers: tuple[ProviderDiscoveryLimit, ...] | None = None,
    ) -> CitationDiscoveryInput:
        return CitationDiscoveryInput(
            kind="citation",
            seed_literature_ids=seeds,
            direction=direction,
            max_depth=max_depth,
            result_limit=result_limit,
            providers=providers
            or (ProviderDiscoveryLimit(provider_name="provider", scan_limit=10),),
        )

    def test_persisted_relation_is_discovered_after_reader_rebuild(self) -> None:
        seed = _literature(1)
        target = _literature(2)
        seed_observation = _observation(1, seed, provider="provider", record_id="persisted-seed")
        target_observation = _observation(
            2, target, provider="provider", record_id="persisted-target"
        )
        self._publish_literatures(((seed, seed_observation), (target, target_observation)))
        relation = _relation(
            1,
            provider="provider",
            citing_record_id="persisted-seed",
            cited_record_id="persisted-target",
        )
        relation_id = relation.observation_id
        self.writer.publish_provider_relation_observation(relation)
        del relation

        candidate_reader, literature_reader = self._new_readers()
        events: list[str] = []
        literature = _Literature(reader=literature_reader, events=events)
        publication = _Publication(events)
        operation, repository, metadata, publication = self._operation(
            literature=literature,
            candidate_reader=candidate_reader,
            publication=publication,
        )

        report = operation(self._request((seed.literature_id,), result_limit=1))

        self.assertEqual(report.run_status, "COMPLETED")
        self.assertEqual(report.discovery_result_count, 1)
        self.assertEqual(repository.finalized, ["COMPLETED"])
        self.assertEqual(metadata.query_requests, [])
        self.assertEqual(publication.sources[0].outcome, "EXHAUSTED")
        self.assertEqual(len(literature.reference_calls), 1)
        source, discovered, supports = literature.reference_calls[0]
        self.assertEqual((source, discovered), (seed, target))
        self.assertEqual(
            supports[0].source,
            ProviderRelationSupport(kind="provider_relation", observation_id=relation_id),
        )
        result, cause = publication.results[0]
        cause = _citation_cause(cause)
        self.assertEqual(result.meta_literature_id, target.meta_literature_id)
        self.assertEqual(
            (cause.source_literature_id, cause.target_literature_id, cause.depth),
            (seed.literature_id, target.literature_id, 1),
        )
        self.assertLess(events.index("reference"), events.index("cause"))

    def test_cited_by_keeps_citing_to_cited_reference_direction(self) -> None:
        citing = _literature(3)
        cited = _literature(4)
        citing_observation = _observation(
            3, citing, provider="provider", record_id="direction-citing"
        )
        cited_observation = _observation(4, cited, provider="provider", record_id="direction-cited")
        self._publish_literatures(((citing, citing_observation), (cited, cited_observation)))
        self.writer.publish_provider_relation_observation(
            _relation(
                2,
                provider="provider",
                citing_record_id="direction-citing",
                cited_record_id="direction-cited",
            )
        )
        candidate_reader, literature_reader = self._new_readers()
        literature = _Literature(reader=literature_reader)
        operation, _, _, publication = self._operation(
            literature=literature,
            candidate_reader=candidate_reader,
        )

        report = operation(
            self._request(
                (cited.literature_id,),
                direction="cited-by",
                result_limit=1,
            )
        )

        self.assertEqual(report.discovery_result_count, 1)
        source, target, _ = literature.reference_calls[0]
        self.assertEqual((source, target), (citing, cited))
        _, cause = publication.results[0]
        cause = _citation_cause(cause)
        self.assertEqual(cause.meta_literature_id, citing.meta_literature_id)
        self.assertEqual(cause.source_literature_id, citing.literature_id)
        self.assertEqual(cause.target_literature_id, cited.literature_id)

    def test_depth_zero_and_breadth_first_depth_boundaries(self) -> None:
        first = _literature(5)
        second = _literature(6)
        third = _literature(7)
        observations = (
            _observation(5, first, provider="provider", record_id="depth-a"),
            _observation(6, second, provider="provider", record_id="depth-b"),
            _observation(7, third, provider="provider", record_id="depth-c"),
        )
        self._publish_literatures(tuple(zip((first, second, third), observations, strict=True)))
        for relation in (
            _relation(
                3,
                provider="provider",
                citing_record_id="depth-a",
                cited_record_id="depth-b",
            ),
            _relation(
                4,
                provider="provider",
                citing_record_id="depth-b",
                cited_record_id="depth-c",
            ),
        ):
            self.writer.publish_provider_relation_observation(relation)

        zero_candidate, zero_reader = self._new_readers()
        zero_literature = _Literature(reader=zero_reader)
        zero_operation, zero_repository, zero_metadata, zero_publication = self._operation(
            literature=zero_literature,
            candidate_reader=zero_candidate,
        )
        zero_report = zero_operation(self._request((first.literature_id,), max_depth=0))
        self.assertEqual(zero_report.discovery_result_count, 0)
        self.assertEqual(zero_report.providers[0].outcome, "EXHAUSTED")
        self.assertEqual(zero_repository.finalized, ["COMPLETED"])
        self.assertEqual(zero_metadata.query_requests, [])
        self.assertEqual(zero_publication.results, [])

        one_candidate, one_reader = self._new_readers()
        one_literature = _Literature(reader=one_reader)
        one_operation, _, _, one_publication = self._operation(
            literature=one_literature,
            candidate_reader=one_candidate,
        )
        one_report = one_operation(self._request((first.literature_id,), max_depth=1))
        self.assertEqual(one_report.discovery_result_count, 1)
        self.assertEqual(
            {item.meta_literature_id for item, _ in one_publication.results},
            {second.meta_literature_id},
        )

        two_candidate, two_reader = self._new_readers()
        two_literature = _Literature(reader=two_reader)
        two_operation, _, _, two_publication = self._operation(
            literature=two_literature,
            candidate_reader=two_candidate,
        )
        two_report = two_operation(self._request((first.literature_id,), max_depth=2))
        self.assertEqual(two_report.discovery_result_count, 2)
        self.assertEqual(
            [
                (item.meta_literature_id, _citation_cause(cause).depth)
                for item, cause in two_publication.results
            ],
            [(second.meta_literature_id, 1), (third.meta_literature_id, 2)],
        )

    def test_result_limit_excludes_seeds_but_retains_repeated_causes(self) -> None:
        first_seed = _literature(8)
        second_seed = _literature(9)
        selected = _literature(10)
        over_limit = _literature(11)
        fixtures = (
            (first_seed, "limit-seed-a"),
            (second_seed, "limit-seed-b"),
            (selected, "limit-selected"),
            (over_limit, "limit-over"),
        )
        self._publish_literatures(
            tuple(
                (
                    literature,
                    _observation(
                        8 + index,
                        literature,
                        provider="provider",
                        record_id=record_id,
                    ),
                )
                for index, (literature, record_id) in enumerate(fixtures)
            )
        )
        relations = (
            _relation(
                5,
                provider="provider",
                citing_record_id="limit-seed-a",
                cited_record_id="limit-seed-b",
            ),
            _relation(
                6,
                provider="provider",
                citing_record_id="limit-seed-a",
                cited_record_id="limit-selected",
            ),
            _relation(
                7,
                provider="provider",
                citing_record_id="limit-seed-b",
                cited_record_id="limit-selected",
            ),
            _relation(
                8,
                provider="provider",
                citing_record_id="limit-seed-a",
                cited_record_id="limit-over",
            ),
        )
        for relation in relations:
            self.writer.publish_provider_relation_observation(relation)
        candidate_reader, literature_reader = self._new_readers()
        literature = _Literature(reader=literature_reader)
        operation, _, metadata, publication = self._operation(
            literature=literature,
            candidate_reader=candidate_reader,
        )

        report = operation(
            self._request(
                (first_seed.literature_id, second_seed.literature_id),
                result_limit=1,
            )
        )

        self.assertEqual(report.discovery_result_count, 1)
        self.assertEqual(
            {item.meta_literature_id for item, _ in publication.results},
            {selected.meta_literature_id},
        )
        self.assertEqual(len(publication.results), 2)
        self.assertEqual(
            {_citation_cause(cause).source_literature_id for _, cause in publication.results},
            {first_seed.literature_id, second_seed.literature_id},
        )
        self.assertNotIn(
            over_limit.literature_id,
            {target.literature_id for _, target, _ in literature.reference_calls},
        )
        self.assertIn(
            (first_seed.literature_id, second_seed.literature_id),
            literature.references,
        )
        self.assertEqual(metadata.query_requests, [])

    def test_reference_query_and_target_lookup_share_run_wide_raw_limit(self) -> None:
        seed = _literature(12)
        seed_observation = _observation(12, seed, provider="provider", record_id="budget-seed")
        details = {seed.literature_id: _detail(seed, (seed_observation,))}
        relations: dict[ObservationId, ProviderRelationObservation] = {}
        relation = _relation(
            9,
            provider="provider",
            citing_record_id="budget-seed",
            cited_record_id="budget-target",
        )
        target_template = _literature(13)
        target_observation = _observation(
            13,
            target_template,
            provider="provider",
            record_id="budget-target",
        )
        metadata = _Metadata(
            query_results=[
                _provider_result(
                    "provider",
                    relations=(relation,),
                    raw_item_count=2,
                )
            ],
            lookup_results=[
                _provider_result(
                    "provider",
                    observations=(target_observation,),
                    raw_item_count=3,
                    outcome="SCAN_LIMIT_REACHED",
                )
            ],
        )
        literature = _Literature(details=details, relations=relations)
        candidate_reader = _CandidateReader(details, relations)
        relation_publication = _RelationPublication(relations)
        operation, _, _, publication = self._operation(
            literature=literature,
            candidate_reader=candidate_reader,
            metadata=metadata,
            relation_publication=relation_publication,
        )

        report = operation(
            self._request(
                (seed.literature_id,),
                result_limit=1,
                providers=(ProviderDiscoveryLimit(provider_name="provider", scan_limit=5),),
            )
        )

        self.assertEqual(metadata.query_requests[0].providers[0].scan_limit, 5)
        self.assertEqual(metadata.lookup_requests[0].scan_limit, 3)
        self.assertEqual(report.providers[0].raw_item_count, 5)
        self.assertEqual(report.providers[0].outcome, "SCAN_LIMIT_REACHED")
        self.assertEqual(report.providers[0].accepted_observation_count, 1)
        self.assertEqual(report.discovery_result_count, 1)
        self.assertEqual(relation_publication.published, [relation])
        self.assertEqual(len(publication.results), 1)

    def test_last_lookup_interruption_keeps_partial_fact_without_source_result(self) -> None:
        seed = _literature(120)
        seed_observation = _observation(
            120,
            seed,
            provider="provider",
            record_id="interrupted-seed",
        )
        details = {seed.literature_id: _detail(seed, (seed_observation,))}
        relations: dict[ObservationId, ProviderRelationObservation] = {}
        relation = _relation(
            120,
            provider="provider",
            citing_record_id="interrupted-seed",
            cited_record_id="interrupted-target",
        )
        target_template = _literature(121)
        target_observation = _observation(
            121,
            target_template,
            provider="provider",
            record_id="interrupted-target",
        )
        lookup_relation = _relation(
            121,
            provider="provider",
            citing_record_id="interrupted-target",
            cited_record_id="interrupted-other",
        )
        metadata = _Metadata(
            query_results=[
                _provider_result(
                    "provider",
                    relations=(relation,),
                    raw_item_count=1,
                )
            ],
            lookup_invocations=[
                MetadataProviderInvocation(
                    provider_name="provider",
                    observations=(target_observation,),
                    relations=(lookup_relation,),
                    raw_item_count=1,
                    outcome="INTERRUPTED",
                )
            ],
        )
        literature = _Literature(details=details, relations=relations)
        relation_port = _RelationPublication(relations)
        operation, repository, _, publication = self._operation(
            literature=literature,
            candidate_reader=_CandidateReader(details, relations),
            metadata=metadata,
            relation_publication=relation_port,
        )

        report = operation(
            self._request(
                (seed.literature_id,),
                result_limit=1,
                providers=(ProviderDiscoveryLimit(provider_name="provider", scan_limit=5),),
            )
        )

        self.assertEqual(report.run_status, "INTERRUPTED")
        self.assertEqual(repository.finalized, ["INTERRUPTED"])
        self.assertEqual(report.providers[0].outcome, "INTERRUPTED")
        self.assertEqual(report.providers[0].raw_item_count, 2)
        self.assertEqual(report.providers[0].accepted_observation_count, 1)
        self.assertEqual(report.new_meta_literature_count, 1)
        self.assertEqual(report.new_literature_count, 1)
        self.assertEqual(report.new_metadata_observation_count, 1)
        self.assertEqual(literature.accepted_observations, [target_observation])
        self.assertEqual(relation_port.published, [relation, lookup_relation])
        self.assertEqual(relation_port.published.count(relation), 1)
        self.assertEqual(relation_port.published.count(lookup_relation), 1)
        self.assertEqual(publication.sources, [])
        self.assertEqual(publication.results, [])

    def test_interrupted_reference_query_publishes_relation_without_admitting_inline_target(
        self,
    ) -> None:
        seed = _literature(122)
        seed_observation = _observation(
            122,
            seed,
            provider="provider",
            record_id="query-interrupted-seed",
        )
        target = _literature(123)
        inline_target = _observation(
            123,
            target,
            provider="provider",
            record_id="query-interrupted-target",
        )
        relation = _relation(
            122,
            provider="provider",
            citing_record_id="query-interrupted-seed",
            cited_record_id="query-interrupted-target",
        )
        details = {seed.literature_id: _detail(seed, (seed_observation,))}
        relations: dict[ObservationId, ProviderRelationObservation] = {}
        literature = _Literature(details=details, relations=relations)
        relation_port = _RelationPublication(relations)
        metadata = _Metadata(
            query_invocations=[
                MetadataProviderInvocation(
                    provider_name="provider",
                    observations=(inline_target,),
                    relations=(relation,),
                    raw_item_count=1,
                    outcome="INTERRUPTED",
                )
            ]
        )
        operation, repository, _, publication = self._operation(
            literature=literature,
            candidate_reader=_CandidateReader(details, relations),
            metadata=metadata,
            relation_publication=relation_port,
        )

        report = operation(self._request((seed.literature_id,), result_limit=1))

        self.assertEqual(report.run_status, "INTERRUPTED")
        self.assertEqual(repository.finalized, ["INTERRUPTED"])
        self.assertEqual(report.providers[0].outcome, "INTERRUPTED")
        self.assertEqual(report.providers[0].raw_item_count, 1)
        self.assertEqual(report.providers[0].accepted_observation_count, 0)
        self.assertEqual(report.new_meta_literature_count, 0)
        self.assertEqual(report.new_literature_count, 0)
        self.assertEqual(report.new_metadata_observation_count, 0)
        self.assertEqual(relation_port.published, [relation])
        self.assertEqual(literature.accepted_observations, [])
        self.assertEqual(literature.reference_calls, [])
        self.assertEqual(publication.sources, [])
        self.assertEqual(publication.results, [])

    def test_real_literature_accepts_interrupted_lookup_partial_once(self) -> None:
        verified = VerifiedReader(self.storage_root)
        literature = LiteratureApi(
            LiteratureService(
                read_port=LiteraturePreconditionReader(self.engine, verified),
                identity_port=self.writer,
                content_port=SqliteContentPublication(
                    self.engine,
                    ArtifactStore(self.storage_root),
                    verified,
                ),
                reference_port=self.writer,
                maintenance_port=self.writer,
                id_factory=_LiteratureIds(),
                query_port=LiteratureReader(
                    CatalogEngine(self.catalog_path, create=False),
                    verified,
                ),
            )
        )
        relation_publication = MetadataPublication(
            literature,
            SqliteProviderRelationObservationPublication(self.writer),
        )
        seed_template = _literature(124)
        seed_observation = _observation(
            124,
            seed_template,
            provider="provider",
            record_id="real-interrupted-seed",
        )
        accepted_seed = relation_publication.publish_observation(seed_observation)
        self.assertEqual(accepted_seed.decision, "created")
        assert accepted_seed.literature is not None
        seed = accepted_seed.literature
        relation = _relation(
            124,
            provider="provider",
            citing_record_id="real-interrupted-seed",
            cited_record_id="real-interrupted-target",
        )
        target_observation = _observation(
            125,
            _literature(125),
            provider="provider",
            record_id="real-interrupted-target",
        )
        metadata = _Metadata(
            query_results=[
                _provider_result(
                    "provider",
                    relations=(relation,),
                    raw_item_count=1,
                )
            ],
            lookup_invocations=[
                MetadataProviderInvocation(
                    provider_name="provider",
                    observations=(target_observation,),
                    relations=(),
                    raw_item_count=1,
                    outcome="INTERRUPTED",
                )
            ],
        )
        repository = _Repository()
        publication = _Publication()
        operation = CitationDiscoveryOperation(
            metadata=metadata,
            relation_publication=relation_publication,
            literature=literature,
            analysis=_Analysis(),
            candidate_reader=SqliteEntryReader(
                CatalogEngine(self.catalog_path, create=False),
                verified,
            ),
            run_repository=repository,
            discovery_publication=publication,
            write_admission=_Admission(),
            recovery=_Recovery(),
            clock=_Clock(),
            run_id_factory=lambda: DiscoveryRunId(_uuid(79_000)),
        )

        report = operation(self._request((seed.literature_id,), result_limit=1))

        self.assertEqual(report.run_status, "INTERRUPTED")
        self.assertEqual(repository.finalized, ["INTERRUPTED"])
        self.assertEqual(report.providers[0].outcome, "INTERRUPTED")
        self.assertEqual(report.providers[0].raw_item_count, 2)
        self.assertEqual(report.providers[0].accepted_observation_count, 1)
        self.assertEqual(report.new_meta_literature_count, 1)
        self.assertEqual(report.new_literature_count, 1)
        self.assertEqual(report.new_metadata_observation_count, 1)
        self.assertEqual(publication.sources, [])
        self.assertEqual(publication.results, [])
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM literatures").fetchone(), (2,)
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM meta_literatures").fetchone(),
                (2,),
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM metadata_observations").fetchone(),
                (2,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM provider_relation_observations"
                ).fetchone(),
                (1,),
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM literature_references").fetchone(),
                (0,),
            )

    def test_one_provider_failure_is_partial_and_does_not_rollback_other_source(self) -> None:
        seed = _literature(14)
        seed_observation = _observation(14, seed, provider="alpha", record_id="partial-seed")
        details = {seed.literature_id: _detail(seed, (seed_observation,))}
        relations: dict[ObservationId, ProviderRelationObservation] = {}
        literature = _Literature(details=details, relations=relations)
        metadata = _Metadata(
            query_results=[
                _provider_result("alpha", raw_item_count=1, outcome="FAILED"),
                _provider_result("beta"),
            ]
        )
        operation, repository, _, publication = self._operation(
            literature=literature,
            candidate_reader=_CandidateReader(details, relations),
            metadata=metadata,
        )

        report = operation(
            self._request(
                (seed.literature_id,),
                providers=(
                    ProviderDiscoveryLimit(provider_name="alpha", scan_limit=2),
                    ProviderDiscoveryLimit(provider_name="beta", scan_limit=2),
                ),
            )
        )

        self.assertEqual(report.run_status, "PARTIAL")
        self.assertEqual(repository.finalized, ["PARTIAL"])
        self.assertEqual(
            [(item.provider_name, item.outcome) for item in publication.sources],
            [("alpha", "FAILED"), ("beta", "EXHAUSTED")],
        )
        self.assertEqual(
            [(item.provider_name, item.outcome) for item in report.providers],
            [("alpha", "FAILED"), ("beta", "EXHAUSTED")],
        )

    def test_cancellation_after_run_creation_is_interrupted_without_source_results(self) -> None:
        seed = _literature(15)
        seed_observation = _observation(15, seed, provider="alpha", record_id="cancel-seed")
        details = {seed.literature_id: _detail(seed, (seed_observation,))}
        relations: dict[ObservationId, ProviderRelationObservation] = {}
        literature = _Literature(details=details, relations=relations)
        metadata = _Metadata()
        operation, repository, _, publication = self._operation(
            literature=literature,
            candidate_reader=_CandidateReader(details, relations),
            metadata=metadata,
            event=_Event(True),
        )

        report = operation(
            self._request(
                (seed.literature_id,),
                providers=(
                    ProviderDiscoveryLimit(provider_name="alpha", scan_limit=2),
                    ProviderDiscoveryLimit(provider_name="beta", scan_limit=2),
                ),
            )
        )

        self.assertEqual(report.run_status, "INTERRUPTED")
        self.assertEqual(repository.finalized, ["INTERRUPTED"])
        self.assertEqual([item.outcome for item in report.providers], ["NOT_STARTED"] * 2)
        self.assertEqual(publication.sources, [])
        self.assertEqual(metadata.query_requests, [])

    def test_cancellation_between_source_publications_does_not_publish_remaining_source(
        self,
    ) -> None:
        seed = _literature(150)
        details = {
            seed.literature_id: _detail(
                seed,
                (_observation(150, seed, provider="alpha", record_id="source-seed"),),
            )
        }
        relations: dict[ObservationId, ProviderRelationObservation] = {}
        literature = _Literature(details=details, relations=relations)
        event = _Event()
        publication = _Publication(
            event=event,
            cancel_after_sources=1,
        )
        operation, repository, _, _ = self._operation(
            literature=literature,
            candidate_reader=_CandidateReader(details, relations),
            publication=publication,
            event=event,
        )

        report = operation(
            self._request(
                (seed.literature_id,),
                max_depth=0,
                providers=(
                    ProviderDiscoveryLimit(provider_name="alpha", scan_limit=2),
                    ProviderDiscoveryLimit(provider_name="beta", scan_limit=2),
                ),
            )
        )

        self.assertEqual(report.run_status, "INTERRUPTED")
        self.assertEqual(repository.finalized, ["INTERRUPTED"])
        self.assertEqual([item.provider_name for item in publication.sources], ["alpha"])
        self.assertEqual(
            [item.outcome for item in report.providers],
            ["EXHAUSTED", "NOT_STARTED"],
        )

    def test_missing_exact_relation_is_local_failed_report_not_provider_failure(self) -> None:
        seed = _literature(16)
        seed_observation = _observation(16, seed, provider="provider", record_id="missing-seed")
        relation = _relation(
            10,
            provider="provider",
            citing_record_id="missing-seed",
            cited_record_id="missing-target",
        )
        details = {seed.literature_id: _detail(seed, (seed_observation,))}
        relations = {relation.observation_id: relation}
        literature = _Literature(
            details=details,
            relations=relations,
            omit_relation_ids={relation.observation_id},
        )
        operation, repository, metadata, publication = self._operation(
            literature=literature,
            candidate_reader=_CandidateReader(details, relations),
        )

        report = operation(self._request((seed.literature_id,)))

        self.assertEqual(report.end.kind, "failed")
        self.assertEqual(report.run_status, "FAILED")
        self.assertEqual(repository.finalized, ["FAILED"])
        self.assertEqual(report.providers[0].outcome, "NOT_STARTED")
        self.assertEqual(publication.sources, [])
        self.assertEqual(metadata.query_requests, [])
        self.assertEqual(literature.reference_calls, [])

    def test_relation_publication_error_is_not_fabricated_as_provider_failure(self) -> None:
        seed = _literature(17)
        seed_observation = _observation(17, seed, provider="provider", record_id="publication-seed")
        relation = _relation(
            11,
            provider="provider",
            citing_record_id="publication-seed",
            cited_record_id="publication-target",
        )
        details = {seed.literature_id: _detail(seed, (seed_observation,))}
        relations: dict[ObservationId, ProviderRelationObservation] = {}
        literature = _Literature(details=details, relations=relations)
        metadata = _Metadata(query_results=[_provider_result("provider", relations=(relation,))])
        publication = _Publication()
        operation, repository, _, _ = self._operation(
            literature=literature,
            candidate_reader=_CandidateReader(details, relations),
            metadata=metadata,
            relation_publication=_RelationPublication(relations, fail=True),
            publication=publication,
        )

        report = operation(self._request((seed.literature_id,)))

        self.assertEqual(report.end.kind, "failed")
        self.assertEqual(report.run_status, "FAILED")
        self.assertEqual(repository.finalized, ["FAILED"])
        self.assertEqual(report.providers[0].outcome, "INTERRUPTED")
        self.assertIsNone(report.providers[0].failure)
        self.assertEqual(publication.sources, [])


if __name__ == "__main__":
    unittest.main()
