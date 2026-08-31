"""OpenAI Chat Completions adapter for the provider-neutral Agents port."""

from __future__ import annotations

from sciretriever.agents.calls import AgentCallLimits, AgentUsage
from sciretriever.agents.ports import AgentProviderCall
from sciretriever.agents.providers.base import (
    OPENAI_BASELINE_ACCESS_POLICY,
    ProviderHttpAdapterBase,
    _ParsedResult,
    agent_http_connection,
    openai_chat_input_parts,
    provider_failure,
    tool_declarations,
    usage_from_payload,
)
from sciretriever.agents.tools import canonical_json_bytes, parse_strict_json_object
from sciretriever.model.access import Header
from sciretriever.model.configuration import AgentReasoningEffort
from sciretriever.network.admission import AccessPolicy, AccessScope
from sciretriever.network.http import HttpClient

_PROVIDER_NAME = "openai"
_PROTOCOL_REVISION = "chat-completions-v1"


class OpenAIChatCompletionsAdapter(ProviderHttpAdapterBase):
    """Bounded Chat Completions implementation with strict JSON schema output."""

    def __init__(
        self,
        *,
        http_client: HttpClient,
        api_key: str | None,
        base_url: str = "https://api.openai.com/v1",
        limits: AgentCallLimits | None = None,
        access_policy: AccessPolicy | None = None,
        provider_name: str = _PROVIDER_NAME,
        service_name: str = "chat-completions",
    ) -> None:
        endpoint, credential_origin, destination_policy = agent_http_connection(
            base_url=base_url,
            endpoint_suffix="/chat/completions",
            api_key=api_key,
        )
        super().__init__(
            http_client=http_client,
            api_key=api_key,
            limits=limits or AgentCallLimits(),
            access_policy=access_policy,
            provider_name=provider_name,
            endpoint=endpoint,
            credential_origin=credential_origin,
            destination_policy=destination_policy,
            access_scope=AccessScope(provider_name, "api", service_name),
            baseline_policy=OPENAI_BASELINE_ACCESS_POLICY,
            protocol_revision=_PROTOCOL_REVISION,
        )

    def _safe_headers(self) -> tuple[Header, ...]:
        return (
            Header(name="Accept", value="application/json"),
            Header(name="Content-Type", value="application/json"),
        )

    def _credential_headers(self) -> tuple[tuple[str, str], ...]:
        return () if self._api_key is None else (("Authorization", f"Bearer {self._api_key}"),)

    def _build_request_body(self, call: AgentProviderCall) -> bytes:
        body: dict[str, object] = {
            "model": call.model,
            "messages": [
                {"role": "developer", "content": call.prompt},
                {"role": "user", "content": openai_chat_input_parts(call)},
            ],
            "max_completion_tokens": call.max_output_tokens,
        }
        if call.response_schema is not None:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "sciretriever_structured_result",
                    "strict": True,
                    "schema": parse_strict_json_object(call.response_schema),
                },
            }
        if call.tools:
            body["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": tool["name"],
                        "description": tool["description"],
                        "parameters": tool["parameters"],
                        "strict": tool["strict"],
                    },
                }
                for tool in tool_declarations(call)
            ]
            body["tool_choice"] = "required"
        if call.reasoning_effort is not AgentReasoningEffort.PROVIDER_DEFAULT:
            body["reasoning_effort"] = call.reasoning_effort.value
        return canonical_json_bytes(body)

    def _parse_result(self, body: bytes, call: AgentProviderCall) -> _ParsedResult:
        root = _chat_root(body, call)
        usage = usage_from_payload(root.get("usage"))
        choice = _single_chat_choice(root)
        finish_reason = choice.get("finish_reason")
        message = _assistant_message(choice)
        if call.tools:
            return _chat_tool_result(message, finish_reason, usage)
        return _chat_text_result(message, finish_reason, usage)

    def _provider_parameters(self) -> dict[str, object]:
        return {
            "instruction_role": "developer",
            "structured_output": "response-format-json-schema-strict",
        }


__all__ = ("OpenAIChatCompletionsAdapter",)


def _chat_root(body: bytes, call: AgentProviderCall) -> dict[str, object]:
    try:
        root = parse_strict_json_object(body)
    except (TypeError, ValueError):
        raise provider_failure("protocol") from None
    model = root.get("model")
    if type(model) is not str or model != call.model:
        raise provider_failure("model-mismatch")
    return root


def _single_chat_choice(root: dict[str, object]) -> dict[str, object]:
    choices = root.get("choices")
    if not isinstance(choices, list) or len(choices) != 1:
        raise provider_failure("protocol")
    choice = choices[0]
    if not isinstance(choice, dict) or choice.get("index") != 0:
        raise provider_failure("protocol")
    return choice


def _assistant_message(choice: dict[str, object]) -> dict[str, object]:
    message = choice.get("message")
    if not isinstance(message, dict) or message.get("role") != "assistant":
        raise provider_failure("protocol")
    return message


def _chat_tool_result(
    message: dict[str, object],
    finish_reason: object,
    usage: AgentUsage,
) -> _ParsedResult:
    if finish_reason != "tool_calls":
        raise provider_failure("tool")
    if message.get("content") is not None and message.get("content") != "":
        raise provider_failure("tool")
    if message.get("refusal") is not None and message.get("refusal") != "":
        raise provider_failure("refusal")
    tool_calls = message.get("tool_calls")
    if not isinstance(tool_calls, list) or len(tool_calls) != 1:
        raise provider_failure("tool")
    tool_call = tool_calls[0]
    if not isinstance(tool_call, dict):
        raise provider_failure("tool")
    function = tool_call.get("function")
    if not isinstance(function, dict):
        raise provider_failure("tool")
    name = function.get("name")
    arguments = function.get("arguments")
    if type(name) is not str or type(arguments) is not str:
        raise provider_failure("tool")
    return _ParsedResult.tool(name, arguments, usage)


def _chat_text_result(
    message: dict[str, object],
    finish_reason: object,
    usage: AgentUsage,
) -> _ParsedResult:
    if finish_reason == "length":
        raise provider_failure("truncated")
    if finish_reason != "stop":
        raise provider_failure("protocol")
    if message.get("refusal") not in {None, ""}:
        raise provider_failure("refusal")
    content = message.get("content")
    if type(content) is not str:
        raise provider_failure("protocol")
    return _ParsedResult.structured(content, usage)
