"""Controlled Browser flow and Browser Agent controller contracts.

This module is the Acquisition-side seam between deterministic Publisher rules,
the neutral Agents runtime, and Network's capability-only Browser page port.
Controllers decide which operation may happen next; an injected action port is
the only component allowed to translate a closed action into a real Browser
operation.  No Playwright, Profile, Context, Cookie, selector, URL client, or
PDF publisher object crosses this boundary.
"""

from __future__ import annotations

import json
import math
import re
import threading
import time
from dataclasses import dataclass, field, replace
from enum import Enum, unique
from typing import Final, Protocol, cast, runtime_checkable

from sciretriever.agents import (
    AgentBudget,
    AgentCapability,
    AgentImagePart,
    AgentPort,
    AgentRequest,
    AgentRole,
    AgentSession,
    AgentTextPart,
    AgentToolDecision,
    AgentToolDeclaration,
    open_session,
    parse_strict_json_object,
)
from sciretriever.agents.failures import AgentFailure
from sciretriever.model.primitives import Sha256
from sciretriever.network.browser import BrowserFlowController, BrowserFlowSession
from sciretriever.network.browser_control import (
    BrowserAgentActionCommand,
    BrowserAgentActionKind,
    BrowserAgentActionPort,
    BrowserAgentObservation,
    BrowserCaptureState,
    BrowserObservationBudget,
    observation_hash,
)

_ARTICLE_TOKEN: Final[re.Pattern[str]] = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    re.ASCII,
)
_ELEMENT_ID: Final[re.Pattern[str]] = re.compile(r"^e[0-9a-f]{1,32}$", re.ASCII)
_MAX_REASON_BYTES: Final[int] = 128
_MAX_SCROLL_PIXELS: Final[int] = 2_000
_MIN_WAIT_SECONDS: Final[float] = 0.05
_MAX_WAIT_SECONDS: Final[float] = 10.0
_MAX_ACTION_SECONDS: Final[float] = 10.0

# This instruction is deliberately static.  The article token, locator and
# page observation are request-local user data and must never be interpolated
# into the system/developer prompt.  Keeping the goal and the safety boundary
# here also prevents a provider adapter from treating the observation JSON as
# the instruction itself.
_BROWSER_AGENT_SYSTEM_INSTRUCTION: Final[str] = (
    "Control a bounded Browser flow whose goal is to obtain the current article's "
    "primary PDF. Use only the declared closed tools on the current page and the "
    "provided observation. Never navigate to an arbitrary URL, enter credentials, "
    "log in, select an institution, handle MFA, CAPTCHA, or challenge interaction. "
    "Choose at most one safe action for this observation. If no safe action can "
    "obtain the PDF, return stop_flow; do not invent success."
)


def _article_token(value: object) -> str:
    if type(value) is not str or _ARTICLE_TOKEN.fullmatch(value.strip()) is None:
        raise ValueError("article_token must be a bounded operation-local token")
    return value.strip()


def _revision(value: object) -> int:
    if type(value) is not int or value < 1:
        raise ValueError("observation revision must be positive")
    return value


def _finite_seconds(value: object, *, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{field_name} must be numeric")
    candidate = float(value)
    if not math.isfinite(candidate) or candidate <= 0:
        raise ValueError(f"{field_name} must be finite and positive")
    return candidate


@unique
class StopFlowReason(str, Enum):
    """Why a model voluntarily ended a bounded Browser flow."""

    NORMAL_MISS = "normal-miss"
    NOT_ACTIONABLE = "not-actionable"
    NO_PROGRESS = "no-progress"


@dataclass(frozen=True, slots=True, repr=False)
class ClickElement:
    """Click one element id from the current observation revision."""

    revision: int
    element_id: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "revision", _revision(self.revision))
        if type(self.element_id) is not str or _ELEMENT_ID.fullmatch(self.element_id) is None:
            raise ValueError("element_id must be a short opaque token")

    @property
    def observation_revision(self) -> int:
        return self.revision

    def __repr__(self) -> str:
        return f"ClickElement(revision={self.revision}, element_id={self.element_id!r})"


