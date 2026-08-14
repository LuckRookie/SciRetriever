from __future__ import annotations

import hashlib
import json
import threading
import unittest
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from io import BytesIO
from pathlib import Path
from typing import BinaryIO, cast
from urllib.parse import parse_qs, urlsplit

from PyPDF2 import PdfWriter

from sciretriever.acquisition.access_profiles import PublisherAccessProfileCatalog
from sciretriever.acquisition.planning import (
    AcquisitionPlanBuilder,
    ProgressiveAcquisitionPlanner,
    PublisherAccessResolver,
    RouteCapability,
    RouteReadiness,
    RouteSpec,
)
from sciretriever.acquisition.ports import (
    AcquisitionExpectedFacts,
    AcquisitionFailure,
    CandidateKeyTracker,
    PrimaryPdfPreparation,
    TemporaryPdf,
)
from sciretriever.acquisition.routes import AcquisitionRouteRegistry, RouteAdapterBinding
from sciretriever.acquisition.routing import (
    AcquisitionEvidence,
    AcquisitionRequest,
    build_acquisition_evidence,
)
from sciretriever.acquisition.sources import arxiv as arxiv_source
from sciretriever.acquisition.sources import europe_pmc as europe_pmc_source
from sciretriever.acquisition.sources import unpaywall as unpaywall_source
from sciretriever.acquisition.tiered_service import TieredAcquisitionService
from sciretriever.literature.content import metadata_sha256
from sciretriever.metadata.providers.arxiv import ACCESS_SCOPE as METADATA_ARXIV_SCOPE
from sciretriever.metadata.providers.europe_pmc import (
    ACCESS_SCOPE as METADATA_EUROPE_PMC_SCOPE,
)
from sciretriever.model.access import AccessFailure, Header, TransportResponse
from sciretriever.model.acquisition import (
    AcquiredPrimaryPdf,
    AcquisitionPath,
    AutomaticPdfAcquisitionExhaustion,
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
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.network.admission import AccessFeedback, AccessPolicy
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import Origin

_FIXTURES = Path(__file__).parent / "fixtures" / "acquisition"
_TIME = UtcTimestamp("2026-08-11T12:00:00Z")
_CONTACT_EMAIL = "team-contact@example.test"


def _id(index: int) -> str:
    return f"{index:08x}-e89b-12d3-a456-426614174000"


def _fixture(provider: str, name: str) -> bytes:
    return (_FIXTURES / provider / name).read_bytes()


def _response(
    body: bytes = b"",
    *,
    status: int = 200,
    final_url: str = "https://api.example.test/result",
    headers: tuple[Header, ...] = (),
) -> TransportResponse:
    return TransportResponse(status=status, final_url=final_url, headers=headers, body=body)


def _access_failure(*, retryable: bool = True) -> AccessFailure:
    return AccessFailure(
        code="transport",
        reason="network access failed",
        action="retry later",
        retryable=retryable,
    )


def _observation(
    index: int,
    *,
    provider_name: str,
    record_id: str,
) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_id(index)),
        provenance=Provenance(
            provenance_id=ProvenanceId(_id(index + 100)),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=provider_name,
            source_record_id=record_id,
            observed_at=_TIME,
            input_sha256=Sha256("a" * 64),
            parameters_sha256=None,
        ),
        metadata=LiteratureMetadata(title="Provider observation"),
    )


def _request(
    *,
    identifiers: tuple[Identifier, ...] = (),
    observations: tuple[MetadataObservation, ...] = (),
    excluded_candidate_keys: frozenset[str] = frozenset(),
) -> tuple[AcquisitionRequest, AcquisitionEvidence]:
    literature = Literature(
        literature_id=LiteratureId(_id(1)),
        meta_literature_id=MetaLiteratureId(_id(2)),
        version_role=VersionRole.PUBLISHED,
        metadata=LiteratureMetadata(title="Protocol fixture", identifiers=identifiers),
        status=LiteratureStatus.UNREVIEWED,
    )
    request = AcquisitionRequest(
        literature=literature,
        expected_facts=AcquisitionExpectedFacts(
            literature_id=literature.literature_id,
            meta_literature_id=literature.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(literature.metadata),
            expected_no_primary_pdf=True,
        ),
        observations=observations,
        excluded_candidate_keys=excluded_candidate_keys,
    )
    return request, build_acquisition_evidence(request)


def _valid_pdf() -> bytes:
    output = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.write(output)
    return output.getvalue()


class _MemoryContent:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.discard_count = 0

    @contextmanager
    def open(self) -> Iterator[BinaryIO]:
        stream = BytesIO(self.payload)
        try:
            yield stream
        finally:
            stream.close()

    def discard(self) -> None:
        self.discard_count += 1


class _HttpFake:
    def __init__(self, actions: Iterable[TransportResponse | AccessFailure]) -> None:
        self.actions = list(actions)
        self.calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
        self.feedback: list[object] = []

    def request(self, *args: object, **kwargs: object) -> TransportResponse | AccessFailure:
        self.calls.append((args, kwargs))
        action = self.actions.pop(0)
        callback = kwargs.get("response_feedback")
        if isinstance(action, TransportResponse) and callable(callback):
            self.feedback.append(callback(action))
        return action


