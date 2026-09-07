"""Acquisition-owned generic Browser Agent controller contracts.

The controller observes the current article, asks the shared stateless Agents
runtime for exactly one closed action, and hands that action back to Network
for validation and execution.

No Browser vendor object, selector, arbitrary URL, Profile, Cookie, CDP handle,
filesystem capability, or PDF publishing capability crosses this boundary.
"""

from __future__ import annotations

import json
import math
import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Final, Protocol, TypeAlias, runtime_checkable

from sciretriever.agents.api import (
    AgentCall,
    AgentCapability,
    AgentFailure,
    AgentImagePart,
    AgentRole,
    AgentRuntime,
    AgentTextPart,
    AgentToolCall,
    AgentToolDeclaration,
)
from sciretriever.logging.api import get_logger
from sciretriever.model.access import AccessFailure
from sciretriever.model.primitives import sha256_digest
from sciretriever.model.report import StableFailure
from sciretriever.network.browser import BrowserFlowSession
from sciretriever.network.browser_control import (
    BrowserAction,
    BrowserBlocked,
    BrowserBlockedReason,
    BrowserCancelled,
    BrowserCaptured,
    BrowserCaptureState,
    BrowserFailed,
    BrowserObservation,
    BrowserPageState,
    BrowserReady,
    BrowserStep,
    BrowserStepSession,
    ClickElement,
    ClickPoint,
    GoBack,
    ScrollSurface,
    Stop,
    WaitForChange,
    execution_binding_fingerprint,
    stable_action_intent_fingerprint,
    stable_semantic_page_fingerprint,
)

# One Browser decision may spend reasoning tokens before returning its small
# closed tool payload.  Keep this task-owned per-call budget separate from the
# model configuration and reuse it when Bootstrap declares the role capacity.
BROWSER_AGENT_MAX_OUTPUT_TOKENS: Final[int] = 131_072
_BROWSER_ACTION_TIMEOUT_SECONDS: Final[float] = 10.0
_BROWSER_AGENT_MAX_MODEL_CALLS: Final[int] = 32
_BROWSER_AGENT_MAX_TRANSIENT_CALL_RETRIES: Final[int] = 2
_TRANSIENT_BROWSER_AGENT_FAILURES: Final[frozenset[str]] = frozenset(
    {
        "agent-access",
        "agent-http-status",
        "agent-remote-service",
        "agent-timeout",
    }
)
_LOGGER = get_logger(__name__)
_STOP_REASONS: Final[tuple[str, ...]] = (
    "normal-miss",
    "not-actionable",
    "challenge-unresolved",
    "login-required",
    "mfa-required",
    "not-entitled",
    "access-denied",
    "not-found",
)


@dataclass(frozen=True, slots=True)
class BrowserArticleGoal:
    """Bounded article context supplied alongside one Browser observation."""

    doi: str | None = None
    title: str | None = None
    authors: tuple[str, ...] = ()
    landing_origins: tuple[str, ...] = ()
    asset_origins: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for name in ("doi", "title"):
            value = getattr(self, name)
            if value is not None:
                if (
                    type(value) is not str
                    or not value.strip()
                    or len(value.encode("utf-8", "strict")) > 512
                ):
                    raise ValueError(f"{name} must be bounded text or None")
                object.__setattr__(self, name, value.strip())
        if not isinstance(self.authors, tuple) or any(
            type(value) is not str
            or not value.strip()
            or len(value.encode("utf-8", "strict")) > 256
            for value in self.authors
        ):
            raise ValueError("authors must contain bounded text")
        object.__setattr__(self, "authors", tuple(value.strip() for value in self.authors))
        for name in ("landing_origins", "asset_origins"):
            values = getattr(self, name)
            if not isinstance(values, tuple) or any(
                type(value) is not str
                or not value.startswith("https://")
                or "?" in value
                or "#" in value
                or len(value.encode("utf-8", "strict")) > 512
                for value in values
            ):
                raise ValueError(f"{name} must contain safe HTTPS origins")
            object.__setattr__(self, name, tuple(dict.fromkeys(values)))


# The system instruction is static.  Page-derived text, the request-local
# article identity, and the screenshot are separate user inputs and can never
# replace the instruction or be interpolated into it.
_BROWSER_AGENT_SYSTEM_INSTRUCTION: Final[str] = (
    "Control the current article's already-open Browser flow to obtain its primary PDF. "
    "Choose exactly one declared action for the supplied observation. Treat a visible "
    "access challenge as an ordinary page: you may interact only with its currently "
    "visible controls through the declared element or screenshot-bound point actions, "
    "and you must not fabricate or inject a challenge result. Never navigate to an "
    "arbitrary URL, enter credentials or other text, log in, select an institution, "
    "handle MFA, upload a file, execute script, or create another Browser. Use stop "
    "when the primary PDF cannot be reached safely with these closed actions. Choose "
    "the most specific declared stop reason when the page visibly requires login or "
    "MFA, denies entitlement or access, is not found, or leaves a challenge unresolved; "
    "otherwise use normal-miss or not-actionable. A stop reason reports "
    "only the visible page outcome and never claims that a PDF was downloaded."
)