@dataclass(frozen=True, slots=True, repr=False)
class ScrollPage:
    """Scroll a bounded amount; positive is down and negative is up."""

    revision: int
    delta_y: int

    def __post_init__(self) -> None:
        object.__setattr__(self, "revision", _revision(self.revision))
        if type(self.delta_y) is not int or isinstance(self.delta_y, bool):
            raise TypeError("delta_y must be an integer")
        if self.delta_y == 0 or abs(self.delta_y) > _MAX_SCROLL_PIXELS:
            raise ValueError("delta_y exceeds the bounded scroll range")

    @property
    def observation_revision(self) -> int:
        return self.revision


@dataclass(frozen=True, slots=True, repr=False)
class WaitForPage:
    """Wait for a bounded page update; no arbitrary polling is exposed."""

    revision: int
    seconds: float

    def __post_init__(self) -> None:
        object.__setattr__(self, "revision", _revision(self.revision))
        value = _finite_seconds(self.seconds, field_name="seconds")
        if value < _MIN_WAIT_SECONDS or value > _MAX_WAIT_SECONDS:
            raise ValueError("seconds exceeds the bounded wait range")
        object.__setattr__(self, "seconds", value)

    @property
    def observation_revision(self) -> int:
        return self.revision


@dataclass(frozen=True, slots=True, repr=False)
class StopFlow:
    """End the model fallback without attempting another Browser action."""

    revision: int
    reason: StopFlowReason = StopFlowReason.NORMAL_MISS

    def __post_init__(self) -> None:
        object.__setattr__(self, "revision", _revision(self.revision))
        if not isinstance(self.reason, StopFlowReason):
            try:
                object.__setattr__(self, "reason", StopFlowReason(self.reason))
            except (TypeError, ValueError):
                raise ValueError("stop reason is not supported") from None

    @property
    def observation_revision(self) -> int:
        return self.revision


BrowserAction = ClickElement | ScrollPage | WaitForPage | StopFlow


def browser_action_command(action: BrowserAction) -> BrowserAgentActionCommand:
    """Translate an Acquisition action into the neutral Network command."""

    if isinstance(action, ClickElement):
        return BrowserAgentActionCommand(
            kind=BrowserAgentActionKind.CLICK_ELEMENT,
            revision=action.revision,
            element_id=action.element_id,
        )
    if isinstance(action, ScrollPage):
        return BrowserAgentActionCommand(
            kind=BrowserAgentActionKind.SCROLL_PAGE,
            revision=action.revision,
            delta_y=action.delta_y,
        )
    if isinstance(action, WaitForPage):
        return BrowserAgentActionCommand(
            kind=BrowserAgentActionKind.WAIT_FOR_PAGE,
            revision=action.revision,
            seconds=action.seconds,
        )
    if isinstance(action, StopFlow):
        return BrowserAgentActionCommand(
            kind=BrowserAgentActionKind.STOP_FLOW,
            revision=action.revision,
            reason=action.reason.value,
        )
    raise TypeError("action is not a closed Browser action")


def _strict_action_arguments(arguments: str, expected: frozenset[str]) -> dict[str, object]:
    values = parse_strict_json_object(arguments)
    if frozenset(values) != expected:
        raise ValueError("Browser Agent action contains unknown or missing fields")
    return values


