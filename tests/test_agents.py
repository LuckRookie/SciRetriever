from __future__ import annotations

import json
import threading
import unittest
from typing import cast

from sciretriever.agents import (
    AgentBudget,
    AgentCapability,
    AgentFailure,
    AgentImagePart,
    AgentModelCapabilities,
    AgentProvenance,
    AgentRequest,
    AgentRole,
    AgentRoleBinding,
    AgentRuntime,
    AgentSession,
    AgentStructuredResponse,
    AgentTextPart,
    AgentToolDecision,
    AgentToolDeclaration,
    AgentUsage,
    canonical_json_bytes,
    parse_strict_json,
)
from sciretriever.agents.providers.anthropic import AnthropicMessagesAdapter
from sciretriever.agents.providers.openai_chat import OpenAIChatCompletionsAdapter
from sciretriever.agents.providers.openai_responses import OpenAIResponsesAdapter
from sciretriever.model.access import Header, TransportRequest
from sciretriever.model.primitives import sha256_digest
from sciretriever.network.admission import AccessCoordinator
from sciretriever.network.http import HttpClient

_MODEL = "fixture-agent-model"
_KEY = "AGENT-KEY-SENTINEL"
_HASH = sha256_digest(b"fixture-agent-input")
_SCHEMA = (
    '{"type":"object","properties":{"ok":{"type":"boolean"}},'
    '"required":["ok"],"additionalProperties":false}'
)
_TOOL_SCHEMA = '{"type":"object","properties":{},"required":[],"additionalProperties":false}'


class _RawResponse:
    def __init__(self, body: bytes, status: int = 200) -> None:
        self.status = status
        self.headers: tuple[Header, ...] = ()
        self.body = body
        self.closed = False

    def close(self) -> None:
        self.closed = True


class _Transport:
    def __init__(self, body: bytes) -> None:
        self.body = body
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
    ) -> _RawResponse:
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
        return _RawResponse(self.body)


class _Resolver:
    def resolve(self, hostname: str) -> tuple[str, ...]:
        del hostname
        return ("93.184.216.34",)


def _client(body: bytes) -> tuple[HttpClient, _Transport]:
    transport = _Transport(body)
    return (
        HttpClient(
            resolver=_Resolver(),
            transport=transport,
            coordinator=AccessCoordinator(),
        ),
        transport,
    )


def _text_request(
    *,
    model: str = _MODEL,
    capabilities: frozenset[AgentCapability] | None = None,
    image_parts: tuple[AgentImagePart, ...] = (),
    response_schema: str | None = _SCHEMA,
    tools: tuple[AgentToolDeclaration, ...] = (),
    budget: AgentBudget | None = None,
    max_output_tokens: int = 32,
) -> AgentRequest:
    if capabilities is None:
        capabilities = frozenset({AgentCapability.STRUCTURED_TEXT})
    return AgentRequest(
        role=AgentRole.ANALYSIS,
        capabilities=capabilities,
        model=model,
        input_sha256=_HASH,
        text_parts=(
            AgentTextPart(media_type="text/plain", text="System instruction"),
            AgentTextPart(media_type="application/json", text='{"input":"fixture"}'),
        ),
        image_parts=image_parts,
        response_schema=response_schema,
        tools=tools,
        max_output_tokens=max_output_tokens,
        budget=AgentBudget() if budget is None else budget,
    )


def _structured_wire() -> bytes:
    return json.dumps(
        {
            "object": "response",
            "status": "completed",
            "model": _MODEL,
            "usage": {"input_tokens": 4, "output_tokens": 1},
            "output": [
                {
                    "type": "message",
                    "status": "completed",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": '{"ok":true}'}],
                }
            ],
        }
    ).encode()


def _chat_wire() -> bytes:
    return json.dumps(
        {
            "object": "chat.completion",
            "model": _MODEL,
            "usage": {"prompt_tokens": 4, "completion_tokens": 1},
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": '{"ok":true}',
                        "refusal": None,
                    },
                }
            ],
        }
    ).encode()


