from __future__ import annotations

import inspect
import re
import threading
import unittest
from collections.abc import Callable, Iterable, Iterator
from contextlib import AbstractContextManager, closing
from io import BytesIO
from typing import BinaryIO, cast

import sciretriever.acquisition.sources.configured_sci_hub as configured_module
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
    AcquisitionExhaustionPublicationCommand,
    AcquisitionExpectedFacts,
    AcquisitionFailure,
    AcquisitionSourceFailure,
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
from sciretriever.acquisition.sources.configured_sci_hub import (
    BUILTIN_SCI_HUB_MIRROR_URLS,
    ConfiguredLocatorResolver,
    ConfiguredSciHubLandingResolver,
    ConfiguredSciHubPdfSource,
    configured_sci_hub_route_status,
)
from sciretriever.acquisition.tiered_service import TieredAcquisitionService
from sciretriever.literature.content import metadata_sha256
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
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ProvenanceId,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure

_TIME = UtcTimestamp("2026-08-11T12:00:00Z")
_KEY = re.compile(r"^sci-hub-(?:resolver|locator):[0-9a-f]{64}$")


def _id(index: int) -> str:
    return f"{index:08x}-e89b-12d3-a456-426614174000"


def _request(
    identifiers: tuple[Identifier, ...] = (
        Identifier(namespace="doi", value="10.1234/configured-fixture"),
    ),
) -> AcquisitionRequest:
    literature = Literature(
        literature_id=LiteratureId(_id(1)),
        meta_literature_id=MetaLiteratureId(_id(2)),
        version_role=VersionRole.PUBLISHED,
        metadata=LiteratureMetadata(
            title="Configured locator fixture",
            identifiers=identifiers,
        ),
        status=LiteratureStatus.UNREVIEWED,
    )
    return AcquisitionRequest(
        literature=literature,
        expected_facts=AcquisitionExpectedFacts(
            literature_id=literature.literature_id,
            meta_literature_id=literature.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(literature.metadata),
            expected_no_primary_pdf=True,
        ),
    )


def _evidence(request: AcquisitionRequest) -> AcquisitionEvidence:
    return build_acquisition_evidence(request)


class _Content:
    def __init__(self, payload: bytes = b"configured candidate") -> None:
        self.payload: bytes | None = payload
        self.discard_count = 0

    def open(self) -> AbstractContextManager[BinaryIO]:
        if self.payload is None:
            raise RuntimeError("temporary content is closed")
        return closing(BytesIO(self.payload))

    def discard(self) -> None:
        self.discard_count += 1
        self.payload = None


class _Resolver:
    def __init__(
        self,
        result: object,
        *,
        action: Callable[[tuple[Identifier, ...], threading.Event | None], None] | None = None,
        failure: BaseException | None = None,
    ) -> None:
        self.result = result
        self.action = action
        self.failure = failure
        self.calls: list[tuple[tuple[Identifier, ...], threading.Event | None]] = []

    def resolve(
        self,
        identifiers: tuple[Identifier, ...],
        *,
        cancel_event: threading.Event | None = None,
    ) -> tuple[str, ...]:
        self.calls.append((identifiers, cancel_event))
        if self.action is not None:
            self.action(identifiers, cancel_event)
        if self.failure is not None:
            raise self.failure
        return cast(tuple[str, ...], self.result)


