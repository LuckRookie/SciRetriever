from __future__ import annotations

import json
import threading
import time
import unittest
from dataclasses import replace

from sciretriever.acquisition.browser_control import (
    AgentBrowserController,
    AgentsBrowserAgentDecisionPort,
    BrowserAction,
    BrowserAgentDecisionRequest,
    BrowserAgentDisposition,
    BrowserAgentLoopBudget,
    BrowserAgentRequestContext,
    ClickElement,
    RuleBrowserController,
    ScrollPage,
    StopFlow,
    WaitForPage,
    action_from_tool_decision,
    build_browser_agent_request,
)
from sciretriever.agents import (
    AgentFailure,
    AgentProvenance,
    AgentRequest,
    AgentResult,
    AgentToolDecision,
    AgentUsage,
    open_session,
)
from sciretriever.agents.providers.anthropic import AnthropicMessagesAdapter
from sciretriever.agents.providers.openai_chat import OpenAIChatCompletionsAdapter
from sciretriever.agents.providers.openai_responses import OpenAIResponsesAdapter
from sciretriever.network.admission import AccessCoordinator
from sciretriever.network.browser import BrowserPageObservation
from sciretriever.network.browser_control import (
    BrowserAgentActionCommand,
    BrowserAgentActionPort,
    BrowserAgentObservation,
    BrowserCaptureState,
    BrowserElement,
    BrowserElementState,
    BrowserObservationBudget,
    BrowserObservationLedger,
    BrowserViewport,
    observation_hash,
)
from sciretriever.network.http import HttpClient


def _observation(
    revision: int = 1,
    *,
    capture: BrowserCaptureState = BrowserCaptureState.NONE,
    page_token: str = "article",
) -> BrowserAgentObservation:
    return BrowserAgentObservation(
        revision=revision,
        page_token=page_token,
        locator="https://publisher.invalid/article",
        status_code=200,
        viewport=BrowserViewport(width=1280, height=720),
        screenshot=b"png-fixture",
        screenshot_media_type="image/png",
        elements=(
            BrowserElement(
                element_id="e1",
                role="button",
                name="Download PDF",
                state=BrowserElementState.VISIBLE_ENABLED,
            ),
            BrowserElement(
                element_id="e2",
                role="button",
                name="Disabled",
                state=BrowserElementState.VISIBLE_DISABLED,
            ),
        ),
        capture_state=capture,
        remaining_budget=BrowserObservationBudget(
            remaining_steps=8,
            remaining_seconds=30.0,
            remaining_image_bytes=2_000_000,
            remaining_navigations=3,
        ),
    )


class _FakeAgentPort:
    provider_name = "fixture-agent"

    def complete(self, request: AgentRequest) -> AgentResult:
        raise AssertionError("decision fake should not call a provider directly")


class _NoopResolver:
    """Typed resolver seam for adapter body tests; it never performs DNS."""

    def resolve(self, hostname: str) -> tuple[str, ...]:
        del hostname
        return ("127.0.0.1",)


class _ToolAgentPort:
    provider_name = "fixture-agent"

    def complete(self, request: AgentRequest) -> AgentResult:
        return AgentToolDecision(
            tool_name="click_element",
            arguments='{"revision":1,"element_id":"e1"}',
            provenance=AgentProvenance(
                provider="fixture-agent",
                model=request.model,
                input_sha256=request.input_sha256,
                parameters_sha256=observation_hash(_observation()),
                usage=AgentUsage(output_tokens=1, response_bytes=1),
            ),
        )


class _SessionPort:
    """Only used to construct a request-local session for wire fixtures."""

    provider_name = "fixture-agent"

    def complete(self, request: AgentRequest) -> AgentResult:
        raise AssertionError("wire fixture must not execute an Agent request")


class _NoopTransport:
    def send(self, *args: object, **kwargs: object) -> object:
        raise AssertionError("wire fixture must not send an HTTP request")


class _FakeActionPort:
    def __init__(self, observations: list[BrowserAgentObservation]) -> None:
        self.observations = observations
        self.executed: list[tuple[object, int]] = []

    def observe(self) -> BrowserAgentObservation:
        return self.observations[0]

    def execute(
        self,
        command: BrowserAgentActionCommand,
        observation: BrowserAgentObservation,
        *,
        timeout_seconds: float,
    ) -> None:
        self.assert_timeout(timeout_seconds)
        self.executed.append((command, observation.revision))
        if len(self.observations) > 1:
            self.observations.pop(0)

    @staticmethod
    def assert_timeout(timeout_seconds: float) -> None:
        if timeout_seconds <= 0 or timeout_seconds > 10:
            raise AssertionError("action timeout was not bounded")