def action_from_tool_decision(tool_name: str, arguments: str) -> BrowserAction:
    """Convert one declared Agent tool decision to a closed Browser action."""

    if type(tool_name) is not str:
        raise TypeError("tool_name must be text")
    if tool_name == "click_element":
        values = _strict_action_arguments(arguments, frozenset({"revision", "element_id"}))
        return ClickElement(
            revision=cast(int, values["revision"]),
            element_id=cast(str, values["element_id"]),
        )
    if tool_name == "scroll_page":
        values = _strict_action_arguments(arguments, frozenset({"revision", "delta_y"}))
        return ScrollPage(
            revision=cast(int, values["revision"]),
            delta_y=cast(int, values["delta_y"]),
        )
    if tool_name == "wait_for_page":
        values = _strict_action_arguments(arguments, frozenset({"revision", "seconds"}))
        return WaitForPage(
            revision=cast(int, values["revision"]),
            seconds=cast(float, values["seconds"]),
        )
    if tool_name == "stop_flow":
        values = _strict_action_arguments(arguments, frozenset({"revision", "reason"}))
        return StopFlow(
            revision=cast(int, values["revision"]),
            reason=cast(StopFlowReason, values["reason"]),
        )
    raise ValueError("Browser Agent returned an undeclared action")


def action_from_agent_decision(decision: object) -> BrowserAction:
    """Convert a neutral ``AgentToolDecision`` without exposing its arguments."""

    from sciretriever.agents import AgentToolDecision

    if not isinstance(decision, AgentToolDecision):
        raise TypeError("decision must be an AgentToolDecision")
    return action_from_tool_decision(decision.tool_name, decision.arguments)


@dataclass(frozen=True, slots=True, repr=False)
class BrowserAgentRequestContext:
    """Request-local binding shared by every Browser Agent turn."""

    article_token: str
    step: int
    observation_hash: Sha256
    remaining_budget: BrowserObservationBudget

    def __post_init__(self) -> None:
        object.__setattr__(self, "article_token", _article_token(self.article_token))
        if type(self.step) is not int or self.step < 1:
            raise ValueError("step must be a positive integer")
        if not isinstance(self.observation_hash, Sha256):
            raise TypeError("observation_hash must be Sha256")
        if not isinstance(self.remaining_budget, BrowserObservationBudget):
            raise TypeError("remaining_budget must be BrowserObservationBudget")


@dataclass(frozen=True, slots=True, repr=False)
class BrowserAgentDecisionRequest:
    """What the model-facing port may inspect for one decision."""

    context: BrowserAgentRequestContext
    observation: BrowserAgentObservation
    session: AgentSession

    def __post_init__(self) -> None:
        if not isinstance(self.context, BrowserAgentRequestContext):
            raise TypeError("context must be BrowserAgentRequestContext")
        if not isinstance(self.observation, BrowserAgentObservation):
            raise TypeError("observation must be BrowserAgentObservation")
        if not isinstance(self.session, AgentSession):
            raise TypeError("session must be an AgentSession")
        if observation_hash(self.observation) != self.context.observation_hash:
            raise ValueError("decision request hash does not match observation")

    def __repr__(self) -> str:
        return (
            "BrowserAgentDecisionRequest("
            f"article_token={self.context.article_token!r}, step={self.context.step}, "
            f"revision={self.observation.revision})"
        )


@runtime_checkable
class BrowserAgentDecisionPort(Protocol):
    """Model-facing Port; implementations may use only neutral Agents values."""

    def decide(self, request: BrowserAgentDecisionRequest) -> BrowserAction: ...


@dataclass(frozen=True, slots=True)
class AgentsBrowserAgentDecisionPort:
    """Default neutral adapter that turns one Agents tool result into an action."""

    model: str
    budget: AgentBudget | None = None

    def __post_init__(self) -> None:
        if type(self.model) is not str or not self.model.strip():
            raise ValueError("model must be nonblank text")
        if self.budget is not None and not isinstance(self.budget, AgentBudget):
            raise TypeError("budget must be AgentBudget or None")

    def decide(self, request: BrowserAgentDecisionRequest) -> BrowserAction:
        agent_request = build_browser_agent_request(
            request,
            model=self.model,
            budget=self.budget,
        )
        result = request.session.complete(agent_request)
        if not isinstance(result, AgentToolDecision):
            raise ValueError("Browser Agent provider did not return a tool decision")
        return action_from_agent_decision(result)


