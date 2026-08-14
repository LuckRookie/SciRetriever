from __future__ import annotations

import inspect
import threading
import unittest
from collections.abc import Callable, Iterable, Iterator
from contextlib import AbstractContextManager
from dataclasses import dataclass
from io import BytesIO
from typing import BinaryIO, cast

from PyPDF2 import PdfWriter

from sciretriever.acquisition.outcomes import RouteOutcome
from sciretriever.acquisition.ports import (
    AcquisitionExpectedFacts,
    AcquisitionFailure,
    CandidateKeyTracker,
    TemporaryPdf,
)
from sciretriever.acquisition.routes import RouteExecutionContext
from sciretriever.acquisition.routing import (
    AcquisitionEvidence,
    AcquisitionRequest,
    build_acquisition_evidence,
)
from sciretriever.acquisition.rules import PdfValidationError, validate_pdf
from sciretriever.acquisition.sources.direct import (
    DirectPdfSource,
    PublicLocatorFetcher,
    WebAccessProfileResolver,
)
from sciretriever.acquisition.sources.doi_landing import DoiLandingResolver
from sciretriever.literature.content import metadata_sha256
from sciretriever.model.access import Header, TransportRequest
from sciretriever.model.acquisition import (
    AcquisitionPath,
    AssetHint,
    AssetHintKind,
    AssetRole,
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
from sciretriever.network.admission import (
    AccessCoordinator,
    AccessPermit,
    AccessPolicy,
    AccessScope,
    HostPermit,
)
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import normalize_url
from sciretriever.storage.pdf_validation_staging import SystemPdfValidationStaging

_TIME = UtcTimestamp("2026-08-11T12:00:00Z")
_PUBLIC_IP = "93.184.216.34"
_PDF_VALIDATION_STAGING = SystemPdfValidationStaging()


def _id(index: int) -> str:
    return f"{index:08x}-e89b-12d3-a456-426614174000"


class _IdFactory:
    def __init__(self, start: int = 1000) -> None:
        self._next = start

    def __call__(self) -> ProvenanceId:
        value = ProvenanceId(_id(self._next))
        self._next += 1
        return value


class _Resolver:
    def __init__(self, answers: dict[str, tuple[str, ...]]) -> None:
        self.answers = answers
        self.calls: list[str] = []

    def resolve(self, hostname: str) -> Iterable[str]:
        self.calls.append(hostname)
        return self.answers[hostname]


class _SequentialResolver(_Resolver):
    def __init__(self, answers: dict[str, list[tuple[str, ...]]]) -> None:
        super().__init__({})
        self.sequential_answers = answers

    def resolve(self, hostname: str) -> Iterable[str]:
        self.calls.append(hostname)
        return self.sequential_answers[hostname].pop(0)


@dataclass(slots=True)
class _RawResponse:
    status: int
    headers: tuple[Header, ...] = ()
    body: bytes | Iterable[bytes] = b""
    closed: bool = False

    def close(self) -> None:
        self.closed = True


TransportAction = Callable[
    [object, object, tuple[tuple[str, str], ...], threading.Event | None], object
]


class _FakeTransport:
    def __init__(self, actions: Iterable[object]) -> None:
        self.actions = list(actions)
        self.calls: list[dict[str, object]] = []
        self.closed = False

    def send(
        self,
        request: object,
        destination: object,
        *,
        headers: tuple[tuple[str, str], ...],
        request_target_renderer: object,
        connect_timeout_seconds: float,
        read_timeout_seconds: float,
        tls_server_hostname: str | None,
        cancel_event: threading.Event | None,
    ) -> object:
        self.calls.append(
            {
                "request": request,
                "destination": destination,
                "headers": headers,
                "request_target_renderer": request_target_renderer,
                "connect_timeout_seconds": connect_timeout_seconds,
                "read_timeout_seconds": read_timeout_seconds,
                "tls_server_hostname": tls_server_hostname,
                "cancel_event": cancel_event,
            }
        )
        if not self.actions:
            raise AssertionError("unexpected transport call")
        action = self.actions.pop(0)
        if callable(action):
            return cast(TransportAction, action)(request, destination, headers, cancel_event)
        if isinstance(action, BaseException):
            raise action
        return action

    def close(self) -> None:
        self.closed = True


class _Clock:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


class _RecordingCoordinator(AccessCoordinator):
    """Advance only admission time so mandatory web cooldown stays test-fast."""

    def __init__(self) -> None:
        self.test_clock = _Clock()
        super().__init__(clock=self.test_clock)
        self.scopes: list[tuple[AccessScope, AccessPolicy | None]] = []
        self.hosts: list[str] = []

    def acquire_scope(
        self,
        scope: AccessScope,
        policy: AccessPolicy | None = None,
        *,
        operator_policy: AccessPolicy | None = None,
        cancel_event: threading.Event | None = None,
        timeout: float | None = None,
    ) -> AccessPermit:
        self.test_clock.advance(31.0)
        self.scopes.append((scope, policy))
        return super().acquire_scope(
            scope,
            policy,
            operator_policy=operator_policy,
            cancel_event=cancel_event,
            timeout=timeout,
        )

    def _acquire_host(
        self,
        owner: AccessPermit,
        host: str,
        *,
        cancel_event: threading.Event | None,
        timeout: float | None,
    ) -> HostPermit:
        self.hosts.append(host)
        return super()._acquire_host(
            owner,
            host,
            cancel_event=cancel_event,
            timeout=timeout,
        )


def _raw(
    status: int = 200,
    *,
    body: bytes = b"bytes",
    location: str | None = None,
    media_type: str | None = None,
) -> _RawResponse:
    headers: list[Header] = []
    if location is not None:
        headers.append(Header(name="Location", value=location))
    if media_type is not None:
        headers.append(Header(name="Content-Type", value=media_type))
    return _RawResponse(status=status, headers=tuple(headers), body=body)


def _valid_pdf() -> bytes:
    output = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.write(output)
    return output.getvalue()


def _http_environment(
    actions: Iterable[object],
    answers: dict[str, tuple[str, ...]],
    *,
    resolver: _Resolver | None = None,
) -> tuple[HttpClient, _FakeTransport, _Resolver, _RecordingCoordinator]:
    transport = _FakeTransport(actions)
    actual_resolver = _Resolver(answers) if resolver is None else resolver
    coordinator = _RecordingCoordinator()
    client = HttpClient(
        resolver=actual_resolver,
        transport=transport,
        coordinator=coordinator,
        max_retries=0,
    )
    return client, transport, actual_resolver, coordinator


def _fetcher(
    client: HttpClient,
    *,
    web_access_profile_resolver: WebAccessProfileResolver | None = None,
) -> PublicLocatorFetcher:
    return PublicLocatorFetcher(
        http_client=client,
        web_access_profile_resolver=web_access_profile_resolver,
        provenance_id_factory=_IdFactory(),
        clock=lambda: _TIME,
    )


def _literature(
    *,
    identifiers: tuple[Identifier, ...] = (),
    publisher: str | None = None,
) -> Literature:
    return Literature(
        literature_id=LiteratureId(_id(1)),
        meta_literature_id=MetaLiteratureId(_id(2)),
        version_role=VersionRole.PUBLISHED,
        metadata=LiteratureMetadata(
            title="Direct-source fixture",
            identifiers=identifiers,
            publisher=publisher,
        ),
        status=LiteratureStatus.UNREVIEWED,
    )


def _observation(
    index: int,
    hints: tuple[AssetHint, ...],
    *,
    provider_name: str = "fixture-metadata",
) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_id(index)),
        provenance=Provenance(
            provenance_id=ProvenanceId(_id(index + 100)),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=provider_name,
            source_record_id=f"record-{index}",
            observed_at=_TIME,
            input_sha256=Sha256("a" * 64),
            parameters_sha256=None,
        ),
        metadata=LiteratureMetadata(title="Observed fixture"),
        asset_hints=hints,
    )


