from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from typing import Mapping
import unittest

import anyio

from sciretriever.adapters.acquisition import CandidateRace, NeutralAssetFetcher, RaceToken
from sciretriever.adapters.collection import collect_metadata
from sciretriever.adapters.registry import Capability, ProviderRegistry, UnsupportedCapability
from sciretriever.adapters.providers import MetadataProviderAdapter, VendorMetadataRecord
from sciretriever.adapters.transport import BoundedHttpsTransportAdapter, TransportFailure
from sciretriever.collection.model import (
    MetadataDiscoveryRequest, MetadataObservation, ProviderDiscoveryResult,
)
from sciretriever.content.model import AssetCandidate, BoundedByteStream, Header, TransportRequest
from sciretriever.kernel.contracts import Identifier
from sciretriever.kernel.enums import AssetRole
from sciretriever.kernel.errors import Action, FailureEvidence, Reason
from sciretriever.network.secure import DialResponse, SecureHttpsTransport


class FakeMetadataProvider:
    def __init__(self, name: str, *, fails: bool = False) -> None:
        self.name = name
        self.calls = 0
        self._fails = fails

    def search(self, request: MetadataDiscoveryRequest) -> ProviderDiscoveryResult:
        self.calls += 1
        if self._fails:
            return ProviderDiscoveryResult(
                self.name, (), FailureEvidence(
                    "provider-unavailable", Reason("provider request failed"),
                    Action("Retry the provider request."), True,
                ),
            )
        observation = MetadataObservation(
            self.name, f"{self.name}-1", request.query, (), None,
            (Identifier("doi", f"10.1/{self.name}"),), None,
        )
        return ProviderDiscoveryResult(self.name, (observation,), None)


@dataclass(frozen=True, slots=True)
class FakeFetcher:
    values: dict[str, BoundedByteStream]

    def fetch(self, candidate: AssetCandidate) -> BoundedByteStream:
        return self.values[candidate.provider]


class SecretFailingMetadataClient:
    def search(self, request: MetadataDiscoveryRequest) -> tuple[VendorMetadataRecord, ...]:
        _ = request
        raise OSError("https://secret.example?api_key=do-not-leak")


class FakeDialResponse:
    def __init__(self, status: int, headers: tuple[tuple[str, str], ...], body: bytes) -> None:
        self.status = status
        self._headers = headers
        self._body = BytesIO(body)

    def getheaders(self) -> list[tuple[str, str]]:
        return list(self._headers)

    def read(self, n: int = -1) -> bytes:
        return self._body.read(n)

    def close(self) -> None:
        self._body.close()


class FakeDialer:
    def __init__(self, responses: list[DialResponse]) -> None:
        self.responses = responses
        self.headers: list[dict[str, str]] = []

    def get(
        self, hostname: str, address: str, port: int, target: str, *,
        timeout: float, headers: Mapping[str, str],
    ) -> DialResponse:
        _ = (hostname, address, port, target, timeout)
        self.headers.append(dict(headers))
        return self.responses.pop(0)


