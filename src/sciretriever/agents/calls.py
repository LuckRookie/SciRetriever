"""One-call values, results, provenance, and objective technical limits."""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from sciretriever.model.primitives import Sha256, sha256_digest

from .capabilities import AgentCapability, AgentRole
from .messages import (
    AgentImagePart,
    AgentTextPart,
    _model_identity,
    _validate_message_parts,
    utf8_size,
)
from .tools import (
    AgentToolCall,
    AgentToolDeclaration,
    _validate_tool_declarations,
    canonical_json_bytes,
    parse_strict_json_object,
)

_MAX_SCHEMA_BYTES = 1 * 1024 * 1024
_MAX_RESULT_BYTES = 16 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class AgentCallLimits:
    """Objective limits for one model request and its HTTP transport."""

    max_prompt_bytes: int = 131_072
    max_input_bytes: int = 8_388_608
    max_schema_bytes: int = 262_144
    max_request_bytes: int = 10_000_000
    max_response_bytes: int = 10_000_000
    max_result_bytes: int = 8_388_608
    max_output_tokens: int = 131_072
    context_window_tokens: int = 1_000_000
    connect_timeout_seconds: float = 10.0
    read_timeout_seconds: float = 120.0
    overall_timeout_seconds: float = 180.0
    max_redirects: int = 0
    max_retries: int = 0

    def __post_init__(self) -> None:
        for field_name in (
            "max_prompt_bytes",
            "max_input_bytes",
            "max_schema_bytes",
            "max_request_bytes",
            "max_response_bytes",
            "max_result_bytes",
            "max_output_tokens",
            "context_window_tokens",
        ):
            value = getattr(self, field_name)
            if type(value) is not int or value < 1:
                raise ValueError(f"{field_name} must be a positive integer")
        for field_name in (
            "connect_timeout_seconds",
            "read_timeout_seconds",
            "overall_timeout_seconds",
        ):
            value = getattr(self, field_name)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise TypeError(f"{field_name} must be numeric")
            normalized = float(value)
            if not math.isfinite(normalized) or normalized <= 0:
                raise ValueError(f"{field_name} must be finite and positive")
            object.__setattr__(self, field_name, normalized)
        if self.overall_timeout_seconds < max(
            self.connect_timeout_seconds,
            self.read_timeout_seconds,
        ):
            raise ValueError("overall timeout must cover each phase timeout")
        if self.max_output_tokens > self.context_window_tokens:
            raise ValueError("output token limit must fit the context window")
        if type(self.max_redirects) is not int or type(self.max_retries) is not int:
            raise TypeError("Agent redirects and retries must be integers")
        if self.max_redirects != 0 or self.max_retries != 0:
            raise ValueError("Agent redirects and non-idempotent retries must be disabled")

    @classmethod
    def stricter(cls, *limits: AgentCallLimits) -> AgentCallLimits:
        """Return one per-call limit set no looser than any supplied set."""

        if not limits or any(not isinstance(value, cls) for value in limits):
            raise TypeError("limits must contain AgentCallLimits values")
        return cls(
            max_prompt_bytes=min(value.max_prompt_bytes for value in limits),
            max_input_bytes=min(value.max_input_bytes for value in limits),
            max_schema_bytes=min(value.max_schema_bytes for value in limits),
            max_request_bytes=min(value.max_request_bytes for value in limits),
            max_response_bytes=min(value.max_response_bytes for value in limits),
            max_result_bytes=min(value.max_result_bytes for value in limits),
            max_output_tokens=min(value.max_output_tokens for value in limits),
            context_window_tokens=min(value.context_window_tokens for value in limits),
            connect_timeout_seconds=min(value.connect_timeout_seconds for value in limits),
            read_timeout_seconds=min(value.read_timeout_seconds for value in limits),
            overall_timeout_seconds=min(value.overall_timeout_seconds for value in limits),
        )


@dataclass(frozen=True, slots=True)
class AgentUsage:
    """Safe counters returned by one provider response."""

    input_tokens: int = 0
    output_tokens: int = 0
    response_bytes: int = 0

    def __post_init__(self) -> None:
        for field_name in ("input_tokens", "output_tokens", "response_bytes"):
            value = getattr(self, field_name)
            if type(value) is not int or value < 0:
                raise ValueError(f"{field_name} must be a nonnegative integer")


@dataclass(frozen=True, slots=True)
class AgentProvenance:
    """Redacted identity and hashes for exactly one provider call."""

    provider: str
    model: str
    input_sha256: Sha256
    parameters_sha256: Sha256
    usage: AgentUsage = AgentUsage()

    def __post_init__(self) -> None:
        from .messages import _bounded_text

        object.__setattr__(
            self,
            "provider",
            _bounded_text(self.provider, field_name="provider", maximum=256),
        )
        object.__setattr__(self, "model", _model_identity(self.model))
        if not isinstance(self.input_sha256, Sha256) or not isinstance(
            self.parameters_sha256, Sha256
        ):
            raise TypeError("Agent provenance hashes are invalid")
        if not isinstance(self.usage, AgentUsage):
            raise TypeError("Agent provenance usage must be AgentUsage")


@dataclass(frozen=True, slots=True)
class AgentStructuredResult:
    """One canonical strict JSON object; its body is excluded from repr."""

    result: str = field(repr=False)
    provenance: AgentProvenance

    def __post_init__(self) -> None:
        if type(self.result) is not str:
            raise TypeError("structured result must be text")
        if utf8_size(self.result) > _MAX_RESULT_BYTES:
            raise ValueError("structured result exceeds its byte limit")
        parsed = parse_strict_json_object(self.result)
        result = canonical_json_bytes(parsed).decode("utf-8", errors="strict")
        if utf8_size(result) > _MAX_RESULT_BYTES:
            raise ValueError("structured result exceeds its byte limit")
        object.__setattr__(self, "result", result)
        if not isinstance(self.provenance, AgentProvenance):
            raise TypeError("structured provenance must be AgentProvenance")

    @property
    def value(self) -> dict[str, object]:
        """Return a fresh parsed object; no mutable value is retained."""

        return parse_strict_json_object(self.result)


