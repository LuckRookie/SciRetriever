from __future__ import annotations

import asyncio
import threading
import unittest
from collections.abc import Callable
from pathlib import Path
from typing import Literal
from unittest.mock import patch
from urllib.parse import unquote, urlsplit
from uuid import UUID

from metadata_provider_contract import (
    ContractBinding,
    ContractEnvironment,
    ContractExpectedResult,
    ContractPorts,
    ContractScenario,
    ExpectedAuthor,
    ProviderContractCase,
)

from sciretriever.literature.metadata import accept_observation
from sciretriever.metadata.ports import (
    MetadataLookupPort,
    MetadataProviderFailure,
    ReferenceQueryPort,
    TopicSearchPort,
)
from sciretriever.metadata.providers._shared import retry_after_feedback
from sciretriever.metadata.providers.opencitations import (
    ACCESS_SCOPE,
    BASELINE_ACCESS_POLICY,
    OpenCitationsAdapter,
)
from sciretriever.metadata.rules import (
    MetadataLookupRequest,
    MetadataProviderResult,
    MetadataReferenceQueryRequest,
    ProviderReferenceQuery,
)
from sciretriever.model.access import Header
from sciretriever.model.literature import Identifier
from sciretriever.model.metadata import ProviderLiteratureKey
from sciretriever.model.primitives import (
    ObservationId,
    ProvenanceId,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.network.admission import (
    AccessCoordinator,
    AccessFeedback,
    AccessPermit,
    AccessPolicy,
    AccessScope,
)
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import Origin

_FIXTURES = Path(__file__).parent / "fixtures" / "metadata" / "opencitations"
_ANCHOR_DOI = Identifier(namespace="doi", value="10.5555/opencitations.anchor")
_ANCHOR_PMID = Identifier(namespace="pmid", value="32939066")
_ANCHOR_OMID = "omid:br/06120343876"


class _IdFactories:
    def __init__(self, start: int) -> None:
        self._next = start

    def _value(self) -> str:
        value = str(UUID(int=self._next))
        self._next += 1
        return value

    def observation(self) -> ObservationId:
        return ObservationId(self._value())

    def provenance(self) -> ProvenanceId:
        return ProvenanceId(self._value())


class _FeedbackCheckpointCoordinator(AccessCoordinator):
    """Expose deterministic admission checkpoints for one waiting request."""

    def __init__(
        self,
        *,
        clock: Callable[[], float],
        checkpoints: tuple[float, ...],
    ) -> None:
        super().__init__(clock=clock)
        self._checkpoints = checkpoints
        self._checkpoint_events = tuple(threading.Event() for _ in checkpoints)
        self._checkpoint_barriers = tuple(threading.Barrier(2) for _ in checkpoints)
        self._checkpoint_selections: list[bool | None] = [None] * len(checkpoints)
        self._tracked_thread_id: int | None = None
        self._test_lock = threading.Lock()
        self.feedback_records: list[tuple[AccessScope, AccessFeedback]] = []

    def track_current_thread(self) -> None:
        with self._test_lock:
            self._tracked_thread_id = threading.get_ident()

    def checkpoint_selection(self, index: int) -> bool:
        if not self._checkpoint_events[index].wait(1.0):
            raise AssertionError("waiting request did not reach its checkpoint")
        with self._test_lock:
            selected = self._checkpoint_selections[index]
        if selected is None:
            raise AssertionError("checkpoint did not record an admission decision")
        return selected

    def release_checkpoint(self, index: int) -> None:
        self._checkpoint_barriers[index].wait(1.0)

    def abort_checkpoints(self) -> None:
        for barrier in self._checkpoint_barriers:
            barrier.abort()

    def record_feedback(
        self,
        source: AccessPermit | AccessScope,
        feedback: AccessFeedback,
    ) -> None:
        super().record_feedback(source, feedback)
        scope = source.scope if isinstance(source, AccessPermit) else source
        self.feedback_records.append((scope, feedback))

    def _select_scope_ticket(self, now: float) -> object | None:  # type: ignore[override]
        selected = super()._select_scope_ticket(now)
        checkpoint_index: int | None = None
        with self._test_lock:
            if threading.get_ident() == self._tracked_thread_id:
                for index, threshold in enumerate(self._checkpoints):
                    if self._checkpoint_selections[index] is None and now >= threshold:
                        self._checkpoint_selections[index] = selected is not None
                        checkpoint_index = index
                        break
        if checkpoint_index is not None:
            self._checkpoint_events[checkpoint_index].set()
            try:
                self._checkpoint_barriers[checkpoint_index].wait(1.0)
            except threading.BrokenBarrierError:
                pass
        return selected


def _fixture(name: str) -> bytes:
    return (_FIXTURES / name).read_bytes()


def _wall_timestamp(environment: ContractEnvironment) -> UtcTimestamp:
    return UtcTimestamp(environment.wall_clock().isoformat().replace("+00:00", "Z"))


def _lookup_request(
    key: ProviderLiteratureKey,
    *,
    scan_limit: int = 2,
) -> MetadataLookupRequest:
    return MetadataLookupRequest(
        provider_name="opencitations",
        key=key,
        scan_limit=scan_limit,
    )


def _reference_request(
    direction: Literal["references", "cited-by", "both"],
    key: ProviderLiteratureKey,
    *,
    scan_limit: int = 10,
) -> MetadataReferenceQueryRequest:
    return MetadataReferenceQueryRequest(
        direction=direction,
        providers=(
            ProviderReferenceQuery(
                provider_name="opencitations",
                keys=(key,),
                scan_limit=scan_limit,
            ),
        ),
    )


def _doi_key(value: str) -> ProviderLiteratureKey:
    return ProviderLiteratureKey(identifiers=(Identifier(namespace="doi", value=value),))


def _anchor_key() -> ProviderLiteratureKey:
    return ProviderLiteratureKey(identifiers=(_ANCHOR_DOI,))


def _assert_atomic_retry_after_feedback(
    case: unittest.TestCase,
    *,
    environment: ContractEnvironment,
    adapter: MetadataLookupPort,
    coordinator: _FeedbackCheckpointCoordinator,
) -> None:
    environment.queue_http_response(
        status=429,
        headers=(Header(name="Retry-After", value="5"),),
    )
    environment.queue_http_response(status=200, body=_fixture("zero-results.json"))
    feedback_entered = threading.Event()
    resume_feedback = threading.Event()
    first_done = threading.Event()
    second_done = threading.Event()
    first_failures: list[MetadataProviderFailure] = []
    second_deliveries: list[object] = []
    unexpected: list[BaseException] = []
    lookup_key = _doi_key("10.5555/opencitations.atomic-feedback")

    def paused_feedback(
        status_code: int,
        headers: object,
        *,
        wall_now: object,
    ) -> AccessFeedback | None:
        if status_code == 429:
            feedback_entered.set()
            if not resume_feedback.wait(1.0):
                raise AssertionError("feedback interpreter did not resume")
        return retry_after_feedback(
            status_code,
            headers,  # type: ignore[arg-type]
            wall_now=wall_now,  # type: ignore[arg-type]
        )

    def first_request() -> None:
        try:
            adapter.open_lookup(lookup_key).pull_raw_item()
        except MetadataProviderFailure as error:
            first_failures.append(error)
        except BaseException as error:
            unexpected.append(error)
        finally:
            first_done.set()

    def second_request() -> None:
        coordinator.track_current_thread()
        try:
            second_deliveries.append(adapter.open_lookup(lookup_key).pull_raw_item())
        except BaseException as error:
            unexpected.append(error)
        finally:
            second_done.set()

    first = threading.Thread(target=first_request)
    second = threading.Thread(target=second_request)
    try:
        with patch(
            "sciretriever.metadata.providers.opencitations.adapter.retry_after_feedback",
            side_effect=paused_feedback,
        ):
            first.start()
            case.assertTrue(feedback_entered.wait(1.0))
            second.start()

            environment.monotonic_clock.advance(1.0)
            coordinator.wake()
            case.assertFalse(
                coordinator.checkpoint_selection(0),
                "same-scope request became admissible before feedback release",
            )
            coordinator.release_checkpoint(0)
            case.assertEqual(len(environment.transport.calls), 1)

            resume_feedback.set()
            case.assertTrue(first_done.wait(1.0))
            case.assertEqual(len(first_failures), 1)
            case.assertEqual(
                first_failures[0].failure.code,
                "metadata-provider-throttled",
            )
            case.assertEqual(len(coordinator.feedback_records), 1)
            case.assertEqual(coordinator.feedback_records[0][1].retry_after, 5.0)

            environment.monotonic_clock.advance(4.9)
            coordinator.wake()
            case.assertFalse(
                coordinator.checkpoint_selection(1),
                "same-scope request became admissible before Retry-After elapsed",
            )
            coordinator.release_checkpoint(1)
            case.assertEqual(len(environment.transport.calls), 1)

            environment.monotonic_clock.advance(0.2)
            coordinator.wake()
            case.assertTrue(second_done.wait(1.0))
            case.assertEqual(second_deliveries, [None])
            case.assertEqual(len(environment.transport.calls), 2)
            case.assertEqual(unexpected, [])
    finally:
        resume_feedback.set()
        coordinator.abort_checkpoints()
        coordinator.wake()
        first.join(1.0)
        second.join(1.0)
        case.assertFalse(first.is_alive())
        case.assertFalse(second.is_alive())


def _environment(
    *,
    token: str | None = None,
    access_policy: AccessPolicy | None = None,
    observation_id_factory: Callable[[], ObservationId] | None = None,
    provenance_id_factory: Callable[[], ProvenanceId] | None = None,
) -> ContractEnvironment:
    ids = _IdFactories(70_000)

    def assemble(environment: ContractEnvironment) -> ContractPorts:
        adapter = OpenCitationsAdapter(
            http_client=environment.http_client,
            access_coordinator=environment.coordinator,
            access_scope=environment.scope,
            access_policy=access_policy or environment.policy,
            observation_id_factory=observation_id_factory or ids.observation,
            provenance_id_factory=provenance_id_factory or ids.provenance,
            clock=lambda: _wall_timestamp(environment),
            token=token,
        )
        return ContractPorts(lookup=adapter, reference_query=adapter)

    return ContractEnvironment(
        provider_name="opencitations",
        capabilities=frozenset({"lookup", "references"}),
        port_factory=assemble,
        expected_scope=ACCESS_SCOPE,
    )


def _contract_ports(environment: ContractEnvironment) -> ContractPorts:
    ids = _IdFactories(80_000)
    adapter = OpenCitationsAdapter(
        http_client=environment.http_client,
        access_coordinator=environment.coordinator,
        access_scope=environment.scope,
        access_policy=environment.policy,
        observation_id_factory=ids.observation,
        provenance_id_factory=ids.provenance,
        clock=lambda: _wall_timestamp(environment),
        token=environment.secret_sentinel,
    )
    return ContractPorts(lookup=adapter, reference_query=adapter)


def _queue_lookup(environment: ContractEnvironment) -> None:
    environment.queue_http_response(status=200, body=_fixture("lookup.json"))


def _queue_both(environment: ContractEnvironment) -> None:
    environment.queue_http_response(status=200, body=_fixture("references.json"))
    environment.queue_http_response(status=200, body=_fixture("citations.json"))


def _queue_retry_after(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=429,
        headers=(Header(name="Retry-After", value="4"),),
    )


def _queue_same_origin_redirect(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=302,
        headers=(
            Header(
                name="Location",
                value="https://api.opencitations.net/meta/v1/metadata/redirected",
            ),
        ),
    )
    _queue_lookup(environment)


def _queue_cross_origin_redirect(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=302,
        headers=(
            Header(
                name="Location",
                value="https://redirect.example.org/opencitations-result",
            ),
        ),
    )
    _queue_lookup(environment)


def _queue_partial(environment: ContractEnvironment) -> None:
    environment.queue_http_response(status=200, body=_fixture("references.json"))
    environment.queue_http_response(status=200, body=_fixture("malformed.json"))


def _lookup_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 1)
    case.assertEqual(result.observations[0].metadata.title, "An OpenCitations Meta record")


