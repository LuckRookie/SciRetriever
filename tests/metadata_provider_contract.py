"""Reusable, test-only Metadata provider contract support.

This module is intentionally not named with the unittest discovery prefix and
defines no production Provider base class.  Concrete adapter tests may combine
ProviderContractCase with unittest.TestCase and override
``provider_contract_binding()``.  The inherited tests execute every declared
capability against the real adapter ports through MetadataApi, the offline
Network boundary, and one recording instance of the real AccessCoordinator.
"""

from __future__ import annotations

import json
import math
import secrets
import threading
import unittest
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field, fields
from datetime import datetime, timedelta, timezone
from typing import Literal, TypeAlias, cast
from urllib.parse import urlsplit

from pydantic import BaseModel

from sciretriever.metadata.api import MetadataApi
from sciretriever.metadata.ports import (
    MetadataLookupPort,
    ReferenceQueryPort,
    TopicSearchPort,
)
from sciretriever.metadata.rules import (
    MetadataLookupRequest,
    MetadataProviderResult,
    MetadataReferenceQueryRequest,
)
from sciretriever.metadata.service import MetadataService
from sciretriever.model.access import (
    Header,
    TransportRequest,
    has_sensitive_query_parameter,
)
from sciretriever.model.discovery import (
    DiscoverySourceOutcome,
    TopicDiscoveryInput,
)
from sciretriever.model.literature import (
    Author,
    Identifier,
)
from sciretriever.model.metadata import (
    MetadataObservation,
    ProviderLiteratureKey,
    ProviderRelationObservation,
)
from sciretriever.network.admission import (
    AccessCoordinator,
    AccessFeedback,
    AccessPermit,
    AccessPolicy,
    AccessScope,
    AdmissionTimeout,
    HostPermit,
)
from sciretriever.network.http import HttpClient

ProviderCapability: TypeAlias = Literal["search", "lookup", "references"]
AuthorKindValue: TypeAlias = Literal["person", "organization", "unknown"]


class FakeMonotonicClock:
    """A process-local monotonic clock controlled by a contract test."""

    __slots__ = ("_value",)

    def __init__(self, initial: float = 100.0) -> None:
        self._value = _finite_nonnegative(initial, field_name="initial")

    def __call__(self) -> float:
        return self._value

    def advance(self, seconds: float) -> None:
        self._value += _finite_nonnegative(seconds, field_name="seconds")


class FakeWallClock:
    """An aware wall clock kept separate from the monotonic admission clock."""

    __slots__ = ("_value",)

    def __init__(self, initial: datetime | None = None) -> None:
        value = initial or datetime(2026, 8, 11, 4, 0, tzinfo=timezone.utc)
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("wall clock must be timezone-aware")
        self._value = value

    def __call__(self) -> datetime:
        return self._value

    def advance(self, seconds: float) -> None:
        self._value += timedelta(seconds=_finite_nonnegative(seconds, field_name="seconds"))


