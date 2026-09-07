"""OpenAI Responses API adapter for the provider-neutral Agents port."""

from __future__ import annotations

import re
from typing import Final

from sciretriever.agents.calls import AgentCallLimits
from sciretriever.agents.ports import AgentProviderCall
from sciretriever.agents.providers.base import (
    OPENAI_BASELINE_ACCESS_POLICY,
    ProviderHttpAdapterBase,
    _ParsedResult,
    agent_http_connection,
    openai_responses_input_parts,
    provider_failure,
    tool_declarations,
    usage_from_payload,
)
from sciretriever.agents.providers.sse import parse_sse_events
from sciretriever.agents.tools import canonical_json_bytes, parse_strict_json_object
from sciretriever.logging.api import get_logger
from sciretriever.model.access import Header
from sciretriever.model.configuration import AgentReasoningEffort
from sciretriever.network.admission import AccessPolicy
from sciretriever.network.http import HttpClient

_PROVIDER_NAME = "openai"
_PROTOCOL_REVISION = "responses-v1"
_SAFE_EVENT_TYPE: Final[re.Pattern[str]] = re.compile(
    r"^[a-z][a-z0-9_.-]{0,127}$",
    re.ASCII,
)
_LOGGER = get_logger("sciretriever.agents")


class OpenAIResponsesAdapter(ProviderHttpAdapterBase):
    """Bounded OpenAI Responses API implementation with no SDK dependency."""

    def __init__(
        self,
        *,
        http_client: HttpClient,
        api_key: str | None,
        base_url: str = "https://api.openai.com/v1",
        limits: AgentCallLimits | None = None,
        access_policy: AccessPolicy | None = None,
        provider_name: str = _PROVIDER_NAME,
        service_name: str = "responses",
    ) -> None:
        from sciretriever.network.admission import AccessScope

        endpoint, credential_origin, destination_policy = agent_http_connection(
            base_url=base_url,
            endpoint_suffix="/responses",
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
            "input": [
                {
                    "role": "developer",
                    "content": [{"type": "input_text", "text": call.prompt}],
                },
                {"role": "user", "content": openai_responses_input_parts(call)},
            ],
            "max_output_tokens": call.max_output_tokens,
            "stream": call.stream,
        }
        if call.response_schema is not None:
            body["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": "sciretriever_structured_result",
                    "strict": True,
                    "schema": parse_strict_json_object(call.response_schema),
                }
            }
        if call.tools:
            body["tools"] = tool_declarations(call)
            body["tool_choice"] = "required"
        if call.reasoning_effort is not AgentReasoningEffort.PROVIDER_DEFAULT:
            body["reasoning"] = {"effort": call.reasoning_effort.value}
        return canonical_json_bytes(body)

    def _parse_result(self, body: bytes, call: AgentProviderCall) -> _ParsedResult:
        root = _response_root(body, call)
        usage = usage_from_payload(root.get("usage"))
        output = root.get("output")
        if not isinstance(output, list):
            raise provider_failure("protocol")
        if call.tools:
            calls: list[dict[str, object]] = []
            for item in output:
                if not isinstance(item, dict):
                    raise provider_failure("tool")
                item_type = item.get("type")
                if item_type == "function_call":
                    calls.append(item)
                elif item_type != "reasoning":
                    # A tool decision must not be accompanied by assistant
                    # text/message content.  Reasoning envelopes are opaque
                    # provider metadata and never cross the adapter.
                    raise provider_failure("tool")
            if len(calls) != 1:
                raise provider_failure("tool")
            call_item = calls[0]
            name = call_item.get("name")
            arguments = call_item.get("arguments")
            if type(name) is not str or type(arguments) is not str:
                raise provider_failure("tool")
            return _ParsedResult.tool(name, arguments, usage)
        return _ParsedResult.structured(_message_text(_single_message(output)), usage)

    def _provider_parameters(self) -> dict[str, object]:
        return {
            "instruction_role": "developer",
            "response_mode": "model-selected",
            "structured_output": "json-schema-strict",
        }


def _response_root(body: bytes, call: AgentProviderCall) -> dict[str, object]:
    if call.stream:
        root = _stream_response(body)
    else:
        try:
            root = parse_strict_json_object(body)
        except (TypeError, ValueError):
            raise provider_failure("protocol") from None
    return _validate_response_root(root, call)


def _validate_response_root(
    root: dict[str, object],
    call: AgentProviderCall,
) -> dict[str, object]:
    """Validate the terminal Responses object reconstructed from SSE."""

    if not isinstance(root, dict):
        raise _protocol_failure("terminal-not-object")
    if root.get("object") != "response":
        raise _protocol_failure("terminal-object")
    status = root.get("status")
    if status == "incomplete":
        details = root.get("incomplete_details")
        if isinstance(details, dict) and details.get("reason") == "max_output_tokens":
            raise provider_failure("truncated")
        raise _protocol_failure("terminal-incomplete")
    if status != "completed":
        raise _protocol_failure("terminal-status")
    if root.get("model") != call.model:
        raise provider_failure("model-mismatch")
    return root