@runtime_checkable
class BrowserRuleExecution(Protocol):
    """Typed deterministic rule execution owned by Acquisition."""

    def run(self, session: BrowserFlowSession) -> None: ...


@dataclass(frozen=True, slots=True, repr=False)
class RuleBrowserController:
    """Run one typed Acquisition-owned deterministic execution."""

    execution: BrowserRuleExecution

    def __post_init__(self) -> None:
        if not isinstance(self.execution, BrowserRuleExecution):
            raise TypeError("execution must implement BrowserRuleExecution")

    def run(self, session: BrowserFlowSession) -> None:
        if not isinstance(session, BrowserFlowSession):
            raise TypeError("session must implement BrowserFlowSession")
        self.execution.run(session)


@unique
class BrowserAgentDisposition(str, Enum):
    CAPTURE_AVAILABLE = "capture-available"
    STOPPED = "stopped"
    UNAVAILABLE = "unavailable"
    BUDGET_EXHAUSTED = "budget-exhausted"
    CANCELLED = "cancelled"
    STALE_OBSERVATION = "stale-observation"
    NO_PROGRESS = "no-progress"
    FAILED = "failed"


@dataclass(frozen=True, slots=True, repr=False)
class BrowserAgentLoopBudget:
    """Hard controller limits independent of model/provider settings."""

    max_steps: int = 8
    max_seconds: float = 60.0
    max_repeated_actions: int = 2
    max_output_tokens: int = 512
    max_image_bytes: int = 2 * 1024 * 1024

    def __post_init__(self) -> None:
        for field_name in (
            "max_steps",
            "max_repeated_actions",
            "max_output_tokens",
            "max_image_bytes",
        ):
            value = getattr(self, field_name)
            if type(value) is not int or value < 1:
                raise ValueError(f"{field_name} must be positive")
        if self.max_repeated_actions > self.max_steps:
            raise ValueError("max_repeated_actions cannot exceed max_steps")
        object.__setattr__(
            self,
            "max_seconds",
            _finite_seconds(self.max_seconds, field_name="max_seconds"),
        )


@dataclass(frozen=True, slots=True, repr=False)
class BrowserAgentResult:
    disposition: BrowserAgentDisposition
    steps: int
    capture_state: BrowserCaptureState
    last_action: BrowserAction | None = field(default=None, repr=False)
    failure_code: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.disposition, BrowserAgentDisposition):
            raise TypeError("disposition must be BrowserAgentDisposition")
        if type(self.steps) is not int or self.steps < 0:
            raise ValueError("steps must be a nonnegative integer")
        if not isinstance(self.capture_state, BrowserCaptureState):
            raise TypeError("capture_state must be BrowserCaptureState")
        if self.last_action is not None and not isinstance(
            self.last_action,
            (ClickElement, ScrollPage, WaitForPage, StopFlow),
        ):
            raise TypeError("last_action must be a closed Browser action")
        if self.failure_code is not None:
            if type(self.failure_code) is not str or not self.failure_code.strip():
                raise ValueError("failure_code must be bounded text")
            if len(self.failure_code.encode("utf-8")) > _MAX_REASON_BYTES:
                raise ValueError("failure_code is too long")


