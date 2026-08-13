from __future__ import annotations

import asyncio
import threading
import unittest
from collections.abc import Callable
from pathlib import Path
from typing import Literal
from unittest.mock import patch
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import UUID

from metadata_provider_contract import (
    ContractBinding,
    ContractEnvironment,
    ContractExpectedResult,
    ContractPorts,
    ContractScenario,
    ExpectedAffiliation,
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
from sciretriever.metadata.providers.openalex import (
    ACCESS_SCOPE as OPENALEX_ACCESS_SCOPE,
)
from sciretriever.metadata.providers.openalex import (
    BASELINE_ACCESS_POLICY as OPENALEX_BASELINE_ACCESS_POLICY,
)
from sciretriever.metadata.providers.openalex import (
    OpenAlexAdapter,
)
from sciretriever.metadata.providers.semantic_scholar import (
    ACCESS_SCOPE as SEMANTIC_SCHOLAR_ACCESS_SCOPE,
)
from sciretriever.metadata.providers.semantic_scholar import (
    BASELINE_ACCESS_POLICY as SEMANTIC_SCHOLAR_BASELINE_ACCESS_POLICY,
)
from sciretriever.metadata.providers.semantic_scholar import (
    SemanticScholarAdapter,
)
from sciretriever.metadata.rules import (
    MetadataLookupRequest,
    MetadataProviderResult,
    MetadataReferenceQueryRequest,
    ProviderReferenceQuery,
    TopicSearchQuery,
)
from sciretriever.model.acquisition import AssetHint, AssetHintKind, AssetRole
from sciretriever.model.discovery import ProviderDiscoveryLimit, TopicDiscoveryInput
from sciretriever.model.literature import (
    Identifier,
    Literature,
    LiteratureStatus,
    VersionRole,
)
from sciretriever.model.metadata import ProviderLiteratureKey
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
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

_FIXTURES = Path(__file__).parent / "fixtures" / "metadata"
_S2_ANCHOR = "1111111111111111111111111111111111111111"
_OPENALEX_ANCHOR = "https://openalex.org/W4444444444"


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
    """Expose deterministic selection checkpoints for one waiting request."""

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


def _assert_atomic_retry_after_feedback(
    case: unittest.TestCase,
    *,
    environment: ContractEnvironment,
    adapter: TopicSearchPort,
    coordinator: _FeedbackCheckpointCoordinator,
    patch_target: str,
) -> None:
    environment.queue_http_response(
        status=429,
        headers=(("Retry-After", "5"),),
    )
    environment.queue_http_response(
        status=200,
        body=(
            _fixture("semantic_scholar", "zero-results.json")
            if adapter.provider_name == "semantic-scholar"
            else _fixture("openalex", "zero-results.json")
        ),
    )
    feedback_entered = threading.Event()
    resume_feedback = threading.Event()
    first_done = threading.Event()
    second_done = threading.Event()
    first_failures: list[MetadataProviderFailure] = []
    second_deliveries: list[object] = []
    unexpected: list[BaseException] = []

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
            adapter.open_topic_search(
                TopicSearchQuery(query="atomic provider feedback")
            ).pull_raw_item()
        except MetadataProviderFailure as error:
            first_failures.append(error)
        except BaseException as error:
            unexpected.append(error)
        finally:
            first_done.set()

    def second_request() -> None:
        coordinator.track_current_thread()
        try:
            delivery = adapter.open_topic_search(
                TopicSearchQuery(query="atomic provider feedback")
            ).pull_raw_item()
            second_deliveries.append(delivery)
        except BaseException as error:
            unexpected.append(error)
        finally:
            second_done.set()

    first = threading.Thread(target=first_request)
    second = threading.Thread(target=second_request)
    try:
        with patch(patch_target, side_effect=paused_feedback):
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


def _fixture(provider: str, name: str) -> bytes:
    return (_FIXTURES / provider / name).read_bytes()


def _wall_timestamp(environment: ContractEnvironment) -> UtcTimestamp:
    return UtcTimestamp(environment.wall_clock().isoformat().replace("+00:00", "Z"))


def _topic_request(
    provider_name: str,
    scan_limit: int,
    *,
    year_from: int | None = 2020,
    year_to: int | None = 2025,
) -> TopicDiscoveryInput:
    return TopicDiscoveryInput(
        kind="topic",
        query="retrieval systems",
        year_from=year_from,
        year_to=year_to,
        providers=(
            ProviderDiscoveryLimit(
                provider_name=provider_name,
                scan_limit=scan_limit,
            ),
        ),
    )


def _reference_request(
    provider_name: str,
    direction: Literal["references", "cited-by", "both"],
    key: ProviderLiteratureKey,
    *,
    scan_limit: int = 10,
) -> MetadataReferenceQueryRequest:
    return MetadataReferenceQueryRequest(
        direction=direction,
        providers=(
            ProviderReferenceQuery(
                provider_name=provider_name,
                keys=(key,),
                scan_limit=scan_limit,
            ),
        ),
    )


def _semantic_environment(
    *,
    api_key: str | None = None,
    access_policy: AccessPolicy | None = None,
    observation_id_factory: Callable[[], ObservationId] | None = None,
) -> ContractEnvironment:
    ids = _IdFactories(10_000)

    def assemble(environment: ContractEnvironment) -> ContractPorts:
        adapter = SemanticScholarAdapter(
            http_client=environment.http_client,
            access_coordinator=environment.coordinator,
            access_scope=environment.scope,
            access_policy=access_policy or environment.policy,
            observation_id_factory=observation_id_factory or ids.observation,
            provenance_id_factory=ids.provenance,
            clock=lambda: _wall_timestamp(environment),
            api_key=api_key,
            page_size=2,
        )
        return ContractPorts(
            topic_search=adapter,
            lookup=adapter,
            reference_query=adapter,
        )

    return ContractEnvironment(
        provider_name="semantic-scholar",
        capabilities=frozenset({"search", "lookup", "references"}),
        port_factory=assemble,
        expected_scope=SEMANTIC_SCHOLAR_ACCESS_SCOPE,
    )


def _openalex_environment(
    *,
    api_key: str | None = None,
    access_policy: AccessPolicy | None = None,
    observation_id_factory: Callable[[], ObservationId] | None = None,
) -> ContractEnvironment:
    ids = _IdFactories(20_000)

    def assemble(environment: ContractEnvironment) -> ContractPorts:
        adapter = OpenAlexAdapter(
            http_client=environment.http_client,
            access_coordinator=environment.coordinator,
            access_scope=environment.scope,
            access_policy=access_policy or environment.policy,
            observation_id_factory=observation_id_factory or ids.observation,
            provenance_id_factory=ids.provenance,
            clock=lambda: _wall_timestamp(environment),
            api_key=api_key,
            page_size=2,
        )
        return ContractPorts(
            topic_search=adapter,
            lookup=adapter,
            reference_query=adapter,
        )

    return ContractEnvironment(
        provider_name="openalex",
        capabilities=frozenset({"search", "lookup", "references"}),
        port_factory=assemble,
        expected_scope=OPENALEX_ACCESS_SCOPE,
    )


def _semantic_contract_ports(environment: ContractEnvironment) -> ContractPorts:
    ids = _IdFactories(30_000)
    adapter = SemanticScholarAdapter(
        http_client=environment.http_client,
        access_coordinator=environment.coordinator,
        access_scope=environment.scope,
        access_policy=environment.policy,
        observation_id_factory=ids.observation,
        provenance_id_factory=ids.provenance,
        clock=lambda: _wall_timestamp(environment),
        api_key=environment.secret_sentinel,
        page_size=2,
    )
    return ContractPorts(topic_search=adapter, lookup=adapter, reference_query=adapter)


def _openalex_contract_ports(environment: ContractEnvironment) -> ContractPorts:
    ids = _IdFactories(40_000)
    adapter = OpenAlexAdapter(
        http_client=environment.http_client,
        access_coordinator=environment.coordinator,
        access_scope=environment.scope,
        access_policy=environment.policy,
        observation_id_factory=ids.observation,
        provenance_id_factory=ids.provenance,
        clock=lambda: _wall_timestamp(environment),
        api_key=environment.secret_sentinel,
        page_size=2,
    )
    return ContractPorts(topic_search=adapter, lookup=adapter, reference_query=adapter)


def _queue_semantic_search(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("semantic_scholar", "search-page-1.json"),
    )
    environment.queue_http_response(
        status=200,
        body=_fixture("semantic_scholar", "search-page-2.json"),
    )


def _semantic_search_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 2)
    first = parse_qs(urlsplit(environment.transport.calls[0].request.url).query)
    second = parse_qs(urlsplit(environment.transport.calls[1].request.url).query)
    case.assertEqual(first["offset"], ["0"])
    case.assertEqual(second["offset"], ["2"])
    case.assertEqual(result.observations[0].metadata.title, "A Semantic Scholar record")


