"""Stateless role-bound runtime for exactly one model invocation."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field, replace

from sciretriever.logging.api import get_logger
from sciretriever.model.configuration import AgentReasoningEffort

from .calls import (
    AgentCall,
    AgentCallLimits,
    AgentResult,
    AgentStructuredResult,
    _model_input_bytes,
    _request_descriptor_bytes,
)
from .capabilities import (
    AgentCapabilityReadiness,
    AgentModelCapabilities,
    AgentRole,
    capability_missing,
    required_capabilities,
)
from .debug import AgentDebugImageRecorder
from .failures import AgentFailure, agent_failure
from .messages import _model_identity, utf8_size
from .ports import AgentProviderCall, AgentProviderPort
from .tools import AgentToolCall, validate_tool_arguments

_LOGGER = get_logger("sciretriever.agents")


@dataclass(frozen=True, slots=True)
class AgentRoleBinding:
    """One role's model, declared capabilities, and single-call limits."""

    role: AgentRole
    model: str
    capabilities: AgentModelCapabilities
    reasoning_effort: AgentReasoningEffort = AgentReasoningEffort.PROVIDER_DEFAULT
    stream: bool = True
    limits: AgentCallLimits = AgentCallLimits()

    def __post_init__(self) -> None:
        if not isinstance(self.role, AgentRole):
            raise TypeError("role must be an AgentRole")
        object.__setattr__(self, "model", _model_identity(self.model))
        if not isinstance(self.capabilities, AgentModelCapabilities):
            raise TypeError("role capabilities must be AgentModelCapabilities")
        if not isinstance(self.reasoning_effort, AgentReasoningEffort):
            raise TypeError("reasoning_effort must be an AgentReasoningEffort")
        if type(self.stream) is not bool:
            raise TypeError("stream must be bool")
        if not isinstance(self.limits, AgentCallLimits):
            raise TypeError("role limits must be AgentCallLimits")


@dataclass(frozen=True, slots=True)
class AgentRoleIdentity:
    """Safe identity of the exact Provider/model binding for one role."""

    role: AgentRole
    provider: str
    model: str
    reasoning_effort: AgentReasoningEffort
    stream: bool

    def __post_init__(self) -> None:
        if not isinstance(self.role, AgentRole):
            raise TypeError("role must be an AgentRole")
        if type(self.provider) is not str or not self.provider.strip():
            raise ValueError("provider must be nonblank text")
        object.__setattr__(self, "provider", self.provider.strip())
        object.__setattr__(self, "model", _model_identity(self.model))
        if not isinstance(self.reasoning_effort, AgentReasoningEffort):
            raise TypeError("reasoning_effort must be an AgentReasoningEffort")
        if type(self.stream) is not bool:
            raise TypeError("stream must be bool")