class AgentBrowserController:
    """Bounded observe/decide/execute loop for one article Browser flow."""

    __slots__ = (
        "_agent_port",
        "_decision_port",
        "_action_port",
        "_budget",
        "_enabled",
    )

    def __init__(
        self,
        *,
        agent_port: AgentPort,
        decision_port: BrowserAgentDecisionPort,
        action_port: BrowserAgentActionPort,
        budget: BrowserAgentLoopBudget | None = None,
        enabled: bool = True,
    ) -> None:
        if not isinstance(agent_port, AgentPort):
            raise TypeError("agent_port must implement AgentPort")
        if not isinstance(decision_port, BrowserAgentDecisionPort):
            raise TypeError("decision_port must implement BrowserAgentDecisionPort")
        if not isinstance(action_port, BrowserAgentActionPort):
            raise TypeError("action_port must implement BrowserAgentActionPort")
        if budget is not None and not isinstance(budget, BrowserAgentLoopBudget):
            raise TypeError("budget must be BrowserAgentLoopBudget or None")
        if type(enabled) is not bool:
            raise TypeError("enabled must be bool")
        self._agent_port = agent_port
        self._decision_port = decision_port
        self._action_port = action_port
        self._budget = budget or BrowserAgentLoopBudget()
        self._enabled = enabled

    @property
    def budget(self) -> BrowserAgentLoopBudget:
        return self._budget

    def run(  # noqa: C901
        self,
        article_token: str,
        *,
        cancel_event: threading.Event | None = None,
    ) -> BrowserAgentResult:
        token = _article_token(article_token)
        if cancel_event is not None and not callable(getattr(cancel_event, "is_set", None)):
            raise TypeError("cancel_event must expose is_set()")
        if not self._enabled:
            return BrowserAgentResult(
                BrowserAgentDisposition.UNAVAILABLE,
                0,
                BrowserCaptureState.NONE,
            )
        started = time.monotonic()
        session_budget = AgentBudget(
            max_output_tokens=self._budget.max_output_tokens,
            context_window_tokens=max(1_024, self._budget.max_output_tokens + 8_192),
            connect_timeout_seconds=min(10.0, self._budget.max_seconds),
            read_timeout_seconds=min(10.0, self._budget.max_seconds),
            overall_timeout_seconds=self._budget.max_seconds,
        )
        session = open_session(
            self._agent_port,
            max_turns=self._budget.max_steps,
            cancel_event=cancel_event,
            budget=session_budget,
        )
        repeated: dict[tuple[object, ...], int] = {}
        last_action: BrowserAction | None = None
        steps = 0
        capture_state = BrowserCaptureState.NONE
        image_bytes_used = 0
        try:
            while steps < self._budget.max_steps:
                if cancel_event is not None and cancel_event.is_set():
                    return BrowserAgentResult(
                        BrowserAgentDisposition.CANCELLED,
                        steps,
                        capture_state,
                        last_action,
                        "agent-cancelled",
                    )
                if time.monotonic() - started >= self._budget.max_seconds:
                    return BrowserAgentResult(
                        BrowserAgentDisposition.BUDGET_EXHAUSTED,
                        steps,
                        capture_state,
                        last_action,
                        "agent-timeout",
                    )
                observation = self._action_port.observe()
                if not isinstance(observation, BrowserAgentObservation):
                    raise TypeError("Browser action port returned an invalid observation")
                capture_state = observation.capture_state
                if capture_state is not BrowserCaptureState.NONE:
                    return BrowserAgentResult(
                        BrowserAgentDisposition.CAPTURE_AVAILABLE,
                        steps,
                        capture_state,
                        last_action,
                    )
                if observation.remaining_budget.remaining_steps <= 0:
                    return BrowserAgentResult(
                        BrowserAgentDisposition.BUDGET_EXHAUSTED,
                        steps,
                        capture_state,
                        last_action,
                        "browser-step-budget",
                    )
                controller_remaining_steps = self._budget.max_steps - steps
                controller_remaining_seconds = self._budget.max_seconds - (
                    time.monotonic() - started
                )
                remaining_steps = min(
                    observation.remaining_budget.remaining_steps,
                    controller_remaining_steps,
                )
                remaining_seconds = min(
                    observation.remaining_budget.remaining_seconds,
                    controller_remaining_seconds,
                )
                if remaining_steps <= 0:
                    return BrowserAgentResult(
                        BrowserAgentDisposition.BUDGET_EXHAUSTED,
                        steps,
                        capture_state,
                        last_action,
                        "agent-step-budget",
                    )
                if remaining_seconds <= 0:
                    return BrowserAgentResult(
                        BrowserAgentDisposition.BUDGET_EXHAUSTED,
                        steps,
                        capture_state,
                        last_action,
                        "agent-timeout",
                    )
                screenshot_bytes = (
                    0 if observation.screenshot is None else len(observation.screenshot)
                )
                remaining_image_bytes = self._budget.max_image_bytes - image_bytes_used
                if screenshot_bytes > remaining_image_bytes:
                    return BrowserAgentResult(
                        BrowserAgentDisposition.BUDGET_EXHAUSTED,
                        steps,
                        capture_state,
                        last_action,
                        "agent-image-budget",
                    )
                decision_observation = replace(
                    observation,
                    remaining_budget=replace(
                        observation.remaining_budget,
                        remaining_steps=remaining_steps,
                        remaining_seconds=remaining_seconds,
                        remaining_image_bytes=min(
                            observation.remaining_budget.remaining_image_bytes,
                            remaining_image_bytes - screenshot_bytes,
                        ),
                    ),
                )
                image_bytes_used += screenshot_bytes
                context = BrowserAgentRequestContext(
                    article_token=token,
                    step=steps + 1,
                    observation_hash=observation_hash(decision_observation),
                    remaining_budget=decision_observation.remaining_budget,
                )
                request = BrowserAgentDecisionRequest(
                    context=context,
                    observation=decision_observation,
                    session=session,
                )
                try:
                    action = self._decision_port.decide(request)
                except AgentFailure as error:
                    code = error.failure.code
                    disposition = (
                        BrowserAgentDisposition.CANCELLED
                        if code == "agent-cancelled"
                        else BrowserAgentDisposition.UNAVAILABLE
                        if code == "agent-capability"
                        else BrowserAgentDisposition.FAILED
                    )
                    return BrowserAgentResult(disposition, steps, capture_state, last_action, code)
                except Exception:
                    return BrowserAgentResult(
                        BrowserAgentDisposition.FAILED,
                        steps,
                        capture_state,
                        last_action,
                        "agent-decision-failed",
                    )
                if cancel_event is not None and cancel_event.is_set():
                    return BrowserAgentResult(
                        BrowserAgentDisposition.CANCELLED,
                        steps,
                        capture_state,
                        last_action,
                        "agent-cancelled",
                    )
                if not isinstance(action, (ClickElement, ScrollPage, WaitForPage, StopFlow)):
                    return BrowserAgentResult(
                        BrowserAgentDisposition.FAILED,
                        steps,
                        capture_state,
                        last_action,
                        "agent-action-invalid",
                    )
                # A page can navigate or mutate while the model response is in
                # flight.  Re-observe before any injected action is allowed.
                current = self._action_port.observe()
                if not isinstance(current, BrowserAgentObservation):
                    raise TypeError("Browser action port returned an invalid observation")
                # A capture can arrive while the model decision is in flight.
                # It wins over any stale/late action: return immediately and
                # never hand the command to Network/vendor code.
                if current.capture_state is not BrowserCaptureState.NONE:
                    return BrowserAgentResult(
                        BrowserAgentDisposition.CAPTURE_AVAILABLE,
                        steps,
                        current.capture_state,
                        last_action,
                    )
                if (
                    current.revision != observation.revision
                    or current.page_token != observation.page_token
                ):
                    return BrowserAgentResult(
                        BrowserAgentDisposition.STALE_OBSERVATION,
                        steps,
                        current.capture_state,
                        last_action,
                        "agent-stale-observation",
                    )
                try:
                    self._validate_action(action, current)
                except ValueError:
                    return BrowserAgentResult(
                        BrowserAgentDisposition.FAILED,
                        steps,
                        current.capture_state,
                        last_action,
                        "agent-action-rejected",
                    )
                if isinstance(action, StopFlow):
                    return BrowserAgentResult(
                        BrowserAgentDisposition.STOPPED,
                        steps,
                        current.capture_state,
                        action,
                    )
                fingerprint = _action_fingerprint(action)
                repeated[fingerprint] = repeated.get(fingerprint, 0) + 1
                if repeated[fingerprint] > self._budget.max_repeated_actions:
                    return BrowserAgentResult(
                        BrowserAgentDisposition.NO_PROGRESS,
                        steps,
                        current.capture_state,
                        action,
                        "agent-no-progress",
                    )
                remaining_seconds = min(
                    self._budget.max_seconds - (time.monotonic() - started),
                    current.remaining_budget.remaining_seconds,
                    _MAX_ACTION_SECONDS,
                )
                if remaining_seconds <= 0:
                    return BrowserAgentResult(
                        BrowserAgentDisposition.BUDGET_EXHAUSTED,
                        steps,
                        current.capture_state,
                        last_action,
                        "agent-action-timeout",
                    )
                # Once an action has passed the closed observation/revision
                # checks, an execution error belongs to Network/Browser's
                # safety boundary.  It must propagate (policy, budget,
                # timeout, cancellation and cleanup are not Agent normal
                # misses) while this controller's ``finally`` still closes
                # the request-local Agents session.
                self._action_port.execute(
                    browser_action_command(action),
                    current,
                    timeout_seconds=remaining_seconds,
                )
                last_action = action
                steps += 1
            return BrowserAgentResult(
                BrowserAgentDisposition.BUDGET_EXHAUSTED,
                steps,
                capture_state,
                last_action,
                "agent-step-budget",
            )
        finally:
            session.close()

    @staticmethod
    def _validate_action(action: BrowserAction, observation: BrowserAgentObservation) -> None:
        if action.observation_revision != observation.revision:
            raise ValueError("Browser Agent action revision is stale")
        if isinstance(action, ClickElement):
            element = next(
                (item for item in observation.elements if item.element_id == action.element_id),
                None,
            )
            if element is None or not element.visible or not element.enabled:
                raise ValueError("Browser Agent click target is not actionable")
        elif isinstance(action, ScrollPage):
            if abs(action.delta_y) > _MAX_SCROLL_PIXELS:
                raise ValueError("Browser Agent scroll is out of range")
        elif isinstance(action, WaitForPage):
            if action.seconds > observation.remaining_budget.remaining_seconds:
                raise ValueError("Browser Agent wait exceeds the remaining budget")