def _queue_semantic_lookup(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("semantic_scholar", "lookup.json"),
    )


def _semantic_lookup_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 1)
    case.assertEqual(
        result.observations[0].provenance.source_record_id,
        "4444444444444444444444444444444444444444",
    )


def _queue_semantic_references(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("semantic_scholar", "references-page-1.json"),
    )
    environment.queue_http_response(
        status=200,
        body=_fixture("semantic_scholar", "references-page-2.json"),
    )


def _semantic_reference_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 2)
    case.assertTrue(
        all(
            urlsplit(call.request.url).path.endswith("/references")
            for call in environment.transport.calls
        )
    )
    case.assertEqual(
        tuple(relation.citing.record_id for relation in result.relations),
        (_S2_ANCHOR, _S2_ANCHOR),
    )
    case.assertEqual(len(result.observations), 1)


def _queue_semantic_partial(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("semantic_scholar", "search-page-1.json"),
    )
    environment.queue_http_response(
        status=200,
        body=_fixture("semantic_scholar", "malformed.json"),
    )


def _queue_openalex_search(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("openalex", "search-page-1.json"),
    )
    environment.queue_http_response(
        status=200,
        body=_fixture("openalex", "search-page-2.json"),
    )


def _openalex_search_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 2)
    first = parse_qs(urlsplit(environment.transport.calls[0].request.url).query)
    second = parse_qs(urlsplit(environment.transport.calls[1].request.url).query)
    case.assertEqual(first["cursor"], ["*"])
    case.assertEqual(second["cursor"], ["cursor-two"])
    case.assertEqual(result.observations[0].metadata.abstract, "A reconstructed OpenAlex abstract.")


def _queue_openalex_lookup(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("openalex", "lookup.json"),
    )


def _openalex_lookup_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 1)
    case.assertEqual(result.observations[0].provenance.source_record_id, _OPENALEX_ANCHOR)
    case.assertEqual(len(result.relations), 2)


def _queue_openalex_both_directions(environment: ContractEnvironment) -> None:
    _queue_openalex_lookup(environment)
    environment.queue_http_response(
        status=200,
        body=_fixture("openalex", "cited-by-page-1.json"),
    )
    environment.queue_http_response(
        status=200,
        body=_fixture("openalex", "cited-by-page-2.json"),
    )


def _openalex_reference_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 3)
    case.assertEqual(len(result.relations), 4)
    case.assertEqual(
        tuple(relation.citing.record_id for relation in result.relations[:2]),
        (_OPENALEX_ANCHOR, _OPENALEX_ANCHOR),
    )
    case.assertEqual(
        tuple(relation.cited.record_id for relation in result.relations[2:]),
        (_OPENALEX_ANCHOR, _OPENALEX_ANCHOR),
    )


def _queue_openalex_partial(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("openalex", "search-page-1.json"),
    )
    environment.queue_http_response(
        status=200,
        body=_fixture("openalex", "malformed.json"),
    )


def _queue_throttled(environment: ContractEnvironment) -> None:
    environment.queue_http_response(status=429, headers=(("Retry-After", "5"),))


def _feedback_evidence(
    contract: ProviderContractCase,
    environment: ContractEnvironment,
    result: MetadataProviderResult,
) -> None:
    case = contract._test_case()
    case.assertEqual(len(environment.transport.calls), 1)
    case.assertEqual(len(environment.coordinator.feedback_records), 1)
    case.assertEqual(
        result.failure.code if result.failure is not None else None,
        "metadata-provider-throttled",
    )


def _queue_semantic_zero(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("semantic_scholar", "zero-results.json"),
    )


def _queue_openalex_zero(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=200,
        body=_fixture("openalex", "zero-results.json"),
    )


def _queue_semantic_same_origin_redirect(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=302,
        headers=(("Location", "https://api.semanticscholar.org/redirected-search"),),
    )
    _queue_semantic_zero(environment)


def _queue_semantic_cross_origin_redirect(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=302,
        headers=(("Location", "https://redirect.example.org/semantic-search"),),
    )
    _queue_semantic_zero(environment)


def _queue_openalex_same_origin_redirect(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=302,
        headers=(("Location", "https://api.openalex.org/redirected-search"),),
    )
    _queue_openalex_zero(environment)


def _queue_openalex_cross_origin_redirect(environment: ContractEnvironment) -> None:
    environment.queue_http_response(
        status=302,
        headers=(("Location", "https://redirect.example.org/openalex-search"),),
    )
    _queue_openalex_zero(environment)


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
    case.assertEqual(len(result.observations), 2)


def _semantic_contract_binding() -> ContractBinding:
    return ContractBinding(
        provider_name="semantic-scholar",
        capabilities=frozenset({"search", "lookup", "references"}),
        expected_scope=SEMANTIC_SCHOLAR_ACCESS_SCOPE,
        credential_mode="header",
        port_factory=_semantic_contract_ports,
        scenarios=(
            ContractScenario(
                name="paged-search",
                capability="search",
                request=_topic_request("semantic-scholar", 10),
                prepare=_queue_semantic_search,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=3,
                    observation_count=3,
                    relation_count=0,
                ),
                evidence=_semantic_search_evidence,
            ),
            ContractScenario(
                name="exact-lookup",
                capability="lookup",
                request=MetadataLookupRequest(
                    provider_name="semantic-scholar",
                    key=ProviderLiteratureKey(record_id="4444444444444444444444444444444444444444"),
                    scan_limit=2,
                ),
                prepare=_queue_semantic_lookup,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=0,
                ),
                evidence=_semantic_lookup_evidence,
            ),
            ContractScenario(
                name="references-with-inline-metadata",
                capability="references",
                request=_reference_request(
                    "semantic-scholar",
                    "references",
                    ProviderLiteratureKey(record_id=_S2_ANCHOR),
                ),
                prepare=_queue_semantic_references,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=2,
                    observation_count=1,
                    relation_count=2,
                ),
                evidence=_semantic_reference_evidence,
            ),
            ContractScenario(
                name="retry-after-feedback",
                capability="search",
                request=_topic_request("semantic-scholar", 2),
                prepare=_queue_throttled,
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
                name="same-origin-header-credential",
                capability="search",
                request=_topic_request("semantic-scholar", 2),
                prepare=_queue_semantic_same_origin_redirect,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=0,
                    observation_count=0,
                    relation_count=0,
                ),
                evidence=_redirect_evidence,
                credential_redirect="same-origin",
            ),
            ContractScenario(
                name="cross-origin-header-credential",
                capability="search",
                request=_topic_request("semantic-scholar", 2),
                prepare=_queue_semantic_cross_origin_redirect,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=0,
                    observation_count=0,
                    relation_count=0,
                ),
                evidence=_redirect_evidence,
                credential_redirect="cross-origin",
            ),
            ContractScenario(
                name="malformed-second-page-keeps-partial-result",
                capability="search",
                request=_topic_request("semantic-scholar", 10),
                prepare=_queue_semantic_partial,
                expected=ContractExpectedResult(
                    outcome="FAILED",
                    raw_item_count=2,
                    observation_count=2,
                    relation_count=0,
                    failure_code="metadata-provider-malformed-json",
                ),
                evidence=_partial_evidence,
            ),
        ),
    )


