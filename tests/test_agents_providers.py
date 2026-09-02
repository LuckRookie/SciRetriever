from __future__ import annotations

import ast
import json
import threading
import unittest
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from sciretriever.agents.api import (
    AgentCall,
    AgentCallLimits,
    AgentCapability,
    AgentFailure,
    AgentImagePart,
    AgentModelCapabilities,
    AgentProvenance,
    AgentRole,
    AgentRoleBinding,
    AgentRuntime,
    AgentStructuredResult,
    AgentTextPart,
    AgentToolCall,
    AgentToolDeclaration,
)
from sciretriever.agents.ports import AgentProviderCall, AgentProviderPort
from sciretriever.agents.providers.anthropic import AnthropicMessagesAdapter
from sciretriever.agents.providers.base import (
    ANTHROPIC_ACCESS_SCOPE,
    OPENAI_ACCESS_SCOPE,
)
from sciretriever.agents.providers.openai_chat import (
    OpenAIChatCompletionsAdapter,
)
from sciretriever.agents.providers.openai_responses import OpenAIResponsesAdapter
from sciretriever.analysis.metadata import MetadataAnalysisStage, MetadataStageInput
from sciretriever.analysis.metadata_rules import metadata_input_sha256
from sciretriever.analysis.ports import (
    AnalysisCall,
    AnalysisRequest,
    AnalysisRequestKind,
    canonical_json_bytes,
)
from sciretriever.model.access import Header, TransportRequest
from sciretriever.model.configuration import AgentReasoningEffort
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.parsing import (
    ParserArtifactRef,
    ParserProvenance,
    ParserResult,
    parser_result_sha256,
)
from sciretriever.model.primitives import (
    AssetId,
    ProvenanceId,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.network.admission import (
    AccessCoordinator,
    AccessFeedback,
    AccessPermit,
    AccessScope,
)
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import ResolvedDestination

_FIXTURES = Path(__file__).parent / "fixtures" / "analysis" / "providers"
_OPENAI_MODEL = "fixture-openai-model"
_ANTHROPIC_MODEL = "fixture-anthropic-model"
_API_KEY = "ANALYSIS-SECRET-SENTINEL"
_PROMPT = "PROMPT-PRIVATE-SENTINEL"
_INPUT = '{"document":"INPUT-PRIVATE-SENTINEL"}'
_SCHEMA = (
    '{"type":"object","properties":{"outcome":{"type":"string"}},'
    '"required":["outcome"],"additionalProperties":true}'
)
_DEEP_SENTINEL = "DEEP-PRIVATE-SENTINEL"
_DEEP_JSON_DEPTH = 10_000


class _Resolver:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def resolve(self, hostname: str) -> tuple[str, ...]:
        self.calls.append(hostname)
        return ("93.184.216.34",)


@dataclass
class _RawResponse:
    status: int
    headers: tuple[Header, ...]
    body: bytes | Iterable[bytes]
    closed: bool = False

    def close(self) -> None:
        self.closed = True


class _FakeTransport:
    def __init__(self, actions: Iterable[object]) -> None:
        self.actions = list(actions)
        self.calls: list[dict[str, object]] = []

    def send(
        self,
        request: object,
        destination: object,
        *,
        headers: tuple[tuple[str, str], ...],
        request_target_renderer: object,
        connect_timeout_seconds: float,
        read_timeout_seconds: float,
        tls_server_hostname: str | None,
        cancel_event: threading.Event | None,
    ) -> object:
        self.calls.append(
            {
                "request": request,
                "destination": destination,
                "headers": headers,
                "request_target_renderer": request_target_renderer,
                "connect_timeout_seconds": connect_timeout_seconds,
                "read_timeout_seconds": read_timeout_seconds,
                "tls_server_hostname": tls_server_hostname,
                "cancel_event": cancel_event,
            }
        )
        action = self.actions.pop(0)
        if isinstance(action, BaseException):
            raise action
        return action


class _RecordingCoordinator(AccessCoordinator):
    def __init__(self) -> None:
        super().__init__()
        self.feedback: list[tuple[AccessScope, AccessFeedback]] = []

    def record_feedback(
        self,
        source: AccessPermit | AccessScope,
        feedback: AccessFeedback,
    ) -> None:
        scope = source.scope if isinstance(source, AccessPermit) else source
        self.feedback.append((scope, feedback))
        super().record_feedback(source, feedback)


class _MetadataCallCapture:
    def __init__(self) -> None:
        self.calls: list[AgentProviderCall] = []

    @property
    def provider_name(self) -> str:
        return "metadata-schema-capture"

    def execute(self, call: AgentProviderCall) -> AgentStructuredResult:
        self.calls.append(call)
        if call.response_schema is None:
            raise AssertionError("metadata stage did not declare a schema")
        schema = json.loads(call.response_schema)
        result = (
            '{"outcome":"no_usable_content"}'
            if "oneOf" in schema
            else '{"metadata":null,"outcome":"no_usable_content"}'
        )
        return AgentStructuredResult(
            result=result,
            provenance=AgentProvenance(
                provider=self.provider_name,
                model=call.model,
                input_sha256=call.input_sha256,
                parameters_sha256=sha256_digest(b"metadata schema capture"),
            ),
        )


def _fixture(provider: str, name: str) -> bytes:
    return (_FIXTURES / provider / f"{name}.json").read_bytes()


def _sse_event(event: str | None, data: object) -> bytes:
    if isinstance(data, bytes):
        encoded = data
    elif isinstance(data, str):
        encoded = data.encode("utf-8")
    else:
        encoded = json.dumps(data, separators=(",", ":")).encode("utf-8")
    prefix = b"" if event is None else f"event: {event}\n".encode("ascii")
    return prefix + b"data: " + encoded + b"\n\n"


def _responses_stream(payload: dict[str, object]) -> bytes:
    """Build a Responses SSE body whose terminal output is intentionally empty."""

    terminal = cast(dict[str, object], json.loads(json.dumps(payload)))
    blocks: list[bytes] = []
    output = terminal.get("output")
    if isinstance(output, list):
        for index, item in enumerate(output):
            blocks.append(
                _sse_event(
                    "response.output_item.done",
                    {
                        "type": "response.output_item.done",
                        "output_index": index,
                        "item": item,
                    },
                )
            )
        terminal["output"] = []
    status = terminal.get("status")
    event = (
        {
            "completed": "response.completed",
            "failed": "response.failed",
            "incomplete": "response.incomplete",
        }.get(status)
        if type(status) is str
        else None
    )
    if event is None:
        event = "response.completed"
    blocks.append(_sse_event(event, {"type": event, "response": terminal}))
    return b"".join(blocks)


def _openai_fixture(name: str) -> bytes:
    return _responses_stream(cast(dict[str, object], json.loads(_fixture("openai", name))))


def _chat_stream(payload: dict[str, object]) -> bytes:
    """Build the standard Chat chunk sequence including terminal usage and DONE."""

    model = payload["model"]
    usage = payload["usage"]
    choices = cast(list[dict[str, object]], payload["choices"])
    choice = choices[0]
    message = cast(dict[str, object], choice["message"])

    def chunk(delta: dict[str, object], finish_reason: object = None) -> bytes:
        return _sse_event(
            None,
            {
                "object": "chat.completion.chunk",
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": delta,
                        "finish_reason": finish_reason,
                    }
                ],
                "usage": None,
            },
        )

    blocks = [chunk({"role": "assistant"})]
    content = message.get("content")
    if type(content) is str and content:
        midpoint = max(1, len(content) // 2)
        blocks.extend(
            (chunk({"content": content[:midpoint]}), chunk({"content": content[midpoint:]}))
        )
    refusal = message.get("refusal")
    if type(refusal) is str and refusal:
        blocks.append(chunk({"refusal": refusal}))
    tool_calls = message.get("tool_calls")
    if isinstance(tool_calls, list) and tool_calls:
        tool_call = cast(dict[str, object], tool_calls[0])
        function = cast(dict[str, object], tool_call["function"])
        blocks.append(
            chunk(
                {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_fixture",
                            "type": "function",
                            "function": {
                                "name": function["name"],
                                "arguments": function["arguments"],
                            },
                        }
                    ]
                }
            )
        )
    blocks.append(chunk({}, choice.get("finish_reason")))
    blocks.append(
        _sse_event(
            None,
            {
                "object": "chat.completion.chunk",
                "model": model,
                "choices": [],
                "usage": usage,
            },
        )
    )
    blocks.append(_sse_event(None, "[DONE]"))
    return b"".join(blocks)