def _provenance(*, output_tokens: int = 1, response_bytes: int = 1) -> AgentProvenance:
    return AgentProvenance(
        provider="fixture-agent",
        model=_MODEL,
        input_sha256=_HASH,
        parameters_sha256=sha256_digest(b"fixture-parameters"),
        usage=AgentUsage(output_tokens=output_tokens, response_bytes=response_bytes),
    )


class _FakePort:
    provider_name = "fixture-agent"

    def __init__(self) -> None:
        self.requests: list[AgentRequest] = []

    def complete(self, request: AgentRequest) -> AgentStructuredResponse:
        self.requests.append(request)
        return AgentStructuredResponse(result='{"ok":true}', provenance=_provenance())


class AgentValueTests(unittest.TestCase):
    def test_strict_json_rejects_duplicates_nonfinite_and_depth(self) -> None:
        for value in (
            '{"x":1,"x":2}',
            '{"x":NaN}',
            '{"x":Infinity}',
            "{" + '"x":{' * 33 + '"value":true' + "}" * 33 + "}",
        ):
            with self.subTest(value=value[:20]):
                with self.assertRaises(ValueError):
                    parse_strict_json(value)

    def test_capabilities_and_tool_schema_are_closed(self) -> None:
        with self.assertRaises(ValueError):
            AgentRequest(
                role=AgentRole.BROWSER,
                capabilities=frozenset({AgentCapability.STRUCTURED_TEXT}),
                model=_MODEL,
                input_sha256=_HASH,
                text_parts=(),
                response_schema=_SCHEMA,
            )
        with self.assertRaises(ValueError):
            AgentToolDeclaration(
                name="navigate",
                input_schema='{"type":"object","additionalProperties":true}',
            )
        declaration = AgentToolDeclaration(name="click", input_schema=_TOOL_SCHEMA)
        with self.assertRaises(ValueError):
            _text_request(
                capabilities=frozenset({AgentCapability.STRUCTURED_TEXT}),
                response_schema=_SCHEMA,
                tools=(declaration,),
            )

    def test_image_is_bounded_and_media_is_explicit(self) -> None:
        image = AgentImagePart(media_type="image/png", data=b"PNG", width=16, height=16)
        request = _text_request(
            capabilities=frozenset({AgentCapability.STRUCTURED_TEXT, AgentCapability.IMAGE_INPUT}),
            image_parts=(image,),
        )
        self.assertEqual(request.image_parts[0].media_type, "image/png")
        with self.assertRaises(ValueError):
            AgentImagePart(media_type="image/gif", data=b"GIF", width=1, height=1)

    def test_tool_decision_canonicalizes_arguments(self) -> None:
        declaration = AgentToolDeclaration(name="click", input_schema=_TOOL_SCHEMA)
        decision = AgentToolDecision(
            tool_name=declaration.name,
            arguments='{ "z": 1, "a": true }',
            provenance=_provenance(),
        )
        self.assertEqual(decision.arguments, '{"a":true,"z":1}')

    def test_structured_result_accepts_json_whitespace_and_canonicalizes_it(self) -> None:
        response = AgentStructuredResponse(
            result='{\r\n\t"ok": true\n}',
            provenance=_provenance(),
        )

        self.assertEqual(response.result, '{"ok":true}')

    def test_json_tree_text_parts_and_cross_field_budgets_are_bounded(self) -> None:
        with self.assertRaises(ValueError):
            canonical_json_bytes({"oversize": "x" * (16 * 1024 * 1024)})
        with self.assertRaises(ValueError):
            AgentRequest(
                role=AgentRole.ANALYSIS,
                capabilities=frozenset({AgentCapability.STRUCTURED_TEXT}),
                model=_MODEL,
                input_sha256=_HASH,
                text_parts=tuple(
                    AgentTextPart(media_type="text/plain", text=f"part-{index}")
                    for index in range(65)
                ),
                response_schema=_SCHEMA,
            )
        with self.assertRaises(ValueError):
            AgentBudget(max_output_tokens=65, context_window_tokens=64)
        with self.assertRaises(ValueError):
            AgentModelCapabilities(context_window_tokens=64, max_output_tokens=65)

    def test_nested_value_objects_reject_wrong_runtime_types(self) -> None:
        with self.assertRaises(TypeError):
            AgentProvenance(
                provider="fixture",
                model=_MODEL,
                input_sha256=_HASH,
                parameters_sha256=_HASH,
                usage=cast(AgentUsage, object()),
            )
        with self.assertRaises(TypeError):
            AgentStructuredResponse(
                result='{"ok":true}',
                provenance=cast(AgentProvenance, object()),
            )
        with self.assertRaises(TypeError):
            AgentToolDecision(
                tool_name="click",
                arguments="{}",
                provenance=cast(AgentProvenance, object()),
            )


