"""Acquisition-owned controlled Browser controller contracts.

Rules and Agent modes are selected before an article Browser flow starts.  A
Rules controller executes one finite, reviewed Publisher program and never
constructs a model call.  An Agent controller observes the current article,
asks the shared stateless Agents runtime for exactly one closed action, and
hands that action back to Network for validation and execution.

No Browser vendor object, selector, arbitrary URL, Profile, Cookie, CDP handle,
filesystem capability, or PDF publishing capability crosses this boundary.
"""

from __future__ import annotations

import json
import math
import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import Enum, unique
from typing import Final, Protocol, runtime_checkable

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
from sciretriever.model.report import StableFailure
from sciretriever.network.browser import BrowserFlowSession
from sciretriever.network.browser_control import (
    BrowserAction,
    BrowserActionOutcome,
    BrowserActionReceipt,
    BrowserCaptureState,
    BrowserObservation,
    BrowserPageState,
    ClickElement,
    ClickPoint,
    GoBack,
    ScrollSurface,
    Stop,
    WaitForChange,
    action_fingerprint,
    observation_hash,
    semantic_page_fingerprint,
)

_BROWSER_AGENT_MAX_OUTPUT_TOKENS: Final[int] = 256
_BROWSER_ACTION_TIMEOUT_SECONDS: Final[float] = 10.0
_LOGGER = get_logger(__name__)
_STOP_REASONS: Final[tuple[str, ...]] = (
    "normal-miss",
    "not-actionable",
    "no-progress",
)

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
    "when the primary PDF cannot be reached safely with these closed actions."
)


@unique
class BrowserControllerKind(str, Enum):
    """The mutually exclusive controller selected for one Browser job."""

    RULES = "rules"
    AGENT = "agent"


@runtime_checkable
class BrowserRuleExecution(Protocol):
    """One finite, reviewed Publisher rule execution owned by Acquisition."""

    def run(self, session: BrowserFlowSession) -> None: ...


@dataclass(frozen=True, slots=True, repr=False)
class RuleBrowserController:
    """Run one deterministic execution without constructing an Agent call."""

    execution: BrowserRuleExecution

    def __post_init__(self) -> None:
        if not isinstance(self.execution, BrowserRuleExecution):
            raise TypeError("execution must implement BrowserRuleExecution")

    def run(self, session: BrowserFlowSession) -> None:
        if not isinstance(session, BrowserFlowSession):
            raise TypeError("session must implement BrowserFlowSession")
        _LOGGER.debug("event=browser-controller-start controller=rules")
        try:
            self.execution.run(session)
        except BaseException:
            _LOGGER.debug("event=browser-controller-result controller=rules result=failure")
            raise
        _LOGGER.debug("event=browser-controller-result controller=rules result=completed")


@runtime_checkable
class BrowserAgentControlSession(Protocol):
    """Acquisition-classified view of Network's article-local control handle."""

    def observe(self) -> BrowserObservation: ...

    def execute(
        self,
        action: BrowserAction,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserActionReceipt: ...


@runtime_checkable
class BrowserAgentControlFactory(Protocol):
    """Bind Publisher classification to one request-local Network session."""

    def open(self, session: BrowserFlowSession) -> BrowserAgentControlSession: ...


@unique
class BrowserAgentDisposition(str, Enum):
    """Natural terminal outcomes of one Agent-controlled article flow."""

    CAPTURE_AVAILABLE = "capture-available"
    PAGE_TERMINAL = "page-terminal"
    STOPPED = "stopped"
    CANCELLED = "cancelled"
    NO_PROGRESS = "no-progress"
    FAILED = "failed"


@dataclass(frozen=True, slots=True, repr=False)
class BrowserAgentResult:
    """Payload-free summary retained only for the current article attempt."""

    disposition: BrowserAgentDisposition
    action_count: int
    page_state: BrowserPageState | None
    capture_state: BrowserCaptureState
    last_action: BrowserAction | None = field(default=None, repr=False)
    failure: StableFailure | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if not isinstance(self.disposition, BrowserAgentDisposition):
            raise TypeError("disposition must be BrowserAgentDisposition")
        if type(self.action_count) is not int or self.action_count < 0:
            raise ValueError("action_count must be a nonnegative integer")
        if self.page_state is not None and not isinstance(self.page_state, BrowserPageState):
            raise TypeError("page_state must be BrowserPageState or None")
        if not isinstance(self.capture_state, BrowserCaptureState):
            raise TypeError("capture_state must be BrowserCaptureState")
        if self.last_action is not None and not isinstance(
            self.last_action,
            (ClickElement, ClickPoint, ScrollSurface, GoBack, WaitForChange, Stop),
        ):
            raise TypeError("last_action must be a closed Browser action")
        if self.failure is not None and not isinstance(self.failure, StableFailure):
            raise TypeError("failure must be StableFailure or None")
        requires_failure = self.disposition in {
            BrowserAgentDisposition.CANCELLED,
            BrowserAgentDisposition.FAILED,
        }
        if requires_failure != (self.failure is not None):
            raise ValueError("only cancelled and failed results require a failure")


def _controller_failure(kind: str) -> StableFailure:
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
    }
    try:
        code, reason, action, retryable = values[kind]
    except KeyError:
        raise ValueError("unknown Browser Agent failure kind") from None
    return StableFailure(code=code, reason=reason, action=action, retryable=retryable)


