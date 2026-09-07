from __future__ import annotations

import json
import logging
import threading
import unittest
from collections.abc import Callable
from dataclasses import replace
from typing import Any

from sciretriever.acquisition.browser_control import (
    AgentBrowserController,
    BrowserAgentResult,
    action_from_agent_tool_call,
    browser_agent_tool_declarations,
    build_browser_agent_call,
)
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
from sciretriever.agents.failures import agent_failure
from sciretriever.agents.ports import AgentProviderCall
from sciretriever.model.access import AccessFailure
from sciretriever.model.primitives import sha256_digest
from sciretriever.network.browser import BrowserPageObservation
from sciretriever.network.browser_control import (
    BROWSER_OBSERVATION_MEDIA_TYPE,
    BrowserAction,
    BrowserActionOutcome,
    BrowserActionReceipt,
    BrowserAgentStatus,
    BrowserBlocked,
    BrowserBlockedReason,
    BrowserBounds,
    BrowserCancelled,
    BrowserCancelledTransition,
    BrowserCandidateTimeoutTransition,
    BrowserCaptured,
    BrowserCapturedTransition,
    BrowserCaptureState,
    BrowserElement,
    BrowserElementState,
    BrowserFailed,
    BrowserFailedTransition,
    BrowserObservation,
    BrowserPageState,
    BrowserReady,
    BrowserScreenshot,
    BrowserScrollState,
    BrowserSettledTransition,
    BrowserStaleTransition,
    BrowserStepAssessment,
    BrowserStepDriver,
    BrowserStepPolicy,
    BrowserStepSession,
    BrowserStoppedTransition,
    BrowserSurface,
    BrowserSurfaceKind,
    BrowserTransition,
    BrowserViewport,
    ClickElement,
    ClickPoint,
    GoBack,
    ScrollSurface,
    Stop,
    WaitForChange,
    execution_binding_fingerprint,
    stable_semantic_page_fingerprint,
)

_MODEL = "fixture-browser-model"


def _observation(
    revision: int = 1,
    *,
    path: str = "/article",
    capture: BrowserCaptureState = BrowserCaptureState.NONE,
    page_state: BrowserPageState = BrowserPageState.NORMAL,
) -> BrowserObservation:
    viewport = BrowserViewport(width=1280, height=720)
    screenshot = f"jpeg-fixture-{revision}-{path}".encode()
    return BrowserObservation(
        article_token="article",
        revision=revision,
        page_id="p00000001",
        surfaces=(
            BrowserSurface(
                surface_id="s00000001",
                page_id="p00000001",
                kind=BrowserSurfaceKind.PAGE,
                parent_surface_id=None,
                origin="https://publisher.invalid",
                path=path,
                title="Article",
                viewport=viewport,
                bounds=BrowserBounds(x=0, y=0, width=1280, height=720),
                scroll=BrowserScrollState(x=0, y=0, maximum_x=0, maximum_y=1440),
            ),
        ),
        elements=(
            BrowserElement(
                element_id="e00000001",
                surface_id="s00000001",
                role="button",
                name="Download PDF",
                state=BrowserElementState.ENABLED,
                bounds=BrowserBounds(x=20, y=20, width=180, height=40),
            ),
            BrowserElement(
                element_id="e00000002",
                surface_id="s00000001",
                role="button",
                name="Disabled",
                state=BrowserElementState.DISABLED,
                bounds=BrowserBounds(x=20, y=80, width=180, height=40),
            ),
        ),
        screenshot=BrowserScreenshot(
            screenshot_id=f"i{revision:08x}",
            article_token="article",
            page_id="p00000001",
            surface_id="s00000001",
            revision=revision,
            viewport=viewport,
            media_type=BROWSER_OBSERVATION_MEDIA_TYPE,
            sha256=sha256_digest(screenshot),
            content=screenshot,
        ),
        page_state=page_state,
        agent_status=BrowserAgentStatus.RUNNING,
        capture_state=capture,
    )


def _identity(observation: BrowserObservation) -> dict[str, object]:
    return {
        "article_token": observation.article_token,
        "page_id": observation.page_id,
        "revision": observation.revision,
    }


def _decision(
    tool_name: str,
    extra: dict[str, object] | None = None,
) -> Callable[[AgentProviderCall], tuple[str, dict[str, object]]]:
    def build(call: AgentProviderCall) -> tuple[str, dict[str, object]]:
        summary = json.loads(call.text_parts[1].text)
        arguments: dict[str, object] = {
            "article_token": summary["article_token"],
            "page_id": summary["page_id"],
            "revision": summary["revision"],
        }
        if extra is not None:
            arguments.update(extra)
        return tool_name, arguments

    return build