def _both_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 2)
    case.assertTrue(all(relation.citing != relation.cited for relation in result.relations))
    case.assertEqual(
        tuple(
            urlsplit(call.request.url).path.split("/")[-2] for call in environment.transport.calls
        ),
        ("references", "citations"),
    )


def _feedback_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    del result
    case = contract._test_case()
    case.assertEqual(len(environment.coordinator.feedback_records), 1)


def _redirect_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    del result
    contract._test_case().assertEqual(len(environment.transport.calls), 2)


def _partial_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 2)
    case.assertEqual(len(result.relations), 3)


def _contract_binding() -> ContractBinding:
    lookup = _lookup_request(_doi_key("10.5555/opencitations.lookup"))
    both = _reference_request("both", _anchor_key())
    return ContractBinding(
        provider_name="opencitations",
        capabilities=frozenset({"lookup", "references"}),
        expected_scope=ACCESS_SCOPE,
        credential_mode="header",
        port_factory=_contract_ports,
        scenarios=(
            ContractScenario(
                name="meta-exact-lookup",
                capability="lookup",
                request=lookup,
                prepare=_queue_lookup,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=0,
                ),
                evidence=_lookup_evidence,
            ),
            ContractScenario(
                name="index-both-directions",
                capability="references",
                request=both,
                prepare=_queue_both,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=5,
                    observation_count=0,
                    relation_count=5,
                ),
                evidence=_both_evidence,
            ),
            ContractScenario(
                name="retry-after-feedback",
                capability="lookup",
                request=lookup,
                prepare=_queue_retry_after,
                expected=ContractExpectedResult(
                    outcome="FAILED",
                    raw_item_count=0,
                    observation_count=0,
                    relation_count=0,
                    failure_code="metadata-provider-throttled",
                ),
                evidence=_feedback_evidence,
                expects_feedback=True,
            ),
            ContractScenario(
                name="same-origin-token-redirect",
                capability="lookup",
                request=lookup,
                prepare=_queue_same_origin_redirect,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=0,
                ),
                evidence=_redirect_evidence,
                credential_redirect="same-origin",
            ),
            ContractScenario(
                name="cross-origin-token-redirect",
                capability="lookup",
                request=lookup,
                prepare=_queue_cross_origin_redirect,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=0,
                ),
                evidence=_redirect_evidence,
                credential_redirect="cross-origin",
            ),
            ContractScenario(
                name="second-index-capability-fails-after-references",
                capability="references",
                request=both,
                prepare=_queue_partial,
                expected=ContractExpectedResult(
                    outcome="FAILED",
                    raw_item_count=3,
                    observation_count=0,
                    relation_count=3,
                    failure_code="metadata-provider-malformed-json",
                ),
                evidence=_partial_evidence,
            ),
        ),
    )