def _openalex_contract_binding() -> ContractBinding:
    return ContractBinding(
        provider_name="openalex",
        capabilities=frozenset({"search", "lookup", "references"}),
        expected_scope=OPENALEX_ACCESS_SCOPE,
        credential_mode="query",
        port_factory=_openalex_contract_ports,
        scenarios=(
            ContractScenario(
                name="cursor-search-with-referenced-works",
                capability="search",
                request=_topic_request("openalex", 10),
                prepare=_queue_openalex_search,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=3,
                    observation_count=3,
                    relation_count=3,
                ),
                evidence=_openalex_search_evidence,
            ),
            ContractScenario(
                name="exact-lookup",
                capability="lookup",
                request=MetadataLookupRequest(
                    provider_name="openalex",
                    key=ProviderLiteratureKey(record_id=_OPENALEX_ANCHOR),
                    scan_limit=2,
                ),
                prepare=_queue_openalex_lookup,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=1,
                    observation_count=1,
                    relation_count=2,
                ),
                evidence=_openalex_lookup_evidence,
            ),
            ContractScenario(
                name="both-reference-directions",
                capability="references",
                request=_reference_request(
                    "openalex",
                    "both",
                    ProviderLiteratureKey(record_id=_OPENALEX_ANCHOR),
                ),
                prepare=_queue_openalex_both_directions,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=3,
                    observation_count=3,
                    relation_count=4,
                ),
                evidence=_openalex_reference_evidence,
            ),
            ContractScenario(
                name="retry-after-feedback",
                capability="search",
                request=_topic_request("openalex", 2),
                prepare=_queue_throttled,
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
                name="same-origin-query-credential",
                capability="search",
                request=_topic_request("openalex", 2),
                prepare=_queue_openalex_same_origin_redirect,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=0,
                    observation_count=0,
                    relation_count=0,
                ),
                evidence=_redirect_evidence,
                credential_redirect="same-origin",
            ),
            ContractScenario(
                name="cross-origin-query-credential",
                capability="search",
                request=_topic_request("openalex", 2),
                prepare=_queue_openalex_cross_origin_redirect,
                expected=ContractExpectedResult(
                    outcome="EXHAUSTED",
                    raw_item_count=0,
                    observation_count=0,
                    relation_count=0,
                ),
                evidence=_redirect_evidence,
                credential_redirect="cross-origin",
            ),
            ContractScenario(
                name="malformed-second-page-keeps-partial-result",
                capability="search",
                request=_topic_request("openalex", 10),
                prepare=_queue_openalex_partial,
                expected=ContractExpectedResult(
                    outcome="FAILED",
                    raw_item_count=2,
                    observation_count=2,
                    relation_count=2,
                    failure_code="metadata-provider-malformed-json",
                ),
                evidence=_partial_evidence,
            ),
        ),
    )


