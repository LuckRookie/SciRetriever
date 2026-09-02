from __future__ import annotations

import json
import logging
import threading
import unittest
from collections.abc import Callable

from sciretriever.acquisition.browser_control import (
    AgentBrowserController,
    BrowserAgentControlSession,
    BrowserAgentDisposition,
    RuleBrowserController,
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
from sciretriever.model.primitives import sha256_digest
from sciretriever.network.browser import BrowserPageObservation
from sciretriever.network.browser_control import (
    BrowserAction,
    BrowserActionOutcome,
    BrowserActionReceipt,
    BrowserAgentStatus,
    BrowserBounds,
    BrowserCaptureState,
    BrowserControlSession,
    BrowserElement,
    BrowserElementState,
    BrowserObservation,
    BrowserPageState,
    BrowserScreenshot,
    BrowserScrollState,
    BrowserSurface,
    BrowserSurfaceKind,
    BrowserViewport,
    ClickElement,
    ClickPoint,
    GoBack,
    ScrollSurface,
    Stop,
    WaitForChange,
    observation_hash,
    semantic_page_fingerprint,
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
    screenshot = f"png-fixture-{revision}-{path}".encode()
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
            media_type="image/png",
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
                context_window_tokens=32_768,
                max_output_tokens=512,
                image_input=True,
                tool_decision=True,
                supported_image_media_types=frozenset({"image/png"}),
                max_image_count=1,
                max_image_bytes=2 * 1024 * 1024,
            ),
            limits=AgentCallLimits(
                max_prompt_bytes=131_072,
                max_input_bytes=2 * 1024 * 1024,
                max_request_bytes=3 * 1024 * 1024,
                max_response_bytes=1 * 1024 * 1024,
                max_result_bytes=1 * 1024 * 1024,
                max_output_tokens=512,
                context_window_tokens=32_768,
            ),
        ),
    )