@runtime_checkable
class BrowserStepSessionFactory(Protocol):
    """Bind Publisher classification to one request-local atomic step session."""

    def open(
        self,
        session: BrowserFlowSession,
        *,
        timeout_seconds: float,
    ) -> BrowserStepSession: ...


_BrowserTerminalStep: TypeAlias = (
    BrowserCaptured | BrowserBlocked | BrowserFailed | BrowserCancelled
)


def _step_outcome(step: _BrowserTerminalStep) -> str:
    if isinstance(step, BrowserCaptured):
        return "captured"
    if isinstance(step, BrowserCancelled):
        return "cancelled"
    if isinstance(step, BrowserFailed):
        return "failed"
    if step.reason is BrowserBlockedReason.STOPPED:
        return "stopped"
    if step.reason is BrowserBlockedReason.CANDIDATE_TIMEOUT:
        return "candidate-timeout"
    if step.reason in {
        BrowserBlockedReason.REPEATED_SELF_TRANSITION,
        BrowserBlockedReason.REPEATED_CYCLE_EDGE,
    }:
        return "no-progress"
    return "page-terminal"


@dataclass(frozen=True, slots=True, repr=False)
class BrowserAgentResult:
    """The final stable Browser step plus controller-only counters."""

    step: _BrowserTerminalStep
    action_count: int
    model_call_count: int = 0
    last_action: BrowserAction | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if not isinstance(
            self.step,
            (BrowserCaptured, BrowserBlocked, BrowserFailed, BrowserCancelled),
        ):
            raise TypeError("step must be a terminal Browser step")
        if type(self.action_count) is not int or self.action_count < 0:
            raise ValueError("action_count must be a nonnegative integer")
        if type(self.model_call_count) is not int or self.model_call_count < 0:
            raise ValueError("model_call_count must be a nonnegative integer")
        if self.last_action is not None and not isinstance(
            self.last_action,
            (ClickElement, ClickPoint, ScrollSurface, GoBack, WaitForChange, Stop),
        ):
            raise TypeError("last_action must be a closed Browser action")

    @property
    def outcome(self) -> str:
        return _step_outcome(self.step)

    @property
    def observation(self) -> BrowserObservation | None:
        return self.step.observation

    @property
    def page_state(self) -> BrowserPageState | None:
        observation = self.observation
        return None if observation is None else observation.page_state

    @property
    def capture_state(self) -> BrowserCaptureState:
        observation = self.observation
        return BrowserCaptureState.NONE if observation is None else observation.capture_state

    @property
    def failure(self) -> AccessFailure | None:
        return self.step.failure if isinstance(self.step, BrowserFailed) else None

    @property
    def blocked_reason(self) -> BrowserBlockedReason | None:
        return self.step.reason if isinstance(self.step, BrowserBlocked) else None


def _controller_failure(kind: str) -> AccessFailure:
    values: dict[str, tuple[str, str, str, bool]] = {
        "cancelled": (
            "agent-cancelled",
            "The Browser Agent operation was cancelled.",
            "Retry the acquisition operation when ready.",
            False,
        ),
        "action": (
            "acquisition-browser-agent-action-rejected",
            "The Browser Agent selected an action outside the current page observation.",
            "Retry the Browser route or review the Browser Agent model capability.",
            False,
        ),
        "receipt": (
            "acquisition-browser-agent-action-failed",
            "Network could not apply the selected Browser Agent action.",
            "Review the Browser runtime and retry the route.",
            True,
        ),
        "readiness": (
            "acquisition-browser-agent-readiness-timeout",
            "The Browser page did not reach one consistent actionable observation.",
            "Retry after the Publisher page and Browser runtime become stable.",
            True,
        ),
        "safety": (
            "controller-safety-limit",
            "The Browser Agent reached its controller safety limit.",
            "Review the Browser model decisions before retrying this route.",
            False,
        ),
        "internal": (
            "browser-agent-internal",
            "The Browser Agent controller encountered an internal error.",
            "Review the Debug transcript and controller implementation.",
            False,
        ),
    }
    try:
        code, reason, action, retryable = values[kind]
    except KeyError:
        raise ValueError("unknown Browser Agent failure kind") from None
    return AccessFailure(code=code, reason=reason, action=action, retryable=retryable)