def _anthropic_stream(payload: dict[str, object]) -> bytes:
    """Build one complete Anthropic event sequence from a full Message."""

    usage = cast(dict[str, object], payload["usage"])
    blocks = [
        _sse_event(
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "type": "message",
                    "role": "assistant",
                    "model": payload["model"],
                    "content": [],
                    "stop_reason": None,
                    "usage": {
                        "input_tokens": usage["input_tokens"],
                        "output_tokens": 0,
                    },
                },
            },
        )
    ]
    content = cast(list[dict[str, object]], payload["content"])
    for index, item in enumerate(content):
        item_type = item.get("type")
        if item_type == "text":
            start = {"type": "text", "text": ""}
            delta = {"type": "text_delta", "text": item["text"]}
        elif item_type == "tool_use":
            start = {
                "type": "tool_use",
                "id": item.get("id", "toolu_fixture"),
                "name": item["name"],
                "input": {},
            }
            delta = {
                "type": "input_json_delta",
                "partial_json": json.dumps(item["input"], separators=(",", ":")),
            }
        else:
            start = item
            delta = {"type": "unsupported_delta"}
        blocks.extend(
            (
                _sse_event(
                    "content_block_start",
                    {
                        "type": "content_block_start",
                        "index": index,
                        "content_block": start,
                    },
                ),
                _sse_event(
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": index,
                        "delta": delta,
                    },
                ),
                _sse_event(
                    "content_block_stop",
                    {"type": "content_block_stop", "index": index},
                ),
            )
        )
    blocks.extend(
        (
            _sse_event(
                "message_delta",
                {
                    "type": "message_delta",
                    "delta": {"stop_reason": payload["stop_reason"]},
                    "usage": {"output_tokens": usage["output_tokens"]},
                },
            ),
            _sse_event("message_stop", {"type": "message_stop"}),
        )
    )
    return b"".join(blocks)


def _anthropic_fixture(name: str) -> bytes:
    return _anthropic_stream(cast(dict[str, object], json.loads(_fixture("anthropic", name))))


def _deep_json_object() -> str:
    return (
        '{"child":' * _DEEP_JSON_DEPTH
        + f'{{"value":"{_DEEP_SENTINEL}"}}'
        + ("}" * _DEEP_JSON_DEPTH)
    )


def _deep_python_object() -> object:
    value: object = {"value": _DEEP_SENTINEL}
    for _ in range(_DEEP_JSON_DEPTH):
        value = {"child": value}
    return value


def _response(
    body: bytes,
    *,
    status: int = 200,
    headers: tuple[Header, ...] = (),
) -> _RawResponse:
    return _RawResponse(status=status, headers=headers, body=body)


def _client(
    actions: Iterable[object],
) -> tuple[HttpClient, _FakeTransport, _RecordingCoordinator, _Resolver]:
    transport = _FakeTransport(actions)
    coordinator = _RecordingCoordinator()
    resolver = _Resolver()
    return (
        HttpClient(
            resolver=resolver,
            transport=transport,
            coordinator=coordinator,
        ),
        transport,
        coordinator,
        resolver,
    )


def _call(
    model: str,
    *,
    kind: AnalysisRequestKind = AnalysisRequestKind.METADATA,
    prompt_version: str = "fixture-prompt-v1",
    prompt: str = _PROMPT,
    structured_input: str = _INPUT,
    response_schema: str = _SCHEMA,
    max_output_tokens: int = 64,
    reasoning_effort: AgentReasoningEffort = AgentReasoningEffort.PROVIDER_DEFAULT,
    stream: bool = True,
    cancel_event: threading.Event | None = None,
) -> AgentProviderCall:
    # ``kind`` and ``prompt_version`` are deliberately Analysis-private and
    # must not enter the neutral Agents request or provider provenance.
    del kind, prompt_version
    consumer_call = AgentCall(
        role=AgentRole.ANALYSIS,
        required_capabilities=frozenset({AgentCapability.STRUCTURED_TEXT}),
        input_sha256=sha256_digest(structured_input.encode("utf-8")),
        text_parts=(
            AgentTextPart(media_type="text/plain", text=prompt),
            AgentTextPart(media_type="application/json", text=structured_input),
        ),
        response_schema=response_schema,
        max_output_tokens=max_output_tokens,
    )
    return AgentProviderCall(
        role=consumer_call.role,
        capabilities=consumer_call.required_capabilities,
        model=model,
        input_sha256=consumer_call.input_sha256,
        text_parts=consumer_call.text_parts,
        image_parts=consumer_call.image_parts,
        response_schema=consumer_call.response_schema,
        tools=consumer_call.tools,
        max_output_tokens=consumer_call.max_output_tokens,
        reasoning_effort=reasoning_effort,
        stream=stream,
        cancel_event=cancel_event,
    )


def _tool_call(model: str, *, stream: bool = True) -> AgentProviderCall:
    return AgentProviderCall(
        role=AgentRole.BROWSER,
        capabilities=frozenset({AgentCapability.IMAGE_INPUT, AgentCapability.TOOL_DECISION}),
        model=model,
        input_sha256=sha256_digest(b"tool fixture"),
        text_parts=(
            AgentTextPart(media_type="text/plain", text="Choose one tool."),
            AgentTextPart(media_type="application/json", text='{"page":"fixture"}'),
        ),
        image_parts=(AgentImagePart(media_type="image/png", data=b"PNG", width=1, height=1),),
        tools=(
            AgentToolDeclaration(
                name="click",
                input_schema=(
                    '{"type":"object","properties":{},"required":[],"additionalProperties":false}'
                ),
            ),
        ),
        max_output_tokens=64,
        stream=stream,
    )


def _safe_request(transport: _FakeTransport, index: int = 0) -> TransportRequest:
    request = transport.calls[index]["request"]
    if not isinstance(request, TransportRequest):
        raise AssertionError("transport did not receive a TransportRequest")
    return request


def _destination(transport: _FakeTransport, index: int = 0) -> ResolvedDestination:
    destination = transport.calls[index]["destination"]
    if not isinstance(destination, ResolvedDestination):
        raise AssertionError("transport did not receive a ResolvedDestination")
    return destination


def _body(transport: _FakeTransport, index: int = 0) -> dict[str, object]:
    body = _safe_request(transport, index).body
    if body is None:
        raise AssertionError("provider request body is missing")
    value = json.loads(body)
    if not isinstance(value, dict):
        raise AssertionError("provider request body is not an object")
    return cast(dict[str, object], value)


