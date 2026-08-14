from __future__ import annotations

import ast
import json
import threading
import unittest
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from sciretriever.analysis.metadata import MetadataAnalysisStage, MetadataStageInput
from sciretriever.analysis.metadata_rules import metadata_input_sha256
from sciretriever.analysis.ports import (
    AnalysisLLMCall,
    AnalysisLLMFailure,
    AnalysisLLMPort,
    LLMProviderLimits,
    canonical_json_bytes,
)
from sciretriever.analysis.providers import (
    ANTHROPIC_ACCESS_SCOPE,
    OPENAI_ACCESS_SCOPE,
)
from sciretriever.analysis.providers.anthropic import AnthropicAnalysisLLMAdapter
from sciretriever.analysis.providers.openai import OpenAIAnalysisLLMAdapter
from sciretriever.analysis.providers.openai_chat import (
    OpenAIChatCompletionsAnalysisLLMAdapter,
)
from sciretriever.model.access import Header, TransportRequest
from sciretriever.model.llm import (
    LLMProvenance,
    LLMRequest,
    LLMRequestKind,
    LLMStructuredResponse,
)
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
        self.calls: list[AnalysisLLMCall] = []

    @property
    def provider_name(self) -> str:
        return "metadata-schema-capture"

    def complete(self, call: AnalysisLLMCall) -> LLMStructuredResponse:
        self.calls.append(call)
        schema = json.loads(call.response_schema)
        result = (
            '{"outcome":"no_usable_content"}'
            if "oneOf" in schema
            else '{"metadata":null,"outcome":"no_usable_content"}'
        )
        return LLMStructuredResponse(
            result=result,
            provenance=LLMProvenance(
                provider=self.provider_name,
                model=call.request.model,
                input_sha256=call.request.input_sha256,
                parameters_sha256=sha256_digest(b"metadata schema capture"),
            ),
        )


def _fixture(provider: str, name: str) -> bytes:
    return (_FIXTURES / provider / f"{name}.json").read_bytes()


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
    kind: LLMRequestKind = LLMRequestKind.METADATA,
    prompt_version: str = "fixture-prompt-v1",
    prompt: str = _PROMPT,
    structured_input: str = _INPUT,
    response_schema: str = _SCHEMA,
    max_output_tokens: int = 64,
    cancel_event: threading.Event | None = None,
) -> AnalysisLLMCall:
    return AnalysisLLMCall(
        request=LLMRequest(
            kind=kind,
            input_sha256=sha256_digest(structured_input.encode("utf-8")),
            model=model,
            max_output_tokens=max_output_tokens,
        ),
        prompt_version=prompt_version,
        prompt=prompt,
        structured_input=structured_input,
        response_schema=response_schema,
        cancel_event=cancel_event,
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


def _real_metadata_stage_call(model: str) -> AnalysisLLMCall:
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
        llm=cast(AnalysisLLMPort, capture),
        model=model,
        max_output_tokens=64,
    )

    stage.analyze(stage_input)

    if len(capture.calls) != 1:
        raise AssertionError("metadata stage did not build exactly one call")
    return capture.calls[0]


