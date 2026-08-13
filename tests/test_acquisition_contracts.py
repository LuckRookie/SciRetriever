from __future__ import annotations

import inspect
import pickle
import unittest
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from io import BytesIO
from typing import BinaryIO

import sciretriever.acquisition.api as acquisition_api
import sciretriever.acquisition.ports as acquisition_ports
from sciretriever.acquisition.api import AcquisitionApi, PreparedAcquisition
from sciretriever.acquisition.ports import (
    AcquisitionExhaustionClearPort,
    AcquisitionExhaustionPublicationCommand,
    AcquisitionExhaustionPublicationPort,
    AcquisitionExpectedFacts,
    AcquisitionFailure,
    AcquisitionRequest,
    CandidateKeyTracker,
    PdfSourceBinding,
    PrimaryPdfPreparation,
    PrimaryPdfPreparationPort,
    SourceReadiness,
    TemporaryPdf,
)
from sciretriever.acquisition.routing import (
    AcquisitionEvidence,
    RoutingEvidenceKind,
    build_acquisition_evidence,
)
from sciretriever.acquisition.service import AcquisitionService
from sciretriever.literature.content import metadata_sha256
from sciretriever.model.acquisition import (
    AcquiredPrimaryPdf,
    AcquisitionPath,
    AcquisitionResult,
    Asset,
    AssetHint,
    AssetHintKind,
    AssetRole,
    AutomaticPdfAcquisitionExhaustion,
    LiteratureAsset,
    NoPrimaryPdf,
    PdfCandidate,
)
from sciretriever.model.literature import (
    Identifier,
    Literature,
    LiteratureStatus,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.primitives import (
    AssetId,
    LiteratureAssetId,
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    RelativeArtifactPath,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure

_TIME = UtcTimestamp("2026-08-11T12:00:00Z")
_HASH = Sha256("a" * 64)


def _id(index: int) -> str:
    return f"{index:08x}-e89b-12d3-a456-426614174000"


def _stable_failure(code: str) -> StableFailure:
    return StableFailure(
        code=code,
        reason="The acquisition operation could not complete.",
        action="Check the local configuration and retry.",
        retryable=True,
    )


def _provenance(
    index: int,
    *,
    source_name: str,
    source_kind: SourceKind = SourceKind.ASSET_PROVIDER,
    source_record_id: str | None = None,
) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(_id(index)),
        source_kind=source_kind,
        source_name=source_name,
        source_record_id=source_record_id,
        observed_at=_TIME,
        input_sha256=_HASH,
        parameters_sha256=None,
    )


def _literature(
    *,
    publisher: str | None = None,
    identifiers: tuple[Identifier, ...] = (),
) -> Literature:
    return Literature(
        literature_id=LiteratureId(_id(1)),
        meta_literature_id=MetaLiteratureId(_id(2)),
        version_role=VersionRole.PUBLISHED,
        metadata=LiteratureMetadata(
            title="A concrete paper",
            publisher=publisher,
            identifiers=identifiers,
        ),
        status=LiteratureStatus.UNREVIEWED,
    )


def _observation(
    index: int,
    *,
    provider_name: str,
    record_id: str,
    asset_hints: tuple[AssetHint, ...] = (),
) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_id(index)),
        provenance=_provenance(
            index + 100,
            source_name=provider_name,
            source_kind=SourceKind.METADATA_PROVIDER,
            source_record_id=record_id,
        ),
        metadata=LiteratureMetadata(title="A source observation"),
        asset_hints=asset_hints,
    )


class _Content:
    def __init__(self, payload: bytes = b"%PDF-fixture") -> None:
        self._payload = payload
        self.discard_count = 0

    @contextmanager
    def open(self) -> Iterator[BinaryIO]:
        stream = BytesIO(self._payload)
        try:
            yield stream
        finally:
            stream.close()

    def discard(self) -> None:
        self.discard_count += 1


def _temporary(
    index: int,
    *,
    key: str,
    source_name: str,
    path: AcquisitionPath,
) -> TemporaryPdf:
    return TemporaryPdf(
        candidate=PdfCandidate(
            candidate_key=key,
            source_name=source_name,
            acquisition_path=path,
            declared_media_type="application/pdf",
        ),
        content=_Content(),
        safe_source_url="https://content.example.invalid/article.pdf",
        provenance=_provenance(index + 200, source_name=source_name),
    )


def _discard_count(temporary_pdf: TemporaryPdf) -> int:
    content = temporary_pdf.content
    if not isinstance(content, _Content):
        raise AssertionError("test temporary content must use _Content")
    return content.discard_count


class _SourceItem:
    def __init__(self, key: str, temporary_pdf: TemporaryPdf | None) -> None:
        self.key = key
        self.temporary_pdf = temporary_pdf