def _finite_nonnegative(value: object, *, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{field_name} must be a number")
    candidate = float(value)
    if not math.isfinite(candidate) or candidate < 0:
        raise ValueError(f"{field_name} must be finite and nonnegative")
    return candidate


class _FakeResolver:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def resolve(self, hostname: str) -> Iterable[str]:
        self.calls.append(hostname)
        # No socket is opened.  A syntactically public address lets the real
        # policy and redirect machinery run around the fake transport.
        return ("93.184.216.34",)


@dataclass(frozen=True, slots=True)
class ContractHttpCall:
    request: TransportRequest
    destination: object
    headers: tuple[tuple[str, str], ...] = field(repr=False)
    wire_target: str = field(repr=False)


@dataclass(slots=True)
class _ContractRawResponse:
    status: int
    headers: tuple[Header | tuple[str, str], ...]
    body: bytes
    closed: bool = False

    def close(self) -> None:
        self.closed = True


class _FakeTransport:
    def __init__(self) -> None:
        self.actions: list[object] = []
        self.calls: list[ContractHttpCall] = []
        self.closed = False

    def send(
        self,
        request: object,
        destination: object,
        *,
        headers: tuple[tuple[str, str], ...],
        request_target_renderer: object | None = None,
        connect_timeout_seconds: float,
        read_timeout_seconds: float,
        tls_server_hostname: str | None,
        cancel_event: threading.Event | None,
    ) -> object:
        del (
            connect_timeout_seconds,
            read_timeout_seconds,
            tls_server_hostname,
            cancel_event,
        )
        safe_request = getattr(request, "safe_request", request)
        if not isinstance(safe_request, TransportRequest):
            raise AssertionError("fake transport requires a safe TransportRequest")
        wire_target = getattr(request, "target", None)
        if wire_target is None and request_target_renderer is not None:
            render = getattr(request_target_renderer, "render", None)
            if not callable(render):
                raise AssertionError("request target renderer must expose render()")
            wire_target = render(safe_request, destination)
        if wire_target is None:
            parsed = urlsplit(safe_request.url)
            wire_target = parsed.path or "/"
            if parsed.query:
                wire_target = f"{wire_target}?{parsed.query}"
        if not isinstance(wire_target, str):
            raise AssertionError("fake transport wire target must be text")
        self.calls.append(
            ContractHttpCall(
                request=safe_request,
                destination=destination,
                headers=headers,
                wire_target=wire_target,
            )
        )
        if not self.actions:
            raise AssertionError("fake transport has no queued response")
        action = self.actions.pop(0)
        if isinstance(action, BaseException):
            raise action
        return action

    def close(self) -> None:
        self.closed = True

    def clear(self) -> None:
        self.actions.clear()
        self.calls.clear()


class RecordingAccessCoordinator(AccessCoordinator):
    """The real limiter plus neutral evidence that an adapter used this instance."""

    def __init__(self, *, clock: FakeMonotonicClock) -> None:
        super().__init__(clock=clock)
        self._test_clock = clock
        self._normal_flow_permits: set[int] = set()
        self.scope_acquisitions: list[AccessScope] = []
        self.scope_acquisition_times: list[tuple[AccessScope, float]] = []
        self.host_acquisition_times: list[tuple[str, float]] = []
        self.feedback_records: list[tuple[AccessScope, AccessFeedback]] = []
        self.feedback_sources: list[AccessPermit | AccessScope] = []
        self.permit_release_events: list[tuple[str, AccessPermit]] = []

    def acquire_scope(
        self,
        scope: AccessScope,
        policy: AccessPolicy | None = None,
        *,
        operator_policy: AccessPolicy | None = None,
        cancel_event: threading.Event | None = None,
        timeout: float | None = None,
    ) -> AccessPermit:
        if policy is not None and scope in self.scope_acquisitions:
            effective = (
                policy
                if operator_policy is None
                else AccessPolicy.strictest(policy, operator_policy)
            )
            if self.policy_for(scope) == effective:
                self._advance_normal_flow(scope, effective)
        permit = super().acquire_scope(
            scope,
            policy,
            operator_policy=operator_policy,
            cancel_event=cancel_event,
            timeout=timeout,
        )
        if policy is not None:
            self._normal_flow_permits.add(id(permit))
        self.scope_acquisitions.append(permit.scope)
        self.scope_acquisition_times.append((permit.scope, self._test_clock()))
        return permit

    def _advance_normal_flow(self, scope: AccessScope, policy: AccessPolicy) -> None:
        """Advance only deterministic adapter flow, never external blocked probes."""

        timestamps = tuple(
            timestamp
            for acquired_scope, timestamp in self.scope_acquisition_times
            if acquired_scope == scope
        )
        if not timestamps:
            return
        target = timestamps[-1] + max(
            policy.min_start_interval,
            policy.cooldown_after_completion,
        )
        if (
            policy.burst_limit is not None
            and policy.window_seconds is not None
            and len(timestamps) >= policy.burst_limit
        ):
            target = max(
                target,
                timestamps[-policy.burst_limit] + policy.window_seconds,
            )
        self._test_clock.advance(max(0.0, target - self._test_clock()))

    def _acquire_host(
        self,
        owner: AccessPermit,
        host: str,
        *,
        cancel_event: threading.Event | None,
        timeout: float | None,
    ) -> HostPermit:
        normalized_host = host.strip().casefold()
        if id(owner) in self._normal_flow_permits:
            timestamps = tuple(
                timestamp
                for acquired_host, timestamp in self.host_acquisition_times
                if acquired_host == normalized_host
            )
            if timestamps:
                self._advance_timestamps(timestamps, self.policy_for(owner.scope))
        permit = super()._acquire_host(
            owner,
            host,
            cancel_event=cancel_event,
            timeout=timeout,
        )
        self.host_acquisition_times.append((normalized_host, self._test_clock()))
        return permit

    def _release_scope(self, permit: AccessPermit) -> None:
        self.permit_release_events.append(("release", permit))
        super()._release_scope(permit)

    def _advance_timestamps(
        self,
        timestamps: tuple[float, ...],
        policy: AccessPolicy,
    ) -> None:
        target = timestamps[-1] + max(
            policy.min_start_interval,
            policy.cooldown_after_completion,
        )
        if (
            policy.burst_limit is not None
            and policy.window_seconds is not None
            and len(timestamps) >= policy.burst_limit
        ):
            target = max(
                target,
                timestamps[-policy.burst_limit] + policy.window_seconds,
            )
        self._test_clock.advance(max(0.0, target - self._test_clock()))

    def record_feedback(
        self,
        source: AccessPermit | AccessScope,
        feedback: AccessFeedback,
    ) -> None:
        super().record_feedback(source, feedback)
        scope = source.scope if isinstance(source, AccessPermit) else source
        self.feedback_records.append((scope, feedback))
        self.feedback_sources.append(source)
        if isinstance(source, AccessPermit):
            self.permit_release_events.append(("feedback", source))


@dataclass(frozen=True, slots=True)
class ContractPorts:
    """The three independent M1 capability ports assembled for one test."""

    topic_search: TopicSearchPort | None = None
    lookup: MetadataLookupPort | None = None
    reference_query: ReferenceQueryPort | None = None


PortFactory: TypeAlias = Callable[["ContractEnvironment"], ContractPorts]
CredentialMode: TypeAlias = Literal["none", "header", "query"]
ContractRequest: TypeAlias = (
    TopicDiscoveryInput | MetadataLookupRequest | MetadataReferenceQueryRequest
)
ContractRedirect: TypeAlias = Literal["same-origin", "cross-origin"]


@dataclass(frozen=True, slots=True)
class ContractExpectedResult:
    """Provider-neutral result facts checked before scenario-specific evidence."""

    outcome: DiscoverySourceOutcome
    raw_item_count: int
    observation_count: int
    relation_count: int
    failure_code: str | None = None

    def __post_init__(self) -> None:
        if self.outcome not in {"EXHAUSTED", "SCAN_LIMIT_REACHED", "FAILED"}:
            raise ValueError("outcome is not a DiscoverySourceOutcome")
        for field_name in ("raw_item_count", "observation_count", "relation_count"):
            value = getattr(self, field_name)
            if isinstance(value, bool) or not isinstance(value, int):
                raise TypeError(f"{field_name} must be an integer")
            if value < 0:
                raise ValueError(f"{field_name} must be nonnegative")
        if (self.outcome == "FAILED") != (self.failure_code is not None):
            raise ValueError("failure_code is required exactly for FAILED outcomes")
        if self.failure_code is not None:
            if type(self.failure_code) is not str:
                raise TypeError("failure_code must be a string or None")
            if not self.failure_code.strip():
                raise ValueError("failure_code must be nonblank")


ScenarioPrepare: TypeAlias = Callable[["ContractEnvironment"], None]
ScenarioEvidence: TypeAlias = Callable[
    ["ProviderContractCase", "ContractEnvironment", MetadataProviderResult],
    None,
]


@dataclass(frozen=True, slots=True)
class ContractScenario:
    """One real adapter invocation with offline HTTP setup and semantic evidence."""

    name: str
    capability: ProviderCapability
    request: ContractRequest
    prepare: ScenarioPrepare
    expected: ContractExpectedResult
    evidence: ScenarioEvidence
    expects_feedback: bool = False
    credential_redirect: ContractRedirect | None = None
    expected_scope: AccessScope | None = None


@dataclass(frozen=True, slots=True)
class ContractBinding:
    """The complete contract supplied by each concrete provider test class."""

    provider_name: str
    capabilities: frozenset[ProviderCapability]
    expected_scope: AccessScope
    credential_mode: CredentialMode
    port_factory: PortFactory
    scenarios: tuple[ContractScenario, ...]


class ContractEnvironment:
    """Offline clocks, Network boundary, capability ports, and MetadataApi."""

    __slots__ = (
        "api",
        "capabilities",
        "coordinator",
        "http_client",
        "monotonic_clock",
        "policy",
        "ports",
        "provider_name",
        "resolver",
        "scope",
        "secret_sentinel",
        "transport",
        "wall_clock",
    )

    def __init__(
        self,
        *,
        provider_name: str,
        capabilities: frozenset[ProviderCapability],
        port_factory: PortFactory,
        expected_scope: AccessScope | None = None,
    ) -> None:
        if type(capabilities) is not frozenset:
            raise TypeError("capabilities must be a frozenset")
        allowed: frozenset[str] = frozenset({"search", "lookup", "references"})
        if not capabilities <= allowed:
            raise ValueError("capabilities contain an unsupported value")
        if not callable(port_factory):
            raise TypeError("port_factory must be callable")

        self.provider_name = provider_name
        self.capabilities = capabilities
        self.secret_sentinel = secrets.token_urlsafe(24)
        self.monotonic_clock = FakeMonotonicClock()
        self.wall_clock = FakeWallClock()
        self.resolver = _FakeResolver()
        self.transport = _FakeTransport()
        self.coordinator = RecordingAccessCoordinator(clock=self.monotonic_clock)
        self.http_client = HttpClient(
            resolver=self.resolver,
            transport=self.transport,
            coordinator=self.coordinator,
            clock=self.monotonic_clock,
            sleeper=lambda _seconds: None,
            max_retries=0,
        )
        self.scope = expected_scope or AccessScope(
            provider_name=provider_name,
            channel="api",
            service_name="metadata",
        )
        if self.scope.provider_name != provider_name:
            raise ValueError("expected_scope provider_name must match the environment")
        self.policy = AccessPolicy(max_concurrency=1)
        self.ports = port_factory(self)
        if not isinstance(self.ports, ContractPorts):
            raise TypeError("port_factory must return ContractPorts")
        self._validate_capabilities()
        self.api = MetadataApi(
            MetadataService(
                topic_search_ports=()
                if self.ports.topic_search is None
                else (self.ports.topic_search,),
                lookup_ports=() if self.ports.lookup is None else (self.ports.lookup,),
                reference_query_ports=()
                if self.ports.reference_query is None
                else (self.ports.reference_query,),
            )
        )

    def __repr__(self) -> str:
        return (
            f"<ContractEnvironment provider_name={self.provider_name!r} "
            f"capabilities={sorted(self.capabilities)!r}>"
        )

    def __enter__(self) -> "ContractEnvironment":
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        self.close()
        return False

    def close(self) -> None:
        self.transport.clear()
        self.http_client.close()

    def has_capability(self, capability: ProviderCapability) -> bool:
        if capability not in {"search", "lookup", "references"}:
            raise ValueError("capability is not supported")
        return capability in self.capabilities

    def queue_http_response(
        self,
        *,
        status: int,
        headers: Sequence[Header | tuple[str, str]] = (),
        body: bytes = b"",
    ) -> None:
        if type(status) is not int or not 100 <= status <= 599:
            raise ValueError("status must be an HTTP status")
        if type(body) is not bytes:
            raise TypeError("body must be bytes")
        self.transport.actions.append(
            _ContractRawResponse(
                status=status,
                headers=tuple(headers),
                body=body,
            )
        )

    def reset_http(self) -> None:
        self.transport.clear()

    def _validate_capabilities(self) -> None:
        values: tuple[tuple[ProviderCapability, object | None, type[object]], ...] = (
            ("search", self.ports.topic_search, TopicSearchPort),
            ("lookup", self.ports.lookup, MetadataLookupPort),
            ("references", self.ports.reference_query, ReferenceQueryPort),
        )
        for capability, port, protocol in values:
            declared = capability in self.capabilities
            if declared != (port is not None):
                raise ValueError("declared capabilities must exactly match assembled ports")
            if port is not None and not isinstance(port, protocol):
                raise TypeError("assembled capability does not implement its declared port")
            if port is not None and port.provider_name != self.provider_name:
                raise ValueError("capability port provider_name must match the environment")


@dataclass(frozen=True, slots=True)
class ExpectedAffiliation:
    name: str
    ror: str | None = None


@dataclass(frozen=True, slots=True)
class ExpectedAuthor:
    kind: AuthorKindValue
    display_name: str
    given_name: str | None = None
    family_name: str | None = None
    orcid: str | None = None
    affiliations: tuple[ExpectedAffiliation, ...] = ()


class ProviderContractCase:
    """Discoverable contract mixin for concrete provider adapter tests."""

    _FORBIDDEN_PAYLOAD_KEYS = frozenset(
        {
            "body",
            "cookie",
            "cursor",
            "extra",
            "extra_metadata",
            "header",
            "headers",
            "page",
            "payload",
            "raw",
            "request",
            "response",
            "score",
            "secret",
            "token",
            "url_session",
            "vendor",
        }
    )

    def _test_case(self) -> unittest.TestCase:
        if not isinstance(self, unittest.TestCase):
            raise TypeError("ProviderContractCase must be combined with unittest.TestCase")
        return self

    def provider_contract_binding(self) -> ContractBinding:
        """Return the concrete provider binding; every subclass must override."""

        raise AssertionError("provider contract binding must be supplied")

    def test_provider_contract_binding_is_complete(self) -> None:
        binding = self._contract_binding()
        self._assert_binding_complete(binding)
        with self._new_contract_environment(binding) as environment:
            self._test_case().assertEqual(environment.scope, binding.expected_scope)

    def test_provider_contract_capability_scenarios(self) -> None:
        binding = self._contract_binding()
        self._assert_binding_complete(binding)
        for scenario in binding.scenarios:
            with self._test_case().subTest(scenario=scenario.name):
                self._execute_contract_scenario(binding, scenario)

    def test_provider_contract_access_scope_and_feedback(self) -> None:
        binding = self._contract_binding()
        self._assert_binding_complete(binding)
        feedback_scenarios = tuple(
            scenario for scenario in binding.scenarios if scenario.expects_feedback
        )
        self._test_case().assertTrue(
            feedback_scenarios,
            "at least one real adapter scenario must record access feedback",
        )
        for scenario in feedback_scenarios:
            with self._test_case().subTest(scenario=scenario.name):
                self._execute_contract_scenario(
                    binding,
                    scenario,
                    require_feedback=True,
                )

    def test_provider_contract_credentials_follow_redirect_origin(self) -> None:
        binding = self._contract_binding()
        self._assert_binding_complete(binding)
        if binding.credential_mode == "none":
            scenarios = binding.scenarios[:1]
        else:
            scenarios = tuple(
                scenario
                for scenario in binding.scenarios
                if scenario.credential_redirect is not None
            )
        self._test_case().assertTrue(scenarios)
        for scenario in scenarios:
            with self._test_case().subTest(scenario=scenario.name):
                self._execute_contract_scenario(binding, scenario)

    def _contract_binding(self) -> ContractBinding:
        binding = self.provider_contract_binding()
        self._test_case().assertIsInstance(
            binding,
            ContractBinding,
            "provider_contract_binding() must return ContractBinding",
        )
        return cast(ContractBinding, binding)

    def _assert_binding_complete(self, binding: ContractBinding) -> None:
        case = self._test_case()
        case.assertIs(type(binding.provider_name), str)
        case.assertTrue(binding.provider_name)
        case.assertEqual(binding.provider_name, binding.provider_name.strip())
        case.assertIs(type(binding.capabilities), frozenset)
        case.assertTrue(binding.capabilities)
        case.assertTrue(binding.capabilities <= frozenset({"search", "lookup", "references"}))
        case.assertIsInstance(binding.expected_scope, AccessScope)
        case.assertEqual(binding.expected_scope.provider_name, binding.provider_name)
        case.assertIn(binding.credential_mode, ("none", "header", "query"))
        case.assertTrue(callable(binding.port_factory))
        case.assertIs(type(binding.scenarios), tuple)
        case.assertTrue(binding.scenarios)

        scenario_names: list[str] = []
        scenario_capabilities: set[ProviderCapability] = set()
        semantic_evidence = False
        redirect_kinds: set[ContractRedirect] = set()
        feedback_scenarios = 0
        for scenario in binding.scenarios:
            case.assertIsInstance(scenario, ContractScenario)
            scenario_names.append(scenario.name)
            case.assertIs(type(scenario.name), str)
            case.assertTrue(scenario.name)
            case.assertEqual(scenario.name, scenario.name.strip())
            case.assertIn(scenario.capability, binding.capabilities)
            scenario_capabilities.add(scenario.capability)
            case.assertTrue(callable(scenario.prepare))
            case.assertTrue(callable(scenario.evidence))
            case.assertIs(type(scenario.expects_feedback), bool)
            case.assertIsInstance(scenario.expected, ContractExpectedResult)
            if scenario.expected_scope is not None:
                case.assertIsInstance(scenario.expected_scope, AccessScope)
                case.assertEqual(
                    scenario.expected_scope.provider_name,
                    binding.provider_name,
                )
            self._assert_scenario_request(binding, scenario)
            semantic_evidence = semantic_evidence or (
                scenario.expected.observation_count > 0 or scenario.expected.relation_count > 0
            )
            if scenario.expects_feedback:
                feedback_scenarios += 1
            if scenario.credential_redirect is not None:
                case.assertIn(
                    scenario.credential_redirect,
                    ("same-origin", "cross-origin"),
                )
                redirect_kinds.add(scenario.credential_redirect)

        case.assertEqual(len(scenario_names), len(set(scenario_names)))
        case.assertEqual(scenario_capabilities, set(binding.capabilities))
        case.assertTrue(
            semantic_evidence,
            "at least one adapter result must carry neutral semantic evidence",
        )
        case.assertGreaterEqual(feedback_scenarios, 1)
        if binding.credential_mode == "none":
            case.assertFalse(
                redirect_kinds,
                "credential_redirect is only valid for credentialed adapters",
            )
        else:
            case.assertEqual(redirect_kinds, {"same-origin", "cross-origin"})

    def _assert_scenario_request(
        self,
        binding: ContractBinding,
        scenario: ContractScenario,
    ) -> None:
        case = self._test_case()
        if scenario.capability == "search":
            case.assertIsInstance(scenario.request, TopicDiscoveryInput)
            request = cast(TopicDiscoveryInput, scenario.request)
            case.assertEqual(
                tuple(item.provider_name for item in request.providers),
                (binding.provider_name,),
            )
        elif scenario.capability == "lookup":
            case.assertIsInstance(scenario.request, MetadataLookupRequest)
            request = cast(MetadataLookupRequest, scenario.request)
            case.assertEqual(request.provider_name, binding.provider_name)
        else:
            case.assertIsInstance(scenario.request, MetadataReferenceQueryRequest)
            request = cast(MetadataReferenceQueryRequest, scenario.request)
            case.assertEqual(
                tuple(item.provider_name for item in request.providers),
                (binding.provider_name,),
            )

    def _new_contract_environment(self, binding: ContractBinding) -> ContractEnvironment:
        environment = ContractEnvironment(
            provider_name=binding.provider_name,
            capabilities=binding.capabilities,
            port_factory=binding.port_factory,
            expected_scope=binding.expected_scope,
        )
        case = self._test_case()
        case.assertFalse(environment.transport.calls)
        case.assertFalse(environment.coordinator.scope_acquisitions)
        case.assertFalse(environment.coordinator.feedback_records)
        return environment

    def _execute_contract_scenario(
        self,
        binding: ContractBinding,
        scenario: ContractScenario,
        *,
        require_feedback: bool = False,
    ) -> None:
        case = self._test_case()
        with self._new_contract_environment(binding) as environment:
            scenario.prepare(environment)
            case.assertTrue(
                environment.transport.actions,
                "scenario.prepare() must queue an offline HTTP response",
            )
            case.assertFalse(
                environment.transport.calls,
                "scenario preparation must not execute the adapter",
            )
            case.assertFalse(environment.coordinator.scope_acquisitions)
            case.assertFalse(environment.coordinator.feedback_records)

            result = self._invoke_contract_scenario(environment, scenario)
            case.assertTrue(
                environment.transport.calls,
                "adapter scenario must reach the environment fake transport",
            )
            case.assertTrue(
                environment.coordinator.scope_acquisitions,
                "adapter scenario must acquire through the environment Coordinator",
            )
            expected_scope = scenario.expected_scope or binding.expected_scope
            case.assertEqual(
                set(environment.coordinator.scope_acquisitions),
                {expected_scope},
            )
            self._assert_scenario_result(result, scenario.expected)
            self.assert_no_private_payload(
                result,
                runtime_secret=environment.secret_sentinel,
            )
            self._assert_credential_transport_evidence(
                binding,
                scenario,
                environment,
            )
            scenario.evidence(self, environment, result)
            if require_feedback:
                self._assert_feedback_reached_coordinator(
                    expected_scope,
                    environment,
                )

    def _invoke_contract_scenario(
        self,
        environment: ContractEnvironment,
        scenario: ContractScenario,
    ) -> MetadataProviderResult:
        expected = scenario.expected
        if scenario.capability == "search":
            return self.assert_topic_scan(
                environment,
                cast(TopicDiscoveryInput, scenario.request),
                outcome=expected.outcome,
                raw_item_count=expected.raw_item_count,
                observation_count=expected.observation_count,
                relation_count=expected.relation_count,
            )
        if scenario.capability == "lookup":
            return self.assert_lookup_scan(
                environment,
                cast(MetadataLookupRequest, scenario.request),
                outcome=expected.outcome,
                raw_item_count=expected.raw_item_count,
                observation_count=expected.observation_count,
                relation_count=expected.relation_count,
            )
        return self.assert_reference_scan(
            environment,
            cast(MetadataReferenceQueryRequest, scenario.request),
            outcome=expected.outcome,
            raw_item_count=expected.raw_item_count,
            observation_count=expected.observation_count,
            relation_count=expected.relation_count,
        )

    def _assert_scenario_result(
        self,
        result: MetadataProviderResult,
        expected: ContractExpectedResult,
    ) -> None:
        if expected.failure_code is None:
            self._test_case().assertIsNone(result.failure)
        else:
            self.assert_stable_failure(result, expected_code=expected.failure_code)

    def _assert_credential_transport_evidence(
        self,
        binding: ContractBinding,
        scenario: ContractScenario,
        environment: ContractEnvironment,
    ) -> None:
        case = self._test_case()
        secret = environment.secret_sentinel

        def header_secret(call: ContractHttpCall) -> bool:
            return any(value == secret for _name, value in call.headers)

        def query_secret(call: ContractHttpCall) -> bool:
            return secret in call.wire_target

        for call in environment.transport.calls:
            case.assertNotIn(secret, call.request.model_dump_json())
            case.assertNotIn(secret, repr(call))
        header_values = tuple(header_secret(call) for call in environment.transport.calls)
        query_values = tuple(query_secret(call) for call in environment.transport.calls)
        if binding.credential_mode == "none":
            case.assertFalse(any(header_values))
            case.assertFalse(any(query_values))
            return
        if binding.credential_mode == "header":
            case.assertFalse(any(query_values))
            carries_secret = header_values
        else:
            case.assertFalse(any(header_values))
            carries_secret = query_values
        case.assertTrue(carries_secret[0])
        if scenario.credential_redirect is None:
            case.assertTrue(all(carries_secret))
            return
        case.assertGreaterEqual(len(carries_secret), 2)
        if scenario.credential_redirect == "same-origin":
            case.assertTrue(all(carries_secret))
        else:
            case.assertFalse(any(carries_secret[1:]))

    def _assert_feedback_reached_coordinator(
        self,
        expected_scope: AccessScope,
        environment: ContractEnvironment,
    ) -> None:
        case = self._test_case()
        records = environment.coordinator.feedback_records
        case.assertTrue(
            records,
            "expects_feedback scenario did not update the environment Coordinator",
        )
        case.assertEqual({scope for scope, _feedback in records}, {expected_scope})
        case.assertEqual(len(environment.coordinator.feedback_sources), len(records))
        for source in environment.coordinator.feedback_sources:
            case.assertIsInstance(
                source,
                AccessPermit,
                "response feedback must be applied through AccessPermit.release()",
            )
            assert isinstance(source, AccessPermit)
            feedback_index = next(
                index
                for index, event in enumerate(environment.coordinator.permit_release_events)
                if event[0] == "feedback" and event[1] is source
            )
            release_index = next(
                index
                for index, event in enumerate(environment.coordinator.permit_release_events)
                if event[0] == "release" and event[1] is source
            )
            case.assertLess(
                feedback_index,
                release_index,
                "response feedback must be recorded before the permit is released",
            )
        delay = max(
            self._feedback_block_seconds(environment, feedback) for _scope, feedback in records
        )
        case.assertGreater(delay, 0.0)
        with case.assertRaises(AdmissionTimeout):
            environment.coordinator.acquire_scope(
                expected_scope,
                timeout=0.01,
            )
        environment.monotonic_clock.advance(delay)
        resumed = environment.coordinator.acquire_scope(
            expected_scope,
            timeout=0.01,
        )
        resumed.release()

    @staticmethod
    def _feedback_block_seconds(
        environment: ContractEnvironment,
        feedback: AccessFeedback,
    ) -> float:
        now = environment.monotonic_clock()
        candidates = [feedback.retry_after or 0.0]
        if feedback.blocked_until is not None:
            candidates.append(max(0.0, feedback.blocked_until - now))
        if feedback.quota_reset_at is not None:
            candidates.append(max(0.0, feedback.quota_reset_at - now))
        if feedback.throttled and feedback.retry_after is None and feedback.blocked_until is None:
            candidates.append(environment.policy.backoff_seconds)
        return max(candidates)

    def _require_capability(
        self,
        environment: ContractEnvironment,
        capability: ProviderCapability,
    ) -> None:
        self._test_case().assertTrue(
            environment.has_capability(capability),
            f"provider does not declare {capability} capability",
        )

    def assert_topic_scan(
        self,
        environment: ContractEnvironment,
        request: TopicDiscoveryInput,
        *,
        outcome: DiscoverySourceOutcome,
        raw_item_count: int,
        observation_count: int,
        relation_count: int = 0,
    ) -> MetadataProviderResult:
        self._require_capability(environment, "search")
        batch = environment.api.search_topic(request)
        result = self._result_for_provider(batch.providers, environment.provider_name)
        self._assert_scan_counts(
            result,
            outcome=outcome,
            raw_item_count=raw_item_count,
            observation_count=observation_count,
            relation_count=relation_count,
        )
        return result

    def assert_lookup_scan(
        self,
        environment: ContractEnvironment,
        request: MetadataLookupRequest,
        *,
        outcome: DiscoverySourceOutcome,
        raw_item_count: int,
        observation_count: int,
        relation_count: int = 0,
    ) -> MetadataProviderResult:
        self._require_capability(environment, "lookup")
        result = environment.api.lookup(request)
        self._test_case().assertEqual(result.provider_name, environment.provider_name)
        self._assert_scan_counts(
            result,
            outcome=outcome,
            raw_item_count=raw_item_count,
            observation_count=observation_count,
            relation_count=relation_count,
        )
        return result

    def assert_reference_scan(
        self,
        environment: ContractEnvironment,
        request: MetadataReferenceQueryRequest,
        *,
        outcome: DiscoverySourceOutcome,
        raw_item_count: int,
        relation_count: int,
        observation_count: int = 0,
    ) -> MetadataProviderResult:
        self._require_capability(environment, "references")
        batch = environment.api.query_references(request)
        result = self._result_for_provider(batch.providers, environment.provider_name)
        self._assert_scan_counts(
            result,
            outcome=outcome,
            raw_item_count=raw_item_count,
            observation_count=observation_count,
            relation_count=relation_count,
        )
        return result

    def _result_for_provider(
        self,
        results: tuple[MetadataProviderResult, ...],
        provider_name: str,
    ) -> MetadataProviderResult:
        matching = tuple(result for result in results if result.provider_name == provider_name)
        self._test_case().assertEqual(len(matching), 1)
        return matching[0]

    def _assert_scan_counts(
        self,
        result: MetadataProviderResult,
        *,
        outcome: DiscoverySourceOutcome,
        raw_item_count: int,
        observation_count: int,
        relation_count: int,
    ) -> None:
        case = self._test_case()
        case.assertEqual(result.outcome, outcome)
        case.assertEqual(result.raw_item_count, raw_item_count)
        case.assertEqual(len(result.observations), observation_count)
        case.assertEqual(len(result.relations), relation_count)

    def assert_stable_failure(
        self,
        result: MetadataProviderResult,
        *,
        expected_code: str,
        forbidden_values: Sequence[str] = (),
    ) -> None:
        case = self._test_case()
        case.assertEqual(result.outcome, "FAILED")
        case.assertIsNotNone(result.failure)
        assert result.failure is not None
        case.assertEqual(result.failure.code, expected_code)
        serialized = result.failure.model_dump_json()
        for forbidden in forbidden_values:
            if forbidden:
                case.assertNotIn(forbidden, serialized)

    def assert_scope_is_neutral(
        self,
        scope: AccessScope,
        *,
        forbidden_values: Sequence[str] = (),
    ) -> None:
        case = self._test_case()
        case.assertEqual(
            tuple(item.name for item in fields(scope)),
            ("provider_name", "channel", "service_name"),
        )
        rendered = repr(scope)
        for forbidden in forbidden_values:
            if forbidden:
                case.assertNotIn(forbidden, rendered)
        case.assertNotIn("://", scope.provider_name)
        case.assertNotIn("?", scope.provider_name)
        if scope.service_name is not None:
            case.assertNotIn("://", scope.service_name)
            case.assertNotIn("?", scope.service_name)

    def assert_author_mapping(
        self,
        actual: tuple[Author, ...],
        expected: tuple[ExpectedAuthor, ...],
    ) -> None:
        projection = tuple(
            ExpectedAuthor(
                kind=author.kind.value,
                display_name=author.display_name,
                given_name=author.given_name,
                family_name=author.family_name,
                orcid=author.orcid,
                affiliations=tuple(
                    ExpectedAffiliation(name=value.name, ror=value.ror)
                    for value in author.affiliations
                ),
            )
            for author in actual
        )
        self._test_case().assertEqual(projection, expected)

    def assert_identifier_record_id_separation(
        self,
        observation: MetadataObservation,
        *,
        expected_identifiers: tuple[Identifier, ...],
        expected_record_id: str,
        forbidden_record_ids: Sequence[str] = (),
    ) -> None:
        case = self._test_case()
        case.assertEqual(observation.metadata.identifiers, expected_identifiers)
        case.assertEqual(observation.provenance.source_record_id, expected_record_id)
        identifier_values = tuple(value.value for value in observation.metadata.identifiers)
        for record_id in forbidden_record_ids:
            case.assertNotIn(record_id, identifier_values)

    def assert_version_links(
        self,
        observation: MetadataObservation,
        expected: tuple[ProviderLiteratureKey, ...],
    ) -> None:
        self._test_case().assertEqual(observation.version_links, expected)

    def assert_citing_to_cited(
        self,
        relation: ProviderRelationObservation,
        *,
        citing: ProviderLiteratureKey,
        cited: ProviderLiteratureKey,
    ) -> None:
        case = self._test_case()
        case.assertEqual(relation.citing, citing)
        case.assertEqual(relation.cited, cited)

    def assert_asset_hints(
        self,
        observation: MetadataObservation,
        expected: tuple[object, ...],
        *,
        runtime_secret: str,
    ) -> None:
        case = self._test_case()
        case.assertEqual(observation.asset_hints, expected)
        case.assertGreaterEqual(len(observation.asset_hints), len(expected))
        for hint in observation.asset_hints:
            case.assertNotIn(runtime_secret, hint.url)
            query = urlsplit(hint.url).query
            try:
                sensitive = has_sensitive_query_parameter(query)
            except (TypeError, ValueError) as error:
                raise AssertionError("asset hint query must be safely parseable") from error
            case.assertFalse(sensitive)

    def assert_no_private_payload(
        self,
        value: BaseModel,
        *,
        runtime_secret: str,
        forbidden_values: Sequence[str] = (),
    ) -> None:
        case = self._test_case()
        serialized = value.model_dump_json()
        case.assertNotIn(runtime_secret, serialized)
        for forbidden in forbidden_values:
            if forbidden:
                case.assertNotIn(forbidden, serialized)
        payload = json.loads(serialized)
        keys = _nested_keys(payload)
        case.assertFalse(keys & self._FORBIDDEN_PAYLOAD_KEYS)


def _nested_keys(value: object) -> set[str]:
    if isinstance(value, dict):
        result = {str(key).casefold() for key in value}
        for nested in value.values():
            result.update(_nested_keys(nested))
        return result
    if isinstance(value, list):
        result: set[str] = set()
        for nested in value:
            result.update(_nested_keys(nested))
        return result
    return set()


__all__ = (
    "ContractBinding",
    "ContractEnvironment",
    "ContractExpectedResult",
    "ContractHttpCall",
    "ContractPorts",
    "ContractScenario",
    "CredentialMode",
    "ExpectedAffiliation",
    "ExpectedAuthor",
    "FakeMonotonicClock",
    "FakeWallClock",
    "ProviderCapability",
    "ProviderContractCase",
    "RecordingAccessCoordinator",
)
