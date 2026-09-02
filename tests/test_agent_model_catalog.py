from __future__ import annotations

import json
import threading
import unittest
from collections.abc import Iterable
from dataclasses import dataclass
from typing import cast
from unittest.mock import Mock, patch

from sciretriever.agents.api import AgentFailure, AgentModelCatalog, AgentModelSummary
from sciretriever.agents.providers.models import AgentModelCatalogClient
from sciretriever.bootstrap import fetch_agent_models
from sciretriever.model.access import Header, TransportRequest
from sciretriever.model.configuration import (
    AgentProtocol,
    AgentReasoningEffort,
)
from sciretriever.network.admission import AccessCoordinator
from sciretriever.network.http import HttpClient

_SECRET = "MODEL-CATALOG-SECRET-SENTINEL"


class _Resolver:
    def resolve(self, hostname: str) -> tuple[str, ...]:
        del hostname
        return ("93.184.216.34",)


@dataclass
class _RawResponse:
    status: int
    headers: tuple[Header, ...]
    body: bytes | Iterable[bytes]
    closed: bool = False

    def close(self) -> None:
        self.closed = True


class _Transport:
    def __init__(self, responses: Iterable[_RawResponse]) -> None:
        self.responses = list(responses)
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
        return self.responses.pop(0)


def _client(payload: object, *, status: int = 200) -> tuple[HttpClient, _Transport]:
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
    transport = _Transport([_RawResponse(status=status, headers=(), body=body)])
    return (
        HttpClient(
            resolver=_Resolver(),
            transport=transport,
            coordinator=AccessCoordinator(),
        ),
        transport,
    )


