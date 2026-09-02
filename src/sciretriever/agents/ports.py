"""Internal Provider wire value and Port for one stateless Agent call."""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from sciretriever.model.configuration import AgentReasoningEffort
from sciretriever.model.primitives import Sha256

from .calls import AgentCallLimits, AgentResult
from .capabilities import AgentCapability, AgentRole
from .messages import AgentImagePart, AgentTextPart, _model_identity
from .tools import AgentToolDeclaration


@dataclass(frozen=True, slots=True, repr=False)
class AgentProviderCall:
    """Runtime-bound, request-local wire value visible only inside Agents."""

    role: AgentRole
    capabilities: frozenset[AgentCapability]
    model: str
    input_sha256: Sha256
    text_parts: tuple[AgentTextPart, ...]
    image_parts: tuple[AgentImagePart, ...]
    response_schema: str | None = field(default=None, repr=False)
    tools: tuple[AgentToolDeclaration, ...] = ()
    max_output_tokens: int = 1
    reasoning_effort: AgentReasoningEffort = AgentReasoningEffort.PROVIDER_DEFAULT
    stream: bool = True
    limits: AgentCallLimits = AgentCallLimits()
    cancel_event: threading.Event | None = field(default=None, repr=False)

    def __post_init__(self) -> None:  # noqa: C901
        if not isinstance(self.role, AgentRole):
            raise TypeError("role must be AgentRole")
        if not isinstance(self.capabilities, frozenset) or any(
            not isinstance(value, AgentCapability) for value in self.capabilities
        ):
            raise TypeError("capabilities must be AgentCapability values")
        object.__setattr__(self, "model", _model_identity(self.model))
        if not isinstance(self.input_sha256, Sha256):
            raise TypeError("input_sha256 must be Sha256")
        if not isinstance(self.text_parts, tuple) or any(
            not isinstance(value, AgentTextPart) for value in self.text_parts
        ):
            raise TypeError("text_parts must contain AgentTextPart values")
        if not isinstance(self.image_parts, tuple) or any(
            not isinstance(value, AgentImagePart) for value in self.image_parts
        ):
            raise TypeError("image_parts must contain AgentImagePart values")
        if not isinstance(self.tools, tuple) or any(
            not isinstance(value, AgentToolDeclaration) for value in self.tools
        ):
            raise TypeError("tools must contain AgentToolDeclaration values")
        if type(self.max_output_tokens) is not int or self.max_output_tokens < 1:
            raise ValueError("max_output_tokens must be positive")
        if not isinstance(self.reasoning_effort, AgentReasoningEffort):
            raise TypeError("reasoning_effort must be an AgentReasoningEffort")
        if type(self.stream) is not bool:
            raise TypeError("stream must be bool")
        if not isinstance(self.limits, AgentCallLimits):
            raise TypeError("limits must be AgentCallLimits")
        if self.cancel_event is not None and not callable(
            getattr(self.cancel_event, "is_set", None)
        ):
            raise TypeError("cancel_event must expose is_set()")

    @property
    def system_text(self) -> str:
        return self.text_parts[0].text if self.text_parts else ""

    @property
    def prompt(self) -> str:
        return self.system_text


@runtime_checkable
class AgentProviderPort(Protocol):
    """One adapter invocation after Runtime has bound model and limits."""

    @property
    def provider_name(self) -> str: ...

    def execute(self, call: AgentProviderCall) -> AgentResult: ...


__all__ = ("AgentProviderCall", "AgentProviderPort")
