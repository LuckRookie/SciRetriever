"""Stable, redacted failures at the Agents boundary."""

from __future__ import annotations

from typing import Literal, TypeAlias

from sciretriever.model.report import StableFailure

AgentRemoteErrorKind: TypeAlias = Literal[
    "image-unsupported",
    "model-not-found",
    "model-rejected",
    "reasoning-unsupported",
    "request-rejected",
    "structured-output-unsupported",
    "tool-unsupported",
]

_REMOTE_ERROR_KINDS: frozenset[str] = frozenset(
    {
        "image-unsupported",
        "model-not-found",
        "model-rejected",
        "reasoning-unsupported",
        "request-rejected",
        "structured-output-unsupported",
        "tool-unsupported",
    }
)
_ACCESS_CODES = frozenset(
    {
        "admission",
        "budget",
        "cancelled",
        "closed",
        "oversize",
        "policy",
        "redirect-limit",
        "response",
        "timeout",
        "tls",
        "transport",
    }
)


class AgentFailure(RuntimeError):
    """Expected provider/access/protocol failure, already stable and redacted."""

    def __init__(
        self,
        failure: StableFailure,
        *,
        http_status: int | None = None,
        access_code: str | None = None,
        remote_error: AgentRemoteErrorKind | None = None,
    ) -> None:
        if not isinstance(failure, StableFailure):
            raise TypeError("failure must be StableFailure")
        if http_status is not None and (
            type(http_status) is not int or not 100 <= http_status <= 599
        ):
            raise ValueError("Agent failure HTTP status is invalid")
        normalized_access_code = (
            access_code.replace("_", "-") if type(access_code) is str else access_code
        )
        if normalized_access_code is not None and normalized_access_code not in _ACCESS_CODES:
            raise ValueError("Agent failure access code is invalid")
        if remote_error is not None and remote_error not in _REMOTE_ERROR_KINDS:
            raise ValueError("Agent remote failure kind is invalid")
        if http_status is not None and access_code is not None:
            raise ValueError("Agent failure evidence is inconsistent")
        if remote_error is not None and http_status is None:
            raise ValueError("Agent remote failure requires an HTTP status")
        super().__init__("agent provider call failed")
        self.failure = failure
        self.http_status = http_status
        self.access_code = normalized_access_code
        self.remote_error = remote_error

    def __repr__(self) -> str:
        return "<AgentFailure>"