class TargetAdapterTests(unittest.TestCase):
    def test_registry_rejects_unsupported_capability_before_provider_request(self) -> None:
        provider = FakeMetadataProvider("metadata-only")
        registry = ProviderRegistry().register_metadata("metadata-only", lambda: provider)

        with self.assertRaises(UnsupportedCapability):
            registry.citation("metadata-only")

        self.assertEqual(provider.calls, 0)

    def test_metadata_partial_failure_preserves_sibling_and_configured_order(self) -> None:
        first = FakeMetadataProvider("first", fails=True)
        second = FakeMetadataProvider("second")
        registry = (
            ProviderRegistry()
            .register_metadata("first", lambda: first)
            .register_metadata("second", lambda: second)
        )

        results = collect_metadata(
            registry, ("first", "second"),
            MetadataDiscoveryRequest("query", None, None, 10),
        )

        self.assertEqual(tuple(result.provider for result in results), ("first", "second"))
        failure = results[0].failure
        self.assertIsNotNone(failure)
        assert failure is not None
        self.assertEqual(failure.code, "provider-unavailable")
        self.assertEqual(results[1].observations[0].title, "query")

    def test_fetcher_falls_back_in_candidate_order(self) -> None:
        candidates = (
            AssetCandidate("empty", AssetRole.PRIMARY_PDF, "https://one.example/a", ()),
            AssetCandidate("valid", AssetRole.PRIMARY_PDF, "https://two.example/a", ()),
        )
        fetcher = NeutralAssetFetcher(FakeFetcher({
            "empty": BoundedByteStream((), "application/pdf", candidates[0].locator, 0),
            "valid": BoundedByteStream((b"%PDF-1.7",), "application/pdf", candidates[1].locator, 8),
        }))

        result = fetcher.fetch_first(candidates)

        self.assertEqual(result.final_locator, candidates[1].locator)

    def test_race_loser_late_result_cannot_publish(self) -> None:
        published: list[str] = []
        release_loser = anyio.Event()
        winner_ready = anyio.Event()

        async def run() -> None:
            race = CandidateRace[str](deadline_seconds=5)

            async def winner(token: RaceToken) -> str:
                self.assertFalse(token.cancelled)
                winner_ready.set()
                return "winner"

            async def loser(token: RaceToken) -> str:
                await release_loser.wait()
                self.assertTrue(token.cancelled)
                return "loser"

            result = await race.run(
                (("winner", winner), ("loser", loser)), published.append,
            )
            self.assertEqual(result, "winner")
            release_loser.set()
            await anyio.sleep(0)

        anyio.run(run)
        self.assertEqual(published, ["winner"])

    def test_registry_inventory_is_explicit_and_sorted(self) -> None:
        registry = (
            ProviderRegistry()
            .register_metadata("zeta", lambda: FakeMetadataProvider("zeta"))
            .register_metadata("alpha", lambda: FakeMetadataProvider("alpha"))
        )

        self.assertEqual(registry.names(Capability.METADATA), ("alpha", "zeta"))

    def test_provider_failure_does_not_expose_raw_exception_or_credential(self) -> None:
        adapter = MetadataProviderAdapter("safe-provider", SecretFailingMetadataClient())

        result = adapter.search(MetadataDiscoveryRequest("query", None, None, 1))

        failure = result.failure
        self.assertIsNotNone(failure)
        assert failure is not None
        rendered = f"{failure.code} {failure.reason} {failure.action}"
        self.assertNotIn("secret.example", rendered)
        self.assertNotIn("api_key", rendered)
        self.assertNotIn("do-not-leak", rendered)

    def test_transport_rejects_private_dns_with_stable_sanitized_failure(self) -> None:
        transport = BoundedHttpsTransportAdapter(SecureHttpsTransport(
            resolver=lambda host: ("127.0.0.1",),
            dialer=FakeDialer([]),
        ))

        with self.assertRaises(TransportFailure) as raised:
            transport.execute(TransportRequest(
                "GET", "https://secret.example/path?token=value", (), None, 2, 20,
            ))

        self.assertEqual(str(raised.exception), "secure-transport-rejected")
        self.assertNotIn("secret.example", str(raised.exception))
        self.assertNotIn("token", str(raised.exception))

    def test_cross_origin_redirect_strips_sensitive_headers(self) -> None:
        dialer = FakeDialer([
            FakeDialResponse(302, (("location", "https://other.example/final"),), b""),
            FakeDialResponse(200, (("content-type", "application/pdf"),), b"pdf"),
        ])
        transport = BoundedHttpsTransportAdapter(SecureHttpsTransport(
            resolver=lambda host: ("93.184.216.34",), dialer=dialer,
        ))

        response = transport.execute(TransportRequest(
            "GET", "https://first.example/start",
            (Header("Authorization", "Bearer secret"), Header("X-Trace", "safe")),
            None, 2, 20,
        ))

        self.assertEqual(response.body, b"pdf")
        self.assertIn("Authorization", dialer.headers[0])
        self.assertNotIn("Authorization", dialer.headers[1])
        self.assertEqual(dialer.headers[1]["X-Trace"], "safe")

    def test_transport_enforces_request_body_cap_below_transport_cap(self) -> None:
        dialer = FakeDialer([
            FakeDialResponse(200, (("content-type", "application/pdf"),), b"oversize"),
        ])
        transport = BoundedHttpsTransportAdapter(SecureHttpsTransport(
            max_bytes=100, resolver=lambda host: ("93.184.216.34",), dialer=dialer,
        ))

        with self.assertRaises(TransportFailure) as raised:
            transport.execute(TransportRequest(
                "GET", "https://example.test/a", (), None, 2, 4,
            ))

        self.assertEqual(str(raised.exception), "response-body-too-large")


if __name__ == "__main__":
    unittest.main()
