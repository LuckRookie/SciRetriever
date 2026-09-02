from __future__ import annotations

import logging
import unittest
from collections.abc import Callable, Iterable
from contextlib import AbstractContextManager
from pathlib import Path
from tempfile import TemporaryDirectory

from sciretriever.entry.discovery import TopicDiscoveryOperation
from sciretriever.entry.ports import WriteAdmissionFailure
from sciretriever.literature.api import LiteratureApi, ObservationAcceptanceResult
from sciretriever.literature.metadata import MetadataProjectionDecision
from sciretriever.literature.service import LiteratureService
from sciretriever.metadata.api import (
    MAX_PROVIDER_RELATION_PUBLICATION_BATCH,
    MetadataApi,
    MetadataProviderInvocation,
    MetadataProviderResult,
    MetadataPublication,
)
from sciretriever.model.discovery import (
    DiscoveryCause,
    DiscoveryResult,
    DiscoveryRun,
    DiscoverySourceResult,
    ProviderDiscoveryLimit,
    TopicDiscoveryCause,
    TopicDiscoveryInput,
)
from sciretriever.model.literature import (
    Identifier,
    Literature,
    LiteratureStatus,
    MetaLiterature,
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
from sciretriever.storage.sqlite.literature_preconditions import LiteraturePreconditionReader
from sciretriever.storage.sqlite.literature_writer import LiteratureWriter

_TIME = UtcTimestamp("2026-08-12T12:00:00Z")
_HASH = Sha256("a" * 64)


def _uuid(index: int) -> str:
    return f"{index:08x}-0000-4000-8000-{index:012x}"


def _failure() -> StableFailure:
    return StableFailure(
        code="offline-provider-failed",
        reason="The offline provider fixture failed.",
        action="Retry the offline fixture.",
        retryable=True,
    )


def _observation(
    index: int,
    provider: str,
    doi: str,
    *,
    version_links: tuple[ProviderLiteratureKey, ...] = (),
) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_uuid(100 + index)),
        provenance=Provenance(
            provenance_id=ProvenanceId(_uuid(200 + index)),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=provider,
            source_record_id=f"record-{index}",
            observed_at=_TIME,
            input_sha256=_HASH,
            parameters_sha256=None,
        ),
        metadata=LiteratureMetadata(
            title=f"Fixture {index}",
            identifiers=(Identifier(namespace="doi", value=doi),),
        ),
        version_links=version_links,
    )


def _relation(index: int, provider: str) -> ProviderRelationObservation:
    observation = _observation(index, provider, f"10.1000/relation-{index}")
    return ProviderRelationObservation(
        observation_id=observation.observation_id,
        provenance=observation.provenance,
        citing=ProviderLiteratureKey(record_id=f"source-{index}"),
        cited=ProviderLiteratureKey(record_id=f"target-{index}"),
    )


def _provider(
    name: str,
    *,
    observations: tuple[MetadataObservation, ...] = (),
    relations: tuple[ProviderRelationObservation, ...] = (),
    raw: int = 0,
    outcome: str = "EXHAUSTED",
) -> MetadataProviderResult:
    return MetadataProviderResult(
        provider_name=name,
        observations=observations,
        relations=relations,
        raw_item_count=raw,
        outcome=outcome,  # type: ignore[arg-type]
        failure=_failure() if outcome == "FAILED" else None,
    )


class _Lease(AbstractContextManager[None]):
    def __init__(
        self,
        events: list[str],
        failure: BaseException | None = None,
    ) -> None:
        self.events = events
        self.failure = failure

    def __enter__(self) -> None:
        self.events.append("admission")
        if self.failure is not None:
            raise self.failure

    def __exit__(self, *_args: object) -> None:
        self.events.append("release")


class _Admission:
    def __init__(
        self,
        events: list[str],
        failure: BaseException | None = None,
    ) -> None:
        self.events = events
        self.failure = failure

    def acquire_nowait(self) -> AbstractContextManager[None]:
        return _Lease(self.events, self.failure)


