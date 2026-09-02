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
from sciretriever.agents.providers.sse import parse_sse_events
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

    def _safe_headers(self, call: AgentProviderCall) -> tuple[Header, ...]:
        return (
            Header(
                name="Accept",
                value="text/event-stream" if call.stream else "application/json",
            ),
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
            "stream": call.stream,
        }
        if call.stream:
            body["stream_options"] = {"include_usage": True}
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
        root = _chat_stream_root(body, call) if call.stream else _chat_root(body, call)
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
            "response_mode": "model-selected",
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


def _chat_stream_root(body: bytes, call: AgentProviderCall) -> dict[str, object]:  # noqa: C901
    """Rebuild one complete Chat Completions envelope from bounded SSE."""

    events, done_seen = parse_sse_events(body, allow_done=True)
    if not done_seen:
        raise provider_failure("protocol")
    content_parts: list[str] = []
    refusal_parts: list[str] = []
    tool_name_parts: list[str] = []
    tool_argument_parts: list[str] = []
    tool_seen = False
    role_seen = False
    finish_reason: str | None = None
    usage_payload: dict[str, object] | None = None

    for event in events:
        if finish_reason is not None:
            # Only the final usage-only chunk may follow the finished choice.
            try:
                terminal_payload = parse_strict_json_object(event.data)
            except (TypeError, ValueError):
                raise provider_failure("protocol") from None
            _validate_chat_stream_event(event.event, terminal_payload, call)
            if terminal_payload.get("choices") != [] or usage_payload is not None:
                raise provider_failure("protocol")
            usage_value = terminal_payload.get("usage")
            usage_from_payload(usage_value)
            assert isinstance(usage_value, dict)
            usage_payload = usage_value
            continue

        try:
            payload = parse_strict_json_object(event.data)
        except (TypeError, ValueError):
            raise provider_failure("protocol") from None
        _validate_chat_stream_event(event.event, payload, call)
        choices = payload.get("choices")
        if not isinstance(choices, list):
            raise provider_failure("protocol")
        usage_value = payload.get("usage")
        if usage_value is not None:
            if usage_payload is not None:
                raise provider_failure("protocol")
            usage_from_payload(usage_value)
            assert isinstance(usage_value, dict)
            usage_payload = usage_value
        if not choices:
            # A usage-only chunk is terminal metadata and cannot precede the
            # choice's finish reason.
            raise provider_failure("protocol")
        if len(choices) != 1 or not isinstance(choices[0], dict):
            raise provider_failure("protocol")
        choice = choices[0]
        if choice.get("index") != 0:
            raise provider_failure("protocol")
        delta = choice.get("delta")
        if not isinstance(delta, dict):
            raise provider_failure("protocol")
        role = delta.get("role")
        if role is not None:
            if role != "assistant" or role_seen:
                raise provider_failure("protocol")
            role_seen = True
        _append_optional_fragment(delta, "content", content_parts)
        _append_optional_fragment(delta, "refusal", refusal_parts)
        if "tool_calls" in delta:
            tool_seen = _append_chat_tool_delta(
                delta.get("tool_calls"),
                tool_name_parts,
                tool_argument_parts,
                seen=tool_seen,
            )
        reason = choice.get("finish_reason")
        if reason is not None:
            if type(reason) is not str or not reason:
                raise provider_failure("protocol")
            finish_reason = reason

    if finish_reason is None or usage_payload is None:
        raise provider_failure("protocol")
    if tool_seen and not call.tools:
        raise provider_failure("protocol")
    message: dict[str, object] = {
        "role": "assistant",
        "content": "".join(content_parts) if content_parts else None,
    }
    if refusal_parts:
        message["refusal"] = "".join(refusal_parts)
    if tool_seen:
        message["tool_calls"] = [
            {
                "type": "function",
                "function": {
                    "name": "".join(tool_name_parts),
                    "arguments": "".join(tool_argument_parts),
                },
            }
        ]
    return {
        "model": call.model,
        "choices": [
            {
                "index": 0,
                "finish_reason": finish_reason,
                "message": message,
            }
        ],
        "usage": usage_payload,
    }


def _validate_chat_stream_event(
    event_name: str | None,
    payload: dict[str, object],
    call: AgentProviderCall,
) -> None:
    object_name = payload.get("object")
    if object_name != "chat.completion.chunk":
        raise provider_failure("protocol")
    if event_name is not None and event_name != object_name:
        raise provider_failure("protocol")
    if payload.get("model") != call.model:
        raise provider_failure("model-mismatch")


def _append_optional_fragment(
    payload: dict[str, object],
    name: str,
    destination: list[str],
) -> None:
    if name not in payload or payload[name] is None:
        return
    value = payload[name]
    if type(value) is not str:
        raise provider_failure("protocol")
    destination.append(value)


def _append_chat_tool_delta(
    value: object,
    names: list[str],
    arguments: list[str],
    *,
    seen: bool,
) -> bool:
    if not isinstance(value, list):
        raise provider_failure("protocol")
    if not value:
        return seen
    if len(value) != 1 or not isinstance(value[0], dict):
        raise provider_failure("tool")
    item = value[0]
    if item.get("index") != 0:
        raise provider_failure("tool")
    if "type" in item and item["type"] != "function":
        raise provider_failure("tool")
    if "id" in item and type(item["id"]) is not str:
        raise provider_failure("tool")
    function = item.get("function")
    if not isinstance(function, dict):
        raise provider_failure("tool")
    _append_optional_fragment(function, "name", names)
    _append_optional_fragment(function, "arguments", arguments)
    return True


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