def _terminal_page(page_state: BrowserPageState) -> bool:
    return page_state in {
        BrowserPageState.LOGIN_REQUIRED,
        BrowserPageState.MFA_REQUIRED,
        BrowserPageState.NOT_ENTITLED,
        BrowserPageState.ACCESS_DENIED,
        BrowserPageState.NOT_FOUND,
        BrowserPageState.FAILED,
    }


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


def _observation_summary(observation: BrowserObservation) -> str:
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
    }
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def build_browser_agent_call(observation: BrowserObservation) -> AgentCall:
    """Build one independent Browser-role call for one exact observation."""

    if not isinstance(observation, BrowserObservation):
        raise TypeError("observation must be BrowserObservation")
    return AgentCall(
        role=AgentRole.BROWSER,
        required_capabilities=frozenset(
            {AgentCapability.IMAGE_INPUT, AgentCapability.TOOL_DECISION}
        ),
        input_sha256=observation_hash(observation),
        text_parts=(
            AgentTextPart(media_type="text/plain", text=_BROWSER_AGENT_SYSTEM_INSTRUCTION),
            AgentTextPart(
                media_type="application/json",
                text=_observation_summary(observation),
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
        max_output_tokens=_BROWSER_AGENT_MAX_OUTPUT_TOKENS,
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
    """Stateless-per-decision Browser loop over one request-local article."""

    __slots__ = (
        "_action_timeout_seconds",
        "_cancel_event",
        "_control_factory",
        "_result",
        "_runtime",
        "_started",
    )

    def __init__(
        self,
        *,
        runtime: AgentRuntime,
        control_factory: BrowserAgentControlFactory,
        cancel_event: threading.Event | None = None,
        action_timeout_seconds: float = _BROWSER_ACTION_TIMEOUT_SECONDS,
    ) -> None:
        if not isinstance(runtime, AgentRuntime):
            raise TypeError("runtime must be AgentRuntime")
        if not isinstance(control_factory, BrowserAgentControlFactory):
            raise TypeError("control_factory must implement BrowserAgentControlFactory")
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
        self._control_factory = control_factory
        self._cancel_event = cancel_event
        self._action_timeout_seconds = timeout
        self._result: BrowserAgentResult | None = None
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
        control = self._control_factory.open(session)
        if not isinstance(control, BrowserAgentControlSession):
            raise TypeError("control factory returned an invalid control session")
        _LOGGER.debug(
            "event=browser-controller-start controller=agent role=browser provider=%s",
            self._runtime.provider_name,
        )
        try:
            self._result = self._run_loop(control)
        except BaseException:
            _LOGGER.debug(
                "event=browser-agent-result controller=agent role=browser provider=%s "
                "outcome=failed code=browser-agent-internal retryable=false "
                "reason=The Browser Agent controller encountered an internal error. "
                "action=Review the Debug transcript and controller implementation.",
                self._runtime.provider_name,
            )
            raise

    @staticmethod
    def _debug_observation(stage: str, observation: BrowserObservation) -> None:
        fingerprint = semantic_page_fingerprint(observation).root
        _LOGGER.debug(
            "event=browser-agent-observation controller=agent stage=%s revision=%d "
            "page_state=%s agent_status=%s capture_state=%s surface_count=%d "
            "element_count=%d actionable_count=%d screenshot_bytes=%d fingerprint=%s",
            stage,
            observation.revision,
            observation.page_state.value,
            observation.agent_status.value,
            observation.capture_state.value,
            len(observation.surfaces),
            len(observation.elements),
            len(observation.actionable_elements),
            len(observation.screenshot.content),
            fingerprint,
        )

    def _finish(self, result: BrowserAgentResult) -> BrowserAgentResult:
        page_state = "none" if result.page_state is None else result.page_state.value
        if result.failure is None:
            _LOGGER.debug(
                "event=browser-agent-result controller=agent role=browser provider=%s "
                "outcome=%s page_state=%s capture_state=%s action_count=%d",
                self._runtime.provider_name,
                result.disposition.value,
                page_state,
                result.capture_state.value,
                result.action_count,
            )
        else:
            _LOGGER.debug(
                "event=browser-agent-result controller=agent role=browser provider=%s "
                "outcome=%s page_state=%s capture_state=%s action_count=%d "
                "code=%s retryable=%s reason=%s action=%s",
                self._runtime.provider_name,
                result.disposition.value,
                page_state,
                result.capture_state.value,
                result.action_count,
                result.failure.code,
                str(result.failure.retryable).lower(),
                result.failure.reason,
                result.failure.action,
            )
        return result

    def _log_action_decision(
        self,
        action: BrowserAction,
        *,
        before_fingerprint: str,
        action_key: str,
    ) -> None:
        _LOGGER.debug(
            "event=browser-agent-action controller=agent role=browser provider=%s "
            "action=%s before_fingerprint=%s action_fingerprint=%s",
            self._runtime.provider_name,
            action.kind.value,
            before_fingerprint,
            action_key,
        )

    def _log_action_receipt(self, receipt: BrowserActionReceipt) -> None:
        failure_code = "none" if receipt.failure_code is None else receipt.failure_code
        _LOGGER.debug(
            "event=browser-agent-action-result controller=agent role=browser provider=%s "
            "action=%s result=%s failure=%s",
            self._runtime.provider_name,
            receipt.action_kind.value,
            receipt.outcome.value,
            failure_code,
        )
        _LOGGER.debug(
            "event=browser-agent-receipt controller=agent action=%s result=%s "
            "before_revision=%d after_revision=%s elapsed_ms=%d failure=%s",
            receipt.action_kind.value,
            receipt.outcome.value,
            receipt.before_revision,
            "none" if receipt.after_revision is None else receipt.after_revision,
            receipt.elapsed_milliseconds,
            failure_code,
        )

    def _cancelled_result(
        self,
        action_count: int,
        observation: BrowserObservation | None,
        last_action: BrowserAction | None,
        failure: StableFailure | None = None,
    ) -> BrowserAgentResult:
        return self._finish(
            BrowserAgentResult(
                disposition=BrowserAgentDisposition.CANCELLED,
                action_count=action_count,
                page_state=None if observation is None else observation.page_state,
                capture_state=(
                    BrowserCaptureState.NONE if observation is None else observation.capture_state
                ),
                last_action=last_action,
                failure=_controller_failure("cancelled") if failure is None else failure,
            )
        )

    def _run_loop(self, control: BrowserAgentControlSession) -> BrowserAgentResult:  # noqa: C901
        transitions: dict[tuple[str, str], str] = {}
        action_count = 0
        last_action: BrowserAction | None = None
        observation: BrowserObservation | None = None
        while True:
            if self._cancel_event is not None and self._cancel_event.is_set():
                return self._cancelled_result(action_count, observation, last_action)
            observation = control.observe()
            if not isinstance(observation, BrowserObservation):
                raise TypeError("Browser control returned an invalid observation")
            self._debug_observation("before-call", observation)
            if observation.capture_state is not BrowserCaptureState.NONE:
                return self._finish(
                    BrowserAgentResult(
                        BrowserAgentDisposition.CAPTURE_AVAILABLE,
                        action_count,
                        observation.page_state,
                        observation.capture_state,
                        last_action,
                    )
                )
            if _terminal_page(observation.page_state):
                return self._finish(
                    BrowserAgentResult(
                        BrowserAgentDisposition.PAGE_TERMINAL,
                        action_count,
                        observation.page_state,
                        observation.capture_state,
                        last_action,
                    )
                )
            call = build_browser_agent_call(observation)
            try:
                decision = self._runtime.execute(call, cancel_event=self._cancel_event)
            except AgentFailure as error:
                if error.failure.code == "agent-cancelled":
                    return self._cancelled_result(
                        action_count,
                        observation,
                        last_action,
                        error.failure,
                    )
                return self._finish(
                    BrowserAgentResult(
                        BrowserAgentDisposition.FAILED,
                        action_count,
                        observation.page_state,
                        observation.capture_state,
                        last_action,
                        error.failure,
                    )
                )
            if self._cancel_event is not None and self._cancel_event.is_set():
                return self._cancelled_result(action_count, observation, last_action)
            if not isinstance(decision, AgentToolCall):
                raise TypeError("Browser Agent runtime returned a non-tool result")

            # A capture or page mutation can arrive while the model call is in
            # flight.  Refresh before parsing or executing any late action.
            current = control.observe()
            if not isinstance(current, BrowserObservation):
                raise TypeError("Browser control returned an invalid observation")
            self._debug_observation("after-call", current)
            if current.capture_state is not BrowserCaptureState.NONE:
                return self._finish(
                    BrowserAgentResult(
                        BrowserAgentDisposition.CAPTURE_AVAILABLE,
                        action_count,
                        current.page_state,
                        current.capture_state,
                        last_action,
                    )
                )
            if _terminal_page(current.page_state):
                return self._finish(
                    BrowserAgentResult(
                        BrowserAgentDisposition.PAGE_TERMINAL,
                        action_count,
                        current.page_state,
                        current.capture_state,
                        last_action,
                    )
                )
            if observation_hash(current) != observation_hash(observation):
                # No stale action reaches Network.  The next loop iteration
                # constructs a fresh independent call for the new observation.
                observation = current
                continue
            try:
                action = action_from_agent_tool_call(decision, current)
            except (TypeError, ValueError):
                return self._finish(
                    BrowserAgentResult(
                        BrowserAgentDisposition.FAILED,
                        action_count,
                        current.page_state,
                        current.capture_state,
                        last_action,
                        _controller_failure("action"),
                    )
                )

            before = semantic_page_fingerprint(current).root
            action_key = action_fingerprint(action).root
            transition_key = (before, action_key)
            self._log_action_decision(
                action,
                before_fingerprint=before,
                action_key=action_key,
            )
            if transitions.get(transition_key) == before:
                return self._finish(
                    BrowserAgentResult(
                        BrowserAgentDisposition.NO_PROGRESS,
                        action_count,
                        current.page_state,
                        current.capture_state,
                        action,
                    )
                )
            receipt = control.execute(
                action,
                current,
                timeout_seconds=self._action_timeout_seconds,
            )
            if not isinstance(receipt, BrowserActionReceipt):
                raise TypeError("Browser control returned an invalid action receipt")
            self._log_action_receipt(receipt)
            action_count += 1
            last_action = action
            if receipt.outcome is BrowserActionOutcome.FAILURE:
                return self._finish(
                    BrowserAgentResult(
                        BrowserAgentDisposition.FAILED,
                        action_count,
                        current.page_state,
                        current.capture_state,
                        last_action,
                        _controller_failure("receipt"),
                    )
                )
            if isinstance(action, Stop):
                return self._finish(
                    BrowserAgentResult(
                        BrowserAgentDisposition.STOPPED,
                        action_count,
                        current.page_state,
                        current.capture_state,
                        last_action,
                    )
                )

            resulting = control.observe()
            if not isinstance(resulting, BrowserObservation):
                raise TypeError("Browser control returned an invalid observation")
            self._debug_observation("after-action", resulting)
            after = semantic_page_fingerprint(resulting).root
            transitions[transition_key] = after
            if resulting.capture_state is not BrowserCaptureState.NONE:
                return self._finish(
                    BrowserAgentResult(
                        BrowserAgentDisposition.CAPTURE_AVAILABLE,
                        action_count,
                        resulting.page_state,
                        resulting.capture_state,
                        last_action,
                    )
                )
            if _terminal_page(resulting.page_state):
                return self._finish(
                    BrowserAgentResult(
                        BrowserAgentDisposition.PAGE_TERMINAL,
                        action_count,
                        resulting.page_state,
                        resulting.capture_state,
                        last_action,
                    )
                )
            if after == before:
                return self._finish(
                    BrowserAgentResult(
                        BrowserAgentDisposition.NO_PROGRESS,
                        action_count,
                        resulting.page_state,
                        resulting.capture_state,
                        last_action,
                    )
                )
            observation = resulting


__all__ = (
    "AgentBrowserController",
    "BrowserAgentControlFactory",
    "BrowserAgentControlSession",
    "BrowserAgentDisposition",
    "BrowserAgentResult",
    "BrowserControllerKind",
    "BrowserRuleExecution",
    "RuleBrowserController",
    "action_from_agent_tool_call",
    "browser_agent_tool_declarations",
    "build_browser_agent_call",
)