def _real_metadata_stage_call(model: str) -> AgentProviderCall:
    markdown_bytes = b"# Fixture title\n\nCover page only"
    source_sha256 = sha256_digest(b"fixture source PDF")
    parameters_sha256 = sha256_digest(b"fixture parser parameters")
    artifact = ParserArtifactRef(
        sha256=sha256_digest(markdown_bytes),
        media_type="text/markdown",
        byte_size=len(markdown_bytes),
    )
    parser_provenance = ParserProvenance(
        provenance=Provenance(
            provenance_id=ProvenanceId("10000001-e89b-12d3-a456-426614174000"),
            source_kind=SourceKind.PARSER,
            source_name="fixture-parser",
            source_record_id=None,
            observed_at=UtcTimestamp("2026-08-12T00:00:00Z"),
            input_sha256=source_sha256,
            parameters_sha256=parameters_sha256,
        ),
        parser_version="1.0",
        mode="fixture",
        model_identity=None,
    )
    asset_id = AssetId("10000002-e89b-12d3-a456-426614174000")
    parser_result = ParserResult(
        source_asset_id=asset_id,
        source_sha256=source_sha256,
        page_count=1,
        markdown=artifact,
        resources=(),
        result_sha256=parser_result_sha256(
            source_asset_id=asset_id,
            source_sha256=source_sha256,
            page_count=1,
            markdown=artifact,
            resources=(),
            provenance=parser_provenance,
        ),
        provenance=parser_provenance,
    )
    metadata = LiteratureMetadata(title="Fixture title")
    stage_input = MetadataStageInput(
        parser_result=parser_result,
        parser_markdown_bytes=markdown_bytes,
        initial_metadata=metadata,
        input_metadata_revision=1,
        input_metadata_sha256=metadata_input_sha256(metadata),
        user_observations=(),
    )
    capture = _MetadataCallCapture()
    stage = MetadataAnalysisStage(
        runtime=AgentRuntime(
            adapter=cast(AgentProviderPort, capture),
            analysis=AgentRoleBinding(
                role=AgentRole.ANALYSIS,
                model=model,
                capabilities=AgentModelCapabilities(
                    context_window_tokens=4_096,
                    max_output_tokens=128,
                    structured_output=True,
                ),
            ),
        ),
        max_output_tokens=64,
    )

    stage.analyze(stage_input)

    if len(capture.calls) != 1:
        raise AssertionError("metadata stage did not build exactly one call")
    return capture.calls[0]