_FAILURES: dict[str, tuple[str, str, str, bool]] = {
    "credentials": (
        "agent-credentials",
        "The Agent provider credential is missing or invalid.",
        "Configure a valid Agent credential before retrying.",
        False,
    ),
    "configuration": (
        "agent-configuration",
        "The Agent provider configuration is incomplete.",
        "Complete the Agent provider configuration before retrying.",
        False,
    ),
    "capability": (
        "agent-capability",
        "The selected model does not support this Agent capability.",
        "Choose a model with the declared capability.",
        False,
    ),
    "input-budget": (
        "agent-input-budget",
        "The Agent input exceeded its configured byte budget.",
        "Reduce the bounded Agent input.",
        False,
    ),
    "output-budget": (
        "agent-output-budget",
        "The requested Agent output exceeded its configured budget.",
        "Reduce the requested output budget.",
        False,
    ),
    "request-budget": (
        "agent-request-budget",
        "The serialized Agent request exceeded its byte budget.",
        "Reduce the bounded Agent request.",
        False,
    ),
    "response-budget": (
        "agent-response-budget",
        "The Agent provider response exceeded its configured byte budget.",
        "Reduce the requested output.",
        False,
    ),
    "result-budget": (
        "agent-result-budget",
        "The Agent structured result exceeded its configured byte budget.",
        "Reduce the requested output.",
        False,
    ),
    "context-budget": (
        "agent-context-budget",
        "The Agent request exceeded the configured context window.",
        "Reduce input or output reserve.",
        False,
    ),
    "access": (
        "agent-access",
        "The Agent provider could not be reached through safe access.",
        "Retry later or review provider readiness.",
        True,
    ),
    "timeout": (
        "agent-timeout",
        "The Agent provider operation timed out.",
        "Retry later or reduce the bounded request.",
        True,
    ),
    "authentication": (
        "agent-authentication",
        "The Agent provider did not authenticate this request.",
        "Review Agent credential readiness.",
        False,
    ),
    "authorization": (
        "agent-authorization",
        "The Agent provider did not authorize this request.",
        "Review account and model readiness.",
        False,
    ),
    "quota": (
        "agent-quota",
        "The Agent provider throttled or exhausted this access scope.",
        "Retry after the shared access policy permits another request.",
        True,
    ),
    "http-status": (
        "agent-http-status",
        "The Agent provider returned an unsuccessful status.",
        "Retry later or review provider readiness.",
        True,
    ),
    "request-rejected": (
        "agent-request-rejected",
        "The Agent provider rejected the model request.",
        "Review the model identity, reasoning, and requested capabilities.",
        False,
    ),
    "not-found": (
        "agent-not-found",
        "The Agent provider could not find the model or API endpoint.",
        "Review the model identity, Base URL, and selected API protocol.",
        False,
    ),
    "endpoint": (
        "agent-endpoint",
        "The Agent provider endpoint does not accept the selected API protocol.",
        "Review the Provider Base URL and selected API protocol.",
        False,
    ),
    "redirect": (
        "agent-redirect",
        "The Agent provider returned an unexpected redirect.",
        "Configure the final Provider Base URL.",
        False,
    ),
    "remote-service": (
        "agent-remote-service",
        "The Agent provider reported a service failure.",
        "Retry later or check the Provider service status.",
        True,
    ),
    "refusal": (
        "agent-refusal",
        "The Agent provider refused the structured request.",
        "Review the request before retrying.",
        False,
    ),
    "truncated": (
        "agent-truncated",
        "The Agent provider truncated the structured result.",
        "Adjust the bounded output request.",
        False,
    ),
    "protocol": (
        "agent-protocol",
        "The Agent provider returned an unsupported response structure.",
        "Update the Agent protocol adapter.",
        False,
    ),
    "model-mismatch": (
        "agent-model-mismatch",
        "The Agent provider returned a different model identity.",
        "Review the configured model.",
        False,
    ),
    "structured-response": (
        "agent-structured-response",
        "The Agent result was not one complete strict object.",
        "Retry or update the protocol adapter.",
        True,
    ),
    "tool": (
        "agent-tool",
        "The Agent provider returned an undeclared tool decision.",
        "Review tool declarations and retry.",
        False,
    ),
    "cancelled": (
        "agent-cancelled",
        "The Agent operation was cancelled.",
        "Retry the operation when ready.",
        False,
    ),
    "cleanup": (
        "agent-cleanup",
        "The Agent session could not be closed cleanly.",
        "Restart the current operation.",
        False,
    ),
    "internal": (
        "agent-internal",
        "The Agent adapter encountered an internal error.",
        "Review the Debug transcript and adapter implementation.",
        False,
    ),
}


def agent_failure(
    kind: str,
    *,
    retryable: bool | None = None,
    http_status: int | None = None,
    access_code: str | None = None,
    remote_error: AgentRemoteErrorKind | None = None,
) -> AgentFailure:
    try:
        code, reason, action, default_retryable = _FAILURES[kind]
    except KeyError:
        raise ValueError("unknown Agent failure kind") from None
    return AgentFailure(
        StableFailure(
            code=code,
            reason=reason,
            action=action,
            retryable=default_retryable if retryable is None else retryable,
        ),
        http_status=http_status,
        access_code=access_code,
        remote_error=remote_error,
    )


__all__ = ("AgentFailure", "AgentRemoteErrorKind", "agent_failure")
