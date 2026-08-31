from __future__ import annotations

import tempfile
import unittest
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any, cast
from unittest import mock

from sciretriever.configuration import (
    ConfigurationProbePort,
    load_credentials,
    parse_configuration,
    set_credentials,
)
from sciretriever.metadata.probe import (
    MetadataProbeEvidence,
    MetadataProbeFailure,
)
from sciretriever.metadata.providers.arxiv import ArxivAdapter
from sciretriever.metadata.providers.core import CoreAdapter
from sciretriever.metadata.providers.crossref import CrossrefAdapter
from sciretriever.metadata.providers.datacite import DataCiteAdapter
from sciretriever.metadata.providers.elsevier import ElsevierScopusAdapter
from sciretriever.metadata.providers.europe_pmc import EuropePmcAdapter
from sciretriever.metadata.providers.openalex import OpenAlexAdapter
from sciretriever.metadata.providers.opencitations import OpenCitationsAdapter
from sciretriever.metadata.providers.semantic_scholar import SemanticScholarAdapter
from sciretriever.metadata.providers.springer import SpringerMetaV2Adapter
from sciretriever.metadata.providers.web_of_science import (
    WebOfScienceExpandedAdapter,
    WebOfScienceStarterAdapter,
)
from sciretriever.metadata.registry import (
    METADATA_PROVIDER_ORDER,
    MetadataAssemblyDependencies,
    MetadataRegistryError,
    build_metadata_probe_registry,
    build_metadata_registry,
)
from sciretriever.model.access import TransportRequest
from sciretriever.model.configuration import (
    Configuration,
    ProbeOutcome,
    ProviderCapability,
    ProviderName,
)
from sciretriever.model.primitives import ObservationId, ProvenanceId, UtcTimestamp
from sciretriever.network.admission import AccessCoordinator
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import ResolvedDestination

_SECRET = "E11-METADATA-PROBE-SECRET-SENTINEL"
_ADAPTER_TYPES = (
    WebOfScienceStarterAdapter,
    WebOfScienceExpandedAdapter,
    CrossrefAdapter,
    SemanticScholarAdapter,
    ArxivAdapter,
    OpenAlexAdapter,
    EuropePmcAdapter,
    ElsevierScopusAdapter,
    SpringerMetaV2Adapter,
    DataCiteAdapter,
    CoreAdapter,
    OpenCitationsAdapter,
)


@contextmanager
def _probe_methods_must_not_run() -> Iterator[None]:
    with ExitStack() as stack:
        for adapter_type in _ADAPTER_TYPES:
            stack.enter_context(
                mock.patch.object(
                    adapter_type,
                    "probe_metadata",
                    side_effect=AssertionError("registry construction must not probe"),
                )
            )
        yield None


class _NeverResolver:
    def __init__(self) -> None:
        self.calls = 0

    def resolve(self, hostname: str) -> tuple[str, ...]:
        self.calls += 1
        raise AssertionError(f"probe registry construction must not resolve {hostname!r}")


class _NeverTransport:
    def __init__(self) -> None:
        self.calls = 0

    def send(
        self,
        request: TransportRequest,
        destination: ResolvedDestination,
        *,
        headers: tuple[tuple[str, str], ...],
        request_target_renderer: object,
        connect_timeout_seconds: float,
        read_timeout_seconds: float,
        tls_server_hostname: str | None,
        cancel_event: object | None,
    ) -> object:
        del (
            request,
            destination,
            headers,
            request_target_renderer,
            connect_timeout_seconds,
            read_timeout_seconds,
            tls_server_hostname,
            cancel_event,
        )
        self.calls += 1
        raise AssertionError("probe registry construction must not send HTTP")

    def close(self) -> None:
        pass


class _ForbiddenFactory:
    def __init__(self, name: str) -> None:
        self.name = name
        self.calls = 0

    def __call__(self) -> object:
        self.calls += 1
        raise AssertionError(f"probe registry construction called {self.name}")


