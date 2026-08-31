"""Provider-neutral Agent roles, model capabilities, and local readiness."""

from __future__ import annotations

from collections.abc import Container
from dataclasses import dataclass
from enum import Enum, unique

BROWSER_OBSERVATION_MEDIA_TYPE = "image/png"


@unique
class AgentRole(str, Enum):
    """One configured consumer role; it never selects a provider or model."""

    ANALYSIS = "analysis"
    BROWSER = "browser"


@unique
class AgentCapability(str, Enum):
    """Closed capabilities that a single neutral Agent call may require."""

    STRUCTURED_TEXT = "structured-text"
    IMAGE_INPUT = "image-input"
    TOOL_DECISION = "tool-decision"


@dataclass(frozen=True, slots=True)
class AgentModelCapabilities:
    """Locally declared capabilities for one role-bound model."""

    context_window_tokens: int
    max_output_tokens: int
    structured_output: bool = False
    image_input: bool = False
    tool_decision: bool = False
    supported_image_media_types: frozenset[str] = frozenset()
    max_image_count: int = 0
    max_image_bytes: int = 0

    def __post_init__(self) -> None:  # noqa: C901
        for name in ("structured_output", "image_input", "tool_decision"):
            if type(getattr(self, name)) is not bool:
                raise TypeError(f"{name} must be bool")
        for name in ("context_window_tokens", "max_output_tokens"):
            value = getattr(self, name)
            if type(value) is not int or value < 1:
                raise ValueError(f"{name} must be positive")
        if self.max_output_tokens > self.context_window_tokens:
            raise ValueError("model output limit must fit its context window")
        if type(self.max_image_count) is not int or self.max_image_count < 0:
            raise ValueError("max_image_count must be nonnegative")
        if type(self.max_image_bytes) is not int or self.max_image_bytes < 0:
            raise ValueError("max_image_bytes must be nonnegative")
        if not isinstance(self.supported_image_media_types, frozenset) or any(
            type(value) is not str or value not in {"image/png", "image/jpeg", "image/webp"}
            for value in self.supported_image_media_types
        ):
            raise ValueError("image media types are invalid")
        if self.image_input and (
            self.max_image_count < 1
            or self.max_image_bytes < 1
            or not self.supported_image_media_types
        ):
            raise ValueError("image capability requires image limits")
        if not self.image_input and (
            self.supported_image_media_types or self.max_image_count or self.max_image_bytes
        ):
            raise ValueError("image limits require image capability")


@dataclass(frozen=True, slots=True)
class AgentCapabilityReadiness:
    """Purely local readiness for exactly one role."""

    role: AgentRole
    configured: bool
    protocol_supported: bool
    model_declared: bool
    missing: frozenset[AgentCapability] = frozenset()

    def __post_init__(self) -> None:
        if not isinstance(self.role, AgentRole):
            raise TypeError("role must be an AgentRole")
        for name in ("configured", "protocol_supported", "model_declared"):
            if type(getattr(self, name)) is not bool:
                raise TypeError(f"{name} must be bool")
        if not isinstance(self.missing, frozenset) or any(
            not isinstance(value, AgentCapability) for value in self.missing
        ):
            raise TypeError("missing must be AgentCapability values")

    @property
    def ready(self) -> bool:
        return (
            self.configured and self.protocol_supported and self.model_declared and not self.missing
        )


def required_capabilities(role: AgentRole) -> frozenset[AgentCapability]:
    """Return the minimum locally declared capabilities for one role."""

    if not isinstance(role, AgentRole):
        raise TypeError("role must be an AgentRole")
    if role is AgentRole.ANALYSIS:
        return frozenset({AgentCapability.STRUCTURED_TEXT})
    return frozenset({AgentCapability.IMAGE_INPUT, AgentCapability.TOOL_DECISION})


def capability_missing(
    required: frozenset[AgentCapability],
    model: AgentModelCapabilities,
) -> frozenset[AgentCapability]:
    """Return required capabilities absent from a declared model binding."""

    if not isinstance(required, frozenset) or any(
        not isinstance(value, AgentCapability) for value in required
    ):
        raise TypeError("required must be AgentCapability values")
    if not isinstance(model, AgentModelCapabilities):
        raise TypeError("model must be AgentModelCapabilities")
    supported: set[AgentCapability] = set()
    if model.structured_output:
        supported.add(AgentCapability.STRUCTURED_TEXT)
    if model.image_input:
        supported.add(AgentCapability.IMAGE_INPUT)
    if model.tool_decision:
        supported.add(AgentCapability.TOOL_DECISION)
    return frozenset(required - supported)


def browser_observation_input_ready(
    *,
    image_input: bool,
    supported_image_media_types: Container[str],
    max_image_count: int,
    max_image_bytes: int,
) -> bool:
    """Return whether a Browser binding can accept one production Observation image."""

    return (
        image_input
        and BROWSER_OBSERVATION_MEDIA_TYPE in supported_image_media_types
        and max_image_count >= 1
        and max_image_bytes >= 1
    )


__all__ = (
    "AgentCapability",
    "AgentCapabilityReadiness",
    "AgentModelCapabilities",
    "AgentRole",
    "BROWSER_OBSERVATION_MEDIA_TYPE",
    "browser_observation_input_ready",
    "capability_missing",
    "required_capabilities",
)
