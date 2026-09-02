"""Anthropic Messages API adapter for the provider-neutral Agents port."""

from __future__ import annotations

from sciretriever.agents.calls import AgentCallLimits, AgentUsage
from sciretriever.agents.ports import AgentProviderCall
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
from sciretriever.agents.providers.sse import parse_sse_events
from sciretriever.agents.tools import canonical_json_bytes, parse_strict_json_object
from sciretriever.model.access import Header
from sciretriever.model.configuration import AgentReasoningEffort
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
        limits: AgentCallLimits | None = None,
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
            limits=limits or AgentCallLimits(),
            access_policy=access_policy,
            provider_name=provider_name,
            endpoint=endpoint,
            credential_origin=credential_origin,
            destination_policy=destination_policy,
            access_scope=AccessScope(provider_name, "api", service_name),
            baseline_policy=ANTHROPIC_BASELINE_ACCESS_POLICY,
            protocol_revision=_PROTOCOL_REVISION,
        )

    def _safe_headers(self, call: AgentProviderCall) -> tuple[Header, ...]:
        return (
            Header(
                name="Accept",
                value="text/event-stream" if call.stream else "application/json",
            ),
            Header(name="Content-Type", value="application/json"),
            Header(name="Anthropic-Version", value=_ANTHROPIC_VERSION),
        )

    def _credential_headers(self) -> tuple[tuple[str, str], ...]:
        return () if self._api_key is None else (("X-Api-Key", self._api_key),)

    def _build_request_body(self, call: AgentProviderCall) -> bytes:
        body: dict[str, object] = {
            "model": call.model,
            "max_tokens": call.max_output_tokens,
            "system": call.prompt,
            "messages": [{"role": "user", "content": anthropic_input_parts(call)}],
            "stream": call.stream,
        }
        if call.response_schema is not None:
            body["output_config"] = {
                "format": {
                    "type": "json_schema",
                    "schema": parse_strict_json_object(call.response_schema),
                }
            }
        if call.reasoning_effort is not AgentReasoningEffort.PROVIDER_DEFAULT:
            output_config = body.setdefault("output_config", {})
            if not isinstance(output_config, dict):  # pragma: no cover - local invariant.
                raise TypeError("Anthropic output configuration is invalid")
            output_config["effort"] = call.reasoning_effort.value
        if call.tools:
            body["tools"] = tool_declarations(call, anthropic=True)
            body["tool_choice"] = {"type": "any"}
        return canonical_json_bytes(body)

    def _parse_result(self, body: bytes, call: AgentProviderCall) -> _ParsedResult:
        root = _anthropic_stream_root(body, call) if call.stream else _anthropic_root(body, call)
        usage = usage_from_payload(root.get("usage"))
        stop_reason, content = _anthropic_content(root)
        if call.tools:
            return _anthropic_tool_result(content, stop_reason, usage)
        return _anthropic_text_result(content, stop_reason, usage)

    def _provider_parameters(self) -> dict[str, object]:
        return {
            "anthropic_version": _ANTHROPIC_VERSION,
            "response_mode": "model-selected",
            "structured_output": "output-config-json-schema",
        }


__all__ = ("AnthropicMessagesAdapter",)


def _anthropic_root(body: bytes, call: AgentProviderCall) -> dict[str, object]:
    try:
        root = parse_strict_json_object(body)
    except (TypeError, ValueError):
        raise provider_failure("protocol") from None
    if root.get("type") != "message" or root.get("role") != "assistant":
        raise provider_failure("protocol")
    if root.get("model") != call.model:
        raise provider_failure("model-mismatch")
    return root


def _anthropic_stream_root(  # noqa: C901
    body: bytes,
    call: AgentProviderCall,
) -> dict[str, object]:
    """Rebuild one complete Anthropic Message from bounded SSE events."""

    events, done_seen = parse_sse_events(body, allow_done=False)
    if done_seen:
        raise provider_failure("protocol")
    started = False
    stopped = False
    delta_seen = False
    input_tokens: int | None = None
    output_tokens: int | None = None
    stop_reason: str | None = None
    active_index: int | None = None
    active: dict[str, object] | None = None
    content: list[dict[str, object]] = []

    for event in events:
        if stopped:
            raise provider_failure("protocol")
        try:
            payload = parse_strict_json_object(event.data)
        except (TypeError, ValueError):
            raise provider_failure("protocol") from None
        event_type = payload.get("type")
        if type(event_type) is not str:
            raise provider_failure("protocol")
        if event.event is not None and event.event != event_type:
            raise provider_failure("protocol")
        if event_type == "error":
            raise provider_failure("remote-service")
        if event_type == "ping":
            continue
        if event_type == "message_start":
            if started:
                raise provider_failure("protocol")
            message = payload.get("message")
            if not isinstance(message, dict):
                raise provider_failure("protocol")
            _validate_anthropic_stream_start(message, call)
            usage = message.get("usage")
            if not isinstance(usage, dict):
                raise provider_failure("protocol")
            input_tokens = _anthropic_usage_counter(usage, "input_tokens")
            _anthropic_usage_counter(usage, "output_tokens")
            started = True
            continue
        if not started:
            raise provider_failure("protocol")
        if event_type == "content_block_start":
            if active is not None or delta_seen:
                raise provider_failure("protocol")
            index = _anthropic_event_index(payload.get("index"))
            if index != len(content):
                raise provider_failure("protocol")
            block = payload.get("content_block")
            if not isinstance(block, dict):
                raise provider_failure("protocol")
            active = _start_anthropic_block(block)
            active_index = index
            continue
        if event_type == "content_block_delta":
            index = _anthropic_event_index(payload.get("index"))
            delta = payload.get("delta")
            if active is None or active_index != index or not isinstance(delta, dict):
                raise provider_failure("protocol")
            _append_anthropic_block_delta(active, delta)
            continue
        if event_type == "content_block_stop":
            index = _anthropic_event_index(payload.get("index"))
            if active is None or active_index != index:
                raise provider_failure("protocol")
            content.append(_finish_anthropic_block(active))
            active = None
            active_index = None
            continue
        if event_type == "message_delta":
            if active is not None or delta_seen:
                raise provider_failure("protocol")
            delta = payload.get("delta")
            usage = payload.get("usage")
            if not isinstance(delta, dict) or not isinstance(usage, dict):
                raise provider_failure("protocol")
            reason = delta.get("stop_reason")
            if type(reason) is not str or not reason:
                raise provider_failure("protocol")
            stop_reason = reason
            output_tokens = _anthropic_usage_counter(usage, "output_tokens")
            delta_seen = True
            continue
        if event_type == "message_stop":
            if active is not None or not delta_seen:
                raise provider_failure("protocol")
            stopped = True
            continue
        raise provider_failure("protocol")

    if (
        not started
        or not stopped
        or input_tokens is None
        or output_tokens is None
        or stop_reason is None
    ):
        raise provider_failure("protocol")
    return {
        "type": "message",
        "role": "assistant",
        "model": call.model,
        "content": content,
        "stop_reason": stop_reason,
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        },
    }