class _LocatorFake:
    def __init__(self, outcomes: Iterable[str | None] = ()) -> None:
        self.outcomes = list(outcomes)
        self.calls: list[dict[str, object]] = []
        self.io_events: list[str] = []
        self.close_count = 0
        self.temporaries: list[TemporaryPdf] = []

    def acquire(
        self,
        *,
        locator: str,
        candidate_key: str,
        source_name: str,
        source_record_id: str | None,
        declared_media_type: str | None,
        candidate_keys: CandidateKeyTracker,
        allow_static_landing_discovery: bool,
    ) -> Iterable[TemporaryPdf]:
        call = {
            "locator": locator,
            "candidate_key": candidate_key,
            "source_name": source_name,
            "source_record_id": source_record_id,
            "declared_media_type": declared_media_type,
            "candidate_keys": candidate_keys,
            "allow_static_landing_discovery": allow_static_landing_discovery,
        }
        self.calls.append(call)

        def make_temporary(
            *,
            key: str,
            source_url: str,
            media_type: str | None,
            payload: bytes,
        ) -> TemporaryPdf:
            temporary = TemporaryPdf(
                candidate=PdfCandidate(
                    candidate_key=key,
                    source_name=source_name,
                    acquisition_path=AcquisitionPath.PUBLIC,
                    declared_media_type=media_type,
                ),
                content=_MemoryContent(payload),
                safe_source_url=source_url,
                provenance=Provenance(
                    provenance_id=ProvenanceId(_id(800 + len(self.temporaries))),
                    source_kind=SourceKind.ASSET_PROVIDER,
                    source_name=source_name,
                    source_record_id=source_record_id,
                    observed_at=_TIME,
                    input_sha256=None,
                    parameters_sha256=None,
                ),
            )
            self.temporaries.append(temporary)
            return temporary

        def run() -> Iterator[TemporaryPdf]:
            outcome: str | None = None
            try:
                if not candidate_keys.claim(candidate_key):
                    return
                self.io_events.append(candidate_key)
                outcome = self.outcomes.pop(0) if self.outcomes else "yield"
                if outcome is None:
                    return
                if outcome == "close-fail":
                    return
                first_payload = (
                    b'<html><meta name="citation_pdf_url" content="discovered.pdf"></html>'
                    if outcome == "html-discovery"
                    else _valid_pdf()
                )
                yield make_temporary(
                    key=candidate_key,
                    source_url=locator,
                    media_type=declared_media_type,
                    payload=first_payload,
                )
                if outcome == "html-discovery" and allow_static_landing_discovery:
                    discovered_key = f"{candidate_key}/static-pdf"
                    if candidate_keys.claim(discovered_key):
                        yield make_temporary(
                            key=discovered_key,
                            source_url="https://repository.example.test/item/discovered.pdf",
                            media_type="application/pdf",
                            payload=_valid_pdf(),
                        )
            finally:
                self.close_count += 1
                if outcome == "close-fail":
                    raise RuntimeError("fixture close failed")

        return run()


def _arxiv(
    http: _HttpFake,
    locator: _LocatorFake,
    *,
    cancel_event: threading.Event | None = None,
) -> arxiv_source.ArxivPdfSource:
    return arxiv_source.ArxivPdfSource(
        http_client=cast(HttpClient, http),
        access_scope=arxiv_source.ACCESS_SCOPE,
        access_policy=AccessPolicy(max_concurrency=4),
        locator_fetcher=locator,
        cancel_event=cancel_event,
    )


def _europe_pmc(
    http: _HttpFake,
    locator: _LocatorFake,
    *,
    cancel_event: threading.Event | None = None,
) -> europe_pmc_source.EuropePmcPdfSource:
    return europe_pmc_source.EuropePmcPdfSource(
        http_client=cast(HttpClient, http),
        access_scope=europe_pmc_source.ACCESS_SCOPE,
        access_policy=AccessPolicy(max_concurrency=4),
        locator_fetcher=locator,
        cancel_event=cancel_event,
    )


def _unpaywall(
    http: _HttpFake,
    locator: _LocatorFake,
    *,
    contact_email: str = _CONTACT_EMAIL,
    cancel_event: threading.Event | None = None,
) -> unpaywall_source.UnpaywallPdfSource:
    return unpaywall_source.UnpaywallPdfSource(
        http_client=cast(HttpClient, http),
        access_scope=unpaywall_source.ACCESS_SCOPE,
        access_policy=AccessPolicy(
            max_concurrency=4,
            burst_limit=200_000,
            window_seconds=43_200.0,
        ),
        locator_fetcher=locator,
        contact_email=contact_email,
        cancel_event=cancel_event,
    )


def _query(call: tuple[tuple[object, ...], dict[str, object]]) -> dict[str, list[str]]:
    url = call[0][1]
    if not isinstance(url, str):
        raise AssertionError("HTTP fake expected a URL string")
    return parse_qs(urlsplit(url).query)


