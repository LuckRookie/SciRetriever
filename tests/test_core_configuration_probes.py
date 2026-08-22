from __future__ import annotations

import json
import tempfile
import threading
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, cast
from unittest.mock import patch

from sciretriever.bootstrap import ProductionConfigurationProbeSession
from sciretriever.configuration import (
    browser_access_status,
    configuration_status,
    load_credentials,
    parse_configuration,
    set_core_credentials,
)
from sciretriever.model.access import Header, TransportRequest
from sciretriever.model.configuration import (
    AgentConfigurationProbeDetails,
    Configuration,
    MinerUConfigurationProbeDetails,
    ProbeOutcome,
)
from sciretriever.network.admission import AccessCoordinator
from sciretriever.network.browser_sessions import BrowserSessionBroker
from sciretriever.network.cloakbrowser import CloakBrowserRuntimeAvailability
from sciretriever.network.http import HttpClient


class _EmptyProbeRegistry:
    supported_capabilities = frozenset()

    def probe(self, provider: object, capability: object) -> object:
        del provider, capability
        raise AssertionError("core probes must not call a Provider probe")


class _EmptyBrowserProbePort:
    supported_access_keys = frozenset()

    def probe(self, access_key: str) -> object:
        del access_key
        raise AssertionError("core probes must not call a Browser probe")


class _Resolver:
    def __init__(self, answers: dict[str, tuple[str, ...]]) -> None:
        self.answers = answers
        self.calls: list[str] = []

    def resolve(self, hostname: str) -> tuple[str, ...]:
        self.calls.append(hostname)
        return self.answers[hostname]


@dataclass
class _RawResponse:
    status: int
    headers: tuple[Header, ...]
    body: bytes | Iterable[bytes]
    closed: bool = False

    def close(self) -> None:
        self.closed = True


class _Transport:
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


def _response(payload: object, *, status: int = 200) -> _RawResponse:
    return _RawResponse(
        status=status,
        headers=(Header(name="Content-Type", value="application/json"),),
        body=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
    )


def _analysis_configuration(protocol: str = "openai-responses") -> Configuration:
    return parse_configuration(
        f"""
        [agents]
        provider = "openai"
        protocol = "{protocol}"
        base_url = "https://api.openai.com/v1"
        authentication = "api-key"
        [agents.analysis]
        model = "probe-model"
        context_window_tokens = 128000
        structured_output = true
        max_output_tokens = 64
        [analysis]
        metadata_max_output_tokens = 64
        content_max_output_tokens = 64
        reference_max_output_tokens = 64
        max_input_bytes = 4096
        max_chunk_bytes = 4096
        max_chunk_count = 1
        max_total_llm_requests = 3
        max_total_output_tokens = 192
        """
    )


def _browser_agent_configuration() -> Configuration:
    return parse_configuration(
        """
        [agents]
        provider = "openai"
        protocol = "openai-responses"
        base_url = "https://api.openai.com/v1"
        authentication = "api-key"
        [agents.analysis]
        model = "analysis-probe-model"
        context_window_tokens = 128000
        structured_output = true
        max_output_tokens = 64
        [agents.browser]
        model = "browser-probe-model"
        context_window_tokens = 128000
        max_output_tokens = 64
        image_input = true
        tool_decision = true
        image_media_types = ["image/png"]
        image_count = 1
        image_bytes = 1024
        turns = 1
        [analysis]
        metadata_max_output_tokens = 64
        content_max_output_tokens = 64
        reference_max_output_tokens = 64
        max_input_bytes = 4096
        max_chunk_bytes = 4096
        max_chunk_count = 1
        max_total_llm_requests = 3
        max_total_output_tokens = 192
        """
    )


def _browser_agent_only_configuration() -> Configuration:
    return parse_configuration(
        """
        [agents]
        provider = "openai"
        protocol = "openai-responses"
        base_url = "https://api.openai.com/v1"
        authentication = "api-key"
        [agents.browser]
        model = "browser-probe-model"
        context_window_tokens = 128000
        max_output_tokens = 64
        image_input = true
        tool_decision = true
        image_media_types = ["image/png"]
        image_count = 1
        image_bytes = 1024
        turns = 1
        """
    )


