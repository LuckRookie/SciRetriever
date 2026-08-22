"""Offline composition checks for the Browser Agent and provider lanes.

These tests intentionally assemble the production scheduler, session broker and
``AgentBrowserController`` around small in-memory fixtures.  The fixtures expose
only the capability seams used by those components; they never start a browser,
open a socket or read a user profile.
"""

from __future__ import annotations

import threading
import unittest
from collections.abc import Callable
from tempfile import TemporaryDirectory
from unittest import mock

from sciretriever.acquisition import browser_control as browser_control_module
from sciretriever.acquisition.browser_control import (
    AgentBrowserController,
    AgentsBrowserAgentDecisionPort,
    BrowserAgentDisposition,
)
from sciretriever.agents import (
    AgentBudget,
    AgentPort,
    AgentProvenance,
    AgentRequest,
    AgentSession,
    AgentToolDecision,
    AgentUsage,
)
from sciretriever.model.primitives import sha256_digest
from sciretriever.network.admission import AccessCoordinator, AccessPolicy, AccessScope
from sciretriever.network.browser_control import (
    BrowserAgentActionCommand,
    BrowserAgentObservation,
    BrowserCaptureState,
    BrowserElement,
    BrowserElementState,
    BrowserObservationBudget,
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

    def __init__(self, *, on_call: Callable[[AgentRequest], None] | None = None) -> None:
        self.calls = 0
        self.on_call = on_call

    def complete(self, request: AgentRequest) -> AgentToolDecision:
        self.calls += 1
        if self.on_call is not None:
            self.on_call(request)
        return AgentToolDecision(
            tool_name="click_element",
            arguments='{"element_id":"e1","revision":1}',
            provenance=AgentProvenance(
                provider=self.provider_name,
                model=request.model,
                input_sha256=request.input_sha256,
                parameters_sha256=sha256_digest(b"browser-agent-fixture"),
                usage=AgentUsage(output_tokens=1, response_bytes=32),
            ),
        )


class _ActionPort:
    def __init__(self, *, capture_race: bool = False) -> None:
        self.capture_race = capture_race
        self.capture_state = BrowserCaptureState.NONE
        self.executed = 0
        self.observation = self._make_observation()

    @staticmethod
    def _make_observation() -> BrowserAgentObservation:
        return BrowserAgentObservation(
            revision=1,
            page_token="article",
            locator="https://publisher.invalid/article",
            status_code=200,
            viewport=BrowserViewport(width=1280, height=720),
            screenshot=b"fixture-image",
            screenshot_media_type="image/png",
            elements=(
                BrowserElement(
                    element_id="e1",
                    role="button",
                    name="Download PDF",
                    state=BrowserElementState.VISIBLE_ENABLED,
                ),
            ),
            capture_state=BrowserCaptureState.NONE,
            remaining_budget=BrowserObservationBudget(
                remaining_steps=2,
                remaining_seconds=10.0,
                remaining_image_bytes=1024,
                remaining_navigations=1,
            ),
        )

    def mark_capture(self) -> None:
        self.capture_state = BrowserCaptureState.AVAILABLE
        self.observation = BrowserAgentObservation(
            revision=1,
            page_token="article",
            locator="https://publisher.invalid/article",
            status_code=200,
            viewport=self.observation.viewport,
            screenshot=self.observation.screenshot,
            screenshot_media_type=self.observation.screenshot_media_type,
            elements=self.observation.elements,
            capture_state=self.capture_state,
            remaining_budget=self.observation.remaining_budget,
        )

    def observe(self) -> BrowserAgentObservation:
        return self.observation

    def execute(
        self,
        command: BrowserAgentActionCommand,
        observation: BrowserAgentObservation,
        *,
        timeout_seconds: float,
    ) -> None:
        del observation
        if timeout_seconds <= 0:
            raise AssertionError("fixture action deadline was not positive")
        self.executed += 1
        if self.capture_race:
            raise AssertionError("capture-race action must not be executed")
        if command.kind.value != "click-element":
            raise AssertionError("fixture Agent should click the PDF control")
        self.mark_capture()


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
        agents: dict[str, _Agent] = {}
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
                    agent = agents.setdefault(attempt.rate_limit_group, _Agent())
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
                    result = AgentBrowserController(
                        agent_port=agent,
                        decision_port=AgentsBrowserAgentDecisionPort(model="fixture-model"),
                        action_port=action_port,
                    ).run(attempt.attempt_key)
                    self.assertIs(result.disposition, BrowserAgentDisposition.CAPTURE_AVAILABLE)
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
        self.assertEqual(sum(agent.calls for agent in agents.values()), 3)
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
            capture_agent = _Agent(on_call=lambda _request: capture_port.mark_capture())
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
                capture_result = AgentBrowserController(
                    agent_port=capture_agent,
                    decision_port=AgentsBrowserAgentDecisionPort(model="fixture-model"),
                    action_port=capture_port,
                ).run("capture-race")
            finally:
                capture_lease.release()
            self.assertIs(capture_result.disposition, BrowserAgentDisposition.CAPTURE_AVAILABLE)
            self.assertEqual(capture_port.executed, 0)
            self.assertEqual(capture_agent.calls, 1)

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

    def test_user_cancellation_closes_agent_session_and_releases_lane_and_permit(self) -> None:
        factory = _Factory()
        broker = BrowserSessionBroker()
        coordinator = _PermitRecorder()
        cancel_event = threading.Event()
        binding = object()
        calls: list[str] = []
        sessions: list[AgentSession] = []
        real_open_session = browser_control_module.open_session

        def spy_open_session(
            port: AgentPort,
            *,
            max_turns: int = 8,
            cancel_event: threading.Event | None = None,
            budget: AgentBudget | None = None,
        ) -> AgentSession:
            session = real_open_session(
                port,
                max_turns=max_turns,
                cancel_event=cancel_event,
                budget=budget,
            )
            sessions.append(session)
            return session

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
                    agent = _Agent(on_call=lambda _request: cancel_event.set())
                    result = AgentBrowserController(
                        agent_port=agent,
                        decision_port=AgentsBrowserAgentDecisionPort(model="fixture-model"),
                        action_port=action_port,
                    ).run(attempt.attempt_key, cancel_event=cancel_event)
                    calls.append(result.disposition.value)
                    self.assertIs(result.disposition, BrowserAgentDisposition.CANCELLED)
                    return BrowserAttemptCompletion(
                        attempt.attempt_key,
                        BrowserAttemptDisposition.FAILED,
                        BrowserGroupFeedback.NONE,
                    )
                finally:
                    lease.release()
                    permit.release()

            scheduler = BrowserGroupScheduler(clock=_AdvancingClock(), max_concurrency=1)
            with mock.patch.object(
                browser_control_module,
                "open_session",
                side_effect=spy_open_session,
            ):
                with self.assertRaises(BrowserSchedulingCancelled):
                    scheduler.execute(
                        (
                            self._attempt("acs-cancel", "acs"),
                            self._attempt("acs-never", "acs"),
                        ),
                        run,
                        cancel_event=cancel_event,
                    )
            self.assertEqual(len(sessions), 1)
            session = sessions[0]
            self.assertTrue(getattr(session, "_closed"))
            self.assertEqual(getattr(session, "_history"), [])
            broker.close()

        self.assertEqual(calls, [BrowserAgentDisposition.CANCELLED.value])
        self.assertEqual(len(factory.runtimes), 1)
        self.assertEqual(factory.runtimes[0].close_calls, 1)
        self.assertEqual(coordinator.released_scopes, ["acs"])
        self.assertEqual(getattr(coordinator, "_active_scope_permits"), {})
        self.assertEqual(getattr(coordinator, "_active_host_permits"), {})


if __name__ == "__main__":
    unittest.main()