def _configuration(
    *,
    providers: tuple[str, ...] = (),
    product: str | None = "expanded",
    crossref_mode: str | None = "polite",
) -> Configuration:
    lines = [
        "[sources.metadata]",
        'mode = "custom"',
        "providers = [" + ", ".join(f'"{provider}"' for provider in providers) + "]",
        "limit = 17",
    ]
    if product is not None:
        lines.extend(
            (
                "[sources.metadata.web-of-science]",
                f'product = "{product}"',
                'database = "WOS"',
                'edition = "core"',
            )
        )
    if crossref_mode is not None:
        lines.extend(
            (
                "[sources.metadata.crossref]",
                f'mode = "{crossref_mode}"',
            )
        )
        if crossref_mode == "polite":
            lines.append('mailto = "probe-fixture@example.invalid"')
    return parse_configuration("\n".join(lines) + "\n")


def _full_credentials(home: Path) -> object:
    for provider, fields in (
        ("web-of-science", {"api_key": f"{_SECRET}-wos"}),
        ("semantic-scholar", {"api_key": f"{_SECRET}-semantic"}),
        ("openalex", {"api_key": f"{_SECRET}-openalex"}),
        (
            "elsevier",
            {
                "api_key": f"{_SECRET}-elsevier",
                "institution_token": f"{_SECRET}-institution",
            },
        ),
        ("springer", {"api_key": f"{_SECRET}-springer"}),
        ("core", {"api_key": f"{_SECRET}-core"}),
        ("opencitations", {"access_token": f"{_SECRET}-opencitations"}),
    ):
        set_credentials(provider, fields, home=home)
    return load_credentials(home=home)


def _dependencies(
    *,
    forbidden_factories: bool = False,
) -> tuple[
    MetadataAssemblyDependencies,
    HttpClient,
    _NeverResolver,
    _NeverTransport,
    tuple[_ForbiddenFactory, ...],
]:
    resolver = _NeverResolver()
    transport = _NeverTransport()
    coordinator = AccessCoordinator(clock=lambda: 42.0)
    client = HttpClient(
        resolver=resolver,
        transport=cast(Any, transport),
        coordinator=coordinator,
        clock=lambda: 42.0,
        sleeper=lambda _seconds: None,
    )
    factories = (
        _ForbiddenFactory("observation ID"),
        _ForbiddenFactory("provenance ID"),
        _ForbiddenFactory("clock"),
    )
    if forbidden_factories:
        observation = cast(Any, factories[0])
        provenance = cast(Any, factories[1])
        clock = cast(Any, factories[2])
    else:

        def observation() -> ObservationId:
            return ObservationId("00000001-0000-4000-8000-000000000000")

        def provenance() -> ProvenanceId:
            return ProvenanceId("00000002-0000-4000-8000-000000000000")

        def clock() -> UtcTimestamp:
            return UtcTimestamp("2026-08-12T00:00:00Z")

    return (
        MetadataAssemblyDependencies(
            http_client=client,
            access_coordinator=coordinator,
            observation_id_factory=observation,
            provenance_id_factory=provenance,
            clock=clock,
        ),
        client,
        resolver,
        transport,
        factories,
    )