class _Recovery:
    def __init__(self, events: list[str]) -> None:
        self.events = events

    def interrupt_visible_running(self) -> tuple[DiscoveryRunId, ...]:
        self.events.append("recovery")
        return ()


class _Clock:
    def now(self) -> UtcTimestamp:
        return _TIME


class _LiteratureIds:
    def __init__(self) -> None:
        self.next_value = 80_000

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


class _Repository:
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.runs: list[DiscoveryRun] = []
        self.finalized: list[str] = []

    def create(self, run: DiscoveryRun) -> None:
        self.events.append("create")
        self.runs.append(run)

    def finalize(self, discovery_run_id: DiscoveryRunId, status: str) -> DiscoveryRun:
        self.finalized.append(status)
        run = next(item for item in self.runs if item.discovery_run_id == discovery_run_id)
        return run.model_copy(update={"status": status})


class _DiscoveryPublication:
    def __init__(self, *, fail_cause: bool = False) -> None:
        self.sources: list[DiscoverySourceResult] = []
        self.results: list[tuple[DiscoveryResult, TopicDiscoveryCause]] = []
        self.fail_cause = fail_cause

    def publish_source_result(self, result: DiscoverySourceResult) -> None:
        self.sources.append(result)

    def publish_result_and_cause(
        self,
        result: DiscoveryResult,
        cause: DiscoveryCause,
    ) -> None:
        if self.fail_cause:
            raise RuntimeError("private publication diagnostic")
        if not isinstance(cause, TopicDiscoveryCause):
            raise TypeError("topic fixture requires a TopicDiscoveryCause")
        self.results.append((result, cause))


class _RelationPublication:
    def __init__(
        self,
        *,
        after_batch: Callable[[int], None] | None = None,
    ) -> None:
        self.batches: list[tuple[ProviderRelationObservation, ...]] = []
        self._after_batch = after_batch

    @property
    def relations(self) -> list[ProviderRelationObservation]:
        return [relation for batch in self.batches for relation in batch]

    def publish_provider_relation_observations(
        self,
        observations: tuple[ProviderRelationObservation, ...],
    ) -> None:
        self.batches.append(observations)
        if self._after_batch is not None:
            self._after_batch(len(self.batches))


class _Literature(LiteratureApi):
    def __init__(self, *, deduplicate_replays: bool = False) -> None:
        self.by_doi: dict[str, tuple[Literature, MetaLiterature]] = {}
        self.calls: list[MetadataObservation] = []
        self.observation_ids: set[ObservationId] = set()
        self.deduplicate_replays = deduplicate_replays

    def accept_observation(
        self,
        observation: MetadataObservation,
        *,
        provider_precedence: Iterable[str] = (),
    ) -> ObservationAcceptanceResult:
        del provider_precedence
        self.calls.append(observation)
        replay = observation.observation_id in self.observation_ids
        self.observation_ids.add(observation.observation_id)
        doi = next(
            item.value for item in observation.metadata.identifiers if item.namespace == "doi"
        )
        existing = self.by_doi.get(doi)
        created = existing is None
        if existing is None:
            index = len(self.by_doi) + 1
            literature = Literature(
                literature_id=LiteratureId(_uuid(300 + index)),
                meta_literature_id=MetaLiteratureId(_uuid(400 + index)),
                version_role=VersionRole.OTHER,
                metadata=observation.metadata,
                status=LiteratureStatus.UNREVIEWED,
            )
            meta = MetaLiterature(
                meta_literature_id=literature.meta_literature_id,
                representative_literature_id=literature.literature_id,
            )
            self.by_doi[doi] = (literature, meta)
        else:
            literature, meta = existing
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
            deduplicated=replay and self.deduplicate_replays,
            meta_literature_created=created,
        )


