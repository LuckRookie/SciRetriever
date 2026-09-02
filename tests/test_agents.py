from __future__ import annotations

import json
import logging
import threading
import unittest
from typing import cast

import sciretriever.agents.api as agents_api
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
    AgentUsage,
)
from sciretriever.agents.ports import AgentProviderCall
from sciretriever.agents.providers.anthropic import AnthropicMessagesAdapter
from sciretriever.agents.providers.openai_chat import OpenAIChatCompletionsAdapter
from sciretriever.agents.providers.openai_responses import OpenAIResponsesAdapter
from sciretriever.agents.tools import canonical_json_bytes, parse_strict_json
from sciretriever.model.access import Header, TransportRequest
from sciretriever.model.primitives import Sha256, sha256_digest
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
    def __init__(self, body: bytes, *, status: int = 200) -> None:
        self.body = body
        self.status = status
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
        return _RawResponse(self.body, self.status)


class _Resolver:
    def resolve(self, hostname: str) -> tuple[str, ...]:
        del hostname
        return ("93.184.216.34",)


def _client(body: bytes, *, status: int = 200) -> tuple[HttpClient, _Transport]:
    transport = _Transport(body, status=status)
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
    limits: AgentCallLimits | None = None,
    max_output_tokens: int = 32,
    stream: bool = True,
) -> AgentProviderCall:
    if capabilities is None:
        capabilities = frozenset({AgentCapability.STRUCTURED_TEXT})
    return AgentProviderCall(
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
        stream=stream,
        limits=AgentCallLimits() if limits is None else limits,
    )


