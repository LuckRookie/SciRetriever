from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from typing import Any, cast
from unittest import mock

from sciretriever.configuration import (
    ConfigurationError,
    load_credentials,
    parse_configuration,
    set_credentials,
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
    MetadataAssemblyDependencies,
    MetadataCapability,
    MetadataProviderStatus,
    MetadataRegistryError,
    build_metadata_registry,
    metadata_provider_statuses,
    validate_metadata_provider_matrix,
)
from sciretriever.model.access import TransportRequest
from sciretriever.model.configuration import (
    Configuration,
    CrossrefAccessMode,
    WebOfScienceProduct,
)
from sciretriever.model.primitives import ObservationId, ProvenanceId, UtcTimestamp
from sciretriever.network.admission import AccessCoordinator, AccessPolicy
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import ResolvedDestination

_SECRET = "M10-METADATA-SECRET-SENTINEL"
_SEARCH_PROVIDERS = (
    "web-of-science",
    "crossref",
    "semantic-scholar",
    "arxiv",
    "openalex",
    "europe-pmc",
    "elsevier",
    "springer",
    "datacite",
    "core",
)
_ALL_PROVIDERS = _SEARCH_PROVIDERS + ("opencitations",)


class _NeverResolver:
    def resolve(self, hostname: str) -> tuple[str, ...]:
        raise AssertionError(f"registry assembly must not resolve {hostname!r}")


class _NeverTransport:
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
        raise AssertionError("registry assembly must not send HTTP")

    def close(self) -> None:
        pass


def _configuration(
    *,
    providers: tuple[str, ...] = _ALL_PROVIDERS,
    product: str | None = "expanded",
    database: str | None = "WOS",
    edition: str | None = "core",
    crossref_mode: str | None = "polite",
    mailto: str | None = "fixture-contact@example.invalid",
    scan_limit: int | None = 37,
) -> Configuration:
    lines: list[str] = []
    if scan_limit is not None:
        lines.extend(("[discovery]", f"metadata_scan_limit = {scan_limit}"))
    lines.extend(
        (
            "[sources.metadata]",
            "providers = [" + ", ".join(f'"{provider}"' for provider in providers) + "]",
        )
    )
    if product is not None or database is not None or edition is not None:
        lines.append("[sources.metadata.web-of-science]")
        if product is not None:
            lines.append(f'product = "{product}"')
        if database is not None:
            lines.append(f'database = "{database}"')
        if edition is not None:
            lines.append(f'edition = "{edition}"')
    if crossref_mode is not None or mailto is not None:
        lines.append("[sources.metadata.crossref]")
        if crossref_mode is not None:
            lines.append(f'mode = "{crossref_mode}"')
        if mailto is not None:
            lines.append(f'mailto = "{mailto}"')
    return parse_configuration("\n".join(lines) + "\n")


def _dependencies() -> tuple[MetadataAssemblyDependencies, HttpClient]:
    coordinator = AccessCoordinator(clock=lambda: 100.0)
    client = HttpClient(
        resolver=_NeverResolver(),
        transport=cast(Any, _NeverTransport()),
        coordinator=coordinator,
        clock=lambda: 100.0,
        sleeper=lambda _seconds: None,
    )
    dependencies = MetadataAssemblyDependencies(
        http_client=client,
        access_coordinator=coordinator,
        observation_id_factory=lambda: ObservationId("00000001-0000-4000-8000-000000000000"),
        provenance_id_factory=lambda: ProvenanceId("00000002-0000-4000-8000-000000000000"),
        clock=lambda: UtcTimestamp("2026-08-11T00:00:00Z"),
    )
    return dependencies, client


def _full_credentials(home: Path) -> Any:
    for provider, fields in (
        ("web-of-science", {"api_key": f"{_SECRET}-wos"}),
        ("semantic-scholar", {"api_key": f"{_SECRET}-s2"}),
        ("openalex", {"api_key": f"{_SECRET}-openalex"}),
        (
            "elsevier",
            {
                "api_key": f"{_SECRET}-elsevier",
                "institution_token": f"{_SECRET}-institution",
            },
        ),
        (
            "springer",
            {
                "api_key": f"{_SECRET}-springer",
                "api_metric": f"{_SECRET}-metric",
            },
        ),
        ("core", {"api_key": f"{_SECRET}-core"}),
        ("opencitations", {"access_token": f"{_SECRET}-oc"}),
    ):
        set_credentials(provider, fields, home=home)
    return load_credentials(home=home)