class OpenCitationsAdapterTests(ProviderContractCase, unittest.TestCase):
    def provider_contract_binding(self) -> ContractBinding:
        return _contract_binding()

    def _new_environment(
        self,
        *,
        token: str | None = None,
        access_policy: AccessPolicy | None = None,
        observation_id_factory: Callable[[], ObservationId] | None = None,
        provenance_id_factory: Callable[[], ProvenanceId] | None = None,
    ) -> ContractEnvironment:
        environment = _environment(
            token=token,
            access_policy=access_policy,
            observation_id_factory=observation_id_factory,
            provenance_id_factory=provenance_id_factory,
        )
        self.addCleanup(environment.close)
        return environment

    def test_capabilities_scope_policy_and_explicit_token_configuration(self) -> None:
        environment = self._new_environment()
        adapter = environment.ports.lookup
        self.assertIs(adapter, environment.ports.reference_query)
        self.assertIsNone(environment.ports.topic_search)
        self.assertIsInstance(adapter, MetadataLookupPort)
        self.assertIsInstance(adapter, ReferenceQueryPort)
        self.assertNotIsInstance(adapter, TopicSearchPort)
        self.assertEqual(environment.capabilities, frozenset({"lookup", "references"}))
        self.assertEqual(
            ACCESS_SCOPE,
            AccessScope(provider_name="opencitations", channel="api"),
        )
        self.assertEqual(
            BASELINE_ACCESS_POLICY,
            AccessPolicy(
                max_concurrency=1,
                min_start_interval=1.0 / 3.0,
                burst_limit=180,
                window_seconds=60.0,
            ),
        )

        ids = _IdFactories(90_000)
        invalid_scopes = (
            AccessScope(provider_name="wrong-provider", channel="api"),
            AccessScope(provider_name="opencitations", channel="web"),
            AccessScope(
                provider_name="opencitations",
                channel="api",
                service_name="metadata",
            ),
        )
        for scope in invalid_scopes:
            with self.subTest(scope=scope), self.assertRaises(ValueError):
                OpenCitationsAdapter(
                    http_client=environment.http_client,
                    access_coordinator=environment.coordinator,
                    access_scope=scope,
                    access_policy=environment.policy,
                    observation_id_factory=ids.observation,
                    provenance_id_factory=ids.provenance,
                    clock=lambda: _wall_timestamp(environment),
                )

        with self.assertRaises(ValueError):
            OpenCitationsAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=ACCESS_SCOPE,
                access_policy=environment.policy,
                observation_id_factory=ids.observation,
                provenance_id_factory=ids.provenance,
                clock=lambda: _wall_timestamp(environment),
                token="\n",
            )

        secret = "repr-must-not-expose-opencitations-token"
        credentialed = self._new_environment(token=secret)
        self.assertNotIn(secret, repr(credentialed.ports.lookup))

    def test_baseline_policy_cannot_be_loosened_and_operator_can_tighten(self) -> None:
        operator_policy = AccessPolicy(
            max_concurrency=8,
            min_start_interval=0.1,
            cooldown_after_completion=2.0,
            burst_limit=240,
            window_seconds=30.0,
            backoff_seconds=3.0,
            max_backoff_seconds=120.0,
        )
        environment = self._new_environment(access_policy=operator_policy)
        environment.queue_http_response(status=200, body=_fixture("zero-results.json"))
        self.assert_lookup_scan(
            environment,
            _lookup_request(_doi_key("10.5555/opencitations.lookup")),
            outcome="EXHAUSTED",
            raw_item_count=0,
            observation_count=0,
        )
        self.assertEqual(
            environment.coordinator.policy_for(ACCESS_SCOPE),
            AccessPolicy.strictest(BASELINE_ACCESS_POLICY, operator_policy),
        )

    def test_retry_after_feedback_is_atomic_with_scope_release(self) -> None:
        environment = self._new_environment()
        start = environment.monotonic_clock()
        coordinator = _FeedbackCheckpointCoordinator(
            clock=environment.monotonic_clock,
            checkpoints=(start + 1.0, start + 5.9),
        )
        http_client = HttpClient(
            resolver=environment.resolver,
            transport=environment.transport,
            coordinator=coordinator,
            clock=environment.monotonic_clock,
            sleeper=lambda _seconds: None,
            max_retries=0,
        )
        self.addCleanup(http_client.close)
        ids = _IdFactories(95_000)
        adapter = OpenCitationsAdapter(
            http_client=http_client,
            access_coordinator=coordinator,
            access_scope=ACCESS_SCOPE,
            access_policy=AccessPolicy(max_concurrency=1),
            observation_id_factory=ids.observation,
            provenance_id_factory=ids.provenance,
            clock=lambda: _wall_timestamp(environment),
        )

        _assert_atomic_retry_after_feedback(
            self,
            environment=environment,
            adapter=adapter,
            coordinator=coordinator,
        )

    def test_invalid_or_conflicting_retry_after_keeps_conservative_throttling(
        self,
    ) -> None:
        scenarios = (
            (Header(name="Retry-After", value="not-a-valid-delay"),),
            (
                Header(name="Retry-After", value="3"),
                Header(name="retry-after", value="7"),
            ),
        )
        for headers in scenarios:
            with self.subTest(headers=headers):
                environment = self._new_environment()
                environment.queue_http_response(status=429, headers=headers)
                failed = self.assert_lookup_scan(
                    environment,
                    _lookup_request(_doi_key("10.5555/opencitations.lookup")),
                    outcome="FAILED",
                    raw_item_count=0,
                    observation_count=0,
                )
                self.assert_stable_failure(
                    failed,
                    expected_code="metadata-provider-throttled",
                )
                self.assertEqual(len(environment.coordinator.feedback_records), 1)
                feedback = environment.coordinator.feedback_records[0][1]
                self.assertTrue(feedback.throttled)
                self.assertIsNone(feedback.retry_after)

    def test_meta_lookup_maps_only_declared_neutral_fields_and_structured_path(self) -> None:
        environment = self._new_environment()
        body = _fixture("lookup.json")
        environment.queue_http_response(status=200, body=body)
        result = self.assert_lookup_scan(
            environment,
            _lookup_request(_doi_key("10.5555/OPENCITATIONS.LOOKUP")),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
        )
        observation = result.observations[0]
        metadata = observation.metadata
        self.assertEqual(metadata.title, "An OpenCitations Meta record")
        self.assertEqual(metadata.publication_date, "2024-02-29")
        self.assertEqual(metadata.publication_year, 2024)
        self.assertEqual(metadata.document_type, "journal-article")
        self.assertEqual(metadata.venue, "Journal of Open Citations")
        self.assertEqual(metadata.publisher, "Example Publisher")
        self.assertEqual(metadata.volume, "42")
        self.assertEqual(metadata.issue, "7")
        self.assertEqual(metadata.pages, "101-119")
        self.assertEqual(
            metadata.identifiers,
            (
                Identifier(namespace="doi", value="10.5555/opencitations.lookup"),
                Identifier(namespace="pmid", value="12345678"),
            ),
        )
        self.assert_author_mapping(
            metadata.authors,
            (
                ExpectedAuthor(
                    kind="person",
                    display_name="Ada Meta",
                    orcid="0000-0002-1825-0097",
                ),
                ExpectedAuthor(
                    kind="unknown",
                    display_name="Open Citations Consortium",
                ),
            ),
        )
        self.assertIsNone(metadata.abstract)
        self.assertIsNone(metadata.language)
        self.assertEqual(metadata.keywords, ())
        self.assertEqual(observation.declared_keywords, ())
        self.assertEqual(observation.reference_texts, ())
        self.assertIsNone(observation.reference_count)
        self.assertIsNone(observation.cited_by_count)
        self.assertEqual(observation.asset_hints, ())
        self.assertEqual(observation.version_links, ())
        self.assertEqual(observation.provenance.source_record_id, "omid:br/0612058700")
        self.assertEqual(observation.provenance.input_sha256, sha256_digest(body))
        self.assertEqual(
            unquote(urlsplit(environment.transport.calls[0].request.url).path),
            "/meta/v1/metadata/doi:10.5555/opencitations.lookup",
        )
        self.assert_no_private_payload(
            result,
            runtime_secret=environment.secret_sentinel,
            forbidden_values=(
                "fixture-secret",
                "Ignored Editor",
                "must not become a keyword",
                "must-not-become-a-hint.pdf",
                "W4249829199",
                "9781402096327",
                "S123456789",
                "0610116006",
            ),
        )

    def test_meta_year_precision_empty_fields_pmid_and_omid_lookup(self) -> None:
        environment = self._new_environment()
        environment.queue_http_response(status=200, body=_fixture("lookup.json"))
        pmid = self.assert_lookup_scan(
            environment,
            _lookup_request(
                ProviderLiteratureKey(identifiers=(Identifier(namespace="pmid", value="12345678"),))
            ),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
        )
        self.assertEqual(
            pmid.observations[0].metadata.identifiers[1],
            Identifier(namespace="pmid", value="12345678"),
        )
        self.assertEqual(
            unquote(urlsplit(environment.transport.calls[0].request.url).path),
            "/meta/v1/metadata/pmid:12345678",
        )

        environment.reset_http()
        environment.queue_http_response(status=200, body=_fixture("lookup.json"))
        omid = self.assert_lookup_scan(
            environment,
            _lookup_request(ProviderLiteratureKey(record_id="omid:br/0612058700")),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
        )
        self.assertEqual(omid.observations[0].provenance.source_record_id, "omid:br/0612058700")
        self.assertEqual(
            unquote(urlsplit(environment.transport.calls[0].request.url).path),
            "/meta/v1/metadata/omid:br/0612058700",
        )

        environment.reset_http()
        environment.queue_http_response(
            status=200,
            body=_fixture("lookup-year-only.json"),
        )
        year_only = self.assert_lookup_scan(
            environment,
            _lookup_request(_doi_key("10.5555/opencitations.year")),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
        )
        metadata = year_only.observations[0].metadata
        self.assertIsNone(metadata.title)
        self.assertEqual(metadata.authors, ())
        self.assertEqual(metadata.publication_date, "2009")
        self.assertEqual(metadata.publication_year, 2009)
        self.assertEqual(metadata.document_type, "book")
        self.assertEqual(metadata.publisher, "Springer Science And Business Media Llc")
        self.assertIsNone(metadata.volume)
        self.assertIsNone(metadata.issue)
        self.assertIsNone(metadata.pages)
        self.assertEqual(accept_observation(year_only.observations[0]).outcome, "created")

    def test_lookup_response_must_match_the_requested_key(self) -> None:
        environment = self._new_environment()
        environment.queue_http_response(status=200, body=_fixture("lookup.json"))
        failed = self.assert_lookup_scan(
            environment,
            _lookup_request(_doi_key("10.5555/opencitations.different")),
            outcome="FAILED",
            raw_item_count=1,
            observation_count=0,
        )
        self.assert_stable_failure(
            failed,
            expected_code="metadata-provider-invalid-record",
            forbidden_values=("10.5555/opencitations.different",),
        )

    def test_lookup_response_must_match_the_selected_locator_only(self) -> None:
        multi_pid_body = (
            b'[{"id":"omid:br/0612058700 doi:10.5555/opencitations.lookup pmid:12345678"}]'
        )
        mismatch_scenarios = (
            (
                ProviderLiteratureKey(
                    record_id="omid:br/09999999999",
                    identifiers=(
                        Identifier(
                            namespace="doi",
                            value="10.5555/opencitations.lookup",
                        ),
                    ),
                ),
                multi_pid_body,
            ),
            (
                ProviderLiteratureKey(
                    identifiers=(
                        Identifier(
                            namespace="doi",
                            value="10.5555/opencitations.different",
                        ),
                        Identifier(namespace="pmid", value="12345678"),
                    )
                ),
                multi_pid_body,
            ),
            (
                ProviderLiteratureKey(
                    record_id="openalex:W4249829199",
                    identifiers=(Identifier(namespace="pmid", value="87654321"),),
                ),
                b'[{"id":"openalex:W4249829199 pmid:12345678"}]',
            ),
        )
        for key, body in mismatch_scenarios:
            with self.subTest(key=key):
                environment = self._new_environment()
                environment.queue_http_response(status=200, body=body)
                failed = self.assert_lookup_scan(
                    environment,
                    _lookup_request(key),
                    outcome="FAILED",
                    raw_item_count=1,
                    observation_count=0,
                )
                self.assert_stable_failure(
                    failed,
                    expected_code="metadata-provider-invalid-record",
                )

        matching = self._new_environment()
        matching.queue_http_response(status=200, body=multi_pid_body)
        accepted = self.assert_lookup_scan(
            matching,
            _lookup_request(
                ProviderLiteratureKey(
                    identifiers=(
                        Identifier(
                            namespace="doi",
                            value="10.5555/opencitations.lookup",
                        ),
                        Identifier(namespace="pmid", value="87654321"),
                    )
                )
            ),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
        )
        self.assertEqual(
            accepted.observations[0].metadata.identifiers,
            (
                Identifier(namespace="doi", value="10.5555/opencitations.lookup"),
                Identifier(namespace="pmid", value="12345678"),
            ),
        )

    def test_openalex_and_unproved_identifier_lookup_keys_are_unsupported(self) -> None:
        keys = (
            ProviderLiteratureKey(record_id="openalex:W4249829199"),
            ProviderLiteratureKey(identifiers=(Identifier(namespace="arxiv", value="2401.00001"),)),
        )
        for key in keys:
            with self.subTest(key=key):
                environment = self._new_environment()
                failed = self.assert_lookup_scan(
                    environment,
                    _lookup_request(key),
                    outcome="FAILED",
                    raw_item_count=0,
                    observation_count=0,
                )
                self.assert_stable_failure(
                    failed,
                    expected_code="metadata-provider-unsupported-key",
                )
                self.assertEqual(environment.transport.calls, [])

    def test_index_references_parse_multi_pid_and_prefixed_groups_once_per_edge(
        self,
    ) -> None:
        environment = self._new_environment()
        body = _fixture("references.json")
        environment.queue_http_response(status=200, body=body)
        result = self.assert_reference_scan(
            environment,
            _reference_request("references", _anchor_key()),
            outcome="EXHAUSTED",
            raw_item_count=3,
            observation_count=0,
            relation_count=3,
        )
        self.assertEqual(len(environment.transport.calls), 1)
        self.assertEqual(
            unquote(urlsplit(environment.transport.calls[0].request.url).path),
            "/index/v2/references/doi:10.5555/opencitations.anchor",
        )
        first, second, third = result.relations
        self.assertEqual(first.citing.record_id, _ANCHOR_OMID)
        self.assertEqual(first.citing.identifiers, (_ANCHOR_DOI, _ANCHOR_PMID))
        self.assertEqual(
            first.cited,
            ProviderLiteratureKey(
                record_id="omid:br/061901512048",
                identifiers=(Identifier(namespace="doi", value="10.5555/opencitations.cited.one"),),
            ),
        )
        self.assertEqual(second.citing.identifiers, (_ANCHOR_DOI, _ANCHOR_PMID))
        self.assertEqual(
            second.cited.identifiers,
            (Identifier(namespace="doi", value="10.5555/opencitations.cited.two"),),
        )
        self.assertEqual(
            third.cited,
            ProviderLiteratureKey(record_id="openalex:W2035776951"),
        )
        self.assertEqual(
            tuple(relation.provenance.source_record_id for relation in result.relations),
            (
                "06120343876-061901512048",
                "06120343876-061901512049",
                "06120343876-061901512050",
            ),
        )
        self.assertEqual(
            {relation.provenance.input_sha256 for relation in result.relations},
            {sha256_digest(body)},
        )
        self.assert_no_private_payload(
            result,
            runtime_secret=environment.secret_sentinel,
            forbidden_values=(
                "fixture-secret",
                "P13Y",
                "journal_sc",
                "author_sc",
                "37",
                "W3099878876",
            ),
        )

    def test_index_citations_and_both_normalize_every_edge_to_citing_then_cited(
        self,
    ) -> None:
        environment = self._new_environment()
        environment.queue_http_response(status=200, body=_fixture("citations.json"))
        cited_by = self.assert_reference_scan(
            environment,
            _reference_request("cited-by", _anchor_key()),
            outcome="EXHAUSTED",
            raw_item_count=2,
            observation_count=0,
            relation_count=2,
        )
        self.assertTrue(
            all(_ANCHOR_DOI in relation.cited.identifiers for relation in cited_by.relations)
        )
        self.assertEqual(
            cited_by.relations[1].citing,
            ProviderLiteratureKey(
                record_id="openalex:W7777777777",
                identifiers=(Identifier(namespace="pmid", value="40000002"),),
            ),
        )

        environment.reset_http()
        _queue_both(environment)
        both = self.assert_reference_scan(
            environment,
            _reference_request("both", _anchor_key()),
            outcome="EXHAUSTED",
            raw_item_count=5,
            observation_count=0,
            relation_count=5,
        )
        self.assertEqual(len(environment.transport.calls), 2)
        self.assertTrue(
            all(_ANCHOR_DOI in relation.citing.identifiers for relation in both.relations[:3])
        )
        self.assertTrue(
            all(_ANCHOR_DOI in relation.cited.identifiers for relation in both.relations[3:])
        )
        acquisition_times = tuple(
            timestamp
            for scope, timestamp in environment.coordinator.scope_acquisition_times[-2:]
            if scope == ACCESS_SCOPE
        )
        self.assertEqual(len(acquisition_times), 2)
        self.assertAlmostEqual(
            acquisition_times[1] - acquisition_times[0],
            1.0 / 3.0,
        )

    def test_scan_limit_does_not_prefetch_citations_and_later_failure_is_partial(
        self,
    ) -> None:
        environment = self._new_environment()
        environment.queue_http_response(status=200, body=_fixture("references.json"))
        limited = self.assert_reference_scan(
            environment,
            _reference_request("both", _anchor_key(), scan_limit=1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=0,
            relation_count=1,
        )
        self.assertEqual(len(environment.transport.calls), 1)
        self.assertEqual(limited.relations[0].citing.identifiers, (_ANCHOR_DOI, _ANCHOR_PMID))

        environment.reset_http()
        _queue_partial(environment)
        partial = self.assert_reference_scan(
            environment,
            _reference_request("both", _anchor_key()),
            outcome="FAILED",
            raw_item_count=3,
            observation_count=0,
            relation_count=3,
        )
        self.assert_stable_failure(
            partial,
            expected_code="metadata-provider-malformed-json",
            forbidden_values=("fixture-secret",),
        )

    def test_unknown_prefix_unsupported_endpoint_and_count_only_are_not_edges(self) -> None:
        scenarios = (
            "unknown-prefix.json",
            "unsupported-endpoint.json",
            "count-only.json",
        )
        for fixture_name in scenarios:
            with self.subTest(fixture=fixture_name):
                environment = self._new_environment()
                environment.queue_http_response(status=200, body=_fixture(fixture_name))
                failed = self.assert_reference_scan(
                    environment,
                    _reference_request("references", _anchor_key()),
                    outcome="FAILED",
                    raw_item_count=1,
                    observation_count=0,
                    relation_count=0,
                )
                self.assert_stable_failure(
                    failed,
                    expected_code="metadata-provider-invalid-record",
                    forbidden_values=("unknown", "9781402096327", "37", "P13Y"),
                )

    def test_index_direction_mismatch_and_self_edge_are_invalid_records(self) -> None:
        bodies = (
            b'[{"oci":"direction-mismatch","citing":"doi:10.5555/opencitations.cited.one",'
            b'"cited":"doi:10.5555/opencitations.anchor"}]',
            b'[{"oci":"self-edge","citing":"doi:10.5555/opencitations.anchor",'
            b'"cited":"doi:10.5555/opencitations.anchor"}]',
        )
        for body in bodies:
            with self.subTest(body=body):
                environment = self._new_environment()
                environment.queue_http_response(status=200, body=body)
                failed = self.assert_reference_scan(
                    environment,
                    _reference_request("references", _anchor_key()),
                    outcome="FAILED",
                    raw_item_count=1,
                    observation_count=0,
                    relation_count=0,
                )
                self.assert_stable_failure(
                    failed,
                    expected_code="metadata-provider-invalid-record",
                )

    def test_index_anchor_must_match_the_selected_locator_only(self) -> None:
        multi_pid_body = (
            b'[{"oci":"selected-locator-reference",'
            b'"citing":"omid:br/06120343876 '
            b'doi:10.5555/opencitations.anchor pmid:32939066",'
            b'"cited":"doi:10.5555/opencitations.cited"}]'
        )
        mismatch_scenarios = (
            (
                "references",
                ProviderLiteratureKey(
                    record_id="omid:br/09999999999",
                    identifiers=(_ANCHOR_DOI,),
                ),
                multi_pid_body,
            ),
            (
                "references",
                ProviderLiteratureKey(
                    identifiers=(
                        Identifier(
                            namespace="doi",
                            value="10.5555/opencitations.different",
                        ),
                        _ANCHOR_PMID,
                    )
                ),
                multi_pid_body,
            ),
            (
                "references",
                ProviderLiteratureKey(
                    record_id="openalex:W3099878876",
                    identifiers=(Identifier(namespace="pmid", value="40000000"),),
                ),
                (
                    b'[{"oci":"selected-pmid-reference",'
                    b'"citing":"openalex:W3099878876 pmid:32939066",'
                    b'"cited":"doi:10.5555/opencitations.cited"}]'
                ),
            ),
            (
                "cited-by",
                ProviderLiteratureKey(
                    identifiers=(
                        Identifier(
                            namespace="doi",
                            value="10.5555/opencitations.different",
                        ),
                        _ANCHOR_PMID,
                    )
                ),
                (
                    b'[{"oci":"selected-locator-citation",'
                    b'"citing":"doi:10.5555/opencitations.citing",'
                    b'"cited":"doi:10.5555/opencitations.anchor '
                    b'pmid:32939066"}]'
                ),
            ),
        )
        for direction, key, body in mismatch_scenarios:
            with self.subTest(direction=direction, key=key):
                environment = self._new_environment()
                environment.queue_http_response(status=200, body=body)
                failed = self.assert_reference_scan(
                    environment,
                    _reference_request(direction, key),  # type: ignore[arg-type]
                    outcome="FAILED",
                    raw_item_count=1,
                    observation_count=0,
                    relation_count=0,
                )
                self.assert_stable_failure(
                    failed,
                    expected_code="metadata-provider-invalid-record",
                )

        matching = self._new_environment()
        matching.queue_http_response(status=200, body=multi_pid_body)
        accepted = self.assert_reference_scan(
            matching,
            _reference_request(
                "references",
                ProviderLiteratureKey(
                    identifiers=(
                        _ANCHOR_DOI,
                        Identifier(namespace="pmid", value="40000000"),
                    )
                ),
            ),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=0,
            relation_count=1,
        )
        self.assertEqual(accepted.relations[0].citing.identifiers, (_ANCHOR_DOI, _ANCHOR_PMID))

    def test_zero_results_wrong_shape_malformed_and_oversize_are_distinct(self) -> None:
        zero = self._new_environment()
        zero.queue_http_response(status=200, body=_fixture("zero-results.json"))
        self.assert_lookup_scan(
            zero,
            _lookup_request(_doi_key("10.5555/opencitations.missing")),
            outcome="EXHAUSTED",
            raw_item_count=0,
            observation_count=0,
        )

        both_empty = self._new_environment()
        both_empty.queue_http_response(status=200, body=_fixture("zero-results.json"))
        both_empty.queue_http_response(status=200, body=_fixture("zero-results.json"))
        self.assert_reference_scan(
            both_empty,
            _reference_request("both", _anchor_key()),
            outcome="EXHAUSTED",
            raw_item_count=0,
            observation_count=0,
            relation_count=0,
        )
        self.assertEqual(len(both_empty.transport.calls), 2)

        failure_cases = (
            (b'{"wrong":[]}', "metadata-provider-unknown-shape"),
            (
                b'[{"id":"doi:10.5555/opencitations.lookup"},'
                b'{"id":"doi:10.5555/opencitations.lookup"}]',
                "metadata-provider-unknown-shape",
            ),
            (_fixture("malformed.json"), "metadata-provider-malformed-json"),
            (b" " * 4_300_000, "metadata-provider-response-too-large"),
        )
        for body, expected_code in failure_cases:
            with self.subTest(code=expected_code):
                environment = self._new_environment()
                environment.queue_http_response(status=200, body=body)
                failed = self.assert_lookup_scan(
                    environment,
                    _lookup_request(_doi_key("10.5555/opencitations.lookup")),
                    outcome="FAILED",
                    raw_item_count=0,
                    observation_count=0,
                )
                self.assert_stable_failure(failed, expected_code=expected_code)

    def test_private_token_never_enters_safe_request_and_auth_does_not_fallback(self) -> None:
        secret = "opencitations private token sentinel"
        environment = self._new_environment(token=secret)
        environment.queue_http_response(status=401)
        denied = self.assert_lookup_scan(
            environment,
            _lookup_request(_doi_key("10.5555/opencitations.lookup")),
            outcome="FAILED",
            raw_item_count=0,
            observation_count=0,
        )
        self.assert_stable_failure(
            denied,
            expected_code="metadata-provider-access-denied",
            forbidden_values=(secret,),
        )
        self.assertEqual(len(environment.transport.calls), 1)
        call = environment.transport.calls[0]
        self.assertIn(("authorization", secret), call.headers)
        self.assertEqual(
            getattr(call.destination, "origin", None),
            Origin("https", "api.opencitations.net", 443),
        )
        self.assertNotIn(secret, call.request.model_dump_json())
        self.assertNotIn(secret, repr(call))

        anonymous = self._new_environment()
        anonymous.queue_http_response(status=200, body=_fixture("zero-results.json"))
        self.assert_lookup_scan(
            anonymous,
            _lookup_request(_doi_key("10.5555/opencitations.lookup")),
            outcome="EXHAUSTED",
            raw_item_count=0,
            observation_count=0,
        )
        self.assertFalse(
            any(
                name.casefold() == "authorization"
                for name, _value in anonymous.transport.calls[0].headers
            )
        )

    def test_replay_ids_ignore_observed_at_but_relation_endpoints_do_not_collide(self) -> None:
        lookup_environment = self._new_environment()
        lookup_body = _fixture("lookup.json")

        def execute_lookup() -> MetadataProviderResult:
            lookup_environment.queue_http_response(status=200, body=lookup_body)
            return self.assert_lookup_scan(
                lookup_environment,
                _lookup_request(_doi_key("10.5555/opencitations.lookup")),
                outcome="EXHAUSTED",
                raw_item_count=1,
                observation_count=1,
            )

        first_lookup = execute_lookup()
        lookup_environment.reset_http()
        lookup_environment.wall_clock.advance(60.0)
        replay_lookup = execute_lookup()
        self.assertNotEqual(
            first_lookup.observations[0].provenance.observed_at,
            replay_lookup.observations[0].provenance.observed_at,
        )
        self.assertEqual(
            first_lookup.observations[0].observation_id,
            replay_lookup.observations[0].observation_id,
        )
        self.assertEqual(
            first_lookup.observations[0].provenance.provenance_id,
            replay_lookup.observations[0].provenance.provenance_id,
        )

        relation_environment = self._new_environment()
        reference_body = _fixture("references.json")

        def execute_relations() -> MetadataProviderResult:
            relation_environment.queue_http_response(status=200, body=reference_body)
            return self.assert_reference_scan(
                relation_environment,
                _reference_request("references", _anchor_key()),
                outcome="EXHAUSTED",
                raw_item_count=3,
                observation_count=0,
                relation_count=3,
            )

        first_relations = execute_relations()
        relation_environment.reset_http()
        relation_environment.wall_clock.advance(60.0)
        replay_relations = execute_relations()
        self.assertEqual(
            tuple(relation.observation_id for relation in first_relations.relations),
            tuple(relation.observation_id for relation in replay_relations.relations),
        )
        self.assertEqual(
            len({relation.observation_id for relation in first_relations.relations}),
            3,
        )
        self.assertEqual(
            tuple(relation.provenance.provenance_id for relation in first_relations.relations),
            tuple(relation.provenance.provenance_id for relation in replay_relations.relations),
        )

    def test_programming_errors_and_cancelled_error_propagate(self) -> None:
        def programming_error() -> ObservationId:
            raise RuntimeError("programming sentinel")

        lookup = self._new_environment(observation_id_factory=programming_error)
        lookup.queue_http_response(status=200, body=_fixture("lookup.json"))
        with self.assertRaisesRegex(RuntimeError, "programming sentinel"):
            lookup.api.lookup(_lookup_request(_doi_key("10.5555/opencitations.lookup")))

        def cancelled() -> ObservationId:
            raise asyncio.CancelledError

        references = self._new_environment(observation_id_factory=cancelled)
        references.queue_http_response(status=200, body=_fixture("references.json"))
        with self.assertRaises(asyncio.CancelledError):
            references.api.query_references(_reference_request("references", _anchor_key()))


if __name__ == "__main__":
    unittest.main()