class _VersionLinkedLiterature(_Literature):
    """Admit a linked second concrete version into the first observation's Meta."""

    def accept_observation(
        self,
        observation: MetadataObservation,
        *,
        provider_precedence: Iterable[str] = (),
    ) -> ObservationAcceptanceResult:
        if not observation.version_links:
            return super().accept_observation(
                observation,
                provider_precedence=provider_precedence,
            )
        del provider_precedence
        self.calls.append(observation)
        self.observation_ids.add(observation.observation_id)
        if len(self.by_doi) != 1:
            raise RuntimeError("linked-version fixture requires one existing identity")
        _, meta = next(iter(self.by_doi.values()))
        literature = Literature(
            literature_id=LiteratureId(_uuid(302)),
            meta_literature_id=meta.meta_literature_id,
            version_role=VersionRole.OTHER,
            metadata=observation.metadata,
            status=LiteratureStatus.UNREVIEWED,
        )
        doi = next(
            item.value for item in observation.metadata.identifiers if item.namespace == "doi"
        )
        self.by_doi[doi] = (literature, meta)
        return ObservationAcceptanceResult(
            decision="created",
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
            meta_literature_created=False,
        )


class _RejectingLiterature(_Literature):
    def __init__(self, reason: str) -> None:
        super().__init__()
        self.reason = reason

    def accept_observation(
        self,
        observation: MetadataObservation,
        *,
        provider_precedence: Iterable[str] = (),
    ) -> ObservationAcceptanceResult:
        del provider_precedence
        self.calls.append(observation)
        return ObservationAcceptanceResult(decision="rejected", reason=self.reason)


class _Metadata(MetadataApi):
    def __init__(self, invocations: list[MetadataProviderInvocation]) -> None:
        self.invocations = invocations
        self.calls: list[TopicDiscoveryInput] = []

    def search_topic_provider(
        self,
        request: TopicDiscoveryInput,
        *,
        cancel_event: object | None = None,
    ) -> MetadataProviderInvocation:
        del cancel_event
        self.calls.append(request)
        return self.invocations.pop(0)


class _RaisingMetadata(_Metadata):
    def search_topic_provider(
        self,
        request: TopicDiscoveryInput,
        *,
        cancel_event: object | None = None,
    ) -> MetadataProviderInvocation:
        del cancel_event
        self.calls.append(request)
        raise RuntimeError("private provider exception with token=SECRET")


class _Event:
    def __init__(self, value: bool = False) -> None:
        self.value = value

    def is_set(self) -> bool:
        return self.value