class _Fetcher:
    def __init__(
        self,
        *,
        failure: AcquisitionFailure | None = None,
        source_name: str = "sci-hub",
        source_record_id: str | None = None,
        on_delivery: Callable[[], None] | None = None,
        additional_candidate_keys: tuple[str, ...] = (),
        failures_by_locator: dict[str, AcquisitionFailure] | None = None,
    ) -> None:
        self.failure = failure
        self.output_source_name = source_name
        self.source_record_id = source_record_id
        self.on_delivery = on_delivery
        self.additional_candidate_keys = additional_candidate_keys
        self.failures_by_locator = {} if failures_by_locator is None else failures_by_locator
        self.calls: list[dict[str, object]] = []
        self.contents: list[_Content] = []
        self.close_count = 0
        self._next_id = 100

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
        self.calls.append(
            {
                "locator": locator,
                "candidate_key": candidate_key,
                "source_name": source_name,
                "source_record_id": source_record_id,
                "declared_media_type": declared_media_type,
                "candidate_keys": candidate_keys,
                "allow_static_landing_discovery": allow_static_landing_discovery,
                "fetch_key_was_claimed": candidate_keys.contains(candidate_key),
            }
        )
        failure = self.failures_by_locator.get(locator, self.failure)
        if failure is not None:
            raise failure
        return self._deliver(
            locator=locator,
            candidate_key=candidate_key,
            candidate_keys=candidate_keys,
        )

    def _deliver(
        self,
        *,
        locator: str,
        candidate_key: str,
        candidate_keys: CandidateKeyTracker,
    ) -> Iterator[TemporaryPdf]:
        try:
            keys = (candidate_key, *self.additional_candidate_keys)
            for index, delivery_key in enumerate(keys):
                if not candidate_keys.claim(delivery_key):
                    continue
                if self.on_delivery is not None:
                    self.on_delivery()
                content = _Content(f"{locator}#{index}".encode("utf-8"))
                self.contents.append(content)
                provenance = Provenance(
                    provenance_id=ProvenanceId(_id(self._next_id)),
                    source_kind=SourceKind.ASSET_PROVIDER,
                    source_name=self.output_source_name,
                    source_record_id=self.source_record_id,
                    observed_at=_TIME,
                    input_sha256=None,
                    parameters_sha256=None,
                )
                self._next_id += 1
                temporary = TemporaryPdf(
                    candidate=PdfCandidate(
                        candidate_key=delivery_key,
                        source_name=self.output_source_name,
                        acquisition_path=AcquisitionPath.PUBLIC,
                        declared_media_type="application/pdf",
                    ),
                    content=content,
                    safe_source_url=locator,
                    provenance=provenance,
                )
                try:
                    yield temporary
                except BaseException:
                    content.discard()
                    raise
        finally:
            self.close_count += 1


def _source(
    resolver: object | None,
    fetcher: object,
    *,
    cancel_event: threading.Event | None = None,
) -> ConfiguredSciHubPdfSource:
    return ConfiguredSciHubPdfSource(
        resolver=cast(ConfiguredLocatorResolver | None, resolver),
        locator_fetcher=cast(configured_module.PublicLocatorFetcher, fetcher),
        cancel_event=cancel_event,
    )


def _rendered_failure(error: AcquisitionFailure) -> str:
    return f"{error!s} {error!r} {error.failure.model_dump_json()}"


