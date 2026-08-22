"""Anthropic Messages API adapter for the provider-neutral Agents port."""

from __future__ import annotations

from sciretriever.agents.providers.base import (
    ANTHROPIC_BASELINE_ACCESS_POLICY,
    ProviderHttpAdapterBase,
    _ParsedResult,
    agent_http_connection,
    anthropic_input_parts,
    provider_failure,
    tool_declarations,
    usage_from_payload,
)
from sciretriever.agents.requests import (
    AgentBudget,
    AgentRequest,
    AgentUsage,
    canonical_json_bytes,
    parse_strict_json_object,
)
from sciretriever.model.access import Header
from sciretriever.network.admission import AccessPolicy
from sciretriever.network.http import HttpClient

_PROVIDER_NAME = "anthropic"
_PROTOCOL_REVISION = "messages-2023-06-01"
_ANTHROPIC_VERSION = "2023-06-01"


class AnthropicMessagesAdapter(ProviderHttpAdapterBase):
    """Bounded Anthropic Messages API implementation with no SDK dependency."""

    def __init__(
        self,
        *,
        http_client: HttpClient,
        api_key: str | None,
        base_url: str = "https://api.anthropic.com/v1",
        limits: AgentBudget | None = None,
        access_policy: AccessPolicy | None = None,
        provider_name: str = _PROVIDER_NAME,
        service_name: str = "messages",
    ) -> None:
        from sciretriever.network.admission import AccessScope

        endpoint, credential_origin, destination_policy = agent_http_connection(
            base_url=base_url,
            endpoint_suffix="/messages",
            api_key=api_key,
        )
        super().__init__(
            http_client=http_client,
            api_key=api_key,
            limits=limits or AgentBudget(),
            access_policy=access_policy,
            provider_name=provider_name,
            endpoint=endpoint,
            credential_origin=credential_origin,
            destination_policy=destination_policy,
            access_scope=AccessScope(provider_name, "api", service_name),
            baseline_policy=ANTHROPIC_BASELINE_ACCESS_POLICY,
            protocol_revision=_PROTOCOL_REVISION,
        )

    def _safe_headers(self) -> tuple[Header, ...]:
        return (
            Header(name="Accept", value="application/json"),
            Header(name="Content-Type", value="application/json"),
            Header(name="Anthropic-Version", value=_ANTHROPIC_VERSION),
        )

    def _credential_headers(self) -> tuple[tuple[str, str], ...]:
        return () if self._api_key is None else (("X-Api-Key", self._api_key),)

    def _build_request_body(self, call: AgentRequest) -> bytes:
        body: dict[str, object] = {
            "model": call.model,
            "max_tokens": call.max_output_tokens,
            "system": call.prompt,
            "messages": [{"role": "user", "content": anthropic_input_parts(call)}],
        }
        if call.response_schema is not None:
            body["output_config"] = {
                "format": {
                    "type": "json_schema",
                    "schema": parse_strict_json_object(call.response_schema),
                }
            }
        if call.tools:
            body["tools"] = tool_declarations(call, anthropic=True)
            body["tool_choice"] = {"type": "any"}
        return canonical_json_bytes(body)

    def _parse_result(self, body: bytes, call: AgentRequest) -> _ParsedResult:
        root = _anthropic_root(body, call)
        usage = usage_from_payload(root.get("usage"))
        stop_reason, content = _anthropic_content(root)
        if call.tools:
            return _anthropic_tool_result(content, stop_reason, usage)
        return _anthropic_text_result(content, stop_reason, usage)

    def _provider_parameters(self) -> dict[str, object]:
        return {
            "anthropic_version": _ANTHROPIC_VERSION,
            "structured_output": "output-config-json-schema",
        }


__all__ = ("AnthropicMessagesAdapter",)


def _anthropic_root(body: bytes, call: AgentRequest) -> dict[str, object]:
    try:
        root = parse_strict_json_object(body)
    except (TypeError, ValueError):
        raise provider_failure("protocol") from None
    if root.get("type") != "message" or root.get("role") != "assistant":
        raise provider_failure("protocol")
    if root.get("model") != call.model:
        raise provider_failure("model-mismatch")
    return root


def _anthropic_content(root: dict[str, object]) -> tuple[object, list[object]]:
    stop_reason = root.get("stop_reason")
    content = root.get("content")
    if not isinstance(content, list) or not content:
        raise provider_failure("protocol")
    return stop_reason, content


def _anthropic_tool_result(
    content: list[object],
    stop_reason: object,
    usage: AgentUsage,
) -> _ParsedResult:
    if stop_reason != "tool_use":
        raise provider_failure("tool")
    if len(content) != 1 or not isinstance(content[0], dict):
        raise provider_failure("tool")
    block = content[0]
    if block.get("type") != "tool_use":
        raise provider_failure("tool")
    name = block.get("name")
    arguments = block.get("input")
    if type(name) is not str or not isinstance(arguments, dict):
        raise provider_failure("tool")
    try:
        encoded = canonical_json_bytes(arguments).decode("utf-8")
    except (TypeError, ValueError, UnicodeDecodeError):
        raise provider_failure("tool") from None
    return _ParsedResult.tool(name, encoded, usage)


def _anthropic_text_result(
    content: list[object],
    stop_reason: object,
    usage: AgentUsage,
) -> _ParsedResult:
    if stop_reason == "refusal":
        raise provider_failure("refusal")
    if stop_reason == "max_tokens":
        raise provider_failure("truncated")
    if stop_reason not in {"end_turn", "stop_sequence"}:
        raise provider_failure("protocol")
    blocks = [block for block in content if isinstance(block, dict) and block.get("type") == "text"]
    if len(blocks) != 1 or type(blocks[0].get("text")) is not str:
        raise provider_failure("protocol")
    return _ParsedResult.structured(blocks[0]["text"], usage)