class TopicDiscoveryTests(unittest.TestCase):
    def _operation(
        self,
        invocations: list[MetadataProviderInvocation],
        *,
        event: _Event | None = None,
        publication: _DiscoveryPublication | None = None,
        literature: _Literature | None = None,
        metadata: _Metadata | None = None,
        relation_publication: _RelationPublication | None = None,
        admission_failure: BaseException | None = None,
    ) -> tuple[
        TopicDiscoveryOperation,
        _Repository,
        _Metadata,
        _Literature,
        _DiscoveryPublication,
        _RelationPublication,
        list[str],
    ]:
        events: list[str] = []
        repository = _Repository(events)
        metadata = metadata or _Metadata(invocations)
        literature = literature or _Literature()
        relations = relation_publication or _RelationPublication()
        discovery = publication or _DiscoveryPublication()
        operation = TopicDiscoveryOperation(
            metadata=metadata,
            metadata_publication=MetadataPublication(literature, relations),
            repository=repository,
            publication=discovery,
            clock=_Clock(),
            write_admission=_Admission(events, admission_failure),
            recovery=_Recovery(events),
            run_id_factory=lambda: DiscoveryRunId(_uuid(1 + len(repository.runs))),
            cancel_event=event,
        )
        return operation, repository, metadata, literature, discovery, relations, events

    def test_write_admission_failure_returns_stable_report_without_creating_run(self) -> None:
        failure = StableFailure(
            code="write-admission-failed",
            reason="The local write boundary was unavailable.",
            action="Retry the operation.",
            retryable=True,
        )
        operation, repository, metadata, _, _, _, events = self._operation(
            [],
            admission_failure=WriteAdmissionFailure(failure),
        )

        report = operation(
            TopicDiscoveryInput(
                kind="topic",
                query="admission failure",
                providers=(ProviderDiscoveryLimit(provider_name="alpha", scan_limit=1),),
            )
        )

        end = report.end
        self.assertEqual(end.kind, "failed")
        if not isinstance(end, FailedReportEnd):
            self.fail("expected a failed Report end")
        self.assertEqual(end.failure, failure)
        self.assertEqual(report.run_status, "FAILED")
        self.assertEqual(report.providers[0].outcome, "NOT_STARTED")
        self.assertEqual(repository.runs, [])
        self.assertEqual(metadata.calls, [])
        self.assertEqual(events, ["admission"])

    def test_happy_multi_source_retains_observations_relations_and_deduplicates_result(
        self,
    ) -> None:
        first = _observation(1, "alpha", "10.1000/shared")
        second = _observation(2, "beta", "10.1000/shared")
        relation = _relation(3, "beta")
        operation, repository, metadata, literature, discovery, relations, events = self._operation(
            [
                MetadataProviderInvocation.model_validate(
                    _provider("alpha", observations=(first,), raw=3).model_dump()
                ),
                MetadataProviderInvocation.model_validate(
                    _provider(
                        "beta",
                        observations=(second,),
                        relations=(relation,),
                        raw=2,
                        outcome="SCAN_LIMIT_REACHED",
                    ).model_dump()
                ),
            ]
        )
        request = TopicDiscoveryInput(
            kind="topic",
            query="offline topic",
            providers=(
                ProviderDiscoveryLimit(provider_name="alpha", scan_limit=5),
                ProviderDiscoveryLimit(provider_name="beta", scan_limit=2),
            ),
        )

        with self.assertLogs("sciretriever.entry.discovery", level="DEBUG") as captured:
            report = operation(request)

        self.assertEqual(events[:3], ["admission", "recovery", "create"])
        self.assertEqual(repository.finalized, ["COMPLETED"])
        self.assertEqual(report.run_status, "COMPLETED")
        self.assertEqual(report.discovery_result_count, 1)
        self.assertEqual(report.new_meta_literature_count, 1)
        self.assertEqual(report.new_literature_count, 1)
        self.assertEqual(report.new_metadata_observation_count, 2)
        self.assertEqual([item.raw_item_count for item in report.providers], [3, 2])
        self.assertEqual([item.accepted_observation_count for item in report.providers], [1, 1])
        self.assertEqual(len(literature.calls), 2)
        self.assertEqual(len(discovery.results), 2)
        self.assertEqual(relations.relations, [relation])
        self.assertEqual(relations.batches, [(relation,)])
        self.assertEqual(
            [tuple(item.providers) for item in metadata.calls],
            [(request.providers[0],), (request.providers[1],)],
        )
        output = "\n".join(captured.output)
        self.assertIn("event=discovery-observation-accepted", output)
        self.assertIn("event=discovery-relation-batch-published", output)
        self.assertRegex(
            output,
            r"event=discovery-relation-batch-published .*provider=beta .*batch=1 "
            r".*relation_count=1 .*published_total=1 .*elapsed_ms=\d+",
        )
        self.assertIn("event=discovery-finished", output)
        self.assertRegex(output, r"event=discovery-finished .*elapsed_ms=\d+")
        final = next(
            record
            for record in captured.records
            if "event=discovery-finished" in record.getMessage()
        )
        self.assertEqual(final.levelno, logging.INFO)
        self.assertIn("outcome=completed", final.getMessage())

    def test_rejected_observation_debug_log_includes_stable_decision_reason(self) -> None:
        reason = "metadata-title-or-doi-required"
        observation = _observation(8, "provider", "10.1000/rejected")
        rejecting = _RejectingLiterature(reason)
        operation, repository, _, literature, discovery, relations, _ = self._operation(
            [
                MetadataProviderInvocation(
                    provider_name="provider",
                    observations=(observation,),
                    relations=(),
                    raw_item_count=1,
                    outcome="EXHAUSTED",
                )
            ],
            literature=rejecting,
        )

        with self.assertLogs("sciretriever.entry.discovery", level="DEBUG") as captured:
            report = operation(
                TopicDiscoveryInput(
                    kind="topic",
                    query="rejected observation",
                    providers=(ProviderDiscoveryLimit(provider_name="provider", scan_limit=1),),
                )
            )

        self.assertEqual(repository.finalized, ["COMPLETED"])
        self.assertEqual(report.discovery_result_count, 0)
        self.assertEqual(report.new_metadata_observation_count, 0)
        self.assertEqual(report.providers[0].accepted_observation_count, 0)
        self.assertEqual(literature.calls, [observation])
        self.assertEqual(discovery.results, [])
        self.assertEqual(relations.relations, [])
        output = "\n".join(captured.output)
        self.assertIn("event=discovery-observation-rejected", output)
        self.assertIn(f"decision_reason={reason}", output)
        self.assertNotIn(observation.metadata.title or "private-title", output)

    def test_partial_and_all_failed_have_correct_terminal_status(self) -> None:
        for outcomes, expected in (
            (["FAILED", "EXHAUSTED"], "PARTIAL"),
            (["FAILED", "FAILED"], "FAILED"),
        ):
            with self.subTest(outcomes=outcomes):
                operation, repository, *_ = self._operation(
                    [
                        MetadataProviderInvocation.model_validate(
                            _provider(name, outcome=outcome).model_dump()
                        )
                        for name, outcome in zip(("a", "b"), outcomes, strict=True)
                    ]
                )
                with self.assertLogs("sciretriever.entry.discovery", level="INFO") as captured:
                    report = operation(
                        TopicDiscoveryInput(
                            kind="topic",
                            query="q",
                            providers=(
                                ProviderDiscoveryLimit(provider_name="a", scan_limit=1),
                                ProviderDiscoveryLimit(provider_name="b", scan_limit=1),
                            ),
                        )
                    )
                self.assertEqual(report.run_status, expected)
                self.assertEqual(repository.finalized, [expected])
                final = next(
                    record
                    for record in captured.records
                    if "event=discovery-finished" in record.getMessage()
                )
                self.assertEqual(final.levelno, logging.WARNING)
                self.assertIn("outcome=action-required", final.getMessage())

    def test_interrupted_invocation_commits_returned_facts_without_source_result(self) -> None:
        observation = _observation(9, "a", "10.1000/interrupted")
        relations_returned = tuple(_relation(index, "a") for index in range(10, 610))
        event = _Event(True)
        operation, repository, metadata, literature, discovery, relations, _ = self._operation(
            [
                MetadataProviderInvocation(
                    provider_name="a",
                    observations=(observation,),
                    relations=relations_returned,
                    raw_item_count=4,
                    outcome="INTERRUPTED",
                )
            ],
            event=event,
        )
        # The facade already started before the event became visible to Entry.
        event.value = False
        original = metadata.search_topic_provider

        def call_and_cancel(*args: object, **kwargs: object) -> MetadataProviderInvocation:
            result = original(*args, **kwargs)  # type: ignore[arg-type]
            event.value = True
            return result

        metadata.search_topic_provider = call_and_cancel  # type: ignore[method-assign]
        report = operation(
            TopicDiscoveryInput(
                kind="topic",
                query="q",
                providers=(
                    ProviderDiscoveryLimit(provider_name="a", scan_limit=9),
                    ProviderDiscoveryLimit(provider_name="b", scan_limit=9),
                ),
            )
        )
        self.assertEqual(repository.finalized, ["INTERRUPTED"])
        self.assertEqual(report.run_status, "INTERRUPTED")
        self.assertEqual(
            [item.outcome for item in report.providers], ["INTERRUPTED", "NOT_STARTED"]
        )
        self.assertEqual(len(literature.calls), 1)
        self.assertEqual(relations.relations, list(relations_returned))
        self.assertEqual(
            [len(batch) for batch in relations.batches],
            [MAX_PROVIDER_RELATION_PUBLICATION_BATCH] * 2 + [88],
        )
        self.assertEqual(discovery.sources, [])
        self.assertEqual(len(discovery.results), 1)

    def test_relations_are_published_in_ordered_bounded_batches(self) -> None:
        returned = tuple(_relation(index, "a") for index in range(1, 602))
        operation, repository, _, _, discovery, relations, _ = self._operation(
            [
                MetadataProviderInvocation(
                    provider_name="a",
                    observations=(),
                    relations=returned,
                    raw_item_count=601,
                    outcome="SCAN_LIMIT_REACHED",
                )
            ]
        )

        report = operation(
            TopicDiscoveryInput(
                kind="topic",
                query="q",
                providers=(ProviderDiscoveryLimit(provider_name="a", scan_limit=601),),
            )
        )

        self.assertEqual(report.run_status, "COMPLETED")
        self.assertEqual(repository.finalized, ["COMPLETED"])
        self.assertEqual(discovery.sources[0].outcome, "SCAN_LIMIT_REACHED")
        self.assertEqual([len(batch) for batch in relations.batches], [256, 256, 89])
        self.assertEqual(relations.relations, list(returned))

    def test_report_counts_51_accepted_observations_from_100_raw_items(self) -> None:
        observations = tuple(
            _observation(index, "datacite", f"10.5555/disposition-{index:03d}")
            for index in range(1, 52)
        )
        operation, repository, _, _, _, _, _ = self._operation(
            [
                MetadataProviderInvocation(
                    provider_name="datacite",
                    observations=observations,
                    relations=(),
                    raw_item_count=100,
                    outcome="SCAN_LIMIT_REACHED",
                )
            ]
        )

        report = operation(
            TopicDiscoveryInput(
                kind="topic",
                query="battery materials",
                providers=(ProviderDiscoveryLimit(provider_name="datacite", scan_limit=100),),
            )
        )

        self.assertEqual(repository.finalized, ["COMPLETED"])
        self.assertEqual(report.run_status, "COMPLETED")
        self.assertEqual(report.discovery_result_count, 51)
        self.assertEqual(report.providers[0].raw_item_count, 100)
        self.assertEqual(report.providers[0].accepted_observation_count, 51)

    def test_cancellation_between_relation_batches_keeps_prior_batch_only(self) -> None:
        event = _Event(False)

        def cancel_after_first(batch_count: int) -> None:
            if batch_count == 1:
                event.value = True

        relation_publication = _RelationPublication(after_batch=cancel_after_first)
        returned = tuple(_relation(index, "a") for index in range(1, 602))
        operation, repository, _, _, discovery, relations, _ = self._operation(
            [
                MetadataProviderInvocation(
                    provider_name="a",
                    observations=(),
                    relations=returned,
                    raw_item_count=601,
                    outcome="SCAN_LIMIT_REACHED",
                )
            ],
            event=event,
            relation_publication=relation_publication,
        )

        report = operation(
            TopicDiscoveryInput(
                kind="topic",
                query="q",
                providers=(ProviderDiscoveryLimit(provider_name="a", scan_limit=601),),
            )
        )

        self.assertEqual(report.run_status, "INTERRUPTED")
        self.assertEqual(repository.finalized, ["INTERRUPTED"])
        self.assertEqual(discovery.sources, [])
        self.assertEqual([len(batch) for batch in relations.batches], [256])
        self.assertEqual(relations.relations, list(returned[:256]))

    def test_real_literature_admission_supplies_meta_creation_count(self) -> None:
        observation = _observation(11, "provider", "10.1000/real-topic")
        with TemporaryDirectory(prefix="sciretriever-topic-real-literature-") as temporary:
            root = Path(temporary)
            engine = CatalogEngine(root / "catalog.sqlite")
            writer = LiteratureWriter(engine)
            storage_root = StorageRoot(root / "artifacts")
            verified = VerifiedReader(storage_root)
            literature = LiteratureApi(
                LiteratureService(
                    read_port=LiteraturePreconditionReader(
                        engine,
                        verified,
                    ),
                    identity_port=writer,
                    content_port=SqliteContentPublication(
                        engine,
                        ArtifactStore(storage_root),
                        verified,
                    ),
                    reference_port=writer,
                    maintenance_port=writer,
                    id_factory=_LiteratureIds(),
                )
            )
            operation, repository, _, _, discovery, relations, _ = self._operation(
                [
                    MetadataProviderInvocation(
                        provider_name="provider",
                        observations=(observation,),
                        relations=(),
                        raw_item_count=1,
                        outcome="EXHAUSTED",
                    )
                ],
                literature=literature,  # type: ignore[arg-type]
            )

            report = operation(
                TopicDiscoveryInput(
                    kind="topic",
                    query="real Literature admission",
                    providers=(ProviderDiscoveryLimit(provider_name="provider", scan_limit=1),),
                )
            )

            self.assertEqual(repository.finalized, ["COMPLETED"])
            self.assertEqual(report.new_meta_literature_count, 1)
            self.assertEqual(report.new_literature_count, 1)
            self.assertEqual(report.new_metadata_observation_count, 1)
            self.assertEqual(report.providers[0].accepted_observation_count, 1)
            self.assertEqual(len(discovery.results), 1)
            self.assertEqual(len(discovery.sources), 1)
            self.assertEqual(relations.relations, [])
            with engine.read_snapshot() as connection:
                self.assertEqual(
                    connection.execute("SELECT count(*) FROM literatures").fetchone(), (1,)
                )
                self.assertEqual(
                    connection.execute("SELECT count(*) FROM meta_literatures").fetchone(),
                    (1,),
                )
                self.assertEqual(
                    connection.execute("SELECT count(*) FROM metadata_observations").fetchone(),
                    (1,),
                )

    def test_publication_failure_finalizes_the_run_as_failed(self) -> None:
        operation, repository, *_ = self._operation(
            [
                MetadataProviderInvocation.model_validate(
                    _provider(
                        "a",
                        observations=(_observation(20, "a", "10.1000/fail"),),
                        raw=1,
                    ).model_dump()
                )
            ],
            publication=_DiscoveryPublication(fail_cause=True),
        )
        report = operation(
            TopicDiscoveryInput(
                kind="topic",
                query="q",
                providers=(ProviderDiscoveryLimit(provider_name="a", scan_limit=1),),
            )
        )
        self.assertEqual(repository.finalized, ["FAILED"])
        self.assertEqual(report.run_status, "FAILED")
        self.assertEqual(report.end.kind, "failed")

    def test_zero_results_complete_and_repeating_request_creates_new_run(self) -> None:
        operation, repository, *_ = self._operation(
            [
                MetadataProviderInvocation.model_validate(_provider("a").model_dump()),
                MetadataProviderInvocation.model_validate(_provider("a").model_dump()),
            ]
        )
        request = TopicDiscoveryInput(
            kind="topic",
            query="q",
            providers=(ProviderDiscoveryLimit(provider_name="a", scan_limit=1),),
        )
        first = operation(request)
        second = operation(request)
        self.assertNotEqual(first.discovery_run_id, second.discovery_run_id)
        self.assertEqual(repository.finalized, ["COMPLETED", "COMPLETED"])
        self.assertEqual(first.discovery_result_count, 0)
        self.assertEqual(first.providers[0].raw_item_count, 0)

    def test_failed_provider_retains_accepted_observation_and_accurate_raw_count(self) -> None:
        observation = _observation(30, "a", "10.1000/partial")
        operation, repository, _, literature, discovery, _, _ = self._operation(
            [
                MetadataProviderInvocation.model_validate(
                    _provider(
                        "a",
                        observations=(observation,),
                        raw=7,
                        outcome="FAILED",
                    ).model_dump()
                )
            ]
        )
        report = operation(
            TopicDiscoveryInput(
                kind="topic",
                query="q",
                providers=(ProviderDiscoveryLimit(provider_name="a", scan_limit=10),),
            )
        )
        self.assertEqual(repository.finalized, ["FAILED"])
        self.assertEqual(len(literature.calls), 1)
        self.assertEqual(len(discovery.results), 1)
        self.assertEqual(discovery.sources[0].outcome, "FAILED")
        self.assertEqual(report.providers[0].raw_item_count, 7)
        self.assertEqual(report.providers[0].accepted_observation_count, 1)

    def test_cancellation_before_first_provider_creates_no_run_or_external_call(self) -> None:
        event = _Event(True)
        operation, repository, metadata, *_ = self._operation([], event=event)
        request = TopicDiscoveryInput(
            kind="topic",
            query="q",
            providers=(ProviderDiscoveryLimit(provider_name="a", scan_limit=1),),
        )
        report = operation(request)
        self.assertEqual(len(repository.runs), 1)
        self.assertEqual(repository.finalized, ["INTERRUPTED"])
        self.assertEqual(metadata.calls, [])
        self.assertEqual(report.providers[0].outcome, "NOT_STARTED")

    def test_provider_exception_is_redacted_and_marks_started_provider_interrupted(self) -> None:
        metadata = _RaisingMetadata([])
        operation, repository, _, _, discovery, _, _ = self._operation(
            [],
            metadata=metadata,
        )
        report = operation(
            TopicDiscoveryInput(
                kind="topic",
                query="q",
                providers=(ProviderDiscoveryLimit(provider_name="a", scan_limit=1),),
            )
        )
        self.assertEqual(repository.finalized, ["FAILED"])
        self.assertEqual(report.run_status, "FAILED")
        self.assertEqual(report.providers[0].outcome, "INTERRUPTED")
        self.assertEqual(discovery.sources, [])
        self.assertNotIn("SECRET", report.model_dump_json())

    def test_exact_replay_adds_cause_but_not_new_observation_count(self) -> None:
        observation = _observation(40, "a", "10.1000/replay")
        literature = _Literature(deduplicate_replays=True)
        operation, _, _, _, discovery, _, _ = self._operation(
            [
                MetadataProviderInvocation.model_validate(
                    _provider("a", observations=(observation,), raw=1).model_dump()
                ),
                MetadataProviderInvocation.model_validate(
                    _provider("a", observations=(observation,), raw=1).model_dump()
                ),
            ],
            literature=literature,
        )
        request = TopicDiscoveryInput(
            kind="topic",
            query="q",
            providers=(ProviderDiscoveryLimit(provider_name="a", scan_limit=1),),
        )
        first = operation(request)
        second = operation(request)
        self.assertEqual(first.new_metadata_observation_count, 1)
        self.assertEqual(second.new_metadata_observation_count, 0)
        self.assertEqual(second.discovery_result_count, 1)
        self.assertEqual(len(discovery.results), 2)

    def test_linked_new_version_counts_one_meta_and_two_concrete_literatures(self) -> None:
        first = _observation(41, "a", "10.1000/preprint")
        linked = _observation(
            42,
            "a",
            "10.1000/article",
            version_links=(ProviderLiteratureKey(record_id="record-41"),),
        )
        literature = _VersionLinkedLiterature()
        operation, _, _, _, discovery, _, _ = self._operation(
            [
                MetadataProviderInvocation.model_validate(
                    _provider("a", observations=(first, linked), raw=2).model_dump()
                )
            ],
            literature=literature,
        )

        report = operation(
            TopicDiscoveryInput(
                kind="topic",
                query="q",
                providers=(ProviderDiscoveryLimit(provider_name="a", scan_limit=2),),
            )
        )

        self.assertEqual(report.discovery_result_count, 1)
        self.assertEqual(report.new_meta_literature_count, 1)
        self.assertEqual(report.new_literature_count, 2)
        self.assertEqual(report.new_metadata_observation_count, 2)
        self.assertEqual(report.providers[0].accepted_observation_count, 2)
        self.assertEqual(len(discovery.results), 2)


if __name__ == "__main__":
    unittest.main()