class PublicProtocolSourceContractTests(unittest.TestCase):
    def test_sources_declare_public_path_and_shared_provider_api_policies(self) -> None:
        self.assertEqual(arxiv_source.ArxivPdfSource.source_name, "arxiv")
        self.assertEqual(europe_pmc_source.EuropePmcPdfSource.source_name, "europe-pmc")
        self.assertEqual(unpaywall_source.UnpaywallPdfSource.source_name, "unpaywall")
        self.assertIs(arxiv_source.ArxivPdfSource.acquisition_path, AcquisitionPath.PUBLIC)
        self.assertIs(europe_pmc_source.EuropePmcPdfSource.acquisition_path, AcquisitionPath.PUBLIC)
        self.assertIs(unpaywall_source.UnpaywallPdfSource.acquisition_path, AcquisitionPath.PUBLIC)
        self.assertEqual(arxiv_source.ACCESS_SCOPE, METADATA_ARXIV_SCOPE)
        self.assertEqual(europe_pmc_source.ACCESS_SCOPE, METADATA_EUROPE_PMC_SCOPE)
        self.assertEqual(
            arxiv_source.BASELINE_ACCESS_POLICY,
            AccessPolicy(max_concurrency=1, min_start_interval=3.0),
        )
        self.assertEqual(
            europe_pmc_source.BASELINE_ACCESS_POLICY,
            AccessPolicy(max_concurrency=1, min_start_interval=1.0),
        )
        self.assertEqual(
            unpaywall_source.BASELINE_ACCESS_POLICY,
            AccessPolicy(
                max_concurrency=1,
                burst_limit=100_000,
                window_seconds=86_400.0,
            ),
        )

    def test_route_lookup_inputs_use_only_strong_provider_evidence(self) -> None:
        doi = Identifier(namespace="doi", value="10.5555/example")
        arxiv = Identifier(namespace="arxiv", value="2106.14834")
        pmcid = Identifier(namespace="pmcid", value="PMC7759461")
        pmid = Identifier(namespace="pmid", value="32939066")

        _, doi_evidence = _request(identifiers=(doi,))
        _, arxiv_evidence = _request(identifiers=(arxiv,))
        _, pmcid_evidence = _request(identifiers=(pmcid,))
        _, pmid_evidence = _request(identifiers=(pmid,))
        cases = (
            (_arxiv, arxiv_evidence, doi_evidence),
            (_europe_pmc, pmcid_evidence, pmid_evidence),
            (_unpaywall, doi_evidence, arxiv_evidence),
        )
        for factory, matching, nonmatching in cases:
            with self.subTest(factory=factory.__name__):
                http = _HttpFake((_response(status=404),))
                source = factory(http, _LocatorFake())
                request, _ = _request(
                    identifiers=tuple(matching.identifiers),
                )
                list(source._deliveries(request, matching, CandidateKeyTracker()))
                request, _ = _request(
                    identifiers=tuple(nonmatching.identifiers),
                )
                list(source._deliveries(request, nonmatching, CandidateKeyTracker()))
                self.assertEqual(len(http.calls), 1)

        _, records = _request(
            observations=(
                _observation(10, provider_name="arxiv", record_id="2106.14834v2"),
                _observation(11, provider_name="europe-pmc", record_id="PMC:7759461"),
            )
        )
        record_request, _ = _request(
            observations=(
                _observation(10, provider_name="arxiv", record_id="2106.14834v2"),
                _observation(11, provider_name="europe-pmc", record_id="PMC:7759461"),
            )
        )
        for factory in (_arxiv, _europe_pmc):
            http = _HttpFake((_response(status=404),))
            list(
                factory(http, _LocatorFake())._deliveries(
                    record_request,
                    records,
                    CandidateKeyTracker(),
                )
            )
            self.assertEqual(len(http.calls), 1)

    def test_arxiv_versioned_records_precede_uncovered_canonical_bases(self) -> None:
        request, evidence = _request(
            identifiers=(
                Identifier(namespace="arxiv", value="2106.14834"),
                Identifier(namespace="arxiv", value="2201.00001"),
            ),
            observations=(
                _observation(10, provider_name="arxiv", record_id="2106.14834v2"),
                _observation(11, provider_name="other", record_id="ignored"),
            ),
        )
        http = _HttpFake([_response(_fixture("arxiv", "zero.xml"))] * 2)
        tracker = CandidateKeyTracker()

        self.assertEqual(
            list(_arxiv(http, _LocatorFake())._deliveries(request, evidence, tracker)),
            [],
        )

        self.assertEqual(
            [_query(call)["id_list"] for call in http.calls],
            [["2106.14834v2"], ["2201.00001"]],
        )
        self.assertIn("arxiv/public/lookup/2106.14834v2", tracker.tried_candidate_keys)
        self.assertNotIn("arxiv/public/lookup/2106.14834", tracker.tried_candidate_keys)

    def test_arxiv_atom_handoff_preserves_actual_revision_and_official_locator(self) -> None:
        request, evidence = _request(
            identifiers=(Identifier(namespace="arxiv", value="2106.14834"),)
        )
        http = _HttpFake([_response(_fixture("arxiv", "success.xml"))])
        locator = _LocatorFake()

        deliveries = list(
            _arxiv(http, locator)._deliveries(request, evidence, CandidateKeyTracker())
        )

        self.assertEqual(len(deliveries), 1)
        self.assertEqual(locator.calls[0]["locator"], "https://arxiv.org/pdf/2106.14834v2")
        self.assertEqual(locator.calls[0]["candidate_key"], "arxiv/public/2106.14834v2")
        self.assertEqual(locator.calls[0]["source_record_id"], "2106.14834v2")
        self.assertEqual(locator.calls[0]["declared_media_type"], "application/pdf")
        self.assertIs(locator.calls[0]["allow_static_landing_discovery"], False)
        self.assertEqual(_query(http.calls[0]), {"id_list": ["2106.14834"], "max_results": ["1"]})
        self.assertEqual(http.calls[0][1]["max_redirects"], 0)
        self.assertEqual(http.calls[0][0][0], arxiv_source.ACCESS_SCOPE)

    def test_arxiv_zero_entry_and_api_not_found_are_normal_misses(self) -> None:
        request, evidence = _request(
            identifiers=(Identifier(namespace="arxiv", value="2106.14834"),)
        )
        for response in (
            _response(_fixture("arxiv", "zero.xml")),
            _response(status=404),
        ):
            with self.subTest(status=response.status, body=bool(response.body)):
                locator = _LocatorFake()
                result = list(
                    _arxiv(_HttpFake((response,)), locator)._deliveries(
                        request,
                        evidence,
                        CandidateKeyTracker(),
                    )
                )
                self.assertEqual(result, [])
                self.assertEqual(locator.calls, [])

    def test_arxiv_rejects_mismatch_unsafe_link_malformed_and_active_xml(self) -> None:
        request, evidence = _request(
            identifiers=(Identifier(namespace="arxiv", value="2106.14834"),)
        )
        cases = (
            ("mismatch.xml", "acquisition-arxiv-protocol"),
            ("unsafe-link.xml", "acquisition-arxiv-protocol"),
            ("malformed.xml", "acquisition-arxiv-protocol"),
            ("doctype.xml", "acquisition-arxiv-unsafe-xml"),
        )
        for name, expected_code in cases:
            with self.subTest(name=name):
                with self.assertRaises(AcquisitionFailure) as caught:
                    list(
                        _arxiv(
                            _HttpFake((_response(_fixture("arxiv", name)),)),
                            _LocatorFake(),
                        )._deliveries(request, evidence, CandidateKeyTracker())
                    )
                self.assertEqual(caught.exception.failure.code, expected_code)

    def test_arxiv_versioned_lookup_requires_the_exact_observed_revision(self) -> None:
        request, evidence = _request(
            identifiers=(Identifier(namespace="arxiv", value="2106.14834"),),
            observations=(_observation(10, provider_name="arxiv", record_id="2106.14834v2"),),
        )
        wrong_revision = _fixture("arxiv", "success.xml").replace(b"v2", b"v1")

        with self.assertRaises(AcquisitionFailure) as caught:
            list(
                _arxiv(
                    _HttpFake((_response(wrong_revision),)),
                    _LocatorFake(),
                )._deliveries(request, evidence, CandidateKeyTracker())
            )

        self.assertEqual(caught.exception.failure.code, "acquisition-arxiv-protocol")

    def test_europe_pmc_lookup_filters_styles_preserves_order_and_deduplicates_urls(
        self,
    ) -> None:
        request, evidence = _request(
            identifiers=(Identifier(namespace="pmcid", value="PMC7759461"),)
        )
        http = _HttpFake([_response(_fixture("europe_pmc", "success.json"))])
        locator = _LocatorFake((None, "yield"))

        deliveries = list(
            _europe_pmc(http, locator)._deliveries(request, evidence, CandidateKeyTracker())
        )

        self.assertEqual(len(deliveries), 1)
        self.assertEqual(
            [call["locator"] for call in locator.calls],
            [
                "https://europepmc.org/articles/PMC7759461?pdf=render",
                "https://cdn.example.test/PMC7759461.pdf",
            ],
        )
        self.assertTrue(
            all(call["declared_media_type"] == "application/pdf" for call in locator.calls)
        )
        self.assertEqual(_query(http.calls[0])["query"], ["PMCID:PMC7759461"])
        self.assertEqual(_query(http.calls[0])["resultType"], ["core"])
        self.assertEqual(http.calls[0][1]["max_redirects"], 0)

    def test_europe_pmc_flags_without_pdf_locator_do_not_create_candidates(self) -> None:
        request, evidence = _request(
            identifiers=(Identifier(namespace="pmcid", value="PMC7759461"),)
        )
        for name in ("flags-only.json", "zero.json"):
            with self.subTest(name=name):
                locator = _LocatorFake()
                deliveries = list(
                    _europe_pmc(
                        _HttpFake((_response(_fixture("europe_pmc", name)),)),
                        locator,
                    )._deliveries(request, evidence, CandidateKeyTracker())
                )
                self.assertEqual(deliveries, [])
                self.assertEqual(locator.calls, [])

    def test_europe_pmc_rejects_identity_mismatch_unsafe_locator_and_malformed_json(
        self,
    ) -> None:
        request, evidence = _request(
            identifiers=(Identifier(namespace="pmcid", value="PMC7759461"),)
        )
        for name in ("mismatch.json", "unsafe.json", "malformed.json"):
            with self.subTest(name=name):
                with self.assertRaises(AcquisitionFailure) as caught:
                    list(
                        _europe_pmc(
                            _HttpFake((_response(_fixture("europe_pmc", name)),)),
                            _LocatorFake(),
                        )._deliveries(request, evidence, CandidateKeyTracker())
                    )
                self.assertEqual(caught.exception.failure.code, "acquisition-europe-pmc-protocol")

    def test_unpaywall_requires_local_valid_contact_email_without_repr_exposure(self) -> None:
        for value in ("", "missing-at.example.test", "person@example", "bad\n@example.test"):
            with self.subTest(value=repr(value)):
                with self.assertRaises((TypeError, ValueError)):
                    _unpaywall(_HttpFake(()), _LocatorFake(), contact_email=value)
        source = _unpaywall(_HttpFake(()), _LocatorFake())
        self.assertNotIn(_CONTACT_EMAIL, repr(source))

    def test_unpaywall_lookup_uses_origin_bound_wire_only_email_and_canonical_doi_path(
        self,
    ) -> None:
        request, evidence = _request(
            identifiers=(Identifier(namespace="doi", value="10.5555/EXAMPLE"),)
        )
        http = _HttpFake([_response(_fixture("unpaywall", "no-oa.json"))])
        source = _unpaywall(http, _LocatorFake())

        self.assertEqual(
            list(source._deliveries(request, evidence, CandidateKeyTracker())),
            [],
        )

        args, kwargs = http.calls[0]
        self.assertEqual(args[1], "https://api.unpaywall.org/v2")
        self.assertEqual(kwargs["path_parameter"], "10.5555/example")
        self.assertEqual(kwargs["credential_query"], {"email": _CONTACT_EMAIL})
        self.assertEqual(
            kwargs["credential_allowed_origins"],
            (Origin("https", "api.unpaywall.org", 443),),
        )
        self.assertEqual(kwargs["max_redirects"], 0)
        self.assertNotIn(_CONTACT_EMAIL, cast(str, args[1]))

    def test_unpaywall_best_locations_first_and_stable_global_url_deduplication(self) -> None:
        request, evidence = _request(
            identifiers=(Identifier(namespace="doi", value="10.5555/example"),)
        )
        locator = _LocatorFake((None, None, None, "yield"))
        deliveries = list(
            _unpaywall(
                _HttpFake((_response(_fixture("unpaywall", "ordered.json")),)),
                locator,
            )._deliveries(request, evidence, CandidateKeyTracker())
        )

        expected = [
            "https://publisher.example.test/article.pdf",
            "https://publisher.example.test/article",
            "https://repository.example.test/item/1",
            "https://first.example.test/article.pdf",
        ]
        self.assertEqual([call["locator"] for call in locator.calls], expected)
        self.assertEqual(len(deliveries), 1)
        self.assertNotIn("embargoed", " ".join(expected))
        self.assertNotIn("never", " ".join(expected))
        self.assertEqual(
            [call["declared_media_type"] for call in locator.calls],
            ["application/pdf", None, None, "application/pdf"],
        )
        self.assertEqual(
            [call["allow_static_landing_discovery"] for call in locator.calls],
            [False, True, True, False],
        )
        for call in locator.calls:
            key = cast(str, call["candidate_key"])
            self.assertNotIn(_CONTACT_EMAIL, key)
            self.assertEqual(call["source_record_id"], "10.5555/example")
        self.assertNotIn(_CONTACT_EMAIL, repr(deliveries[0]))

    def test_unpaywall_same_url_merges_pdf_and_landing_semantics_for_static_discovery(
        self,
    ) -> None:
        request, evidence = _request(
            identifiers=(Identifier(namespace="doi", value="10.5555/example"),)
        )
        locator = _LocatorFake(("html-discovery",))

        deliveries = list(
            _unpaywall(
                _HttpFake((_response(_fixture("unpaywall", "merged-semantics.json")),)),
                locator,
            )._deliveries(request, evidence, CandidateKeyTracker())
        )

        self.assertEqual(len(locator.calls), 1)
        self.assertEqual(len(locator.io_events), 1)
        self.assertEqual(locator.calls[0]["declared_media_type"], "application/pdf")
        self.assertIs(locator.calls[0]["allow_static_landing_discovery"], True)
        self.assertEqual(len(deliveries), 2)
        with deliveries[0].content.open() as stream:
            self.assertTrue(stream.read().startswith(b"<html>"))
        with deliveries[1].content.open() as stream:
            self.assertTrue(stream.read().startswith(b"%PDF"))

    def test_unpaywall_generic_url_is_only_a_fallback_without_pdf_or_landing(self) -> None:
        request, evidence = _request(
            identifiers=(Identifier(namespace="doi", value="10.5555/example"),)
        )
        payload = json.dumps(
            {
                "doi": "10.5555/example",
                "is_oa": True,
                "oa_locations": [
                    {
                        "url_for_pdf": "https://example.test/direct.pdf",
                        "url": "https://example.test/direct-generic",
                    },
                    {
                        "url_for_landing_page": "https://example.test/landing",
                        "url": "https://example.test/landing-generic",
                    },
                    {"url": "https://example.test/generic-only"},
                ],
            }
        ).encode("utf-8")
        locator = _LocatorFake((None, None, None))

        list(
            _unpaywall(_HttpFake((_response(payload),)), locator)._deliveries(
                request,
                evidence,
                CandidateKeyTracker(),
            )
        )

        self.assertEqual(
            [call["locator"] for call in locator.calls],
            [
                "https://example.test/direct.pdf",
                "https://example.test/landing",
                "https://example.test/generic-only",
            ],
        )

    def test_public_protocol_json_rejects_duplicate_keys_and_nonfinite_constants(self) -> None:
        cases = (
            (
                _europe_pmc,
                Identifier(namespace="pmcid", value="PMC7759461"),
                b'{"hitCount": 0, "hitCount": 0}',
                "acquisition-europe-pmc-protocol",
            ),
            (
                _europe_pmc,
                Identifier(namespace="pmcid", value="PMC7759461"),
                b'{"hitCount": NaN}',
                "acquisition-europe-pmc-protocol",
            ),
            (
                _unpaywall,
                Identifier(namespace="doi", value="10.5555/example"),
                b'{"doi":"10.5555/example","is_oa":true,"is_oa":true}',
                "acquisition-unpaywall-protocol",
            ),
            (
                _unpaywall,
                Identifier(namespace="doi", value="10.5555/example"),
                b'{"doi":"10.5555/example","is_oa":NaN}',
                "acquisition-unpaywall-protocol",
            ),
        )
        for factory, identifier, payload, expected_code in cases:
            with self.subTest(expected_code=expected_code, payload=payload):
                request, evidence = _request(identifiers=(identifier,))
                with self.assertRaises(AcquisitionFailure) as caught:
                    list(
                        factory(
                            _HttpFake((_response(payload),)),
                            _LocatorFake(),
                        )._deliveries(request, evidence, CandidateKeyTracker())
                    )
                self.assertEqual(caught.exception.failure.code, expected_code)

    def test_unpaywall_no_oa_no_location_and_api_not_found_are_normal_misses(self) -> None:
        request, evidence = _request(
            identifiers=(Identifier(namespace="doi", value="10.5555/example"),)
        )
        responses = (
            _response(_fixture("unpaywall", "no-oa.json")),
            _response(_fixture("unpaywall", "no-location.json")),
            _response(status=404),
        )
        for response in responses:
            with self.subTest(status=response.status, body=bool(response.body)):
                locator = _LocatorFake()
                deliveries = list(
                    _unpaywall(_HttpFake((response,)), locator)._deliveries(
                        request,
                        evidence,
                        CandidateKeyTracker(),
                    )
                )
                self.assertEqual(deliveries, [])
                self.assertEqual(locator.calls, [])

    def test_unpaywall_rejects_doi_mismatch_unsafe_locator_and_malformed_or_html_api(
        self,
    ) -> None:
        request, evidence = _request(
            identifiers=(Identifier(namespace="doi", value="10.5555/example"),)
        )
        payloads = (
            _fixture("unpaywall", "mismatch.json"),
            _fixture("unpaywall", "unsafe.json"),
            _fixture("unpaywall", "malformed.json"),
            b"<html>service error</html>",
        )
        for payload in payloads:
            with self.subTest(payload=payload[:20]):
                with self.assertRaises(AcquisitionFailure) as caught:
                    list(
                        _unpaywall(
                            _HttpFake((_response(payload),)),
                            _LocatorFake(),
                        )._deliveries(request, evidence, CandidateKeyTracker())
                    )
                self.assertEqual(caught.exception.failure.code, "acquisition-unpaywall-protocol")

    def test_lookup_claim_happens_before_io_and_excluded_lookup_does_no_io(self) -> None:
        cases = (
            (
                "arxiv/public/lookup/2106.14834",
                _arxiv,
                (Identifier(namespace="arxiv", value="2106.14834"),),
            ),
            (
                "europe-pmc/public/lookup/PMC7759461",
                _europe_pmc,
                (Identifier(namespace="pmcid", value="PMC7759461"),),
            ),
            (
                "unpaywall/public/lookup/10.5555/example",
                _unpaywall,
                (Identifier(namespace="doi", value="10.5555/example"),),
            ),
        )
        for key, factory, identifiers in cases:
            with self.subTest(key=key):
                request, evidence = _request(
                    identifiers=identifiers,
                    excluded_candidate_keys=frozenset({key}),
                )
                http = _HttpFake(())
                deliveries = list(
                    factory(http, _LocatorFake())._deliveries(
                        request,
                        evidence,
                        CandidateKeyTracker(request.excluded_candidate_keys),
                    )
                )
                self.assertEqual(deliveries, [])
                self.assertEqual(http.calls, [])

    def test_request_and_evidence_mismatch_is_a_system_failure_before_any_io(self) -> None:
        cases = (
            (
                _arxiv,
                Identifier(namespace="arxiv", value="2106.14834"),
                Identifier(namespace="arxiv", value="2201.00001"),
                "acquisition-arxiv-evidence-mismatch",
            ),
            (
                _europe_pmc,
                Identifier(namespace="pmcid", value="PMC7759461"),
                Identifier(namespace="pmcid", value="PMC1"),
                "acquisition-europe-pmc-evidence-mismatch",
            ),
            (
                _unpaywall,
                Identifier(namespace="doi", value="10.5555/example"),
                Identifier(namespace="doi", value="10.5555/different"),
                "acquisition-unpaywall-evidence-mismatch",
            ),
        )
        for factory, request_identifier, evidence_identifier, expected_code in cases:
            with self.subTest(expected_code=expected_code):
                request, _ = _request(identifiers=(request_identifier,))
                _, wrong_evidence = _request(identifiers=(evidence_identifier,))
                http = _HttpFake(())
                locator = _LocatorFake()

                with self.assertRaises(AcquisitionFailure) as caught:
                    list(
                        factory(http, locator)._deliveries(
                            request,
                            wrong_evidence,
                            CandidateKeyTracker(),
                        )
                    )

                self.assertEqual(caught.exception.failure.code, expected_code)
                self.assertEqual(http.calls, [])
                self.assertEqual(locator.calls, [])

    def test_locator_candidate_claim_happens_before_io_and_exclusion_skips_access(self) -> None:
        request, evidence = _request(
            identifiers=(Identifier(namespace="arxiv", value="2106.14834"),)
        )
        key = "arxiv/public/2106.14834v2"
        locator = _LocatorFake()
        deliveries = list(
            _arxiv(
                _HttpFake((_response(_fixture("arxiv", "success.xml")),)),
                locator,
            )._deliveries(request, evidence, CandidateKeyTracker((key,)))
        )
        self.assertEqual(deliveries, [])
        self.assertEqual(locator.io_events, [])

    def test_lookup_access_and_http_statuses_are_system_failures_but_404_is_not(self) -> None:
        cases = (
            (
                _arxiv,
                (Identifier(namespace="arxiv", value="2106.14834"),),
                "acquisition-arxiv",
            ),
            (
                _europe_pmc,
                (Identifier(namespace="pmcid", value="PMC7759461"),),
                "acquisition-europe-pmc",
            ),
            (
                _unpaywall,
                (Identifier(namespace="doi", value="10.5555/example"),),
                "acquisition-unpaywall",
            ),
        )
        for factory, identifiers, prefix in cases:
            request, evidence = _request(identifiers=identifiers)
            for action, suffix in (
                (_access_failure(), "access"),
                (_response(status=401), "http-status"),
                (_response(status=403), "http-status"),
                (_response(status=429), "http-status"),
                (_response(status=500), "http-status"),
            ):
                with self.subTest(
                    source=prefix,
                    action=type(action).__name__,
                    status=getattr(action, "status", None),
                ):
                    with self.assertRaises(AcquisitionFailure) as caught:
                        list(
                            factory(_HttpFake((action,)), _LocatorFake())._deliveries(
                                request,
                                evidence,
                                CandidateKeyTracker(),
                            )
                        )
                    self.assertEqual(caught.exception.failure.code, f"{prefix}-{suffix}")

    def test_provider_api_redirect_status_is_never_a_normal_miss(self) -> None:
        cases = (
            (_arxiv, Identifier(namespace="arxiv", value="2106.14834")),
            (_europe_pmc, Identifier(namespace="pmcid", value="PMC7759461")),
            (_unpaywall, Identifier(namespace="doi", value="10.5555/example")),
        )
        for factory, identifier in cases:
            with self.subTest(factory=factory.__name__):
                request, evidence = _request(identifiers=(identifier,))
                with self.assertRaises(AcquisitionFailure):
                    list(
                        factory(
                            _HttpFake((_response(status=302),)),
                            _LocatorFake(),
                        )._deliveries(request, evidence, CandidateKeyTracker())
                    )

    def test_lookup_cancellation_is_forwarded_and_never_enters_locator_access(self) -> None:
        cancel_event = threading.Event()
        cancel_event.set()
        cancelled = AccessFailure(
            code="cancelled",
            reason="access operation cancelled",
            action="retry when ready",
            retryable=True,
        )
        cases = (
            (
                _arxiv,
                (Identifier(namespace="arxiv", value="2106.14834"),),
            ),
            (
                _europe_pmc,
                (Identifier(namespace="pmcid", value="PMC7759461"),),
            ),
            (
                _unpaywall,
                (Identifier(namespace="doi", value="10.5555/example"),),
            ),
        )
        for factory, identifiers in cases:
            with self.subTest(factory=factory.__name__):
                request, evidence = _request(identifiers=identifiers)
                http = _HttpFake((cancelled,))
                locator = _LocatorFake()

                with self.assertRaises(AcquisitionFailure) as caught:
                    list(
                        factory(http, locator, cancel_event=cancel_event)._deliveries(
                            request,
                            evidence,
                            CandidateKeyTracker(),
                        )
                    )

                self.assertEqual(caught.exception.failure.code, "acquisition-interrupted")
                self.assertIs(http.calls[0][1]["cancel_event"], cancel_event)
                self.assertEqual(locator.calls, [])

    def test_lookup_failure_is_not_reclassified_by_a_concurrently_set_cancel_event(
        self,
    ) -> None:
        cancel_event = threading.Event()
        cancel_event.set()
        transport_failure = AccessFailure(
            code="transport",
            reason="network access failed",
            action="retry later",
            retryable=True,
        )
        cases = (
            (
                _arxiv,
                (Identifier(namespace="arxiv", value="2106.14834"),),
                "acquisition-arxiv-access",
            ),
            (
                _europe_pmc,
                (Identifier(namespace="pmcid", value="PMC7759461"),),
                "acquisition-europe-pmc-access",
            ),
            (
                _unpaywall,
                (Identifier(namespace="doi", value="10.5555/example"),),
                "acquisition-unpaywall-access",
            ),
        )
        for factory, identifiers, expected_code in cases:
            with self.subTest(expected_code=expected_code):
                request, evidence = _request(identifiers=identifiers)
                http = _HttpFake((transport_failure,))
                locator = _LocatorFake()

                with self.assertRaises(AcquisitionFailure) as caught:
                    list(
                        factory(http, locator, cancel_event=cancel_event)._deliveries(
                            request,
                            evidence,
                            CandidateKeyTracker(),
                        )
                    )

                self.assertEqual(caught.exception.failure.code, expected_code)
                self.assertIs(http.calls[0][1]["cancel_event"], cancel_event)
                self.assertEqual(locator.calls, [])

    def test_source_constructors_reject_non_event_cancellation_values(self) -> None:
        invalid = cast(threading.Event, object())
        for factory in (_arxiv, _europe_pmc, _unpaywall):
            with self.subTest(factory=factory.__name__):
                with self.assertRaises(TypeError):
                    factory(_HttpFake(()), _LocatorFake(), cancel_event=invalid)

    def test_throttling_feedback_is_applied_for_429_and_server_failures(self) -> None:
        request, evidence = _request(
            identifiers=(Identifier(namespace="arxiv", value="2106.14834"),)
        )
        for status in (429, 500):
            headers = (Header(name="Retry-After", value="9"),) if status == 429 else ()
            http = _HttpFake((_response(status=status, headers=headers),))
            with self.assertRaises(AcquisitionFailure):
                list(
                    _arxiv(http, _LocatorFake())._deliveries(
                        request,
                        evidence,
                        CandidateKeyTracker(),
                    )
                )
            feedback = cast(AccessFeedback, http.feedback[0])
            self.assertIsNotNone(feedback)
            self.assertTrue(feedback.throttled)
            self.assertEqual(feedback.retry_after, 9.0 if status == 429 else None)

    def test_short_circuit_close_does_not_prepare_later_locators_and_closes_current(self) -> None:
        request, evidence = _request(
            identifiers=(Identifier(namespace="pmcid", value="PMC7759461"),)
        )
        locator = _LocatorFake(("yield", "yield"))
        iterator = _europe_pmc(
            _HttpFake((_response(_fixture("europe_pmc", "success.json")),)),
            locator,
        )._deliveries(request, evidence, CandidateKeyTracker())

        first = next(iterator)
        self.assertEqual(first.candidate.source_name, "europe-pmc")
        close = getattr(iterator, "close")
        close()

        self.assertEqual(len(locator.calls), 1)
        self.assertEqual(locator.close_count, 1)

    def test_locator_iterator_cleanup_failure_is_a_system_failure(self) -> None:
        request, evidence = _request(
            identifiers=(Identifier(namespace="arxiv", value="2106.14834"),)
        )
        with self.assertRaises(AcquisitionFailure) as caught:
            list(
                _arxiv(
                    _HttpFake((_response(_fixture("arxiv", "success.xml")),)),
                    _LocatorFake(("close-fail",)),
                )._deliveries(request, evidence, CandidateKeyTracker())
            )
        self.assertEqual(caught.exception.failure.code, "acquisition-arxiv-cleanup")

    def test_candidate_keys_are_stable_url_hashes_without_locator_text(self) -> None:
        request, evidence = _request(
            identifiers=(Identifier(namespace="pmcid", value="PMC7759461"),)
        )
        locator = _LocatorFake((None, None))
        list(
            _europe_pmc(
                _HttpFake((_response(_fixture("europe_pmc", "success.json")),)),
                locator,
            )._deliveries(request, evidence, CandidateKeyTracker())
        )
        for call in locator.calls:
            url = cast(str, call["locator"])
            digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
            self.assertEqual(call["candidate_key"], f"europe-pmc/public/pdf/{digest}")
            self.assertNotIn(url, cast(str, call["candidate_key"]))

    def test_source_failure_never_publishes_false_exhaustion(self) -> None:
        request, _ = _request(identifiers=(Identifier(namespace="arxiv", value="2106.14834"),))
        cancel_event = threading.Event()
        cancel_event.set()
        actions = (
            (_response(status=500), None, "acquisition-arxiv-http-status"),
            (
                AccessFailure(
                    code="cancelled",
                    reason="access operation cancelled",
                    action="retry when ready",
                    retryable=True,
                ),
                cancel_event,
                "acquisition-interrupted",
            ),
            (
                AccessFailure(
                    code="transport",
                    reason="network access failed",
                    action="retry later",
                    retryable=True,
                ),
                cancel_event,
                "acquisition-arxiv-access",
            ),
        )
        for action, event, expected_code in actions:
            with self.subTest(action=type(action).__name__, cancelled=event is not None):
                source = _arxiv(
                    _HttpFake((action,)),
                    _LocatorFake(),
                    cancel_event=event,
                )
                exhaustion = _ExhaustionPort()
                catalog = PublisherAccessProfileCatalog(())
                spec = RouteSpec(
                    route_key=source.route_key,
                    tier=AcquisitionPath.PUBLIC,
                    capability=RouteCapability.PUBLIC_PROTOCOL,
                    readiness=RouteReadiness.READY,
                    required_identifier_namespaces=("arxiv",),
                    required_provider_record_names=("arxiv",),
                )
                registry = AcquisitionRouteRegistry(
                    profile_catalog=catalog,
                    bindings=(RouteAdapterBinding(spec=spec, adapter=source),),
                )
                service = TieredAcquisitionService(
                    route_registry=registry,
                    planner=ProgressiveAcquisitionPlanner(
                        resolver=PublisherAccessResolver(catalog),
                        builder=AcquisitionPlanBuilder(catalog),
                        route_specs=(spec,),
                        doi_landing_resolver=None,
                    ),
                    publication_port=_PublicationPort(),
                    exhaustion_port=exhaustion,
                    exhaustion_clear_port=_ClearPort(),
                )

                with self.assertRaises(AcquisitionFailure) as raised:
                    service.prepare_primary_pdf(request)
                self.assertEqual(raised.exception.failure.code, expected_code)
                self.assertEqual(exhaustion.calls, 0)


class _PublicationPort:
    def prepare_primary_pdf(
        self,
        request: AcquisitionRequest,
        temporary_pdf: TemporaryPdf,
        *,
        cancel_event: object | None = None,
    ) -> None:
        del request, temporary_pdf, cancel_event
        return None

    def commit_primary_pdf(self, prepared: PrimaryPdfPreparation) -> AcquiredPrimaryPdf:
        del prepared
        raise AssertionError("normal miss must not create a candidate commit")


class _ExhaustionPort:
    def __init__(self) -> None:
        self.calls = 0

    def publish_exhaustion(self, command: object) -> AutomaticPdfAcquisitionExhaustion:
        self.calls += 1
        expected_facts = getattr(command, "expected_facts")
        return AutomaticPdfAcquisitionExhaustion(
            literature_id=expected_facts.literature_id,
        )


class _ClearPort:
    def clear_exhaustion(self, expected_facts: AcquisitionExpectedFacts) -> None:
        del expected_facts


if __name__ == "__main__":
    unittest.main()