class ConfiguredSciHubContractTests(unittest.TestCase):
    def test_builtin_mirror_set_is_ordered_and_forms_safe_doi_landings(self) -> None:
        self.assertEqual(
            BUILTIN_SCI_HUB_MIRROR_URLS,
            ("https://sci-hub.ru", "https://sci-hub.kr"),
        )
        resolver = ConfiguredSciHubLandingResolver(BUILTIN_SCI_HUB_MIRROR_URLS)

        self.assertEqual(
            resolver.resolve((Identifier(namespace="doi", value="10.1234/fixture"),)),
            (
                "https://sci-hub.ru/10.1234/fixture",
                "https://sci-hub.kr/10.1234/fixture",
            ),
        )

    def test_builtin_resolver_emits_ordered_canonical_mirror_landings_for_doi(self) -> None:
        resolver = ConfiguredSciHubLandingResolver(
            (
                "https://MIRROR-ONE.example:443/base/",
                "https://mirror-two.example",
                "https://mirror-one.example/base",
            )
        )

        self.assertEqual(
            resolver.resolve(
                (
                    Identifier(namespace="pmid", value="12345"),
                    Identifier(namespace="doi", value="10.1234/path?download#part"),
                )
            ),
            (
                "https://mirror-one.example/base/10.1234/path%3Fdownload%23part",
                "https://mirror-two.example/10.1234/path%3Fdownload%23part",
            ),
        )
        self.assertEqual(
            resolver.resolve((Identifier(namespace="pmid", value="12345"),)),
            (),
        )
        rendered = repr(resolver)
        self.assertIn("mirrors=2", rendered)
        self.assertNotIn("mirror-one", rendered)
        self.assertNotIn("mirror-two", rendered)

    def test_builtin_resolver_rejects_unsafe_mirrors_and_honours_cancellation(self) -> None:
        invalid: tuple[object, ...] = (
            (),
            ["https://mirror.example"],
            ("http://mirror.example",),
            ("https://127.0.0.1",),
            ("https://localhost",),
            ("https://mirror.localhost",),
            ("https://user:secret@mirror.example",),
            ("https://mirror.example?token=secret",),
            ("https://mirror.example/path#fragment",),
            ("https://mirror.example:8443",),
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                ConfiguredSciHubLandingResolver(cast(tuple[str, ...], value))

        cancel_event = threading.Event()
        cancel_event.set()
        with self.assertRaises(AcquisitionFailure) as raised:
            ConfiguredSciHubLandingResolver(("https://mirror.example",)).resolve(
                (Identifier(namespace="doi", value="10.1234/fixture"),),
                cancel_event=cancel_event,
            )
        self.assertEqual(
            raised.exception.failure.code,
            "acquisition-configured-sci-hub-cancelled",
        )

    def test_mirror_source_continues_in_order_after_one_source_failure(self) -> None:
        request = _request()
        first = "https://mirror-one.example/10.1234/configured-fixture"
        second = "https://mirror-two.example/base/10.1234/configured-fixture"
        failure = AcquisitionSourceFailure(
            StableFailure(
                code="acquisition-public-locator-network-failed",
                reason="The first mirror failed.",
                action="Try the next configured mirror.",
                retryable=True,
            )
        )
        fetcher = _Fetcher(failures_by_locator={first: failure})
        source = _source(
            ConfiguredSciHubLandingResolver(
                ("https://mirror-one.example", "https://mirror-two.example/base")
            ),
            fetcher,
        )

        iterator = iter(source._deliveries(request, _evidence(request), CandidateKeyTracker()))
        delivery = next(iterator)
        close = getattr(iterator, "close", None)
        self.assertTrue(callable(close))
        cast(Callable[[], object], close)()

        self.assertEqual([call["locator"] for call in fetcher.calls], [first, second])
        self.assertEqual(delivery.candidate.source_name, "sci-hub")
        self.assertIsNone(delivery.safe_source_url)
        delivery.content.discard()

    def test_public_route_and_missing_resolver_status_are_explicit(self) -> None:
        request = _request()
        no_identifier_request = _request(())
        fetcher = _Fetcher()
        source = _source(None, fetcher)

        self.assertEqual(source.source_name, "sci-hub")
        self.assertIs(source.acquisition_path, AcquisitionPath.PUBLIC)
        self.assertEqual(
            list(
                source._deliveries(
                    no_identifier_request,
                    _evidence(no_identifier_request),
                    CandidateKeyTracker(),
                )
            ),
            [],
        )

        status = configured_sci_hub_route_status(None)
        self.assertIs(status.readiness, RouteReadiness.UNCONFIGURED)
        self.assertIsNotNone(status.failure)
        assert status.failure is not None
        self.assertEqual(
            status.failure.code,
            "acquisition-configured-sci-hub-resolver-missing",
        )
        self.assertIs(
            configured_sci_hub_route_status(_Resolver(())).readiness,
            RouteReadiness.READY,
        )

        with self.assertRaises(AcquisitionFailure) as raised:
            list(source._deliveries(request, _evidence(request), CandidateKeyTracker()))
        self.assertEqual(raised.exception.failure, status.failure)
        self.assertEqual(fetcher.calls, [])

    def test_missing_resolver_binding_fails_preflight_without_exhaustion(self) -> None:
        class Publication:
            def prepare_primary_pdf(
                self,
                request: AcquisitionRequest,
                temporary_pdf: TemporaryPdf,
                *,
                cancel_event: object | None = None,
            ) -> PrimaryPdfPreparation | None:
                del request, temporary_pdf, cancel_event
                raise AssertionError("publication must not run")

            def commit_primary_pdf(
                self,
                prepared: PrimaryPdfPreparation,
            ) -> AcquiredPrimaryPdf:
                del prepared
                raise AssertionError("publication must not run")

        class Exhaustion:
            def __init__(self) -> None:
                self.calls = 0

            def publish_exhaustion(
                self,
                command: AcquisitionExhaustionPublicationCommand,
            ) -> AutomaticPdfAcquisitionExhaustion:
                self.calls += 1
                return AutomaticPdfAcquisitionExhaustion(
                    literature_id=command.expected_facts.literature_id
                )

        class Clear:
            def clear_exhaustion(self, expected_facts: AcquisitionExpectedFacts) -> None:
                del expected_facts
                raise AssertionError("clear must not run")

        request = _request()
        fetcher = _Fetcher()
        source = _source(None, fetcher)
        exhaustion = Exhaustion()
        catalog = PublisherAccessProfileCatalog(())
        spec = RouteSpec(
            route_key=source.route_key,
            tier=AcquisitionPath.PUBLIC,
            capability=RouteCapability.PUBLIC_PROTOCOL,
            readiness=RouteReadiness.UNCONFIGURED,
            requires_any_identifier=True,
        )
        service = TieredAcquisitionService(
            route_registry=AcquisitionRouteRegistry(
                profile_catalog=catalog,
                bindings=(RouteAdapterBinding(spec=spec, adapter=None),),
            ),
            planner=ProgressiveAcquisitionPlanner(
                resolver=PublisherAccessResolver(catalog),
                builder=AcquisitionPlanBuilder(catalog),
                route_specs=(spec,),
                doi_landing_resolver=None,
            ),
            publication_port=Publication(),
            exhaustion_port=exhaustion,
            exhaustion_clear_port=Clear(),
        )

        with self.assertRaises(AcquisitionFailure) as raised:
            service.prepare_primary_pdf(request)

        self.assertEqual(
            raised.exception.failure.code,
            "acquisition-route-unconfigured",
        )
        self.assertEqual(exhaustion.calls, 0)
        self.assertEqual(fetcher.calls, [])

    def test_resolver_receives_only_identifiers_and_cancel_event_after_digest_claim(
        self,
    ) -> None:
        request = _request(
            (
                Identifier(namespace="doi", value="10.1234/configured-fixture"),
                Identifier(namespace="pmcid", value="PMC12345"),
            )
        )
        evidence = _evidence(request)
        tracker = CandidateKeyTracker()
        cancel_event = threading.Event()

        def inspect_call(
            identifiers: tuple[Identifier, ...],
            received_event: threading.Event | None,
        ) -> None:
            self.assertIs(identifiers, evidence.identifiers)
            self.assertIs(received_event, cancel_event)
            self.assertEqual(len(tracker.tried_candidate_keys), 1)
            resolver_key = next(iter(tracker.tried_candidate_keys))
            self.assertRegex(resolver_key, _KEY)
            self.assertNotIn("10.1234", resolver_key)
            self.assertNotIn("PMC12345", resolver_key)

        resolver = _Resolver(("https://PUBLIC.test:443/article?download=1",), action=inspect_call)
        fetcher = _Fetcher()
        source = _source(resolver, fetcher, cancel_event=cancel_event)

        deliveries = list(source._deliveries(request, evidence, tracker))

        self.assertEqual(resolver.calls, [(evidence.identifiers, cancel_event)])
        self.assertEqual(len(fetcher.calls), 1)
        call = fetcher.calls[0]
        self.assertEqual(call["locator"], "https://public.test/article?download=1")
        self.assertEqual(call["source_name"], "sci-hub")
        self.assertIsNone(call["source_record_id"])
        self.assertIsNone(call["declared_media_type"])
        self.assertIs(call["candidate_keys"], tracker)
        self.assertTrue(call["allow_static_landing_discovery"])
        self.assertFalse(call["fetch_key_was_claimed"])
        self.assertRegex(cast(str, call["candidate_key"]), _KEY)
        self.assertNotIn("public.test", cast(str, call["candidate_key"]))

        self.assertEqual(len(deliveries), 1)
        delivery = deliveries[0]
        self.assertIsNone(delivery.safe_source_url)
        self.assertEqual(delivery.candidate.source_name, "sci-hub")
        self.assertIs(delivery.candidate.acquisition_path, AcquisitionPath.PUBLIC)
        self.assertEqual(delivery.provenance.source_name, "sci-hub")
        self.assertIs(delivery.provenance.source_kind, SourceKind.ASSET_PROVIDER)
        self.assertIsNone(delivery.provenance.source_record_id)
        delivery.content.discard()

    def test_protocol_surface_cannot_receive_literature_metadata_or_runtime_clients(self) -> None:
        parameters = inspect.signature(ConfiguredLocatorResolver.resolve).parameters
        self.assertEqual(tuple(parameters), ("self", "identifiers", "cancel_event"))
        self.assertIs(parameters["cancel_event"].kind, inspect.Parameter.KEYWORD_ONLY)
        annotation_surface = " ".join(str(value.annotation) for value in parameters.values())
        for forbidden in (
            "AcquisitionEvidence",
            "AcquisitionRequest",
            "AssetHint",
            "Browser",
            "HttpClient",
            "Literature",
            "LiteratureMetadata",
            "MetadataObservation",
        ):
            self.assertNotIn(forbidden, annotation_surface)
        for forbidden_runtime in ("BrowserClient", "BrowserRequest", "HttpClient"):
            self.assertFalse(hasattr(configured_module, forbidden_runtime))

    def test_empty_tuple_is_normal_miss_and_excluded_resolver_key_skips_the_call(self) -> None:
        request = _request()
        evidence = _evidence(request)
        first_resolver = _Resolver(())
        first_fetcher = _Fetcher()
        first_tracker = CandidateKeyTracker()

        self.assertEqual(
            list(
                _source(first_resolver, first_fetcher)._deliveries(
                    request,
                    evidence,
                    first_tracker,
                )
            ),
            [],
        )
        self.assertEqual(len(first_resolver.calls), 1)
        self.assertEqual(first_fetcher.calls, [])
        self.assertEqual(len(first_tracker.tried_candidate_keys), 1)
        resolver_key = next(iter(first_tracker.tried_candidate_keys))

        second_resolver = _Resolver(("https://must-not-run.test/file",))
        second_fetcher = _Fetcher()
        self.assertEqual(
            list(
                _source(second_resolver, second_fetcher)._deliveries(
                    request,
                    evidence,
                    CandidateKeyTracker((resolver_key,)),
                )
            ),
            [],
        )
        self.assertEqual(second_resolver.calls, [])
        self.assertEqual(second_fetcher.calls, [])

    def test_locators_deduplicate_and_one_invalid_locator_does_not_hide_valid_work(
        self,
    ) -> None:
        request = _request()
        evidence = _evidence(request)
        resolver = _Resolver(
            (
                "https://ONE.test:443/article",
                "https://one.test/article",
                "https://two.test/path?download=1",
                "https://ONE.test/article",
            )
        )
        fetcher = _Fetcher()
        deliveries = list(
            _source(resolver, fetcher)._deliveries(
                request,
                evidence,
                CandidateKeyTracker(),
            )
        )

        self.assertEqual(
            [call["locator"] for call in fetcher.calls],
            ["https://one.test/article", "https://two.test/path?download=1"],
        )
        self.assertTrue(
            all(not cast(bool, call["fetch_key_was_claimed"]) for call in fetcher.calls)
        )
        self.assertEqual(len(deliveries), 2)
        for delivery in deliveries:
            self.assertIsNone(delivery.safe_source_url)
            delivery.content.discard()

        invalid_resolver = _Resolver(
            (
                "https://valid-before-invalid.test/file",
                "https://user:private-password@invalid.test/file",
            )
        )
        untouched_fetcher = _Fetcher()
        iterator = iter(
            _source(invalid_resolver, untouched_fetcher)._deliveries(
                request,
                evidence,
                CandidateKeyTracker(),
            )
        )
        valid_delivery = next(iterator)
        valid_delivery.content.discard()
        with self.assertRaises(AcquisitionFailure):
            next(iterator)
        self.assertEqual(
            [call["locator"] for call in untouched_fetcher.calls],
            ["https://valid-before-invalid.test/file"],
        )

    def test_a5_landing_can_deliver_initial_body_and_a_distinct_discovered_candidate(
        self,
    ) -> None:
        request = _request()
        evidence = _evidence(request)
        discovered_key = "public-locator:" + "b" * 64
        fetcher = _Fetcher(additional_candidate_keys=(discovered_key,))
        tracker = CandidateKeyTracker()

        deliveries = list(
            _source(
                _Resolver(("https://landing.test/article",)),
                fetcher,
            )._deliveries(request, evidence, tracker)
        )

        self.assertEqual(len(fetcher.calls), 1)
        self.assertTrue(fetcher.calls[0]["allow_static_landing_discovery"])
        self.assertEqual(len(deliveries), 2)
        self.assertNotEqual(
            deliveries[0].candidate.candidate_key,
            deliveries[1].candidate.candidate_key,
        )
        self.assertEqual(deliveries[1].candidate.candidate_key, discovered_key)
        self.assertTrue(all(delivery.safe_source_url is None for delivery in deliveries))
        self.assertTrue(all(delivery.candidate.source_name == "sci-hub" for delivery in deliveries))
        self.assertTrue(
            all(delivery.provenance.source_name == "sci-hub" for delivery in deliveries)
        )
        self.assertTrue(
            all(tracker.contains(delivery.candidate.candidate_key) for delivery in deliveries)
        )
        for delivery in deliveries:
            delivery.content.discard()

    def test_non_tuple_nonstr_https_credential_fragment_and_nonpublic_literals_fail_closed(
        self,
    ) -> None:
        cases: tuple[tuple[str, object], ...] = (
            ("list", ["https://public.test/file"]),
            ("generator", iter(("https://public.test/file",))),
            ("non-string", (object(),)),
            ("http", ("http://public.test/file",)),
            ("userinfo", ("https://user:password@public.test/file",)),
            ("fragment", ("https://public.test/file#private",)),
            ("sensitive-query", ("https://public.test/file?token=private",)),
            ("loopback-v4", ("https://127.0.0.1/file",)),
            ("private-v4", ("https://10.0.0.1/file",)),
            ("loopback-v6", ("https://[::1]/file",)),
            ("link-local-v6", ("https://[fe80::1]/file",)),
        )
        request = _request()
        evidence = _evidence(request)
        for name, result in cases:
            with self.subTest(name=name):
                fetcher = _Fetcher()
                with self.assertRaises(AcquisitionFailure) as raised:
                    list(
                        _source(_Resolver(result), fetcher)._deliveries(
                            request,
                            evidence,
                            CandidateKeyTracker(),
                        )
                    )
                self.assertEqual(
                    raised.exception.failure.code,
                    "acquisition-configured-sci-hub-locator-invalid"
                    if isinstance(result, tuple)
                    else "acquisition-configured-sci-hub-resolver-contract",
                )
                self.assertEqual(fetcher.calls, [])

    def test_resolver_and_locator_failures_are_stable_and_do_not_echo_private_details(self) -> None:
        private_values = (
            "private-mirror.test",
            "operator-token",
            "PRIVATE-RESPONSE-BODY",
        )
        private_message = (
            "https://private-mirror.test/file?token=operator-token PRIVATE-RESPONSE-BODY"
        )
        request = _request()
        evidence = _evidence(request)

        with self.assertRaises(AcquisitionFailure) as resolver_raised:
            list(
                _source(
                    _Resolver((), failure=RuntimeError(private_message)),
                    _Fetcher(),
                )._deliveries(
                    request,
                    evidence,
                    CandidateKeyTracker(),
                )
            )
        self.assertEqual(
            resolver_raised.exception.failure.code,
            "acquisition-configured-sci-hub-resolver-failed",
        )
        self.assertTrue(resolver_raised.exception.__suppress_context__)

        with self.assertRaises(AcquisitionFailure) as locator_raised:
            list(
                _source(_Resolver((private_message,)), _Fetcher())._deliveries(
                    request,
                    evidence,
                    CandidateKeyTracker(),
                )
            )
        self.assertEqual(
            locator_raised.exception.failure.code,
            "acquisition-configured-sci-hub-locator-invalid",
        )

        rendered = _rendered_failure(resolver_raised.exception) + _rendered_failure(
            locator_raised.exception
        )
        for private in private_values:
            self.assertNotIn(private, rendered)

    def test_cancellation_is_checked_before_claim_after_resolver_and_before_delivery(
        self,
    ) -> None:
        request = _request()
        evidence = _evidence(request)

        pre_cancel = threading.Event()
        pre_cancel.set()
        pre_resolver = _Resolver(("https://public.test/file",))
        pre_fetcher = _Fetcher()
        pre_tracker = CandidateKeyTracker()
        with self.assertRaises(AcquisitionFailure) as pre_raised:
            list(
                _source(pre_resolver, pre_fetcher, cancel_event=pre_cancel)._deliveries(
                    request,
                    evidence,
                    pre_tracker,
                )
            )
        self.assertEqual(
            pre_raised.exception.failure.code,
            "acquisition-configured-sci-hub-cancelled",
        )
        self.assertEqual(pre_tracker.tried_candidate_keys, frozenset())
        self.assertEqual(pre_resolver.calls, [])
        self.assertEqual(pre_fetcher.calls, [])

        post_cancel = threading.Event()

        def cancel_after_resolve(
            _identifiers: tuple[Identifier, ...],
            event: threading.Event | None,
        ) -> None:
            assert event is not None
            event.set()

        post_resolver = _Resolver(
            ("https://public.test/file",),
            action=cancel_after_resolve,
        )
        post_fetcher = _Fetcher()
        post_tracker = CandidateKeyTracker()
        with self.assertRaises(AcquisitionFailure) as post_raised:
            list(
                _source(post_resolver, post_fetcher, cancel_event=post_cancel)._deliveries(
                    request,
                    evidence,
                    post_tracker,
                )
            )
        self.assertEqual(
            post_raised.exception.failure.code,
            "acquisition-configured-sci-hub-cancelled",
        )
        self.assertEqual(len(post_tracker.tried_candidate_keys), 1)
        self.assertEqual(post_fetcher.calls, [])

        delivery_cancel = threading.Event()
        delivery_fetcher = _Fetcher(on_delivery=delivery_cancel.set)
        with self.assertRaises(AcquisitionFailure) as delivery_raised:
            list(
                _source(
                    _Resolver(("https://public.test/file",)),
                    delivery_fetcher,
                    cancel_event=delivery_cancel,
                )._deliveries(request, evidence, CandidateKeyTracker())
            )
        self.assertEqual(
            delivery_raised.exception.failure.code,
            "acquisition-configured-sci-hub-cancelled",
        )
        self.assertEqual(len(delivery_fetcher.contents), 1)
        self.assertGreaterEqual(delivery_fetcher.contents[0].discard_count, 1)
        self.assertEqual(delivery_fetcher.close_count, 1)

    def test_a5_failure_propagates_without_fallback_and_source_close_releases_content(self) -> None:
        request = _request()
        evidence = _evidence(request)
        marker = AcquisitionFailure(
            StableFailure(
                code="acquisition-public-locator-network-failed",
                reason="A public PDF locator could not be accessed safely.",
                action="Check Network policy before retrying.",
                retryable=True,
            )
        )
        failing_fetcher = _Fetcher(failure=marker)
        with self.assertRaises(AcquisitionFailure) as raised:
            list(
                _source(
                    _Resolver(("https://public.test/file",)),
                    failing_fetcher,
                )._deliveries(request, evidence, CandidateKeyTracker())
            )
        self.assertIs(raised.exception, marker)

        closing_fetcher = _Fetcher()
        iterator = iter(
            _source(
                _Resolver(("https://public.test/file",)),
                closing_fetcher,
            )._deliveries(request, evidence, CandidateKeyTracker())
        )
        temporary = next(iterator)
        self.assertIsNone(temporary.safe_source_url)
        close = getattr(iterator, "close", None)
        self.assertTrue(callable(close))
        cast(Callable[[], object], close)()
        self.assertEqual(closing_fetcher.close_count, 1)
        self.assertEqual(len(closing_fetcher.contents), 1)
        self.assertGreaterEqual(closing_fetcher.contents[0].discard_count, 1)

    def test_evidence_mismatch_and_fetcher_source_contract_fail_before_publication(self) -> None:
        request = _request()
        other_request = _request((Identifier(namespace="pmid", value="123456"),))
        resolver = _Resolver(("https://public.test/file",))
        fetcher = _Fetcher()
        with self.assertRaises(AcquisitionFailure) as mismatch:
            list(
                _source(resolver, fetcher)._deliveries(
                    request,
                    _evidence(other_request),
                    CandidateKeyTracker(),
                )
            )
        self.assertEqual(
            mismatch.exception.failure.code,
            "acquisition-configured-sci-hub-evidence-mismatch",
        )
        self.assertEqual(resolver.calls, [])
        self.assertEqual(fetcher.calls, [])

        wrong_fetcher = _Fetcher(source_name="private-resolver-name", source_record_id="secret-id")
        with self.assertRaises(AcquisitionFailure) as wrong_source:
            list(
                _source(
                    _Resolver(("https://public.test/file",)),
                    wrong_fetcher,
                )._deliveries(request, _evidence(request), CandidateKeyTracker())
            )
        self.assertEqual(
            wrong_source.exception.failure.code,
            "acquisition-configured-sci-hub-fetcher-contract",
        )
        self.assertEqual(len(wrong_fetcher.contents), 1)
        self.assertGreaterEqual(wrong_fetcher.contents[0].discard_count, 1)


if __name__ == "__main__":
    unittest.main()