class AnalysisLlmProviderTests(unittest.TestCase):
    def _failure(self, operation: object) -> AnalysisLLMFailure:
        if not callable(operation):
            raise TypeError("operation must be callable")
        with self.assertRaises(AnalysisLLMFailure) as caught:
            operation()
        return caught.exception

    def test_neutral_port_preserves_all_three_request_meanings_and_order(self) -> None:
        client, transport, _, _ = _client(
            [_response(_fixture("openai", "success")) for _ in range(3)]
        )
        adapter = OpenAIAnalysisLLMAdapter(http_client=client, api_key=_API_KEY)

        self.assertIsInstance(adapter, AnalysisLLMPort)
        results = [
            adapter.complete(_call(_OPENAI_MODEL, kind=kind))
            for kind in (
                LLMRequestKind.METADATA,
                LLMRequestKind.CONTENT,
                LLMRequestKind.REFERENCE_LOOKUP,
            )
        ]

        self.assertTrue(all(isinstance(value, LLMStructuredResponse) for value in results))
        self.assertEqual(len(transport.calls), 3)
        self.assertEqual(
            len({str(value.provenance.parameters_sha256) for value in results}),
            3,
        )
        self.assertEqual(
            [value.result for value in results],
            ['{"outcome":"usable","title":"Fixture"}'] * 3,
        )

    def test_openai_uses_responses_protocol_and_private_origin_bound_credential(self) -> None:
        client, transport, _, resolver = _client([_response(_fixture("openai", "success"))])
        adapter = OpenAIAnalysisLLMAdapter(http_client=client, api_key=_API_KEY)

        result = adapter.complete(_call(_OPENAI_MODEL))

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
        input_items = cast(list[dict[str, object]], body["input"])
        self.assertEqual([item["role"] for item in input_items], ["developer", "user"])
        developer_content = cast(list[dict[str, object]], input_items[0]["content"])
        user_content = cast(list[dict[str, object]], input_items[1]["content"])
        self.assertEqual(developer_content[0]["text"], _PROMPT)
        self.assertEqual(user_content[0]["text"], _INPUT)
        self.assertEqual(result.provenance.provider, "openai")
        self.assertEqual(result.provenance.model, _OPENAI_MODEL)

    def test_anthropic_uses_messages_protocol_and_private_origin_bound_credential(self) -> None:
        client, transport, _, resolver = _client([_response(_fixture("anthropic", "success"))])
        adapter = AnthropicAnalysisLLMAdapter(http_client=client, api_key=_API_KEY)

        result = adapter.complete(_call(_ANTHROPIC_MODEL))

        request = _safe_request(transport)
        body = _body(transport)
        self.assertIsInstance(adapter, AnalysisLLMPort)
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
        messages = cast(list[dict[str, object]], body["messages"])
        self.assertEqual(messages[0]["role"], "user")
        self.assertEqual(messages[0]["content"], _INPUT)
        self.assertEqual(result.provenance.provider, "anthropic")
        self.assertEqual(result.provenance.model, _ANTHROPIC_MODEL)

    def test_chat_completions_uses_strict_schema_and_parses_one_assistant_choice(self) -> None:
        response = {
            "id": "chatcmpl-fixture",
            "object": "chat.completion",
            "model": _OPENAI_MODEL,
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
        client, transport, _, _ = _client([_response(json.dumps(response).encode("utf-8"))])
        adapter = OpenAIChatCompletionsAnalysisLLMAdapter(
            http_client=client,
            api_key=_API_KEY,
        )

        result = adapter.complete(_call(_OPENAI_MODEL))

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
        self.assertEqual(result.provenance.provider, "openai")

    def test_custom_loopback_chat_service_never_requires_or_sends_a_credential(self) -> None:
        response = {
            "model": _OPENAI_MODEL,
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": '{"ok":true}'},
                }
            ],
        }
        client, transport, _, resolver = _client([_response(json.dumps(response).encode("utf-8"))])
        resolver.resolve = lambda hostname: ("127.0.0.1",)  # type: ignore[method-assign]
        adapter = OpenAIChatCompletionsAnalysisLLMAdapter(
            http_client=client,
            api_key=None,
            base_url="http://127.0.0.1:1234/v1",
            provider_name="local-llm",
        )

        result = adapter.complete(_call(_OPENAI_MODEL))

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
            "stop_reason": "end_turn",
            "content": [{"type": "text", "text": '{"ok":true}'}],
        }
        client, transport, _, resolver = _client([_response(json.dumps(response).encode("utf-8"))])
        resolver.resolve = lambda hostname: ("127.0.0.1",)  # type: ignore[method-assign]
        adapter = AnthropicAnalysisLLMAdapter(
            http_client=client,
            api_key=None,
            base_url="http://127.0.0.1:1234/v1",
            provider_name="local-anthropic",
        )

        result = adapter.complete(_call(_ANTHROPIC_MODEL))

        self.assertEqual(result.result, '{"ok":true}')
        request = _safe_request(transport)
        self.assertEqual(request.url, "http://127.0.0.1:1234/v1/messages")
        headers = cast(tuple[tuple[str, str], ...], transport.calls[0]["headers"])
        self.assertFalse(any(name.casefold() == "x-api-key" for name, _ in headers))

    def test_context_window_fails_before_transport_with_a_stable_error(self) -> None:
        client, transport, _, _ = _client([])
        adapter = OpenAIAnalysisLLMAdapter(
            http_client=client,
            api_key=_API_KEY,
            limits=LLMProviderLimits(context_window_tokens=64),
        )

        failure = self._failure(lambda: adapter.complete(_call(_OPENAI_MODEL)))

        self.assertEqual(failure.failure.code, "analysis-llm-context-budget")
        self.assertEqual(transport.calls, [])

    def test_custom_remote_endpoint_is_exact_and_credential_bound_to_its_origin(self) -> None:
        client, transport, _, _ = _client([_response(_fixture("openai", "success"))])
        adapter = OpenAIAnalysisLLMAdapter(
            http_client=client,
            api_key=_API_KEY,
            base_url="https://llm.example.invalid:8443/v1",
            provider_name="operator-service",
        )

        adapter.complete(_call(_OPENAI_MODEL))

        request = _safe_request(transport)
        self.assertEqual(request.url, "https://llm.example.invalid:8443/v1/responses")
        self.assertEqual(_destination(transport).origin.text, "https://llm.example.invalid:8443")

    def test_real_metadata_stage_schema_is_embedded_in_both_provider_request_shapes(
        self,
    ) -> None:
        openai_call = _real_metadata_stage_call(_OPENAI_MODEL)
        openai_client, openai_transport, _, _ = _client([_response(_fixture("openai", "success"))])
        OpenAIAnalysisLLMAdapter(
            http_client=openai_client,
            api_key=_API_KEY,
        ).complete(openai_call)
        openai_format = cast(
            dict[str, object],
            cast(dict[str, object], _body(openai_transport)["text"])["format"],
        )

        anthropic_call = _real_metadata_stage_call(_ANTHROPIC_MODEL)
        anthropic_client, anthropic_transport, _, _ = _client(
            [_response(_fixture("anthropic", "success"))]
        )
        AnthropicAnalysisLLMAdapter(
            http_client=anthropic_client,
            api_key=_API_KEY,
        ).complete(anthropic_call)
        anthropic_format = cast(
            dict[str, object],
            cast(
                dict[str, object],
                _body(anthropic_transport)["output_config"],
            )["format"],
        )

        expected = json.loads(openai_call.response_schema)
        self.assertEqual(expected, json.loads(anthropic_call.response_schema))
        self.assertEqual(expected.get("type"), "object")
        self.assertNotIn("oneOf", expected)
        self.assertNotIn("$schema", expected)
        self.assertTrue(openai_format["strict"])
        self.assertEqual(openai_format["type"], "json_schema")
        self.assertEqual(openai_format["schema"], expected)
        self.assertEqual(anthropic_format["type"], "json_schema")
        self.assertEqual(anthropic_format["schema"], expected)

    def test_provenance_hash_is_stable_and_binds_every_effective_parameter(self) -> None:
        client, _, _, _ = _client([_response(_fixture("openai", "success")) for _ in range(7)])
        adapter = OpenAIAnalysisLLMAdapter(http_client=client, api_key=_API_KEY)
        calls = (
            _call(_OPENAI_MODEL),
            _call(_OPENAI_MODEL),
            _call(_OPENAI_MODEL, kind=LLMRequestKind.CONTENT),
            _call(_OPENAI_MODEL, prompt_version="fixture-prompt-v2"),
            _call(_OPENAI_MODEL, prompt="changed private prompt"),
            _call(
                _OPENAI_MODEL,
                response_schema='{"type":"object","additionalProperties":false}',
            ),
            _call(_OPENAI_MODEL, max_output_tokens=65),
        )

        hashes = [str(adapter.complete(value).provenance.parameters_sha256) for value in calls]

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
        client, transport, _, _ = _client(
            [_response(_fixture("openai", "success")) for _ in range(3)]
        )
        adapter = OpenAIAnalysisLLMAdapter(http_client=client, api_key=_API_KEY)

        original = adapter.complete(_call(_OPENAI_MODEL, response_schema=_SCHEMA))
        equivalent = adapter.complete(_call(_OPENAI_MODEL, response_schema=equivalent_schema))
        changed = adapter.complete(_call(_OPENAI_MODEL, response_schema=changed_schema))

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
        request = LLMRequest(
            kind=LLMRequestKind.METADATA,
            input_sha256=sha256_digest(b"different"),
            model=_OPENAI_MODEL,
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
                    AnalysisLLMCall(
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
        cases: tuple[tuple[str, Callable[[], AnalysisLLMCall]], ...] = (
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
        client, _, _, _ = _client([_response(_deep_json_object().encode("utf-8"))])
        adapter = OpenAIAnalysisLLMAdapter(http_client=client, api_key=_API_KEY)

        failure = self._failure(lambda: adapter.complete(_call(_OPENAI_MODEL)))

        self.assertEqual(failure.failure.code, "analysis-llm-protocol")
        self.assertNotIn(_DEEP_SENTINEL, repr(failure))

    def test_deep_provider_result_is_a_stable_structured_response_failure(self) -> None:
        envelope = json.loads(_fixture("openai", "success"))
        envelope["output"][0]["content"][0]["text"] = _deep_json_object()
        client, _, _, _ = _client([_response(json.dumps(envelope).encode("utf-8"))])
        adapter = OpenAIAnalysisLLMAdapter(http_client=client, api_key=_API_KEY)

        failure = self._failure(lambda: adapter.complete(_call(_OPENAI_MODEL)))

        self.assertEqual(failure.failure.code, "analysis-llm-structured-response")
        self.assertNotIn(_DEEP_SENTINEL, repr(failure))

    def test_private_canonical_encoder_never_exposes_recursion_error_or_value(self) -> None:
        with self.assertRaises(ValueError) as caught:
            canonical_json_bytes(_deep_python_object())

        self.assertNotIsInstance(caught.exception, RecursionError)
        self.assertNotIn(_DEEP_SENTINEL, repr(caught.exception))

    def test_request_and_field_budgets_fail_before_transport(self) -> None:
        cases = (
            (
                "analysis-llm-prompt-budget",
                LLMProviderLimits(max_prompt_bytes=4),
                _call(_OPENAI_MODEL),
            ),
            (
                "analysis-llm-input-budget",
                LLMProviderLimits(max_input_bytes=4),
                _call(_OPENAI_MODEL),
            ),
            (
                "analysis-llm-schema-budget",
                LLMProviderLimits(max_schema_bytes=4),
                _call(_OPENAI_MODEL),
            ),
            (
                "analysis-llm-request-budget",
                LLMProviderLimits(max_request_bytes=128),
                _call(_OPENAI_MODEL),
            ),
            (
                "analysis-llm-token-budget",
                LLMProviderLimits(max_output_tokens=63),
                _call(_OPENAI_MODEL),
            ),
        )
        for code, limits, call in cases:
            with self.subTest(code=code):
                client, transport, _, _ = _client([])
                adapter = OpenAIAnalysisLLMAdapter(
                    http_client=client,
                    api_key=_API_KEY,
                    limits=limits,
                )
                failure = self._failure(lambda: adapter.complete(call))
                self.assertEqual(failure.failure.code, code)
                self.assertEqual(transport.calls, [])

    def test_response_and_result_budgets_are_independent(self) -> None:
        client, transport, _, _ = _client([_response(_fixture("openai", "success"))])
        response_limited = OpenAIAnalysisLLMAdapter(
            http_client=client,
            api_key=_API_KEY,
            limits=LLMProviderLimits(max_response_bytes=32),
        )
        failure = self._failure(lambda: response_limited.complete(_call(_OPENAI_MODEL)))
        self.assertEqual(failure.failure.code, "analysis-llm-response-budget")
        self.assertEqual(len(transport.calls), 1)

        result_text = '{"value":"' + ("x" * 128) + '"}'
        envelope = json.loads(_fixture("openai", "success"))
        envelope["output"][0]["content"][0]["text"] = result_text
        client, _, _, _ = _client([_response(json.dumps(envelope).encode("utf-8"))])
        result_limited = OpenAIAnalysisLLMAdapter(
            http_client=client,
            api_key=_API_KEY,
            limits=LLMProviderLimits(max_result_bytes=32),
        )
        failure = self._failure(lambda: result_limited.complete(_call(_OPENAI_MODEL)))
        self.assertEqual(failure.failure.code, "analysis-llm-result-budget")

    def test_http_statuses_are_stable_and_429_feedback_is_atomic(self) -> None:
        matrix = {
            401: "analysis-llm-authentication",
            403: "analysis-llm-authorization",
            408: "analysis-llm-timeout",
            429: "analysis-llm-quota",
            500: "analysis-llm-http-status",
        }
        for status, code in matrix.items():
            with self.subTest(status=status):
                headers = (Header(name="Retry-After", value="5"),) if status == 429 else ()
                client, transport, coordinator, _ = _client(
                    [_response(b"RESPONSE-PRIVATE-SENTINEL", status=status, headers=headers)]
                )
                adapter = OpenAIAnalysisLLMAdapter(http_client=client, api_key=_API_KEY)
                failure = self._failure(lambda: adapter.complete(_call(_OPENAI_MODEL)))
                self.assertEqual(failure.failure.code, code)
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

    def test_redirects_and_post_transport_errors_never_retry(self) -> None:
        redirect = _response(
            b"redirect body",
            status=307,
            headers=(Header(name="Location", value="https://example.org/elsewhere"),),
        )
        client, transport, _, _ = _client([redirect, _response(_fixture("openai", "success"))])
        adapter = OpenAIAnalysisLLMAdapter(http_client=client, api_key=_API_KEY)
        failure = self._failure(lambda: adapter.complete(_call(_OPENAI_MODEL)))
        self.assertEqual(failure.failure.code, "analysis-llm-access")
        self.assertEqual(len(transport.calls), 1)

        client, transport, _, _ = _client(
            [OSError("TRANSPORT-PRIVATE-SENTINEL"), _response(_fixture("openai", "success"))]
        )
        adapter = OpenAIAnalysisLLMAdapter(http_client=client, api_key=_API_KEY)
        failure = self._failure(lambda: adapter.complete(_call(_OPENAI_MODEL)))
        self.assertEqual(failure.failure.code, "analysis-llm-access")
        self.assertEqual(len(transport.calls), 1)
        self.assertNotIn("TRANSPORT-PRIVATE-SENTINEL", repr(failure))

    def test_openai_refusal_truncation_unknown_shape_and_model_mismatch_are_distinct(self) -> None:
        mismatch = json.loads(_fixture("openai", "success"))
        mismatch["model"] = "unexpected-model"
        cases = (
            ("refusal", _fixture("openai", "refusal"), "analysis-llm-refusal"),
            ("truncated", _fixture("openai", "truncated"), "analysis-llm-truncated"),
            ("unknown", _fixture("openai", "unknown-shape"), "analysis-llm-protocol"),
            (
                "mismatch",
                json.dumps(mismatch).encode("utf-8"),
                "analysis-llm-model-mismatch",
            ),
        )
        for name, body, code in cases:
            with self.subTest(name=name):
                client, _, _, _ = _client([_response(body)])
                adapter = OpenAIAnalysisLLMAdapter(http_client=client, api_key=_API_KEY)
                failure = self._failure(lambda: adapter.complete(_call(_OPENAI_MODEL)))
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
                client, _, _, _ = _client([_response(json.dumps(envelope).encode("utf-8"))])
                adapter = OpenAIAnalysisLLMAdapter(http_client=client, api_key=_API_KEY)

                failure = self._failure(lambda: adapter.complete(_call(_OPENAI_MODEL)))

                self.assertEqual(failure.failure.code, "analysis-llm-protocol")

    def test_anthropic_refusal_truncation_unknown_shape_and_model_mismatch_are_distinct(
        self,
    ) -> None:
        mismatch = json.loads(_fixture("anthropic", "success"))
        mismatch["model"] = "unexpected-model"
        cases = (
            ("refusal", _fixture("anthropic", "refusal"), "analysis-llm-refusal"),
            ("truncated", _fixture("anthropic", "truncated"), "analysis-llm-truncated"),
            ("unknown", _fixture("anthropic", "unknown-shape"), "analysis-llm-protocol"),
            (
                "mismatch",
                json.dumps(mismatch).encode("utf-8"),
                "analysis-llm-model-mismatch",
            ),
        )
        for name, body, code in cases:
            with self.subTest(name=name):
                client, _, _, _ = _client([_response(body)])
                adapter = AnthropicAnalysisLLMAdapter(http_client=client, api_key=_API_KEY)
                failure = self._failure(lambda: adapter.complete(_call(_ANTHROPIC_MODEL)))
                self.assertEqual(failure.failure.code, code)
                self.assertNotIn("fixture refusal text", repr(failure))

    def test_malformed_envelope_and_result_json_never_cross_the_boundary(self) -> None:
        invalid_result = json.loads(_fixture("openai", "success"))
        invalid_result["output"][0]["content"][0]["text"] = '{"x":1,"x":2}'
        invalid_unicode_result = json.loads(_fixture("openai", "success"))
        invalid_unicode_result["output"][0]["content"][0]["text"] = '{"x":"\\ud800"}'
        cases = (
            ("non-utf8", b"\xff", "analysis-llm-protocol"),
            (
                "duplicate-envelope",
                b'{"status":"completed","status":"failed"}',
                "analysis-llm-protocol",
            ),
            (
                "duplicate-result",
                json.dumps(invalid_result).encode("utf-8"),
                "analysis-llm-structured-response",
            ),
            (
                "non-unicode-result",
                json.dumps(invalid_unicode_result).encode("utf-8"),
                "analysis-llm-structured-response",
            ),
        )
        for name, body, code in cases:
            with self.subTest(name=name):
                client, _, _, _ = _client([_response(body)])
                adapter = OpenAIAnalysisLLMAdapter(http_client=client, api_key=_API_KEY)
                failure = self._failure(lambda: adapter.complete(_call(_OPENAI_MODEL)))
                self.assertEqual(failure.failure.code, code)

    def test_adapter_validates_only_json_object_syntax_not_analysis_business_fields(self) -> None:
        envelope = json.loads(_fixture("anthropic", "success"))
        raw_result = '{"future_business_shape":{"kept":"opaque"}}'
        envelope["content"][0]["text"] = raw_result
        client, _, _, _ = _client([_response(json.dumps(envelope).encode("utf-8"))])
        adapter = AnthropicAnalysisLLMAdapter(http_client=client, api_key=_API_KEY)

        result = adapter.complete(_call(_ANTHROPIC_MODEL, kind=LLMRequestKind.REFERENCE_LOOKUP))

        self.assertEqual(result.result, raw_result)
        self.assertEqual(
            result.provenance.input_sha256, _call(_ANTHROPIC_MODEL).request.input_sha256
        )

    def test_repr_and_failures_do_not_expose_credentials_prompts_inputs_or_responses(self) -> None:
        call = _call(_OPENAI_MODEL)
        client, _, _, _ = _client([_response(b'{"private":"RESPONSE-PRIVATE-SENTINEL"}')])
        adapter = OpenAIAnalysisLLMAdapter(http_client=client, api_key=_API_KEY)
        failure = self._failure(lambda: adapter.complete(call))
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
        failure = self._failure(lambda: OpenAIAnalysisLLMAdapter(http_client=client, api_key="   "))
        self.assertEqual(failure.failure.code, "analysis-llm-credentials")

    def test_adapters_have_no_sdk_or_direct_network_import(self) -> None:
        provider_root = (
            Path(__file__).parents[1] / "src" / "sciretriever" / "analysis" / "providers"
        )
        forbidden = {"anthropic", "httpx", "openai", "requests", "socket", "urllib"}
        for path in (provider_root / "openai.py", provider_root / "anthropic.py"):
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