class _SourceFake:
    def __init__(
        self,
        source_name: str,
        path: AcquisitionPath,
        *,
        events: list[str],
        items: tuple[_SourceItem, ...] = (),
        applicable: bool | Callable[[AcquisitionEvidence], bool] = True,
        failure: AcquisitionFailure | None = None,
    ) -> None:
        self.source_name = source_name
        self.acquisition_path = path
        self._events = events
        self._items = items
        self._applicable = applicable
        self._failure = failure
        self.close_count = 0

    def is_applicable(self, evidence: AcquisitionEvidence) -> bool:
        self._events.append(f"applicable:{self.source_name}")
        if callable(self._applicable):
            return self._applicable(evidence)
        return self._applicable

    def acquire(
        self,
        request: AcquisitionRequest,
        evidence: AcquisitionEvidence,
        candidate_keys: CandidateKeyTracker,
    ) -> Iterator[TemporaryPdf]:
        del request, evidence
        try:
            self._events.append(f"acquire:{self.source_name}")
            if self._failure is not None:
                raise self._failure
            for item in self._items:
                # ``claim`` is deliberately before the simulated I/O event.
                # The Source Port requires the same ordering for real access.
                if not candidate_keys.claim(item.key):
                    continue
                self._events.append(f"attempt:{self.source_name}:{item.key}")
                if item.temporary_pdf is not None:
                    yield item.temporary_pdf
        finally:
            self.close_count += 1


class _PreparedFake:
    def __init__(
        self,
        *,
        request: AcquisitionRequest,
        temporary_pdf: TemporaryPdf,
        events: list[str],
    ) -> None:
        self.request = request
        self.temporary_pdf = temporary_pdf
        self.events = events
        self.discard_count = 0

    def discard(self) -> None:
        self.discard_count += 1


class _PublicationFake(PrimaryPdfPreparationPort):
    def __init__(
        self,
        *,
        events: list[str],
        success_key: str | None = None,
        failure: AcquisitionFailure | None = None,
        after_prepare: Callable[[], None] | None = None,
    ) -> None:
        self._events = events
        self._success_key = success_key
        self._failure = failure
        self._after_prepare = after_prepare
        self.expected_facts: list[AcquisitionExpectedFacts] = []
        self.prepared_values: list[_PreparedFake] = []

    def prepare_primary_pdf(
        self,
        request: AcquisitionRequest,
        temporary_pdf: TemporaryPdf,
        *,
        cancel_event: object | None = None,
    ) -> PrimaryPdfPreparation | None:
        del cancel_event
        self.expected_facts.append(request.expected_facts)
        key = temporary_pdf.candidate.candidate_key
        self._events.append(f"prepare:{key}")
        if self._failure is not None:
            raise self._failure
        if key != self._success_key:
            return None
        prepared = _PreparedFake(
            request=request,
            temporary_pdf=temporary_pdf,
            events=self._events,
        )
        self.prepared_values.append(prepared)
        if self._after_prepare is not None:
            self._after_prepare()
        return prepared

    def commit_primary_pdf(self, prepared: PrimaryPdfPreparation) -> AcquiredPrimaryPdf:
        if not isinstance(prepared, _PreparedFake):
            raise AssertionError("unexpected prepared value")
        request = prepared.request
        temporary_pdf = prepared.temporary_pdf
        key = temporary_pdf.candidate.candidate_key
        self._events.append(f"publish:{key}")
        asset = Asset(
            asset_id=AssetId(_id(500)),
            sha256=_HASH,
            size_bytes=12,
            media_type="application/pdf",
            path=RelativeArtifactPath("assets/fixture.pdf"),
        )
        relation = LiteratureAsset(
            literature_asset_id=LiteratureAssetId(_id(501)),
            literature_id=request.literature.literature_id,
            asset_id=asset.asset_id,
            role=AssetRole.PRIMARY_PDF,
            provenance=temporary_pdf.provenance,
            source_url=temporary_pdf.safe_source_url,
        )
        return AcquiredPrimaryPdf(asset=asset, relation=relation, candidate_key=key)


class _ExhaustionFake(AcquisitionExhaustionPublicationPort):
    def __init__(
        self,
        *,
        events: list[str],
        failure: AcquisitionFailure | None = None,
    ) -> None:
        self._events = events
        self._failure = failure
        self.calls = 0
        self.commands: list[AcquisitionExhaustionPublicationCommand] = []

    def publish_exhaustion(
        self,
        command: AcquisitionExhaustionPublicationCommand,
    ) -> AutomaticPdfAcquisitionExhaustion:
        self.calls += 1
        self.commands.append(command)
        self._events.append("publish-exhaustion")
        if self._failure is not None:
            raise self._failure
        return AutomaticPdfAcquisitionExhaustion(literature_id=command.expected_facts.literature_id)


