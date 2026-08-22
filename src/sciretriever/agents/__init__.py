"""Provider-neutral runtime used by Analysis and the controlled Browser Agent.

Only the small exchange surface is exported here.  Concrete protocol adapters
live below :mod:`sciretriever.agents.providers` and are intentionally not
re-exported: callers should depend on capabilities rather than a vendor name.
"""

from .api import AgentRoleBinding, AgentRuntime, open_session
from .capabilities import (
    AgentCapability,
    AgentCapabilityReadiness,
    AgentModelCapabilities,
    AgentReadiness,
)
from .failures import AgentFailure
from .ports import AgentPort, AgentResult
from .requests import (
    AgentBudget,
    AgentImagePart,
    AgentProvenance,
    AgentRequest,
    AgentRole,
    AgentStructuredResponse,
    AgentTextPart,
    AgentToolDecision,
    AgentToolDeclaration,
    AgentUsage,
    canonical_json_bytes,
    parse_strict_json,
    parse_strict_json_object,
    utf8_size,
)
from .sessions import AgentSession

__all__ = (
    "AgentBudget",
    "AgentCapability",
    "AgentCapabilityReadiness",
    "AgentFailure",
    "AgentImagePart",
    "AgentProvenance",
    "AgentModelCapabilities",
    "AgentPort",
    "AgentReadiness",
    "AgentRoleBinding",
    "AgentRuntime",
    "AgentRequest",
    "AgentResult",
    "AgentRole",
    "AgentSession",
    "AgentStructuredResponse",
    "AgentTextPart",
    "AgentToolDecision",
    "AgentToolDeclaration",
    "AgentUsage",
    "canonical_json_bytes",
    "parse_strict_json",
    "parse_strict_json_object",
    "open_session",
    "utf8_size",
)
