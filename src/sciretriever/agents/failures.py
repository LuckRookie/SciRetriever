"""Stable, redacted failures at the Agents boundary."""

from __future__ import annotations

from sciretriever.model.report import StableFailure


class AgentFailure(RuntimeError):
    """Expected provider/access/protocol failure, already stable and redacted."""

    def __init__(self, failure: StableFailure) -> None:
        if not isinstance(failure, StableFailure):
            raise TypeError("failure must be StableFailure")
        super().__init__("agent provider call failed")
        self.failure = failure

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
}


def agent_failure(kind: str, *, retryable: bool | None = None) -> AgentFailure:
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
        )
    )


__all__ = ("AgentFailure", "agent_failure")