class AgentRuntimeTests(unittest.TestCase):
    @staticmethod
    def _analysis_capabilities() -> AgentModelCapabilities:
        return AgentModelCapabilities(
            context_window_tokens=4_096,
            max_output_tokens=128,
            structured_output=True,
        )

    @staticmethod
    def _browser_capabilities() -> AgentModelCapabilities:
        return AgentModelCapabilities(
            context_window_tokens=4_096,
            max_output_tokens=128,
            image_input=True,
            tool_decision=True,
            supported_image_media_types=frozenset({"image/png"}),
            max_image_count=1,
            max_image_bytes=64,
        )

    def test_role_binding_model_identity_matches_request_contract(self) -> None:
        decomposed = "fixture-e\u0301-model"
        normalized = "fixture-\u00e9-model"
        binding = AgentRoleBinding(
            role=AgentRole.ANALYSIS,
            model=decomposed,
            capabilities=self._analysis_capabilities(),
        )
        request = _text_request(model=decomposed)

        self.assertEqual(binding.model, normalized)
        self.assertEqual(request.model, normalized)

        for invalid in (
            "fixture\nforged",
            "fixture\u0085forged",
            "\u754c" * 171,
        ):
            with self.subTest(invalid=invalid[:16]):
                with self.assertRaises(ValueError):
                    AgentRoleBinding(
                        role=AgentRole.ANALYSIS,
                        model=invalid,
                        capabilities=self._analysis_capabilities(),
                    )
                with self.assertRaises(ValueError):
                    _text_request(model=invalid)

        exact_byte_limit = "\u754c" * 170 + "ab"
        self.assertEqual(
            AgentRoleBinding(
                role=AgentRole.ANALYSIS,
                model=exact_byte_limit,
                capabilities=self._analysis_capabilities(),
            ).model,
            exact_byte_limit,
        )
        self.assertEqual(_text_request(model=exact_byte_limit).model, exact_byte_limit)

    def test_role_slots_and_browser_readiness_are_exact(self) -> None:
        port = _FakePort()
        with self.assertRaises(ValueError):
            AgentRuntime(
                adapter=port,
                analysis=AgentRoleBinding(
                    role=AgentRole.BROWSER,
                    model=_MODEL,
                    capabilities=self._browser_capabilities(),
                ),
            )
        runtime = AgentRuntime(
            adapter=port,
            analysis=AgentRoleBinding(
                role=AgentRole.ANALYSIS,
                model=_MODEL,
                capabilities=self._analysis_capabilities(),
            ),
            browser=AgentRoleBinding(
                role=AgentRole.BROWSER,
                model=_MODEL,
                capabilities=self._browser_capabilities(),
            ),
        )

        self.assertTrue(runtime.readiness.analysis.ready)
        self.assertTrue(runtime.readiness.browser.ready)

    def test_protocol_model_and_image_limits_fail_before_adapter_io(self) -> None:
        port = _FakePort()
        binding = AgentRoleBinding(
            role=AgentRole.ANALYSIS,
            model=_MODEL,
            capabilities=self._analysis_capabilities(),
        )
        disabled = AgentRuntime(adapter=port, analysis=binding, protocol_supported=False)
        with self.assertRaises(AgentFailure) as caught:
            disabled.complete(_text_request())
        self.assertEqual(caught.exception.failure.code, "agent-capability")

        tiny = AgentRuntime(
            adapter=port,
            analysis=AgentRoleBinding(
                role=AgentRole.ANALYSIS,
                model=_MODEL,
                capabilities=AgentModelCapabilities(
                    context_window_tokens=64,
                    max_output_tokens=1,
                    structured_output=True,
                ),
            ),
        )
        with self.assertRaises(AgentFailure) as caught:
            tiny.complete(_text_request(max_output_tokens=1))
        self.assertEqual(caught.exception.failure.code, "agent-context-budget")
        self.assertEqual(port.requests, [])

    def test_browser_image_media_count_and_bytes_fail_before_adapter_io(self) -> None:
        port = _FakePort()
        runtime = AgentRuntime(
            adapter=port,
            browser=AgentRoleBinding(
                role=AgentRole.BROWSER,
                model=_MODEL,
                capabilities=self._browser_capabilities(),
            ),
        )
        declaration = AgentToolDeclaration(name="click", input_schema=_TOOL_SCHEMA)
        request = AgentRequest(
            role=AgentRole.BROWSER,
            capabilities=frozenset({AgentCapability.IMAGE_INPUT, AgentCapability.TOOL_DECISION}),
            model=_MODEL,
            input_sha256=_HASH,
            text_parts=(AgentTextPart(media_type="text/plain", text="decide"),),
            image_parts=(AgentImagePart(media_type="image/jpeg", data=b"JPEG", width=1, height=1),),
            tools=(declaration,),
            max_output_tokens=1,
        )

        with self.assertRaises(AgentFailure) as caught:
            runtime.complete(request)
        self.assertEqual(caught.exception.failure.code, "agent-capability")
        self.assertEqual(port.requests, [])