class AgentModelCatalogTests(unittest.TestCase):
    def test_openai_catalog_reads_only_model_id_through_origin_bound_get(self) -> None:
        client, transport = _client(
            {
                "object": "list",
                "data": [
                    {"id": "gpt-fixture", "object": "model", "owned_by": "fixture"},
                    {"id": "vision-name-is-not-proof", "object": "model"},
                ],
            }
        )
        catalog_client = AgentModelCatalogClient(
            http_client=client,
            protocol=AgentProtocol.OPENAI_RESPONSES,
            base_url="https://api.openai.com/v1",
            api_key=_SECRET,
            provider_name="openai",
        )

        catalog = catalog_client.list_models()

        self.assertEqual(
            [item.model for item in catalog.models],
            [
                "gpt-fixture",
                "vision-name-is-not-proof",
            ],
        )
        self.assertTrue(all(item.image_input is None for item in catalog.models))
        self.assertTrue(all(item.context_window_tokens is None for item in catalog.models))
        request = cast(TransportRequest, transport.calls[0]["request"])
        self.assertEqual(request.method, "GET")
        self.assertEqual(request.url, "https://api.openai.com/v1/models")
        self.assertIsNone(request.body)
        headers = cast(tuple[tuple[str, str], ...], transport.calls[0]["headers"])
        self.assertIn(("Authorization", f"Bearer {_SECRET}"), headers)
        self.assertNotIn(_SECRET, repr(request) + repr(catalog_client) + repr(catalog))

    def test_anthropic_catalog_accepts_reported_context_vision_and_effort_hints(self) -> None:
        client, transport = _client(
            {
                "data": [
                    {
                        "id": "claude-fixture",
                        "display_name": "Claude Fixture",
                        "max_input_tokens": 200_000,
                        "max_tokens": 64_000,
                        "capabilities": {
                            "image_input": {"supported": True},
                            "effort": {
                                "supported": True,
                                "low": {"supported": True},
                                "medium": {"supported": True},
                                "high": {"supported": True},
                                "xhigh": {"supported": True},
                                "max": {"supported": True},
                            },
                        },
                    }
                ],
                "has_more": True,
                "first_id": "claude-fixture",
                "last_id": "claude-fixture",
            }
        )
        catalog_client = AgentModelCatalogClient(
            http_client=client,
            protocol=AgentProtocol.ANTHROPIC_MESSAGES,
            base_url="https://api.anthropic.com/v1",
            api_key=_SECRET,
            provider_name="anthropic",
        )

        catalog = catalog_client.list_models()

        self.assertTrue(catalog.truncated)
        self.assertEqual(len(catalog.models), 1)
        summary = catalog.models[0]
        self.assertEqual(summary.display_name, "Claude Fixture")
        self.assertEqual(summary.context_window_tokens, 200_000)
        self.assertEqual(summary.max_output_tokens, 64_000)
        self.assertTrue(summary.image_input)
        self.assertEqual(
            summary.reasoning_efforts,
            (
                AgentReasoningEffort.LOW,
                AgentReasoningEffort.MEDIUM,
                AgentReasoningEffort.HIGH,
                AgentReasoningEffort.XHIGH,
                AgentReasoningEffort.MAX,
            ),
        )
        self.assertTrue(summary.reasoning_efforts_reported)
        headers = cast(tuple[tuple[str, str], ...], transport.calls[0]["headers"])
        self.assertIn(("X-Api-Key", _SECRET), headers)
        self.assertIn(("Anthropic-Version", "2023-06-01"), headers)

    def test_catalog_rejects_duplicate_or_malformed_provider_claims(self) -> None:
        cases = (
            {
                "object": "list",
                "data": [{"id": "same"}, {"id": "same"}],
            },
            {
                "data": [
                    {
                        "id": "claude-fixture",
                        "capabilities": {"image_input": {"supported": "yes"}},
                    }
                ],
                "has_more": False,
            },
        )
        for index, payload in enumerate(cases):
            with self.subTest(index=index):
                client, _transport = _client(payload)
                protocol = (
                    AgentProtocol.OPENAI_RESPONSES
                    if index == 0
                    else AgentProtocol.ANTHROPIC_MESSAGES
                )
                catalog_client = AgentModelCatalogClient(
                    http_client=client,
                    protocol=protocol,
                    base_url=(
                        "https://api.openai.com/v1"
                        if index == 0
                        else "https://api.anthropic.com/v1"
                    ),
                    api_key=_SECRET,
                    provider_name="fixture",
                )
                with self.assertRaises(AgentFailure) as caught:
                    catalog_client.list_models()
                self.assertEqual(caught.exception.failure.code, "agent-protocol")
                self.assertNotIn(_SECRET, repr(caught.exception))

    def test_catalog_is_bounded_to_one_hundred_models_and_reports_truncation(self) -> None:
        client, _transport = _client(
            {
                "object": "list",
                "data": [{"id": f"fixture-{index:03d}"} for index in range(101)],
            }
        )
        catalog_client = AgentModelCatalogClient(
            http_client=client,
            protocol=AgentProtocol.OPENAI_RESPONSES,
            base_url="https://api.openai.com/v1",
            api_key=_SECRET,
            provider_name="openai",
        )

        catalog = catalog_client.list_models()

        self.assertEqual(len(catalog.models), 100)
        self.assertTrue(catalog.truncated)
        self.assertEqual(catalog.models[-1].model, "fixture-099")

    def test_oversize_catalog_response_has_a_stable_secret_free_failure(self) -> None:
        client, _transport = _client(b"x" * 1_048_577)
        catalog_client = AgentModelCatalogClient(
            http_client=client,
            protocol=AgentProtocol.OPENAI_RESPONSES,
            base_url="https://api.openai.com/v1",
            api_key=_SECRET,
            provider_name="openai",
        )

        with self.assertRaises(AgentFailure) as caught:
            catalog_client.list_models()

        self.assertEqual(caught.exception.failure.code, "agent-response-budget")
        self.assertNotIn(_SECRET, repr(caught.exception))

    def test_catalog_does_not_follow_redirects_and_stabilizes_authentication(self) -> None:
        for status, expected in ((302, "agent-redirect"), (401, "agent-authentication")):
            with self.subTest(status=status):
                client, transport = _client(b"PRIVATE-RESPONSE-SENTINEL", status=status)
                catalog_client = AgentModelCatalogClient(
                    http_client=client,
                    protocol=AgentProtocol.OPENAI_CHAT_COMPLETIONS,
                    base_url="https://api.openai.com/v1",
                    api_key=_SECRET,
                    provider_name="openai",
                )
                with self.assertRaises(AgentFailure) as caught:
                    catalog_client.list_models()
                self.assertEqual(caught.exception.failure.code, expected)
                self.assertEqual(caught.exception.http_status, status)
                self.assertEqual(len(transport.calls), 1)
                self.assertNotIn("PRIVATE-RESPONSE-SENTINEL", repr(caught.exception))

    def test_bootstrap_entry_uses_one_shared_network_and_always_closes_it(self) -> None:
        catalog = AgentModelCatalog(models=(AgentModelSummary(model="fixture-model"),))
        http_client = Mock()
        catalog_client = Mock()
        catalog_client.list_models.return_value = catalog

        with (
            patch(
                "sciretriever.bootstrap.probes._new_shared_network",
                return_value=(Mock(), Mock(), http_client),
            ) as new_network,
            patch(
                "sciretriever.agents.providers.models.AgentModelCatalogClient",
                return_value=catalog_client,
            ) as client_type,
            patch(
                "sciretriever.bootstrap.probes.load_credentials",
                side_effect=AssertionError("model discovery must not read credentials"),
            ) as load_credentials,
        ):
            result = fetch_agent_models(
                provider_name="fixture-service",
                api=AgentProtocol.OPENAI_CHAT_COMPLETIONS,
                base_url="https://llm.example.invalid/v1",
                api_key=_SECRET,
            )

        self.assertEqual(result, catalog)
        new_network.assert_called_once_with()
        load_credentials.assert_not_called()
        client_type.assert_called_once_with(
            http_client=http_client,
            protocol=AgentProtocol.OPENAI_CHAT_COMPLETIONS,
            base_url="https://llm.example.invalid/v1",
            api_key=_SECRET,
            provider_name="fixture-service",
        )
        catalog_client.list_models.assert_called_once_with()
        http_client.close.assert_called_once_with()

    def test_bootstrap_entry_closes_shared_network_when_catalog_fails(self) -> None:
        http_client = Mock()
        catalog_client = Mock()
        catalog_client.list_models.side_effect = RuntimeError("offline fixture failure")
        with (
            patch(
                "sciretriever.bootstrap.probes._new_shared_network",
                return_value=(Mock(), Mock(), http_client),
            ),
            patch(
                "sciretriever.agents.providers.models.AgentModelCatalogClient",
                return_value=catalog_client,
            ),
            self.assertRaisesRegex(RuntimeError, "offline fixture failure"),
        ):
            fetch_agent_models(
                provider_name="openai",
                api=AgentProtocol.OPENAI_RESPONSES,
                base_url="https://api.openai.com/v1",
                api_key=_SECRET,
            )

        http_client.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