class _FakeDecisionPort:
    def __init__(self, actions: list[BrowserAction]) -> None:
        self.actions = actions
        self.requests: list[BrowserAgentDecisionRequest] = []

    def decide(self, request: BrowserAgentDecisionRequest) -> BrowserAction:
        self.requests.append(request)
        return self.actions[min(len(self.requests) - 1, len(self.actions) - 1)]


class BrowserAgentObservationTests(unittest.TestCase):
    def test_observation_is_query_free_bounded_and_revision_scoped(self) -> None:
        value = _observation()
        self.assertEqual(value.origin, "https://publisher.invalid")
        self.assertEqual(value.path, "/article")
        self.assertEqual(len(value.actionable_elements), 1)
        self.assertNotIn("Download PDF", repr(value))
        with self.assertRaises(ValueError):
            _observation().with_revision(0)
        with self.assertRaises(ValueError):
            BrowserAgentObservation(
                revision=1,
                page_token="article",
                locator="https://publisher.invalid/article?token=secret",
                status_code=200,
                viewport=BrowserViewport(1, 1),
                screenshot=None,
                screenshot_media_type=None,
                elements=(),
                capture_state=BrowserCaptureState.NONE,
                remaining_budget=BrowserObservationBudget(1, 1.0, 1),
            )

    def test_ledger_invalidates_element_revision(self) -> None:
        ledger = BrowserObservationLedger()
        current = ledger.publish(_observation(revision=99))
        self.assertEqual(current.revision, 1)
        self.assertEqual(ledger.element(1, "e1").name, "Download PDF")
        ledger.publish(_observation(revision=100))
        with self.assertRaises(ValueError):
            ledger.element(1, "e1")


class BrowserAgentActionTests(unittest.TestCase):
    def test_closed_actions_and_tool_parser_reject_open_ended_values(self) -> None:
        self.assertEqual(
            action_from_tool_decision(
                "click_element",
                '{"revision":1,"element_id":"e1"}',
            ),
            ClickElement(1, "e1"),
        )
        self.assertEqual(
            action_from_tool_decision(
                "scroll_page",
                '{"revision":1,"delta_y":-200}',
            ),
            ScrollPage(1, -200),
        )
        self.assertEqual(
            action_from_tool_decision(
                "wait_for_page",
                '{"revision":1,"seconds":0.2}',
            ),
            WaitForPage(1, 0.2),
        )
        self.assertEqual(
            action_from_tool_decision(
                "stop_flow",
                '{"revision":1,"reason":"normal-miss"}',
            ),
            StopFlow(1),
        )
        for name, args in (
            ("navigate", '{"url":"https://evil.invalid"}'),
            ("click_element", '{"revision":1,"element_id":"e1","js":"alert(1)"}'),
            ("scroll_page", '{"revision":1,"delta_y":100000}'),
            ("wait_for_page", '{"revision":1,"seconds":20}'),
            ("stop_flow", '{"revision":1,"reason":"CAPTCHA"}'),
        ):
            with self.subTest(name=name):
                with self.assertRaises((TypeError, ValueError)):
                    action_from_tool_decision(name, args)


