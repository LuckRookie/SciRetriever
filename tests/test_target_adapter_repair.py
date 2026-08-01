from __future__ import annotations

import unittest
from dataclasses import dataclass

import anyio

from sciretriever.adapters.acquisition import RaceToken
from sciretriever.adapters.budgets import HostBudgetManager, InvalidHostname, canonical_hostname
from sciretriever.adapters.collection import collect_citations, collect_metadata
from sciretriever.adapters.production import (
    ACQUISITION_PROVIDERS,
    CITATION_PROVIDERS,
    METADATA_PROVIDERS,
    ProviderDependencies,
    ProviderRuntimeConfig,
    build_provider_registry,
)
from sciretriever.adapters.providers import (
    CitationClient,
    MetadataClient,
    MetadataProviderAdapter,
    VendorCitationRecord,
    VendorMetadataRecord,
)
from sciretriever.adapters.registry import Capability, ProviderRegistry
from sciretriever.collection.ports import (
    CitationDiscoveryRequest,
    MetadataDiscoveryPort,
    MetadataDiscoveryRequest,
    ProviderDiscoveryResult,
)
from sciretriever.content.ports import (
    TransportRequest,
    TransportResponse,
)
from sciretriever.kernel.enums import CitationDirection
from sciretriever.kernel.ids import WorkId

UUID_A = "00000000-0000-4000-8000-000000000001"


@dataclass(frozen=True, slots=True)
class FakeMetadataClient:
    provider: str

    def search(self, request: MetadataDiscoveryRequest) -> tuple[VendorMetadataRecord, ...]:
        return (
            VendorMetadataRecord(
                f"{self.provider}-record",
                request.query,
                ("Ada",),
                2026,
                (("doi", f"10.1/{self.provider}"),),
                "abstract",
            ),
        )


@dataclass(frozen=True, slots=True)
class FakeCitationClient:
    provider: str

    def expand(self, request: CitationDiscoveryRequest) -> tuple[VendorCitationRecord, ...]:
        _ = request
        return (VendorCitationRecord("doi", f"10.1/{self.provider}"),)


class FakeTransport:
    def execute(self, request: TransportRequest) -> TransportResponse:
        return TransportResponse(200, request.url, (), b"%PDF-1.7")


class SpoofingProvider:
    def search(self, request: MetadataDiscoveryRequest) -> ProviderDiscoveryResult:
        _ = request
        return ProviderDiscoveryResult("spoofed", (), None)


class TargetAdapterRepairTests(unittest.TestCase):
    def test_production_registry_contains_complete_supported_inventory(self) -> None:
        metadata: dict[str, MetadataClient] = {
            name: FakeMetadataClient(name) for name in METADATA_PROVIDERS
        }
        citations: dict[str, CitationClient] = {
            name: FakeCitationClient(name) for name in CITATION_PROVIDERS
        }
        registry = build_provider_registry(
            ProviderRuntimeConfig(sci_hub_enabled=True, timeout_seconds=30, max_asset_bytes=100),
            ProviderDependencies(metadata, citations, {}, FakeTransport()),
        )

        self.assertEqual(registry.names(Capability.METADATA), tuple(sorted(METADATA_PROVIDERS)))
        self.assertEqual(registry.names(Capability.CITATION), tuple(sorted(CITATION_PROVIDERS)))
        self.assertEqual(
            registry.names(Capability.ASSET_RESOLVER),
            tuple(sorted((*ACQUISITION_PROVIDERS, "sci-hub"))),
        )
        self.assertEqual(
            registry.names(Capability.ASSET_FETCHER),
            tuple(sorted((*ACQUISITION_PROVIDERS, "sci-hub"))),
        )

    def test_factory_failure_is_ordered_and_does_not_abort_sibling(self) -> None:
        good = FakeMetadataClient("good")
        registry = ProviderRegistry()
        registry.register_metadata("bad", lambda: self._raise_factory_error())
        registry.register_metadata(
            "good",
            lambda: MetadataProviderAdapter("good", good),
        )

        results = collect_metadata(
            registry,
            ("bad", "good"),
            MetadataDiscoveryRequest("query", None, None, 10),
        )

        self.assertEqual(tuple(result.provider for result in results), ("bad", "good"))
        self.assertEqual(results[0].failure.code, "provider-unavailable")
        self.assertEqual(results[1].observations[0].provider, "good")

    def test_spoofed_provider_identity_becomes_configured_failure(self) -> None:
        registry = ProviderRegistry().register_metadata("configured", lambda: SpoofingProvider())

        result = collect_metadata(
            registry,
            ("configured",),
            MetadataDiscoveryRequest("query", None, None, 1),
        )[0]

        self.assertEqual(result.provider, "configured")
        self.assertEqual(result.observations, ())
        self.assertEqual(result.failure.code, "provider-invalid-response")

    def test_each_production_metadata_and_citation_adapter_translates_neutral_records(self) -> None:
        metadata = {name: FakeMetadataClient(name) for name in METADATA_PROVIDERS}
        citations = {name: FakeCitationClient(name) for name in CITATION_PROVIDERS}
        registry = build_provider_registry(
            ProviderRuntimeConfig(False, 30, 100),
            ProviderDependencies(metadata, citations, {}, FakeTransport()),
        )

        metadata_results = collect_metadata(
            registry,
            METADATA_PROVIDERS,
            MetadataDiscoveryRequest("query", None, None, 20),
        )
        citation_results = collect_citations(
            registry,
            CITATION_PROVIDERS,
            CitationDiscoveryRequest(WorkId(UUID_A), CitationDirection.REFERENCES, 20),
        )

        self.assertEqual(
            tuple(result.observations[0].provider for result in metadata_results),
            METADATA_PROVIDERS,
        )
        self.assertEqual(
            tuple(result.observations[0].provider for result in citation_results),
            CITATION_PROVIDERS,
        )

    def test_dns_equivalent_hosts_share_canonical_budget_key(self) -> None:
        self.assertEqual(canonical_hostname("Example.COM"), "example.com")
        self.assertEqual(canonical_hostname("example.com."), "example.com")
        self.assertEqual(canonical_hostname("BÜCHER.example"), "xn--bcher-kva.example")
        self.assertEqual(canonical_hostname("xn--bcher-kva.example"), "xn--bcher-kva.example")
        for value in ("", ".", "example..com", "example.com.."):
            with self.subTest(value=value), self.assertRaises(InvalidHostname):
                canonical_hostname(value)

    def test_dns_equivalent_hosts_cannot_exceed_one_concurrent_operation(self) -> None:
        async def scenario() -> int:
            manager = HostBudgetManager(1)
            token = RaceToken(anyio.current_time() + 5)
            active = 0
            peak = 0
            first_entered = anyio.Event()
            release = anyio.Event()

            async def operation(current: RaceToken) -> str:
                nonlocal active, peak
                _ = current
                active += 1
                peak = max(peak, active)
                first_entered.set()
                await release.wait()
                active -= 1
                return "ok"

            async with anyio.create_task_group() as tasks:
                tasks.start_soon(manager.run, "Example.COM", token, operation)
                await first_entered.wait()
                tasks.start_soon(manager.run, "example.com.", token, operation)
                await anyio.sleep(0)
                release.set()
            return peak

        self.assertEqual(anyio.run(scenario), 1)

    @staticmethod
    def _raise_factory_error() -> MetadataDiscoveryPort:
        raise OSError("secret factory detail")


if __name__ == "__main__":
    unittest.main()