class _SequenceProvider:
    provider_name = "fixture-agent"

    def __init__(
        self,
        decisions: list[Callable[[AgentProviderCall], tuple[str, dict[str, object]]]],
        *,
        on_call: Callable[[int, AgentProviderCall], None] | None = None,
    ) -> None:
        self.decisions = decisions
        self.on_call = on_call
        self.calls: list[AgentProviderCall] = []

    def execute(self, call: AgentProviderCall) -> AgentToolCall:
        self.calls.append(call)
        index = len(self.calls) - 1
        if self.on_call is not None:
            self.on_call(index, call)
        tool_name, arguments = self.decisions[min(index, len(self.decisions) - 1)](call)
        encoded = json.dumps(arguments, sort_keys=True, separators=(",", ":"))
        return AgentToolCall(
            tool_name=tool_name,
            arguments=encoded,
            provenance=AgentProvenance(
                provider=self.provider_name,
                model=call.model,
                input_sha256=call.input_sha256,
                parameters_sha256=sha256_digest(b"fixture-browser-parameters"),
                usage=AgentUsage(output_tokens=1, response_bytes=len(encoded)),
            ),
        )


class _FailingProvider(_SequenceProvider):
    def execute(self, call: AgentProviderCall) -> AgentToolCall:
        self.calls.append(call)
        raise agent_failure("quota")