def _request(
    *,
    observations: tuple[MetadataObservation, ...] = (),
    literature: Literature | None = None,
) -> AcquisitionRequest:
    target = literature or _literature()
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
    )


def _evidence(request: AcquisitionRequest) -> AcquisitionEvidence:
    return build_acquisition_evidence(request)


def _route_deliveries(
    source: DirectPdfSource,
    request: AcquisitionRequest,
    evidence: AcquisitionEvidence,
    tracker: CandidateKeyTracker,
) -> Iterator[TemporaryPdf]:
    results = source.execute(
        RouteExecutionContext(
            request=request,
            evidence=evidence,
            route_hints=(),
            candidate_keys=tracker,
        )
    )
    for result in results:
        if result.outcome is RouteOutcome.PDF_DELIVERED:
            temporary_pdf = result.temporary_pdf
            if temporary_pdf is None:
                raise AssertionError("delivery result lost its TemporaryPdf")
            yield temporary_pdf
        elif result.outcome is not RouteOutcome.NORMAL_MISS:
            raise AssertionError(f"unexpected direct route outcome: {result.outcome}")


def _payload(temporary_pdf: TemporaryPdf) -> bytes:
    context = temporary_pdf.content.open()
    if not isinstance(context, AbstractContextManager):
        raise AssertionError("temporary content did not return a context manager")
    with context as stream:
        return cast(BinaryIO, stream).read()


def _request_url(call: dict[str, object]) -> str:
    request = call["request"]
    if not isinstance(request, TransportRequest):
        raise AssertionError("transport did not receive a TransportRequest")
    return request.url