def _agent_failure_step(
    failure: StableFailure,
    observation: BrowserObservation | None,
) -> BrowserFailed:
    """Convert an Agents failure into the stable Browser failure vocabulary."""

    if not isinstance(failure, StableFailure):
        raise TypeError("failure must be StableFailure")
    return BrowserFailed(
        failure=AccessFailure(
            code=failure.code,
            reason=failure.reason,
            action=failure.action,
            retryable=failure.retryable,
        ),
        observation=observation,
    )


def _closed_object_schema(properties: Mapping[str, object]) -> str:
    return json.dumps(
        {
            "type": "object",
            "properties": properties,
            "required": list(properties),
            "additionalProperties": False,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _const_string(value: str) -> dict[str, object]:
    return {"type": "string", "const": value}


def _const_integer(value: int) -> dict[str, object]:
    return {"type": "integer", "const": value}


def browser_agent_tool_declarations(
    observation: BrowserObservation,
) -> tuple[AgentToolDeclaration, ...]:
    """Declare the six closed actions, bound to one exact observation."""

    if not isinstance(observation, BrowserObservation):
        raise TypeError("observation must be BrowserObservation")
    identity = {
        "article_token": _const_string(observation.article_token),
        "page_id": _const_string(observation.page_id),
        "revision": _const_integer(observation.revision),
    }
    return (
        AgentToolDeclaration(
            name="click_element",
            description=(
                "Click one visible enabled element id from this exact observation. "
                "The supplied surface must own that element."
            ),
            input_schema=_closed_object_schema(
                {
                    **identity,
                    "surface_id": {"type": "string"},
                    "element_id": {"type": "string"},
                }
            ),
        ),
        AgentToolDeclaration(
            name="click_point",
            description=(
                "Click one viewport point visible in this exact screenshot and inside "
                "the supplied current-page surface."
            ),
            input_schema=_closed_object_schema(
                {
                    **identity,
                    "surface_id": {"type": "string"},
                    "screenshot_id": _const_string(observation.screenshot.screenshot_id),
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                }
            ),
        ),
        AgentToolDeclaration(
            name="scroll_surface",
            description=("Scroll one current-page surface by a nonzero bounded CSS-pixel amount."),
            input_schema=_closed_object_schema(
                {
                    **identity,
                    "surface_id": {"type": "string"},
                    "delta_y": {"type": "integer"},
                }
            ),
        ),
        AgentToolDeclaration(
            name="go_back",
            description="Go back in the current page history without supplying a URL.",
            input_schema=_closed_object_schema(identity),
        ),
        AgentToolDeclaration(
            name="wait_for_change",
            description=(
                "Wait once for the current page to change. The application owns the "
                "single-action timeout; no duration is accepted here."
            ),
            input_schema=_closed_object_schema(identity),
        ),
        AgentToolDeclaration(
            name="stop",
            description=(
                "Stop this article flow when no allowed action can safely reach the primary PDF."
            ),
            input_schema=_closed_object_schema(
                {
                    **identity,
                    "reason": {"type": "string", "enum": list(_STOP_REASONS)},
                }
            ),
        ),
    )


@dataclass(frozen=True, slots=True)
class _BrowserStepFeedback:
    action_kind: str | None
    dispatch_outcome: str | None
    settle_outcome: str
    semantic_changed: bool
    page_state: str
    capture_state: str


def _observation_debug_values(
    observation: BrowserObservation,
) -> tuple[str, int, str, str, float, float, int, int, str]:
    """Extract only bounded state facts suitable for a Debug LogRecord."""

    root = observation.primary_surface
    return (
        observation.page_id,
        observation.revision,
        observation.page_state.value,
        observation.capture_state.value,
        root.scroll.y,
        root.scroll.maximum_y,
        len(observation.surfaces),
        len(observation.elements),
        root.kind.value,
    )


def _step_feedback(
    step: BrowserStep,
    requested_action: BrowserAction,
) -> _BrowserStepFeedback:
    observation = getattr(step, "observation", None)
    receipt = getattr(step, "receipt", None)
    semantic_changed = getattr(step, "semantic_changed", False)
    return _BrowserStepFeedback(
        action_kind=(requested_action.kind.value if receipt is None else receipt.action_kind.value),
        dispatch_outcome=("not-dispatched" if receipt is None else receipt.outcome.value),
        settle_outcome=step.kind.value,
        semantic_changed=bool(semantic_changed),
        page_state="none" if observation is None else observation.page_state.value,
        capture_state="none" if observation is None else observation.capture_state.value,
    )


def _observation_summary(
    observation: BrowserObservation,
    previous_transition: _BrowserStepFeedback | None = None,
    article_goal: BrowserArticleGoal | None = None,
) -> str:
    last_receipt = observation.last_receipt
    value = {
        "article_token": observation.article_token,
        "revision": observation.revision,
        "page_id": observation.page_id,
        "page_state": observation.page_state.value,
        "agent_status": observation.agent_status.value,
        "capture_state": observation.capture_state.value,
        "viewport": {
            "width": observation.viewport.width,
            "height": observation.viewport.height,
        },
        "screenshot_id": observation.screenshot.screenshot_id,
        "surfaces": [
            {
                "surface_id": surface.surface_id,
                "page_id": surface.page_id,
                "kind": surface.kind.value,
                "parent_surface_id": surface.parent_surface_id,
                "origin": surface.origin,
                "path": surface.path,
                "title": surface.title,
                "bounds": {
                    "x": surface.bounds.x,
                    "y": surface.bounds.y,
                    "width": surface.bounds.width,
                    "height": surface.bounds.height,
                },
                "scroll": {
                    "x": surface.scroll.x,
                    "y": surface.scroll.y,
                    "maximum_x": surface.scroll.maximum_x,
                    "maximum_y": surface.scroll.maximum_y,
                },
            }
            for surface in observation.surfaces
        ],
        "elements": [
            {
                "element_id": element.element_id,
                "surface_id": element.surface_id,
                "role": element.role,
                "name": element.name,
                "state": element.state.value,
                "bounds": {
                    "x": element.bounds.x,
                    "y": element.bounds.y,
                    "width": element.bounds.width,
                    "height": element.bounds.height,
                },
            }
            for element in observation.elements
        ],
        "last_action": (
            None
            if last_receipt is None
            else {
                "kind": last_receipt.action_kind.value,
                "outcome": last_receipt.outcome.value,
            }
        ),
        "previous_transition": (
            None
            if previous_transition is None
            else {
                "action_kind": previous_transition.action_kind,
                "dispatch_outcome": previous_transition.dispatch_outcome,
                "settle_outcome": previous_transition.settle_outcome,
                "semantic_changed": previous_transition.semantic_changed,
                "page_state": previous_transition.page_state,
                "capture_state": previous_transition.capture_state,
            }
        ),
        "article_goal": (
            None
            if article_goal is None
            else {
                "doi": article_goal.doi,
                "title": article_goal.title,
                "authors": list(article_goal.authors),
                "landing_origins": list(article_goal.landing_origins),
                "asset_origins": list(article_goal.asset_origins),
            }
        ),
    }
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def build_browser_agent_call(
    observation: BrowserObservation,
    previous_transition: _BrowserStepFeedback | None = None,
    article_goal: BrowserArticleGoal | None = None,
) -> AgentCall:
    """Build one independent Browser-role call for one exact observation."""

    if not isinstance(observation, BrowserObservation):
        raise TypeError("observation must be BrowserObservation")
    if article_goal is not None and not isinstance(article_goal, BrowserArticleGoal):
        raise TypeError("article_goal must be BrowserArticleGoal or None")
    summary = _observation_summary(observation, previous_transition, article_goal)
    input_sha256 = sha256_digest(
        execution_binding_fingerprint(observation).root.encode("ascii")
        + b"\0"
        + summary.encode("utf-8")
    )
    return AgentCall(
        role=AgentRole.BROWSER,
        required_capabilities=frozenset(
            {AgentCapability.IMAGE_INPUT, AgentCapability.TOOL_DECISION}
        ),
        input_sha256=input_sha256,
        text_parts=(
            AgentTextPart(media_type="text/plain", text=_BROWSER_AGENT_SYSTEM_INSTRUCTION),
            AgentTextPart(
                media_type="application/json",
                text=summary,
            ),
        ),
        image_parts=(
            AgentImagePart(
                media_type=observation.screenshot.media_type,
                data=observation.screenshot.content,
                width=observation.viewport.width,
                height=observation.viewport.height,
            ),
        ),
        tools=browser_agent_tool_declarations(observation),
        max_output_tokens=BROWSER_AGENT_MAX_OUTPUT_TOKENS,
    )


def _strict_arguments(call: AgentToolCall, expected: frozenset[str]) -> dict[str, object]:
    values = call.value
    if frozenset(values) != expected:
        raise ValueError("Browser Agent action contains unknown or missing fields")
    return values


def _text_argument(values: dict[str, object], name: str) -> str:
    value = values[name]
    if type(value) is not str:
        raise ValueError(f"{name} must be text")
    return value


def _integer_argument(values: dict[str, object], name: str) -> int:
    value = values[name]
    if type(value) is not int:
        raise ValueError(f"{name} must be an integer")
    return value


def _number_argument(values: dict[str, object], name: str) -> float:
    value = values[name]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be numeric")
    selected = float(value)
    if not math.isfinite(selected):
        raise ValueError(f"{name} must be finite")
    return selected


def _common_action_identity(
    values: dict[str, object],
) -> tuple[str, str, int]:
    return (
        _text_argument(values, "article_token"),
        _text_argument(values, "page_id"),
        _integer_argument(values, "revision"),
    )


def action_from_agent_tool_call(
    call: AgentToolCall,
    observation: BrowserObservation,
) -> BrowserAction:
    """Convert and validate one tool call against the current observation."""

    if not isinstance(call, AgentToolCall):
        raise TypeError("call must be an AgentToolCall")
    if not isinstance(observation, BrowserObservation):
        raise TypeError("observation must be BrowserObservation")
    base = frozenset({"article_token", "page_id", "revision"})
    if call.tool_name == "click_element":
        values = _strict_arguments(call, base | {"surface_id", "element_id"})
        article_token, page_id, revision = _common_action_identity(values)
        action: BrowserAction = ClickElement(
            article_token=article_token,
            page_id=page_id,
            surface_id=_text_argument(values, "surface_id"),
            revision=revision,
            element_id=_text_argument(values, "element_id"),
        )
    elif call.tool_name == "click_point":
        values = _strict_arguments(
            call,
            base | {"surface_id", "screenshot_id", "x", "y"},
        )
        article_token, page_id, revision = _common_action_identity(values)
        action = ClickPoint(
            article_token=article_token,
            page_id=page_id,
            surface_id=_text_argument(values, "surface_id"),
            revision=revision,
            screenshot_id=_text_argument(values, "screenshot_id"),
            x=_number_argument(values, "x"),
            y=_number_argument(values, "y"),
        )
    elif call.tool_name == "scroll_surface":
        values = _strict_arguments(call, base | {"surface_id", "delta_y"})
        article_token, page_id, revision = _common_action_identity(values)
        action = ScrollSurface(
            article_token=article_token,
            page_id=page_id,
            surface_id=_text_argument(values, "surface_id"),
            revision=revision,
            delta_y=_integer_argument(values, "delta_y"),
        )
    elif call.tool_name == "go_back":
        values = _strict_arguments(call, base)
        article_token, page_id, revision = _common_action_identity(values)
        action = GoBack(article_token=article_token, page_id=page_id, revision=revision)
    elif call.tool_name == "wait_for_change":
        values = _strict_arguments(call, base)
        article_token, page_id, revision = _common_action_identity(values)
        action = WaitForChange(
            article_token=article_token,
            page_id=page_id,
            revision=revision,
        )
    elif call.tool_name == "stop":
        values = _strict_arguments(call, base | {"reason"})
        article_token, page_id, revision = _common_action_identity(values)
        reason = _text_argument(values, "reason")
        if reason not in _STOP_REASONS:
            raise ValueError("Browser Agent stop reason is not declared")
        action = Stop(
            article_token=article_token,
            page_id=page_id,
            revision=revision,
            reason=reason,
        )
    else:
        raise ValueError("Browser Agent returned an undeclared action")
    _validate_action_for_observation(action, observation)
    return action


def _validate_action_for_observation(
    action: BrowserAction,
    observation: BrowserObservation,
) -> None:
    if (
        action.article_token != observation.article_token
        or action.revision != observation.revision
        or action.page_id != observation.page_id
    ):
        raise ValueError("Browser Agent action identity is stale")
    surfaces = {surface.surface_id: surface for surface in observation.surfaces}
    if isinstance(action, ClickElement):
        element = next(
            (value for value in observation.elements if value.element_id == action.element_id),
            None,
        )
        surface = surfaces.get(action.surface_id)
        if (
            element is None
            or surface is None
            or not element.visible
            or not element.enabled
            or element.surface_id != action.surface_id
            or surface.page_id != action.page_id
        ):
            raise ValueError("Browser Agent click element is not actionable")
    elif isinstance(action, ClickPoint):
        surface = surfaces.get(action.surface_id)
        if (
            surface is None
            or surface.page_id != action.page_id
            or action.screenshot_id != observation.screenshot.screenshot_id
            or not surface.bounds.contains(action.x, action.y)
            or action.x > observation.viewport.width
            or action.y > observation.viewport.height
        ):
            raise ValueError("Browser Agent click point is outside the current screenshot")
    elif isinstance(action, ScrollSurface):
        surface = surfaces.get(action.surface_id)
        if surface is None or surface.page_id != action.page_id:
            raise ValueError("Browser Agent scroll surface is not current")


class AgentBrowserController:
    """Choose one closed action for each stable Browser step."""

    __slots__ = (
        "_action_timeout_seconds",
        "_article_goal",
        "_cancel_event",
        "_progress_action_count",
        "_progress_last_action",
        "_progress_model_call_count",
        "_progress_observation",
        "_provider_name",
        "_result",
        "_runtime",
        "_started",
        "_step_factory",
    )

    def __init__(
        self,
        *,
        runtime: AgentRuntime,
        step_factory: BrowserStepSessionFactory,
        article_goal: BrowserArticleGoal | None = None,
        cancel_event: threading.Event | None = None,
        action_timeout_seconds: float = _BROWSER_ACTION_TIMEOUT_SECONDS,
    ) -> None:
        if not isinstance(runtime, AgentRuntime):
            raise TypeError("runtime must be AgentRuntime")
        if not isinstance(step_factory, BrowserStepSessionFactory):
            raise TypeError("step_factory must implement BrowserStepSessionFactory")
        if article_goal is not None and not isinstance(article_goal, BrowserArticleGoal):
            raise TypeError("article_goal must be BrowserArticleGoal or None")
        if cancel_event is not None and not isinstance(cancel_event, threading.Event):
            raise TypeError("cancel_event must be a threading.Event or None")
        if isinstance(action_timeout_seconds, bool) or not isinstance(
            action_timeout_seconds,
            (int, float),
        ):
            raise TypeError("action_timeout_seconds must be numeric")
        timeout = float(action_timeout_seconds)
        if not math.isfinite(timeout) or not 0 < timeout <= _BROWSER_ACTION_TIMEOUT_SECONDS:
            raise ValueError("action_timeout_seconds exceeds the single-action limit")
        self._runtime = runtime
        self._provider_name = runtime.identity(AgentRole.BROWSER).provider
        self._step_factory = step_factory
        self._article_goal = article_goal
        self._cancel_event = cancel_event
        self._action_timeout_seconds = timeout
        self._result: BrowserAgentResult | None = None
        self._progress_action_count = 0
        self._progress_model_call_count = 0
        self._progress_observation: BrowserObservation | None = None
        self._progress_last_action: BrowserAction | None = None
        self._started = False

    @property
    def result(self) -> BrowserAgentResult | None:
        return self._result

    def run(self, session: BrowserFlowSession) -> None:
        """Run once; Network receives no controller result data channel."""

        if not isinstance(session, BrowserFlowSession):
            raise TypeError("session must implement BrowserFlowSession")
        if self._started:
            raise RuntimeError("AgentBrowserController is single-use")
        self._started = True
        _LOGGER.debug(
            "event=browser-controller-start controller=agent role=browser provider=%s",
            self._provider_name,
        )
        try:
            steps = self._step_factory.open(
                session,
                timeout_seconds=self._action_timeout_seconds,
            )
            if not isinstance(steps, BrowserStepSession):
                raise TypeError("step factory returned an invalid BrowserStepSession")
            self._result = self._run_loop(steps)
        except Exception as error:
            observation = self._progress_observation
            _LOGGER.debug(
                "event=browser-agent-controller-failed controller=agent role=browser "
                "provider=%s exception_type=%s action_count=%d model_call_count=%d",
                self._provider_name,
                type(error).__name__,
                self._progress_action_count,
                self._progress_model_call_count,
            )
            self._result = self._finish(
                BrowserAgentResult(
                    step=BrowserFailed(
                        failure=_controller_failure("internal"),
                        observation=observation,
                    ),
                    action_count=self._progress_action_count,
                    model_call_count=self._progress_model_call_count,
                    last_action=self._progress_last_action,
                )
            )
        except BaseException:
            _LOGGER.debug(
                "event=browser-agent-result controller=agent role=browser provider=%s "
                "outcome=interrupted",
                self._provider_name,
            )
            raise

    @staticmethod
    def _debug_observation(stage: str, observation: BrowserObservation) -> None:
        fingerprint = stable_semantic_page_fingerprint(observation).root
        (
            page_id,
            revision,
            page_state,
            capture_state,
            scroll_y,
            scroll_max_y,
            surface_count,
            element_count,
            surface_kind,
        ) = _observation_debug_values(observation)
        _LOGGER.debug(
            "event=browser-agent-observation controller=agent stage=%s page_id=%s "
            "revision=%d page_state=%s agent_status=%s capture_state=%s "
            "surface_count=%d element_count=%d actionable_count=%d "
            "surface_kind=%s root_scroll_y=%.1f root_scroll_max_y=%.1f "
            "screenshot_bytes=%d fingerprint=%s",
            stage,
            page_id,
            revision,
            page_state,
            observation.agent_status.value,
            capture_state,
            surface_count,
            element_count,
            len(observation.actionable_elements),
            surface_kind,
            scroll_y,
            scroll_max_y,
            len(observation.screenshot.content),
            fingerprint,
        )

    def _finish(self, result: BrowserAgentResult) -> BrowserAgentResult:
        page_state = "none" if result.page_state is None else result.page_state.value
        failure = result.failure
        _LOGGER.debug(
            "event=browser-agent-result controller=agent role=browser provider=%s "
            "outcome=%s step=%s blocked_reason=%s page_state=%s capture_state=%s "
            "action_count=%d model_call_count=%d code=%s retryable=%s reason=%s action=%s",
            self._provider_name,
            result.outcome,
            result.step.kind.value,
            ("none" if result.blocked_reason is None else result.blocked_reason.value),
            page_state,
            result.capture_state.value,
            result.action_count,
            result.model_call_count,
            "none" if failure is None else failure.code,
            "none" if failure is None else str(failure.retryable).lower(),
            "none" if failure is None else failure.reason,
            "none" if failure is None else failure.action,
        )
        return result

    def _log_action_decision(
        self,
        action: BrowserAction,
        observation: BrowserObservation,
    ) -> None:
        _LOGGER.debug(
            "event=browser-agent-action controller=agent role=browser provider=%s "
            "action=%s semantic_fingerprint=%s intent_fingerprint=%s",
            self._provider_name,
            action.kind.value,
            stable_semantic_page_fingerprint(observation).root,
            stable_action_intent_fingerprint(action, observation).root,
        )

    def _log_step(
        self,
        step: BrowserStep,
        *,
        requested_action: BrowserAction | None,
    ) -> None:
        receipt = getattr(step, "receipt", None)
        observation = getattr(step, "observation", None)
        semantic_changed = bool(getattr(step, "semantic_changed", False))
        blocked_reason = step.reason.value if isinstance(step, BrowserBlocked) else "none"
        failure_code = step.failure.code if isinstance(step, BrowserFailed) else "none"
        log = _LOGGER.info if receipt is not None else _LOGGER.debug
        log(
            "event=browser-agent-step controller=agent role=browser provider=%s "
            "requested_action=%s action=%s dispatch=%s result=%s "
            "semantic_changed=%s page_state=%s capture_state=%s "
            "blocked_reason=%s failure_code=%s elapsed_ms=%s",
            self._provider_name,
            "none" if requested_action is None else requested_action.kind.value,
            "none" if receipt is None else receipt.action_kind.value,
            "not-dispatched" if receipt is None else receipt.outcome.value,
            step.kind.value,
            str(semantic_changed).lower(),
            "none" if observation is None else observation.page_state.value,
            "none" if observation is None else observation.capture_state.value,
            blocked_reason,
            failure_code,
            "none" if receipt is None else receipt.elapsed_milliseconds,
        )

    def _cancelled_result(
        self,
        action_count: int,
        model_call_count: int,
        observation: BrowserObservation | None,
        last_action: BrowserAction | None,
    ) -> BrowserAgentResult:
        return self._finish(
            BrowserAgentResult(
                step=BrowserCancelled(observation),
                action_count=action_count,
                model_call_count=model_call_count,
                last_action=last_action,
            )
        )

    def _failed_result(
        self,
        failure: AccessFailure,
        *,
        action_count: int,
        model_call_count: int,
        observation: BrowserObservation | None,
        last_action: BrowserAction | None,
    ) -> BrowserAgentResult:
        return self._finish(
            BrowserAgentResult(
                step=BrowserFailed(failure=failure, observation=observation),
                action_count=action_count,
                model_call_count=model_call_count,
                last_action=last_action,
            )
        )

    def _choose_action(
        self,
        observation: BrowserObservation,
        previous_step: _BrowserStepFeedback | None,
    ) -> BrowserAction | BrowserFailed | BrowserCancelled:
        call = build_browser_agent_call(
            observation,
            previous_step,
            self._article_goal,
        )
        try:
            decision = self._runtime.execute(call, cancel_event=self._cancel_event)
        except AgentFailure as error:
            if error.failure.code == "agent-cancelled":
                return BrowserCancelled(observation)
            return _agent_failure_step(error.failure, observation)
        if self._cancel_event is not None and self._cancel_event.is_set():
            return BrowserCancelled(observation)
        if not isinstance(decision, AgentToolCall):
            return BrowserFailed(
                failure=_controller_failure("internal"),
                observation=observation,
            )
        try:
            action = action_from_agent_tool_call(decision, observation)
            self._log_action_decision(action, observation)
        except (TypeError, ValueError):
            return BrowserFailed(
                failure=_controller_failure("action"),
                observation=observation,
            )
        return action

    def _run_loop(self, steps: BrowserStepSession) -> BrowserAgentResult:
        action_count = 0
        model_call_count = 0
        transient_call_retries = 0
        last_action: BrowserAction | None = None
        previous_step: _BrowserStepFeedback | None = None
        if self._cancel_event is not None and self._cancel_event.is_set():
            return self._cancelled_result(0, 0, None, None)
        step = steps.start()
        self._log_step(step, requested_action=None)

        while isinstance(step, BrowserReady):
            observation = step.observation
            self._progress_observation = observation
            self._debug_observation("before-call", observation)
            if self._cancel_event is not None and self._cancel_event.is_set():
                return self._cancelled_result(
                    action_count,
                    model_call_count,
                    observation,
                    last_action,
                )
            if model_call_count >= _BROWSER_AGENT_MAX_MODEL_CALLS:
                return self._failed_result(
                    _controller_failure("safety"),
                    action_count=action_count,
                    model_call_count=model_call_count,
                    observation=observation,
                    last_action=last_action,
                )

            model_call_count += 1
            self._progress_model_call_count = model_call_count
            choice = self._choose_action(observation, previous_step)
            if isinstance(choice, BrowserFailed):
                failure = choice.failure
                if (
                    failure.retryable
                    and failure.code in _TRANSIENT_BROWSER_AGENT_FAILURES
                    and transient_call_retries < _BROWSER_AGENT_MAX_TRANSIENT_CALL_RETRIES
                    and model_call_count < _BROWSER_AGENT_MAX_MODEL_CALLS
                ):
                    transient_call_retries += 1
                    _LOGGER.debug(
                        "event=browser-agent-call-retry controller=agent role=browser "
                        "provider=%s retry=%d max_retries=%d code=%s",
                        self._provider_name,
                        transient_call_retries,
                        _BROWSER_AGENT_MAX_TRANSIENT_CALL_RETRIES,
                        failure.code,
                    )
                    continue
                return self._terminal_result(
                    choice,
                    action_count=action_count,
                    model_call_count=model_call_count,
                    last_action=last_action,
                )
            if isinstance(choice, BrowserCancelled):
                return self._terminal_result(
                    choice,
                    action_count=action_count,
                    model_call_count=model_call_count,
                    last_action=last_action,
                )
            action = choice
            transient_call_retries = 0

            step = steps.apply(action)
            self._log_step(step, requested_action=action)
            previous_step = _step_feedback(step, action)
            action_count, last_action = self._record_step_progress(
                step,
                action,
                action_count=action_count,
                last_action=last_action,
            )

        return self._terminal_result(
            step,
            action_count=action_count,
            model_call_count=model_call_count,
            last_action=last_action,
        )

    def _record_step_progress(
        self,
        step: BrowserStep,
        action: BrowserAction,
        *,
        action_count: int,
        last_action: BrowserAction | None,
    ) -> tuple[int, BrowserAction | None]:
        if getattr(step, "receipt", None) is not None:
            action_count += 1
            last_action = action
            self._progress_action_count = action_count
            self._progress_last_action = action
        observation = getattr(step, "observation", None)
        if isinstance(observation, BrowserObservation):
            self._progress_observation = observation
            if isinstance(step, BrowserReady):
                self._debug_observation("after-step", observation)
        return action_count, last_action

    def _terminal_result(
        self,
        step: BrowserStep,
        *,
        action_count: int,
        model_call_count: int,
        last_action: BrowserAction | None,
    ) -> BrowserAgentResult:
        if not isinstance(
            step,
            (BrowserCaptured, BrowserBlocked, BrowserFailed, BrowserCancelled),
        ):
            raise TypeError("Browser step result was not exhaustive")
        return self._finish(
            BrowserAgentResult(
                step=step,
                action_count=action_count,
                model_call_count=model_call_count,
                last_action=last_action,
            )
        )


__all__ = (
    "AgentBrowserController",
    "BrowserAgentResult",
    "BrowserArticleGoal",
    "BrowserStepSessionFactory",
    "action_from_agent_tool_call",
    "browser_agent_tool_declarations",
    "build_browser_agent_call",
)