@dataclass(frozen=True, slots=True, repr=False)
class AgentCall:
    """One immutable consumer request with no provider, model, or history."""

    role: AgentRole
    required_capabilities: frozenset[AgentCapability]
    input_sha256: Sha256
    text_parts: tuple[AgentTextPart, ...] = ()
    image_parts: tuple[AgentImagePart, ...] = ()
    response_schema: str | None = field(default=None, repr=False)
    tools: tuple[AgentToolDeclaration, ...] = ()
    max_output_tokens: int = 1

    def __post_init__(self) -> None:
        if not isinstance(self.role, AgentRole):
            raise TypeError("role must be AgentRole")
        if not isinstance(self.input_sha256, Sha256):
            raise TypeError("input_sha256 must be Sha256")
        _validate_message_parts(self.text_parts, self.image_parts)
        _validate_tool_declarations(self.tools)
        if type(self.max_output_tokens) is not int or self.max_output_tokens < 1:
            raise ValueError("max_output_tokens must be positive")
        if self.response_schema is not None:
            if type(self.response_schema) is not str:
                raise TypeError("response schema must be text")
            if utf8_size(self.response_schema) > _MAX_SCHEMA_BYTES:
                raise ValueError("response schema exceeds its byte limit")
            parsed = parse_strict_json_object(self.response_schema)
            object.__setattr__(
                self,
                "response_schema",
                canonical_json_bytes(parsed).decode("utf-8", errors="strict"),
            )
        _validate_call_capabilities(
            self.required_capabilities,
            self.image_parts,
            self.tools,
            self.response_schema,
        )

    @property
    def messages(self) -> tuple[AgentTextPart, ...]:
        """Expose the ordered text messages without adding a second state field."""

        return self.text_parts

    @property
    def system_text(self) -> str:
        return self.text_parts[0].text if self.text_parts else ""

    @property
    def prompt(self) -> str:
        return self.system_text

    def __repr__(self) -> str:
        capabilities = sorted(value.value for value in self.required_capabilities)
        return f"<AgentCall role={self.role.value} capabilities={capabilities}>"


AgentResult = AgentStructuredResult | AgentToolCall


def _validate_call_capabilities(
    capabilities: object,
    image_parts: tuple[AgentImagePart, ...],
    tools: tuple[AgentToolDeclaration, ...],
    response_schema: str | None,
) -> None:
    if not isinstance(capabilities, frozenset) or any(
        not isinstance(value, AgentCapability) for value in capabilities
    ):
        raise TypeError("required_capabilities must be an AgentCapability set")
    if not capabilities:
        raise ValueError("at least one Agent capability is required")
    structured = AgentCapability.STRUCTURED_TEXT in capabilities
    tool_decision = AgentCapability.TOOL_DECISION in capabilities
    image_input = AgentCapability.IMAGE_INPUT in capabilities
    if structured and response_schema is None:
        raise ValueError("structured-text calls require a response schema")
    if not structured and response_schema is not None:
        raise ValueError("response schema requires structured-text capability")
    if image_input and not image_parts:
        raise ValueError("image-input calls require image parts")
    if not image_input and image_parts:
        raise ValueError("image parts require image-input capability")
    if tool_decision and not tools:
        raise ValueError("tool-decision calls require tool declarations")
    if not tool_decision and tools:
        raise ValueError("tool declarations require tool-decision capability")
    if structured and tool_decision:
        raise ValueError("structured-text and tool-decision cannot be mixed")


def request_input_hash(value: str) -> Sha256:
    if type(value) is not str:
        raise TypeError("input value must be text")
    return sha256_digest(value.encode("utf-8", errors="strict"))


def _tools_bytes(call: AgentCall) -> bytes:
    return canonical_json_bytes(
        [
            {
                "name": declaration.name,
                "description": declaration.description,
                "schema": parse_strict_json_object(declaration.input_schema),
            }
            for declaration in call.tools
        ]
    )


def _model_input_bytes(call: AgentCall) -> int:
    total = sum(utf8_size(part.text) for part in call.text_parts)
    total += sum(len(part.data) for part in call.image_parts)
    total += utf8_size(call.response_schema or "")
    total += len(_tools_bytes(call))
    return total


def _request_descriptor_bytes(call: AgentCall) -> int:
    descriptor = canonical_json_bytes(
        {
            "role": call.role.value,
            "capabilities": sorted(value.value for value in call.required_capabilities),
            "input_sha256": str(call.input_sha256),
            "text": [
                {"media_type": part.media_type, "text": part.text} for part in call.text_parts
            ],
            "images": [
                {
                    "media_type": part.media_type,
                    "width": part.width,
                    "height": part.height,
                    "sha256": str(sha256_digest(part.data)),
                }
                for part in call.image_parts
            ],
            "response_schema": (
                None
                if call.response_schema is None
                else parse_strict_json_object(call.response_schema)
            ),
            "tools": [
                {
                    "name": declaration.name,
                    "description": declaration.description,
                    "schema": parse_strict_json_object(declaration.input_schema),
                }
                for declaration in call.tools
            ],
            "max_output_tokens": call.max_output_tokens,
        }
    )
    return len(descriptor) + sum(len(part.data) for part in call.image_parts)


__all__ = (
    "AgentCall",
    "AgentCallLimits",
    "AgentProvenance",
    "AgentResult",
    "AgentStructuredResult",
    "AgentUsage",
)