class BrowserAgentControllerTests(unittest.TestCase):
    def _controller(
        self,
        actions: list[BrowserAction],
        observations: list[BrowserAgentObservation],
        *,
        budget: BrowserAgentLoopBudget | None = None,
    ) -> tuple[AgentBrowserController, _FakeActionPort, _FakeDecisionPort]:
        action_port = _FakeActionPort(observations)
        decision_port = _FakeDecisionPort(actions)
        controller = AgentBrowserController(
            agent_port=_FakeAgentPort(),
            decision_port=decision_port,
            action_port=action_port,
            budget=budget,
        )
        return controller, action_port, decision_port

    def test_click_loop_binds_article_step_hash_and_closes_session(self) -> None:
        controller, action_port, decision_port = self._controller(
            [ClickElement(1, "e1")],
            [_observation(), _observation(2, capture=BrowserCaptureState.AVAILABLE)],
        )
        result = controller.run("article-token")
        self.assertEqual(result.disposition, BrowserAgentDisposition.CAPTURE_AVAILABLE)
        self.assertEqual(result.steps, 1)
        self.assertEqual(len(action_port.executed), 1)
        self.assertEqual(decision_port.requests[0].context.article_token, "article-token")
        self.assertEqual(decision_port.requests[0].context.step, 1)
        self.assertEqual(
            decision_port.requests[0].context.observation_hash,
            observation_hash(_observation()),
        )

    def test_disabled_controller_does_not_call_agent_or_page(self) -> None:
        action_port = _FakeActionPort([_observation()])
        decision_port = _FakeDecisionPort([StopFlow(1)])
        controller = AgentBrowserController(
            agent_port=_FakeAgentPort(),
            decision_port=decision_port,
            action_port=action_port,
            enabled=False,
        )
        result = controller.run("article-token")
        self.assertEqual(result.disposition, BrowserAgentDisposition.UNAVAILABLE)
        self.assertEqual(decision_port.requests, [])
        self.assertEqual(action_port.executed, [])

    def test_stale_observation_is_rejected_before_execute(self) -> None:
        action_port = _FakeActionPort([_observation(), _observation(2)])
        decision_port = _FakeDecisionPort([ClickElement(1, "e1")])

        class _MutatingDecision(_FakeDecisionPort):
            def decide(self, request: BrowserAgentDecisionRequest) -> BrowserAction:
                action_port.observations[0] = _observation(2)
                return super().decide(request)

        decision_port = _MutatingDecision([ClickElement(1, "e1")])
        controller = AgentBrowserController(
            agent_port=_FakeAgentPort(),
            decision_port=decision_port,
            action_port=action_port,
        )
        result = controller.run("article-token")
        self.assertEqual(result.disposition, BrowserAgentDisposition.STALE_OBSERVATION)
        self.assertEqual(action_port.executed, [])

    def test_capture_race_after_decision_never_executes_late_action(self) -> None:
        action_port = _FakeActionPort([_observation()])

        class _CaptureDecision(_FakeDecisionPort):
            def decide(self, request: BrowserAgentDecisionRequest) -> BrowserAction:
                action_port.observations[0] = _observation(
                    1,
                    capture=BrowserCaptureState.AVAILABLE,
                )
                return super().decide(request)

        decision_port = _CaptureDecision([ClickElement(1, "e1")])
        controller = AgentBrowserController(
            agent_port=_FakeAgentPort(),
            decision_port=decision_port,
            action_port=action_port,
        )
        result = controller.run("article-token")
        self.assertEqual(result.disposition, BrowserAgentDisposition.CAPTURE_AVAILABLE)
        self.assertEqual(result.capture_state, BrowserCaptureState.AVAILABLE)
        self.assertEqual(action_port.executed, [])

    def test_controller_budget_is_minimum_exposed_to_decision(self) -> None:
        controller, _, decision_port = self._controller(
            [StopFlow(1)],
            [_observation()],
            budget=BrowserAgentLoopBudget(
                max_steps=2,
                max_seconds=3.0,
                max_image_bytes=2_000_000,
            ),
        )
        result = controller.run("article-token")
        self.assertEqual(result.disposition, BrowserAgentDisposition.STOPPED)
        request = decision_port.requests[0]
        self.assertEqual(request.context.remaining_budget.remaining_steps, 2)
        self.assertLessEqual(request.context.remaining_budget.remaining_seconds, 3.0)

    def test_cumulative_image_budget_stops_before_second_agent_decision(self) -> None:
        first = _observation()
        second = _observation(2)
        screenshot_bytes = len(first.screenshot or b"")
        controller, action_port, decision_port = self._controller(
            [ClickElement(1, "e1"), ClickElement(1, "e1")],
            [first, second],
            budget=BrowserAgentLoopBudget(max_image_bytes=screenshot_bytes),
        )
        result = controller.run("article-token")
        self.assertEqual(result.disposition, BrowserAgentDisposition.BUDGET_EXHAUSTED)
        self.assertEqual(result.failure_code, "agent-image-budget")
        self.assertEqual(len(decision_port.requests), 1)
        self.assertEqual(len(action_port.executed), 1)

    def test_cancel_during_decision_prevents_follow_up_action(self) -> None:
        cancel_event = threading.Event()
        action_port = _FakeActionPort([_observation()])

        class _CancellingDecision(_FakeDecisionPort):
            def decide(self, request: BrowserAgentDecisionRequest) -> BrowserAction:
                cancel_event.set()
                return super().decide(request)

        decision_port = _CancellingDecision([ClickElement(1, "e1")])
        controller = AgentBrowserController(
            agent_port=_FakeAgentPort(),
            decision_port=decision_port,
            action_port=action_port,
        )
        result = controller.run("article-token", cancel_event=cancel_event)
        self.assertEqual(result.disposition, BrowserAgentDisposition.CANCELLED)
        self.assertEqual(result.failure_code, "agent-cancelled")
        self.assertEqual(action_port.executed, [])

    def test_late_decision_after_deadline_never_executes_action(self) -> None:
        action_port = _FakeActionPort([_observation()])

        class _LateDecision(_FakeDecisionPort):
            def decide(self, request: BrowserAgentDecisionRequest) -> BrowserAction:
                time.sleep(0.03)
                return super().decide(request)

        decision_port = _LateDecision([ClickElement(1, "e1")])
        controller = AgentBrowserController(
            agent_port=_FakeAgentPort(),
            decision_port=decision_port,
            action_port=action_port,
            budget=BrowserAgentLoopBudget(max_seconds=0.01),
        )
        result = controller.run("article-token")
        self.assertEqual(result.disposition, BrowserAgentDisposition.BUDGET_EXHAUSTED)
        self.assertEqual(result.failure_code, "agent-action-timeout")
        self.assertEqual(action_port.executed, [])

    def test_zero_network_navigation_budget_denies_agent_admission(self) -> None:
        observation = _observation()
        observation = replace(
            observation,
            remaining_budget=replace(
                observation.remaining_budget,
                remaining_steps=0,
                remaining_navigations=0,
            ),
        )
        controller, action_port, decision_port = self._controller(
            [ClickElement(1, "e1")],
            [observation],
        )
        result = controller.run("article-token")
        self.assertEqual(result.disposition, BrowserAgentDisposition.BUDGET_EXHAUSTED)
        self.assertEqual(result.failure_code, "browser-step-budget")
        self.assertEqual(decision_port.requests, [])
        self.assertEqual(action_port.executed, [])

    def test_no_progress_cancel_and_capture_are_bounded(self) -> None:
        controller, _, _ = self._controller(
            [ClickElement(1, "e1")],
            [_observation()],
            budget=BrowserAgentLoopBudget(max_steps=4, max_repeated_actions=2),
        )
        self.assertEqual(
            controller.run("article-token").disposition,
            BrowserAgentDisposition.NO_PROGRESS,
        )
        cancel = threading.Event()
        cancel.set()
        controller, _, _ = self._controller([ClickElement(1, "e1")], [_observation()])
        self.assertEqual(
            controller.run("article-token", cancel_event=cancel).disposition,
            BrowserAgentDisposition.CANCELLED,
        )

    def test_action_execution_failure_propagates_and_closes_session(self) -> None:
        class _FailingActionPort(_FakeActionPort):
            def execute(
                self,
                command: BrowserAgentActionCommand,
                observation: BrowserAgentObservation,
                *,
                timeout_seconds: float,
            ) -> None:
                self.assert_timeout(timeout_seconds)
                raise RuntimeError("network-policy-sentinel")

        action_port = _FailingActionPort([_observation()])
        decision_port = _FakeDecisionPort([ClickElement(1, "e1")])
        controller = AgentBrowserController(
            agent_port=_FakeAgentPort(),
            decision_port=decision_port,
            action_port=action_port,
        )
        with self.assertRaisesRegex(RuntimeError, "network-policy-sentinel"):
            controller.run("article-token")
        request = decision_port.requests[0]
        with self.assertRaises(AgentFailure):
            request.session.complete(build_browser_agent_request(request, model="browser-model"))

    def test_rule_controller_only_receives_capability_session(self) -> None:  # noqa: C901
        called: list[object] = []

        class _Session:
            def click(self, selector: str) -> bool:
                called.append(selector)
                return True

            def open_viewer(self, locator: str) -> None: ...

            def open_verified_locator(self, locator: str) -> None: ...

            def discover_pdf_locators(self) -> tuple[str, ...]:
                return ()

            def capture_available(self, kind: object) -> bool:
                return False

            def wait_for_capture(self, kind: object) -> None: ...

            def wait_for_any_capture(self, kinds: tuple[object, ...]) -> None: ...

            def has_selector(self, selector: str) -> bool:
                return False

            def text(self, selector: str) -> str:
                return ""

            def observe(self) -> BrowserPageObservation:
                return BrowserPageObservation("https://publisher.invalid/article", 200)

            def agent_action_port(self) -> BrowserAgentActionPort:
                raise AssertionError("rule controller must not request the Agent port")

        class _Execution:
            def run(self, session: object) -> None:
                session.click("button")  # type: ignore[attr-defined]

        RuleBrowserController(_Execution()).run(_Session())
        self.assertEqual(called, ["button"])

    def test_build_request_requires_screenshot_and_contains_only_bounded_fields(self) -> None:
        action_port = _FakeActionPort([_observation()])
        decision_port = _FakeDecisionPort([StopFlow(1)])
        controller = AgentBrowserController(
            agent_port=_FakeAgentPort(),
            decision_port=decision_port,
            action_port=action_port,
        )
        del controller
        session = open_session(_FakeAgentPort())
        request = BrowserAgentDecisionRequest(
            context=BrowserAgentRequestContext(
                "article-token",
                1,
                observation_hash(_observation()),
                _observation().remaining_budget,
            ),
            observation=_observation(),
            session=session,
        )
        built = build_browser_agent_request(request, model="browser-model")
        self.assertEqual(built.role.value, "browser")
        self.assertEqual(len(built.image_parts), 1)
        self.assertEqual(len(built.text_parts), 2)
        self.assertIn("current article's primary PDF", built.system_text)
        self.assertNotIn("article-token", built.system_text)
        self.assertNotIn("article-token", built.user_text)
        self.assertIn('"origin":"https://publisher.invalid"', built.user_text)
        self.assertNotIn("?", built.user_text)
        self.assertNotEqual(built.system_text, built.user_text)
        session.close()

    def test_agents_decision_port_uses_request_local_session_and_closed_tool(self) -> None:
        session = open_session(_ToolAgentPort())
        observation = _observation()
        request = BrowserAgentDecisionRequest(
            context=BrowserAgentRequestContext(
                "article-token",
                1,
                observation_hash(observation),
                observation.remaining_budget,
            ),
            observation=observation,
            session=session,
        )
        action = AgentsBrowserAgentDecisionPort(model="browser-model").decide(request)
        self.assertEqual(action, ClickElement(1, "e1"))
        self.assertEqual(session.turns, 1)
        session.close()

    def test_browser_request_keeps_system_and_user_parts_separate_on_all_protocol_wires(
        self,
    ) -> None:
        observation = _observation()
        article_token = "article-token-secret"
        session = open_session(_SessionPort())
        request = BrowserAgentDecisionRequest(
            context=BrowserAgentRequestContext(
                article_token,
                1,
                observation_hash(observation),
                observation.remaining_budget,
            ),
            observation=observation,
            session=session,
        )
        built = build_browser_agent_request(request, model="browser-model")
        client = HttpClient(
            resolver=_NoopResolver(),
            transport=_NoopTransport(),
            coordinator=AccessCoordinator(),
        )
        adapters = (
            OpenAIResponsesAdapter(http_client=client, api_key="wire-api-key"),
            OpenAIChatCompletionsAdapter(http_client=client, api_key="wire-api-key"),
            AnthropicMessagesAdapter(http_client=client, api_key="wire-api-key"),
        )
        try:
            for adapter in adapters:
                with self.subTest(protocol=type(adapter).__name__):
                    body = json.loads(adapter._build_request_body(built))  # type: ignore[attr-defined]
                    wire = json.dumps(body, ensure_ascii=False, sort_keys=True)
                    self.assertNotIn(article_token, wire)
                    self.assertNotIn("?", wire)
                    if isinstance(adapter, OpenAIResponsesAdapter):
                        items = body["input"]
                        self.assertEqual([item["role"] for item in items], ["developer", "user"])
                        self.assertEqual(items[0]["content"][0]["text"], built.system_text)
                        self.assertEqual(items[1]["content"][0]["text"], built.user_text)
                    elif isinstance(adapter, OpenAIChatCompletionsAdapter):
                        messages = body["messages"]
                        self.assertEqual([item["role"] for item in messages], ["developer", "user"])
                        self.assertEqual(messages[0]["content"], built.system_text)
                        self.assertEqual(messages[1]["content"][0]["text"], built.user_text)
                    else:
                        self.assertEqual(body["system"], built.system_text)
                        messages = body["messages"]
                        self.assertEqual(messages[0]["role"], "user")
                        self.assertEqual(messages[0]["content"][0]["text"], built.user_text)
        finally:
            session.close()


if __name__ == "__main__":
    unittest.main()