class OrdinaryMetadataConfigurationTests(unittest.TestCase):
    def test_configuration_closes_only_required_metadata_ordinary_fields(self) -> None:
        value = _configuration()
        metadata = value.sources.metadata
        self.assertEqual(tuple(item.value for item in metadata.providers), _ALL_PROVIDERS)
        self.assertEqual(value.discovery.metadata_scan_limit, 37)
        self.assertEqual(
            metadata.web_of_science.product,
            WebOfScienceProduct.EXPANDED,
        )
        self.assertEqual(metadata.web_of_science.database, "WOS")
        self.assertEqual(metadata.web_of_science.edition, "core")
        self.assertEqual(metadata.crossref.mode, CrossrefAccessMode.POLITE)
        self.assertEqual(metadata.crossref.mailto, "fixture-contact@example.invalid")
        serialized = value.model_dump_json()
        for forbidden in (
            "endpoint",
            "api_key",
            "access_token",
            "api_metric",
            "credential_alias",
            "extra",
            _SECRET,
        ):
            self.assertNotIn(forbidden, serialized)

    def test_unknown_duplicate_unbounded_and_illegal_combinations_fail_closed(self) -> None:
        invalid = (
            '[sources.metadata]\nproviders = ["unknown"]\n',
            '[sources.metadata]\nproviders = ["crossref", "crossref"]\n',
            "[discovery]\nmetadata_scan_limit = 0\n",
            "[discovery]\nmetadata_scan_limit = 1.5\n",
            (
                '[sources.metadata]\nproviders = ["crossref"]\n'
                '[sources.metadata.crossref]\nmode = "polite"\n'
            ),
            (
                '[sources.metadata]\nproviders = ["crossref"]\n'
                '[sources.metadata.crossref]\nmode = "anonymous"\n'
                'mailto = "fixture@example.invalid"\n'
            ),
            (
                '[sources.metadata]\nproviders = ["crossref"]\n'
                '[sources.metadata.crossref]\nmode = "plus"\n'
            ),
            ('[sources.metadata]\nproviders = ["crossref"]\nlookup = true\n'),
            (
                '[sources.metadata]\nproviders = ["crossref"]\n'
                'endpoint = "https://example.invalid"\n'
            ),
            (
                '[sources.metadata]\nproviders = ["web-of-science"]\n'
                "[sources.metadata.web-of-science]\n"
                'product = "starter"\n'
                'database = "WOS"\n'
                f'api_key = "{_SECRET}"\n'
            ),
            (
                '[sources.metadata]\nproviders = ["web-of-science"]\n'
                "[sources.metadata.web-of-science]\n"
                'product = "starter"\n'
                'database = "WOS\\nunsafe"\n'
            ),
        )
        for payload in invalid:
            with self.subTest(payload=payload):
                with self.assertRaises(ConfigurationError):
                    parse_configuration(payload)

    def test_credentials_reject_control_characters_at_the_single_secret_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with self.assertRaises(ConfigurationError) as caught:
                set_credentials(
                    "web-of-science",
                    {"api_key": f"{_SECRET}\runsafe"},
                    home=home,
                )
            self.assertEqual(str(caught.exception), "credentials value is invalid")
            self.assertNotIn(_SECRET, str(caught.exception))
            self.assertFalse((home / ".sciretriever" / "credentials.toml").exists())

        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            directory = home / ".sciretriever"
            directory.mkdir(mode=0o700)
            path = directory / "credentials.toml"
            path.write_text(
                f'[web-of-science]\napi_key = "{_SECRET}\\nunsafe"\n',
                encoding="utf-8",
            )
            path.chmod(0o600)
            with self.assertRaises(ConfigurationError) as caught:
                load_credentials(home=home)
            self.assertEqual(str(caught.exception), "credentials value is invalid")
            self.assertNotIn(_SECRET, str(caught.exception))