def _stream_response(body: bytes) -> dict[str, object]:  # noqa: C901
    """Reconstruct one terminal Responses object from a bounded SSE body.

    Network has already bounded and fully read the response bytes.  The
    adapter deliberately consumes only terminal response data and completed
    output items; token deltas never cross the provider boundary.  Some
    OpenAI-compatible gateways leave ``response.completed.response.output``
    empty, so completed output-item events are the authoritative fallback.
    """

    output_items: dict[int, dict[str, object]] = {}
    completed_text: dict[tuple[int, int], str] = {}
    terminal: dict[str, object] | None = None

    events, done_seen = parse_sse_events(body, allow_done=True)
    for event in events:
        event_name, data = event.event, event.data
        if terminal is not None:
            raise _protocol_failure("event-after-terminal")
        try:
            payload = parse_strict_json_object(data)
        except (TypeError, ValueError):
            raise _protocol_failure("event-json") from None
        payload_type = payload.get("type")
        if type(payload_type) is not str:
            raise _protocol_failure("event-type")
        if event_name is not None and event_name != payload_type:
            raise _protocol_failure("event-name-mismatch")
        event_type = payload_type

        if event_type == "response.output_item.done":
            index = _event_index(payload.get("output_index"))
            item = payload.get("item")
            if index in output_items or not isinstance(item, dict):
                raise _protocol_failure("output-item-done")
            # Re-encode and parse to apply the same finite/depth/key checks to
            # nested item data that a complete JSON response receives.
            try:
                output_items[index] = parse_strict_json_object(canonical_json_bytes(item))
            except (TypeError, ValueError):
                raise _protocol_failure("output-item-json") from None
            continue

        if event_type == "response.output_text.done":
            output_index = _event_index(payload.get("output_index"))
            content_index = _event_index(payload.get("content_index"))
            value = payload.get("text")
            key = (output_index, content_index)
            if type(value) is not str or key in completed_text:
                raise _protocol_failure("output-text-done")
            completed_text[key] = value
            continue

        if event_type in {
            "response.completed",
            "response.failed",
            "response.incomplete",
        }:
            response = payload.get("response")
            if not isinstance(response, dict):
                raise _protocol_failure("terminal-response")
            try:
                terminal = parse_strict_json_object(canonical_json_bytes(response))
            except (TypeError, ValueError):
                raise _protocol_failure("terminal-json") from None
            continue

        if event_type == "error":
            raise provider_failure("remote-service")

        if event_type == "keepalive":
            # Some OpenAI-compatible gateways emit an explicitly typed JSON
            # keepalive while a long reasoning response is in progress.  It
            # carries no Responses output and only extends the transport
            # lifetime; all other non-``response.*`` extensions still fail
            # closed below.
            continue

        if event_type.startswith("response."):
            # Responses streams include lifecycle and delta events such as
            # ``response.created``, ``response.output_item.added`` and
            # ``response.output_text.delta`` before their authoritative
            # ``*.done``/terminal events.  They are still strictly framed and
            # JSON-decoded above, but do not need to be accumulated: the
            # bounded completed item/text and terminal response carry the
            # complete value consumed by SciRetriever.
            continue

        raise _protocol_failure("unknown-event", event_type=event_type)

    if terminal is None:
        raise _protocol_failure("terminal-missing")
    if done_seen and not events:
        raise _protocol_failure("done-without-events")

    terminal_output = terminal.get("output")
    if not isinstance(terminal_output, list):
        raise _protocol_failure("terminal-output")
    completed_items = [output_items[index] for index in sorted(output_items)]
    if terminal_output and completed_items:
        try:
            if canonical_json_bytes(terminal_output) != canonical_json_bytes(completed_items):
                raise _protocol_failure("terminal-output-mismatch")
        except (TypeError, ValueError):
            raise _protocol_failure("terminal-output-json") from None
    elif not terminal_output and completed_items:
        terminal = {**terminal, "output": completed_items}
    elif not terminal_output and completed_text:
        if set(completed_text) != {(0, 0)}:
            raise _protocol_failure("completed-text-shape")
        terminal = {
            **terminal,
            "output": [
                {
                    "type": "message",
                    "status": "completed",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": completed_text[(0, 0)],
                        }
                    ],
                }
            ],
        }
    return terminal


def _event_index(value: object) -> int:
    if type(value) is not int or value < 0 or value > 1_000_000:
        raise _protocol_failure("event-index")
    return value


def _protocol_failure(stage: str, *, event_type: str | None = None) -> Exception:
    """Return a stable failure after recording only a payload-free parse stage."""

    safe_event_type = (
        event_type
        if type(event_type) is str and _SAFE_EVENT_TYPE.fullmatch(event_type) is not None
        else "none"
    )
    _LOGGER.debug(
        "event=agent-protocol-diagnostic protocol=%s stage=%s event_type=%s",
        _PROTOCOL_REVISION,
        stage,
        safe_event_type,
    )
    return provider_failure("protocol")


def _single_message(output: object) -> dict[str, object]:
    if not isinstance(output, list):
        raise provider_failure("protocol")
    messages: list[dict[str, object]] = []
    for item in output:
        if not isinstance(item, dict):
            raise provider_failure("protocol")
        item_type = item.get("type")
        if item_type == "message":
            messages.append(item)
        elif item_type != "reasoning":
            raise provider_failure("protocol")
    if len(messages) != 1:
        raise provider_failure("protocol")
    return messages[0]


def _message_text(message: dict[str, object]) -> str:
    if message.get("status") != "completed" or message.get("role") != "assistant":
        raise provider_failure("protocol")
    content = message.get("content")
    if not isinstance(content, list) or not content:
        raise provider_failure("protocol")
    if any(isinstance(item, dict) and item.get("type") == "refusal" for item in content):
        raise provider_failure("refusal")
    if len(content) != 1 or not isinstance(content[0], dict):
        raise provider_failure("protocol")
    output_text = content[0]
    text = output_text.get("text")
    if output_text.get("type") != "output_text" or type(text) is not str:
        raise provider_failure("protocol")
    return text


__all__ = ("OpenAIResponsesAdapter",)
