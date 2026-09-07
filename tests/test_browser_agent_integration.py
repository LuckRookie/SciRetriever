"""Offline composition checks for the Browser Agent and provider lanes.

These tests intentionally assemble the production scheduler, session broker and
``AgentBrowserController`` around small in-memory fixtures.  The fixtures expose
only the capability seams used by those components; they never start a browser,
open a socket or read a user profile.
"""

from __future__ import annotations

import json
import threading
import unittest
from collections.abc import Callable
from dataclasses import replace
from tempfile import TemporaryDirectory

from sciretriever.acquisition.browser_control import AgentBrowserController
from sciretriever.agents.api import (
    AgentCallLimits,
    AgentModelCapabilities,
    AgentProvenance,
    AgentRole,
    AgentRoleBinding,
    AgentRuntime,
    AgentToolCall,
    AgentUsage,
)
from sciretriever.agents.ports import AgentProviderCall
from sciretriever.model.primitives import sha256_digest
from sciretriever.network.admission import AccessCoordinator, AccessPolicy, AccessScope
from sciretriever.network.browser import (
    BrowserCaptureKind,
    BrowserPageObservation,
)
from sciretriever.network.browser_control import (
    BROWSER_OBSERVATION_MEDIA_TYPE,
    BrowserAction,
    BrowserActionOutcome,
    BrowserActionReceipt,
    BrowserAgentStatus,
    BrowserBounds,
    BrowserCancelled,
    BrowserCaptured,
    BrowserCapturedTransition,
    BrowserCaptureState,
    BrowserElement,
    BrowserElementState,
    BrowserObservation,
    BrowserPageState,
    BrowserScreenshot,
    BrowserScrollState,
    BrowserSettledTransition,
    BrowserStepAssessment,
    BrowserStepPolicy,
    BrowserStepSession,
    BrowserSurface,
    BrowserSurfaceKind,
    BrowserViewport,
)
from sciretriever.network.browser_scheduler import (
    BrowserArticleAttempt,
    BrowserAttemptCompletion,
    BrowserAttemptDisposition,
    BrowserGroupFeedback,
    BrowserGroupPolicy,
    BrowserGroupScheduler,
    BrowserSchedulerCancellation,
    BrowserSchedulingCancelled,
)
from sciretriever.network.browser_sessions import BrowserSessionBroker

_EVENTS = ("page", "download", "response", "requestfinished", "requestfailed")


class _AdvancingClock:
    """Deterministic scheduler clock; no wall-clock or network is involved."""

    def __init__(self) -> None:
        self.current = 0.0
        self._lock = threading.Lock()

    def now(self) -> float:
        with self._lock:
            return self.current

    def wait_until(
        self,
        deadline: float,
        cancel_event: BrowserSchedulerCancellation | None,
    ) -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise BrowserSchedulingCancelled("fixture cancellation")
        with self._lock:
            self.current = max(self.current, deadline)


class _Article:
    def __init__(self, context: _Context, lane_key: str) -> None:
        self.context = context
        self.lane_key = lane_key
        self.active = True
        self.route_handler: Callable[[object], object] | None = None
        self.handlers: dict[str, Callable[[object], object]] = {}

    def bind_connection(self, binding: object) -> object:
        return binding

    def route(self, pattern: str, handler: Callable[[object], object]) -> None:
        if pattern != "**/*" or self.route_handler is not None:
            raise AssertionError("fixture route registration is not closed")
        self.route_handler = handler

    def on(self, event: str, handler: Callable[[object], object]) -> None:
        if event not in _EVENTS or event in self.handlers:
            raise AssertionError("fixture event registration is not closed")
        self.handlers[event] = handler

    def click(self, selector: str) -> bool:
        del selector
        return False

    def open_viewer(self, locator: str) -> None:
        del locator

    def open_verified_locator(self, locator: str) -> None:
        del locator

    def discover_pdf_locators(self) -> tuple[str, ...]:
        return ()

    def capture_available(self, kind: BrowserCaptureKind) -> bool:
        del kind
        return False

    def wait_for_capture(self, kind: BrowserCaptureKind) -> None:
        del kind

    def wait_for_any_capture(self, kinds: tuple[BrowserCaptureKind, ...]) -> None:
        del kinds

    def has_selector(self, selector: str) -> bool:
        del selector
        return False

    def text(self, selector: str) -> str:
        del selector
        return ""

    def observe(self) -> BrowserPageObservation:
        return BrowserPageObservation("https://publisher.invalid/article", 200)

    def browser_steps(
        self,
        policy: BrowserStepPolicy,
        *,
        timeout_seconds: float,
    ) -> BrowserStepSession:
        del policy, timeout_seconds
        raise AssertionError("the integration fixture injects its bounded control session")

    def end_article(self) -> bool:
        if not self.active:
            return False
        self.active = False
        self.context.active_lanes.remove(self.lane_key)
        return True