def _runtime(provider: _SequenceProvider) -> AgentRuntime:
    return AgentRuntime(
        adapter=provider,
        browser=AgentRoleBinding(
            role=AgentRole.BROWSER,
            model=_MODEL,
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


class _Control:
    def __init__(
        self,
        observation: BrowserObservation,
        *,
        results: list[BrowserObservation] | None = None,
        settle_results: list[BrowserObservation] | None = None,
    ) -> None:
        self.current = observation
        self.results = [] if results is None else list(results)
        self.settle_results = [] if settle_results is None else list(settle_results)
        self.executed: list[tuple[BrowserAction, BrowserObservation, float]] = []
        self.observe_count = 0
        self.settle_count = 0

    def observe(self) -> BrowserObservation:
        self.observe_count += 1
        return self.current

    def begin(
        self,
        *,
        page_state: BrowserPageState,
        timeout_seconds: float,
    ) -> BrowserTransition:
        del page_state
        observation = self.observe()
        return self.settle(observation, timeout_seconds=timeout_seconds)

    def execute(
        self,
        action: BrowserAction,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserTransition:
        if not 0 < timeout_seconds <= 10:
            raise AssertionError("single Browser action timeout is not bounded")
        self.executed.append((action, observation, timeout_seconds))
        before = stable_semantic_page_fingerprint(observation)
        if isinstance(action, Stop):
            self.current = replace(
                observation,
                agent_status=BrowserAgentStatus.STOPPED,
            )
        elif self.results:
            self.current = self.results.pop(0)
        after = stable_semantic_page_fingerprint(self.current)
        receipt = BrowserActionReceipt(
            action_kind=action.kind,
            outcome=(
                BrowserActionOutcome.NO_CHANGE
                if before == after and not isinstance(action, Stop)
                else BrowserActionOutcome.APPLIED
            ),
            article_token=observation.article_token,
            page_id=action.page_id,
            surface_id=action.surface_id,
            before_revision=observation.revision,
            after_revision=self.current.revision,
            elapsed_milliseconds=1,
        )
        self.current = replace(self.current, last_receipt=receipt)
        if isinstance(action, Stop):
            return BrowserStoppedTransition(receipt, self.current)
        if self.current.capture_state is BrowserCaptureState.CAPTURED:
            return BrowserCapturedTransition(self.current, receipt)
        if self.current.capture_state is BrowserCaptureState.CANDIDATE:
            return BrowserCandidateTimeoutTransition(self.current, receipt)
        return BrowserSettledTransition(
            observation=self.current,
            changed=before != after,
            receipt=receipt,
        )

    def settle(
        self,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserTransition:
        if not 0 < timeout_seconds <= 10:
            raise AssertionError("single Browser settle timeout is not bounded")
        self.settle_count += 1
        if self.settle_results:
            self.current = self.settle_results.pop(0)
        elif self.current.capture_state is BrowserCaptureState.CANDIDATE and self.results:
            self.current = self.results.pop(0)
        if self.current.capture_state is BrowserCaptureState.CAPTURED:
            return BrowserCapturedTransition(self.current)
        if self.current.capture_state is BrowserCaptureState.CANDIDATE:
            return BrowserCandidateTimeoutTransition(self.current)
        return BrowserSettledTransition(
            observation=self.current,
            changed=stable_semantic_page_fingerprint(self.current)
            != stable_semantic_page_fingerprint(observation),
        )


class _FailingControl(_Control):
    def execute(
        self,
        action: BrowserAction,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserTransition:
        del action, timeout_seconds
        raise RuntimeError("network-policy-sentinel")


class _SingleObservationControl(_Control):
    def observe(self) -> BrowserObservation:
        if self.observe_count:
            raise RuntimeError("the controller re-observed outside the settle gate")
        return super().observe()


class _FailAfterFirstActionControl(_Control):
    def execute(
        self,
        action: BrowserAction,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserTransition:
        if self.executed:
            raise RuntimeError("second-action-sentinel")
        return super().execute(
            action,
            observation,
            timeout_seconds=timeout_seconds,
        )


class _TypedFailingControl(_Control):
    def execute(
        self,
        action: BrowserAction,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserTransition:
        del action, timeout_seconds
        return BrowserFailedTransition(
            failure=AccessFailure(
                code="acquisition-browser-agent-action-rejected",
                reason="The selected action no longer matched the controlled page.",
                action="Retry with a fresh Browser observation.",
                retryable=False,
            ),
            observation=observation,
        )


class _NeverReadyControl(_Control):
    def settle(
        self,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserTransition:
        if not 0 < timeout_seconds <= 10:
            raise AssertionError("single Browser settle timeout is not bounded")
        self.settle_count += 1
        return BrowserStaleTransition(observation)


class _InitialTransitionControl(_Control):
    def __init__(
        self,
        observation: BrowserObservation,
        transition: BrowserTransition,
    ) -> None:
        super().__init__(observation)
        self.transition = transition

    def begin(
        self,
        *,
        page_state: BrowserPageState,
        timeout_seconds: float,
    ) -> BrowserTransition:
        del page_state, timeout_seconds
        return self.transition


class _PassThroughStepPolicy:
    def assess(self, observation: BrowserObservation) -> BrowserStepAssessment:
        return BrowserStepAssessment(
            page_state=observation.page_state,
            matches_observation=True,
        )


class _ChallengeStepPolicy:
    def assess(self, observation: BrowserObservation) -> BrowserStepAssessment:
        del observation
        return BrowserStepAssessment(
            page_state=BrowserPageState.CHALLENGE,
            matches_observation=True,
        )


class _ControlFactory:
    def __init__(self, control: _Control) -> None:
        self.control = control
        self.opened = 0

    def open(
        self,
        session: object,
        *,
        timeout_seconds: float,
    ) -> BrowserStepSession:
        del session
        self.opened += 1
        return BrowserStepSession(
            driver=self.control,
            policy=_PassThroughStepPolicy(),
            timeout_seconds=timeout_seconds,
        )


class _Session:
    def __init__(self, control: BrowserStepDriver | None = None) -> None:
        self.control = control
        self.clicks: list[str] = []

    def click(self, selector: str) -> bool:
        self.clicks.append(selector)
        return True

    def open_viewer(self, locator: str) -> None:
        del locator

    def open_verified_locator(self, locator: str) -> None:
        del locator

    def discover_pdf_locators(self) -> tuple[str, ...]:
        return ()

    def capture_available(self, kind: object) -> bool:
        del kind
        return False

    def wait_for_capture(self, kind: object) -> None:
        del kind

    def wait_for_any_capture(self, kinds: tuple[object, ...]) -> None:
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
        if self.control is None:
            raise AssertionError("control session was not configured")
        return BrowserStepSession(
            driver=self.control,
            policy=policy,
            timeout_seconds=timeout_seconds,
        )


def _controller(
    provider: _SequenceProvider,
    control: _Control,
    *,
    cancel_event: threading.Event | None = None,
) -> tuple[AgentBrowserController, _ControlFactory]:
    factory = _ControlFactory(control)
    return (
        AgentBrowserController(
            runtime=_runtime(provider),
            step_factory=factory,
            cancel_event=cancel_event,
        ),
        factory,
    )


def _tool_call(
    tool_name: str,
    arguments: dict[str, object],
    observation: BrowserObservation,
) -> AgentToolCall:
    return AgentToolCall(
        tool_name=tool_name,
        arguments=json.dumps(arguments, sort_keys=True, separators=(",", ":")),
        provenance=AgentProvenance(
            provider="fixture-agent",
            model=_MODEL,
            input_sha256=execution_binding_fingerprint(observation),
            parameters_sha256=sha256_digest(b"fixture-browser-parameters"),
        ),
    )


class BrowserAgentCallTests(unittest.TestCase):
    def test_call_is_one_stateless_role_bound_observation_with_six_tools(self) -> None:
        observation = _observation(page_state=BrowserPageState.CHALLENGE)
        call = build_browser_agent_call(observation)
        self.assertEqual(call.role, AgentRole.BROWSER)
        self.assertNotEqual(call.input_sha256, execution_binding_fingerprint(observation))
        self.assertEqual(len(call.text_parts), 2)
        self.assertEqual(len(call.image_parts), 1)
        self.assertEqual(
            tuple(tool.name for tool in call.tools),
            (
                "click_element",
                "click_point",
                "scroll_surface",
                "go_back",
                "wait_for_change",
                "stop",
            ),
        )
        self.assertIn("visible access challenge as an ordinary page", call.system_text)
        self.assertNotIn(observation.page_id, call.system_text)
        summary = json.loads(call.text_parts[1].text)
        self.assertEqual(summary["page_state"], "challenge")
        self.assertEqual(summary["article_token"], observation.article_token)
        self.assertEqual(call.max_output_tokens, 131_072)
        self.assertNotIn("?", call.text_parts[1].text)
        self.assertFalse(hasattr(call, "history"))
        self.assertFalse(hasattr(call, "turn"))
        self.assertFalse(hasattr(call, "session"))
        self.assertFalse(hasattr(call, "budget"))

        schemas = {tool.name: json.loads(tool.input_schema) for tool in call.tools}
        for schema in schemas.values():
            properties = schema["properties"]
            self.assertEqual(properties["article_token"]["const"], observation.article_token)
            self.assertEqual(properties["page_id"]["const"], observation.page_id)
            self.assertEqual(properties["revision"]["const"], observation.revision)
        self.assertEqual(
            schemas["click_point"]["properties"]["screenshot_id"]["const"],
            observation.screenshot.screenshot_id,
        )
        self.assertEqual(
            schemas["stop"]["properties"]["reason"]["enum"],
            [
                "normal-miss",
                "not-actionable",
                "challenge-unresolved",
                "login-required",
                "mfa-required",
                "not-entitled",
                "access-denied",
                "not-found",
            ],
        )

    def test_no_progress_is_not_an_agent_selectable_stop_reason(self) -> None:
        observation = _observation()
        with self.assertRaisesRegex(ValueError, "stop reason is not declared"):
            action_from_agent_tool_call(
                _tool_call(
                    "stop",
                    {**_identity(observation), "reason": "no-progress"},
                    observation,
                ),
                observation,
            )

    def test_tool_parser_supports_only_the_six_observation_bound_actions(self) -> None:
        observation = _observation()
        base = _identity(observation)
        values = (
            (
                "click_element",
                {**base, "surface_id": "s00000001", "element_id": "e00000001"},
                ClickElement("article", "p00000001", "s00000001", 1, "e00000001"),
            ),
            (
                "click_point",
                {
                    **base,
                    "surface_id": "s00000001",
                    "screenshot_id": "i00000001",
                    "x": 50,
                    "y": 50,
                },
                ClickPoint("article", "p00000001", "s00000001", 1, "i00000001", 50, 50),
            ),
            (
                "scroll_surface",
                {**base, "surface_id": "s00000001", "delta_y": 300},
                ScrollSurface("article", "p00000001", "s00000001", 1, 300),
            ),
            ("go_back", base, GoBack("article", "p00000001", 1)),
            ("wait_for_change", base, WaitForChange("article", "p00000001", 1)),
            (
                "stop",
                {**base, "reason": "normal-miss"},
                Stop("article", "p00000001", 1, "normal-miss"),
            ),
        )
        for tool_name, arguments, expected in values:
            with self.subTest(tool_name=tool_name):
                self.assertEqual(
                    action_from_agent_tool_call(
                        _tool_call(tool_name, arguments, observation),
                        observation,
                    ),
                    expected,
                )

        for reason in (
            "challenge-unresolved",
            "login-required",
            "mfa-required",
            "not-entitled",
            "access-denied",
            "not-found",
        ):
            with self.subTest(stop_reason=reason):
                self.assertEqual(
                    action_from_agent_tool_call(
                        _tool_call("stop", {**base, "reason": reason}, observation),
                        observation,
                    ),
                    Stop("article", "p00000001", 1, reason),
                )

        rejected = (
            ("navigate", {**base, "url": "https://evil.invalid"}),
            (
                "click_element",
                {**base, "surface_id": "s00000001", "element_id": "e00000002"},
            ),
            (
                "click_point",
                {
                    **base,
                    "surface_id": "s00000001",
                    "screenshot_id": "i00000001",
                    "x": 2000,
                    "y": 50,
                },
            ),
            (
                "scroll_surface",
                {**base, "surface_id": "s00000001", "delta_y": 100_000},
            ),
            ("stop", {**base, "reason": "login"}),
            ("go_back", {**base, "url": "https://evil.invalid"}),
        )
        for tool_name, arguments in rejected:
            with self.subTest(rejected=tool_name):
                with self.assertRaises((TypeError, ValueError)):
                    action_from_agent_tool_call(
                        _tool_call(tool_name, arguments, observation),
                        observation,
                    )

    def test_tool_declarations_never_expose_open_browser_capabilities(self) -> None:
        encoded = "\n".join(
            declaration.input_schema
            for declaration in browser_agent_tool_declarations(_observation())
        )
        for forbidden in (
            '"url"',
            '"selector"',
            '"javascript"',
            '"text"',
            '"file"',
            '"cookie"',
            '"profile"',
            '"cdp"',
        ):
            self.assertNotIn(forbidden, encoded.casefold())


class BrowserStepSessionContractTests(unittest.TestCase):
    def test_only_ready_can_continue_and_each_action_dispatches_at_most_once(self) -> None:
        observation = _observation()
        control = _Control(observation)
        steps = BrowserStepSession(
            driver=control,
            policy=_PassThroughStepPolicy(),
            timeout_seconds=10.0,
        )
        action = Stop(
            observation.article_token,
            observation.page_id,
            observation.revision,
            "normal-miss",
        )

        with self.assertRaisesRegex(RuntimeError, "start.*before apply"):
            steps.apply(action)
        self.assertIsInstance(steps.start(), BrowserReady)
        with self.assertRaisesRegex(RuntimeError, "single-use"):
            steps.start()
        terminal = steps.apply(action)
        self.assertIsInstance(terminal, BrowserBlocked)
        assert isinstance(terminal, BrowserBlocked)
        self.assertIs(terminal.reason, BrowserBlockedReason.STOPPED)
        self.assertEqual(len(control.executed), 1)
        with self.assertRaisesRegex(RuntimeError, "terminal"):
            steps.apply(action)
        self.assertEqual(len(control.executed), 1)

    def test_initial_capture_candidate_is_hidden_from_agent_until_it_completes(self) -> None:
        cases = (
            (
                _observation(capture=BrowserCaptureState.CAPTURED),
                BrowserCaptured,
                None,
            ),
            (
                _observation(capture=BrowserCaptureState.CANDIDATE),
                BrowserReady,
                None,
            ),
            (
                _observation(page_state=BrowserPageState.NOT_FOUND),
                BrowserReady,
                None,
            ),
        )
        for observation, expected_type, expected_reason in cases:
            with self.subTest(capture=observation.capture_state, state=observation.page_state):
                steps = BrowserStepSession(
                    driver=_Control(observation),
                    policy=_PassThroughStepPolicy(),
                    timeout_seconds=10.0,
                )
                result = steps.start()
                self.assertIsInstance(result, expected_type)
                if isinstance(result, BrowserBlocked):
                    self.assertIs(result.reason, expected_reason)

    def test_bound_page_classification_does_not_require_another_settle_cycle(self) -> None:
        observation = _observation()
        control = _Control(observation)
        steps = BrowserStepSession(
            driver=control,
            policy=_ChallengeStepPolicy(),
            timeout_seconds=0.01,
        )

        result = steps.start()

        self.assertIsInstance(result, BrowserReady)
        assert isinstance(result, BrowserReady)
        self.assertIs(result.observation.page_state, BrowserPageState.CHALLENGE)
        self.assertEqual(control.settle_count, 1)

    def test_initial_runtime_failure_and_cancellation_keep_distinct_terminals(self) -> None:
        observation = _observation()
        failure = AccessFailure(
            code="fixture-runtime",
            reason="The fixture runtime failed.",
            action="Repair the fixture runtime.",
            retryable=True,
        )
        cases = (
            (BrowserFailedTransition(failure, observation), BrowserFailed),
            (BrowserCancelledTransition(observation), BrowserCancelled),
        )
        for transition, expected_type in cases:
            with self.subTest(expected=expected_type.__name__):
                result = BrowserStepSession(
                    driver=_InitialTransitionControl(observation, transition),
                    policy=_PassThroughStepPolicy(),
                    timeout_seconds=10.0,
                ).start()
                self.assertIsInstance(result, expected_type)
                if isinstance(result, BrowserFailed):
                    self.assertEqual(result.failure, failure)


class BrowserAgentControllerTests(unittest.TestCase):
    def test_result_retains_one_terminal_browser_step(self) -> None:
        invalid_step: Any = BrowserReady(_observation())
        with self.assertRaises(TypeError):
            BrowserAgentResult(
                step=invalid_step,
                action_count=0,
            )
        captured = BrowserAgentResult(
            step=BrowserCaptured(_observation(capture=BrowserCaptureState.CAPTURED)),
            action_count=0,
        )
        self.assertIs(captured.capture_state, BrowserCaptureState.CAPTURED)
        candidate_timeout = BrowserAgentResult(
            step=BrowserBlocked(
                reason=BrowserBlockedReason.CANDIDATE_TIMEOUT,
                observation=_observation(capture=BrowserCaptureState.CANDIDATE),
            ),
            action_count=0,
        )
        self.assertIs(candidate_timeout.capture_state, BrowserCaptureState.CANDIDATE)
        self.assertIs(
            candidate_timeout.blocked_reason,
            BrowserBlockedReason.CANDIDATE_TIMEOUT,
        )

    def test_debug_logs_safe_observation_action_receipt_and_fingerprints(self) -> None:
        initial = _observation()
        captured = _observation(2, path="/article/pdf", capture=BrowserCaptureState.CAPTURED)
        provider = _SequenceProvider(
            [
                _decision(
                    "click_element",
                    {"surface_id": "s00000001", "element_id": "e00000001"},
                )
            ]
        )
        controller, _factory = _controller(provider, _Control(initial, results=[captured]))

        with self.assertLogs("sciretriever.acquisition.browser_control", level="DEBUG") as logs:
            controller.run(_Session())

        rendered = "\n".join(logs.output)
        for expected in (
            "event=browser-controller-start",
            "event=browser-agent-observation",
            "event=browser-agent-action ",
            "event=browser-agent-step",
            "event=browser-agent-result",
            "page_state=normal",
            "action=click-element",
            "outcome=captured",
            "semantic_fingerprint=",
            "intent_fingerprint=",
            "screenshot_bytes=",
        ):
            self.assertIn(expected, rendered)
        for sensitive in (
            "Download PDF",
            "Disabled",
            "Article",
            "jpeg-fixture",
            "e00000001",
            '"surface_id"',
            '"article_token"',
        ):
            self.assertNotIn(sensitive, rendered)
        info = "\n".join(
            record.getMessage() for record in logs.records if record.levelno == logging.INFO
        )
        self.assertIn("event=browser-agent-step", info)
        self.assertNotIn("revision=", info)
        self.assertNotIn("fingerprint=", info)

    def test_debug_logs_stable_agent_failure_without_tool_or_page_payload(self) -> None:
        controller, _factory = _controller(
            _FailingProvider([_decision("wait_for_change")]),
            _Control(_observation()),
        )

        with self.assertLogs("sciretriever.acquisition.browser_control", level="DEBUG") as logs:
            controller.run(_Session())

        rendered = "\n".join(logs.output)
        self.assertIn("role=browser", rendered)
        self.assertIn("provider=fixture-agent", rendered)
        self.assertIn("outcome=failed", rendered)
        self.assertIn("code=agent-quota", rendered)
        self.assertIn("retryable=true", rendered)
        self.assertIn("reason=The Agent provider throttled", rendered)
        self.assertIn("action=Retry after the shared access policy", rendered)
        self.assertTrue(all(record.levelno == logging.DEBUG for record in logs.records))
        self.assertNotIn("Download PDF", rendered)
        self.assertNotIn("wait_for_change", rendered)

    def test_first_model_input_is_first_observation_and_capture_ends_flow(self) -> None:
        initial = _observation()
        captured = _observation(2, path="/article/pdf", capture=BrowserCaptureState.CAPTURED)
        provider = _SequenceProvider(
            [_decision("click_element", {"surface_id": "s00000001", "element_id": "e00000001"})]
        )
        control = _Control(initial, results=[captured])
        controller, factory = _controller(provider, control)
        controller.run(_Session())
        result = controller.result
        assert result is not None
        self.assertIsInstance(result.step, BrowserCaptured)
        self.assertEqual(result.action_count, 1)
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(
            provider.calls[0].input_sha256,
            build_browser_agent_call(initial).input_sha256,
        )
        self.assertEqual(len(control.executed), 1)
        self.assertEqual(factory.opened, 1)

    def test_challenge_uses_the_same_call_and_click_point_action(self) -> None:
        challenge = _observation(page_state=BrowserPageState.CHALLENGE)
        captured = _observation(2, capture=BrowserCaptureState.CAPTURED)
        provider = _SequenceProvider(
            [
                _decision(
                    "click_point",
                    {
                        "surface_id": "s00000001",
                        "screenshot_id": challenge.screenshot.screenshot_id,
                        "x": 100,
                        "y": 100,
                    },
                )
            ]
        )
        control = _Control(challenge, results=[captured])
        controller, _factory = _controller(provider, control)
        controller.run(_Session())
        result = controller.result
        assert result is not None
        self.assertIsInstance(result.step, BrowserCaptured)
        self.assertIsInstance(control.executed[0][0], ClickPoint)
        summary = json.loads(provider.calls[0].text_parts[1].text)
        self.assertEqual(summary["page_state"], "challenge")

    def test_identity_pages_are_given_to_the_agent_until_it_explicitly_stops(self) -> None:
        for page_state in (BrowserPageState.LOGIN_REQUIRED, BrowserPageState.MFA_REQUIRED):
            with self.subTest(page_state=page_state):
                provider = _SequenceProvider([_decision("stop", {"reason": "normal-miss"})])
                control = _Control(_observation(page_state=page_state))
                controller, _factory = _controller(provider, control)
                controller.run(_Session())
                result = controller.result
                assert result is not None
                self.assertIsInstance(result.step, BrowserBlocked)
                self.assertIs(result.blocked_reason, BrowserBlockedReason.STOPPED)
                self.assertEqual(result.page_state, page_state)
                self.assertEqual(len(provider.calls), 1)
                self.assertEqual(len(control.executed), 1)

    def test_stop_is_a_closed_network_action_and_never_requires_page_progress(self) -> None:
        provider = _SequenceProvider([_decision("stop", {"reason": "not-actionable"})])
        control = _Control(_observation())
        controller, _factory = _controller(provider, control)
        controller.run(_Session())
        result = controller.result
        assert result is not None
        self.assertIs(result.blocked_reason, BrowserBlockedReason.STOPPED)
        self.assertEqual(result.action_count, 1)
        self.assertIsInstance(control.executed[0][0], Stop)

    def test_capture_race_wins_and_late_action_never_reaches_network(self) -> None:
        control = _Control(_observation())

        def capture_during_call(index: int, call: AgentProviderCall) -> None:
            del index, call
            control.current = _observation(capture=BrowserCaptureState.CAPTURED)

        provider = _SequenceProvider(
            [_decision("click_element", {"surface_id": "s00000001", "element_id": "e00000001"})],
            on_call=capture_during_call,
        )
        controller, _factory = _controller(provider, control)
        controller.run(_Session())
        result = controller.result
        assert result is not None
        self.assertIsInstance(result.step, BrowserCaptured)
        self.assertEqual(control.executed, [])

    def test_page_change_during_model_call_gets_a_fresh_stateless_decision(self) -> None:
        control = _Control(
            _observation(),
            results=[_observation(3, path="/article/pdf", capture=BrowserCaptureState.CAPTURED)],
        )

        def mutate_first_call(index: int, call: AgentProviderCall) -> None:
            del call
            if index == 0:
                control.current = _observation(2, path="/article/next")

        provider = _SequenceProvider(
            [
                _decision(
                    "click_element",
                    {"surface_id": "s00000001", "element_id": "e00000001"},
                ),
                _decision("wait_for_change"),
            ],
            on_call=mutate_first_call,
        )
        controller, _factory = _controller(provider, control)
        controller.run(_Session())
        result = controller.result
        assert result is not None
        self.assertIsInstance(result.step, BrowserCaptured)
        self.assertEqual(len(provider.calls), 2)
        self.assertEqual(len(control.executed), 1)
        self.assertIsInstance(control.executed[0][0], WaitForChange)
        self.assertNotEqual(provider.calls[0].input_sha256, provider.calls[1].input_sha256)
        self.assertGreaterEqual(control.settle_count, 3)

    def test_action_transition_is_reused_without_a_second_raw_observation(self) -> None:
        control = _SingleObservationControl(_observation())
        provider = _SequenceProvider(
            [
                _decision("wait_for_change"),
                _decision("stop", {"reason": "normal-miss"}),
            ]
        )
        controller, _factory = _controller(provider, control)

        controller.run(_Session())

        result = controller.result
        assert result is not None
        self.assertIs(result.blocked_reason, BrowserBlockedReason.STOPPED)
        self.assertEqual(result.action_count, 2)
        self.assertEqual(result.model_call_count, 2)
        self.assertEqual(control.observe_count, 1)
        self.assertEqual(control.settle_count, 3)

    def test_initial_observation_settles_before_the_first_model_call(self) -> None:
        ready = _observation(2, path="/article/ready")
        provider = _SequenceProvider([_decision("stop", {"reason": "normal-miss"})])
        control = _Control(
            _observation(path="/article/loading"),
            settle_results=[ready],
        )
        controller, _factory = _controller(provider, control)

        controller.run(_Session())

        result = controller.result
        assert result is not None
        self.assertIs(result.blocked_reason, BrowserBlockedReason.STOPPED)
        self.assertEqual(control.settle_count, 2)
        self.assertEqual(len(provider.calls), 1)
        summary = json.loads(provider.calls[0].text_parts[1].text)
        self.assertEqual(summary["surfaces"][0]["path"], "/article/ready")

    def test_unchanged_observation_is_allowed_until_the_controller_budget(self) -> None:
        provider = _SequenceProvider([_decision("wait_for_change")])
        control = _Control(_observation())
        controller, _factory = _controller(provider, control)
        controller.run(_Session())
        result = controller.result
        assert result is not None
        self.assertIsInstance(result.step, BrowserFailed)
        assert result.failure is not None
        self.assertEqual(result.failure.code, "controller-safety-limit")
        self.assertEqual(result.action_count, 32)
        self.assertEqual(result.model_call_count, 32)
        self.assertEqual(len(provider.calls), 32)
        self.assertEqual(len(control.executed), 32)
        feedback = json.loads(provider.calls[1].text_parts[1].text)["previous_transition"]
        self.assertEqual(feedback["settle_outcome"], "ready")
        self.assertFalse(feedback["semantic_changed"])

    def test_cycle_is_allowed_until_the_controller_budget(self) -> None:
        provider = _SequenceProvider([_decision("wait_for_change")])
        control = _Control(
            _observation(),
            results=[
                _observation(2, path="/article/step"),
                _observation(3, path="/article"),
            ],
        )
        controller, _factory = _controller(provider, control)

        controller.run(_Session())

        result = controller.result
        assert result is not None
        self.assertIsInstance(result.step, BrowserFailed)
        assert result.failure is not None
        self.assertEqual(result.failure.code, "controller-safety-limit")
        self.assertEqual(result.action_count, 32)
        self.assertEqual(result.model_call_count, 32)
        self.assertEqual(len(control.executed), 32)

    def test_initial_candidate_waits_for_capture_or_allows_agent_exploration(self) -> None:
        provider = _SequenceProvider([_decision("wait_for_change")])
        captured_control = _Control(
            _observation(capture=BrowserCaptureState.CANDIDATE),
            results=[_observation(2, capture=BrowserCaptureState.CAPTURED)],
        )
        controller, _factory = _controller(provider, captured_control)
        controller.run(_Session())
        captured = controller.result
        assert captured is not None
        self.assertIsInstance(captured.step, BrowserCaptured)
        self.assertEqual(captured.model_call_count, 0)

        timeout_control = _Control(_observation(capture=BrowserCaptureState.CANDIDATE))
        controller, _factory = _controller(provider, timeout_control)
        controller.run(_Session())
        timed_out = controller.result
        assert timed_out is not None
        self.assertIsInstance(timed_out.step, BrowserFailed)
        assert timed_out.failure is not None
        self.assertEqual(timed_out.failure.code, "controller-safety-limit")
        self.assertEqual(timed_out.model_call_count, 32)

    def test_unique_click_points_end_at_the_non_business_controller_safety_limit(
        self,
    ) -> None:
        decision_index = 0

        def unique_point(call: AgentProviderCall) -> tuple[str, dict[str, object]]:
            nonlocal decision_index
            summary = json.loads(call.text_parts[1].text)
            arguments = {
                "article_token": summary["article_token"],
                "page_id": summary["page_id"],
                "revision": summary["revision"],
                "surface_id": "s00000001",
                "screenshot_id": summary["screenshot_id"],
                "x": 20 + decision_index * 40,
                "y": 200,
            }
            decision_index += 1
            return "click_point", arguments

        provider = _SequenceProvider([unique_point])
        control = _Control(_observation())
        controller, _factory = _controller(provider, control)

        controller.run(_Session())

        result = controller.result
        assert result is not None
        self.assertIsInstance(result.step, BrowserFailed)
        assert result.failure is not None
        self.assertEqual(result.failure.code, "controller-safety-limit")
        self.assertEqual(result.model_call_count, 32)
        self.assertEqual(result.action_count, 32)

    def test_repeated_action_kind_continues_while_semantic_page_changes(self) -> None:
        provider = _SequenceProvider([_decision("wait_for_change"), _decision("wait_for_change")])
        control = _Control(
            _observation(),
            results=[
                _observation(2, path="/article/step"),
                _observation(3, path="/article/pdf", capture=BrowserCaptureState.CAPTURED),
            ],
        )
        controller, _factory = _controller(provider, control)
        controller.run(_Session())
        result = controller.result
        assert result is not None
        self.assertIsInstance(result.step, BrowserCaptured)
        self.assertEqual(result.action_count, 2)
        self.assertEqual(len(provider.calls), 2)
        self.assertEqual(len(control.executed), 2)

    def test_user_cancellation_and_agent_failure_are_natural_terminals(self) -> None:
        cancel_event = threading.Event()
        cancel_event.set()
        provider = _SequenceProvider([_decision("wait_for_change")])
        control = _Control(_observation())
        controller, factory = _controller(provider, control, cancel_event=cancel_event)
        controller.run(_Session())
        result = controller.result
        assert result is not None
        self.assertIsInstance(result.step, BrowserCancelled)
        self.assertEqual(provider.calls, [])
        self.assertEqual(control.observe_count, 0)
        self.assertEqual(factory.opened, 1)

        failing = _FailingProvider([_decision("wait_for_change")])
        controller, _factory = _controller(failing, _Control(_observation()))
        controller.run(_Session())
        result = controller.result
        assert result is not None
        self.assertIsInstance(result.step, BrowserFailed)
        assert result.failure is not None
        self.assertEqual(result.failure.code, "agent-quota")

    def test_transient_model_failure_retries_the_same_observation(self) -> None:
        def fail_first_call(index: int, _call: AgentProviderCall) -> None:
            if index == 0:
                raise agent_failure("remote-service")

        provider = _SequenceProvider(
            [_decision("stop", {"reason": "normal-miss"})],
            on_call=fail_first_call,
        )
        controller, _factory = _controller(provider, _Control(_observation()))

        controller.run(_Session())

        result = controller.result
        assert result is not None
        self.assertIsInstance(result.step, BrowserBlocked)
        self.assertEqual(result.model_call_count, 2)
        self.assertEqual(len(provider.calls), 2)
        self.assertEqual(provider.calls[0].input_sha256, provider.calls[1].input_sha256)

    def test_unexpected_control_exception_becomes_nonretryable_internal_failure(self) -> None:
        provider = _SequenceProvider([_decision("wait_for_change")])
        controller, _factory = _controller(provider, _FailingControl(_observation()))
        controller.run(_Session())
        result = controller.result
        assert result is not None and result.failure is not None
        self.assertIsInstance(result.step, BrowserFailed)
        self.assertEqual(result.failure.code, "browser-agent-internal")
        self.assertFalse(result.failure.retryable)
        self.assertNotIn("network-policy-sentinel", repr(result.failure))

    def test_repeated_identical_readiness_stale_is_a_bounded_retryable_failure(self) -> None:
        provider = _SequenceProvider([_decision("wait_for_change")])
        control = _NeverReadyControl(_observation())
        controller, _factory = _controller(provider, control)

        controller.run(_Session())

        result = controller.result
        assert result is not None and result.failure is not None
        self.assertIsInstance(result.step, BrowserFailed)
        self.assertEqual(
            result.failure.code,
            "acquisition-browser-readiness-timeout",
        )
        self.assertTrue(result.failure.retryable)
        self.assertEqual(result.action_count, 0)
        self.assertEqual(result.model_call_count, 0)
        self.assertEqual(control.settle_count, 2)
        self.assertEqual(provider.calls, [])

    def test_internal_failure_retains_completed_action_and_model_call_counts(self) -> None:
        provider = _SequenceProvider(
            [
                _decision("wait_for_change"),
                _decision("stop", {"reason": "normal-miss"}),
            ]
        )
        control = _FailAfterFirstActionControl(_observation())
        controller, _factory = _controller(provider, control)

        controller.run(_Session())

        result = controller.result
        assert result is not None and result.failure is not None
        self.assertIsInstance(result.step, BrowserFailed)
        self.assertEqual(result.failure.code, "browser-agent-internal")
        self.assertEqual(result.action_count, 1)
        self.assertEqual(result.model_call_count, 2)
        self.assertIsInstance(result.last_action, WaitForChange)

    def test_typed_network_failure_propagates_without_becoming_an_agent_miss(self) -> None:
        provider = _SequenceProvider([_decision("wait_for_change")])
        controller, _factory = _controller(provider, _TypedFailingControl(_observation()))
        controller.run(_Session())
        result = controller.result
        assert result is not None and result.failure is not None
        self.assertIsInstance(result.step, BrowserFailed)
        self.assertEqual(
            result.failure.code,
            "acquisition-browser-agent-action-rejected",
        )
        self.assertFalse(result.failure.retryable)


if __name__ == "__main__":
    unittest.main()