def _mineru_configuration() -> Configuration:
    return parse_configuration(
        """
        [parsing]
        base_url = "http://127.0.0.1:8000"
        connection_mode = "loopback"
        model_identity = "mineru-3.4.4-vlm"
        remote_upload_authorized = false
        """
    )


def _session(
    configuration: Configuration,
    home: Path,
    transport: _Transport,
) -> ProductionConfigurationProbeSession:
    coordinator = AccessCoordinator()
    http_client = HttpClient(
        resolver=_Resolver(
            {
                "api.openai.com": ("93.184.216.34",),
                "127.0.0.1": ("127.0.0.1",),
            }
        ),
        transport=transport,
        coordinator=coordinator,
    )
    credentials = load_credentials(home=home)
    with patch(
        "sciretriever.configuration.browser_access._cloak_local_status",
        return_value=(
            True,
            True,
            True,
            "146.0.7680.177.5",
            True,
            True,
            "sciretriever.browser-identity.v1",
        ),
    ):
        browser_status = browser_access_status(
            configuration,
            home=home,
            runtime_availability=CloakBrowserRuntimeAvailability(
                cloak_wrapper_available=True,
                playwright_api_available=True,
                binary_executable_available=True,
                headed_display_available=True,
                browser_version="146.0.7680.177.5",
            ),
        )
    return ProductionConfigurationProbeSession(
        configuration=configuration,
        credentials=credentials,
        status=configuration_status(configuration, credentials=credentials),
        probe_port=cast(Any, _EmptyProbeRegistry()),
        access_coordinator=coordinator,
        http_client=http_client,
        browser_status=browser_status,
        browser_probe_port=cast(Any, _EmptyBrowserProbePort()),
        browser_session_broker=BrowserSessionBroker(),
    )


