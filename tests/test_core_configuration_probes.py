from __future__ import annotations

import json
import tempfile
import threading
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, cast

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
    Configuration,
    LLMConfigurationProbeDetails,
    MinerUConfigurationProbeDetails,
    ProbeOutcome,
)
from sciretriever.network.admission import AccessCoordinator
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
        [analysis]
        provider = "openai"
        protocol = "{protocol}"
        base_url = "https://api.openai.com/v1"
        model = "probe-model"
        context_window_tokens = 128000
        authentication = "api-key"
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
    return ProductionConfigurationProbeSession(
        configuration=configuration,
        credentials=credentials,
        status=configuration_status(configuration, credentials=credentials),
        probe_port=cast(Any, _EmptyProbeRegistry()),
        access_coordinator=coordinator,
        http_client=http_client,
        browser_status=browser_access_status(
            configuration,
            home=home,
            python_dependency_available=True,
        ),
        browser_probe_port=cast(Any, _EmptyBrowserProbePort()),
    )


class CoreConfigurationProbeTests(unittest.TestCase):
    def test_llm_probe_uses_production_adapter_with_one_minimal_non_literature_request(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_core_credentials(
                "llm",
                secret="probe-secret",
                origin="https://api.openai.com",
                home=home,
            )
            response = {
                "id": "resp_probe",
                "object": "response",
                "status": "completed",
                "model": "probe-model",
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
            result = _session(_analysis_configuration(), home, transport).run_llm()

        self.assertIs(result.outcome, ProbeOutcome.PASSED)
        self.assertIsInstance(result.details, LLMConfigurationProbeDetails)
        details = cast(LLMConfigurationProbeDetails, result.details)
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
            (_response({}, status=401), "analysis-llm-authentication"),
            (_response({"unexpected": True}), "analysis-llm-protocol"),
            (
                _response(
                    {
                        "id": "resp_probe",
                        "object": "response",
                        "status": "completed",
                        "model": "probe-model",
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
                    "llm",
                    secret="probe-secret",
                    origin="https://api.openai.com",
                    home=home,
                )
                result = _session(
                    _analysis_configuration(),
                    home,
                    _Transport([response]),
                ).run_llm()
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