@dataclass(frozen=True, slots=True)
class AgentRuntime:
    """Provider-neutral executor with one adapter selected for each bound role."""

    adapter: AgentProviderPort | None = None
    analysis_adapter: AgentProviderPort | None = None
    browser_adapter: AgentProviderPort | None = None
    analysis: AgentRoleBinding | None = None
    browser: AgentRoleBinding | None = None
    configured_roles: frozenset[AgentRole] = frozenset()
    protocol_supported: bool = True
    debug_image_recorder: AgentDebugImageRecorder | None = field(default=None, repr=False)

    def __post_init__(self) -> None:  # noqa: C901
        for adapter in (self.adapter, self.analysis_adapter, self.browser_adapter):
            if adapter is not None and not isinstance(adapter, AgentProviderPort):
                raise TypeError("adapter must implement AgentProviderPort")
        analysis_adapter = self.analysis_adapter or self.adapter
        browser_adapter = self.browser_adapter or self.adapter
        if self.analysis is not None and analysis_adapter is None:
            raise ValueError("analysis binding requires an adapter")
        if self.browser is not None and browser_adapter is None:
            raise ValueError("browser binding requires an adapter")
        object.__setattr__(self, "analysis_adapter", analysis_adapter)
        object.__setattr__(self, "browser_adapter", browser_adapter)
        if self.adapter is None:
            object.__setattr__(self, "adapter", analysis_adapter or browser_adapter)
        if not isinstance(self.configured_roles, frozenset) or any(
            not isinstance(role, AgentRole) for role in self.configured_roles
        ):
            raise TypeError("configured_roles must contain AgentRole values")
        if type(self.protocol_supported) is not bool:
            raise TypeError("protocol_supported must be bool")
        if self.debug_image_recorder is not None and not isinstance(
            self.debug_image_recorder,
            AgentDebugImageRecorder,
        ):
            raise TypeError("debug_image_recorder must be AgentDebugImageRecorder or None")
        if self.analysis is not None and self.analysis.role is not AgentRole.ANALYSIS:
            raise ValueError("analysis slot requires an analysis role binding")
        if self.browser is not None and self.browser.role is not AgentRole.BROWSER:
            raise ValueError("browser slot requires a browser role binding")
        bound_roles = {
            binding.role for binding in (self.analysis, self.browser) if binding is not None
        }
        object.__setattr__(
            self,
            "configured_roles",
            frozenset(self.configured_roles | bound_roles),
        )

    def with_debug_image_recording(self) -> AgentRuntime:
        """Return a runtime that records exact image inputs for this process.

        The runtime is immutable so object-graph assembly can opt in after it
        has determined that the command is running at Debug level.  Reusing an
        already-enabled recorder keeps one sequence and directory across all
        role bindings in the graph.
        """

        if self.debug_image_recorder is not None:
            return self
        return replace(self, debug_image_recorder=AgentDebugImageRecorder())

    def identity(self, role: AgentRole) -> AgentRoleIdentity:
        """Return the exact role binding; never fall back to another role."""

        if not isinstance(role, AgentRole):
            raise TypeError("role must be an AgentRole")
        binding = self._binding(role)
        adapter = self._adapter(role)
        if binding is None or adapter is None:
            raise ValueError(f"{role.value} Agent role is unbound")
        return AgentRoleIdentity(
            role=role,
            provider=adapter.provider_name,
            model=binding.model,
            reasoning_effort=binding.reasoning_effort,
            stream=binding.stream,
        )

    def readiness(self, role: AgentRole) -> AgentCapabilityReadiness:
        """Return pure local readiness for one requested role."""

        if not isinstance(role, AgentRole):
            raise TypeError("role must be an AgentRole")
        binding = self._binding(role)
        if binding is None:
            return AgentCapabilityReadiness(
                role=role,
                configured=role in self.configured_roles,
                protocol_supported=self.protocol_supported,
                model_declared=False,
                missing=required_capabilities(role),
            )
        missing = set(capability_missing(required_capabilities(role), binding.capabilities))
        return AgentCapabilityReadiness(
            role=role,
            configured=True,
            protocol_supported=self.protocol_supported,
            model_declared=True,
            missing=frozenset(missing),
        )

    def execute(
        self,
        call: AgentCall,
        *,
        cancel_event: threading.Event | None = None,
    ) -> AgentResult:
        """Validate and execute exactly one independent model call."""

        if not isinstance(call, AgentCall):
            raise TypeError("call must be an AgentCall")
        if cancel_event is not None and not isinstance(cancel_event, threading.Event):
            raise TypeError("cancel_event must be a threading.Event")
        if cancel_event is not None and cancel_event.is_set():
            self._raise_preflight(call, "cancelled")
        binding = self._binding(call.role)
        if not self.protocol_supported or binding is None:
            self._raise_preflight(call, "capability")
        assert binding is not None
        baseline = required_capabilities(call.role)
        if not baseline.issubset(call.required_capabilities):
            self._raise_preflight(call, "capability")
        missing = capability_missing(call.required_capabilities, binding.capabilities)
        if missing:
            self._raise_preflight(call, "capability")
        try:
            self._validate_call(call, binding)
        except AgentFailure as error:
            self._log_preflight_failure(call, error)
            raise
        provider_call = AgentProviderCall(
            role=call.role,
            capabilities=call.required_capabilities,
            model=binding.model,
            input_sha256=call.input_sha256,
            text_parts=call.text_parts,
            image_parts=call.image_parts,
            response_schema=call.response_schema,
            tools=call.tools,
            max_output_tokens=call.max_output_tokens,
            reasoning_effort=binding.reasoning_effort,
            stream=binding.stream,
            limits=binding.limits,
            cancel_event=cancel_event,
        )
        adapter = self._adapter(call.role)
        if adapter is None:
            self._raise_preflight(call, "capability")
        assert adapter is not None
        recorder = self.debug_image_recorder
        if recorder is not None:
            recorder.record(provider_call)
        return self._execute_provider(call, binding, adapter, provider_call)

    def _execute_provider(
        self,
        call: AgentCall,
        binding: AgentRoleBinding,
        adapter: AgentProviderPort,
        provider_call: AgentProviderCall,
    ) -> AgentResult:
        """Invoke one adapter and own the role-level terminal transcript."""

        identity = self.identity(call.role)
        started = time.monotonic()
        _LOGGER.info(
            "event=agent-call-started role=%s provider=%s wire_model=%s stream=%s "
            "reasoning_effort=%s",
            call.role.value,
            identity.provider,
            identity.model,
            "on" if identity.stream else "off",
            identity.reasoning_effort.value,
        )
        try:
            result = adapter.execute(provider_call)
            self._validate_result(call, binding, adapter, result)
        except AgentFailure as error:
            failure = error.failure
            _LOGGER.info(
                "event=agent-call-finished role=%s provider=%s wire_model=%s "
                "outcome=failed code=%s retryable=%s elapsed_ms=%d reason=%s action=%s",
                call.role.value,
                identity.provider,
                identity.model,
                failure.code,
                str(failure.retryable).lower(),
                max(int((time.monotonic() - started) * 1000), 0),
                failure.reason,
                failure.action,
            )
            raise
        except Exception:
            error = agent_failure("internal")
            failure = error.failure
            _LOGGER.info(
                "event=agent-call-finished role=%s provider=%s wire_model=%s "
                "outcome=failed code=%s retryable=false elapsed_ms=%d "
                "reason=%s action=%s",
                call.role.value,
                identity.provider,
                identity.model,
                failure.code,
                max(int((time.monotonic() - started) * 1000), 0),
                failure.reason,
                failure.action,
            )
            raise error from None
        usage = result.provenance.usage
        _LOGGER.info(
            "event=agent-call-finished role=%s provider=%s wire_model=%s "
            "outcome=success result=%s input_tokens=%d output_tokens=%d "
            "response_bytes=%d elapsed_ms=%d",
            call.role.value,
            identity.provider,
            identity.model,
            "tool" if isinstance(result, AgentToolCall) else "structured",
            usage.input_tokens,
            usage.output_tokens,
            usage.response_bytes,
            max(int((time.monotonic() - started) * 1000), 0),
        )
        return result

    def _binding(self, role: AgentRole) -> AgentRoleBinding | None:
        return self.analysis if role is AgentRole.ANALYSIS else self.browser

    def _adapter(self, role: AgentRole) -> AgentProviderPort | None:
        return self.analysis_adapter if role is AgentRole.ANALYSIS else self.browser_adapter

    @staticmethod
    def _validate_call(call: AgentCall, binding: AgentRoleBinding) -> None:  # noqa: C901
        limits = binding.limits
        capabilities = binding.capabilities
        if call.max_output_tokens > limits.max_output_tokens or (
            call.max_output_tokens > capabilities.max_output_tokens
        ):
            raise agent_failure("output-budget")
        if utf8_size(call.prompt) > limits.max_prompt_bytes:
            raise agent_failure("input-budget")
        schema_bytes = utf8_size(call.response_schema or "")
        if schema_bytes > limits.max_schema_bytes:
            raise agent_failure("input-budget")
        input_bytes = _model_input_bytes(call)
        if input_bytes > limits.max_input_bytes:
            raise agent_failure("input-budget")
        try:
            request_bytes = _request_descriptor_bytes(call)
        except ValueError:
            raise agent_failure("request-budget") from None
        if request_bytes > limits.max_request_bytes:
            raise agent_failure("request-budget")
        if call.image_parts:
            if len(call.image_parts) > capabilities.max_image_count:
                raise agent_failure("capability")
            if sum(len(part.data) for part in call.image_parts) > capabilities.max_image_bytes:
                raise agent_failure("capability")
            if any(
                part.media_type not in capabilities.supported_image_media_types
                for part in call.image_parts
            ):
                raise agent_failure("capability")

    def _validate_result(  # noqa: C901
        self,
        call: AgentCall,
        binding: AgentRoleBinding,
        adapter: AgentProviderPort,
        result: object,
    ) -> None:
        if call.tools:
            if not isinstance(result, AgentToolCall):
                raise agent_failure("tool")
            declaration = next(
                (value for value in call.tools if value.name == result.tool_name),
                None,
            )
            if declaration is None:
                raise agent_failure("tool")
            try:
                validate_tool_arguments(declaration, result.arguments)
            except (TypeError, ValueError):
                raise agent_failure("tool") from None
            result_bytes = utf8_size(result.arguments)
        else:
            if not isinstance(result, AgentStructuredResult):
                raise agent_failure("structured-response")
            result_bytes = utf8_size(result.result)
        provenance = result.provenance
        if provenance.model != binding.model:
            raise agent_failure("model-mismatch")
        if (
            provenance.provider != adapter.provider_name
            or provenance.input_sha256 != call.input_sha256
        ):
            raise agent_failure("protocol")
        usage = provenance.usage
        if usage.output_tokens > call.max_output_tokens or usage.output_tokens > (
            binding.limits.max_output_tokens
        ):
            raise agent_failure("output-budget")
        if usage.response_bytes > binding.limits.max_response_bytes:
            raise agent_failure("response-budget")
        if result_bytes > binding.limits.max_result_bytes:
            raise agent_failure("result-budget")
        if usage.input_tokens + usage.output_tokens > min(
            binding.limits.context_window_tokens,
            binding.capabilities.context_window_tokens,
        ):
            raise agent_failure("context-budget")

    def _raise_preflight(self, call: AgentCall, kind: str) -> None:
        error = agent_failure(kind)
        self._log_preflight_failure(call, error)
        raise error

    def _log_preflight_failure(self, call: AgentCall, error: AgentFailure) -> None:
        binding = self._binding(call.role)
        adapter = self._adapter(call.role)
        failure = error.failure
        _LOGGER.debug(
            "event=agent-call-preflight-failed role=%s provider=%s wire_model=%s "
            "stream=%s capabilities=%s reasoning_effort=%s outcome=failed "
            "code=%s retryable=%s reason=%s action=%s",
            call.role.value,
            "unbound" if adapter is None else adapter.provider_name,
            "unbound" if binding is None else binding.model,
            "unbound" if binding is None else "on" if binding.stream else "off",
            ",".join(sorted(value.value for value in call.required_capabilities)),
            "unbound" if binding is None else binding.reasoning_effort.value,
            failure.code,
            str(failure.retryable).lower(),
            failure.reason,
            failure.action,
        )


__all__ = ("AgentRoleBinding", "AgentRoleIdentity", "AgentRuntime")