class CoreConfigurationProbeTests(unittest.TestCase):
    def test_browser_agent_only_configuration_uses_browser_role_without_analysis(self) -> None:
        response = {
            "id": "resp_browser_probe",
            "object": "response",
            "status": "completed",
            "model": "browser-probe-model",
            "usage": {"input_tokens": 16, "output_tokens": 1},
            "output": [
                {
                    "type": "function_call",
                    "name": "probe_stop",
                    "arguments": '{"ok":true}',
                }
            ],
        }
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_core_credentials(
                "agents",
                secret="probe-secret",
                origin="https://api.openai.com",
                home=home,
            )
            transport = _Transport([_response(response)])
            result = _session(
                _browser_agent_only_configuration(),
                home,
                transport,
            ).run_browser_agent()

        self.assertIs(result.outcome, ProbeOutcome.PASSED)
        self.assertTrue(result.local_ready)
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(cast(AgentConfigurationProbeDetails, result.details).role, "browser-agent")

    def test_browser_agent_probe_uses_one_synthetic_image_and_closed_tool(self) -> None:
        response = {
            "id": "resp_browser_probe",
            "object": "response",
            "status": "completed",
            "model": "browser-probe-model",
            "usage": {"input_tokens": 16, "output_tokens": 1},
            "output": [
                {
                    "type": "function_call",
                    "name": "probe_stop",
                    "arguments": '{"ok":true}',
                }
            ],
        }
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_core_credentials(
                "agents",
                secret="probe-secret",
                origin="https://api.openai.com",
                home=home,
            )
            transport = _Transport([_response(response)])
            result = _session(_browser_agent_configuration(), home, transport).run_browser_agent()

        self.assertIs(result.outcome, ProbeOutcome.PASSED)
        self.assertIsInstance(result.details, AgentConfigurationProbeDetails)
        details = cast(AgentConfigurationProbeDetails, result.details)
        self.assertEqual(details.role, "browser-agent")
        self.assertEqual(details.request_kind, "browser-agent-tool")
        self.assertTrue(details.image_input)
        self.assertTrue(details.tool_decision)
        self.assertEqual(details.image_count, 1)
        self.assertEqual(details.tool_count, 1)
        self.assertTrue(details.tool_decision_parseable)
        self.assertFalse(details.sends_user_literature)
        self.assertFalse(details.sends_page_content)
        self.assertFalse(details.sends_pdf)
        self.assertTrue(details.may_consume_quota)
        self.assertFalse(result.persisted)
        self.assertEqual(len(transport.calls), 1)
        request = transport.calls[0]["request"]
        self.assertIsInstance(request, TransportRequest)
        body = json.loads(cast(bytes, cast(TransportRequest, request).body))
        serialized = json.dumps(body, separators=(",", ":"))
        self.assertIn("probe_stop", serialized)
        self.assertIn("synthetic", serialized)
        self.assertNotIn("Literature", serialized)
        self.assertNotIn("PDF", serialized)
        self.assertNotIn("page content", serialized)
        self.assertLess(len(cast(bytes, cast(TransportRequest, request).body)), 8_000)

    def test_browser_agent_probe_skips_before_transport_when_role_is_unconfigured(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            transport = _Transport([])
            result = _session(_analysis_configuration(), home, transport).run_browser_agent()

        self.assertIs(result.outcome, ProbeOutcome.SKIPPED)
        self.assertFalse(result.local_ready)
        self.assertEqual(result.failure_code, "browser-agent-not-ready")
        self.assertIsInstance(result.details, AgentConfigurationProbeDetails)
        details = cast(AgentConfigurationProbeDetails, result.details)
        self.assertEqual(details.role, "browser-agent")
        self.assertEqual(details.request_kind, "browser-agent-tool")
        self.assertEqual(transport.calls, [])

    def test_browser_agent_probe_classifies_authentication_and_tool_contract_failures(self) -> None:
        responses = (
            (_response({}, status=401), "agent-authentication"),
            (
                _response(
                    {
                        "id": "resp_browser_probe",
                        "object": "response",
                        "status": "completed",
                        "model": "browser-probe-model",
                        "usage": {"input_tokens": 16, "output_tokens": 1},
                        "output": [
                            {
                                "type": "function_call",
                                "name": "other_tool",
                                "arguments": '{"ok":true}',
                            }
                        ],
                    }
                ),
                "browser-agent-probe-contract",
            ),
        )
        for response, failure_code in responses:
            with (
                self.subTest(failure_code=failure_code),
                tempfile.TemporaryDirectory() as temporary,
            ):
                home = Path(temporary)
                set_core_credentials(
                    "agents",
                    secret="probe-secret",
                    origin="https://api.openai.com",
                    home=home,
                )
                result = _session(
                    _browser_agent_configuration(),
                    home,
                    _Transport([response]),
                ).run_browser_agent()
            self.assertIs(result.outcome, ProbeOutcome.FAILED)
            self.assertEqual(result.failure_code, failure_code)
            self.assertIsInstance(result.details, AgentConfigurationProbeDetails)
            self.assertEqual(
                cast(AgentConfigurationProbeDetails, result.details).role, "browser-agent"
            )

    def test_llm_probe_uses_production_adapter_with_one_minimal_non_literature_request(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_core_credentials(
                "agents",
                secret="probe-secret",
                origin="https://api.openai.com",
                home=home,
            )
            response = {
                "id": "resp_probe",
                "object": "response",
                "status": "completed",
                "model": "probe-model",
                "usage": {"input_tokens": 8, "output_tokens": 1},
                "output": [
                    {
                        "id": "msg_probe",
                        "type": "message",
                        "status": "completed",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "output_text",
                                "text": '{"ok":true}',
                                "annotations": [],
                            }
                        ],
                    }
                ],
            }
            transport = _Transport([_response(response)])
            result = _session(_analysis_configuration(), home, transport).run_agents()

        self.assertIs(result.outcome, ProbeOutcome.PASSED)
        self.assertIsInstance(result.details, AgentConfigurationProbeDetails)
        details = cast(AgentConfigurationProbeDetails, result.details)
        self.assertFalse(details.sends_user_literature)
        self.assertTrue(details.may_consume_quota)
        self.assertFalse(result.persisted)
        self.assertEqual(len(transport.calls), 1)
        request = transport.calls[0]["request"]
        self.assertIsInstance(request, TransportRequest)
        request = cast(TransportRequest, request)
        self.assertEqual(request.url, "https://api.openai.com/v1/responses")
        body = json.loads(cast(bytes, request.body))
        serialized = json.dumps(body, separators=(",", ":"))
        self.assertIn("sciretriever-configuration", serialized)
        self.assertIn('"const":true', serialized)
        self.assertNotIn("Literature", serialized)
        self.assertNotIn("PDF", serialized)
        self.assertLess(len(cast(bytes, request.body)), 1_500)
        self.assertIn(
            ("Authorization", "Bearer probe-secret"),
            cast(tuple[tuple[str, str], ...], transport.calls[0]["headers"]),
        )

    def test_llm_probe_classifies_authentication_protocol_and_contract_failures(self) -> None:
        cases = (
            (_response({}, status=401), "agent-authentication"),
            (_response({"unexpected": True}), "agent-protocol"),
            (
                _response(
                    {
                        "id": "resp_probe",
                        "object": "response",
                        "status": "completed",
                        "model": "probe-model",
                        "usage": {"input_tokens": 8, "output_tokens": 1},
                        "output": [
                            {
                                "id": "msg_probe",
                                "type": "message",
                                "status": "completed",
                                "role": "assistant",
                                "content": [
                                    {
                                        "type": "output_text",
                                        "text": '{"ok":false}',
                                        "annotations": [],
                                    }
                                ],
                            }
                        ],
                    }
                ),
                "analysis-llm-probe-contract",
            ),
        )
        for response, failure_code in cases:
            with (
                self.subTest(failure_code=failure_code),
                tempfile.TemporaryDirectory() as temporary,
            ):
                home = Path(temporary)
                set_core_credentials(
                    "agents",
                    secret="probe-secret",
                    origin="https://api.openai.com",
                    home=home,
                )
                result = _session(
                    _analysis_configuration(),
                    home,
                    _Transport([response]),
                ).run_agents()
            self.assertIs(result.outcome, ProbeOutcome.FAILED)
            self.assertEqual(result.failure_code, failure_code)

    def test_mineru_probe_is_health_only_and_never_submits_or_uploads_a_pdf(self) -> None:
        transport = _Transport(
            [
                _response(
                    {
                        "protocol_version": 2,
                        "status": "healthy",
                        "version": "3.4.4",
                    }
                )
            ]
        )
        with tempfile.TemporaryDirectory() as temporary:
            result = _session(
                _mineru_configuration(),
                Path(temporary),
                transport,
            ).run_mineru()

        self.assertIs(result.outcome, ProbeOutcome.PASSED)
        self.assertIsInstance(result.details, MinerUConfigurationProbeDetails)
        details = cast(MinerUConfigurationProbeDetails, result.details)
        self.assertFalse(details.uploaded_pdf)
        self.assertFalse(result.persisted)
        self.assertEqual(len(transport.calls), 1)
        request = transport.calls[0]["request"]
        self.assertIsInstance(request, TransportRequest)
        request = cast(TransportRequest, request)
        self.assertEqual(
            (request.method, request.url, request.body),
            ("GET", "http://127.0.0.1:8000/health", None),
        )

    def test_mineru_probe_classifies_status_and_protocol_failures(self) -> None:
        cases = (
            (_response({}, status=403), "mineru-status-invalid"),
            (
                _response(
                    {
                        "protocol_version": 1,
                        "status": "healthy",
                        "version": "3.4.4",
                    }
                ),
                "mineru-protocol-invalid",
            ),
        )
        for response, failure_code in cases:
            with (
                self.subTest(failure_code=failure_code),
                tempfile.TemporaryDirectory() as temporary,
            ):
                result = _session(
                    _mineru_configuration(),
                    Path(temporary),
                    _Transport([response]),
                ).run_mineru()
            self.assertIs(result.outcome, ProbeOutcome.FAILED)
            self.assertEqual(result.failure_code, failure_code)


if __name__ == "__main__":
    unittest.main()