class MetadataProviderMatrixTests(unittest.TestCase):
    def test_full_fake_configuration_builds_exact_deterministic_capability_matrix(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            credentials = _full_credentials(Path(temporary))
            config = _configuration()
            dependencies, client = _dependencies()
            self.addCleanup(client.close)

            registry = build_metadata_registry(config, credentials, dependencies)
            rebuilt = build_metadata_registry(config, credentials, dependencies)

        self.assertEqual(
            tuple(port.provider_name for port in registry.topic_search_ports),
            _SEARCH_PROVIDERS,
        )
        self.assertEqual(
            tuple(port.provider_name for port in registry.lookup_ports),
            _ALL_PROVIDERS,
        )
        self.assertEqual(
            tuple(port.provider_name for port in registry.reference_query_ports),
            (
                "web-of-science",
                "semantic-scholar",
                "openalex",
                "europe-pmc",
                "datacite",
                "core",
                "opencitations",
            ),
        )
        self.assertEqual(
            tuple((item.provider_name, item.scan_limit) for item in registry.topic_limits),
            tuple((provider, 37) for provider in _SEARCH_PROVIDERS),
        )
        self.assertEqual(
            tuple((item.provider_name, item.scan_limit) for item in registry.citation_limits),
            tuple(
                (provider, 37)
                for provider in (
                    "web-of-science",
                    "semantic-scholar",
                    "openalex",
                    "europe-pmc",
                    "datacite",
                    "core",
                    "opencitations",
                )
            ),
        )
        self.assertEqual(
            tuple(port.provider_name for port in rebuilt.topic_search_ports),
            _SEARCH_PROVIDERS,
        )
        self.assertFalse(
            any(
                status.provider_name == "opencitations"
                and MetadataCapability.TOPIC_SEARCH in status.capabilities
                for status in registry.statuses
            )
        )

    def test_discovery_limits_follow_configuration_order_and_filter_capabilities(
        self,
    ) -> None:
        selected = (
            "opencitations",
            "crossref",
            "openalex",
            "arxiv",
            "semantic-scholar",
        )
        config = _configuration(
            providers=selected,
            product=None,
            database=None,
            edition=None,
            crossref_mode="anonymous",
            mailto=None,
            scan_limit=23,
        )
        with tempfile.TemporaryDirectory() as temporary:
            credentials = load_credentials(home=Path(temporary))
            dependencies, client = _dependencies()
            self.addCleanup(client.close)
            registry = build_metadata_registry(config, credentials, dependencies)

        self.assertEqual(
            tuple(item.provider_name for item in registry.topic_limits),
            ("crossref", "openalex", "arxiv", "semantic-scholar"),
        )
        self.assertEqual(
            tuple(item.provider_name for item in registry.citation_limits),
            ("opencitations", "openalex", "semantic-scholar"),
        )
        self.assertTrue(all(item.scan_limit == 23 for item in registry.citation_limits))
        self.assertIn("citation_query=", repr(registry))
        for rendered in (repr(registry), repr(registry.citation_limits)):
            self.assertNotIn(_SECRET, rendered)

    def test_opencitations_only_requires_and_receives_citation_scan_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            credentials = load_credentials(home=Path(temporary))
            dependencies, client = _dependencies()
            self.addCleanup(client.close)
            registry = build_metadata_registry(
                _configuration(
                    providers=("opencitations",),
                    product=None,
                    database=None,
                    edition=None,
                    crossref_mode=None,
                    mailto=None,
                    scan_limit=11,
                ),
                credentials,
                dependencies,
            )
            with self.assertRaises(MetadataRegistryError) as caught:
                build_metadata_registry(
                    _configuration(
                        providers=("opencitations",),
                        product=None,
                        database=None,
                        edition=None,
                        crossref_mode=None,
                        mailto=None,
                        scan_limit=None,
                    ),
                    credentials,
                    dependencies,
                )

        self.assertEqual(registry.topic_limits, ())
        self.assertEqual(
            tuple((item.provider_name, item.scan_limit) for item in registry.citation_limits),
            (("opencitations", 11),),
        )
        self.assertEqual(caught.exception.code, "missing-scan-limit")
        self.assertNotIn(_SECRET, repr(caught.exception))

    def test_production_types_parameters_credentials_and_shared_network_are_exact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            credentials = _full_credentials(Path(temporary))
            dependencies, client = _dependencies()
            self.addCleanup(client.close)
            registry = build_metadata_registry(_configuration(), credentials, dependencies)

        adapters: dict[str, Any] = {
            item.provider_name: item.adapter for item in registry.registrations
        }
        expected_types = {
            "web-of-science": WebOfScienceExpandedAdapter,
            "crossref": CrossrefAdapter,
            "semantic-scholar": SemanticScholarAdapter,
            "arxiv": ArxivAdapter,
            "openalex": OpenAlexAdapter,
            "europe-pmc": EuropePmcAdapter,
            "elsevier": ElsevierScopusAdapter,
            "springer": SpringerMetaV2Adapter,
            "datacite": DataCiteAdapter,
            "core": CoreAdapter,
            "opencitations": OpenCitationsAdapter,
        }
        self.assertEqual(
            {provider: type(adapter) for provider, adapter in adapters.items()},
            expected_types,
        )
        self.assertEqual(adapters["web-of-science"]._database, "WOS")  # type: ignore[attr-defined]
        self.assertEqual(adapters["web-of-science"]._edition, "core")  # type: ignore[attr-defined]
        self.assertEqual(  # type: ignore[attr-defined]
            adapters["crossref"]._mailto,
            "fixture-contact@example.invalid",
        )
        self.assertEqual(  # type: ignore[attr-defined]
            adapters["web-of-science"]._api_key,
            f"{_SECRET}-wos",
        )
        self.assertEqual(  # type: ignore[attr-defined]
            adapters["elsevier"]._api_key,
            f"{_SECRET}-elsevier",
        )
        self.assertEqual(  # type: ignore[attr-defined]
            adapters["elsevier"]._institution_token,
            f"{_SECRET}-institution",
        )
        self.assertEqual(  # type: ignore[attr-defined]
            adapters["springer"]._api_key,
            f"{_SECRET}-springer",
        )
        self.assertEqual(  # type: ignore[attr-defined]
            adapters["semantic-scholar"]._api_key,
            f"{_SECRET}-s2",
        )
        self.assertEqual(  # type: ignore[attr-defined]
            adapters["opencitations"]._token,
            f"{_SECRET}-oc",
        )
        self.assertEqual(
            repr(adapters["elsevier"]),
            "<ElsevierScopusAdapter api_key_configured=True institution_token_configured=True>",
        )
        self.assertNotIn(_SECRET, repr(adapters["elsevier"]))
        for registration in registry.registrations:
            adapter = cast(Any, registration.adapter)
            with self.subTest(provider=registration.provider_name):
                self.assertIs(adapter._http_client, dependencies.http_client)  # type: ignore[attr-defined]
                self.assertIs(  # type: ignore[attr-defined]
                    adapter._access_coordinator,
                    dependencies.access_coordinator,
                )
                self.assertIsInstance(adapter._access_policy, AccessPolicy)  # type: ignore[attr-defined]
                self.assertFalse(any("limiter" in name for name in vars(adapter)))
        for rendered in (repr(registry), repr(registry.statuses), repr(registry.registrations)):
            self.assertNotIn(_SECRET, rendered)
            self.assertNotIn("institution", rendered)
            self.assertNotIn("metric", rendered)

    def test_anonymous_and_optional_credentials_are_ready_without_silent_fallback(self) -> None:
        config = _configuration(
            providers=(
                "crossref",
                "semantic-scholar",
                "openalex",
                "core",
                "opencitations",
            ),
            product=None,
            database=None,
            edition=None,
            crossref_mode="anonymous",
            mailto=None,
        )
        with tempfile.TemporaryDirectory() as temporary:
            credentials = load_credentials(home=Path(temporary))
            dependencies, client = _dependencies()
            self.addCleanup(client.close)
            registry = build_metadata_registry(config, credentials, dependencies)

        adapters: dict[str, Any] = {
            item.provider_name: item.adapter for item in registry.registrations
        }
        self.assertIsNone(adapters["crossref"]._mailto)  # type: ignore[attr-defined]
        self.assertIsNone(adapters["semantic-scholar"]._api_key)  # type: ignore[attr-defined]
        self.assertIsNone(adapters["openalex"]._api_key)  # type: ignore[attr-defined]
        self.assertIsNone(adapters["core"]._api_key)  # type: ignore[attr-defined]
        self.assertIsNone(adapters["opencitations"]._token)  # type: ignore[attr-defined]
        self.assertEqual(
            tuple(port.provider_name for port in registry.topic_search_ports),
            ("crossref", "semantic-scholar", "openalex", "core"),
        )

    def test_web_of_science_product_changes_reference_capability_without_duck_typing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_credentials("web-of-science", {"api_key": _SECRET}, home=home)
            credentials = load_credentials(home=home)
            dependencies, client = _dependencies()
            self.addCleanup(client.close)
            starter = build_metadata_registry(
                _configuration(
                    providers=("web-of-science",),
                    product="starter",
                    crossref_mode=None,
                    mailto=None,
                ),
                credentials,
                dependencies,
            )

        self.assertIsInstance(starter.registrations[0].adapter, WebOfScienceStarterAdapter)
        self.assertEqual(starter.reference_query_ports, ())
        self.assertEqual(
            starter.statuses[0].capabilities,
            (MetadataCapability.TOPIC_SEARCH, MetadataCapability.LOOKUP),
        )


class MetadataReadinessFailureTests(unittest.TestCase):
    def _assert_failure(
        self,
        config: Configuration,
        credentials: Any,
        expected_code: str,
    ) -> None:
        dependencies, client = _dependencies()
        self.addCleanup(client.close)
        with self.assertRaises(MetadataRegistryError) as caught:
            build_metadata_registry(config, credentials, dependencies)
        self.assertEqual(caught.exception.code, expected_code)
        self.assertNotIn(_SECRET, str(caught.exception))
        self.assertNotIn(_SECRET, repr(caught.exception))

    def test_enabled_required_credentials_and_ordinary_parameters_fail_before_calls(self) -> None:
        cases = (
            (
                _configuration(
                    providers=("web-of-science",),
                    product=None,
                    database=None,
                    edition=None,
                    crossref_mode=None,
                    mailto=None,
                ),
                "missing-ordinary-parameter",
            ),
            (
                _configuration(
                    providers=("web-of-science",),
                    crossref_mode=None,
                    mailto=None,
                ),
                "missing-required-credential",
            ),
            (
                _configuration(
                    providers=("elsevier",),
                    product=None,
                    database=None,
                    edition=None,
                    crossref_mode=None,
                    mailto=None,
                ),
                "missing-required-credential",
            ),
            (
                _configuration(
                    providers=("springer",),
                    product=None,
                    database=None,
                    edition=None,
                    crossref_mode=None,
                    mailto=None,
                ),
                "missing-required-credential",
            ),
            (
                _configuration(
                    providers=("crossref",),
                    product=None,
                    database=None,
                    edition=None,
                    crossref_mode=None,
                    mailto=None,
                ),
                "missing-ordinary-parameter",
            ),
            (
                _configuration(
                    providers=("crossref",),
                    product=None,
                    database=None,
                    edition=None,
                    scan_limit=None,
                    crossref_mode="anonymous",
                    mailto=None,
                ),
                "missing-scan-limit",
            ),
        )
        for config, expected_code in cases:
            with self.subTest(expected_code=expected_code):
                with tempfile.TemporaryDirectory() as temporary:
                    credentials = load_credentials(home=Path(temporary))
                    self._assert_failure(config, credentials, expected_code)

    def test_disabled_unready_provider_is_not_constructed_or_added_to_exhaustion_set(self) -> None:
        config = _configuration(
            providers=("crossref",),
            product=None,
            database=None,
            edition=None,
            crossref_mode="anonymous",
            mailto=None,
        )
        with tempfile.TemporaryDirectory() as temporary:
            credentials = load_credentials(home=Path(temporary))
            dependencies, client = _dependencies()
            self.addCleanup(client.close)
            registry = build_metadata_registry(config, credentials, dependencies)

        self.assertEqual(
            tuple(item.provider_name for item in registry.registrations),
            ("crossref",),
        )
        self.assertEqual(
            tuple(item.provider_name for item in registry.topic_limits),
            ("crossref",),
        )
        web_of_science = next(
            item for item in registry.statuses if item.provider_name == "web-of-science"
        )
        self.assertFalse(web_of_science.enabled)
        self.assertFalse(web_of_science.ready)

    def test_invalid_static_matrix_fails_closed_before_assembly(self) -> None:
        config = _configuration(
            providers=("crossref",),
            product=None,
            database=None,
            edition=None,
            crossref_mode="anonymous",
            mailto=None,
        )
        with tempfile.TemporaryDirectory() as temporary:
            credentials = load_credentials(home=Path(temporary))
            statuses = metadata_provider_statuses(config, credentials)

        opencitations_index = next(
            index
            for index, status in enumerate(statuses)
            if status.provider_name == "opencitations"
        )
        opencitations = statuses[opencitations_index]
        mutations: tuple[tuple[MetadataProviderStatus, str], ...] = (
            (
                replace(
                    opencitations,
                    capabilities=(
                        MetadataCapability.TOPIC_SEARCH,
                        MetadataCapability.LOOKUP,
                        MetadataCapability.REFERENCE_QUERY,
                    ),
                ),
                "capability-mismatch",
            ),
            (replace(opencitations, access_policy=None), "missing-access-policy"),
            (replace(opencitations, uses_shared_network=False), "network-bypass"),
            (replace(opencitations, uses_private_limiter=True), "private-limiter-forbidden"),
        )
        for mutated, expected_code in mutations:
            candidate = list(statuses)
            candidate[opencitations_index] = mutated
            with self.subTest(expected_code=expected_code):
                with self.assertRaises(MetadataRegistryError) as caught:
                    validate_metadata_provider_matrix(tuple(candidate))
                self.assertEqual(caught.exception.code, expected_code)

        duplicate = statuses[:-1] + (statuses[0],)
        with self.assertRaises(MetadataRegistryError) as caught:
            validate_metadata_provider_matrix(duplicate)
        self.assertEqual(caught.exception.code, "duplicate-provider")

        unknown = statuses[:-1] + (replace(statuses[-1], provider_name="unknown"),)
        with self.assertRaises(MetadataRegistryError) as caught:
            validate_metadata_provider_matrix(unknown)
        self.assertEqual(caught.exception.code, "unknown-provider")

    def test_enabled_provider_without_production_adapter_fails_before_construction(self) -> None:
        config = _configuration(
            providers=("crossref",),
            product=None,
            database=None,
            edition=None,
            crossref_mode="anonymous",
            mailto=None,
        )
        with tempfile.TemporaryDirectory() as temporary:
            credentials = load_credentials(home=Path(temporary))
            statuses = metadata_provider_statuses(config, credentials)
            crossref_index = next(
                index for index, status in enumerate(statuses) if status.provider_name == "crossref"
            )
            unavailable = list(statuses)
            unavailable[crossref_index] = replace(
                statuses[crossref_index],
                production_implementation=None,
                production_available=False,
                ready=False,
                failure_code="missing-production-adapter",
            )
            candidate = tuple(unavailable)
            validate_metadata_provider_matrix(candidate)
            dependencies, client = _dependencies()
            self.addCleanup(client.close)
            with (
                mock.patch(
                    "sciretriever.metadata.registry.metadata_provider_statuses",
                    return_value=candidate,
                ),
                self.assertRaises(MetadataRegistryError) as caught,
            ):
                build_metadata_registry(config, credentials, dependencies)

        self.assertEqual(caught.exception.code, "missing-production-adapter")


if __name__ == "__main__":
    unittest.main()