def browser_agent_tool_declarations() -> tuple[AgentToolDeclaration, ...]:
    """Return the four closed tools for an adapter constructing an AgentRequest."""

    return (
        AgentToolDeclaration(
            name="click_element",
            description=(
                "Click one currently visible and enabled element from this observation "
                "revision; use only when it is a safe step toward the primary PDF."
            ),
            input_schema=(
                '{"type":"object","properties":{"revision":{"type":"integer"},'
                '"element_id":{"type":"string"}},"required":["revision","element_id"],'
                '"additionalProperties":false}'
            ),
        ),
        AgentToolDeclaration(
            name="scroll_page",
            description=(
                "Scroll the current article page by a small bounded amount to reveal a "
                "visible PDF control; this never navigates to another URL."
            ),
            input_schema=(
                '{"type":"object","properties":{"revision":{"type":"integer"},'
                '"delta_y":{"type":"integer"}},"required":["revision","delta_y"],'
                '"additionalProperties":false}'
            ),
        ),
        AgentToolDeclaration(
            name="wait_for_page",
            description=(
                "Wait briefly for the current page to settle after a safe action; do "
                "not use this to wait through login, MFA, CAPTCHA, or a challenge."
            ),
            input_schema=(
                '{"type":"object","properties":{"revision":{"type":"integer"},'
                '"seconds":{"type":"number"}},"required":["revision","seconds"],'
                '"additionalProperties":false}'
            ),
        ),
        AgentToolDeclaration(
            name="stop_flow",
            description=(
                "Stop the Browser fallback when the primary PDF is not safely "
                "obtainable with the closed actions."
            ),
            input_schema=(
                '{"type":"object","properties":{"revision":{"type":"integer"},'
                '"reason":{"type":"string","enum":["normal-miss","not-actionable",'
                '"no-progress"]}},"required":["revision","reason"],'
                '"additionalProperties":false}'
            ),
        ),
    )