class AcquisitionDirectSourceTests(unittest.TestCase):
    def test_web_access_profile_resolver_is_local_and_unknown_hosts_use_safe_default(
        self,
    ) -> None:
        resolver = WebAccessProfileResolver()

        scope, policy = resolver.resolve(normalize_url("https://UNKNOWN.test:443/file"))

        self.assertEqual(scope, AccessScope("unknown.test", "web"))
        self.assertEqual(policy.max_concurrency, 1)
        self.assertGreaterEqual(policy.min_start_interval, 1.0)
        self.assertEqual(policy.cooldown_after_completion, 0.0)

    def test_known_hosts_share_provider_web_scope_and_all_policies_only_tighten(self) -> None:
        provider_scope = AccessScope("fixture-publisher", "web")
        injected_profile_policy = AccessPolicy(
            max_concurrency=8,
            min_start_interval=3.0,
            cooldown_after_completion=2.0,
        )
        operator_policy = AccessPolicy(
            max_concurrency=99,
            min_start_interval=7.0,
            cooldown_after_completion=1.0,
        )
        profile_resolver = WebAccessProfileResolver(
            {
                "articles.publisher.test": (provider_scope, injected_profile_policy),
                "downloads.publisher.test": (provider_scope, injected_profile_policy),
            }
        )
        client, transport, _resolver, coordinator = _http_environment(
            [_raw(body=b"article"), _raw(body=b"download")],
            {
                "articles.publisher.test": (_PUBLIC_IP,),
                "downloads.publisher.test": (_PUBLIC_IP,),
            },
        )
        fetcher = PublicLocatorFetcher(
            http_client=client,
            web_access_profile_resolver=profile_resolver,
            access_policy=operator_policy,
            provenance_id_factory=_IdFactory(),
            clock=lambda: _TIME,
        )
        tracker = CandidateKeyTracker()

        deliveries = [
            *fetcher.acquire(
                locator="https://articles.publisher.test/article",
                candidate_key="fixture:known-profile:article",
                source_name="fixture-source",
                source_record_id=None,
                declared_media_type=None,
                candidate_keys=tracker,
                allow_static_landing_discovery=False,
            ),
            *fetcher.acquire(
                locator="https://downloads.publisher.test/file",
                candidate_key="fixture:known-profile:download",
                source_name="fixture-source",
                source_record_id=None,
                declared_media_type=None,
                candidate_keys=tracker,
                allow_static_landing_discovery=False,
            ),
        ]

        self.assertEqual(len(transport.calls), 2)
        self.assertEqual([scope for scope, _policy in coordinator.scopes], [provider_scope] * 2)
        expected_policy = AccessPolicy.strictest(
            AccessPolicy(max_concurrency=1, min_start_interval=1.0),
            injected_profile_policy,
            operator_policy,
        )
        self.assertEqual(
            [policy for _scope, policy in coordinator.scopes],
            [expected_policy] * 2,
        )
        for delivery in deliveries:
            delivery.content.discard()

    def test_web_access_profile_rejects_non_web_scope(self) -> None:
        with self.assertRaises(ValueError):
            WebAccessProfileResolver(
                {
                    "publisher.test": (
                        AccessScope("fixture-publisher", "api"),
                        AccessPolicy(max_concurrency=1),
                    )
                }
            )

    def test_route_ignores_weak_and_non_primary_hints_without_network_io(
        self,
    ) -> None:
        client, transport, _resolver, _coordinator = _http_environment([], {})
        source = DirectPdfSource(fetcher=_fetcher(client))

        self.assertEqual(source.source_name, "direct")
        self.assertIs(source.acquisition_path, AcquisitionPath.PUBLIC)
        weak_request = _request(
            literature=_literature(
                identifiers=(Identifier(namespace="doi", value="10.1234/weak"),),
                publisher="Publisher text is not routing authority",
            )
        )
        self.assertEqual(
            list(
                _route_deliveries(
                    source,
                    weak_request,
                    _evidence(weak_request),
                    CandidateKeyTracker(),
                )
            ),
            [],
        )

        non_primary = _observation(
            10,
            (
                AssetHint(
                    url="https://content.test/supplement.pdf",
                    kind=AssetHintKind.DIRECT_FILE,
                    asset_role=AssetRole.SUPPLEMENTARY_PDF,
                ),
                AssetHint(
                    url="https://content.test/article.xml",
                    kind=AssetHintKind.DIRECT_FILE,
                    asset_role=AssetRole.XML,
                ),
                AssetHint(
                    url="https://content.test/article",
                    kind=AssetHintKind.LANDING_PAGE,
                    asset_role=AssetRole.HTML,
                ),
            ),
        )
        request = _request(observations=(non_primary,))
        evidence = _evidence(request)
        self.assertEqual(
            list(_route_deliveries(source, request, evidence, CandidateKeyTracker())),
            [],
        )
        self.assertEqual(transport.calls, [])

    def test_direct_first_stable_order_canonical_dedup_and_claim_before_io(self) -> None:
        tracker = CandidateKeyTracker()
        responses = [_raw(body=b"first"), _raw(body=b"second"), _raw(body=b"<html></html>")]

        def assert_claimed(
            _request_value: object,
            _destination: object,
            _headers: tuple[tuple[str, str], ...],
            _cancel: threading.Event | None,
        ) -> object:
            self.assertGreaterEqual(len(tracker.tried_candidate_keys), 1)
            return responses.pop(0)

        client, transport, _resolver, coordinator = _http_environment(
            [assert_claimed, assert_claimed, assert_claimed],
            {"content.test": (_PUBLIC_IP,)},
        )
        hints = (
            AssetHint(
                url="https://content.test/landing",
                kind=AssetHintKind.LANDING_PAGE,
            ),
            AssetHint(
                url="https://CONTENT.test:443/b",
                kind=AssetHintKind.DIRECT_FILE,
            ),
            AssetHint(
                url="https://content.test/a",
                kind=AssetHintKind.DIRECT_FILE,
            ),
            AssetHint(
                url="https://content.test/b",
                kind=AssetHintKind.DIRECT_FILE,
                media_type="application/pdf",
            ),
        )
        request = _request(observations=(_observation(11, hints),))
        evidence = _evidence(request)
        source = DirectPdfSource(fetcher=_fetcher(client))

        deliveries = list(_route_deliveries(source, request, evidence, tracker))

        self.assertEqual(
            [_payload(item) for item in deliveries],
            [b"first", b"second", b"<html></html>"],
        )
        self.assertEqual(
            [_request_url(call) for call in transport.calls],
            [
                "https://content.test/b",
                "https://content.test/a",
                "https://content.test/landing",
            ],
        )
        self.assertEqual(len(tracker.tried_candidate_keys), 3)
        for key in tracker.tried_candidate_keys:
            self.assertNotIn("content.test", key)
            self.assertNotIn("://", key)
        for item in deliveries:
            self.assertIn(item.candidate.candidate_key, tracker.tried_candidate_keys)
            self.assertEqual(item.candidate.source_name, "direct")
            self.assertIs(item.candidate.acquisition_path, AcquisitionPath.PUBLIC)
            self.assertIsNone(item.provenance.source_record_id)
            item.content.discard()
        self.assertTrue(
            all(
                scope.provider_name == "content.test"
                and scope.channel == "web"
                and policy is not None
                and policy.max_concurrency == 1
                and policy.min_start_interval >= 1.0
                and policy.cooldown_after_completion == 0.0
                for scope, policy in coordinator.scopes
            )
        )

    def test_first_hint_transport_failure_does_not_hide_a_later_hint_candidate(self) -> None:
        client, transport, _resolver, _coordinator = _http_environment(
            [TimeoutError("fixture timeout"), _raw(body=_valid_pdf())],
            {
                "timeout.test": (_PUBLIC_IP,),
                "success.test": (_PUBLIC_IP,),
            },
        )
        hints = (
            AssetHint(
                url="https://timeout.test/article.pdf",
                kind=AssetHintKind.DIRECT_FILE,
            ),
            AssetHint(
                url="https://success.test/article.pdf",
                kind=AssetHintKind.DIRECT_FILE,
            ),
        )
        request = _request(observations=(_observation(12, hints),))
        iterator = iter(
            _route_deliveries(
                DirectPdfSource(fetcher=_fetcher(client)),
                request,
                _evidence(request),
                CandidateKeyTracker(),
            )
        )

        delivery = next(iterator)

        self.assertEqual(delivery.safe_source_url, "https://success.test/article.pdf")
        self.assertTrue(_payload(delivery).startswith(b"%PDF-"))
        self.assertEqual(
            [_request_url(call) for call in transport.calls],
            [
                "https://timeout.test/article.pdf",
                "https://success.test/article.pdf",
            ],
        )
        delivery.content.discard()
        close = getattr(iterator, "close", None)
        self.assertTrue(callable(close))
        cast(Callable[[], object], close)()

    def test_asset_hint_evidence_from_another_request_fails_before_io(self) -> None:
        client, transport, _resolver, _coordinator = _http_environment(
            [],
            {"one.test": (_PUBLIC_IP,), "two.test": (_PUBLIC_IP,)},
        )
        first_request = _request(
            observations=(
                _observation(
                    20,
                    (
                        AssetHint(
                            url="https://one.test/article",
                            kind=AssetHintKind.DIRECT_FILE,
                        ),
                    ),
                ),
            )
        )
        other_request = _request(
            observations=(
                _observation(
                    21,
                    (
                        AssetHint(
                            url="https://two.test/other",
                            kind=AssetHintKind.DIRECT_FILE,
                        ),
                    ),
                ),
            )
        )
        source = DirectPdfSource(fetcher=_fetcher(client))

        with self.assertRaises(AcquisitionFailure):
            list(
                _route_deliveries(
                    source,
                    first_request,
                    _evidence(other_request),
                    CandidateKeyTracker(),
                )
            )
        self.assertEqual(transport.calls, [])

    def test_excluded_candidate_is_claimed_without_io_and_candidate_key_never_contains_url(
        self,
    ) -> None:
        first_client, _transport, _resolver, _coordinator = _http_environment(
            [_raw(body=b"candidate")],
            {"content.test": (_PUBLIC_IP,)},
        )
        first_tracker = CandidateKeyTracker()
        first = list(
            _fetcher(first_client).acquire(
                locator="https://content.test/file?version=1",
                candidate_key="public-locator:" + "a" * 64,
                source_name="fixture-source",
                source_record_id="record-1",
                declared_media_type=None,
                candidate_keys=first_tracker,
                allow_static_landing_discovery=False,
            )
        )
        self.assertEqual(len(first), 1)
        first[0].content.discard()

        blocked_key = next(iter(first_tracker.tried_candidate_keys))
        blocked_client, blocked_transport, _resolver, _coordinator = _http_environment(
            [],
            {"content.test": (_PUBLIC_IP,)},
        )
        blocked = list(
            _fetcher(blocked_client).acquire(
                locator="https://content.test/file?version=1",
                candidate_key=blocked_key,
                source_name="fixture-source",
                source_record_id=None,
                declared_media_type=None,
                candidate_keys=CandidateKeyTracker((blocked_key,)),
                allow_static_landing_discovery=False,
            )
        )
        self.assertEqual(blocked, [])
        self.assertEqual(blocked_transport.calls, [])
        self.assertNotIn("://", blocked_key)
        self.assertNotIn("version=1", blocked_key)

    def test_declared_media_types_and_actual_bytes_remain_separate_until_a2(self) -> None:
        client, _transport, _resolver, _coordinator = _http_environment(
            [
                _raw(body=b"<html>not a pdf</html>", media_type="application/pdf"),
                _raw(body=b"%PDF-1.4 fixture", media_type="text/html"),
            ],
            {"one.test": (_PUBLIC_IP,), "two.test": (_PUBLIC_IP,)},
        )
        fetcher = _fetcher(client)
        tracker = CandidateKeyTracker()
        declared_pdf = list(
            fetcher.acquire(
                locator="https://one.test/download",
                candidate_key="fixture:one",
                source_name="fixture-source",
                source_record_id=None,
                declared_media_type="application/pdf",
                candidate_keys=tracker,
                allow_static_landing_discovery=False,
            )
        )
        declared_html = list(
            fetcher.acquire(
                locator="https://two.test/download.pdf",
                candidate_key="fixture:two",
                source_name="fixture-source",
                source_record_id=None,
                declared_media_type=None,
                candidate_keys=tracker,
                allow_static_landing_discovery=False,
            )
        )

        self.assertEqual(_payload(declared_pdf[0]), b"<html>not a pdf</html>")
        self.assertEqual(declared_pdf[0].candidate.declared_media_type, "application/pdf")
        self.assertEqual(_payload(declared_html[0]), b"%PDF-1.4 fixture")
        self.assertEqual(declared_html[0].candidate.declared_media_type, "text/html")
        declared_pdf[0].content.discard()
        declared_html[0].content.discard()

    def test_static_landing_uses_final_page_base_and_only_explicit_pdf_locators(self) -> None:
        page = b"""
            <html><head>
              <meta name="citation_pdf_url" content="/from-meta">
              <link type="application/pdf; charset=binary" href="https://link.test/file">
              <script><a type="application/pdf" href="https://evil.test/script"></a></script>
            </head><body>
              <a type="APPLICATION/PDF" href="https://anchor.test/file">PDF</a>
              <embed type="application/pdf" src="https://embed.test/file">
              <object type="application/pdf" data="https://object.test/file"></object>
              <a href="https://guess.test/looks-like.pdf">not explicit</a>
            </body></html>
        """
        raw_responses = [
            _raw(302, location="https://final.test/articles/page"),
            _raw(body=page, media_type="text/html"),
            *[_raw(body=f"payload-{index}".encode()) for index in range(5)],
        ]
        answers = {
            host: (_PUBLIC_IP,)
            for host in (
                "landing.test",
                "final.test",
                "link.test",
                "anchor.test",
                "embed.test",
                "object.test",
            )
        }
        client, transport, _resolver, _coordinator = _http_environment(raw_responses, answers)
        shared_landing_scope = AccessScope("fixture-publisher", "web")
        landing_profiles = WebAccessProfileResolver(
            {
                "landing.test": (shared_landing_scope, AccessPolicy(max_concurrency=1)),
                "final.test": (shared_landing_scope, AccessPolicy(max_concurrency=1)),
            }
        )
        deliveries = list(
            _fetcher(
                client,
                web_access_profile_resolver=landing_profiles,
            ).acquire(
                locator="https://landing.test/start",
                candidate_key="fixture:landing",
                source_name="fixture-source",
                source_record_id="record-landing",
                declared_media_type="text/html",
                candidate_keys=CandidateKeyTracker(),
                allow_static_landing_discovery=True,
            )
        )

        self.assertEqual(len(deliveries), 6)
        self.assertEqual(
            [item.safe_source_url for item in deliveries],
            [
                "https://final.test/articles/page",
                "https://final.test/from-meta",
                "https://link.test/file",
                "https://anchor.test/file",
                "https://embed.test/file",
                "https://object.test/file",
            ],
        )
        requested = [_request_url(call) for call in transport.calls]
        self.assertNotIn("https://evil.test/script", requested)
        self.assertNotIn("https://guess.test/looks-like.pdf", requested)
        self.assertEqual(
            [item.candidate.declared_media_type for item in deliveries],
            ["text/html", *("application/pdf" for _index in range(5))],
        )
        self.assertEqual(_payload(deliveries[0]), page)
        self.assertTrue(
            all(item.provenance.source_record_id == "record-landing" for item in deliveries)
        )
        self.assertTrue(all(response.closed for response in raw_responses))
        for item in deliveries:
            item.content.discard()

    def test_landing_without_explicit_locator_is_normal_miss_without_script_or_selector_guessing(
        self,
    ) -> None:
        page = b"""
            <script>window.location = '/generated.pdf';</script>
            <a class="download-pdf" href="/guessed.pdf">Download</a>
            <iframe src="/viewer"></iframe>
        """
        client, transport, _resolver, _coordinator = _http_environment(
            [_raw(body=page)],
            {"landing.test": (_PUBLIC_IP,)},
        )
        result = list(
            _fetcher(client).acquire(
                locator="https://landing.test/page",
                candidate_key="fixture:no-static-link",
                source_name="fixture-source",
                source_record_id=None,
                declared_media_type=None,
                candidate_keys=CandidateKeyTracker(),
                allow_static_landing_discovery=True,
            )
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(_payload(result[0]), page)
        result[0].content.discard()
        self.assertEqual(len(transport.calls), 1)

    def test_landing_body_reaches_a2_before_static_discovery_even_with_wrong_media_type(
        self,
    ) -> None:
        payload = _valid_pdf()
        client, transport, _resolver, _coordinator = _http_environment(
            [_raw(body=payload, media_type="text/html")],
            {"landing.test": (_PUBLIC_IP,)},
        )
        fetcher = PublicLocatorFetcher(
            http_client=client,
            max_landing_response_bytes=8,
            provenance_id_factory=_IdFactory(),
            clock=lambda: _TIME,
        )
        iterator = iter(
            fetcher.acquire(
                locator="https://landing.test/article",
                candidate_key="fixture:landing-pdf",
                source_name="fixture-source",
                source_record_id=None,
                declared_media_type="text/html",
                candidate_keys=CandidateKeyTracker(),
                allow_static_landing_discovery=True,
            )
        )

        landing_body = next(iterator)
        self.assertEqual(landing_body.candidate.declared_media_type, "text/html")
        with landing_body.content.open() as source:
            validated = validate_pdf(
                source,
                staging=_PDF_VALIDATION_STAGING,
                candidate_belongs_to_literature=True,
                declared_media_type=landing_body.candidate.declared_media_type,
            )
        validated.close()
        landing_body.content.discard()
        close = getattr(iterator, "close", None)
        self.assertTrue(callable(close))
        cast(Callable[[], object], close)()
        self.assertEqual(len(transport.calls), 1)

    def test_a2_rejects_landing_html_then_iterator_continues_to_explicit_pdf(self) -> None:
        page = b'<meta name="citation_pdf_url" content="/article.pdf">'
        payload = _valid_pdf()
        client, transport, _resolver, _coordinator = _http_environment(
            [_raw(body=page, media_type="application/pdf"), _raw(body=payload)],
            {"landing.test": (_PUBLIC_IP,)},
        )
        iterator = iter(
            _fetcher(client).acquire(
                locator="https://landing.test/page",
                candidate_key="fixture:landing-html",
                source_name="fixture-source",
                source_record_id=None,
                declared_media_type="application/pdf",
                candidate_keys=CandidateKeyTracker(),
                allow_static_landing_discovery=True,
            )
        )

        landing_body = next(iterator)
        with landing_body.content.open() as source:
            with self.assertRaises(PdfValidationError) as caught:
                validate_pdf(
                    source,
                    staging=_PDF_VALIDATION_STAGING,
                    candidate_belongs_to_literature=True,
                    declared_media_type=landing_body.candidate.declared_media_type,
                )
        self.assertTrue(caught.exception.is_candidate_rejection)
        landing_body.content.discard()

        discovered_pdf = next(iterator)
        self.assertEqual(discovered_pdf.safe_source_url, "https://landing.test/article.pdf")
        with discovered_pdf.content.open() as source:
            validated = validate_pdf(
                source,
                staging=_PDF_VALIDATION_STAGING,
                candidate_belongs_to_literature=True,
            )
        validated.close()
        discovered_pdf.content.discard()
        self.assertEqual(list(iterator), [])
        self.assertEqual(len(transport.calls), 2)

    def test_direct_and_multiple_landings_share_canonical_locator_claims(self) -> None:
        target = "https://shared.test/article"
        landing_one = f'<meta name="citation_pdf_url" content="{target}">'.encode()
        landing_two = f'<a type="application/pdf" href="{target}">PDF</a>'.encode()
        client, transport, _resolver, _coordinator = _http_environment(
            [_raw(body=b"direct"), _raw(body=landing_one), _raw(body=landing_two)],
            {
                "shared.test": (_PUBLIC_IP,),
                "one.test": (_PUBLIC_IP,),
                "two.test": (_PUBLIC_IP,),
            },
        )
        hints = (
            AssetHint(url="https://one.test/page", kind=AssetHintKind.LANDING_PAGE),
            AssetHint(url=target, kind=AssetHintKind.DIRECT_FILE),
            AssetHint(url="https://two.test/page", kind=AssetHintKind.LANDING_PAGE),
        )
        request = _request(observations=(_observation(12, hints),))
        tracker = CandidateKeyTracker()
        source = DirectPdfSource(fetcher=_fetcher(client))

        deliveries = list(
            _route_deliveries(
                source,
                request,
                _evidence(request),
                tracker,
            )
        )

        self.assertEqual(
            [_request_url(call) for call in transport.calls],
            [target, "https://one.test/page", "https://two.test/page"],
        )
        self.assertEqual(sum(_request_url(call) == target for call in transport.calls), 1)
        self.assertEqual(
            [_payload(item) for item in deliveries], [b"direct", landing_one, landing_two]
        )
        self.assertEqual(len(tracker.tried_candidate_keys), 3)
        self.assertTrue(all("://" not in key for key in tracker.tried_candidate_keys))
        for item in deliveries:
            item.content.discard()

    def test_duplicate_direct_and_landing_hint_fetch_once_but_preserve_static_discovery(
        self,
    ) -> None:
        page = b'<link type="application/pdf" href="/real">'
        client, transport, _resolver, _coordinator = _http_environment(
            [_raw(body=page), _raw(body=b"real-pdf-candidate")],
            {"same.test": (_PUBLIC_IP,)},
        )
        hints = (
            AssetHint(
                url="https://SAME.test:443/article",
                kind=AssetHintKind.LANDING_PAGE,
            ),
            AssetHint(
                url="https://same.test/article",
                kind=AssetHintKind.DIRECT_FILE,
            ),
        )
        request = _request(observations=(_observation(13, hints),))
        source = DirectPdfSource(fetcher=_fetcher(client))

        deliveries = list(
            _route_deliveries(
                source,
                request,
                _evidence(request),
                CandidateKeyTracker(),
            )
        )

        self.assertEqual(
            [_request_url(call) for call in transport.calls],
            ["https://same.test/article", "https://same.test/real"],
        )
        self.assertEqual([_payload(item) for item in deliveries], [page, b"real-pdf-candidate"])
        for item in deliveries:
            item.content.discard()

    def test_http_statuses_distinguish_normal_miss_from_system_failure(self) -> None:
        for status in (204, 404, 410):
            with self.subTest(status=status, result="miss"):
                client, _transport, _resolver, _coordinator = _http_environment(
                    [_raw(status)],
                    {"status.test": (_PUBLIC_IP,)},
                )
                with self.assertNoLogs(
                    "sciretriever.acquisition.sources.direct",
                    level="INFO",
                ):
                    result = list(
                        _fetcher(client).acquire(
                            locator="https://status.test/file",
                            candidate_key=f"fixture:status:{status}",
                            source_name="fixture-source",
                            source_record_id=None,
                            declared_media_type=None,
                            candidate_keys=CandidateKeyTracker(),
                            allow_static_landing_discovery=False,
                        )
                    )
                self.assertEqual(result, [])

        for status in (300, 400, 401, 403, 429, 500, 503):
            with self.subTest(status=status, result="failure"):
                client, _transport, _resolver, _coordinator = _http_environment(
                    [_raw(status)],
                    {"status.test": (_PUBLIC_IP,)},
                )
                with self.assertLogs(
                    "sciretriever.acquisition.sources.direct",
                    level="INFO",
                ) as captured:
                    with self.assertRaises(AcquisitionFailure):
                        list(
                            _fetcher(client).acquire(
                                locator="https://status.test/file",
                                candidate_key=f"fixture:status:{status}",
                                source_name="fixture-source",
                                source_record_id=None,
                                declared_media_type=None,
                                candidate_keys=CandidateKeyTracker(),
                                allow_static_landing_discovery=False,
                            )
                        )
                output = "\n".join(captured.output)
                self.assertIn("event=public-locator-response-failed", output)
                self.assertIn(f"status={status}", output)
                self.assertIn("code=acquisition-public-locator-response-failed", output)
                self.assertIn(
                    "reason=A public PDF locator returned a non-miss failure response.",
                    output,
                )
                self.assertNotIn("https://", output)
                self.assertNotIn("status.test", output)

    def test_debug_log_records_normal_public_locator_miss_without_locator(self) -> None:
        client, _transport, _resolver, _coordinator = _http_environment(
            [_raw(404)],
            {"private-locator-sentinel.test": (_PUBLIC_IP,)},
        )

        with self.assertLogs(
            "sciretriever.acquisition.sources.direct",
            level="DEBUG",
        ) as captured:
            result = list(
                _fetcher(client).acquire(
                    locator="https://private-locator-sentinel.test/file?opaque=value",
                    candidate_key="fixture:debug-miss",
                    source_name="fixture-source",
                    source_record_id=None,
                    declared_media_type=None,
                    candidate_keys=CandidateKeyTracker(),
                    allow_static_landing_discovery=False,
                )
            )

        self.assertEqual(result, [])
        output = "\n".join(captured.output)
        self.assertIn("event=public-locator-started", output)
        self.assertIn("event=public-locator-finished", output)
        self.assertIn("outcome=miss", output)
        self.assertIn("status=404", output)
        self.assertNotIn("private-locator-sentinel", output)
        self.assertNotIn("opaque=value", output)

    def test_network_cancellation_is_typed_without_masking_a_racing_transport_failure(
        self,
    ) -> None:
        cancel_event = threading.Event()
        cancel_event.set()
        cancelled_client, cancelled_transport, cancelled_resolver, _coordinator = _http_environment(
            [], {}
        )
        cancelled_fetcher = PublicLocatorFetcher(
            http_client=cancelled_client,
            cancel_event=cancel_event,
            provenance_id_factory=_IdFactory(),
            clock=lambda: _TIME,
        )

        with self.assertRaises(AcquisitionFailure) as cancelled:
            list(
                cancelled_fetcher.acquire(
                    locator="https://cancelled.test/file.pdf",
                    candidate_key="fixture:cancelled",
                    source_name="fixture-source",
                    source_record_id=None,
                    declared_media_type="application/pdf",
                    candidate_keys=CandidateKeyTracker(),
                    allow_static_landing_discovery=False,
                )
            )

        self.assertEqual(cancelled.exception.failure.code, "acquisition-interrupted")
        self.assertEqual(cancelled_transport.calls, [])
        self.assertEqual(cancelled_resolver.calls, [])

        racing_cancel_event = threading.Event()

        def fail_transport(
            _request: object,
            _destination: object,
            _headers: tuple[tuple[str, str], ...],
            _cancel_event: threading.Event | None,
        ) -> object:
            racing_cancel_event.set()
            raise RuntimeError("fixture transport failure")

        failed_client, failed_transport, _resolver, _coordinator = _http_environment(
            [fail_transport],
            {"failure.test": (_PUBLIC_IP,)},
        )
        failed_fetcher = PublicLocatorFetcher(
            http_client=failed_client,
            cancel_event=racing_cancel_event,
            provenance_id_factory=_IdFactory(),
            clock=lambda: _TIME,
        )

        with self.assertRaises(AcquisitionFailure) as failed:
            list(
                failed_fetcher.acquire(
                    locator="https://failure.test/file.pdf",
                    candidate_key="fixture:transport-failure",
                    source_name="fixture-source",
                    source_record_id=None,
                    declared_media_type="application/pdf",
                    candidate_keys=CandidateKeyTracker(),
                    allow_static_landing_discovery=False,
                )
            )

        self.assertTrue(racing_cancel_event.is_set())
        self.assertEqual(
            failed.exception.failure.code,
            "acquisition-public-locator-network-failed",
        )
        self.assertEqual(len(failed_transport.calls), 1)

    def test_private_redirect_dns_rebinding_and_policy_fail_closed_without_delivery(self) -> None:
        cases: list[tuple[str, HttpClient, _FakeTransport]] = []

        private_client, private_transport, _resolver, _coordinator = _http_environment(
            [],
            {"private.test": ("127.0.0.1",)},
        )
        cases.append(("private", private_client, private_transport))

        redirect_client, redirect_transport, _resolver, _coordinator = _http_environment(
            [_raw(302, location="https://private.test/file")],
            {"public.test": (_PUBLIC_IP,), "private.test": ("127.0.0.1",)},
        )
        cases.append(("redirect", redirect_client, redirect_transport))

        sequential = _SequentialResolver({"rebind.test": [(_PUBLIC_IP,), ("127.0.0.1",)]})
        rebind_client, rebind_transport, _resolver, _coordinator = _http_environment(
            [_raw(body=b"must-not-be-sent")],
            {},
            resolver=sequential,
        )
        cases.append(("rebind", rebind_client, rebind_transport))

        for name, client, transport in cases:
            with self.subTest(name=name):
                with self.assertRaises(AcquisitionFailure):
                    list(
                        _fetcher(client).acquire(
                            locator=f"https://{name if name != 'redirect' else 'public'}.test/file",
                            candidate_key=f"fixture:{name}",
                            source_name="fixture-source",
                            source_record_id=None,
                            declared_media_type=None,
                            candidate_keys=CandidateKeyTracker(),
                            allow_static_landing_discovery=False,
                        )
                    )
        self.assertEqual(private_transport.calls, [])
        self.assertEqual(len(redirect_transport.calls), 1)
        self.assertEqual(rebind_transport.calls, [])

    def test_same_provider_redirect_uses_one_web_scope_and_actual_host_permits(
        self,
    ) -> None:
        first = _raw(302, location="https://other.test/final")
        second = _raw(body=b"candidate")
        client, transport, _resolver, coordinator = _http_environment(
            [first, second],
            {"start.test": (_PUBLIC_IP,), "other.test": (_PUBLIC_IP,)},
        )
        provider_scope = AccessScope("fixture-publisher", "web")
        profiles = WebAccessProfileResolver(
            {
                "start.test": (provider_scope, AccessPolicy(max_concurrency=1)),
                "other.test": (provider_scope, AccessPolicy(max_concurrency=1)),
            }
        )
        deliveries = list(
            _fetcher(client, web_access_profile_resolver=profiles).acquire(
                locator="https://start.test/redirect",
                candidate_key="fixture:redirect",
                source_name="fixture-source",
                source_record_id=None,
                declared_media_type=None,
                candidate_keys=CandidateKeyTracker(),
                allow_static_landing_discovery=False,
            )
        )

        self.assertEqual(
            [scope for scope, _policy in coordinator.scopes],
            [provider_scope],
        )
        self.assertEqual(coordinator.hosts, ["start.test", "other.test"])
        self.assertEqual(deliveries[0].safe_source_url, "https://other.test/final")
        for call in transport.calls:
            header_names = {
                name.casefold()
                for name, _value in cast(tuple[tuple[str, str], ...], call["headers"])
            }
            self.assertFalse(header_names & {"authorization", "cookie", "proxy-authorization"})
        self.assertTrue(first.closed)
        self.assertTrue(second.closed)
        deliveries[0].content.discard()

    def test_cross_provider_redirect_releases_and_readmits_each_web_scope(
        self,
    ) -> None:
        first = _raw(302, location="https://other.test/final?opaque=private-target-sentinel")
        second = _raw(body=b"candidate")
        client, transport, resolver, coordinator = _http_environment(
            [first, second],
            {"start.test": (_PUBLIC_IP,), "other.test": (_PUBLIC_IP,)},
        )
        start_scope = AccessScope("provider-a", "web")
        target_scope = AccessScope("provider-b", "web")
        profiles = WebAccessProfileResolver(
            {
                "start.test": (start_scope, AccessPolicy(max_concurrency=1)),
                "other.test": (target_scope, AccessPolicy(max_concurrency=1)),
            }
        )

        with self.assertLogs("sciretriever", level="DEBUG") as captured:
            deliveries = list(
                _fetcher(client, web_access_profile_resolver=profiles).acquire(
                    locator="https://start.test/redirect",
                    candidate_key="fixture:cross-provider-redirect",
                    source_name="fixture-source",
                    source_record_id=None,
                    declared_media_type=None,
                    candidate_keys=CandidateKeyTracker(),
                    allow_static_landing_discovery=False,
                )
            )

        self.assertEqual(
            [scope for scope, _policy in coordinator.scopes],
            [start_scope, target_scope],
        )
        self.assertEqual(coordinator.hosts, ["start.test", "other.test"])
        self.assertIn("other.test", resolver.calls)
        self.assertEqual(len(transport.calls), 2)
        self.assertTrue(first.closed)
        self.assertTrue(second.closed)
        self.assertEqual(coordinator._active_scope_permits, {})
        self.assertEqual(coordinator._active_host_permits, {})
        self.assertEqual(
            deliveries[0].safe_source_url,
            "https://other.test/final?opaque=private-target-sentinel",
        )
        self.assertNotIn("private-target-sentinel", "\n".join(captured.output))
        deliveries[0].content.discard()

    def test_same_scope_redirect_tightens_target_profile_without_second_scope_permit(
        self,
    ) -> None:
        first = _raw(302, location="https://strict.test/final")
        second = _raw(body=b"candidate")
        client, transport, resolver, coordinator = _http_environment(
            [first, second],
            {"start.test": (_PUBLIC_IP,), "strict.test": (_PUBLIC_IP,)},
        )
        provider_scope = AccessScope("fixture-publisher", "web")
        profiles = WebAccessProfileResolver(
            {
                "start.test": (provider_scope, AccessPolicy(max_concurrency=1)),
                "strict.test": (
                    provider_scope,
                    AccessPolicy(max_concurrency=1, min_start_interval=45.0),
                ),
            }
        )

        deliveries = list(
            _fetcher(client, web_access_profile_resolver=profiles).acquire(
                locator="https://start.test/redirect",
                candidate_key="fixture:stricter-profile-redirect",
                source_name="fixture-source",
                source_record_id=None,
                declared_media_type=None,
                candidate_keys=CandidateKeyTracker(),
                allow_static_landing_discovery=False,
            )
        )

        self.assertEqual([scope for scope, _policy in coordinator.scopes], [provider_scope])
        self.assertEqual(coordinator.hosts, ["start.test", "strict.test"])
        self.assertIn("strict.test", resolver.calls)
        self.assertEqual(len(transport.calls), 2)
        self.assertTrue(first.closed)
        self.assertTrue(second.closed)
        self.assertEqual(
            coordinator.policy_for(provider_scope).min_start_interval,
            45.0,
        )
        deliveries[0].content.discard()

    def test_iterator_close_discards_undelivered_temporary_lifetime(self) -> None:
        client, _transport, _resolver, _coordinator = _http_environment(
            [_raw(body=b"candidate")],
            {"content.test": (_PUBLIC_IP,)},
        )
        iterator = iter(
            _fetcher(client).acquire(
                locator="https://content.test/file",
                candidate_key="fixture:iterator",
                source_name="fixture-source",
                source_record_id=None,
                declared_media_type=None,
                candidate_keys=CandidateKeyTracker(),
                allow_static_landing_discovery=False,
            )
        )
        temporary = next(iterator)
        close = getattr(iterator, "close", None)
        self.assertTrue(callable(close))
        cast(Callable[[], object], close)()
        with self.assertRaises(Exception):
            temporary.content.open()

    def test_public_locator_fetcher_fixed_compatibility_signature_is_keyword_only(self) -> None:
        parameters = inspect.signature(PublicLocatorFetcher.acquire).parameters
        self.assertEqual(
            tuple(parameters),
            (
                "self",
                "locator",
                "candidate_key",
                "source_name",
                "source_record_id",
                "declared_media_type",
                "candidate_keys",
                "allow_static_landing_discovery",
            ),
        )
        self.assertTrue(
            all(
                parameter.kind is inspect.Parameter.KEYWORD_ONLY
                for name, parameter in parameters.items()
                if name != "self"
            )
        )


class DoiLandingResolverTests(unittest.TestCase):
    def test_invalid_input_is_rejected_and_non_doi_identifier_is_a_local_miss(self) -> None:
        client, transport, resolver, _coordinator = _http_environment([], {})
        landing = DoiLandingResolver(http_client=client)

        with self.assertRaises(TypeError):
            landing.resolve(None)  # type: ignore[arg-type]
        self.assertIsNone(landing.resolve(Identifier(namespace="pmid", value="123")))
        self.assertEqual(transport.calls, [])
        self.assertEqual(resolver.calls, [])

    def test_no_landing_200_204_404_and_410_are_none_but_other_statuses_fail(self) -> None:
        doi = Identifier(namespace="doi", value="10.1234/example")
        for status in (200, 204, 404, 410):
            with self.subTest(status=status, result="none"):
                client, _transport, _resolver, _coordinator = _http_environment(
                    [_raw(status)],
                    {"doi.org": (_PUBLIC_IP,)},
                )
                self.assertIsNone(DoiLandingResolver(http_client=client).resolve(doi))

        for status in (300, 401, 403, 429, 500):
            with self.subTest(status=status, result="failure"):
                client, _transport, _resolver, _coordinator = _http_environment(
                    [_raw(status)],
                    {"doi.org": (_PUBLIC_IP,)},
                )
                with self.assertRaises(AcquisitionFailure):
                    DoiLandingResolver(http_client=client).resolve(doi)

    def test_network_cancellation_is_typed_from_the_access_failure_code(self) -> None:
        cancel_event = threading.Event()
        cancel_event.set()
        client, transport, resolver, _coordinator = _http_environment([], {})

        with self.assertRaises(AcquisitionFailure) as raised:
            DoiLandingResolver(
                http_client=client,
                cancel_event=cancel_event,
            ).resolve(Identifier(namespace="doi", value="10.1234/example"))

        self.assertEqual(raised.exception.failure.code, "acquisition-interrupted")
        self.assertEqual(transport.calls, [])
        self.assertEqual(resolver.calls, [])

    def test_returns_only_normalized_final_origin_even_when_response_looks_like_pdf(self) -> None:
        first = _raw(302, location="https://publisher.test/articles/file.pdf?download=1")
        second = _raw(
            body=b"%PDF-1.4 bytes that DOI resolution must not deliver",
            media_type="application/pdf",
        )
        client, transport, _resolver, coordinator = _http_environment(
            [first, second],
            {"doi.org": (_PUBLIC_IP,), "publisher.test": (_PUBLIC_IP,)},
        )

        result = DoiLandingResolver(http_client=client).resolve(
            Identifier(namespace="doi", value="doi:10.1234/Example")
        )

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.origin, "https://publisher.test")
        self.assertEqual(
            result.canonical_landing_url,
            "https://publisher.test/articles/file.pdf?download=1",
        )
        self.assertEqual(coordinator.hosts, ["doi.org", "publisher.test"])
        self.assertEqual(
            [scope for scope, _policy in coordinator.scopes],
            [
                AccessScope("doi.org", "web"),
                AccessScope("publisher.test", "web"),
            ],
        )
        self.assertTrue(
            all(
                isinstance(call["request"], TransportRequest)
                and cast(TransportRequest, call["request"]).method == "HEAD"
                for call in transport.calls
            )
        )
        self.assertIn("10.1234%2Fexample", _request_url(transport.calls[0]))
        self.assertTrue(first.closed)
        self.assertTrue(second.closed)

    def test_private_redirect_and_dns_rebinding_are_system_failures(self) -> None:
        doi = Identifier(namespace="doi", value="10.1234/example")
        private_client, private_transport, _resolver, _coordinator = _http_environment(
            [_raw(302, location="https://private.test/article")],
            {"doi.org": (_PUBLIC_IP,), "private.test": ("127.0.0.1",)},
        )
        with self.assertRaises(AcquisitionFailure):
            DoiLandingResolver(http_client=private_client).resolve(doi)
        self.assertEqual(len(private_transport.calls), 1)

        sequential = _SequentialResolver({"doi.org": [(_PUBLIC_IP,), ("127.0.0.1",)]})
        rebind_client, rebind_transport, _resolver, _coordinator = _http_environment(
            [_raw(200)],
            {},
            resolver=sequential,
        )
        with self.assertRaises(AcquisitionFailure):
            DoiLandingResolver(http_client=rebind_client).resolve(doi)
        self.assertEqual(rebind_transport.calls, [])


if __name__ == "__main__":
    unittest.main()