class _Context:
    def __init__(self, owner: _Runtime, profile_identity: object) -> None:
        self.owner = owner
        self.profile_identity = profile_identity
        self.articles: list[_Article] = []
        self.active_lanes: set[str] = set()
        self.close_calls = 0

    def bind_connection(self, binding: object) -> object:
        return binding

    def begin_article(
        self,
        *,
        lane_key: str,
        downloads_path: str,
        connection_binding: object,
    ) -> _Article:
        del downloads_path, connection_binding
        if lane_key in self.active_lanes:
            raise AssertionError("same Publisher lane overlapped")
        self.active_lanes.add(lane_key)
        article = _Article(self, lane_key)
        self.articles.append(article)
        return article

    def close(self) -> None:
        self.close_calls += 1
        if self.active_lanes:
            raise AssertionError("shared context closed while a lane was active")


class _Runtime:
    def __init__(self, profile_identity: object) -> None:
        self.profile_identity = profile_identity
        self.context: _Context | None = None
        self.close_calls = 0

    def __enter__(self) -> _Runtime:
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> bool:
        del exc_type, exc, traceback
        self.close()
        return False

    def bind_connection(self, binding: object) -> object:
        return binding

    def new_context(
        self,
        *,
        downloads_path: str,
        accept_downloads: bool,
        connection_binding: object,
    ) -> _Context:
        del downloads_path, connection_binding
        if not accept_downloads or self.context is not None:
            raise AssertionError("one shared context is required")
        self.context = _Context(self, self.profile_identity)
        return self.context

    def close(self) -> None:
        self.close_calls += 1


class _Factory:
    def __init__(self) -> None:
        self.profile_identity = object()
        self.runtimes: list[_Runtime] = []

    def __call__(self, *, downloads_path: str, connection_binding: object) -> _Runtime:
        del downloads_path, connection_binding
        runtime = _Runtime(self.profile_identity)
        self.runtimes.append(runtime)
        return runtime