class AgentProviderWireTests(unittest.TestCase):
    def test_each_protocol_embeds_image_without_repeating_system_prompt(self) -> None:
        image = AgentImagePart(media_type="image/png", data=b"PNG", width=16, height=16)
        request = _text_request(
            capabilities=frozenset({AgentCapability.STRUCTURED_TEXT, AgentCapability.IMAGE_INPUT}),
            image_parts=(image,),
        )
        for adapter_type, key in (
            (OpenAIResponsesAdapter, "input"),
            (OpenAIChatCompletionsAdapter, "messages"),
            (AnthropicMessagesAdapter, "messages"),
        ):
            with self.subTest(adapter=adapter_type.__name__):
                if "Anthropic" in adapter_type.__name__:
                    wire = json.dumps(
                        {
                            "type": "message",
                            "role": "assistant",
                            "model": _MODEL,
                            "usage": {"input_tokens": 4, "output_tokens": 1},
                            "stop_reason": "end_turn",
                            "content": [{"type": "text", "text": '{"ok":true}'}],
                        }
                    ).encode()
                elif "Chat" in adapter_type.__name__:
                    wire = _chat_wire()
                else:
                    wire = _structured_wire()
                client, transport = _client(wire)
                adapter = adapter_type(http_client=client, api_key=_KEY)
                adapter.complete(request)
                raw = transport.calls[0]["request"]
                assert isinstance(raw, TransportRequest)
                assert raw.body is not None
                body = json.loads(raw.body)
                if key == "input":
                    user = body["input"][1]["content"]
                    self.assertEqual([part["type"] for part in user], ["input_text", "input_image"])
                    self.assertEqual(body["input"][0]["content"][0]["text"], "System instruction")
                elif "Anthropic" in adapter_type.__name__:
                    content = body["messages"][0]["content"]
                    self.assertEqual([part["type"] for part in content], ["text", "image"])
                    self.assertEqual(body["system"], "System instruction")
                else:
                    content = body["messages"][1]["content"]
                    self.assertEqual(
                        [part["type"] for part in content],
                        ["text", "image_url"],
                    )
                    self.assertEqual(body["messages"][0]["content"], "System instruction")

    def test_each_protocol_parses_declared_tool_only(self) -> None:
        declaration = AgentToolDeclaration(name="click", input_schema=_TOOL_SCHEMA)
        request = _text_request(
            capabilities=frozenset({AgentCapability.TOOL_DECISION}),
            response_schema=None,
            tools=(declaration,),
        )
        payloads = (
            (
                OpenAIResponsesAdapter,
                {
                    "object": "response",
                    "status": "completed",
                    "model": _MODEL,
                    "usage": {"input_tokens": 4, "output_tokens": 1},
                    "output": [{"type": "function_call", "name": "click", "arguments": "{}"}],
                },
            ),
            (
                OpenAIChatCompletionsAdapter,
                {
                    "object": "chat.completion",
                    "model": _MODEL,
                    "usage": {"prompt_tokens": 4, "completion_tokens": 1},
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "tool_calls",
                            "message": {
                                "role": "assistant",
                                "tool_calls": [
                                    {
                                        "type": "function",
                                        "function": {
                                            "name": "click",
                                            "arguments": "{}",
                                        },
                                    }
                                ],
                            },
                        }
                    ],
                },
            ),
            (
                AnthropicMessagesAdapter,
                {
                    "type": "message",
                    "role": "assistant",
                    "model": _MODEL,
                    "usage": {"input_tokens": 4, "output_tokens": 1},
                    "stop_reason": "tool_use",
                    "content": [{"type": "tool_use", "name": "click", "input": {}}],
                },
            ),
        )
        for adapter_type, payload in payloads:
            with self.subTest(adapter=adapter_type.__name__):
                client, _ = _client(json.dumps(payload).encode())
                result = adapter_type(http_client=client, api_key=_KEY).complete(request)
                self.assertIsInstance(result, AgentToolDecision)
                assert isinstance(result, AgentToolDecision)
                self.assertEqual(result.tool_name, "click")
                self.assertEqual(result.arguments, "{}")

    def test_request_budget_is_stricter_than_adapter_defaults_and_undeclared_tool_fails(
        self,
    ) -> None:
        client, transport = _client(_structured_wire())
        adapter = OpenAIResponsesAdapter(http_client=client, api_key=_KEY)
        with self.assertRaises(AgentFailure) as caught:
            adapter.complete(_text_request(budget=AgentBudget(max_prompt_bytes=4)))
        self.assertEqual(caught.exception.failure.code, "agent-input-budget")
        self.assertEqual(transport.calls, [])

        bad_tool = json.loads(
            json.dumps(
                {
                    "object": "response",
                    "status": "completed",
                    "model": _MODEL,
                    "usage": {"input_tokens": 4, "output_tokens": 1},
                    "output": [{"type": "function_call", "name": "other", "arguments": "{}"}],
                }
            )
        )
        client, _ = _client(json.dumps(bad_tool).encode())
        declaration = AgentToolDeclaration(name="click", input_schema=_TOOL_SCHEMA)
        with self.assertRaises(AgentFailure) as caught:
            OpenAIResponsesAdapter(http_client=client, api_key=_KEY).complete(
                _text_request(
                    capabilities=frozenset({AgentCapability.TOOL_DECISION}),
                    response_schema=None,
                    tools=(declaration,),
                )
            )
        self.assertEqual(caught.exception.failure.code, "agent-tool")

    def test_tool_arguments_are_validated_against_the_declared_closed_schema(self) -> None:
        schema = json.dumps(
            {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["click"]},
                    "count": {"type": "integer", "const": 1},
                    "mode": {
                        "type": "string",
                        "anyOf": [
                            {"type": "string", "enum": ["safe"]},
                            {"type": "string", "enum": ["stop"]},
                        ],
                    },
                    "flags": {"type": "array", "items": {"type": "boolean"}},
                },
                "required": ["action", "count", "mode", "flags"],
                "additionalProperties": False,
            }
        )
        declaration = AgentToolDeclaration(name="decide", input_schema=schema)
        request = _text_request(
            capabilities=frozenset({AgentCapability.TOOL_DECISION}),
            response_schema=None,
            tools=(declaration,),
        )
        invalid_arguments = (
            '{"action":"click","count":true,"mode":"safe","flags":[]}',
            '{"action":"click","count":1,"mode":"other","flags":[]}',
            '{"action":"click","count":1,"mode":"safe","flags":[],"extra":1}',
            '{"action":"click","count":1,"mode":"safe"}',
        )
        for arguments in invalid_arguments:
            with self.subTest(arguments=arguments):
                payload = {
                    "object": "response",
                    "status": "completed",
                    "model": _MODEL,
                    "usage": {"input_tokens": 4, "output_tokens": 1},
                    "output": [
                        {
                            "type": "function_call",
                            "name": "decide",
                            "arguments": arguments,
                        }
                    ],
                }
                client, _ = _client(json.dumps(payload).encode())
                with self.assertRaises(AgentFailure) as caught:
                    OpenAIResponsesAdapter(http_client=client, api_key=_KEY).complete(request)
                self.assertEqual(caught.exception.failure.code, "agent-tool")

    def test_tool_description_is_consumer_data_and_has_no_browser_business_default(self) -> None:
        declaration = AgentToolDeclaration(name="click", input_schema=_TOOL_SCHEMA)
        request = _text_request(
            capabilities=frozenset({AgentCapability.TOOL_DECISION}),
            response_schema=None,
            tools=(declaration,),
        )
        payload = {
            "object": "response",
            "status": "completed",
            "model": _MODEL,
            "usage": {"input_tokens": 4, "output_tokens": 1},
            "output": [{"type": "function_call", "name": "click", "arguments": "{}"}],
        }
        client, transport = _client(json.dumps(payload).encode())

        OpenAIResponsesAdapter(http_client=client, api_key=_KEY).complete(request)

        raw = transport.calls[0]["request"]
        assert isinstance(raw, TransportRequest)
        assert raw.body is not None
        body = json.loads(raw.body)
        description = body["tools"][0]["description"]
        self.assertEqual(description, "Return one declared action.")
        self.assertNotIn("Browser", description)

    def test_missing_usage_is_a_protocol_failure_for_every_adapter(self) -> None:
        response_payload = json.loads(_structured_wire())
        response_payload.pop("usage")
        chat_payload = json.loads(_chat_wire())
        chat_payload.pop("usage")
        anthropic_payload = {
            "type": "message",
            "role": "assistant",
            "model": _MODEL,
            "stop_reason": "end_turn",
            "content": [{"type": "text", "text": '{"ok":true}'}],
        }
        for adapter_type, payload in (
            (OpenAIResponsesAdapter, response_payload),
            (OpenAIChatCompletionsAdapter, chat_payload),
            (AnthropicMessagesAdapter, anthropic_payload),
        ):
            with self.subTest(adapter=adapter_type.__name__):
                client, _ = _client(json.dumps(payload).encode())
                with self.assertRaises(AgentFailure) as caught:
                    adapter_type(http_client=client, api_key=_KEY).complete(_text_request())
                self.assertEqual(caught.exception.failure.code, "agent-protocol")

    def test_tool_mode_rejects_any_extra_assistant_content(self) -> None:
        declaration = AgentToolDeclaration(name="click", input_schema=_TOOL_SCHEMA)
        request = _text_request(
            capabilities=frozenset({AgentCapability.TOOL_DECISION}),
            response_schema=None,
            tools=(declaration,),
        )
        payloads = (
            (
                OpenAIResponsesAdapter,
                {
                    "object": "response",
                    "status": "completed",
                    "model": _MODEL,
                    "usage": {"input_tokens": 4, "output_tokens": 1},
                    "output": [
                        {"type": "function_call", "name": "click", "arguments": "{}"},
                        {
                            "type": "message",
                            "status": "completed",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": "extra"}],
                        },
                    ],
                },
            ),
            (
                OpenAIChatCompletionsAdapter,
                {
                    "object": "chat.completion",
                    "model": _MODEL,
                    "usage": {"prompt_tokens": 4, "completion_tokens": 1},
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "tool_calls",
                            "message": {
                                "role": "assistant",
                                "content": "extra",
                                "tool_calls": [
                                    {
                                        "type": "function",
                                        "function": {"name": "click", "arguments": "{}"},
                                    }
                                ],
                            },
                        }
                    ],
                },
            ),
            (
                AnthropicMessagesAdapter,
                {
                    "type": "message",
                    "role": "assistant",
                    "model": _MODEL,
                    "usage": {"input_tokens": 4, "output_tokens": 1},
                    "stop_reason": "tool_use",
                    "content": [
                        {"type": "tool_use", "name": "click", "input": {}},
                        {"type": "text", "text": "extra"},
                    ],
                },
            ),
        )
        for adapter_type, payload in payloads:
            with self.subTest(adapter=adapter_type.__name__):
                client, _ = _client(json.dumps(payload).encode())
                with self.assertRaises(AgentFailure) as caught:
                    adapter_type(http_client=client, api_key=_KEY).complete(request)
                self.assertEqual(caught.exception.failure.code, "agent-tool")

    def test_pre_transport_budget_failure_still_emits_one_terminal_result_log(self) -> None:
        client, transport = _client(_structured_wire())
        adapter = OpenAIResponsesAdapter(http_client=client, api_key=_KEY)

        with self.assertLogs("sciretriever.agents", level="INFO") as captured:
            with self.assertRaises(AgentFailure):
                adapter.complete(_text_request(budget=AgentBudget(max_prompt_bytes=4)))

        terminal = [message for message in captured.output if "agent.call.result" in message]
        self.assertEqual(len(terminal), 1)
        self.assertIn("failure=agent-input-budget", terminal[0])
        self.assertEqual(transport.calls, [])