class AgentsProviderTests(unittest.TestCase):
    def _failure(self, operation: object) -> AgentFailure:
        if not callable(operation):
            raise TypeError("operation must be callable")
        with self.assertRaises(AgentFailure) as caught:
            operation()
        return caught.exception

    def test_neutral_port_accepts_analysis_turns_without_business_kind(self) -> None:
        client, transport, _, _ = _client([_response(_openai_fixture("success")) for _ in range(3)])
        adapter = OpenAIResponsesAdapter(http_client=client, api_key=_API_KEY)

        self.assertIsInstance(adapter, AgentProviderPort)
        results = [
            adapter.execute(_call(_OPENAI_MODEL, kind=kind))
            for kind in (
                AnalysisRequestKind.METADATA,
                AnalysisRequestKind.CONTENT,
                AnalysisRequestKind.REFERENCE_LOOKUP,
            )
        ]

        self.assertTrue(all(isinstance(value, AgentStructuredResult) for value in results))
        self.assertEqual(len(transport.calls), 3)
        self.assertEqual(
            len({str(value.provenance.parameters_sha256) for value in results}),
            1,
        )
        self.assertTrue(all(isinstance(value, AgentStructuredResult) for value in results))
        structured_results = [
            value for value in results if isinstance(value, AgentStructuredResult)
        ]
        self.assertEqual(
            [value.result for value in structured_results],
            ['{"outcome":"usable","title":"Fixture"}'] * 3,
        )

    def test_openai_uses_responses_protocol_and_private_origin_bound_credential(self) -> None:
        client, transport, _, resolver = _client([_response(_openai_fixture("success"))])
        adapter = OpenAIResponsesAdapter(http_client=client, api_key=_API_KEY)

        result = adapter.execute(_call(_OPENAI_MODEL))

        request = _safe_request(transport)
        body = _body(transport)
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.url, "https://api.openai.com/v1/responses")
        self.assertEqual(_destination(transport).origin.text, "https://api.openai.com")
        self.assertEqual(transport.calls[0]["tls_server_hostname"], "api.openai.com")
        self.assertGreaterEqual(len(resolver.calls), 2)
        self.assertEqual(set(resolver.calls), {"api.openai.com"})
        self.assertNotIn(_API_KEY, repr(request))
        self.assertNotIn(_API_KEY, request.model_dump_json())
        self.assertNotIn("authorization", request.model_dump_json().casefold())
        wire_headers = cast(tuple[tuple[str, str], ...], transport.calls[0]["headers"])
        self.assertIn(("Authorization", f"Bearer {_API_KEY}"), wire_headers)
        self.assertEqual(body["model"], _OPENAI_MODEL)
        self.assertEqual(body["max_output_tokens"], 64)
        self.assertIs(body["stream"], True)
        self.assertIn(Header(name="Accept", value="text/event-stream"), request.headers)
        input_items = cast(list[dict[str, object]], body["input"])
        self.assertEqual([item["role"] for item in input_items], ["developer", "user"])
        developer_content = cast(list[dict[str, object]], input_items[0]["content"])
        user_content = cast(list[dict[str, object]], input_items[1]["content"])
        self.assertEqual(developer_content[0]["text"], _PROMPT)
        self.assertEqual(user_content[0]["text"], _INPUT)
        self.assertEqual(result.provenance.provider, "openai")
        self.assertEqual(result.provenance.model, _OPENAI_MODEL)

    def test_anthropic_uses_messages_protocol_and_private_origin_bound_credential(self) -> None:
        client, transport, _, resolver = _client([_response(_anthropic_fixture("success"))])
        adapter = AnthropicMessagesAdapter(http_client=client, api_key=_API_KEY)

        result = adapter.execute(_call(_ANTHROPIC_MODEL))

        request = _safe_request(transport)
        body = _body(transport)
        self.assertIsInstance(adapter, AgentProviderPort)
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.url, "https://api.anthropic.com/v1/messages")
        self.assertEqual(_destination(transport).origin.text, "https://api.anthropic.com")
        self.assertEqual(transport.calls[0]["tls_server_hostname"], "api.anthropic.com")
        self.assertGreaterEqual(len(resolver.calls), 2)
        self.assertEqual(set(resolver.calls), {"api.anthropic.com"})
        wire_headers = cast(tuple[tuple[str, str], ...], transport.calls[0]["headers"])
        self.assertIn(("X-Api-Key", _API_KEY), wire_headers)
        self.assertIn(("Anthropic-Version", "2023-06-01"), wire_headers)
        self.assertNotIn(_API_KEY, repr(request))
        self.assertEqual(body["model"], _ANTHROPIC_MODEL)
        self.assertEqual(body["max_tokens"], 64)
        self.assertEqual(body["system"], _PROMPT)
        self.assertIs(body["stream"], True)
        self.assertIn(Header(name="Accept", value="text/event-stream"), request.headers)
        messages = cast(list[dict[str, object]], body["messages"])
        self.assertEqual(messages[0]["role"], "user")
        content = cast(list[dict[str, object]], messages[0]["content"])
        self.assertEqual(content[0]["type"], "text")
        self.assertEqual(content[0]["text"], _INPUT)
        self.assertEqual(result.provenance.provider, "anthropic")
        self.assertEqual(result.provenance.model, _ANTHROPIC_MODEL)

    def test_role_reasoning_effort_is_encoded_by_each_protocol_and_hashed(self) -> None:
        chat_response = {
            "model": _OPENAI_MODEL,
            "usage": {"prompt_tokens": 23, "completion_tokens": 11},
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": '{"outcome":"usable","title":"Fixture"}',
                    },
                }
            ],
        }
        cases = (
            (
                OpenAIResponsesAdapter,
                _OPENAI_MODEL,
                _openai_fixture("success"),
                lambda body: cast(dict[str, object], body.get("reasoning")).get("effort"),
            ),
            (
                OpenAIChatCompletionsAdapter,
                _OPENAI_MODEL,
                _chat_stream(chat_response),
                lambda body: body.get("reasoning_effort"),
            ),
            (
                AnthropicMessagesAdapter,
                _ANTHROPIC_MODEL,
                _anthropic_fixture("success"),
                lambda body: cast(dict[str, object], body.get("output_config")).get("effort"),
            ),
        )
        explicit_efforts = tuple(
            effort
            for effort in AgentReasoningEffort
            if effort is not AgentReasoningEffort.PROVIDER_DEFAULT
        )
        for adapter_type, model, response, effort_value in cases:
            with self.subTest(adapter=adapter_type.__name__):
                client, transport, _, _ = _client(
                    [_response(response) for _value in range(1 + len(explicit_efforts))]
                )
                adapter = adapter_type(http_client=client, api_key=_API_KEY)

                default_result = adapter.execute(_call(model))
                default_body = _body(transport, 0)
                self.assertNotIn("reasoning", default_body)
                self.assertNotIn("reasoning_effort", default_body)
                if adapter_type is AnthropicMessagesAdapter:
                    default_output = cast(dict[str, object], default_body["output_config"])
                    self.assertNotIn("effort", default_output)
                for index, effort in enumerate(explicit_efforts, start=1):
                    with self.subTest(effort=effort.value):
                        explicit_result = adapter.execute(_call(model, reasoning_effort=effort))
                        explicit_body = _body(transport, index)
                        self.assertEqual(effort_value(explicit_body), effort.value)
                        self.assertNotEqual(
                            default_result.provenance.parameters_sha256,
                            explicit_result.provenance.parameters_sha256,
                        )

    def test_chat_completions_uses_strict_schema_and_parses_one_assistant_choice(self) -> None:
        response = {
            "id": "chatcmpl-fixture",
            "object": "chat.completion",
            "model": _OPENAI_MODEL,
            "usage": {"prompt_tokens": 23, "completion_tokens": 11},
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": '{"outcome":"usable","title":"Fixture"}',
                        "refusal": None,
                    },
                }
            ],
        }
        client, transport, _, _ = _client([_response(_chat_stream(response))])
        adapter = OpenAIChatCompletionsAdapter(
            http_client=client,
            api_key=_API_KEY,
        )

        result = adapter.execute(_call(_OPENAI_MODEL))

        request = _safe_request(transport)
        body = _body(transport)
        self.assertEqual(request.url, "https://api.openai.com/v1/chat/completions")
        messages = cast(list[dict[str, object]], body["messages"])
        self.assertEqual([item["role"] for item in messages], ["developer", "user"])
        response_format = cast(dict[str, object], body["response_format"])
        self.assertEqual(response_format["type"], "json_schema")
        schema = cast(dict[str, object], response_format["json_schema"])
        self.assertTrue(schema["strict"])
        self.assertEqual(body["max_completion_tokens"], 64)
        self.assertIs(body["stream"], True)
        self.assertEqual(body["stream_options"], {"include_usage": True})
        self.assertIn(Header(name="Accept", value="text/event-stream"), request.headers)
        self.assertEqual(result.provenance.provider, "openai")

    def test_each_protocol_honors_model_stream_and_hashes_the_selected_mode(self) -> None:
        chat = {
            "model": _OPENAI_MODEL,
            "usage": {"prompt_tokens": 23, "completion_tokens": 11},
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": '{"outcome":"usable","title":"Fixture"}',
                    },
                }
            ],
        }
        anthropic = cast(dict[str, object], json.loads(_fixture("anthropic", "success")))
        cases = (
            (
                OpenAIResponsesAdapter,
                _OPENAI_MODEL,
                _openai_fixture("success"),
                _fixture("openai", "success"),
            ),
            (
                OpenAIChatCompletionsAdapter,
                _OPENAI_MODEL,
                _chat_stream(chat),
                json.dumps(chat).encode("utf-8"),
            ),
            (
                AnthropicMessagesAdapter,
                _ANTHROPIC_MODEL,
                _anthropic_stream(anthropic),
                json.dumps(anthropic).encode("utf-8"),
            ),
        )
        for adapter_type, model, streamed, plain in cases:
            with self.subTest(adapter=adapter_type.__name__):
                client, transport, _, _ = _client([_response(streamed), _response(plain)])
                adapter = adapter_type(http_client=client, api_key=_API_KEY)

                streamed_result = adapter.execute(_call(model))
                plain_result = adapter.execute(_call(model, stream=False))

                self.assertEqual(len(transport.calls), 2)
                self.assertIs(_body(transport, 0)["stream"], True)
                self.assertIs(_body(transport, 1)["stream"], False)
                self.assertIn(
                    Header(name="Accept", value="text/event-stream"),
                    _safe_request(transport, 0).headers,
                )
                self.assertIn(
                    Header(name="Accept", value="application/json"),
                    _safe_request(transport, 1).headers,
                )
                if adapter_type is OpenAIChatCompletionsAdapter:
                    self.assertEqual(
                        _body(transport, 0)["stream_options"],
                        {"include_usage": True},
                    )
                    self.assertNotIn("stream_options", _body(transport, 1))
                self.assertNotEqual(
                    streamed_result.provenance.parameters_sha256,
                    plain_result.provenance.parameters_sha256,
                )

    def test_stream_protocol_failure_never_retries_as_non_stream(self) -> None:
        chat = {
            "model": _OPENAI_MODEL,
            "usage": {"prompt_tokens": 4, "completion_tokens": 1},
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": '{"ok":true}'},
                }
            ],
        }
        cases = (
            (OpenAIResponsesAdapter, _OPENAI_MODEL, _fixture("openai", "success")),
            (
                OpenAIChatCompletionsAdapter,
                _OPENAI_MODEL,
                json.dumps(chat).encode("utf-8"),
            ),
            (
                AnthropicMessagesAdapter,
                _ANTHROPIC_MODEL,
                _fixture("anthropic", "success"),
            ),
        )
        for adapter_type, model, non_stream_response in cases:
            with self.subTest(adapter=adapter_type.__name__):
                client, transport, _, _ = _client(
                    [_response(non_stream_response), _response(non_stream_response)]
                )
                adapter = adapter_type(http_client=client, api_key=_API_KEY)

                failure = self._failure(lambda: adapter.execute(_call(model)))

                self.assertEqual(failure.failure.code, "agent-protocol")
                self.assertEqual(len(transport.calls), 1)

    def test_chat_and_anthropic_streams_reconstruct_one_declared_tool(self) -> None:
        chat = {
            "model": _OPENAI_MODEL,
            "usage": {"prompt_tokens": 12, "completion_tokens": 3},
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "type": "function",
                                "function": {"name": "click", "arguments": "{}"},
                            }
                        ],
                    },
                }
            ],
        }
        anthropic = {
            "type": "message",
            "role": "assistant",
            "model": _ANTHROPIC_MODEL,
            "usage": {"input_tokens": 12, "output_tokens": 3},
            "stop_reason": "tool_use",
            "content": [{"type": "tool_use", "name": "click", "input": {}}],
        }
        for adapter_type, model, body in (
            (OpenAIChatCompletionsAdapter, _OPENAI_MODEL, _chat_stream(chat)),
            (AnthropicMessagesAdapter, _ANTHROPIC_MODEL, _anthropic_stream(anthropic)),
        ):
            with self.subTest(adapter=adapter_type.__name__):
                client, _, _, _ = _client([_response(body)])

                result = adapter_type(http_client=client, api_key=_API_KEY).execute(
                    _tool_call(model)
                )

                self.assertIsInstance(result, AgentToolCall)
                assert isinstance(result, AgentToolCall)
                self.assertEqual((result.tool_name, result.arguments), ("click", "{}"))

    def test_chat_and_anthropic_streams_require_one_terminal_sequence(self) -> None:
        chat = {
            "model": _OPENAI_MODEL,
            "usage": {"prompt_tokens": 4, "completion_tokens": 1},
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": '{"ok":true}'},
                }
            ],
        }
        chat_done = _sse_event(None, "[DONE]")
        chat_stream = _chat_stream(chat)
        anthropic = cast(dict[str, object], json.loads(_fixture("anthropic", "success")))
        message_stop = _sse_event("message_stop", {"type": "message_stop"})
        anthropic_stream = _anthropic_stream(anthropic)
        cases = (
            (OpenAIChatCompletionsAdapter, _OPENAI_MODEL, chat_stream[: -len(chat_done)]),
            (OpenAIChatCompletionsAdapter, _OPENAI_MODEL, chat_stream + chat_done),
            (
                AnthropicMessagesAdapter,
                _ANTHROPIC_MODEL,
                anthropic_stream[: -len(message_stop)],
            ),
            (
                AnthropicMessagesAdapter,
                _ANTHROPIC_MODEL,
                anthropic_stream + message_stop,
            ),
        )
        for adapter_type, model, body in cases:
            with self.subTest(adapter=adapter_type.__name__, body_size=len(body)):
                client, _, _, _ = _client([_response(body)])
                failure = self._failure(
                    lambda: adapter_type(http_client=client, api_key=_API_KEY).execute(_call(model))
                )
                self.assertEqual(failure.failure.code, "agent-protocol")

    def test_custom_loopback_chat_service_never_requires_or_sends_a_credential(self) -> None:
        response = {
            "model": _OPENAI_MODEL,
            "usage": {"prompt_tokens": 23, "completion_tokens": 1},
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": '{"ok":true}'},
                }
            ],
        }
        client, transport, _, resolver = _client([_response(_chat_stream(response))])
        resolver.resolve = lambda hostname: ("127.0.0.1",)  # type: ignore[method-assign]
        adapter = OpenAIChatCompletionsAdapter(
            http_client=client,
            api_key=None,
            base_url="http://127.0.0.1:1234/v1",
            provider_name="local-llm",
        )

        result = adapter.execute(_call(_OPENAI_MODEL))

        self.assertIsInstance(result, AgentStructuredResult)
        assert isinstance(result, AgentStructuredResult)
        self.assertEqual(result.result, '{"ok":true}')
        request = _safe_request(transport)
        self.assertEqual(request.url, "http://127.0.0.1:1234/v1/chat/completions")
        headers = cast(tuple[tuple[str, str], ...], transport.calls[0]["headers"])
        self.assertFalse(any(name.casefold() == "authorization" for name, _ in headers))

    def test_custom_loopback_anthropic_service_never_requires_or_sends_a_credential(
        self,
    ) -> None:
        response = {
            "type": "message",
            "role": "assistant",
            "model": _ANTHROPIC_MODEL,
            "usage": {"input_tokens": 23, "output_tokens": 1},
            "stop_reason": "end_turn",
            "content": [{"type": "text", "text": '{"ok":true}'}],
        }
        client, transport, _, resolver = _client([_response(_anthropic_stream(response))])
        resolver.resolve = lambda hostname: ("127.0.0.1",)  # type: ignore[method-assign]
        adapter = AnthropicMessagesAdapter(
            http_client=client,
            api_key=None,
            base_url="http://127.0.0.1:1234/v1",
            provider_name="local-anthropic",
        )

        result = adapter.execute(_call(_ANTHROPIC_MODEL))

        self.assertIsInstance(result, AgentStructuredResult)
        assert isinstance(result, AgentStructuredResult)
        self.assertEqual(result.result, '{"ok":true}')
        request = _safe_request(transport)
        self.assertEqual(request.url, "http://127.0.0.1:1234/v1/messages")
        headers = cast(tuple[tuple[str, str], ...], transport.calls[0]["headers"])
        self.assertFalse(any(name.casefold() == "x-api-key" for name, _ in headers))

    def test_context_window_fails_before_transport_with_a_stable_error(self) -> None:
        client, transport, _, _ = _client([])
        adapter = OpenAIResponsesAdapter(
            http_client=client,
            api_key=_API_KEY,
            limits=AgentCallLimits(context_window_tokens=64, max_output_tokens=64),
        )

        failure = self._failure(lambda: adapter.execute(_call(_OPENAI_MODEL)))

        self.assertEqual(failure.failure.code, "agent-context-budget")
        self.assertEqual(transport.calls, [])

    def test_custom_remote_endpoint_is_exact_and_credential_bound_to_its_origin(self) -> None:
        client, transport, _, _ = _client([_response(_openai_fixture("success"))])
        adapter = OpenAIResponsesAdapter(
            http_client=client,
            api_key=_API_KEY,
            base_url="https://llm.example.invalid:8443/v1",
            provider_name="operator-service",
        )

        adapter.execute(_call(_OPENAI_MODEL))

        request = _safe_request(transport)
        self.assertEqual(request.url, "https://llm.example.invalid:8443/v1/responses")
        self.assertEqual(_destination(transport).origin.text, "https://llm.example.invalid:8443")

    def test_real_metadata_stage_schema_is_embedded_in_both_provider_request_shapes(
        self,
    ) -> None:
        openai_call = _real_metadata_stage_call(_OPENAI_MODEL)
        openai_client, openai_transport, _, _ = _client([_response(_openai_fixture("success"))])
        OpenAIResponsesAdapter(
            http_client=openai_client,
            api_key=_API_KEY,
        ).execute(openai_call)
        openai_format = cast(
            dict[str, object],
            cast(dict[str, object], _body(openai_transport)["text"])["format"],
        )

        anthropic_call = _real_metadata_stage_call(_ANTHROPIC_MODEL)
        anthropic_client, anthropic_transport, _, _ = _client(
            [_response(_anthropic_fixture("success"))]
        )
        AnthropicMessagesAdapter(
            http_client=anthropic_client,
            api_key=_API_KEY,
        ).execute(anthropic_call)
        anthropic_format = cast(
            dict[str, object],
            cast(
                dict[str, object],
                _body(anthropic_transport)["output_config"],
            )["format"],
        )

        openai_schema = openai_call.response_schema
        anthropic_schema = anthropic_call.response_schema
        self.assertIsNotNone(openai_schema)
        self.assertIsNotNone(anthropic_schema)
        assert openai_schema is not None
        assert anthropic_schema is not None
        expected = json.loads(openai_schema)
        self.assertEqual(expected, json.loads(anthropic_schema))
        self.assertEqual(expected.get("type"), "object")
        self.assertNotIn("oneOf", expected)
        self.assertNotIn("$schema", expected)
        self.assertTrue(openai_format["strict"])
        self.assertEqual(openai_format["type"], "json_schema")
        self.assertEqual(openai_format["schema"], expected)
        self.assertEqual(anthropic_format["type"], "json_schema")
        self.assertEqual(anthropic_format["schema"], expected)

    def test_provenance_hash_is_stable_and_binds_every_effective_parameter(self) -> None:
        client, _, _, _ = _client([_response(_openai_fixture("success")) for _ in range(7)])
        adapter = OpenAIResponsesAdapter(http_client=client, api_key=_API_KEY)
        calls = (
            _call(_OPENAI_MODEL),
            _call(_OPENAI_MODEL),
            _call(_OPENAI_MODEL, structured_input='{"document":"different"}'),
            _call(_OPENAI_MODEL, prompt="changed second private prompt"),
            _call(_OPENAI_MODEL, response_schema='{"type":"object","additionalProperties":false}'),
            _call(_OPENAI_MODEL, max_output_tokens=65),
            _call(_OPENAI_MODEL, max_output_tokens=66),
        )

        hashes = [str(adapter.execute(value).provenance.parameters_sha256) for value in calls]

        self.assertEqual(hashes[0], hashes[1])
        self.assertEqual(len(set(hashes[0:1] + hashes[2:])), 6)

    def test_effective_schema_canonicalization_drives_body_and_parameters_hash(self) -> None:
        equivalent_schema = (
            '{ "required" : [ "outcome" ], "additionalProperties" : true, '
            '"properties" : { "outcome" : { "type" : "string" } }, '
            '"type" : "object" }'
        )
        changed_schema = (
            '{"type":"object","properties":{"outcome":{"type":"string"}},'
            '"required":["outcome"],"additionalProperties":false}'
        )
        client, transport, _, _ = _client([_response(_openai_fixture("success")) for _ in range(3)])
        adapter = OpenAIResponsesAdapter(http_client=client, api_key=_API_KEY)

        original = adapter.execute(_call(_OPENAI_MODEL, response_schema=_SCHEMA))
        equivalent = adapter.execute(_call(_OPENAI_MODEL, response_schema=equivalent_schema))
        changed = adapter.execute(_call(_OPENAI_MODEL, response_schema=changed_schema))

        self.assertNotEqual(_SCHEMA, equivalent_schema)
        self.assertEqual(_safe_request(transport, 0).body, _safe_request(transport, 1).body)
        self.assertEqual(
            original.provenance.parameters_sha256,
            equivalent.provenance.parameters_sha256,
        )
        self.assertNotEqual(_safe_request(transport, 0).body, _safe_request(transport, 2).body)
        self.assertNotEqual(
            original.provenance.parameters_sha256,
            changed.provenance.parameters_sha256,
        )

    def test_call_rejects_hash_mismatch_and_non_strict_json_without_leaking_input(self) -> None:
        request = AnalysisRequest(
            kind=AnalysisRequestKind.METADATA,
            input_sha256=sha256_digest(b"different"),
            max_output_tokens=64,
        )
        cases = (
            ("hash", _INPUT, _SCHEMA),
            ("duplicate", '{"x":1,"x":2}', _SCHEMA),
            ("constant", '{"x":NaN}', _SCHEMA),
            ("array", "[]", _SCHEMA),
            ("schema-duplicate", _INPUT, '{"type":"object","type":"array"}'),
        )
        for name, structured_input, response_schema in cases:
            with self.subTest(name=name):
                with self.assertRaises(ValueError) as caught:
                    AnalysisCall(
                        request=request,
                        prompt_version="fixture-prompt-v1",
                        prompt=_PROMPT,
                        structured_input=structured_input,
                        response_schema=response_schema,
                    )
                rendered = repr(caught.exception)
                self.assertNotIn(_PROMPT, rendered)
                self.assertNotIn("INPUT-PRIVATE-SENTINEL", rendered)

    def test_deep_call_input_and_schema_are_stably_rejected_without_leaking(self) -> None:
        deep_json = _deep_json_object()
        cases: tuple[tuple[str, Callable[[], AgentProviderCall]], ...] = (
            ("input", lambda: _call(_OPENAI_MODEL, structured_input=deep_json)),
            ("schema", lambda: _call(_OPENAI_MODEL, response_schema=deep_json)),
        )
        for name, operation in cases:
            with self.subTest(name=name):
                with self.assertRaises(ValueError) as caught:
                    operation()
                self.assertNotIsInstance(caught.exception, RecursionError)
                self.assertNotIn(_DEEP_SENTINEL, repr(caught.exception))

    def test_deep_provider_envelope_is_a_stable_protocol_failure(self) -> None:
        client, _, _, _ = _client(
            [_response(_sse_event("response.completed", _deep_json_object()))]
        )
        adapter = OpenAIResponsesAdapter(http_client=client, api_key=_API_KEY)

        failure = self._failure(lambda: adapter.execute(_call(_OPENAI_MODEL)))

        self.assertEqual(failure.failure.code, "agent-protocol")
        self.assertNotIn(_DEEP_SENTINEL, repr(failure))

    def test_deep_provider_result_is_a_stable_structured_response_failure(self) -> None:
        envelope = json.loads(_fixture("openai", "success"))
        envelope["output"][0]["content"][0]["text"] = _deep_json_object()
        client, _, _, _ = _client([_response(_responses_stream(envelope))])
        adapter = OpenAIResponsesAdapter(http_client=client, api_key=_API_KEY)

        failure = self._failure(lambda: adapter.execute(_call(_OPENAI_MODEL)))

        self.assertEqual(failure.failure.code, "agent-structured-response")
        self.assertNotIn(_DEEP_SENTINEL, repr(failure))

    def test_private_canonical_encoder_never_exposes_recursion_error_or_value(self) -> None:
        with self.assertRaises(ValueError) as caught:
            canonical_json_bytes(_deep_python_object())

        self.assertNotIsInstance(caught.exception, RecursionError)
        self.assertNotIn(_DEEP_SENTINEL, repr(caught.exception))

    def test_request_and_field_budgets_fail_before_transport(self) -> None:
        cases = (
            (
                "agent-input-budget",
                AgentCallLimits(max_prompt_bytes=4),
                _call(_OPENAI_MODEL),
            ),
            (
                "agent-input-budget",
                AgentCallLimits(max_input_bytes=4),
                _call(_OPENAI_MODEL),
            ),
            (
                "agent-input-budget",
                AgentCallLimits(max_schema_bytes=4),
                _call(_OPENAI_MODEL),
            ),
            (
                "agent-request-budget",
                AgentCallLimits(max_request_bytes=128),
                _call(_OPENAI_MODEL),
            ),
            (
                "agent-output-budget",
                AgentCallLimits(max_output_tokens=63),
                _call(_OPENAI_MODEL),
            ),
        )
        for code, limits, call in cases:
            with self.subTest(code=code):
                client, transport, _, _ = _client([])
                adapter = OpenAIResponsesAdapter(
                    http_client=client,
                    api_key=_API_KEY,
                    limits=limits,
                )
                failure = self._failure(lambda: adapter.execute(call))
                self.assertEqual(failure.failure.code, code)
                self.assertEqual(transport.calls, [])

    def test_response_and_result_budgets_are_independent(self) -> None:
        client, transport, _, _ = _client([_response(_openai_fixture("success"))])
        response_limited = OpenAIResponsesAdapter(
            http_client=client,
            api_key=_API_KEY,
            limits=AgentCallLimits(max_response_bytes=32),
        )
        failure = self._failure(lambda: response_limited.execute(_call(_OPENAI_MODEL)))
        self.assertEqual(failure.failure.code, "agent-response-budget")
        self.assertEqual(len(transport.calls), 1)

        result_text = '{"value":"' + ("x" * 128) + '"}'
        envelope = json.loads(_fixture("openai", "success"))
        envelope["output"][0]["content"][0]["text"] = result_text
        client, _, _, _ = _client([_response(_responses_stream(envelope))])
        result_limited = OpenAIResponsesAdapter(
            http_client=client,
            api_key=_API_KEY,
            limits=AgentCallLimits(max_result_bytes=32),
        )
        failure = self._failure(lambda: result_limited.execute(_call(_OPENAI_MODEL)))
        self.assertEqual(failure.failure.code, "agent-result-budget")

    def test_http_statuses_are_stable_and_429_feedback_is_atomic(self) -> None:
        matrix = {
            400: "agent-request-rejected",
            401: "agent-authentication",
            403: "agent-authorization",
            404: "agent-not-found",
            405: "agent-endpoint",
            408: "agent-timeout",
            422: "agent-request-rejected",
            429: "agent-quota",
            500: "agent-remote-service",
        }
        for status, code in matrix.items():
            with self.subTest(status=status):
                headers = (Header(name="Retry-After", value="5"),) if status == 429 else ()
                client, transport, coordinator, _ = _client(
                    [_response(b"RESPONSE-PRIVATE-SENTINEL", status=status, headers=headers)]
                )
                adapter = OpenAIResponsesAdapter(http_client=client, api_key=_API_KEY)
                failure = self._failure(lambda: adapter.execute(_call(_OPENAI_MODEL)))
                self.assertEqual(failure.failure.code, code)
                self.assertEqual(failure.http_status, status)
                self.assertIsNone(failure.access_code)
                self.assertEqual(len(transport.calls), 1)
                self.assertNotIn("RESPONSE-PRIVATE-SENTINEL", repr(failure))
                if status == 429:
                    self.assertEqual(len(coordinator.feedback), 1)
                    scope, feedback = coordinator.feedback[0]
                    self.assertEqual(scope, OPENAI_ACCESS_SCOPE)
                    self.assertEqual(feedback.retry_after, 5.0)
                    self.assertTrue(feedback.throttled)
                else:
                    self.assertEqual(coordinator.feedback, [])

    def test_known_remote_error_fields_classify_model_and_capability_without_body_leak(
        self,
    ) -> None:
        cases = (
            (404, {"code": "model_not_found", "param": "model"}, "model-not-found"),
            (
                400,
                {"type": "invalid_request_error", "param": "reasoning.effort"},
                "reasoning-unsupported",
            ),
            (
                422,
                {"code": "unsupported_response_format", "param": "response_format"},
                "structured-output-unsupported",
            ),
        )
        for status, fields, expected in cases:
            with self.subTest(status=status, expected=expected):
                body = json.dumps(
                    {
                        "error": {
                            **fields,
                            "message": "RESPONSE-PRIVATE-SENTINEL",
                        }
                    }
                ).encode("utf-8")
                client, _transport, _coordinator, _resolver = _client(
                    [_response(body, status=status)]
                )
                adapter = OpenAIResponsesAdapter(http_client=client, api_key=_API_KEY)

                failure = self._failure(lambda: adapter.execute(_call(_OPENAI_MODEL)))

                self.assertEqual(failure.remote_error, expected)
                self.assertEqual(failure.http_status, status)
                self.assertNotIn("RESPONSE-PRIVATE-SENTINEL", repr(failure))

    def test_redirects_and_post_transport_errors_never_retry(self) -> None:
        redirect = _response(
            b"redirect body",
            status=307,
            headers=(Header(name="Location", value="https://example.org/elsewhere"),),
        )
        client, transport, _, _ = _client([redirect, _response(_openai_fixture("success"))])
        adapter = OpenAIResponsesAdapter(http_client=client, api_key=_API_KEY)
        failure = self._failure(lambda: adapter.execute(_call(_OPENAI_MODEL)))
        self.assertEqual(failure.failure.code, "agent-access")
        self.assertEqual(len(transport.calls), 1)

        client, transport, _, _ = _client(
            [OSError("TRANSPORT-PRIVATE-SENTINEL"), _response(_openai_fixture("success"))]
        )
        adapter = OpenAIResponsesAdapter(http_client=client, api_key=_API_KEY)
        failure = self._failure(lambda: adapter.execute(_call(_OPENAI_MODEL)))
        self.assertEqual(failure.failure.code, "agent-access")
        self.assertEqual(len(transport.calls), 1)
        self.assertNotIn("TRANSPORT-PRIVATE-SENTINEL", repr(failure))

    def test_openai_refusal_truncation_unknown_shape_and_model_mismatch_are_distinct(self) -> None:
        mismatch = json.loads(_fixture("openai", "success"))
        mismatch["model"] = "unexpected-model"
        cases = (
            ("refusal", _openai_fixture("refusal"), "agent-refusal"),
            ("truncated", _openai_fixture("truncated"), "agent-truncated"),
            ("unknown", _openai_fixture("unknown-shape"), "agent-protocol"),
            (
                "mismatch",
                _responses_stream(mismatch),
                "agent-model-mismatch",
            ),
        )
        for name, body, code in cases:
            with self.subTest(name=name):
                client, _, _, _ = _client([_response(body)])
                adapter = OpenAIResponsesAdapter(http_client=client, api_key=_API_KEY)
                failure = self._failure(lambda: adapter.execute(_call(_OPENAI_MODEL)))
                self.assertEqual(failure.failure.code, code)
                self.assertNotIn("fixture refusal text", repr(failure))

    def test_chat_stream_refusal_truncation_and_model_mismatch_are_distinct(self) -> None:
        def envelope(
            *,
            model: str = _OPENAI_MODEL,
            finish_reason: str = "stop",
            content: str | None = '{"outcome":"usable"}',
            refusal: str | None = None,
        ) -> dict[str, object]:
            message: dict[str, object] = {
                "role": "assistant",
                "content": content,
            }
            if refusal is not None:
                message["refusal"] = refusal
            return {
                "model": model,
                "usage": {"prompt_tokens": 4, "completion_tokens": 1},
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": finish_reason,
                        "message": message,
                    }
                ],
            }

        cases = (
            (
                "refusal",
                envelope(content=None, refusal="fixture refusal text"),
                "agent-refusal",
            ),
            ("truncated", envelope(finish_reason="length"), "agent-truncated"),
            (
                "mismatch",
                envelope(model="unexpected-model"),
                "agent-model-mismatch",
            ),
        )
        for name, payload, code in cases:
            with self.subTest(name=name):
                client, _, _, _ = _client([_response(_chat_stream(payload))])
                adapter = OpenAIChatCompletionsAdapter(
                    http_client=client,
                    api_key=_API_KEY,
                )

                failure = self._failure(lambda: adapter.execute(_call(_OPENAI_MODEL)))

                self.assertEqual(failure.failure.code, code)
                self.assertNotIn("fixture refusal text", repr(failure))

    def test_openai_requires_the_exact_responses_envelope_identity(self) -> None:
        for object_value in (None, "chat.completion"):
            with self.subTest(object_value=object_value):
                envelope = json.loads(_fixture("openai", "success"))
                if object_value is None:
                    del envelope["object"]
                else:
                    envelope["object"] = object_value
                client, _, _, _ = _client([_response(_responses_stream(envelope))])
                adapter = OpenAIResponsesAdapter(http_client=client, api_key=_API_KEY)

                failure = self._failure(lambda: adapter.execute(_call(_OPENAI_MODEL)))

                self.assertEqual(failure.failure.code, "agent-protocol")

    def test_openai_stream_reconstructs_text_done_and_rejects_ambiguous_framing(self) -> None:
        terminal = cast(dict[str, object], json.loads(_fixture("openai", "success")))
        terminal["output"] = []
        lifecycle = b"".join(
            (
                _sse_event(
                    "response.created",
                    {
                        "type": "response.created",
                        "response": {
                            "object": "response",
                            "status": "in_progress",
                            "model": _OPENAI_MODEL,
                            "output": [],
                        },
                    },
                ),
                _sse_event(
                    "response.in_progress",
                    {
                        "type": "response.in_progress",
                        "response": {
                            "object": "response",
                            "status": "in_progress",
                            "model": _OPENAI_MODEL,
                            "output": [],
                        },
                    },
                ),
                _sse_event(
                    "response.output_item.added",
                    {
                        "type": "response.output_item.added",
                        "output_index": 0,
                        "item": {
                            "type": "message",
                            "status": "in_progress",
                            "role": "assistant",
                            "content": [],
                        },
                    },
                ),
                _sse_event(
                    "response.output_text.delta",
                    {
                        "type": "response.output_text.delta",
                        "output_index": 0,
                        "content_index": 0,
                        "delta": '{"outcome":"usable",',
                    },
                ),
            )
        )
        text_done = _sse_event(
            "response.output_text.done",
            {
                "type": "response.output_text.done",
                "output_index": 0,
                "content_index": 0,
                "text": '{"outcome":"usable","title":"Fixture"}',
            },
        )
        completed = _sse_event(
            "response.completed",
            {"type": "response.completed", "response": terminal},
        )
        client, _, _, _ = _client(
            [_response(lifecycle + text_done + completed + _sse_event(None, "[DONE]"))]
        )
        result = OpenAIResponsesAdapter(http_client=client, api_key=_API_KEY).execute(
            _call(_OPENAI_MODEL)
        )
        self.assertIsInstance(result, AgentStructuredResult)

        malformed = (
            text_done,
            completed + completed,
            _sse_event(
                "response.completed",
                {"type": "response.output_text.done", "response": terminal},
            ),
        )
        for body in malformed:
            with self.subTest(body_size=len(body)):
                client, _, _, _ = _client([_response(body)])
                adapter = OpenAIResponsesAdapter(http_client=client, api_key=_API_KEY)
                failure = self._failure(lambda: adapter.execute(_call(_OPENAI_MODEL)))
                self.assertEqual(failure.failure.code, "agent-protocol")

    def test_anthropic_refusal_truncation_unknown_shape_and_model_mismatch_are_distinct(
        self,
    ) -> None:
        mismatch = json.loads(_fixture("anthropic", "success"))
        mismatch["model"] = "unexpected-model"
        cases = (
            ("refusal", _anthropic_fixture("refusal"), "agent-refusal", True),
            ("truncated", _anthropic_fixture("truncated"), "agent-truncated", True),
            ("unknown", _fixture("anthropic", "unknown-shape"), "agent-protocol", False),
            (
                "mismatch",
                _anthropic_stream(mismatch),
                "agent-model-mismatch",
                True,
            ),
        )
        for name, body, code, stream in cases:
            with self.subTest(name=name):
                client, _, _, _ = _client([_response(body)])
                adapter = AnthropicMessagesAdapter(http_client=client, api_key=_API_KEY)
                failure = self._failure(
                    lambda: adapter.execute(_call(_ANTHROPIC_MODEL, stream=stream))
                )
                self.assertEqual(failure.failure.code, code)
                self.assertNotIn("fixture refusal text", repr(failure))

    def test_malformed_envelope_and_result_json_never_cross_the_boundary(self) -> None:
        invalid_result = json.loads(_fixture("openai", "success"))
        invalid_result["output"][0]["content"][0]["text"] = '{"x":1,"x":2}'
        invalid_unicode_result = json.loads(_fixture("openai", "success"))
        invalid_unicode_result["output"][0]["content"][0]["text"] = '{"x":"\\ud800"}'
        cases = (
            ("non-utf8", b"\xff", "agent-protocol"),
            (
                "duplicate-envelope",
                _sse_event(
                    "response.completed",
                    '{"type":"response.completed","response":'
                    '{"object":"response","status":"completed","status":"failed"}}',
                ),
                "agent-protocol",
            ),
            (
                "duplicate-result",
                _responses_stream(invalid_result),
                "agent-structured-response",
            ),
            (
                "non-unicode-result",
                _responses_stream(invalid_unicode_result),
                "agent-structured-response",
            ),
        )
        for name, body, code in cases:
            with self.subTest(name=name):
                client, _, _, _ = _client([_response(body)])
                adapter = OpenAIResponsesAdapter(http_client=client, api_key=_API_KEY)
                failure = self._failure(lambda: adapter.execute(_call(_OPENAI_MODEL)))
                self.assertEqual(failure.failure.code, code)

    def test_adapter_validates_only_json_object_syntax_not_analysis_business_fields(self) -> None:
        envelope = json.loads(_fixture("anthropic", "success"))
        raw_result = '{"future_business_shape":{"kept":"opaque"}}'
        envelope["content"][0]["text"] = raw_result
        client, _, _, _ = _client([_response(_anthropic_stream(envelope))])
        adapter = AnthropicMessagesAdapter(http_client=client, api_key=_API_KEY)

        result = adapter.execute(_call(_ANTHROPIC_MODEL))

        self.assertIsInstance(result, AgentStructuredResult)
        assert isinstance(result, AgentStructuredResult)
        self.assertEqual(result.result, raw_result)
        self.assertEqual(result.provenance.input_sha256, _call(_ANTHROPIC_MODEL).input_sha256)

    def test_repr_and_failures_do_not_expose_credentials_prompts_inputs_or_responses(self) -> None:
        call = _call(_OPENAI_MODEL)
        client, _, _, _ = _client([_response(b'{"private":"RESPONSE-PRIVATE-SENTINEL"}')])
        adapter = OpenAIResponsesAdapter(http_client=client, api_key=_API_KEY)
        failure = self._failure(lambda: adapter.execute(call))
        rendered = "\n".join((repr(adapter), repr(call), str(failure), repr(failure)))
        for sentinel in (
            _API_KEY,
            _PROMPT,
            "INPUT-PRIVATE-SENTINEL",
            "RESPONSE-PRIVATE-SENTINEL",
            "api.openai.com",
            "Authorization",
        ):
            self.assertNotIn(sentinel, rendered)

        client, _, _, _ = _client([])
        failure = self._failure(lambda: OpenAIResponsesAdapter(http_client=client, api_key="   "))
        self.assertEqual(failure.failure.code, "agent-credentials")

    def test_adapters_have_no_sdk_or_direct_network_import(self) -> None:
        provider_root = Path(__file__).parents[1] / "src" / "sciretriever" / "agents" / "providers"
        forbidden = {"anthropic", "httpx", "openai", "requests", "socket", "urllib"}
        for path in (
            provider_root / "openai_responses.py",
            provider_root / "openai_chat.py",
            provider_root / "anthropic.py",
        ):
            with self.subTest(path=path.name):
                tree = ast.parse(path.read_text(encoding="utf-8"))
                imported: set[str] = set()
                for node in ast.walk(tree):
                    if isinstance(node, ast.Import):
                        imported.update(alias.name.split(".", 1)[0] for alias in node.names)
                    elif isinstance(node, ast.ImportFrom) and node.module is not None:
                        imported.add(node.module.split(".", 1)[0])
                self.assertEqual(imported & forbidden, set())

    def test_provider_scopes_are_exact_and_not_caller_selected(self) -> None:
        self.assertEqual(
            OPENAI_ACCESS_SCOPE,
            AccessScope(provider_name="openai", channel="api", service_name="responses"),
        )
        self.assertEqual(
            ANTHROPIC_ACCESS_SCOPE,
            AccessScope(provider_name="anthropic", channel="api", service_name="messages"),
        )


if __name__ == "__main__":
    unittest.main()