def build_browser_agent_request(
    request: BrowserAgentDecisionRequest,
    *,
    model: str,
    budget: AgentBudget | None = None,
) -> AgentRequest:
    """Build a neutral multimodal Agent request for a decision-port adapter.

    This helper contains only bounded observation data.  It deliberately
    requires a screenshot: Browser role capability is image input plus tool
    decision, so silently dropping an absent image would violate that contract.
    """

    if not isinstance(request, BrowserAgentDecisionRequest):
        raise TypeError("request must be BrowserAgentDecisionRequest")
    observation = request.observation
    if observation.screenshot is None or observation.screenshot_media_type is None:
        raise ValueError("Browser Agent observation requires a bounded screenshot")
    summary = {
        "origin": observation.origin,
        "path": observation.path,
        "status": observation.status_code,
        "revision": observation.revision,
        "capture": observation.capture_state.value,
        "elements": [
            {
                "id": element.element_id,
                "role": element.role,
                "name": element.name,
                "state": element.state.value,
            }
            for element in observation.elements
        ],
        "remaining": {
            "steps": observation.remaining_budget.remaining_steps,
            "seconds": observation.remaining_budget.remaining_seconds,
        },
    }
    text = json.dumps(summary, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    image = AgentImagePart(
        media_type=observation.screenshot_media_type,
        data=observation.screenshot,
        width=observation.viewport.width,
        height=observation.viewport.height,
    )
    selected_budget = AgentBudget() if budget is None else budget
    return AgentRequest(
        role=AgentRole.BROWSER,
        capabilities=frozenset({AgentCapability.IMAGE_INPUT, AgentCapability.TOOL_DECISION}),
        model=model,
        input_sha256=request.context.observation_hash,
        # Agents adapters map the first text part to a system/developer
        # instruction and every subsequent part to the user turn.  Keep the
        # static business goal separate from the observation so that a page
        # snapshot cannot replace the instruction (or be sent twice).
        text_parts=(
            AgentTextPart(
                media_type="text/plain",
                text=_BROWSER_AGENT_SYSTEM_INSTRUCTION,
            ),
            AgentTextPart(media_type="application/json", text=text),
        ),
        image_parts=(image,),
        tools=browser_agent_tool_declarations(),
        max_output_tokens=min(256, selected_budget.max_output_tokens),
        budget=selected_budget,
    )


def _action_fingerprint(action: BrowserAction) -> tuple[object, ...]:
    if isinstance(action, ClickElement):
        return ("click", action.revision, action.element_id)
    if isinstance(action, ScrollPage):
        return ("scroll", action.revision, action.delta_y)
    if isinstance(action, WaitForPage):
        return ("wait", action.revision, action.seconds)
    return ("stop", action.revision, action.reason.value)


__all__ = (
    "AgentBrowserController",
    "BrowserAction",
    "BrowserAgentActionPort",
    "browser_action_command",
    "AgentsBrowserAgentDecisionPort",
    "BrowserAgentDecisionPort",
    "BrowserAgentDecisionRequest",
    "BrowserAgentDisposition",
    "BrowserAgentLoopBudget",
    "BrowserAgentRequestContext",
    "BrowserAgentResult",
    "BrowserFlowController",
    "ClickElement",
    "RuleBrowserController",
    "BrowserRuleExecution",
    "ScrollPage",
    "StopFlow",
    "StopFlowReason",
    "WaitForPage",
    "action_from_agent_decision",
    "action_from_tool_decision",
    "browser_agent_tool_declarations",
    "build_browser_agent_request",
)