class _ExhaustionClearFake(AcquisitionExhaustionClearPort):
    def __init__(
        self,
        *,
        events: list[str],
        failure: AcquisitionFailure | None = None,
    ) -> None:
        self._events = events
        self._failure = failure
        self.expected_facts: list[AcquisitionExpectedFacts] = []

    def clear_exhaustion(self, expected_facts: AcquisitionExpectedFacts) -> None:
        self.expected_facts.append(expected_facts)
        self._events.append("clear-exhaustion")
        if self._failure is not None:
            raise self._failure


_READY = SourceReadiness(is_ready=True)


def _binding(
    source: _SourceFake | None,
    *,
    source_name: str | None = None,
    path: AcquisitionPath | None = None,
    enabled: bool = True,
    production: bool = True,
    readiness: SourceReadiness | None = _READY,
) -> PdfSourceBinding:
    if source is not None:
        source_name = source.source_name if source_name is None else source_name
        path = source.acquisition_path if path is None else path
    assert source_name is not None
    assert path is not None
    return PdfSourceBinding(
        source_name=source_name,
        acquisition_path=path,
        enabled=enabled,
        production=production,
        readiness=readiness,
        source=source,
    )


def _request(
    *,
    literature: Literature | None = None,
    observations: tuple[MetadataObservation, ...] = (),
    resolved_landing_origin: str | None = None,
    excluded_candidate_keys: frozenset[str] = frozenset(),
    current_assets: tuple[LiteratureAsset, ...] = (),
) -> AcquisitionRequest:
    target = _literature() if literature is None else literature
    return AcquisitionRequest(
        literature=target,
        expected_facts=AcquisitionExpectedFacts(
            literature_id=target.literature_id,
            meta_literature_id=target.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(target.metadata),
            expected_no_primary_pdf=True,
        ),
        observations=observations,
        current_assets=current_assets,
        resolved_landing_origin=resolved_landing_origin,
        excluded_candidate_keys=excluded_candidate_keys,
    )


def _api(
    bindings: tuple[PdfSourceBinding, ...],
    publication: PrimaryPdfPreparationPort,
    exhaustion: AcquisitionExhaustionPublicationPort,
    *,
    exhaustion_clear: AcquisitionExhaustionClearPort | None = None,
) -> AcquisitionApi:
    if exhaustion_clear is None:
        exhaustion_clear = _ExhaustionClearFake(events=[])
    return AcquisitionApi(
        AcquisitionService(
            source_bindings=bindings,
            publication_port=publication,
            exhaustion_port=exhaustion,
            exhaustion_clear_port=exhaustion_clear,
        )
    )


def _prepare_and_commit(api: AcquisitionApi, request: AcquisitionRequest) -> AcquisitionResult:
    prepared = api.prepare_primary_pdf(request)
    return api.commit_primary_pdf(prepared)


class _CancelEvent:
    def __init__(self, *, cancelled: bool = False) -> None:
        self.cancelled = cancelled

    def is_set(self) -> bool:
        return self.cancelled


class _CancelAfterChecks:
    def __init__(self, threshold: int) -> None:
        self.threshold = threshold
        self.calls = 0

    def is_set(self) -> bool:
        self.calls += 1
        return self.calls >= self.threshold