class AgentSessionTests(unittest.TestCase):
    def test_session_adds_bounded_history_and_cleans_on_close(self) -> None:
        port = _FakePort()
        session = AgentSession(port=port, max_turns=2)
        request = _text_request()
        session.complete(request)
        session.complete(request)
        self.assertEqual([len(item.history) for item in port.requests], [0, 1])
        self.assertEqual(session.turns, 2)
        session.close()
        with self.assertRaises(AgentFailure) as caught:
            session.complete(request)
        self.assertEqual(caught.exception.failure.code, "agent-cleanup")

    def test_session_enforces_turn_cancel_and_cumulative_output_budget(self) -> None:
        port = _FakePort()
        session = AgentSession(port=port, max_turns=3)
        request = _text_request(
            budget=AgentBudget(max_output_tokens=1),
            max_output_tokens=1,
        )
        session.complete(request)
        with self.assertRaises(AgentFailure) as caught:
            session.complete(request)
        self.assertEqual(caught.exception.failure.code, "agent-output-budget")
        cancelled = threading.Event()
        cancelled.set()
        with self.assertRaises(AgentFailure) as caught:
            AgentSession(port=port, cancel_event=cancelled).complete(request)
        self.assertEqual(caught.exception.failure.code, "agent-cancelled")


if __name__ == "__main__":
    unittest.main()