def _structured_payload() -> dict[str, object]:
    return {
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


def _structured_wire() -> bytes:
    return _responses_stream(_structured_payload())


def _responses_stream(payload: dict[str, object]) -> bytes:
    terminal = cast(dict[str, object], json.loads(json.dumps(payload)))
    blocks: list[bytes] = []
    output = terminal.get("output")
    if isinstance(output, list):
        for index, item in enumerate(output):
            event = {
                "type": "response.output_item.done",
                "output_index": index,
                "item": item,
            }
            blocks.append(
                b"event: response.output_item.done\ndata: "
                + json.dumps(event, separators=(",", ":")).encode()
                + b"\n\n"
            )
        terminal["output"] = []
    completed = {"type": "response.completed", "response": terminal}
    blocks.append(
        b"event: response.completed\ndata: "
        + json.dumps(completed, separators=(",", ":")).encode()
        + b"\n\n"
    )
    return b"".join(blocks)


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


def _runtime_text_call(*, max_output_tokens: int = 32) -> AgentCall:
    return AgentCall(
        role=AgentRole.ANALYSIS,
        required_capabilities=frozenset({AgentCapability.STRUCTURED_TEXT}),
        input_sha256=_HASH,
        text_parts=(
            AgentTextPart(media_type="text/plain", text="System instruction"),
            AgentTextPart(media_type="application/json", text='{"input":"fixture"}'),
        ),
        response_schema=_SCHEMA,
        max_output_tokens=max_output_tokens,
    )


class _FakePort:
    provider_name = "fixture-agent"

    def __init__(self, result: object | None = None) -> None:
        self.calls: list[AgentProviderCall] = []
        self.result = result

    def execute(self, call: AgentProviderCall) -> AgentStructuredResult:
        self.calls.append(call)
        if self.result is not None:
            return cast(AgentStructuredResult, self.result)
        return AgentStructuredResult(result='{"ok":true}', provenance=_provenance())


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
            AgentCall(
                role=AgentRole.BROWSER,
                required_capabilities=frozenset({AgentCapability.STRUCTURED_TEXT}),
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
            AgentCall(
                role=AgentRole.ANALYSIS,
                required_capabilities=frozenset({AgentCapability.STRUCTURED_TEXT}),
                input_sha256=_HASH,
                text_parts=(AgentTextPart(media_type="text/plain", text="instruction"),),
                response_schema=_SCHEMA,
                tools=(declaration,),
            )

    def test_image_is_bounded_and_media_is_explicit(self) -> None:
        image = AgentImagePart(media_type="image/png", data=b"PNG", width=16, height=16)
        request = AgentCall(
            role=AgentRole.ANALYSIS,
            required_capabilities=frozenset(
                {AgentCapability.STRUCTURED_TEXT, AgentCapability.IMAGE_INPUT}
            ),
            input_sha256=_HASH,
            text_parts=(AgentTextPart(media_type="text/plain", text="instruction"),),
            image_parts=(image,),
            response_schema=_SCHEMA,
        )
        self.assertEqual(request.image_parts[0].media_type, "image/png")
        with self.assertRaises(ValueError):
            AgentImagePart(media_type="image/gif", data=b"GIF", width=1, height=1)

    def test_tool_decision_canonicalizes_arguments(self) -> None:
        declaration = AgentToolDeclaration(name="click", input_schema=_TOOL_SCHEMA)
        decision = AgentToolCall(
            tool_name=declaration.name,
            arguments='{ "z": 1, "a": true }',
            provenance=_provenance(),
        )
        self.assertEqual(decision.arguments, '{"a":true,"z":1}')

    def test_structured_result_accepts_json_whitespace_and_canonicalizes_it(self) -> None:
        response = AgentStructuredResult(
            result='{\r\n\t"ok": true\n}',
            provenance=_provenance(),
        )

        self.assertEqual(response.result, '{"ok":true}')

    def test_json_tree_text_parts_and_cross_field_budgets_are_bounded(self) -> None:
        with self.assertRaises(ValueError):
            canonical_json_bytes({"oversize": "x" * (16 * 1024 * 1024)})
        with self.assertRaises(ValueError):
            AgentCall(
                role=AgentRole.ANALYSIS,
                required_capabilities=frozenset({AgentCapability.STRUCTURED_TEXT}),
                input_sha256=_HASH,
                text_parts=tuple(
                    AgentTextPart(media_type="text/plain", text=f"part-{index}")
                    for index in range(65)
                ),
                response_schema=_SCHEMA,
            )
        with self.assertRaises(ValueError):
            AgentCallLimits(max_output_tokens=65, context_window_tokens=64)
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
            AgentStructuredResult(
                result='{"ok":true}',
                provenance=cast(AgentProvenance, object()),
            )
        with self.assertRaises(TypeError):
            AgentToolCall(
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

    def test_role_binding_owns_model_identity_while_call_has_no_model(self) -> None:
        decomposed = "fixture-e\u0301-model"
        normalized = "fixture-\u00e9-model"
        binding = AgentRoleBinding(
            role=AgentRole.ANALYSIS,
            model=decomposed,
            capabilities=self._analysis_capabilities(),
        )
        self.assertEqual(binding.model, normalized)
        self.assertNotIn("model", AgentCall.__dataclass_fields__)

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
        exact_byte_limit = "\u754c" * 170 + "ab"
        self.assertEqual(
            AgentRoleBinding(
                role=AgentRole.ANALYSIS,
                model=exact_byte_limit,
                capabilities=self._analysis_capabilities(),
            ).model,
            exact_byte_limit,
        )

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

        self.assertTrue(runtime.readiness(AgentRole.ANALYSIS).ready)
        self.assertTrue(runtime.readiness(AgentRole.BROWSER).ready)

    def test_readiness_is_local_and_distinguishes_missing_and_protocol(self) -> None:
        port = _FakePort()
        missing = AgentRuntime(adapter=port)
        missing_analysis = missing.readiness(AgentRole.ANALYSIS)
        self.assertFalse(missing_analysis.configured)
        self.assertFalse(missing_analysis.model_declared)
        self.assertTrue(missing_analysis.protocol_supported)
        self.assertEqual(
            missing_analysis.missing,
            frozenset({AgentCapability.STRUCTURED_TEXT}),
        )

        undeclared = AgentRuntime(
            adapter=port,
            configured_roles=frozenset({AgentRole.ANALYSIS}),
        ).readiness(AgentRole.ANALYSIS)
        self.assertTrue(undeclared.configured)
        self.assertFalse(undeclared.model_declared)
        self.assertFalse(undeclared.ready)

        disabled = AgentRuntime(
            adapter=port,
            analysis=AgentRoleBinding(
                role=AgentRole.ANALYSIS,
                model=_MODEL,
                capabilities=self._analysis_capabilities(),
            ),
            protocol_supported=False,
        )
        disabled_analysis = disabled.readiness(AgentRole.ANALYSIS)
        self.assertTrue(disabled_analysis.configured)
        self.assertTrue(disabled_analysis.model_declared)
        self.assertFalse(disabled_analysis.protocol_supported)
        self.assertEqual(port.calls, [])

    def test_browser_readiness_requires_the_production_observation_media_type(self) -> None:
        port = _FakePort()
        runtime = AgentRuntime(
            adapter=port,
            browser=AgentRoleBinding(
                role=AgentRole.BROWSER,
                model=_MODEL,
                capabilities=AgentModelCapabilities(
                    context_window_tokens=4_096,
                    max_output_tokens=128,
                    image_input=True,
                    tool_decision=True,
                    supported_image_media_types=frozenset({"image/jpeg"}),
                    max_image_count=1,
                    max_image_bytes=64,
                ),
            ),
        )

        readiness = runtime.readiness(AgentRole.BROWSER)

        self.assertFalse(readiness.ready)
        self.assertEqual(readiness.missing, frozenset({AgentCapability.IMAGE_INPUT}))
        self.assertEqual(port.calls, [])

    def test_single_call_limits_and_cancel_type_fail_before_adapter_io(self) -> None:
        port = _FakePort()
        runtime = AgentRuntime(
            adapter=port,
            analysis=AgentRoleBinding(
                role=AgentRole.ANALYSIS,
                model=_MODEL,
                capabilities=self._analysis_capabilities(),
                limits=AgentCallLimits(max_request_bytes=1),
            ),
        )

        with self.assertRaises(AgentFailure) as caught:
            runtime.execute(_runtime_text_call())
        self.assertEqual(caught.exception.failure.code, "agent-request-budget")
        with self.assertRaises(TypeError):
            runtime.execute(_runtime_text_call(), cancel_event=cast(threading.Event, object()))
        self.assertEqual(port.calls, [])

    def test_preflight_failure_log_keeps_role_provider_model_and_safe_code(self) -> None:
        port = _FakePort()
        runtime = AgentRuntime(
            adapter=port,
            analysis=AgentRoleBinding(
                role=AgentRole.ANALYSIS,
                model=_MODEL,
                capabilities=self._analysis_capabilities(),
                limits=AgentCallLimits(max_request_bytes=1),
            ),
        )

        with self.assertLogs("sciretriever.agents", level="DEBUG") as logs:
            with self.assertRaises(AgentFailure):
                runtime.execute(_runtime_text_call())

        rendered = "\n".join(logs.output)
        self.assertIn("event=agent-call-preflight-failed", rendered)
        self.assertIn("role=analysis", rendered)
        self.assertIn("provider=fixture-agent", rendered)
        self.assertIn(f"wire_model={_MODEL}", rendered)
        self.assertIn("stream=on", rendered)
        self.assertIn("reasoning_effort=default", rendered)
        self.assertIn("outcome=failed", rendered)
        self.assertIn("code=agent-request-budget", rendered)
        self.assertIn("reason=The serialized Agent request exceeded", rendered)
        self.assertIn("action=Reduce the bounded Agent request.", rendered)
        self.assertEqual([record.levelno for record in logs.records], [logging.DEBUG])
        self.assertEqual(port.calls, [])

    def test_protocol_model_and_image_limits_fail_before_adapter_io(self) -> None:
        port = _FakePort()
        binding = AgentRoleBinding(
            role=AgentRole.ANALYSIS,
            model=_MODEL,
            capabilities=self._analysis_capabilities(),
        )
        disabled = AgentRuntime(adapter=port, analysis=binding, protocol_supported=False)
        with self.assertRaises(AgentFailure) as caught:
            disabled.execute(_runtime_text_call())
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
            tiny.execute(_runtime_text_call(max_output_tokens=1))
        self.assertEqual(caught.exception.failure.code, "agent-context-budget")
        self.assertEqual(port.calls, [])

    def test_execute_binds_model_and_cancel_to_one_provider_call(self) -> None:
        port = _FakePort()
        runtime = AgentRuntime(
            adapter=port,
            analysis=AgentRoleBinding(
                role=AgentRole.ANALYSIS,
                model=_MODEL,
                capabilities=self._analysis_capabilities(),
                stream=False,
            ),
        )
        cancel_event = threading.Event()

        result = runtime.execute(_runtime_text_call(), cancel_event=cancel_event)

        self.assertIsInstance(result, AgentStructuredResult)
        self.assertEqual(len(port.calls), 1)
        self.assertEqual(port.calls[0].model, _MODEL)
        self.assertFalse(port.calls[0].stream)
        self.assertIs(port.calls[0].cancel_event, cancel_event)

        self.assertTrue(
            AgentRoleBinding(
                role=AgentRole.ANALYSIS,
                model=_MODEL,
                capabilities=self._analysis_capabilities(),
            ).stream
        )

        cancelled = threading.Event()
        cancelled.set()
        with self.assertRaises(AgentFailure) as caught:
            runtime.execute(_runtime_text_call(), cancel_event=cancelled)
        self.assertEqual(caught.exception.failure.code, "agent-cancelled")
        self.assertEqual(len(port.calls), 1)

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
        request = AgentCall(
            role=AgentRole.BROWSER,
            required_capabilities=frozenset(
                {AgentCapability.IMAGE_INPUT, AgentCapability.TOOL_DECISION}
            ),
            input_sha256=_HASH,
            text_parts=(AgentTextPart(media_type="text/plain", text="decide"),),
            image_parts=(AgentImagePart(media_type="image/jpeg", data=b"JPEG", width=1, height=1),),
            tools=(declaration,),
            max_output_tokens=1,
        )

        with self.assertRaises(AgentFailure) as caught:
            runtime.execute(request)
        self.assertEqual(caught.exception.failure.code, "agent-capability")
        self.assertEqual(port.calls, [])

    def test_result_identity_and_usage_are_validated_at_the_runtime_boundary(self) -> None:
        def execute_with(provenance: AgentProvenance) -> str | None:
            port = _FakePort(AgentStructuredResult(result='{"ok":true}', provenance=provenance))
            runtime = AgentRuntime(
                adapter=port,
                analysis=AgentRoleBinding(
                    role=AgentRole.ANALYSIS,
                    model=_MODEL,
                    capabilities=self._analysis_capabilities(),
                ),
            )
            try:
                runtime.execute(_runtime_text_call())
            except AgentFailure as error:
                return error.failure.code
            self.assertEqual(len(port.calls), 1)
            return None

        self.assertEqual(
            execute_with(
                AgentProvenance(
                    provider="other-provider",
                    model=_MODEL,
                    input_sha256=_HASH,
                    parameters_sha256=_HASH,
                )
            ),
            "agent-protocol",
        )
        self.assertEqual(
            execute_with(
                AgentProvenance(
                    provider="fixture-agent",
                    model="other-model",
                    input_sha256=_HASH,
                    parameters_sha256=_HASH,
                )
            ),
            "agent-model-mismatch",
        )
        self.assertEqual(
            execute_with(
                AgentProvenance(
                    provider="fixture-agent",
                    model=_MODEL,
                    input_sha256=Sha256("b" * 64),
                    parameters_sha256=_HASH,
                )
            ),
            "agent-protocol",
        )
        self.assertEqual(
            execute_with(_provenance(output_tokens=33)),
            "agent-output-budget",
        )
        self.assertEqual(
            execute_with(_provenance(response_bytes=10_000_001)),
            "agent-response-budget",
        )


class AgentPublicApiTests(unittest.TestCase):
    def test_public_api_exposes_stateless_call_without_legacy_session_or_model_selection(
        self,
    ) -> None:
        exported = frozenset(agents_api.__all__)
        self.assertTrue(
            {
                "AgentCall",
                "AgentRuntime",
                "AgentStructuredResult",
                "AgentToolCall",
            }.issubset(exported)
        )
        self.assertTrue(
            exported.isdisjoint(
                {
                    "AgentBudget",
                    "AgentRequest",
                    "AgentSession",
                    "AgentPort",
                    "open_session",
                }
            )
        )
        self.assertTrue(
            frozenset(AgentCall.__dataclass_fields__).isdisjoint(
                {
                    "provider",
                    "base_url",
                    "model",
                    "credential",
                    "session",
                    "history",
                    "turn",
                    "budget",
                    "cancel_event",
                }
            )
        )


class AgentProviderWireTests(unittest.TestCase):
    def test_each_protocol_embeds_image_without_repeating_system_prompt(self) -> None:
        image = AgentImagePart(media_type="image/png", data=b"PNG", width=16, height=16)
        call = AgentCall(
            role=AgentRole.ANALYSIS,
            required_capabilities=frozenset(
                {AgentCapability.STRUCTURED_TEXT, AgentCapability.IMAGE_INPUT}
            ),
            input_sha256=_HASH,
            text_parts=(
                AgentTextPart(media_type="text/plain", text="System instruction"),
                AgentTextPart(media_type="application/json", text='{"input":"fixture"}'),
            ),
            image_parts=(image,),
            response_schema=_SCHEMA,
            max_output_tokens=32,
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
                runtime = AgentRuntime(
                    adapter=adapter,
                    analysis=AgentRoleBinding(
                        role=AgentRole.ANALYSIS,
                        model=_MODEL,
                        capabilities=AgentModelCapabilities(
                            context_window_tokens=4_096,
                            max_output_tokens=128,
                            structured_output=True,
                            image_input=True,
                            supported_image_media_types=frozenset({"image/png"}),
                            max_image_count=1,
                            max_image_bytes=64,
                        ),
                        stream=adapter_type is OpenAIResponsesAdapter,
                    ),
                )
                runtime.execute(call)
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
        call = AgentCall(
            role=AgentRole.BROWSER,
            required_capabilities=frozenset(
                {AgentCapability.IMAGE_INPUT, AgentCapability.TOOL_DECISION}
            ),
            input_sha256=_HASH,
            text_parts=(
                AgentTextPart(media_type="text/plain", text="System instruction"),
                AgentTextPart(media_type="application/json", text='{"input":"fixture"}'),
            ),
            image_parts=(AgentImagePart(media_type="image/png", data=b"PNG", width=16, height=16),),
            tools=(declaration,),
            max_output_tokens=32,
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
                wire = (
                    _responses_stream(payload)
                    if adapter_type is OpenAIResponsesAdapter
                    else json.dumps(payload).encode()
                )
                client, _ = _client(wire)
                runtime = AgentRuntime(
                    adapter=adapter_type(http_client=client, api_key=_KEY),
                    browser=AgentRoleBinding(
                        role=AgentRole.BROWSER,
                        model=_MODEL,
                        capabilities=AgentModelCapabilities(
                            context_window_tokens=4_096,
                            max_output_tokens=128,
                            image_input=True,
                            tool_decision=True,
                            supported_image_media_types=frozenset({"image/png"}),
                            max_image_count=1,
                            max_image_bytes=64,
                        ),
                        stream=adapter_type is OpenAIResponsesAdapter,
                    ),
                )
                result = runtime.execute(call)
                self.assertIsInstance(result, AgentToolCall)
                assert isinstance(result, AgentToolCall)
                self.assertEqual(result.tool_name, "click")
                self.assertEqual(result.arguments, "{}")

    def test_request_budget_is_stricter_than_adapter_defaults_and_undeclared_tool_fails(
        self,
    ) -> None:
        client, transport = _client(_structured_wire())
        adapter = OpenAIResponsesAdapter(http_client=client, api_key=_KEY)
        with self.assertRaises(AgentFailure) as caught:
            adapter.execute(_text_request(limits=AgentCallLimits(max_prompt_bytes=4)))
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
        client, _ = _client(_responses_stream(bad_tool))
        declaration = AgentToolDeclaration(name="click", input_schema=_TOOL_SCHEMA)
        with self.assertRaises(AgentFailure) as caught:
            OpenAIResponsesAdapter(http_client=client, api_key=_KEY).execute(
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
                client, _ = _client(_responses_stream(payload))
                with self.assertRaises(AgentFailure) as caught:
                    OpenAIResponsesAdapter(http_client=client, api_key=_KEY).execute(request)
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
        client, transport = _client(_responses_stream(payload))

        OpenAIResponsesAdapter(http_client=client, api_key=_KEY).execute(request)

        raw = transport.calls[0]["request"]
        assert isinstance(raw, TransportRequest)
        assert raw.body is not None
        body = json.loads(raw.body)
        description = body["tools"][0]["description"]
        self.assertEqual(description, "Return one declared action.")
        self.assertNotIn("Browser", description)

    def test_missing_usage_is_a_protocol_failure_for_every_adapter(self) -> None:
        response_payload = _structured_payload()
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
                wire = (
                    _responses_stream(payload)
                    if adapter_type is OpenAIResponsesAdapter
                    else json.dumps(payload).encode()
                )
                client, _ = _client(wire)
                with self.assertRaises(AgentFailure) as caught:
                    adapter_type(http_client=client, api_key=_KEY).execute(
                        _text_request(stream=adapter_type is OpenAIResponsesAdapter)
                    )
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
                wire = (
                    _responses_stream(payload)
                    if adapter_type is OpenAIResponsesAdapter
                    else json.dumps(payload).encode()
                )
                client, _ = _client(wire)
                with self.assertRaises(AgentFailure) as caught:
                    adapter_type(http_client=client, api_key=_KEY).execute(
                        _text_request(
                            capabilities=request.capabilities,
                            response_schema=request.response_schema,
                            tools=request.tools,
                            stream=adapter_type is OpenAIResponsesAdapter,
                        )
                    )
                self.assertEqual(caught.exception.failure.code, "agent-tool")

    def test_provider_logs_safe_stream_request_and_terminal_result_diagnostics(self) -> None:
        for stream in (True, False):
            with self.subTest(stream=stream):
                body = (
                    _structured_wire()
                    if stream
                    else json.dumps(_structured_payload()).encode("utf-8")
                )
                client, _transport = _client(body)
                adapter = OpenAIResponsesAdapter(http_client=client, api_key=_KEY)

                with self.assertLogs("sciretriever.agents", level="DEBUG") as captured:
                    result = adapter.execute(_text_request(stream=stream))

                self.assertIsInstance(result, AgentStructuredResult)
                rendered = "\n".join(captured.output)
                self.assertEqual(rendered.count("event=agent-call-started"), 1)
                self.assertEqual(rendered.count("event=agent-call-finished"), 1)
                self.assertIn("provider=openai", rendered)
                self.assertIn(f"wire_model={_MODEL}", rendered)
                self.assertIn("protocol=responses-v1", rendered)
                self.assertIn(f"stream={'on' if stream else 'off'}", rendered)
                self.assertIn("reasoning_effort=default", rendered)
                self.assertIn("outcome=success", rendered)
                self.assertIn("result=structured", rendered)
                self.assertIn("input_tokens=4", rendered)
                self.assertIn("output_tokens=1", rendered)
                self.assertTrue(all(record.levelno == logging.DEBUG for record in captured.records))
                self.assertNotIn(_KEY, rendered)
                self.assertNotIn("System instruction", rendered)
                self.assertNotIn('{"input":"fixture"}', rendered)

    def test_provider_failure_log_keeps_safe_remote_evidence_without_response_text(self) -> None:
        response_text = "provider-private-message-must-not-leak"
        body = json.dumps(
            {
                "error": {
                    "type": "invalid_request_error",
                    "param": "model",
                    "message": response_text,
                }
            }
        ).encode("utf-8")
        client, _transport = _client(body, status=400)
        adapter = OpenAIResponsesAdapter(http_client=client, api_key=_KEY)

        with self.assertLogs("sciretriever.agents", level="DEBUG") as captured:
            with self.assertRaises(AgentFailure):
                adapter.execute(_text_request())

        rendered = "\n".join(captured.output)
        terminal = [
            message for message in captured.output if "event=agent-call-finished" in message
        ]
        self.assertEqual(len(terminal), 1)
        self.assertIn("outcome=failed", terminal[0])
        self.assertIn("code=agent-request-rejected", terminal[0])
        self.assertIn("retryable=false", terminal[0])
        self.assertIn("http_status=400", terminal[0])
        self.assertIn("remote_error=model-rejected", terminal[0])
        self.assertIn("reason=The Agent provider rejected", terminal[0])
        self.assertIn("action=Review the model identity", terminal[0])
        self.assertNotIn(response_text, rendered)
        self.assertNotIn(_KEY, rendered)

    def test_pre_transport_budget_failure_still_emits_one_terminal_result_log(self) -> None:
        client, transport = _client(_structured_wire())
        adapter = OpenAIResponsesAdapter(http_client=client, api_key=_KEY)

        with self.assertLogs("sciretriever.agents", level="DEBUG") as captured:
            with self.assertRaises(AgentFailure):
                adapter.execute(_text_request(limits=AgentCallLimits(max_prompt_bytes=4)))

        terminal = [
            message for message in captured.output if "event=agent-call-finished" in message
        ]
        self.assertEqual(len(terminal), 1)
        self.assertIn("code=agent-input-budget", terminal[0])
        self.assertEqual(transport.calls, [])


if __name__ == "__main__":
    unittest.main()