class AcquisitionWorkflowContractTests(unittest.TestCase):
    def test_prepare_is_publication_free_and_commit_consumes_the_receipt_once(self) -> None:
        events: list[str] = []
        temporary = _temporary(
            1,
            key="public/candidate",
            source_name="public-one",
            path=AcquisitionPath.PUBLIC,
        )
        publication = _PublicationFake(events=events, success_key="public/candidate")
        api = _api(
            (
                _binding(
                    _SourceFake(
                        "public-one",
                        AcquisitionPath.PUBLIC,
                        events=events,
                        items=(_SourceItem("public/candidate", temporary),),
                    )
                ),
            ),
            publication,
            _ExhaustionFake(events=events),
        )

        prepared = api.prepare_primary_pdf(_request())

        self.assertIsInstance(prepared, PreparedAcquisition)
        self.assertNotIn("publish:public/candidate", events)
        result = api.commit_primary_pdf(prepared)
        self.assertIsInstance(result, AcquiredPrimaryPdf)
        self.assertIn("publish:public/candidate", events)
        with self.assertRaises(AcquisitionFailure):
            api.commit_primary_pdf(prepared)

    def test_receipt_is_opaque_redacted_service_bound_and_discard_is_idempotent(self) -> None:
        api = _api((), _PublicationFake(events=[]), _ExhaustionFake(events=[]))
        other = _api((), _PublicationFake(events=[]), _ExhaustionFake(events=[]))
        prepared = api.prepare_primary_pdf(_request())

        self.assertEqual(repr(prepared), "<PreparedAcquisition opaque>")
        self.assertEqual(prepared.__slots__, ("__weakref__",))
        self.assertFalse(hasattr(prepared, "__dict__"))
        with self.assertRaises(TypeError):
            pickle.dumps(prepared)
        with self.assertRaises(AcquisitionFailure):
            other.commit_primary_pdf(prepared)
        with self.assertRaises(AcquisitionFailure):
            other.discard_prepared(prepared)

        api.discard_prepared(prepared)
        api.discard_prepared(prepared)
        with self.assertRaises(AcquisitionFailure):
            api.commit_primary_pdf(prepared)

    def test_forged_receipt_and_cancelled_prepare_fail_without_exhaustion_commit(self) -> None:
        events: list[str] = []
        exhaustion = _ExhaustionFake(events=events)
        api = _api((), _PublicationFake(events=events), exhaustion)

        with self.assertRaises(AcquisitionFailure):
            api.commit_primary_pdf(PreparedAcquisition())
        with self.assertRaises(AcquisitionFailure) as raised:
            api.prepare_primary_pdf(_request(), cancel_event=_CancelEvent(cancelled=True))

        self.assertEqual(raised.exception.failure.code, "acquisition-interrupted")
        self.assertEqual(exhaustion.calls, 0)

    def test_cancel_after_candidate_validation_discards_prepared_bytes_and_returns_no_receipt(
        self,
    ) -> None:
        events: list[str] = []
        temporary = _temporary(
            1,
            key="public/candidate",
            source_name="public-one",
            path=AcquisitionPath.PUBLIC,
        )
        cancel_event = _CancelEvent()
        publication = _PublicationFake(
            events=events,
            success_key="public/candidate",
            after_prepare=lambda: setattr(cancel_event, "cancelled", True),
        )
        source = _SourceFake(
            "public-one",
            AcquisitionPath.PUBLIC,
            events=events,
            items=(_SourceItem("public/candidate", temporary),),
        )
        exhaustion = _ExhaustionFake(events=events)
        api = _api((_binding(source),), publication, exhaustion)

        with self.assertRaises(AcquisitionFailure) as raised:
            api.prepare_primary_pdf(
                _request(),
                cancel_event=cancel_event,
            )

        self.assertEqual(raised.exception.failure.code, "acquisition-interrupted")
        self.assertEqual(exhaustion.calls, 0)
        self.assertEqual(_discard_count(temporary), 1)
        if publication.prepared_values:
            self.assertEqual(publication.prepared_values[0].discard_count, 1)

    def test_discard_releases_candidate_preparation_once(self) -> None:
        events: list[str] = []
        temporary = _temporary(
            1,
            key="public/candidate",
            source_name="public-one",
            path=AcquisitionPath.PUBLIC,
        )
        publication = _PublicationFake(events=events, success_key="public/candidate")
        api = _api(
            (
                _binding(
                    _SourceFake(
                        "public-one",
                        AcquisitionPath.PUBLIC,
                        events=events,
                        items=(_SourceItem("public/candidate", temporary),),
                    )
                ),
            ),
            publication,
            _ExhaustionFake(events=events),
        )

        prepared = api.prepare_primary_pdf(_request())
        api.discard_prepared(prepared)
        api.discard_prepared(prepared)

        self.assertEqual(publication.prepared_values[0].discard_count, 1)
        self.assertNotIn("publish:public/candidate", events)

    def test_public_second_candidate_commits_and_short_circuits_later_stages(self) -> None:
        events: list[str] = []
        first = _temporary(
            1, key="public/first", source_name="public-one", path=AcquisitionPath.PUBLIC
        )
        second = _temporary(
            2,
            key="public/second",
            source_name="public-one",
            path=AcquisitionPath.PUBLIC,
        )
        public = _SourceFake(
            "public-one",
            AcquisitionPath.PUBLIC,
            events=events,
            items=(
                _SourceItem("public/first", first),
                _SourceItem("public/second", second),
            ),
        )
        authorized = _SourceFake(
            "authorized-one",
            AcquisitionPath.AUTHORIZED_PROVIDER_API,
            events=events,
        )
        browser = _SourceFake(
            "browser-one",
            AcquisitionPath.CONTROLLED_BROWSER,
            events=events,
        )
        exhaustion = _ExhaustionFake(events=events)

        result = _prepare_and_commit(
            _api(
                (_binding(public), _binding(authorized), _binding(browser)),
                _PublicationFake(events=events, success_key="public/second"),
                exhaustion,
            ),
            _request(),
        )

        self.assertIsInstance(result, AcquiredPrimaryPdf)
        assert isinstance(result, AcquiredPrimaryPdf)
        self.assertEqual(result.candidate_key, "public/second")
        self.assertEqual(
            events,
            [
                "applicable:public-one",
                "acquire:public-one",
                "attempt:public-one:public/first",
                "prepare:public/first",
                "attempt:public-one:public/second",
                "prepare:public/second",
                "publish:public/second",
            ],
        )
        self.assertEqual(exhaustion.calls, 0)
        self.assertEqual(_discard_count(first), 1)
        self.assertEqual(_discard_count(second), 1)
        self.assertEqual(public.close_count, 1)
        self.assertEqual(authorized.close_count, 0)
        self.assertEqual(browser.close_count, 0)

    def test_normal_misses_cross_each_stage_only_after_the_previous_stage(self) -> None:
        events: list[str] = []
        sources = (
            _SourceFake(
                "public-one",
                AcquisitionPath.PUBLIC,
                events=events,
                items=(_SourceItem("public/one", None),),
            ),
            _SourceFake(
                "public-two",
                AcquisitionPath.PUBLIC,
                events=events,
                items=(_SourceItem("public/two", None),),
            ),
            _SourceFake(
                "authorized-one",
                AcquisitionPath.AUTHORIZED_PROVIDER_API,
                events=events,
                items=(_SourceItem("authorized/one", None),),
            ),
            _SourceFake(
                "browser-one",
                AcquisitionPath.CONTROLLED_BROWSER,
                events=events,
                items=(_SourceItem("browser/one", None),),
            ),
        )
        exhaustion = _ExhaustionFake(events=events)

        result = _prepare_and_commit(
            _api(
                tuple(_binding(source) for source in sources),
                _PublicationFake(events=events),
                exhaustion,
            ),
            _request(),
        )

        self.assertIsInstance(result, NoPrimaryPdf)
        self.assertEqual(
            [event for event in events if event.startswith(("acquire:", "publish-exhaustion"))],
            [
                "acquire:public-one",
                "acquire:public-two",
                "acquire:authorized-one",
                "acquire:browser-one",
                "publish-exhaustion",
            ],
        )

    def test_candidate_key_is_claimed_before_io_and_duplicate_or_excluded_keys_are_skipped(
        self,
    ) -> None:
        events: list[str] = []
        candidate = _temporary(
            1,
            key="same/key",
            source_name="public-one",
            path=AcquisitionPath.PUBLIC,
        )
        duplicate = _temporary(
            2,
            key="same/key",
            source_name="public-one",
            path=AcquisitionPath.PUBLIC,
        )
        source = _SourceFake(
            "public-one",
            AcquisitionPath.PUBLIC,
            events=events,
            items=(
                _SourceItem("already/excluded", None),
                _SourceItem("same/key", candidate),
                _SourceItem("same/key", duplicate),
            ),
        )

        result = _prepare_and_commit(
            _api(
                (_binding(source),),
                _PublicationFake(events=events),
                _ExhaustionFake(events=events),
            ),
            _request(excluded_candidate_keys=frozenset({"already/excluded"})),
        )

        self.assertIsInstance(result, NoPrimaryPdf)
        self.assertEqual(
            [event for event in events if event.startswith("attempt:")],
            ["attempt:public-one:same/key"],
        )
        self.assertEqual(
            [event for event in events if event == "prepare:same/key"], ["prepare:same/key"]
        )
        self.assertEqual(_discard_count(candidate), 1)
        self.assertEqual(_discard_count(duplicate), 0)

    def test_no_primary_pdf_exists_only_after_field_free_exhaustion_is_published(self) -> None:
        events: list[str] = []
        temporary = _temporary(
            1,
            key="public/miss",
            source_name="public-one",
            path=AcquisitionPath.PUBLIC,
        )
        source = _SourceFake(
            "public-one",
            AcquisitionPath.PUBLIC,
            events=events,
            items=(_SourceItem("public/miss", temporary),),
        )
        publication = _PublicationFake(events=events)
        exhaustion = _ExhaustionFake(events=events)
        later_observation = _observation(
            12,
            provider_name="index-two",
            record_id="record-two",
        )
        earlier_observation = _observation(
            11,
            provider_name="index-one",
            record_id="record-one",
        )
        request = _request(observations=(later_observation, earlier_observation, later_observation))

        result = _prepare_and_commit(
            _api(
                (_binding(source),),
                publication,
                exhaustion,
            ),
            request,
        )

        self.assertEqual(result, NoPrimaryPdf())
        self.assertEqual(result.model_dump(), {})
        self.assertEqual(exhaustion.calls, 1)
        self.assertEqual(events[-1], "publish-exhaustion")
        self.assertEqual(publication.expected_facts, [request.expected_facts])
        self.assertEqual(len(exhaustion.commands), 1)
        exhaustion_command = exhaustion.commands[0]
        self.assertEqual(exhaustion_command.expected_facts, request.expected_facts)
        self.assertEqual(
            exhaustion_command.observation_ids,
            (earlier_observation.observation_id, later_observation.observation_id),
        )
        self.assertEqual(exhaustion_command.observation_ids, request.observation_closure)
        self.assertEqual(request.expected_facts.literature_id, request.literature.literature_id)
        self.assertEqual(
            request.expected_facts.meta_literature_id,
            request.literature.meta_literature_id,
        )
        self.assertEqual(request.expected_facts.metadata_revision, 1)
        self.assertEqual(
            request.expected_facts.metadata_sha256,
            metadata_sha256(request.literature.metadata),
        )
        self.assertTrue(request.expected_facts.expected_no_primary_pdf)

    def test_disabled_and_inapplicable_sources_do_not_join_the_exhaustion_set(self) -> None:
        events: list[str] = []
        disabled_broken = _SourceFake(
            "disabled",
            AcquisitionPath.PUBLIC,
            events=events,
        )
        inapplicable = _SourceFake(
            "inapplicable",
            AcquisitionPath.AUTHORIZED_PROVIDER_API,
            events=events,
            applicable=False,
        )

        result = _prepare_and_commit(
            _api(
                (
                    _binding(
                        disabled_broken,
                        enabled=False,
                        production=False,
                        readiness=None,
                    ),
                    _binding(inapplicable),
                ),
                _PublicationFake(events=events),
                _ExhaustionFake(events=events),
            ),
            _request(),
        )

        self.assertIsInstance(result, NoPrimaryPdf)
        self.assertNotIn("applicable:disabled", events)
        self.assertNotIn("acquire:disabled", events)
        self.assertIn("applicable:inapplicable", events)
        self.assertNotIn("acquire:inapplicable", events)


