"""Request-local bounded Agent sessions for future Browser turns."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field, replace
from typing import Protocol, cast

from .failures import agent_failure
from .ports import AgentPort
from .requests import (
    AgentBudget,
    AgentRequest,
    AgentResult,
    AgentStructuredResponse,
    AgentToolDecision,
    canonical_json_bytes,
    parse_strict_json_object,
    utf8_size,
)


class _CancellationLike(Protocol):
    def is_set(self) -> bool: ...


class _CancellationSignal:
    __slots__ = ("_signals",)

    def __init__(self, signals: tuple[_CancellationLike, ...]) -> None:
        self._signals = signals

    def is_set(self) -> bool:
        return any(signal.is_set() for signal in self._signals)


@dataclass(slots=True)
class AgentSession:
    """A short-lived, explicitly closed multi-turn session.

    The session retains only neutral requests/results and never persists them.
    It is deliberately not thread-safe; callers serialize turns per article.
    """

    port: AgentPort
    max_turns: int = 8
    cancel_event: threading.Event | None = None
    budget: AgentBudget = AgentBudget()
    _turns: int = field(default=0, init=False)
    _closed: bool = field(default=False, init=False)
    _history: list[AgentResult] = field(default_factory=list, init=False, repr=False)
    _started_at: float | None = field(default=None, init=False, repr=False)
    _input_bytes: int = field(default=0, init=False, repr=False)
    _output_tokens: int = field(default=0, init=False, repr=False)
    _response_bytes: int = field(default=0, init=False, repr=False)
    _result_bytes: int = field(default=0, init=False, repr=False)

    def __post_init__(self) -> None:
        if not isinstance(self.port, AgentPort):
            raise TypeError("port must implement AgentPort")
        if type(self.max_turns) is not int or self.max_turns < 1:
            raise ValueError("max_turns must be positive")
        if not isinstance(self.budget, AgentBudget):
            raise TypeError("budget must be an AgentBudget")

    @property
    def turns(self) -> int:
        return self._turns

    def complete(self, request: AgentRequest) -> AgentResult:
        effective = self._validate_turn(request)
        session_request = replace(
            request,
            history=tuple(self._history),
            budget=effective,
            cancel_event=cast(threading.Event | None, self._cancel_signal(request)),
        )
        input_bytes = self._serialized_input_size(session_request)
        self._check_session_input(effective, input_bytes)
        self._input_bytes += input_bytes
        self._turns += 1
        result = self.port.complete(session_request)
        if not isinstance(result, (AgentStructuredResponse, AgentToolDecision)):
            raise TypeError("Agent port returned an unsupported result")
        self._record_result(result, effective)
        return result

    def _validate_turn(self, request: AgentRequest) -> AgentBudget:
        if self._closed:
            raise agent_failure("cleanup")
        if not isinstance(request, AgentRequest):
            raise TypeError("request must be an AgentRequest")
        if self._turns >= self.max_turns:
            raise agent_failure("output-budget")
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise agent_failure("cancelled")
        if request.cancel_event is not None and request.cancel_event.is_set():
            raise agent_failure("cancelled")
        now = time.monotonic()
        if self._started_at is None:
            self._started_at = now
        effective = AgentBudget.stricter(self.budget, request.budget)
        if request.max_output_tokens > effective.max_output_tokens:
            raise agent_failure("output-budget")
        elapsed = now - self._started_at
        remaining = effective.overall_timeout_seconds - elapsed
        if remaining <= 0:
            raise agent_failure("timeout")
        return replace(
            effective,
            connect_timeout_seconds=min(effective.connect_timeout_seconds, remaining),
            read_timeout_seconds=min(effective.read_timeout_seconds, remaining),
            overall_timeout_seconds=remaining,
        )

    def _cancel_signal(self, request: AgentRequest) -> _CancellationLike | None:
        values: list[_CancellationLike] = []
        for signal in (self.cancel_event, request.cancel_event):
            if signal is not None and all(signal is not existing for existing in values):
                values.append(cast(_CancellationLike, signal))
        if not values:
            return None
        if len(values) == 1:
            return values[0]
        return _CancellationSignal(tuple(values))

    def _check_session_input(self, budget: AgentBudget, input_bytes: int) -> None:
        if self._input_bytes + input_bytes > budget.max_input_bytes:
            raise agent_failure("input-budget")

    @staticmethod
    def _serialized_input_size(request: AgentRequest) -> int:
        history: list[dict[str, object]] = []
        for index, result in enumerate(request.history):
            if isinstance(result, AgentStructuredResponse):
                payload: object = parse_strict_json_object(result.result)
            else:
                payload = {
                    "tool_name": result.tool_name,
                    "arguments": parse_strict_json_object(result.arguments),
                }
            history.append({"turn": index + 1, "result": payload})
        value = {
            "text": [part.text for part in request.text_parts],
            "images": [
                {
                    "media_type": image.media_type,
                    "width": image.width,
                    "height": image.height,
                    "bytes": len(image.data),
                }
                for image in request.image_parts
            ],
            "schema": request.response_schema,
            "tools": [
                {
                    "name": tool.name,
                    "schema": parse_strict_json_object(tool.input_schema),
                }
                for tool in request.tools
            ],
            "history": history,
        }
        serialized = len(canonical_json_bytes(value))
        # The canonical descriptor intentionally avoids retaining image bytes,
        # but the operation budget must still account for every byte sent.
        return serialized + sum(len(image.data) for image in request.image_parts)

    def _record_result(self, result: AgentResult, budget: AgentBudget) -> None:
        usage = result.provenance.usage
        next_output_tokens = self._output_tokens + usage.output_tokens
        next_response_bytes = self._response_bytes + usage.response_bytes
        result_bytes = utf8_size(
            result.result if isinstance(result, AgentStructuredResponse) else result.arguments
        )
        next_result_bytes = self._result_bytes + result_bytes
        if next_output_tokens > budget.max_output_tokens:
            raise agent_failure("output-budget")
        if next_response_bytes > budget.max_response_bytes:
            raise agent_failure("response-budget")
        if next_result_bytes > budget.max_result_bytes:
            raise agent_failure("result-budget")
        self._history.append(result)
        self._output_tokens += usage.output_tokens
        self._response_bytes += usage.response_bytes
        self._result_bytes = next_result_bytes

    def close(self) -> None:
        self._history.clear()
        self._started_at = None
        self._input_bytes = 0
        self._output_tokens = 0
        self._response_bytes = 0
        self._result_bytes = 0
        self._closed = True

    def __enter__(self) -> AgentSession:
        return self

    def __exit__(self, *unused: object) -> None:
        self.close()


__all__ = ("AgentSession",)