class _Agent:
    provider_name = "fixture-browser-agent"

    def __init__(
        self,
        *,
        on_call: Callable[[AgentProviderCall], None] | None = None,
    ) -> None:
        self.calls: list[AgentProviderCall] = []
        self.on_call = on_call

    def execute(self, call: AgentProviderCall) -> AgentToolCall:
        self.calls.append(call)
        if self.on_call is not None:
            self.on_call(call)
        summary = json.loads(call.text_parts[1].text)
        encoded = json.dumps(
            {
                "article_token": summary["article_token"],
                "page_id": summary["page_id"],
                "revision": summary["revision"],
                "surface_id": "s00000001",
                "element_id": "e00000001",
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        return AgentToolCall(
            tool_name="click_element",
            arguments=encoded,
            provenance=AgentProvenance(
                provider=self.provider_name,
                model=call.model,
                input_sha256=call.input_sha256,
                parameters_sha256=sha256_digest(b"browser-agent-fixture"),
                usage=AgentUsage(output_tokens=1, response_bytes=len(encoded)),
            ),
        )


def _agent_runtime(agent: _Agent) -> AgentRuntime:
    return AgentRuntime(
        adapter=agent,
        browser=AgentRoleBinding(
            role=AgentRole.BROWSER,
            model="fixture-model",
            capabilities=AgentModelCapabilities(
                context_window_tokens=1_000_000,
                max_output_tokens=131_072,
                image_input=True,
                tool_decision=True,
                supported_image_media_types=frozenset({BROWSER_OBSERVATION_MEDIA_TYPE}),
                max_image_count=1,
                max_image_bytes=2 * 1024 * 1024,
            ),
            limits=AgentCallLimits(
                max_prompt_bytes=131_072,
                max_input_bytes=2 * 1024 * 1024,
                max_request_bytes=3 * 1024 * 1024,
                max_response_bytes=1 * 1024 * 1024,
                max_result_bytes=1 * 1024 * 1024,
                max_output_tokens=131_072,
                context_window_tokens=1_000_000,
            ),
        ),
    )


class _ActionPort:
    def __init__(self, *, capture_race: bool = False) -> None:
        self.capture_race = capture_race
        self.capture_state = BrowserCaptureState.NONE
        self.executed = 0
        self.observation = self._make_observation()

    @staticmethod
    def _make_observation() -> BrowserObservation:
        viewport = BrowserViewport(width=1280, height=720)
        screenshot = b"fixture-image"
        return BrowserObservation(
            article_token="article",
            revision=1,
            page_id="p00000001",
            surfaces=(
                BrowserSurface(
                    surface_id="s00000001",
                    page_id="p00000001",
                    kind=BrowserSurfaceKind.PAGE,
                    parent_surface_id=None,
                    origin="https://publisher.invalid",
                    path="/article",
                    title="Article",
                    viewport=viewport,
                    bounds=BrowserBounds(0, 0, 1280, 720),
                    scroll=BrowserScrollState(0, 0, 0, 1440),
                ),
            ),
            elements=(
                BrowserElement(
                    element_id="e00000001",
                    surface_id="s00000001",
                    role="button",
                    name="Download PDF",
                    state=BrowserElementState.ENABLED,
                    bounds=BrowserBounds(20, 20, 180, 40),
                ),
            ),
            screenshot=BrowserScreenshot(
                screenshot_id="i00000001",
                article_token="article",
                page_id="p00000001",
                surface_id="s00000001",
                revision=1,
                viewport=viewport,
                media_type=BROWSER_OBSERVATION_MEDIA_TYPE,
                sha256=sha256_digest(screenshot),
                content=screenshot,
            ),
            page_state=BrowserPageState.NORMAL,
            agent_status=BrowserAgentStatus.RUNNING,
            capture_state=BrowserCaptureState.NONE,
        )

    def mark_capture(self) -> None:
        self.capture_state = BrowserCaptureState.CAPTURED
        self.observation = replace(self.observation, capture_state=self.capture_state)

    def observe(self) -> BrowserObservation:
        return self.observation

    def begin(
        self,
        *,
        page_state: BrowserPageState,
        timeout_seconds: float,
    ) -> BrowserCapturedTransition | BrowserSettledTransition:
        del page_state
        return self.settle(self.observation, timeout_seconds=timeout_seconds)

    def execute(
        self,
        action: BrowserAction,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserCapturedTransition:
        del observation
        if timeout_seconds <= 0:
            raise AssertionError("fixture action deadline was not positive")
        self.executed += 1
        if self.capture_race:
            raise AssertionError("capture-race action must not be executed")
        if action.kind.value != "click-element":
            raise AssertionError("fixture Agent should click the PDF control")
        self.mark_capture()
        receipt = BrowserActionReceipt(
            action_kind=action.kind,
            outcome=BrowserActionOutcome.APPLIED,
            article_token=self.observation.article_token,
            page_id=action.page_id,
            surface_id=action.surface_id,
            before_revision=self.observation.revision,
            after_revision=self.observation.revision,
            elapsed_milliseconds=1,
        )
        return BrowserCapturedTransition(self.observation, receipt)

    def settle(
        self,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserCapturedTransition | BrowserSettledTransition:
        if timeout_seconds <= 0:
            raise AssertionError("fixture settle deadline was not positive")
        if self.capture_state is BrowserCaptureState.CAPTURED:
            return BrowserCapturedTransition(self.observation)
        return BrowserSettledTransition(observation=self.observation, changed=False)


class _ControlFactory:
    def __init__(self, control: _ActionPort) -> None:
        self.control = control

    def open(
        self,
        session: object,
        *,
        timeout_seconds: float,
    ) -> BrowserStepSession:
        if not isinstance(session, _Article):
            raise AssertionError("controller did not receive the leased article session")
        return BrowserStepSession(
            driver=self.control,
            policy=_PassThroughPolicy(),
            timeout_seconds=timeout_seconds,
        )


class _PassThroughPolicy:
    def assess(self, observation: BrowserObservation) -> BrowserStepAssessment:
        return BrowserStepAssessment(observation.page_state, True)


class _PermitRecorder(AccessCoordinator):
    def __init__(self) -> None:
        super().__init__()
        self.released_scopes: list[str] = []

    def _release_scope(self, permit: object) -> None:
        scope = getattr(permit, "scope")
        self.released_scopes.append(scope.provider_name)
        super()._release_scope(permit)  # type: ignore[arg-type]


class BrowserAgentIntegrationTests(unittest.TestCase):
    def _attempt(self, key: str, group: str, *, interval: float = 0.0) -> BrowserArticleAttempt:
        return BrowserArticleAttempt(
            attempt_key=key,
            rate_limit_group=group,
            session_key=group,
            policy=BrowserGroupPolicy(
                rate_limit_group=group,
                policy_revision="fixture-cba67-v1",
                minimum_start_interval=interval,
                rate_limit_cooldown=30.0,
                runtime_failure_threshold=2,
            ),
        )

    def test_groups_overlap_lanes_are_paced_and_one_runtime_drives_agent_flows(self) -> None:
        acs_interval = 0.03
        scheduler_clock = _AdvancingClock()
        factory = _Factory()
        broker = BrowserSessionBroker()
        coordinator = _PermitRecorder()
        agent = _Agent()
        agent_runtime = _agent_runtime(agent)
        action_ports: dict[str, _ActionPort] = {}
        started: dict[str, list[float]] = {"acs": [], "wiley": []}
        active: dict[str, int] = {"acs": 0, "wiley": 0}
        maximum: dict[str, int] = {"acs": 0, "wiley": 0}
        lock = threading.Lock()
        both_groups_entered = threading.Event()
        group_entered = {"acs": threading.Event(), "wiley": threading.Event()}
        binding = object()
        with TemporaryDirectory(prefix="sciretriever-cba67-") as raw:

            def run(attempt: BrowserArticleAttempt) -> BrowserAttemptCompletion[str]:
                scope = AccessScope(attempt.rate_limit_group, "web")
                permit = coordinator.acquire_scope(scope, AccessPolicy(max_concurrency=1))
                lease = broker.acquire(
                    attempt.session_key,
                    factory=factory,
                    downloads_path=raw,
                    connection_binding=binding,
                    route_handler=lambda _value: None,
                    event_handlers={event: lambda _value: None for event in _EVENTS},
                    timeout=2.0,
                )
                try:
                    action_port = _ActionPort()
                    action_ports[attempt.attempt_key] = action_port
                    with lock:
                        active[attempt.rate_limit_group] += 1
                        maximum[attempt.rate_limit_group] = max(
                            maximum[attempt.rate_limit_group],
                            active[attempt.rate_limit_group],
                        )
                        started[attempt.rate_limit_group].append(scheduler_clock.now())
                        group_entered[attempt.rate_limit_group].set()
                        if all(event.is_set() for event in group_entered.values()):
                            both_groups_entered.set()
                    article = lease.context
                    if not isinstance(article, _Article):
                        self.fail("broker did not return the fixture article session")
                    controller = AgentBrowserController(
                        runtime=agent_runtime,
                        step_factory=_ControlFactory(action_port),
                    )
                    controller.run(article)
                    result = controller.result
                    if result is None:
                        self.fail("Agent Browser controller did not retain a result")
                    self.assertIsInstance(result.step, BrowserCaptured)
                    # Hold the first article in each group long enough to prove
                    # independent groups overlap in the same Browser context.
                    if attempt.attempt_key in {"acs-1", "wiley-1"}:
                        self.assertTrue(both_groups_entered.wait(2.0))
                    return BrowserAttemptCompletion(
                        attempt.attempt_key,
                        BrowserAttemptDisposition.COMPLETED,
                        BrowserGroupFeedback.SUCCESS,
                    )
                finally:
                    with lock:
                        active[attempt.rate_limit_group] -= 1
                    lease.release()
                    permit.release()

            attempts = (
                self._attempt("acs-1", "acs", interval=acs_interval),
                self._attempt("acs-2", "acs", interval=acs_interval),
                self._attempt("wiley-1", "wiley"),
            )
            scheduler = BrowserGroupScheduler(clock=scheduler_clock, max_concurrency=2)
            result = scheduler.execute(attempts, run)
            broker.close()

        self.assertEqual(tuple(item.value for item in result), ("acs-1", "acs-2", "wiley-1"))
        self.assertEqual(maximum, {"acs": 1, "wiley": 1})
        self.assertGreaterEqual(started["acs"][1] - started["acs"][0], acs_interval)
        self.assertEqual(len(factory.runtimes), 1)
        runtime = factory.runtimes[0]
        self.assertIsNotNone(runtime.context)
        self.assertIs(runtime.profile_identity, factory.profile_identity)
        if runtime.context is None:
            self.fail("shared Browser context was not created")
        self.assertIs(runtime.context.profile_identity, factory.profile_identity)
        self.assertTrue(runtime.context.articles)
        self.assertTrue(
            all(article.context is runtime.context for article in runtime.context.articles)
        )
        self.assertEqual(runtime.close_calls, 1)
        self.assertEqual(runtime.context.close_calls, 1)
        self.assertEqual(len(action_ports), 3)
        self.assertEqual(len(agent.calls), 3)
        self.assertCountEqual(coordinator.released_scopes, ["acs", "wiley", "acs"])
        self.assertEqual(getattr(coordinator, "_active_scope_permits"), {})
        self.assertEqual(getattr(coordinator, "_active_host_permits"), {})

    def test_capture_race_and_lane_failure_retire_shared_runtime_without_second_browser(
        self,
    ) -> None:
        factory = _Factory()
        broker = BrowserSessionBroker()
        coordinator = _PermitRecorder()
        binding = object()
        with TemporaryDirectory(prefix="sciretriever-cba67-") as raw:
            capture_port = _ActionPort(capture_race=True)
            capture_agent = _Agent(on_call=lambda _call: capture_port.mark_capture())
            capture_lease = broker.acquire(
                "acs",
                factory=factory,
                downloads_path=raw,
                connection_binding=binding,
                route_handler=lambda _value: None,
                event_handlers={event: lambda _value: None for event in _EVENTS},
                timeout=2.0,
            )
            try:
                article = capture_lease.context
                if not isinstance(article, _Article):
                    self.fail("broker did not return the fixture article session")
                controller = AgentBrowserController(
                    runtime=_agent_runtime(capture_agent),
                    step_factory=_ControlFactory(capture_port),
                )
                controller.run(article)
                capture_result = controller.result
            finally:
                capture_lease.release()
            if capture_result is None:
                self.fail("Agent Browser controller did not retain a result")
            self.assertIsInstance(capture_result.step, BrowserCaptured)
            self.assertEqual(capture_port.executed, 0)
            self.assertEqual(len(capture_agent.calls), 1)

            def fail(_attempt: BrowserArticleAttempt) -> BrowserAttemptCompletion[str]:
                scope = AccessScope("wiley", "web")
                permit = coordinator.acquire_scope(scope, AccessPolicy(max_concurrency=1))
                lease = broker.acquire(
                    "wiley",
                    factory=factory,
                    downloads_path=raw,
                    connection_binding=binding,
                    route_handler=lambda _value: None,
                    event_handlers={event: lambda _value: None for event in _EVENTS},
                    timeout=2.0,
                )
                lease.invalidate()
                try:
                    raise RuntimeError("lane-failure")
                finally:
                    lease.release()
                    permit.release()

            with self.assertRaisesRegex(RuntimeError, "lane-failure"):
                BrowserGroupScheduler(clock=_AdvancingClock(), max_concurrency=1).execute(
                    (self._attempt("wiley-failure", "wiley"),),
                    fail,
                )
            self.assertEqual(len(factory.runtimes), 1)
            runtime = factory.runtimes[0]
            self.assertIsNone(getattr(broker, "_shared"))
            self.assertEqual(runtime.close_calls, 1)
            self.assertIsNotNone(runtime.context)
            if runtime.context is None:
                self.fail("shared Browser context was not created")
            self.assertEqual(runtime.context.close_calls, 1)
            self.assertFalse(runtime.context.active_lanes)
            broker.close()

        self.assertEqual(len(factory.runtimes), 1)
        runtime = factory.runtimes[0]
        self.assertEqual(runtime.close_calls, 1)
        self.assertEqual(coordinator.released_scopes, ["wiley"])
        self.assertEqual(getattr(coordinator, "_active_scope_permits"), {})
        self.assertEqual(getattr(coordinator, "_active_host_permits"), {})

    def test_user_cancellation_releases_lane_and_permit_without_session_state(self) -> None:
        factory = _Factory()
        broker = BrowserSessionBroker()
        coordinator = _PermitRecorder()
        cancel_event = threading.Event()
        binding = object()
        calls: list[str] = []
        agent_calls: list[AgentProviderCall] = []

        def cancel_during_call(call: AgentProviderCall) -> None:
            agent_calls.append(call)
            cancel_event.set()

        with TemporaryDirectory(prefix="sciretriever-cba67-") as raw:

            def run(attempt: BrowserArticleAttempt) -> BrowserAttemptCompletion[str]:
                scope = AccessScope(attempt.rate_limit_group, "web")
                permit = coordinator.acquire_scope(scope, AccessPolicy(max_concurrency=1))
                lease = broker.acquire(
                    attempt.session_key,
                    factory=factory,
                    downloads_path=raw,
                    connection_binding=binding,
                    route_handler=lambda _value: None,
                    event_handlers={event: lambda _value: None for event in _EVENTS},
                    timeout=2.0,
                    cancel_event=cancel_event,
                )
                try:
                    action_port = _ActionPort()
                    agent = _Agent(on_call=cancel_during_call)
                    article = lease.context
                    if not isinstance(article, _Article):
                        self.fail("broker did not return the fixture article session")
                    controller = AgentBrowserController(
                        runtime=_agent_runtime(agent),
                        step_factory=_ControlFactory(action_port),
                        cancel_event=cancel_event,
                    )
                    controller.run(article)
                    result = controller.result
                    if result is None:
                        self.fail("Agent Browser controller did not retain a result")
                    calls.append(result.outcome)
                    self.assertIsInstance(result.step, BrowserCancelled)
                    self.assertEqual(action_port.executed, 0)
                    return BrowserAttemptCompletion(
                        attempt.attempt_key,
                        BrowserAttemptDisposition.FAILED,
                        BrowserGroupFeedback.NONE,
                    )
                finally:
                    lease.release()
                    permit.release()

            scheduler = BrowserGroupScheduler(clock=_AdvancingClock(), max_concurrency=1)
            with self.assertRaises(BrowserSchedulingCancelled):
                scheduler.execute(
                    (
                        self._attempt("acs-cancel", "acs"),
                        self._attempt("acs-never", "acs"),
                    ),
                    run,
                    cancel_event=cancel_event,
                )
            broker.close()

        self.assertEqual(calls, ["cancelled"])
        self.assertEqual(len(agent_calls), 1)
        self.assertFalse(hasattr(agent_calls[0], "history"))
        self.assertFalse(hasattr(agent_calls[0], "session"))
        self.assertEqual(len(factory.runtimes), 1)
        self.assertEqual(factory.runtimes[0].close_calls, 1)
        self.assertEqual(coordinator.released_scopes, ["acs"])
        self.assertEqual(getattr(coordinator, "_active_scope_permits"), {})
        self.assertEqual(getattr(coordinator, "_active_host_permits"), {})


if __name__ == "__main__":
    unittest.main()