class AcquisitionFailureBoundaryTests(unittest.TestCase):
    def test_explicit_retry_clear_passes_complete_expected_facts_without_source_io(self) -> None:
        source_events: list[str] = []
        clear_events: list[str] = []
        source = _SourceFake("public-one", AcquisitionPath.PUBLIC, events=source_events)
        clear = _ExhaustionClearFake(events=clear_events)
        request = _request()
        api = _api(
            (_binding(source),),
            _PublicationFake(events=[]),
            _ExhaustionFake(events=[]),
            exhaustion_clear=clear,
        )

        result = api.clear_exhaustion_for_explicit_retry(request.expected_facts)

        self.assertIsNone(result)
        self.assertEqual(clear.expected_facts, [request.expected_facts])
        self.assertEqual(clear_events, ["clear-exhaustion"])
        self.assertEqual(source_events, [])
        self.assertEqual(source.close_count, 0)

    def test_explicit_retry_clear_failure_propagates_without_source_io(self) -> None:
        source_events: list[str] = []
        clear_events: list[str] = []
        source = _SourceFake("public-one", AcquisitionPath.PUBLIC, events=source_events)
        failure = AcquisitionFailure(_stable_failure("exhaustion-clear-failed"))
        clear = _ExhaustionClearFake(events=clear_events, failure=failure)
        api = _api(
            (_binding(source),),
            _PublicationFake(events=[]),
            _ExhaustionFake(events=[]),
            exhaustion_clear=clear,
        )

        with self.assertRaises(AcquisitionFailure) as raised:
            api.clear_exhaustion_for_explicit_retry(_request().expected_facts)

        self.assertIs(raised.exception, failure)
        self.assertEqual(clear_events, ["clear-exhaustion"])
        self.assertEqual(source_events, [])
        self.assertEqual(source.close_count, 0)

    def test_every_enabled_source_must_have_production_implementation_and_readiness(self) -> None:
        cases: tuple[tuple[str, Callable[[_SourceFake], PdfSourceBinding], str], ...] = (
            (
                "not-production",
                lambda source: _binding(source, production=False),
                "acquisition-source-not-production",
            ),
            (
                "implementation",
                lambda _source: _binding(
                    None,
                    source_name="configured",
                    path=AcquisitionPath.PUBLIC,
                ),
                "acquisition-source-not-implemented",
            ),
            (
                "readiness",
                lambda source: _binding(source, readiness=None),
                "acquisition-source-readiness-missing",
            ),
            (
                "policy",
                lambda source: _binding(
                    source,
                    readiness=SourceReadiness(
                        is_ready=False,
                        failure=_stable_failure("access-policy-missing"),
                    ),
                ),
                "access-policy-missing",
            ),
            (
                "credential",
                lambda source: _binding(
                    source,
                    readiness=SourceReadiness(
                        is_ready=False,
                        failure=_stable_failure("provider-credential-missing"),
                    ),
                ),
                "provider-credential-missing",
            ),
        )
        for label, make_binding, expected_code in cases:
            with self.subTest(label=label):
                events: list[str] = []
                source = _SourceFake("configured", AcquisitionPath.PUBLIC, events=events)
                binding = make_binding(source)
                exhaustion = _ExhaustionFake(events=events)

                with self.assertRaises(AcquisitionFailure) as raised:
                    _api(
                        (binding,),
                        _PublicationFake(events=events),
                        exhaustion,
                    ).prepare_primary_pdf(_request())

                self.assertEqual(raised.exception.failure.code, expected_code)
                self.assertEqual(exhaustion.calls, 0)
                self.assertFalse(any(event.startswith("acquire:") for event in events))

    def test_network_cancellation_and_coordinator_failures_never_publish_exhaustion(self) -> None:
        for code in ("network-transport", "cancelled", "access-coordinator"):
            with self.subTest(code=code):
                events: list[str] = []
                source = _SourceFake(
                    "public-one",
                    AcquisitionPath.PUBLIC,
                    events=events,
                    failure=AcquisitionFailure(_stable_failure(code)),
                )
                exhaustion = _ExhaustionFake(events=events)

                with self.assertRaises(AcquisitionFailure) as raised:
                    _api(
                        (_binding(source),),
                        _PublicationFake(events=events),
                        exhaustion,
                    ).prepare_primary_pdf(_request())

                self.assertEqual(raised.exception.failure.code, code)
                self.assertEqual(exhaustion.calls, 0)

    def test_primary_publication_failure_is_system_failure_not_no_primary_pdf(self) -> None:
        events: list[str] = []
        temporary = _temporary(
            1,
            key="public/candidate",
            source_name="public-one",
            path=AcquisitionPath.PUBLIC,
        )
        source = _SourceFake(
            "public-one",
            AcquisitionPath.PUBLIC,
            events=events,
            items=(_SourceItem("public/candidate", temporary),),
        )
        exhaustion = _ExhaustionFake(events=events)

        with self.assertRaises(AcquisitionFailure) as raised:
            _prepare_and_commit(
                _api(
                    (_binding(source),),
                    _PublicationFake(
                        events=events,
                        failure=AcquisitionFailure(_stable_failure("primary-publication-failed")),
                    ),
                    exhaustion,
                ),
                _request(),
            )

        self.assertEqual(raised.exception.failure.code, "primary-publication-failed")
        self.assertEqual(exhaustion.calls, 0)
        self.assertEqual(_discard_count(temporary), 1)

    def test_exhaustion_publication_failure_is_system_failure_not_no_primary_pdf(self) -> None:
        events: list[str] = []
        source = _SourceFake("public-one", AcquisitionPath.PUBLIC, events=events)
        exhaustion = _ExhaustionFake(
            events=events,
            failure=AcquisitionFailure(_stable_failure("exhaustion-publication-failed")),
        )

        with self.assertRaises(AcquisitionFailure) as raised:
            api = _api(
                (_binding(source),),
                _PublicationFake(events=events),
                exhaustion,
            )
            prepared = api.prepare_primary_pdf(_request())
            api.commit_primary_pdf(prepared)

        self.assertEqual(raised.exception.failure.code, "exhaustion-publication-failed")
        self.assertEqual(exhaustion.calls, 1)