class SemanticScholarAdapterTests(ProviderContractCase, unittest.TestCase):
    def provider_contract_binding(self) -> ContractBinding:
        return _semantic_contract_binding()

    def _semantic(self, *, api_key: str | None = None) -> ContractEnvironment:
        environment = _semantic_environment(api_key=api_key)
        self.addCleanup(environment.close)
        return environment

    def test_capabilities_scope_and_explicit_credential_configuration(self) -> None:
        environment = self._semantic()
        adapter = environment.ports.topic_search
        self.assertIs(adapter, environment.ports.lookup)
        self.assertIs(adapter, environment.ports.reference_query)
        self.assertIsInstance(adapter, TopicSearchPort)
        self.assertIsInstance(adapter, MetadataLookupPort)
        self.assertIsInstance(adapter, ReferenceQueryPort)
        self.assert_scope_is_neutral(environment.scope)
        self.assertEqual(
            SEMANTIC_SCHOLAR_ACCESS_SCOPE,
            AccessScope(provider_name="semantic-scholar", channel="api"),
        )
        self.assertEqual(
            SEMANTIC_SCHOLAR_BASELINE_ACCESS_POLICY,
            AccessPolicy(max_concurrency=1, min_start_interval=1.0),
        )

        ids = _IdFactories(50_000)
        with self.assertRaises(ValueError):
            SemanticScholarAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=AccessScope(
                    provider_name="wrong-provider",
                    channel="api",
                    service_name="metadata",
                ),
                access_policy=AccessPolicy(max_concurrency=1),
                observation_id_factory=ids.observation,
                provenance_id_factory=ids.provenance,
                clock=lambda: _wall_timestamp(environment),
                page_size=2,
            )
        with self.assertRaises(ValueError):
            SemanticScholarAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=AccessScope(
                    provider_name="semantic-scholar",
                    channel="api",
                    service_name="metadata",
                ),
                access_policy=AccessPolicy(max_concurrency=1),
                observation_id_factory=ids.observation,
                provenance_id_factory=ids.provenance,
                clock=lambda: _wall_timestamp(environment),
                page_size=2,
            )
        with self.assertRaises(ValueError):
            SemanticScholarAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=AccessScope(
                    provider_name="semantic-scholar",
                    channel="web",
                ),
                access_policy=AccessPolicy(max_concurrency=1),
                observation_id_factory=ids.observation,
                provenance_id_factory=ids.provenance,
                clock=lambda: _wall_timestamp(environment),
                page_size=2,
            )
        with self.assertRaises(ValueError):
            SemanticScholarAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=environment.scope,
                access_policy=environment.policy,
                observation_id_factory=ids.observation,
                provenance_id_factory=ids.provenance,
                clock=lambda: _wall_timestamp(environment),
                api_key="   ",
                page_size=2,
            )

        secret = "repr-must-not-expose-key"
        keyed = _semantic_environment(api_key=secret)
        self.addCleanup(keyed.close)
        self.assertNotIn(secret, repr(keyed.ports.topic_search))

    def test_baseline_policy_cannot_be_loosened_and_operator_policy_can_tighten(
        self,
    ) -> None:
        operator_policy = AccessPolicy(
            max_concurrency=8,
            min_start_interval=0.25,
            cooldown_after_completion=2.0,
            burst_limit=5,
            window_seconds=10.0,
            backoff_seconds=3.0,
            max_backoff_seconds=120.0,
        )
        environment = _semantic_environment(access_policy=operator_policy)
        self.addCleanup(environment.close)
        _queue_semantic_zero(environment)
        self.assert_topic_scan(
            environment,
            _topic_request("semantic-scholar", 2),
            outcome="EXHAUSTED",
            raw_item_count=0,
            observation_count=0,
        )
        self.assertEqual(
            environment.coordinator.policy_for(environment.scope),
            AccessPolicy.strictest(
                SEMANTIC_SCHOLAR_BASELINE_ACCESS_POLICY,
                operator_policy,
            ),
        )

    def test_retry_after_feedback_is_atomic_with_scope_release(self) -> None:
        environment = self._semantic()
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
        ids = _IdFactories(15_000)
        adapter = SemanticScholarAdapter(
            http_client=http_client,
            access_coordinator=coordinator,
            access_scope=SEMANTIC_SCHOLAR_ACCESS_SCOPE,
            access_policy=AccessPolicy(max_concurrency=1),
            observation_id_factory=ids.observation,
            provenance_id_factory=ids.provenance,
            clock=lambda: _wall_timestamp(environment),
            page_size=2,
        )

        _assert_atomic_retry_after_feedback(
            self,
            environment=environment,
            adapter=adapter,
            coordinator=coordinator,
            patch_target=(
                "sciretriever.metadata.providers.semantic_scholar.adapter.retry_after_feedback"
            ),
        )

    def test_invalid_retry_after_on_429_keeps_conservative_throttling(self) -> None:
        environment = self._semantic()
        environment.queue_http_response(
            status=429,
            headers=(("Retry-After", "not-a-valid-delay"),),
        )
        failed = self.assert_topic_scan(
            environment,
            _topic_request("semantic-scholar", 2),
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

    def test_search_maps_whitelisted_metadata_and_pages_lazily(self) -> None:
        environment = self._semantic()
        page_one = _fixture("semantic_scholar", "search-page-1.json")
        environment.queue_http_response(status=200, body=page_one)
        environment.queue_http_response(
            status=200,
            body=_fixture("semantic_scholar", "search-page-2.json"),
        )
        result = self.assert_topic_scan(
            environment,
            _topic_request("semantic-scholar", 10),
            outcome="EXHAUSTED",
            raw_item_count=3,
            observation_count=3,
            relation_count=0,
        )

        self.assertEqual(len(environment.transport.calls), 2)
        acquisition_times = tuple(
            timestamp
            for scope, timestamp in environment.coordinator.scope_acquisition_times
            if scope == SEMANTIC_SCHOLAR_ACCESS_SCOPE
        )
        self.assertEqual(len(acquisition_times), 2)
        self.assertGreaterEqual(acquisition_times[1] - acquisition_times[0], 1.0)
        first_url = urlsplit(environment.transport.calls[0].request.url)
        second_url = urlsplit(environment.transport.calls[1].request.url)
        self.assertEqual(
            (first_url.scheme, first_url.netloc, first_url.path),
            ("https", "api.semanticscholar.org", "/graph/v1/paper/search"),
        )
        first_query = parse_qs(first_url.query)
        second_query = parse_qs(second_url.query)
        self.assertEqual(first_query["query"], ["retrieval systems"])
        self.assertEqual(first_query["offset"], ["0"])
        self.assertEqual(first_query["limit"], ["2"])
        self.assertEqual(first_query["year"], ["2020-2025"])
        self.assertIn("paperId", first_query["fields"][0].split(","))
        self.assertEqual(second_query["offset"], ["2"])
        self.assertNotIn("api_key", first_query)

        observation = result.observations[0]
        metadata = observation.metadata
        self.assertEqual(metadata.title, "A Semantic Scholar record")
        self.assertEqual(metadata.abstract, "An explicit provider abstract.")
        self.assertEqual(metadata.publication_date, "2024-02-29")
        self.assertEqual(metadata.publication_year, 2024)
        self.assertEqual(metadata.document_type, "journal-article")
        self.assertEqual(metadata.venue, "Journal of Neutral Metadata")
        self.assertEqual(metadata.volume, "42")
        self.assertEqual(metadata.pages, "101-119")
        self.assertIsNone(metadata.issue)
        self.assertEqual(metadata.keywords, ())
        self.assertEqual(observation.declared_keywords, ())
        self.assertEqual(observation.reference_texts, ())
        self.assertEqual(observation.reference_count, 17)
        self.assertEqual(observation.cited_by_count, 29)
        self.assertEqual(observation.version_links, ())
        self.assert_author_mapping(
            metadata.authors,
            (
                ExpectedAuthor(kind="unknown", display_name="Ada Example"),
                ExpectedAuthor(kind="unknown", display_name="Research Collaboration"),
            ),
        )
        self.assert_identifier_record_id_separation(
            observation,
            expected_identifiers=(
                Identifier(namespace="doi", value="10.5555/semantic.openalex"),
                Identifier(namespace="arxiv", value="2501.01234"),
                Identifier(namespace="pmid", value="01234567"),
                Identifier(namespace="pmcid", value="PMC7654321"),
            ),
            expected_record_id=_S2_ANCHOR,
            forbidden_record_ids=("123456", "987654", "journals/example/private"),
        )
        self.assert_asset_hints(
            observation,
            (
                AssetHint(
                    url="https://assets.example.org/semantic-paper.pdf",
                    kind=AssetHintKind.DIRECT_FILE,
                    media_type="application/pdf",
                    asset_role=AssetRole.PRIMARY_PDF,
                    access_status="HYBRID",
                    license="CCBY",
                ),
            ),
            runtime_secret=environment.secret_sentinel,
        )
        self.assertEqual(observation.provenance.input_sha256, sha256_digest(page_one))
        self.assertEqual(observation.provenance.observed_at, _wall_timestamp(environment))

        sparse = result.observations[1]
        self.assertEqual(sparse.metadata.identifiers, ())
        self.assertEqual(sparse.asset_hints, ())
        rejection = accept_observation(sparse)
        self.assertEqual(rejection.outcome, "rejected")
        self.assertEqual(rejection.reason, "missing-title-or-doi")
        self.assertEqual(rejection.observations, ())

        self.assert_no_private_payload(
            result,
            runtime_secret=environment.secret_sentinel,
            forbidden_values=(
                "fixture-secret",
                "adapter-whitelist-must-ignore-this-key",
                "Must not become content.",
                "Computer Science",
                "Must not become a keyword",
                "author-private-1",
                "venue-private-id",
            ),
        )

    def test_scan_limit_has_no_prefetch_and_second_page_failure_is_partial(self) -> None:
        environment = self._semantic()
        environment.queue_http_response(
            status=200,
            body=_fixture("semantic_scholar", "search-page-1.json"),
        )
        limited = self.assert_topic_scan(
            environment,
            _topic_request("semantic-scholar", 1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
        )
        self.assertEqual(len(environment.transport.calls), 1)
        self.assertEqual(limited.observations[0].metadata.title, "A Semantic Scholar record")

        environment.reset_http()
        _queue_semantic_partial(environment)
        partial = self.assert_topic_scan(
            environment,
            _topic_request("semantic-scholar", 10),
            outcome="FAILED",
            raw_item_count=2,
            observation_count=2,
        )
        self.assert_stable_failure(
            partial,
            expected_code="metadata-provider-malformed-json",
            forbidden_values=("fixture-secret", environment.secret_sentinel),
        )

    def test_lookup_uses_one_structured_identifier_path_parameter(self) -> None:
        environment = self._semantic()
        environment.queue_http_response(
            status=200,
            body=_fixture("semantic_scholar", "lookup.json"),
        )
        result = self.assert_lookup_scan(
            environment,
            MetadataLookupRequest(
                provider_name="semantic-scholar",
                key=ProviderLiteratureKey(
                    identifiers=(Identifier(namespace="doi", value="10.5555/LOOKUP.S2"),)
                ),
                scan_limit=2,
            ),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
        )
        self.assertEqual(result.observations[0].metadata.publication_date, "2022-08-09")
        path = urlsplit(environment.transport.calls[0].request.url).path
        self.assertEqual(
            unquote(path),
            "/graph/v1/paper/DOI:10.5555/lookup.s2",
        )
        query = parse_qs(urlsplit(environment.transport.calls[0].request.url).query)
        self.assertIn("fields", query)

    def test_lookup_rejects_a_response_for_a_different_literature_key(self) -> None:
        environment = self._semantic()
        environment.queue_http_response(
            status=200,
            body=_fixture("semantic_scholar", "lookup.json"),
        )
        failed = self.assert_lookup_scan(
            environment,
            MetadataLookupRequest(
                provider_name="semantic-scholar",
                key=ProviderLiteratureKey(
                    identifiers=(
                        Identifier(namespace="doi", value="10.5555/different.semantic.key"),
                    )
                ),
                scan_limit=2,
            ),
            outcome="FAILED",
            raw_item_count=1,
            observation_count=0,
        )
        self.assert_stable_failure(
            failed,
            expected_code="metadata-provider-invalid-record",
            forbidden_values=("10.5555/different.semantic.key",),
        )

    def test_reference_and_citation_endpoints_normalize_direction_and_inline_records(
        self,
    ) -> None:
        environment = self._semantic()
        anchor = ProviderLiteratureKey(record_id=_S2_ANCHOR)
        _queue_semantic_references(environment)
        references = self.assert_reference_scan(
            environment,
            _reference_request("semantic-scholar", "references", anchor),
            outcome="EXHAUSTED",
            raw_item_count=2,
            observation_count=1,
            relation_count=2,
        )
        self.assertEqual(len(environment.transport.calls), 2)
        self.assertTrue(
            all(
                urlsplit(call.request.url).path.endswith("/references")
                for call in environment.transport.calls
            )
        )
        self.assertEqual(references.relations[0].citing, anchor)
        self.assertEqual(
            references.relations[0].cited,
            ProviderLiteratureKey(
                record_id="5555555555555555555555555555555555555555",
                identifiers=(Identifier(namespace="doi", value="10.5555/s2.cited.one"),),
            ),
        )
        self.assertEqual(references.relations[1].citing, anchor)
        self.assertEqual(
            references.relations[1].cited,
            ProviderLiteratureKey(record_id="6666666666666666666666666666666666666666"),
        )
        self.assertEqual(
            references.observations[0].metadata.title,
            "An inline cited paper",
        )
        self.assertEqual(references.observations[0].reference_texts, ())
        self.assert_no_private_payload(
            references,
            runtime_secret=environment.secret_sentinel,
            forbidden_values=(
                "Vendor-generated citation context must be ignored.",
                "relation-only-record-must-not-grow-metadata",
                "background",
            ),
        )

        environment.reset_http()
        environment.queue_http_response(
            status=200,
            body=_fixture("semantic_scholar", "citations.json"),
        )
        citations = self.assert_reference_scan(
            environment,
            _reference_request("semantic-scholar", "cited-by", anchor),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
            relation_count=1,
        )
        self.assertTrue(
            urlsplit(environment.transport.calls[0].request.url).path.endswith("/citations")
        )
        self.assertEqual(citations.relations[0].cited, anchor)
        self.assertEqual(
            citations.relations[0].citing.record_id,
            "7777777777777777777777777777777777777777",
        )

        environment.reset_http()
        _queue_semantic_references(environment)
        environment.queue_http_response(
            status=200,
            body=_fixture("semantic_scholar", "citations.json"),
        )
        both = self.assert_reference_scan(
            environment,
            _reference_request("semantic-scholar", "both", anchor),
            outcome="EXHAUSTED",
            raw_item_count=3,
            observation_count=2,
            relation_count=3,
        )
        self.assertEqual(
            tuple(
                urlsplit(call.request.url).path.rsplit("/", maxsplit=1)[-1]
                for call in environment.transport.calls
            ),
            ("references", "references", "citations"),
        )
        self.assertEqual(both.relations[-1].cited, anchor)

    def test_reference_empty_page_with_next_offset_fails_without_cursor_loop(self) -> None:
        environment = self._semantic()
        environment.queue_http_response(
            status=200,
            body=b'{"offset":0,"next":2,"data":[]}',
        )
        failed = self.assert_reference_scan(
            environment,
            _reference_request(
                "semantic-scholar",
                "references",
                ProviderLiteratureKey(record_id=_S2_ANCHOR),
            ),
            outcome="FAILED",
            raw_item_count=0,
            observation_count=0,
            relation_count=0,
        )
        self.assertEqual(len(environment.transport.calls), 1)
        self.assert_stable_failure(failed, expected_code="metadata-provider-protocol")

    def test_replayed_reference_input_keeps_metadata_relation_and_provenance_ids(
        self,
    ) -> None:
        environment = self._semantic()
        page = _fixture("semantic_scholar", "references-page-1.json")

        def execute() -> MetadataProviderResult:
            environment.queue_http_response(status=200, body=page)
            return self.assert_reference_scan(
                environment,
                _reference_request(
                    "semantic-scholar",
                    "references",
                    ProviderLiteratureKey(record_id=_S2_ANCHOR),
                    scan_limit=1,
                ),
                outcome="SCAN_LIMIT_REACHED",
                raw_item_count=1,
                observation_count=1,
                relation_count=1,
            )

        first = execute()
        environment.reset_http()
        environment.monotonic_clock.advance(1.0)
        environment.wall_clock.advance(60.0)
        replay = execute()

        self.assertNotEqual(
            first.observations[0].provenance.observed_at,
            replay.observations[0].provenance.observed_at,
        )
        self.assertEqual(
            first.observations[0].observation_id,
            replay.observations[0].observation_id,
        )
        self.assertEqual(
            first.relations[0].observation_id,
            replay.relations[0].observation_id,
        )
        self.assertEqual(
            first.observations[0].provenance.provenance_id,
            replay.observations[0].provenance.provenance_id,
        )
        self.assertEqual(
            first.relations[0].provenance.provenance_id,
            replay.relations[0].provenance.provenance_id,
        )
        self.assertNotEqual(
            first.observations[0].observation_id,
            first.relations[0].observation_id,
        )

    def test_private_header_is_not_public_and_auth_failure_does_not_fallback(self) -> None:
        secret = "semantic-private-key-sentinel"
        environment = self._semantic(api_key=secret)
        environment.queue_http_response(status=401)
        denied = self.assert_topic_scan(
            environment,
            _topic_request("semantic-scholar", 2),
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
        self.assertIn(("x-api-key", secret), call.headers)
        self.assertEqual(
            getattr(call.destination, "origin", None),
            Origin("https", "api.semanticscholar.org", 443),
        )
        self.assertNotIn(secret, call.request.model_dump_json())
        self.assertNotIn(secret, repr(call))

        anonymous = self._semantic()
        _queue_semantic_zero(anonymous)
        self.assert_topic_scan(
            anonymous,
            _topic_request("semantic-scholar", 2),
            outcome="EXHAUSTED",
            raw_item_count=0,
            observation_count=0,
        )
        self.assertFalse(
            any(
                name.casefold() == "x-api-key"
                for name, _value in anonymous.transport.calls[0].headers
            )
        )

    def test_wrong_shape_and_oversize_fail_without_vendor_payload(self) -> None:
        environment = self._semantic()
        environment.queue_http_response(
            status=200,
            body=b'{"total": 1, "offset": 0, "data": {"paperId": "private"}}',
        )
        wrong = self.assert_topic_scan(
            environment,
            _topic_request("semantic-scholar", 2),
            outcome="FAILED",
            raw_item_count=0,
            observation_count=0,
        )
        self.assert_stable_failure(
            wrong,
            expected_code="metadata-provider-unknown-shape",
            forbidden_values=("private",),
        )

        environment.reset_http()
        environment.queue_http_response(status=200, body=b" " * 4_300_000)
        oversized = self.assert_topic_scan(
            environment,
            _topic_request("semantic-scholar", 2),
            outcome="FAILED",
            raw_item_count=0,
            observation_count=0,
        )
        self.assert_stable_failure(
            oversized,
            expected_code="metadata-provider-response-too-large",
        )


class OpenAlexAdapterTests(ProviderContractCase, unittest.TestCase):
    def provider_contract_binding(self) -> ContractBinding:
        return _openalex_contract_binding()

    def _openalex(self, *, api_key: str | None = None) -> ContractEnvironment:
        environment = _openalex_environment(api_key=api_key)
        self.addCleanup(environment.close)
        return environment

    def _semantic(self) -> ContractEnvironment:
        environment = _semantic_environment()
        self.addCleanup(environment.close)
        return environment

    def test_capabilities_scope_and_explicit_credential_configuration(self) -> None:
        environment = self._openalex()
        adapter = environment.ports.topic_search
        self.assertIs(adapter, environment.ports.lookup)
        self.assertIs(adapter, environment.ports.reference_query)
        self.assertIsInstance(adapter, TopicSearchPort)
        self.assertIsInstance(adapter, MetadataLookupPort)
        self.assertIsInstance(adapter, ReferenceQueryPort)
        self.assert_scope_is_neutral(environment.scope)
        self.assertEqual(
            OPENALEX_ACCESS_SCOPE,
            AccessScope(provider_name="openalex", channel="api"),
        )
        self.assertEqual(
            OPENALEX_BASELINE_ACCESS_POLICY,
            AccessPolicy(max_concurrency=1, min_start_interval=1.0),
        )

        ids = _IdFactories(60_000)
        with self.assertRaises(ValueError):
            OpenAlexAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=AccessScope(
                    provider_name="wrong-provider",
                    channel="api",
                    service_name="metadata",
                ),
                access_policy=AccessPolicy(max_concurrency=1),
                observation_id_factory=ids.observation,
                provenance_id_factory=ids.provenance,
                clock=lambda: _wall_timestamp(environment),
                page_size=2,
            )
        with self.assertRaises(ValueError):
            OpenAlexAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=AccessScope(
                    provider_name="openalex",
                    channel="api",
                    service_name="metadata",
                ),
                access_policy=AccessPolicy(max_concurrency=1),
                observation_id_factory=ids.observation,
                provenance_id_factory=ids.provenance,
                clock=lambda: _wall_timestamp(environment),
                page_size=2,
            )
        with self.assertRaises(ValueError):
            OpenAlexAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=AccessScope(provider_name="openalex", channel="web"),
                access_policy=AccessPolicy(max_concurrency=1),
                observation_id_factory=ids.observation,
                provenance_id_factory=ids.provenance,
                clock=lambda: _wall_timestamp(environment),
                page_size=2,
            )
        with self.assertRaises(ValueError):
            OpenAlexAdapter(
                http_client=environment.http_client,
                access_coordinator=environment.coordinator,
                access_scope=environment.scope,
                access_policy=environment.policy,
                observation_id_factory=ids.observation,
                provenance_id_factory=ids.provenance,
                clock=lambda: _wall_timestamp(environment),
                api_key="\n",
                page_size=2,
            )

        secret = "repr-must-not-expose-query-key"
        keyed = _openalex_environment(api_key=secret)
        self.addCleanup(keyed.close)
        self.assertNotIn(secret, repr(keyed.ports.topic_search))

    def test_baseline_policy_cannot_be_loosened_and_operator_policy_can_tighten(
        self,
    ) -> None:
        operator_policy = AccessPolicy(
            max_concurrency=8,
            min_start_interval=0.25,
            cooldown_after_completion=2.0,
            burst_limit=5,
            window_seconds=10.0,
            backoff_seconds=3.0,
            max_backoff_seconds=120.0,
        )
        environment = _openalex_environment(access_policy=operator_policy)
        self.addCleanup(environment.close)
        _queue_openalex_zero(environment)
        self.assert_topic_scan(
            environment,
            _topic_request("openalex", 2),
            outcome="EXHAUSTED",
            raw_item_count=0,
            observation_count=0,
        )
        self.assertEqual(
            environment.coordinator.policy_for(environment.scope),
            AccessPolicy.strictest(
                OPENALEX_BASELINE_ACCESS_POLICY,
                operator_policy,
            ),
        )

    def test_retry_after_feedback_is_atomic_with_scope_release(self) -> None:
        environment = self._openalex()
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
        ids = _IdFactories(25_000)
        adapter = OpenAlexAdapter(
            http_client=http_client,
            access_coordinator=coordinator,
            access_scope=OPENALEX_ACCESS_SCOPE,
            access_policy=AccessPolicy(max_concurrency=1),
            observation_id_factory=ids.observation,
            provenance_id_factory=ids.provenance,
            clock=lambda: _wall_timestamp(environment),
            page_size=2,
        )

        _assert_atomic_retry_after_feedback(
            self,
            environment=environment,
            adapter=adapter,
            coordinator=coordinator,
            patch_target=("sciretriever.metadata.providers.openalex.adapter.retry_after_feedback"),
        )

    def test_conflicting_retry_after_on_429_keeps_conservative_throttling(
        self,
    ) -> None:
        environment = self._openalex()
        environment.queue_http_response(
            status=429,
            headers=(
                ("Retry-After", "3"),
                ("retry-after", "7"),
            ),
        )
        failed = self.assert_topic_scan(
            environment,
            _topic_request("openalex", 2),
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

    def test_search_reconstructs_metadata_edges_authors_and_all_safe_locations(self) -> None:
        environment = self._openalex()
        page_one = _fixture("openalex", "search-page-1.json")
        environment.queue_http_response(status=200, body=page_one)
        environment.queue_http_response(
            status=200,
            body=_fixture("openalex", "search-page-2.json"),
        )
        result = self.assert_topic_scan(
            environment,
            _topic_request("openalex", 10),
            outcome="EXHAUSTED",
            raw_item_count=3,
            observation_count=3,
            relation_count=3,
        )

        self.assertEqual(len(environment.transport.calls), 2)
        acquisition_times = tuple(
            timestamp
            for scope, timestamp in environment.coordinator.scope_acquisition_times
            if scope == OPENALEX_ACCESS_SCOPE
        )
        self.assertEqual(len(acquisition_times), 2)
        self.assertGreaterEqual(acquisition_times[1] - acquisition_times[0], 1.0)
        first_url = urlsplit(environment.transport.calls[0].request.url)
        second_url = urlsplit(environment.transport.calls[1].request.url)
        self.assertEqual(
            (first_url.scheme, first_url.netloc, first_url.path),
            ("https", "api.openalex.org", "/works"),
        )
        first_query = parse_qs(first_url.query)
        second_query = parse_qs(second_url.query)
        self.assertEqual(first_query["search"], ["retrieval systems"])
        self.assertEqual(first_query["cursor"], ["*"])
        self.assertEqual(first_query["per_page"], ["2"])
        self.assertEqual(
            first_query["filter"],
            ["from_publication_date:2020-01-01,to_publication_date:2025-12-31"],
        )
        self.assertIn("abstract_inverted_index", first_query["select"][0].split(","))
        self.assertEqual(second_query["cursor"], ["cursor-two"])
        self.assertNotIn("api_key", first_query)

        observation = result.observations[0]
        metadata = observation.metadata
        self.assertEqual(metadata.title, "An OpenAlex record")
        self.assertEqual(metadata.abstract, "A reconstructed OpenAlex abstract.")
        self.assertEqual(metadata.publication_date, "2024-02-29")
        self.assertEqual(metadata.publication_year, 2024)
        self.assertEqual(metadata.document_type, "article")
        self.assertEqual(metadata.language, "en")
        self.assertEqual(metadata.venue, "OpenAlex Journal")
        self.assertEqual(metadata.volume, "42")
        self.assertEqual(metadata.issue, "7")
        self.assertEqual(metadata.pages, "101-119")
        self.assertEqual(metadata.keywords, ())
        self.assertEqual(observation.declared_keywords, ())
        self.assertEqual(observation.reference_texts, ())
        self.assertEqual(observation.reference_count, 17)
        self.assertEqual(observation.cited_by_count, 29)
        self.assert_author_mapping(
            metadata.authors,
            (
                ExpectedAuthor(
                    kind="person",
                    display_name="Ada OpenAlex",
                    orcid="0000-0002-1825-0097",
                    affiliations=(ExpectedAffiliation(name="Example Institute", ror="03yrm5c26"),),
                ),
                ExpectedAuthor(kind="unknown", display_name="Second OpenAlex Author"),
            ),
        )
        self.assert_identifier_record_id_separation(
            observation,
            expected_identifiers=(
                Identifier(namespace="doi", value="10.5555/semantic.openalex"),
                Identifier(namespace="pmid", value="01234567"),
                Identifier(namespace="pmcid", value="PMC7654321"),
            ),
            expected_record_id="https://openalex.org/W1111111111",
            forbidden_record_ids=(
                "https://openalex.org/W1111111111",
                "private-mag-id",
            ),
        )
        expected_hints = (
            AssetHint(
                url="https://doi.org/10.5555/semantic.openalex",
                kind=AssetHintKind.LANDING_PAGE,
                version_role=VersionRole.PUBLISHED,
                access_status="open",
                license="cc-by",
            ),
            AssetHint(
                url="https://assets.example.org/openalex-published.pdf",
                kind=AssetHintKind.DIRECT_FILE,
                media_type="application/pdf",
                asset_role=AssetRole.PRIMARY_PDF,
                version_role=VersionRole.PUBLISHED,
                access_status="open",
                license="cc-by",
            ),
            AssetHint(
                url="https://repository.example.org/openalex-record",
                kind=AssetHintKind.LANDING_PAGE,
                version_role=VersionRole.PREPRINT,
                access_status="open",
                license="cc-by",
            ),
            AssetHint(
                url="https://repository.example.org/openalex-record.pdf",
                kind=AssetHintKind.DIRECT_FILE,
                media_type="application/pdf",
                asset_role=AssetRole.PRIMARY_PDF,
                version_role=VersionRole.PREPRINT,
                access_status="open",
                license="cc-by",
            ),
            AssetHint(
                url="https://publisher.example.org/accepted-record",
                kind=AssetHintKind.LANDING_PAGE,
                version_role=VersionRole.ACCEPTED_MANUSCRIPT,
                access_status="closed",
                license="publisher-terms",
            ),
            AssetHint(
                url="https://publisher.example.org/accepted-record.pdf",
                kind=AssetHintKind.DIRECT_FILE,
                media_type="application/pdf",
                asset_role=AssetRole.PRIMARY_PDF,
                version_role=VersionRole.ACCEPTED_MANUSCRIPT,
                access_status="closed",
                license="publisher-terms",
            ),
            AssetHint(
                url=("https://shared.example.org/same-url-different-semantics.pdf"),
                kind=AssetHintKind.DIRECT_FILE,
                media_type="application/pdf",
                asset_role=AssetRole.PRIMARY_PDF,
                version_role=VersionRole.PUBLISHED,
                access_status="closed",
                license="publisher-terms",
            ),
            AssetHint(
                url=("https://shared.example.org/same-url-different-semantics.pdf"),
                kind=AssetHintKind.DIRECT_FILE,
                media_type="application/pdf",
                asset_role=AssetRole.PRIMARY_PDF,
                version_role=VersionRole.PREPRINT,
                access_status="open",
                license="cc-by",
            ),
        )
        self.assert_asset_hints(
            observation,
            expected_hints,
            runtime_secret=environment.secret_sentinel,
        )
        self.assertEqual(observation.provenance.input_sha256, sha256_digest(page_one))

        citing = ProviderLiteratureKey(
            record_id="https://openalex.org/W1111111111",
            identifiers=metadata.identifiers,
        )
        self.assertEqual(
            tuple(relation.citing for relation in result.relations[:2]),
            (citing, citing),
        )
        self.assertEqual(
            tuple(relation.cited.record_id for relation in result.relations[:2]),
            (
                "https://openalex.org/W5555555555",
                "https://openalex.org/W6666666666",
            ),
        )
        self.assertNotIn(
            "https://openalex.org/W9999999999",
            tuple(relation.cited.record_id for relation in result.relations),
        )

        sparse = result.observations[1]
        rejection = accept_observation(sparse)
        self.assertEqual(rejection.outcome, "rejected")
        self.assertEqual(rejection.reason, "missing-title-or-doi")
        self.assertEqual(rejection.observations, ())

        self.assert_no_private_payload(
            result,
            runtime_secret=environment.secret_sentinel,
            forbidden_values=(
                "fixture-secret",
                "adapter-whitelist-must-ignore-this-key",
                "Must not become keyword",
                "Still not a keyword",
                "Algorithmic keyword",
                "Private concept",
                "private-lineage",
                "Do not duplicate aligned institutions",
                "https://aggregate.example.org/not-an-extra-location",
            ),
        )

    def test_replayed_work_input_keeps_ids_and_distinct_relation_endpoints_do_not_collide(
        self,
    ) -> None:
        environment = self._openalex()
        page = _fixture("openalex", "search-page-1.json")

        def execute() -> MetadataProviderResult:
            environment.queue_http_response(status=200, body=page)
            return self.assert_topic_scan(
                environment,
                _topic_request("openalex", 1),
                outcome="SCAN_LIMIT_REACHED",
                raw_item_count=1,
                observation_count=1,
                relation_count=2,
            )

        first = execute()
        environment.reset_http()
        environment.monotonic_clock.advance(1.0)
        environment.wall_clock.advance(60.0)
        replay = execute()

        self.assertNotEqual(
            first.observations[0].provenance.observed_at,
            replay.observations[0].provenance.observed_at,
        )
        self.assertEqual(
            first.observations[0].observation_id,
            replay.observations[0].observation_id,
        )
        self.assertEqual(
            first.observations[0].provenance.provenance_id,
            replay.observations[0].provenance.provenance_id,
        )
        self.assertEqual(
            tuple(relation.observation_id for relation in first.relations),
            tuple(relation.observation_id for relation in replay.relations),
        )
        self.assertEqual(
            len({relation.observation_id for relation in first.relations}),
            2,
        )
        self.assertNotIn(
            first.observations[0].observation_id,
            {relation.observation_id for relation in first.relations},
        )
        self.assertEqual(
            {relation.provenance.provenance_id for relation in first.relations},
            {first.observations[0].provenance.provenance_id},
        )

    def test_scan_limit_has_no_prefetch_and_second_page_failure_is_partial(self) -> None:
        environment = self._openalex()
        environment.queue_http_response(
            status=200,
            body=_fixture("openalex", "search-page-1.json"),
        )
        limited = self.assert_topic_scan(
            environment,
            _topic_request("openalex", 1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
            relation_count=2,
        )
        self.assertEqual(len(environment.transport.calls), 1)
        self.assertEqual(limited.observations[0].metadata.title, "An OpenAlex record")

        environment.reset_http()
        _queue_openalex_partial(environment)
        partial = self.assert_topic_scan(
            environment,
            _topic_request("openalex", 10),
            outcome="FAILED",
            raw_item_count=2,
            observation_count=2,
            relation_count=2,
        )
        self.assert_stable_failure(
            partial,
            expected_code="metadata-provider-malformed-json",
            forbidden_values=("cursor-two", "fixture-secret", environment.secret_sentinel),
        )

    def test_lookup_uses_structured_official_identifier_and_emits_inline_references(self) -> None:
        environment = self._openalex()
        environment.queue_http_response(
            status=200,
            body=_fixture("openalex", "lookup.json"),
        )
        result = self.assert_lookup_scan(
            environment,
            MetadataLookupRequest(
                provider_name="openalex",
                key=ProviderLiteratureKey(
                    identifiers=(Identifier(namespace="doi", value="10.5555/LOOKUP.OPENALEX"),)
                ),
                scan_limit=2,
            ),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
            relation_count=2,
        )
        observation = result.observations[0]
        self.assertEqual(observation.provenance.source_record_id, _OPENALEX_ANCHOR)
        self.assertEqual(observation.metadata.abstract, "Lookup abstract.")
        self.assertEqual(observation.metadata.pages, "5-12")
        path = urlsplit(environment.transport.calls[0].request.url).path
        self.assertEqual(
            unquote(path),
            "/works/doi:10.5555/lookup.openalex",
        )

    def test_lookup_rejects_a_response_for_a_different_literature_key(self) -> None:
        environment = self._openalex()
        environment.queue_http_response(
            status=200,
            body=_fixture("openalex", "lookup.json"),
        )
        failed = self.assert_lookup_scan(
            environment,
            MetadataLookupRequest(
                provider_name="openalex",
                key=ProviderLiteratureKey(record_id="https://openalex.org/W9999999999"),
                scan_limit=2,
            ),
            outcome="FAILED",
            raw_item_count=1,
            observation_count=0,
            relation_count=0,
        )
        self.assert_stable_failure(
            failed,
            expected_code="metadata-provider-invalid-record",
            forbidden_values=("W9999999999",),
        )

    def test_reference_query_uses_referenced_works_and_cites_filter_directions(self) -> None:
        environment = self._openalex()
        anchor = ProviderLiteratureKey(record_id=_OPENALEX_ANCHOR)
        _queue_openalex_lookup(environment)
        references = self.assert_reference_scan(
            environment,
            _reference_request("openalex", "references", anchor),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
            relation_count=2,
        )
        self.assertEqual(
            tuple(relation.citing.record_id for relation in references.relations),
            (_OPENALEX_ANCHOR, _OPENALEX_ANCHOR),
        )

        environment.reset_http()
        doi_anchor = ProviderLiteratureKey(
            identifiers=(Identifier(namespace="doi", value="10.5555/lookup.openalex"),)
        )
        _queue_openalex_lookup(environment)
        doi_references = self.assert_reference_scan(
            environment,
            _reference_request("openalex", "references", doi_anchor),
            outcome="EXHAUSTED",
            raw_item_count=1,
            observation_count=1,
            relation_count=2,
        )
        self.assertEqual(
            tuple(relation.citing for relation in doi_references.relations),
            (doi_anchor, doi_anchor),
        )
        self.assertEqual(
            unquote(urlsplit(environment.transport.calls[0].request.url).path),
            "/works/doi:10.5555/lookup.openalex",
        )

        environment.reset_http()
        environment.queue_http_response(
            status=200,
            body=_fixture("openalex", "cited-by-page-1.json"),
        )
        environment.queue_http_response(
            status=200,
            body=_fixture("openalex", "cited-by-page-2.json"),
        )
        cited_by = self.assert_reference_scan(
            environment,
            _reference_request("openalex", "cited-by", anchor),
            outcome="EXHAUSTED",
            raw_item_count=2,
            observation_count=2,
            relation_count=2,
        )
        self.assertEqual(len(environment.transport.calls), 2)
        first_query = parse_qs(urlsplit(environment.transport.calls[0].request.url).query)
        second_query = parse_qs(urlsplit(environment.transport.calls[1].request.url).query)
        self.assertEqual(first_query["filter"], ["cites:W4444444444"])
        self.assertEqual(first_query["cursor"], ["*"])
        self.assertEqual(second_query["cursor"], ["cited-by-two"])
        self.assertEqual(
            tuple(relation.cited for relation in cited_by.relations),
            (anchor, anchor),
        )
        self.assertEqual(
            tuple(relation.citing.record_id for relation in cited_by.relations),
            (
                "https://openalex.org/W7777777777",
                "https://openalex.org/W8888888888",
            ),
        )

    def test_abstract_position_conflicts_fail_stably_without_half_observation(self) -> None:
        environment = self._openalex()
        scenarios = (
            ("bad-abstract.json", "W9999999991"),
            ("gap-abstract.json", "W9999999992"),
            ("invalid-position-abstract.json", "W9999999993"),
        )
        for fixture_name, work_id in scenarios:
            with self.subTest(fixture=fixture_name):
                environment.reset_http()
                environment.queue_http_response(
                    status=200,
                    body=_fixture("openalex", fixture_name),
                )
                failed = self.assert_lookup_scan(
                    environment,
                    MetadataLookupRequest(
                        provider_name="openalex",
                        key=ProviderLiteratureKey(record_id=f"https://openalex.org/{work_id}"),
                        scan_limit=2,
                    ),
                    outcome="FAILED",
                    raw_item_count=1,
                    observation_count=0,
                )
                self.assert_stable_failure(
                    failed,
                    expected_code="metadata-provider-invalid-record",
                    forbidden_values=("conflicting", "positions", "missing", "illegal"),
                )

    def test_private_query_key_never_enters_safe_url_and_auth_failure_does_not_fallback(
        self,
    ) -> None:
        secret = "openalex private key&/+"
        environment = self._openalex(api_key=secret)
        environment.queue_http_response(status=403)
        denied = self.assert_topic_scan(
            environment,
            _topic_request("openalex", 2),
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
        safe_query = parse_qs(urlsplit(call.request.url).query)
        wire_query = parse_qs(urlsplit(call.wire_target).query)
        self.assertNotIn("api_key", safe_query)
        self.assertEqual(wire_query["api_key"], [secret])
        self.assertNotIn(secret, call.request.model_dump_json())
        self.assertNotIn(secret, repr(call))

        anonymous = self._openalex()
        _queue_openalex_zero(anonymous)
        self.assert_topic_scan(
            anonymous,
            _topic_request("openalex", 2),
            outcome="EXHAUSTED",
            raw_item_count=0,
            observation_count=0,
        )
        self.assertNotIn(
            "api_key", parse_qs(urlsplit(anonymous.transport.calls[0].wire_target).query)
        )

    def test_wrong_shape_and_oversize_fail_without_vendor_payload(self) -> None:
        environment = self._openalex()
        environment.queue_http_response(status=200, body=b'[{"id":"private-work"}]')
        wrong = self.assert_topic_scan(
            environment,
            _topic_request("openalex", 2),
            outcome="FAILED",
            raw_item_count=0,
            observation_count=0,
            relation_count=0,
        )
        self.assert_stable_failure(
            wrong,
            expected_code="metadata-provider-unknown-shape",
            forbidden_values=("private-work",),
        )

        environment.reset_http()
        environment.queue_http_response(status=200, body=b" " * 4_300_000)
        oversized = self.assert_topic_scan(
            environment,
            _topic_request("openalex", 2),
            outcome="FAILED",
            raw_item_count=0,
            observation_count=0,
            relation_count=0,
        )
        self.assert_stable_failure(
            oversized,
            expected_code="metadata-provider-response-too-large",
        )

    def test_same_doi_observations_stay_distinct_and_literature_matches(self) -> None:
        semantic = self._semantic()
        semantic.queue_http_response(
            status=200,
            body=_fixture("semantic_scholar", "search-page-1.json"),
        )
        semantic_observation = self.assert_topic_scan(
            semantic,
            _topic_request("semantic-scholar", 1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
        ).observations[0]

        openalex = self._openalex()
        openalex.queue_http_response(
            status=200,
            body=_fixture("openalex", "search-page-1.json"),
        )
        openalex_observation = self.assert_topic_scan(
            openalex,
            _topic_request("openalex", 1),
            outcome="SCAN_LIMIT_REACHED",
            raw_item_count=1,
            observation_count=1,
            relation_count=2,
        ).observations[0]

        self.assertNotEqual(
            semantic_observation.observation_id,
            openalex_observation.observation_id,
        )
        self.assertEqual(
            semantic_observation.metadata.identifiers[0],
            openalex_observation.metadata.identifiers[0],
        )
        existing = Literature(
            literature_id=LiteratureId("00000000-0000-0000-0000-000000009101"),
            meta_literature_id=MetaLiteratureId("00000000-0000-0000-0000-000000009102"),
            version_role=VersionRole.PUBLISHED,
            metadata=semantic_observation.metadata,
            status=LiteratureStatus.UNREVIEWED,
        )
        decision = accept_observation(
            openalex_observation,
            existing_literature=(existing,),
            existing_observations=(semantic_observation,),
        )
        self.assertEqual(decision.outcome, "matched")
        self.assertEqual(decision.literature, existing)
        self.assertEqual(
            decision.observations,
            (semantic_observation, openalex_observation),
        )

    def test_programming_errors_and_cancelled_error_propagate(self) -> None:
        def programming_error() -> ObservationId:
            raise RuntimeError("programming sentinel")

        semantic = _semantic_environment(observation_id_factory=programming_error)
        self.addCleanup(semantic.close)
        semantic.queue_http_response(
            status=200,
            body=_fixture("semantic_scholar", "search-page-1.json"),
        )
        with self.assertRaisesRegex(RuntimeError, "programming sentinel"):
            semantic.api.search_topic(_topic_request("semantic-scholar", 1))

        def cancelled() -> ObservationId:
            raise asyncio.CancelledError

        openalex = _openalex_environment(observation_id_factory=cancelled)
        self.addCleanup(openalex.close)
        openalex.queue_http_response(
            status=200,
            body=_fixture("openalex", "search-page-1.json"),
        )
        with self.assertRaises(asyncio.CancelledError):
            openalex.api.search_topic(_topic_request("openalex", 1))


if __name__ == "__main__":
    unittest.main()