def _validate_anthropic_stream_start(
    message: dict[str, object],
    call: AgentProviderCall,
) -> None:
    if message.get("type") != "message" or message.get("role") != "assistant":
        raise provider_failure("protocol")
    if message.get("model") != call.model:
        raise provider_failure("model-mismatch")
    if message.get("content") != [] or message.get("stop_reason") is not None:
        raise provider_failure("protocol")


def _anthropic_usage_counter(payload: dict[str, object], name: str) -> int:
    value = payload.get(name)
    if type(value) is not int or value < 0 or value > 10**9:
        raise provider_failure("protocol")
    return value


def _anthropic_event_index(value: object) -> int:
    if type(value) is not int or value < 0 or value > 1_000_000:
        raise provider_failure("protocol")
    return value


def _start_anthropic_block(block: dict[str, object]) -> dict[str, object]:
    block_type = block.get("type")
    if block_type == "text":
        text = block.get("text")
        if type(text) is not str:
            raise provider_failure("protocol")
        return {"type": "text", "parts": [text]}
    if block_type == "tool_use":
        identifier = block.get("id")
        name = block.get("name")
        value = block.get("input")
        if type(identifier) is not str or type(name) is not str or not isinstance(value, dict):
            raise provider_failure("tool")
        try:
            initial = parse_strict_json_object(canonical_json_bytes(value))
        except (TypeError, ValueError):
            raise provider_failure("tool") from None
        return {
            "type": "tool_use",
            "id": identifier,
            "name": name,
            "initial": initial,
            "parts": [],
        }
    if block_type == "thinking":
        thinking = block.get("thinking")
        if type(thinking) is not str:
            raise provider_failure("protocol")
        return {"type": "thinking", "parts": [thinking], "signature_parts": []}
    if block_type == "redacted_thinking":
        data = block.get("data")
        if type(data) is not str:
            raise provider_failure("protocol")
        return {"type": "redacted_thinking", "data": data}
    raise provider_failure("protocol")


def _append_anthropic_block_delta(
    active: dict[str, object],
    delta: dict[str, object],
) -> None:
    block_type = active.get("type")
    delta_type = delta.get("type")
    if block_type == "text" and delta_type == "text_delta":
        _append_anthropic_fragment(active, "parts", delta.get("text"))
        return
    if block_type == "tool_use" and delta_type == "input_json_delta":
        _append_anthropic_fragment(active, "parts", delta.get("partial_json"))
        return
    if block_type == "thinking" and delta_type == "thinking_delta":
        _append_anthropic_fragment(active, "parts", delta.get("thinking"))
        return
    if block_type == "thinking" and delta_type == "signature_delta":
        _append_anthropic_fragment(active, "signature_parts", delta.get("signature"))
        return
    raise provider_failure("protocol")


def _append_anthropic_fragment(
    active: dict[str, object],
    field: str,
    value: object,
) -> None:
    parts = active.get(field)
    if not isinstance(parts, list) or type(value) is not str:
        raise provider_failure("protocol")
    parts.append(value)


def _finish_anthropic_block(active: dict[str, object]) -> dict[str, object]:
    block_type = active.get("type")
    if block_type == "text":
        return {"type": "text", "text": _joined_anthropic_fragments(active, "parts")}
    if block_type == "tool_use":
        initial = active.get("initial")
        partial = _joined_anthropic_fragments(active, "parts")
        if partial:
            if initial != {}:
                raise provider_failure("tool")
            try:
                value = parse_strict_json_object(partial)
            except (TypeError, ValueError):
                raise provider_failure("tool") from None
        else:
            if not isinstance(initial, dict):
                raise provider_failure("tool")
            value = initial
        return {
            "type": "tool_use",
            "id": active["id"],
            "name": active["name"],
            "input": value,
        }
    if block_type == "thinking":
        result: dict[str, object] = {
            "type": "thinking",
            "thinking": _joined_anthropic_fragments(active, "parts"),
        }
        signature = _joined_anthropic_fragments(active, "signature_parts")
        if signature:
            result["signature"] = signature
        return result
    if block_type == "redacted_thinking":
        return {"type": "redacted_thinking", "data": active["data"]}
    raise provider_failure("protocol")


def _joined_anthropic_fragments(active: dict[str, object], field: str) -> str:
    value = active.get(field)
    if not isinstance(value, list) or any(type(item) is not str for item in value):
        raise provider_failure("protocol")
    return "".join(value)


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