class _Control:
    def __init__(
        self,
        observation: BrowserObservation,
        *,
        results: list[BrowserObservation] | None = None,
    ) -> None:
        self.current = observation
        self.results = [] if results is None else list(results)
        self.executed: list[tuple[BrowserAction, BrowserObservation, float]] = []
        self.observe_count = 0

    def observe(self) -> BrowserObservation:
        self.observe_count += 1
        return self.current

    def execute(
        self,
        action: BrowserAction,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserActionReceipt:
        if not 0 < timeout_seconds <= 10:
            raise AssertionError("single Browser action timeout is not bounded")
        self.executed.append((action, observation, timeout_seconds))
        before = semantic_page_fingerprint(observation)
        if self.results and not isinstance(action, Stop):
            self.current = self.results.pop(0)
        after = semantic_page_fingerprint(self.current)
        outcome = (
            BrowserActionOutcome.CAPTURE
            if self.current.capture_state is not BrowserCaptureState.NONE
            else BrowserActionOutcome.NO_CHANGE
            if before == after
            else BrowserActionOutcome.APPLIED
        )
        return BrowserActionReceipt(
            action_kind=action.kind,
            outcome=outcome,
            article_token=observation.article_token,
            page_id=action.page_id,
            surface_id=action.surface_id,
            before_revision=observation.revision,
            after_revision=self.current.revision,
            elapsed_milliseconds=1,
        )


class _FailingControl(_Control):
    def execute(
        self,
        action: BrowserAction,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserActionReceipt:
        del action, observation, timeout_seconds
        raise RuntimeError("network-policy-sentinel")


class _ControlFactory:
    def __init__(self, control: BrowserAgentControlSession) -> None:
        self.control = control
        self.opened = 0

    def open(self, session: object) -> BrowserAgentControlSession:
        del session
        self.opened += 1
        return self.control


class _Session:
    def __init__(self, control: BrowserControlSession | None = None) -> None:
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

    def control_session(self) -> BrowserControlSession:
        if self.control is None:
            raise AssertionError("control session was not configured")
        return self.control


def _controller(
    provider: _SequenceProvider,
    control: BrowserAgentControlSession,
    *,
    cancel_event: threading.Event | None = None,
) -> tuple[AgentBrowserController, _ControlFactory]:
    factory = _ControlFactory(control)
    return (
        AgentBrowserController(
            runtime=_runtime(provider),
            control_factory=factory,
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
            input_sha256=observation_hash(observation),
            parameters_sha256=sha256_digest(b"fixture-browser-parameters"),
        ),
    )


class BrowserAgentCallTests(unittest.TestCase):
    def test_call_is_one_stateless_role_bound_observation_with_six_tools(self) -> None:
        observation = _observation(page_state=BrowserPageState.CHALLENGE)
        call = build_browser_agent_call(observation)
        self.assertEqual(call.role, AgentRole.BROWSER)
        self.assertEqual(call.input_sha256, observation_hash(observation))
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


class BrowserAgentControllerTests(unittest.TestCase):
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
            "event=browser-agent-action-result",
            "event=browser-agent-receipt",
            "event=browser-agent-result",
            "page_state=normal",
            "action=click-element",
            "outcome=capture-available",
            "before_fingerprint=",
            "action_fingerprint=",
            "screenshot_bytes=",
        ):
            self.assertIn(expected, rendered)
        for sensitive in (
            "Download PDF",
            "Disabled",
            "Article",
            "png-fixture",
            "e00000001",
            '"surface_id"',
            '"article_token"',
        ):
            self.assertNotIn(sensitive, rendered)

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
        self.assertEqual(result.disposition, BrowserAgentDisposition.CAPTURE_AVAILABLE)
        self.assertEqual(result.action_count, 1)
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(provider.calls[0].input_sha256, observation_hash(initial))
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
        self.assertEqual(result.disposition, BrowserAgentDisposition.CAPTURE_AVAILABLE)
        self.assertIsInstance(control.executed[0][0], ClickPoint)
        summary = json.loads(provider.calls[0].text_parts[1].text)
        self.assertEqual(summary["page_state"], "challenge")

    def test_identity_pages_stop_before_any_model_call(self) -> None:
        for page_state in (BrowserPageState.LOGIN_REQUIRED, BrowserPageState.MFA_REQUIRED):
            with self.subTest(page_state=page_state):
                provider = _SequenceProvider([_decision("stop", {"reason": "normal-miss"})])
                control = _Control(_observation(page_state=page_state))
                controller, _factory = _controller(provider, control)
                controller.run(_Session())
                result = controller.result
                assert result is not None
                self.assertEqual(result.disposition, BrowserAgentDisposition.PAGE_TERMINAL)
                self.assertEqual(provider.calls, [])
                self.assertEqual(control.executed, [])

    def test_stop_is_a_closed_network_action_and_never_requires_page_progress(self) -> None:
        provider = _SequenceProvider([_decision("stop", {"reason": "not-actionable"})])
        control = _Control(_observation())
        controller, _factory = _controller(provider, control)
        controller.run(_Session())
        result = controller.result
        assert result is not None
        self.assertEqual(result.disposition, BrowserAgentDisposition.STOPPED)
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
        self.assertEqual(result.disposition, BrowserAgentDisposition.CAPTURE_AVAILABLE)
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
        self.assertEqual(result.disposition, BrowserAgentDisposition.CAPTURE_AVAILABLE)
        self.assertEqual(len(provider.calls), 2)
        self.assertEqual(len(control.executed), 1)
        self.assertIsInstance(control.executed[0][0], WaitForChange)
        self.assertNotEqual(provider.calls[0].input_sha256, provider.calls[1].input_sha256)

    def test_proven_semantic_self_transition_stops_without_a_repeat_budget(self) -> None:
        provider = _SequenceProvider([_decision("wait_for_change")])
        control = _Control(_observation())
        controller, _factory = _controller(provider, control)
        controller.run(_Session())
        result = controller.result
        assert result is not None
        self.assertEqual(result.disposition, BrowserAgentDisposition.NO_PROGRESS)
        self.assertEqual(result.action_count, 1)
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(len(control.executed), 1)

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
        self.assertEqual(result.disposition, BrowserAgentDisposition.CAPTURE_AVAILABLE)
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
        self.assertEqual(result.disposition, BrowserAgentDisposition.CANCELLED)
        self.assertEqual(provider.calls, [])
        self.assertEqual(control.observe_count, 0)
        self.assertEqual(factory.opened, 1)

        failing = _FailingProvider([_decision("wait_for_change")])
        controller, _factory = _controller(failing, _Control(_observation()))
        controller.run(_Session())
        result = controller.result
        assert result is not None
        self.assertEqual(result.disposition, BrowserAgentDisposition.FAILED)
        assert result.failure is not None
        self.assertEqual(result.failure.code, "agent-quota")

    def test_network_failure_propagates_without_becoming_an_agent_miss(self) -> None:
        provider = _SequenceProvider([_decision("wait_for_change")])
        controller, _factory = _controller(provider, _FailingControl(_observation()))
        with self.assertRaisesRegex(RuntimeError, "network-policy-sentinel"):
            controller.run(_Session())
        self.assertIsNone(controller.result)

    def test_rule_controller_never_constructs_or_calls_an_agent_runtime(self) -> None:
        class _Execution:
            def run(self, session: object) -> None:
                clicked = session.click("button")  # type: ignore[attr-defined]
                if clicked is not True:
                    raise AssertionError("deterministic click did not run")

        session = _Session()
        RuleBrowserController(_Execution()).run(session)
        self.assertEqual(session.clicks, ["button"])


if __name__ == "__main__":
    unittest.main()