class AcquisitionRoutingContractTests(unittest.TestCase):
    def test_request_has_one_ports_owned_definition_and_public_api_export(self) -> None:
        self.assertIs(acquisition_ports.AcquisitionRequest, AcquisitionRequest)
        self.assertIs(acquisition_api.AcquisitionRequest, AcquisitionRequest)
        self.assertEqual(
            AcquisitionRequest.__module__,
            "sciretriever.acquisition.ports",
        )

    def test_evidence_is_local_and_ordered_without_performing_source_io(self) -> None:
        hint = AssetHint(
            url="https://repository.example.invalid/paper.pdf",
            kind=AssetHintKind.DIRECT_FILE,
            media_type="application/pdf",
            asset_role=AssetRole.PRIMARY_PDF,
        )
        literature = _literature(
            publisher="Example Publisher",
            identifiers=(
                Identifier(namespace="doi", value="10.1016/example"),
                Identifier(namespace="pii", value="S012345678900001X"),
            ),
        )
        request = _request(
            literature=literature,
            observations=(
                _observation(
                    10,
                    provider_name="example-index",
                    record_id="record-10",
                    asset_hints=(hint,),
                ),
            ),
            resolved_landing_origin="https://publisher.example.invalid",
        )

        evidence = build_acquisition_evidence(request)

        self.assertEqual(
            evidence.priority,
            (
                RoutingEvidenceKind.ASSET_HINT,
                RoutingEvidenceKind.STABLE_PROVIDER_LOCATOR,
                RoutingEvidenceKind.PROVIDER_RECORD_IDENTITY,
                RoutingEvidenceKind.RESOLVED_LANDING_ORIGIN,
                RoutingEvidenceKind.WEAK_PUBLISHER_OR_DOI_PREFIX,
            ),
        )
        self.assertEqual(evidence.asset_hints[0].hint, hint)
        self.assertEqual(evidence.stable_provider_locators[0].namespace, "pii")
        self.assertEqual(evidence.provider_record_identities[0].provider_name, "example-index")
        self.assertEqual(evidence.provider_record_identities[0].record_id, "record-10")
        self.assertEqual(evidence.resolved_landing_origin, "https://publisher.example.invalid")
        self.assertEqual(evidence.weak_hints.publisher, "Example Publisher")
        self.assertEqual(evidence.weak_hints.doi_prefixes, ("10.1016",))

    def test_publisher_doi_prefix_and_observation_source_do_not_prove_authorized_applicability(
        self,
    ) -> None:
        events: list[str] = []
        literature = _literature(
            publisher="Elsevier",
            identifiers=(Identifier(namespace="doi", value="10.1016/example"),),
        )
        observation = _observation(
            10,
            provider_name="elsevier",
            record_id="scopus-index-record",
        )

        def has_strong_elsevier_location(evidence: AcquisitionEvidence) -> bool:
            return any(
                locator.namespace == "pii" for locator in evidence.stable_provider_locators
            ) or any(
                identity.provider_name == "elsevier" and identity.record_id.startswith("pii:")
                for identity in evidence.provider_record_identities
            )

        authorized = _SourceFake(
            "elsevier-content",
            AcquisitionPath.AUTHORIZED_PROVIDER_API,
            events=events,
            applicable=has_strong_elsevier_location,
            items=(_SourceItem("authorized/should-not-run", None),),
        )

        result = _prepare_and_commit(
            _api(
                (_binding(authorized),),
                _PublicationFake(events=events),
                _ExhaustionFake(events=events),
            ),
            _request(literature=literature, observations=(observation,)),
        )

        self.assertIsInstance(result, NoPrimaryPdf)
        self.assertIn("applicable:elsevier-content", events)
        self.assertNotIn("acquire:elsevier-content", events)

    def test_is_applicable_receives_only_prebuilt_evidence_and_never_opens_source_io(self) -> None:
        events: list[str] = []
        source = _SourceFake(
            "authorized-one",
            AcquisitionPath.AUTHORIZED_PROVIDER_API,
            events=events,
            applicable=False,
            items=(_SourceItem("authorized/not-applicable", None),),
        )

        result = _prepare_and_commit(
            _api(
                (_binding(source),),
                _PublicationFake(events=events),
                _ExhaustionFake(events=events),
            ),
            _request(),
        )

        self.assertIsInstance(result, NoPrimaryPdf)
        self.assertEqual(events.count("applicable:authorized-one"), 1)
        self.assertNotIn("acquire:authorized-one", events)

    def test_public_api_and_ports_have_no_transport_browser_or_vendor_types(self) -> None:
        prepare_signature = str(inspect.signature(AcquisitionApi.prepare_primary_pdf))
        commit_signature = str(inspect.signature(AcquisitionApi.commit_primary_pdf))
        discard_signature = str(inspect.signature(AcquisitionApi.discard_prepared))
        clear_signature = str(inspect.signature(AcquisitionApi.clear_exhaustion_for_explicit_retry))
        source_signature = str(inspect.signature(acquisition_ports.PdfSource.acquire))
        publication_signature = str(
            inspect.signature(acquisition_ports.PrimaryPdfPreparationPort.prepare_primary_pdf)
        )
        exposed = " ".join(
            (
                prepare_signature,
                commit_signature,
                discard_signature,
                clear_signature,
                source_signature,
                publication_signature,
            )
        )

        for forbidden in (
            "AccessFailure",
            "BoundedByteStream",
            "Browser",
            "Http",
            "TransportRequest",
            "TransportResponse",
            "Vendor",
        ):
            self.assertNotIn(forbidden, exposed)
            self.assertFalse(hasattr(acquisition_api, forbidden))
            self.assertFalse(hasattr(acquisition_ports, forbidden))


if __name__ == "__main__":
    unittest.main()