class MetadataProbeRegistryTests(unittest.TestCase):
    def test_all_ready_providers_register_in_fixed_order_without_io_or_factories(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            credentials = _full_credentials(Path(temporary))
            dependencies, client, resolver, transport, factories = _dependencies(
                forbidden_factories=True
            )
            self.addCleanup(client.close)

            with _probe_methods_must_not_run():
                registry = build_metadata_probe_registry(
                    _configuration(providers=()),
                    credentials,  # type: ignore[arg-type]
                    dependencies,
                )
                rebuilt = build_metadata_probe_registry(
                    _configuration(providers=()),
                    credentials,  # type: ignore[arg-type]
                    dependencies,
                )

        expected = tuple(ProviderName(provider) for provider in METADATA_PROVIDER_ORDER)
        self.assertEqual(tuple(item.provider for item in registry.registrations), expected)
        self.assertEqual(tuple(item.provider for item in rebuilt.registrations), expected)
        self.assertEqual(
            registry.supported_capabilities,
            frozenset((provider, ProviderCapability.METADATA) for provider in expected),
        )
        self.assertIsInstance(registry, ConfigurationProbePort)
        self.assertEqual(resolver.calls, 0)
        self.assertEqual(transport.calls, 0)
        self.assertTrue(all(factory.calls == 0 for factory in factories))
        for rendered in (repr(registry), repr(registry.registrations)):
            self.assertNotIn(_SECRET, rendered)
            self.assertNotIn("https://", rendered)
            self.assertNotIn("2026-", rendered)

    def test_disabled_ready_providers_are_registered_for_named_tests(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            credentials = _full_credentials(Path(temporary))
            dependencies, client, _resolver, _transport, _factories = _dependencies()
            self.addCleanup(client.close)
            configuration = _configuration(providers=())

            probes = build_metadata_probe_registry(
                configuration,
                credentials,  # type: ignore[arg-type]
                dependencies,
            )
            business = build_metadata_registry(configuration, credentials, dependencies)  # type: ignore[arg-type]

        self.assertEqual(
            tuple(item.provider.value for item in probes.registrations),
            METADATA_PROVIDER_ORDER,
        )
        self.assertEqual(business.registrations, ())
        self.assertEqual(business.topic_search_ports, ())

    def test_missing_ordinary_parameters_and_credentials_are_not_registered(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            credentials = load_credentials(home=Path(temporary))
            dependencies, client, resolver, transport, factories = _dependencies(
                forbidden_factories=True
            )
            self.addCleanup(client.close)
            registry = build_metadata_probe_registry(
                _configuration(product=None, crossref_mode=None),
                credentials,
                dependencies,
            )

        self.assertEqual(
            tuple(item.provider.value for item in registry.registrations),
            (
                "crossref",
                "semantic-scholar",
                "arxiv",
                "openalex",
                "europe-pmc",
                "datacite",
                "core",
                "opencitations",
            ),
        )
        self.assertEqual(
            registry.supported_capabilities,
            frozenset(
                (ProviderName(provider), ProviderCapability.METADATA)
                for provider in METADATA_PROVIDER_ORDER
            ),
        )
        self.assertEqual(resolver.calls, 0)
        self.assertEqual(transport.calls, 0)
        self.assertTrue(all(factory.calls == 0 for factory in factories))

    def test_web_of_science_product_and_crossref_pool_follow_ordinary_configuration(self) -> None:
        for product, expected_type in (
            ("starter", WebOfScienceStarterAdapter),
            ("expanded", WebOfScienceExpandedAdapter),
        ):
            for mode, expected_mailto in (
                ("anonymous", None),
                ("polite", "probe-fixture@example.invalid"),
            ):
                with self.subTest(product=product, mode=mode):
                    with tempfile.TemporaryDirectory() as temporary:
                        credentials = _full_credentials(Path(temporary))
                        dependencies, client, _resolver, _transport, _factories = _dependencies()
                        self.addCleanup(client.close)
                        registry = build_metadata_probe_registry(
                            _configuration(product=product, crossref_mode=mode),
                            credentials,  # type: ignore[arg-type]
                            dependencies,
                        )
                    adapters = {
                        item.provider: cast(Any, item.adapter) for item in registry.registrations
                    }
                    self.assertIs(
                        type(adapters[ProviderName.WEB_OF_SCIENCE]),
                        expected_type,
                    )
                    self.assertEqual(
                        adapters[ProviderName.CROSSREF]._mailto,
                        expected_mailto,
                    )

    def test_all_adapters_share_the_injected_http_client_and_coordinator(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            credentials = _full_credentials(Path(temporary))
            dependencies, client, _resolver, _transport, _factories = _dependencies()
            self.addCleanup(client.close)
            registry = build_metadata_probe_registry(
                _configuration(),
                credentials,  # type: ignore[arg-type]
                dependencies,
            )

        self.assertIs(client._coordinator, dependencies.access_coordinator)
        for registration in registry.registrations:
            adapter = cast(Any, registration.adapter)
            with self.subTest(provider=registration.provider.value):
                self.assertIs(adapter._http_client, client)
                self.assertIs(adapter._access_coordinator, dependencies.access_coordinator)
                self.assertEqual(registration.capability, ProviderCapability.METADATA)
        opencitations = next(
            item for item in registry.registrations if item.provider is ProviderName.OPENCITATIONS
        )
        self.assertIs(type(opencitations.adapter), OpenCitationsAdapter)

    def test_registry_is_the_configuration_probe_port_and_validates_evidence_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            credentials = _full_credentials(Path(temporary))
            dependencies, client, _resolver, _transport, _factories = _dependencies()
            self.addCleanup(client.close)
            registry = build_metadata_probe_registry(
                _configuration(),
                credentials,  # type: ignore[arg-type]
                dependencies,
            )
        registration = next(
            item for item in registry.registrations if item.provider is ProviderName.CROSSREF
        )
        with mock.patch.object(
            CrossrefAdapter,
            "probe_metadata",
            return_value=MetadataProbeEvidence(provider_name="crossref"),
        ) as probe:
            result = registry.probe(ProviderName.CROSSREF, ProviderCapability.METADATA)
        probe.assert_called_once_with()
        self.assertEqual(result.outcome, ProbeOutcome.PASSED)
        self.assertEqual(
            (
                result.network_reachable,
                result.authentication_accepted,
                result.api_product_usable,
                result.minimal_response_parseable,
            ),
            (True, True, True, True),
        )

        with mock.patch.object(
            type(registration.adapter),
            "probe_metadata",
            return_value=MetadataProbeEvidence(provider_name="arxiv"),
        ):
            invalid = registry.probe(ProviderName.CROSSREF, ProviderCapability.METADATA)
        self.assertEqual(invalid.outcome, ProbeOutcome.FAILED)
        self.assertEqual(invalid.failure_code, "metadata-probe-invalid-result")

    def test_probe_failures_are_stable_results_without_private_diagnostics(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            credentials = _full_credentials(Path(temporary))
            dependencies, client, _resolver, _transport, _factories = _dependencies()
            self.addCleanup(client.close)
            registry = build_metadata_probe_registry(
                _configuration(),
                credentials,  # type: ignore[arg-type]
                dependencies,
            )

        failure = MetadataProbeFailure(
            "metadata-probe-authentication",
            network_reachable=True,
            authentication_accepted=False,
            api_product_usable=None,
            minimal_response_parseable=None,
        )
        with mock.patch.object(CrossrefAdapter, "probe_metadata", side_effect=failure):
            translated = registry.probe(
                ProviderName.CROSSREF,
                ProviderCapability.METADATA,
            )
        self.assertEqual(translated.outcome, ProbeOutcome.FAILED)
        self.assertEqual(translated.failure_code, "metadata-probe-authentication")
        self.assertEqual(
            (
                translated.network_reachable,
                translated.authentication_accepted,
                translated.api_product_usable,
                translated.minimal_response_parseable,
            ),
            (True, False, None, None),
        )

        private = f"{_SECRET} https://provider.invalid/private raw-response"
        with mock.patch.object(
            CrossrefAdapter,
            "probe_metadata",
            side_effect=RuntimeError(private),
        ):
            stabilized = registry.probe(
                ProviderName.CROSSREF,
                ProviderCapability.METADATA,
            )
        self.assertEqual(stabilized.failure_code, "metadata-probe-failed")
        self.assertNotIn(_SECRET, repr(stabilized))
        self.assertNotIn("provider.invalid", repr(stabilized))

    def test_duplicate_wrong_name_missing_port_and_network_bypass_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            credentials = _full_credentials(Path(temporary))
            dependencies, client, _resolver, _transport, _factories = _dependencies()
            self.addCleanup(client.close)
            registry = build_metadata_probe_registry(
                _configuration(),
                credentials,  # type: ignore[arg-type]
                dependencies,
            )

        first = registry.registrations[0]
        with self.assertRaises(MetadataRegistryError) as duplicate:
            replace(registry, registrations=(first, first))
        self.assertEqual(duplicate.exception.code, "duplicate-probe-registration")

        adapter = cast(Any, first.adapter)
        with mock.patch.object(
            type(adapter), "provider_name", new_callable=mock.PropertyMock
        ) as name:
            name.return_value = "crossref"
            with self.assertRaises(MetadataRegistryError) as mismatch:
                replace(registry, registrations=(first,))
        self.assertEqual(mismatch.exception.code, "probe-provider-mismatch")

        with mock.patch.object(type(adapter), "probe_metadata", None):
            with self.assertRaises(MetadataRegistryError) as missing_port:
                replace(registry, registrations=(first,))
        self.assertEqual(missing_port.exception.code, "probe-port-missing")

        original_client = adapter._http_client
        try:
            adapter._http_client = object()
            with self.assertRaises(MetadataRegistryError) as bypass:
                replace(registry, registrations=(first,))
        finally:
            adapter._http_client = original_client
        self.assertEqual(bypass.exception.code, "network-bypass")
        for error in (
            duplicate.exception,
            mismatch.exception,
            missing_port.exception,
            bypass.exception,
        ):
            rendered = f"{error!s} {error!r}"
            self.assertNotIn(_SECRET, rendered)
            self.assertNotIn("https://", rendered)


if __name__ == "__main__":
    unittest.main()
