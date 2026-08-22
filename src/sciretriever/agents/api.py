"""Small consumer-facing construction helpers for the Agents boundary."""

from __future__ import annotations

import threading
from dataclasses import dataclass

from sciretriever.logging.api import get_logger

from .capabilities import (
    AgentCapabilityReadiness,
    AgentModelCapabilities,
    AgentReadiness,
    capability_missing,
    required_capabilities,
)
from .failures import AgentFailure, agent_failure
from .ports import AgentPort
from .requests import (
    AgentBudget,
    AgentRequest,
    AgentResult,
    AgentRole,
    AgentStructuredResponse,
    AgentToolDecision,
    _model_identity,
    utf8_size,
)
from .sessions import AgentSession

_LOGGER = get_logger("sciretriever.agents")


@dataclass(frozen=True, slots=True)
class AgentRoleBinding:
    """One configured role's model identity and declared capabilities."""

    role: AgentRole
    model: str
    capabilities: AgentModelCapabilities

    def __post_init__(self) -> None:
        if not isinstance(self.role, AgentRole):
            raise TypeError("role must be an AgentRole")
        model = _model_identity(self.model)
        object.__setattr__(self, "model", model)
        if not isinstance(self.capabilities, AgentModelCapabilities):
            raise TypeError("role capabilities must be AgentModelCapabilities")


@dataclass(frozen=True, slots=True)
class AgentRuntime:
    """One adapter shared by independently configured Analysis/Browser roles."""

    adapter: AgentPort
    analysis: AgentRoleBinding | None = None
    browser: AgentRoleBinding | None = None
    protocol_supported: bool = True

    def __post_init__(self) -> None:
        if not isinstance(self.adapter, AgentPort):
            raise TypeError("adapter must implement AgentPort")
        if type(self.protocol_supported) is not bool:
            raise TypeError("protocol_supported must be bool")
        if self.analysis is not None and self.analysis.role is not AgentRole.ANALYSIS:
            raise ValueError("analysis slot requires an analysis role binding")
        if self.browser is not None and self.browser.role is not AgentRole.BROWSER:
            raise ValueError("browser slot requires a browser role binding")

    @property
    def provider_name(self) -> str:
        return self.adapter.provider_name

    @property
    def readiness(self) -> AgentReadiness:
        return AgentReadiness(
            analysis=self._role_readiness(AgentRole.ANALYSIS, self.analysis),
            browser=self._role_readiness(AgentRole.BROWSER, self.browser),
        )

    def complete(self, request: AgentRequest) -> AgentResult:
        if not isinstance(request, AgentRequest):
            raise TypeError("request must be an AgentRequest")
        binding = self.analysis if request.role is AgentRole.ANALYSIS else self.browser
        if (
            not self.protocol_supported
            or binding is None
            or binding.role is not request.role
            or request.model != binding.model
        ):
            _LOGGER.info(
                "agent.call.result role=%s provider=%s model=%s capabilities=%s "
                "result=failure failure=agent-capability",
                request.role.value,
                self.provider_name,
                request.model,
                _capability_names(request),
            )
            raise agent_failure("capability")
        missing = capability_missing(request.capabilities, binding.capabilities)
        if missing:
            _LOGGER.info(
                "agent.call.result role=%s provider=%s model=%s capabilities=%s "
                "result=failure failure=agent-capability",
                request.role.value,
                self.provider_name,
                request.model,
                _capability_names(request),
            )
            raise agent_failure("capability")
        try:
            self._validate_model_limits(request, binding.capabilities)
        except AgentFailure as error:
            _LOGGER.info(
                "agent.call.result role=%s provider=%s model=%s capabilities=%s "
                "result=failure failure=%s",
                request.role.value,
                self.provider_name,
                request.model,
                _capability_names(request),
                error.failure.code,
            )
            raise
        return self.adapter.complete(request)

    @staticmethod
    def _validate_model_limits(
        request: AgentRequest,
        capabilities: AgentModelCapabilities,
    ) -> None:
        if request.max_output_tokens > request.budget.max_output_tokens or (
            request.max_output_tokens > capabilities.max_output_tokens
        ):
            raise agent_failure("output-budget")
        _validate_image_limits(request, capabilities)
        input_bytes = _model_input_bytes(request)
        if input_bytes > request.budget.max_input_bytes:
            raise agent_failure("input-budget")
        context_limit = min(
            request.budget.context_window_tokens,
            capabilities.context_window_tokens,
        )
        # No provider tokenizer is part of this neutral boundary.  One token per
        # UTF-8 byte is a safe upper bound; a byte/3 estimate can undercount
        # punctuation-heavy or non-ASCII input and let an over-budget call out.
        if input_bytes + request.max_output_tokens > context_limit:
            raise agent_failure("context-budget")

    def _role_readiness(
        self,
        role: AgentRole,
        binding: AgentRoleBinding | None,
    ) -> AgentCapabilityReadiness:
        if binding is None:
            return AgentCapabilityReadiness(
                role=role,
                configured=False,
                protocol_supported=self.protocol_supported,
                model_declared=False,
                missing=required_capabilities(role),
            )
        return AgentCapabilityReadiness(
            role=role,
            configured=True,
            protocol_supported=self.protocol_supported,
            model_declared=True,
            missing=capability_missing(required_capabilities(role), binding.capabilities),
        )


def open_session(
    port: AgentPort,
    *,
    max_turns: int = 8,
    cancel_event: threading.Event | None = None,
    budget: AgentBudget | None = None,
) -> AgentSession:
    """Create one request-local session for a single consumer flow.

    The budget is fixed for the lifetime of this request-local session.  Keeping
    construction here prevents consumers from depending on provider adapters or
    private session state.
    """

    selected_budget = AgentBudget() if budget is None else budget
    if not isinstance(selected_budget, AgentBudget):
        raise TypeError("budget must be an AgentBudget")
    return AgentSession(
        port=port,
        max_turns=max_turns,
        cancel_event=cancel_event,
        budget=selected_budget,
    )


def _capability_names(request: AgentRequest) -> str:
    return ",".join(sorted(value.value for value in request.capabilities))


def _validate_image_limits(
    request: AgentRequest,
    capabilities: AgentModelCapabilities,
) -> None:
    if not request.image_parts:
        return
    if len(request.image_parts) > capabilities.max_image_count:
        raise agent_failure("capability")
    if sum(len(part.data) for part in request.image_parts) > capabilities.max_image_bytes:
        raise agent_failure("capability")
    if any(
        part.media_type not in capabilities.supported_image_media_types
        for part in request.image_parts
    ):
        raise agent_failure("capability")


def _model_input_bytes(request: AgentRequest) -> int:
    total = sum(utf8_size(part.text) for part in request.text_parts)
    total += sum(len(part.data) for part in request.image_parts)
    total += utf8_size(request.response_schema or "")
    total += sum(
        utf8_size(tool.name) + utf8_size(tool.description) + utf8_size(tool.input_schema)
        for tool in request.tools
    )
    for result in request.history:
        if isinstance(result, AgentStructuredResponse):
            total += utf8_size(result.result)
        elif isinstance(result, AgentToolDecision):
            total += utf8_size(result.tool_name) + utf8_size(result.arguments)
    return total


__all__ = ("AgentRoleBinding", "AgentRuntime", "open_session")
