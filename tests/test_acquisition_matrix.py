from __future__ import annotations

import tempfile
import threading
import unittest
from dataclasses import replace
from pathlib import Path
from typing import Any, cast
from unittest import mock

from pydantic import ValidationError

from sciretriever.acquisition.authorized import (
    PRODUCTION_AUTHORIZED_PROVIDER_CATALOG,
    UNSUPPORTED_AUTHORIZED_API_PROVIDER_KEYS,
    AuthorizedPdfSource,
)
from sciretriever.acquisition.ports import CandidateKeyTracker
from sciretriever.acquisition.registry import (
    ACQUISITION_PROVIDER_ORDER,
    PRODUCTION_WEB_HOSTS_BY_PROVIDER,
    AcquisitionAssemblyDependencies,
    AcquisitionCapability,
    AcquisitionProviderStatus,
    AcquisitionRegistryError,
    acquisition_provider_statuses,
    build_acquisition_registry,
    production_web_access_profile_resolver,
    validate_acquisition_provider_matrix,
)
from sciretriever.acquisition.routing import (
    AcquisitionRequest,
    build_acquisition_evidence,
)
from sciretriever.acquisition.sources import (
    CONTROLLED_BROWSER_PRODUCTION_READINESS,
    PRODUCTION_BROWSER_RULE_CATALOG,
    ArxivPdfSource,
    ConfiguredSciHubPdfSource,
    DirectPdfSource,
    EuropePmcPdfSource,
    PublicLocatorFetcher,
    UnpaywallPdfSource,
    WebAccessProfileResolver,
)
from sciretriever.configuration import (
    ConfigurationError,
    CredentialLookup,
    credential_status_for,
    load_credentials,
    parse_configuration,
    set_credentials,
)
from sciretriever.literature.content import metadata_sha256
from sciretriever.model.acquisition import AcquisitionPath, AssetHint, AssetHintKind
from sciretriever.model.configuration import CredentialStatus, ProviderName
from sciretriever.model.literature import (
    Identifier,
    Literature,
    LiteratureStatus,
    VersionRole,
)
from sciretriever.model.metadata import (
    LiteratureMetadata,
    MetadataObservation,
)
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.network.admission import AccessCoordinator, AccessScope
from sciretriever.network.browser import BrowserClient
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import normalize_url

_TIME = UtcTimestamp("2026-08-11T00:00:00Z")
_ALL_PROVIDERS = (
    "arxiv",
    "crossref",
    "semantic-scholar",
    "openalex",
    "europe-pmc",
    "unpaywall",
    "elsevier",
    "springer",
    "wiley",
    "datacite",
    "core",
    "sci-hub",
)


def _id(index: int) -> str:
    return f"{index:08d}-0000-4000-8000-000000000000"


class _NeverResolver:
    def resolve(self, hostname: str) -> tuple[str, ...]:
        raise AssertionError(f"registry assembly must not resolve {hostname!r}")


class _NeverTransport:
    def send(self, *args: object, **kwargs: object) -> object:
        del args, kwargs
        raise AssertionError("registry assembly must not send HTTP")

    def close(self) -> None:
        pass


class _ConfiguredLocatorResolver:
    def __init__(self) -> None:
        self.calls = 0

    def resolve(
        self,
        identifiers: tuple[object, ...],
        *,
        cancel_event: threading.Event | None = None,
    ) -> tuple[str, ...]:
        del identifiers, cancel_event
        self.calls += 1
        return ()


def _configuration(
    providers: tuple[str, ...] = (),
    *,
    unpaywall_email: str | None = None,
) -> Any:
    lines = (
        "[sources.acquisition]",
        "providers = [" + ", ".join(f'"{provider}"' for provider in providers) + "]",
    )
    payload = list(lines)
    if unpaywall_email is not None:
        payload.extend(
            (
                "[sources.acquisition.unpaywall]",
                f'contact_email = "{unpaywall_email}"',
            )
        )
    return parse_configuration("\n".join(payload) + "\n")


def _dependencies(
    *,
    coordinator: AccessCoordinator | None = None,
    http_coordinator: AccessCoordinator | None = None,
    configured_resolver: _ConfiguredLocatorResolver | None = None,
    cancel_event: threading.Event | None = None,
    credentials: CredentialLookup | None = None,
) -> tuple[AcquisitionAssemblyDependencies, HttpClient]:
    shared = coordinator or AccessCoordinator(clock=lambda: 100.0)
    client = HttpClient(
        resolver=_NeverResolver(),
        transport=cast(Any, _NeverTransport()),
        coordinator=http_coordinator or shared,
        clock=lambda: 100.0,
        sleeper=lambda _seconds: None,
        max_retries=0,
    )
    dependencies = AcquisitionAssemblyDependencies(
        http_client=client,
        access_coordinator=shared,
        web_access_profile_resolver=WebAccessProfileResolver(),
        provenance_id_factory=lambda: ProvenanceId(_id(900)),
        clock=lambda: _TIME,
        credentials=credentials,
        cancel_event=cancel_event,
        configured_sci_hub_resolver=configured_resolver,
    )
    return dependencies, client


def _literature() -> Literature:
    return Literature(
        literature_id=LiteratureId(_id(1)),
        meta_literature_id=MetaLiteratureId(_id(2)),
        version_role=VersionRole.PUBLISHED,
        metadata=LiteratureMetadata(title="Acquisition matrix fixture"),
        status=LiteratureStatus.UNREVIEWED,
    )


def _observation(index: int, provider_name: str, url: str) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_id(index)),
        provenance=Provenance(
            provenance_id=ProvenanceId(_id(index + 100)),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=provider_name,
            source_record_id=f"record-{index}",
            observed_at=_TIME,
            input_sha256=Sha256("a" * 64),
            parameters_sha256=None,
        ),
        metadata=LiteratureMetadata(title=f"Observation {index}"),
        asset_hints=(AssetHint(url=url, kind=AssetHintKind.DIRECT_FILE),),
    )


def _request(
    observations: tuple[MetadataObservation, ...],
    *,
    identifiers: tuple[Identifier, ...] = (),
) -> AcquisitionRequest:
    literature = _literature()
    if identifiers:
        metadata = literature.metadata.model_copy(update={"identifiers": identifiers})
        literature = literature.model_copy(update={"metadata": metadata})
    from sciretriever.acquisition.ports import AcquisitionExpectedFacts

    return AcquisitionRequest(
        literature=literature,
        expected_facts=AcquisitionExpectedFacts(
            literature_id=literature.literature_id,
            meta_literature_id=literature.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(literature.metadata),
            expected_no_primary_pdf=True,
        ),
        observations=observations,
    )


class OrdinaryAcquisitionConfigurationTests(unittest.TestCase):
    def test_exact_provider_allowlist_preserves_order_and_is_secret_free(self) -> None:
        value = _configuration(
            tuple(reversed(_ALL_PROVIDERS)),
            unpaywall_email="researcher@example.invalid",
        )
        acquisition = value.sources.acquisition
        self.assertEqual(
            tuple(provider.value for provider in acquisition.providers),
            tuple(reversed(_ALL_PROVIDERS)),
        )
        self.assertEqual(
            acquisition.unpaywall.contact_email,
            "researcher@example.invalid",
        )
        # This assertion belongs to the Acquisition configuration boundary.
        # Other accepted responsibility groups (notably ``[parsing]``) may
        # legitimately contain fields such as ``base_url``.
        serialized = acquisition.model_dump_json()
        for forbidden in (
            "endpoint",
            "base_url",
            "resolver",
            "cookie",
            "session",
            "selector",
            "api_key",
        ):
            self.assertNotIn(forbidden, serialized.casefold())
        with self.assertRaises(ValidationError):
            acquisition.providers = ()  # type: ignore[misc]

    def test_unknown_non_acquisition_duplicate_and_private_fields_fail_closed(self) -> None:
        invalid = (
            '[sources.acquisition]\nproviders = ["web-of-science"]\n',
            '[sources.acquisition]\nproviders = ["opencitations"]\n',
            '[sources.acquisition]\nproviders = ["direct"]\n',
            '[sources.acquisition]\nproviders = ["controlled-browser"]\n',
            '[sources.acquisition]\nproviders = ["unknown"]\n',
            '[sources.acquisition]\nproviders = ["arxiv", "arxiv"]\n',
            (
                '[sources.acquisition]\nproviders = ["unpaywall"]\n'
                '[sources.acquisition.unpaywall]\ncontact_email = "not-an-email"\n'
            ),
            (
                '[sources.acquisition]\nproviders = ["sci-hub"]\n'
                '[sources.acquisition.sci-hub]\nendpoint = "https://example.invalid"\n'
            ),
            (
                '[sources.acquisition]\nproviders = ["unpaywall"]\n'
                '[sources.acquisition.unpaywall]\ncontact_email = "fixture@example.invalid"\n'
                'session = "forbidden"\n'
            ),
        )
        for payload in invalid:
            with self.subTest(payload=payload):
                with self.assertRaises(ConfigurationError):
                    parse_configuration(payload)

    def test_sci_hub_credentials_are_not_required_but_resolver_is_not_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            credentials = load_credentials(home=Path(temporary))
        with mock.patch(
            "sciretriever.configuration.load_credentials",
            side_effect=AssertionError("offline status must not read default credentials"),
        ):
            status = credential_status_for(
                "sci-hub",
                "acquisition",
                credentials=credentials,
                supported_capabilities=("acquisition",),
            )
        self.assertEqual(status.status, CredentialStatus.NOT_REQUIRED)
        self.assertEqual(status.fields, ())


class AcquisitionProviderMatrixTests(unittest.TestCase):
    def test_production_web_profiles_are_closed_shared_and_conservative(self) -> None:
        self.assertEqual(
            PRODUCTION_WEB_HOSTS_BY_PROVIDER,
            (
                ("arxiv", ("arxiv.org", "export.arxiv.org")),
                ("europe-pmc", ("europepmc.org", "www.ebi.ac.uk")),
                ("elsevier", ("api.elsevier.com",)),
                (
                    "springer",
                    (
                        "api.springernature.com",
                        "link.springer.com",
                        "www.nature.com",
                    ),
                ),
                ("wiley", ("onlinelibrary.wiley.com", "alm.wiley.com")),
                ("core", ("api.core.ac.uk", "core.ac.uk")),
            ),
        )
        resolver = production_web_access_profile_resolver()
        for first, second, provider_name in (
            ("arxiv.org", "export.arxiv.org", "arxiv"),
            ("europepmc.org", "www.ebi.ac.uk", "europe-pmc"),
            ("api.springernature.com", "link.springer.com", "springer"),
            ("onlinelibrary.wiley.com", "alm.wiley.com", "wiley"),
            ("api.core.ac.uk", "core.ac.uk", "core"),
        ):
            first_scope, first_policy = resolver.resolve(normalize_url(f"https://{first}/"))
            second_scope, second_policy = resolver.resolve(normalize_url(f"https://{second}/"))
            self.assertEqual(first_scope, AccessScope(provider_name, "web"))
            self.assertEqual(second_scope, first_scope)
            self.assertEqual(first_policy, second_policy)
            self.assertEqual(first_policy.max_concurrency, 1)
            self.assertGreaterEqual(first_policy.cooldown_after_completion, 30.0)

        springer_scope, _ = resolver.resolve(
            normalize_url("https://www.nature.com/articles/example.pdf")
        )
        elsevier_scope, _ = resolver.resolve(
            normalize_url("https://api.elsevier.com/content/article/example")
        )
        self.assertNotEqual(springer_scope, elsevier_scope)

        unknown_scope, unknown_policy = resolver.resolve(
            normalize_url("https://repository.example.invalid/paper.pdf")
        )
        self.assertEqual(
            unknown_scope,
            AccessScope("repository.example.invalid", "web"),
        )
        self.assertEqual(unknown_policy.max_concurrency, 1)
        self.assertGreaterEqual(unknown_policy.cooldown_after_completion, 30.0)

    def test_fixed_matrix_has_exact_provider_and_multi_path_mappings(self) -> None:
        configuration = _configuration(
            (),
            unpaywall_email="researcher@example.invalid",
        )
        statuses = acquisition_provider_statuses(
            configuration,
            configured_sci_hub_resolver=_ConfiguredLocatorResolver(),
        )
        self.assertEqual(ACQUISITION_PROVIDER_ORDER, _ALL_PROVIDERS)
        self.assertEqual(tuple(status.provider_name for status in statuses), _ALL_PROVIDERS)
        self.assertNotIn("web-of-science", ACQUISITION_PROVIDER_ORDER)
        self.assertNotIn("opencitations", ACQUISITION_PROVIDER_ORDER)
        self.assertNotIn("direct", ACQUISITION_PROVIDER_ORDER)

        capabilities = {
            status.provider_name: tuple(mapping.capability.value for mapping in status.mappings)
            for status in statuses
        }
        self.assertEqual(
            capabilities,
            {
                "arxiv": ("generic-asset-hint", "public-protocol"),
                "crossref": ("generic-asset-hint",),
                "semantic-scholar": ("generic-asset-hint",),
                "openalex": ("generic-asset-hint",),
                "europe-pmc": ("generic-asset-hint", "public-protocol"),
                "unpaywall": ("public-protocol",),
                "elsevier": (
                    "generic-asset-hint",
                    "authorized-provider-api",
                    "controlled-browser",
                ),
                "springer": (
                    "generic-asset-hint",
                    "authorized-provider-api",
                    "controlled-browser",
                ),
                "wiley": ("authorized-provider-api", "controlled-browser"),
                "datacite": ("generic-asset-hint",),
                "core": ("generic-asset-hint", "authorized-provider-api"),
                "sci-hub": ("operator-locator",),
            },
        )
        self.assertEqual(set(PRODUCTION_AUTHORIZED_PROVIDER_CATALOG), {"core", "wiley"})
        self.assertEqual(
            UNSUPPORTED_AUTHORIZED_API_PROVIDER_KEYS,
            frozenset({"elsevier", "springer"}),
        )
        self.assertEqual(PRODUCTION_BROWSER_RULE_CATALOG.rules, ())
        self.assertFalse(CONTROLLED_BROWSER_PRODUCTION_READINESS.is_ready)

    def test_readiness_is_per_provider_and_optional_paths_do_not_block_generic_path(self) -> None:
        missing = acquisition_provider_statuses(_configuration(_ALL_PROVIDERS))
        by_name = {status.provider_name: status for status in missing}
        self.assertFalse(by_name["unpaywall"].ready)
        self.assertEqual(by_name["unpaywall"].failure_code, "missing-ordinary-parameter")
        self.assertFalse(by_name["sci-hub"].ready)
        self.assertEqual(by_name["sci-hub"].failure_code, "missing-configured-resolver")
        self.assertTrue(by_name["wiley"].ready)
        self.assertTrue(
            any(
                mapping.capability is AcquisitionCapability.AUTHORIZED_PROVIDER_API
                and mapping.production_available
                for mapping in by_name["wiley"].mappings
            )
        )
        for provider in ("elsevier", "springer"):
            self.assertTrue(by_name[provider].ready)
            self.assertTrue(
                any(
                    mapping.capability is AcquisitionCapability.AUTHORIZED_PROVIDER_API
                    and not mapping.production_available
                    for mapping in by_name[provider].mappings
                )
            )
        self.assertTrue(by_name["core"].ready)
        core_authorized = next(
            mapping
            for mapping in by_name["core"].mappings
            if mapping.capability is AcquisitionCapability.AUTHORIZED_PROVIDER_API
        )
        self.assertTrue(core_authorized.production_available)

        ready = acquisition_provider_statuses(
            _configuration(_ALL_PROVIDERS, unpaywall_email="researcher@example.invalid"),
            configured_sci_hub_resolver=_ConfiguredLocatorResolver(),
        )
        ready_by_name = {status.provider_name: status for status in ready}
        self.assertTrue(ready_by_name["unpaywall"].ready)
        self.assertTrue(ready_by_name["sci-hub"].ready)
        self.assertTrue(ready_by_name["wiley"].ready)

    def test_matrix_validator_rejects_order_duplicates_and_contract_tampering(self) -> None:
        statuses = acquisition_provider_statuses(_configuration(()))
        with self.assertRaises(AcquisitionRegistryError):
            validate_acquisition_provider_matrix(tuple(reversed(statuses)))
        with self.assertRaises(AcquisitionRegistryError):
            validate_acquisition_provider_matrix(statuses[:-1] + (statuses[0],))
        crossref = statuses[1]
        damaged = replace(
            crossref,
            mappings=(replace(crossref.mappings[0], uses_shared_network=False),),
        )
        with self.assertRaises(AcquisitionRegistryError):
            validate_acquisition_provider_matrix(
                statuses[:1] + (cast(AcquisitionProviderStatus, damaged),) + statuses[2:]
            )


class AcquisitionRegistryAssemblyTests(unittest.TestCase):
    def test_core_authorized_source_is_last_and_requires_one_local_credential_snapshot(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_credentials(ProviderName.CORE, {"api_key": "synthetic-core-key"}, home=home)
            credentials = load_credentials(home=home)
            dependencies, client = _dependencies(credentials=credentials)
            registry = build_acquisition_registry(_configuration(("core",)), dependencies)

        self.assertEqual(
            tuple(binding.acquisition_path for binding in registry.source_bindings),
            (
                AcquisitionPath.PUBLIC,
                AcquisitionPath.PUBLIC,
                AcquisitionPath.PUBLIC,
                AcquisitionPath.AUTHORIZED_PROVIDER_API,
            ),
        )
        self.assertEqual(registry.registrations[-1].provider_names, ("core",))
        authorized = registry.source_bindings[-1].source
        self.assertIsInstance(authorized, AuthorizedPdfSource)
        authorized = cast(AuthorizedPdfSource, authorized)
        core_client = getattr(authorized, "_client")
        self.assertIs(getattr(core_client, "_http_client"), client)
        self.assertIs(getattr(client, "_coordinator"), dependencies.access_coordinator)

        missing, _client = _dependencies()
        with self.assertRaises(AcquisitionRegistryError) as caught:
            build_acquisition_registry(_configuration(("core",)), missing)
        self.assertEqual(caught.exception.code, "acquisition-authorized-credential-missing")

        # CORE credentials are irrelevant when the authorized Source is not
        # enabled; assembling the shared public direct Source remains valid.
        disabled = build_acquisition_registry(_configuration(()), missing)
        self.assertTrue(
            all(
                binding.acquisition_path is AcquisitionPath.PUBLIC
                for binding in disabled.source_bindings
            )
        )

    def test_wiley_authorized_source_requires_one_token_and_doi_resolution(self) -> None:
        token = "synthetic-wiley-tdm-token"
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_credentials(ProviderName.WILEY, {"tdm_api_token": token}, home=home)
            dependencies, client = _dependencies(credentials=load_credentials(home=home))
            registry = build_acquisition_registry(_configuration(("wiley",)), dependencies)

        self.assertTrue(registry.requires_doi_landing_origin)
        self.assertEqual(registry.registrations[-1].provider_names, ("wiley",))
        authorized = registry.source_bindings[-1].source
        self.assertIsInstance(authorized, AuthorizedPdfSource)
        wiley_client = getattr(cast(AuthorizedPdfSource, authorized), "_client")
        self.assertIs(getattr(wiley_client, "_http_client"), client)
        self.assertNotIn(token, repr(registry))
        self.assertNotIn(token, repr(authorized))

    def test_direct_is_not_a_provider_and_consumes_all_saved_hints_when_none_enabled(
        self,
    ) -> None:
        dependencies, _client = _dependencies()
        registry = build_acquisition_registry(_configuration(()), dependencies)
        web_of_science = _observation(
            1,
            "web-of-science",
            "https://wos.test/paper.pdf",
        )
        web_of_science = web_of_science.model_copy(
            update={
                "asset_hints": (
                    *web_of_science.asset_hints,
                    AssetHint(
                        url="https://wos.test/article",
                        kind=AssetHintKind.LANDING_PAGE,
                    ),
                )
            }
        )
        request = _request(
            (
                web_of_science,
                _observation(2, "opencitations", "https://oci.test/paper.pdf"),
                _observation(3, "semantic-scholar", "https://s2.test/paper.pdf"),
            )
        )
        evidence = build_acquisition_evidence(request)
        calls: list[tuple[tuple[str, str], ...]] = []

        def record(
            direct: DirectPdfSource,
            filtered_request: AcquisitionRequest,
            filtered_evidence: object,
            candidate_keys: CandidateKeyTracker,
        ) -> tuple[()]:
            del direct, filtered_evidence, candidate_keys
            calls.append(
                tuple(
                    (observation.provenance.source_name, hint.kind.value)
                    for observation in filtered_request.observations
                    for hint in observation.asset_hints
                )
            )
            return ()

        with mock.patch.object(DirectPdfSource, "acquire", autospec=True, side_effect=record):
            for binding in registry.source_bindings:
                source = binding.source
                self.assertIsNotNone(source)
                assert source is not None
                if source.is_applicable(evidence):
                    tuple(source.acquire(request, evidence, CandidateKeyTracker()))

        self.assertEqual(
            calls,
            [
                (
                    ("web-of-science", "direct-file"),
                    ("opencitations", "direct-file"),
                    ("semantic-scholar", "direct-file"),
                ),
                (("web-of-science", "landing-page"),),
            ],
        )
        self.assertTrue(registry.registrations)
        self.assertTrue(
            all(
                registration.provider_names == ()
                for registration in registry.registrations
                if registration.binding.source_name == "direct"
            )
        )

    def test_public_order_is_global_direct_prefix_then_configured_and_fallback_landing(
        self,
    ) -> None:
        dependencies, _client = _dependencies()
        registry = build_acquisition_registry(
            _configuration(("arxiv", "crossref")),
            dependencies,
        )
        arxiv = _observation(4, "arxiv", "https://arxiv.test/landing").model_copy(
            update={
                "asset_hints": (
                    AssetHint(
                        url="https://arxiv.test/landing",
                        kind=AssetHintKind.LANDING_PAGE,
                    ),
                )
            }
        )
        crossref = _observation(5, "crossref", "https://crossref.test/paper.pdf")
        crossref = crossref.model_copy(
            update={
                "asset_hints": (
                    *crossref.asset_hints,
                    AssetHint(
                        url="https://crossref.test/landing",
                        kind=AssetHintKind.LANDING_PAGE,
                    ),
                )
            }
        )
        historical = _observation(6, "semantic-scholar", "https://s2.test/landing")
        historical = historical.model_copy(
            update={
                "asset_hints": (
                    AssetHint(
                        url="https://s2.test/landing",
                        kind=AssetHintKind.LANDING_PAGE,
                    ),
                )
            }
        )
        request = _request(
            (arxiv, crossref, historical),
            identifiers=(Identifier(namespace="arxiv", value="2106.14834"),),
        )
        evidence = build_acquisition_evidence(request)
        calls: list[tuple[str, tuple[tuple[str, str], ...]]] = []

        def record_direct(
            direct: DirectPdfSource,
            filtered_request: AcquisitionRequest,
            filtered_evidence: object,
            candidate_keys: CandidateKeyTracker,
        ) -> tuple[()]:
            del direct, filtered_evidence, candidate_keys
            calls.append(
                (
                    "direct",
                    tuple(
                        (observation.provenance.source_name, hint.kind.value)
                        for observation in filtered_request.observations
                        for hint in observation.asset_hints
                    ),
                )
            )
            return ()

        def record_arxiv(
            source: ArxivPdfSource,
            filtered_request: AcquisitionRequest,
            filtered_evidence: object,
            candidate_keys: CandidateKeyTracker,
        ) -> tuple[()]:
            del source, filtered_request, filtered_evidence, candidate_keys
            calls.append(("arxiv", ()))
            return ()

        with (
            mock.patch.object(
                DirectPdfSource,
                "acquire",
                autospec=True,
                side_effect=record_direct,
            ),
            mock.patch.object(
                ArxivPdfSource,
                "acquire",
                autospec=True,
                side_effect=record_arxiv,
            ),
        ):
            tracker = CandidateKeyTracker()
            for binding in registry.source_bindings:
                source = binding.source
                self.assertIsNotNone(source)
                assert source is not None
                if source.is_applicable(evidence):
                    tuple(source.acquire(request, evidence, tracker))

        self.assertEqual(
            calls,
            [
                ("direct", (("crossref", "direct-file"),)),
                ("arxiv", ()),
                ("direct", (("arxiv", "landing-page"),)),
                ("direct", (("crossref", "landing-page"),)),
                ("direct", (("semantic-scholar", "landing-page"),)),
            ],
        )

    def test_duplicate_direct_and_landing_declarations_stay_in_the_direct_prefix(
        self,
    ) -> None:
        dependencies, _client = _dependencies()
        registry = build_acquisition_registry(_configuration(()), dependencies)
        observation = _observation(7, "web-of-science", "https://hint.test/paper.pdf")
        observation = observation.model_copy(
            update={
                "asset_hints": (
                    *observation.asset_hints,
                    AssetHint(
                        url="https://HINT.test:443/paper.pdf",
                        kind=AssetHintKind.LANDING_PAGE,
                    ),
                )
            }
        )
        request = _request((observation,))
        evidence = build_acquisition_evidence(request)
        calls: list[tuple[str, ...]] = []

        def record(
            direct: DirectPdfSource,
            filtered_request: AcquisitionRequest,
            filtered_evidence: object,
            candidate_keys: CandidateKeyTracker,
        ) -> tuple[()]:
            del direct, filtered_evidence, candidate_keys
            calls.append(
                tuple(
                    hint.kind.value
                    for item in filtered_request.observations
                    for hint in item.asset_hints
                )
            )
            return ()

        with mock.patch.object(DirectPdfSource, "acquire", autospec=True, side_effect=record):
            for binding in registry.source_bindings:
                source = binding.source
                self.assertIsNotNone(source)
                assert source is not None
                if source.is_applicable(evidence):
                    tuple(source.acquire(request, evidence, CandidateKeyTracker()))

        self.assertEqual(calls, [("direct-file", "landing-page")])

    def test_builds_ordered_views_over_one_direct_source_and_configured_public_sources(
        self,
    ) -> None:
        configured_resolver = _ConfiguredLocatorResolver()
        cancel_event = threading.Event()
        dependencies, client = _dependencies(
            configured_resolver=configured_resolver,
            cancel_event=cancel_event,
        )
        configuration = _configuration(
            ("crossref", "arxiv", "unpaywall", "sci-hub", "europe-pmc"),
            unpaywall_email="researcher@example.invalid",
        )
        registry = build_acquisition_registry(configuration, dependencies)

        self.assertEqual(
            tuple(binding.source_name for binding in registry.source_bindings),
            (
                "direct",
                "direct",
                "arxiv",
                "direct",
                "unpaywall",
                "sci-hub",
                "europe-pmc",
                "direct",
                "direct",
            ),
        )
        self.assertEqual(
            tuple(registration.provider_names for registration in registry.registrations),
            (
                (),
                (),
                ("arxiv",),
                (),
                ("unpaywall",),
                ("sci-hub",),
                ("europe-pmc",),
                (),
                (),
            ),
        )
        sources = tuple(binding.source for binding in registry.source_bindings)
        direct_wrappers = tuple(
            source for source in sources if source is not None and source.source_name == "direct"
        )
        direct_sources = tuple(
            getattr(wrapper, "_direct_source", None) for wrapper in direct_wrappers
        )
        self.assertTrue(direct_sources)
        self.assertTrue(all(isinstance(source, DirectPdfSource) for source in direct_sources))
        direct = cast(DirectPdfSource, direct_sources[0])
        self.assertTrue(all(source is direct for source in direct_sources))
        by_name = {
            source.source_name: source
            for source in sources
            if source is not None and source.source_name != "direct"
        }
        self.assertIsInstance(by_name["arxiv"], ArxivPdfSource)
        self.assertIsInstance(by_name["unpaywall"], UnpaywallPdfSource)
        self.assertIsInstance(by_name["sci-hub"], ConfiguredSciHubPdfSource)
        self.assertIsInstance(by_name["europe-pmc"], EuropePmcPdfSource)
        self.assertFalse(registry.requires_doi_landing_origin)
        self.assertIs(getattr(registry.doi_landing_resolver, "_http_client"), client)
        self.assertIs(getattr(registry.doi_landing_resolver, "_cancel_event"), cancel_event)
        self.assertEqual(configured_resolver.calls, 0)

        fetcher = cast(PublicLocatorFetcher, getattr(direct, "_fetcher"))
        self.assertIs(getattr(fetcher, "_http_client"), client)
        self.assertIs(
            getattr(fetcher, "_web_access_profile_resolver"),
            dependencies.web_access_profile_resolver,
        )
        self.assertIs(getattr(fetcher, "_cancel_event"), cancel_event)
        for source in by_name.values():
            if isinstance(source, ConfiguredSciHubPdfSource):
                self.assertIs(getattr(source, "_locator_fetcher"), fetcher)
            else:
                self.assertIs(getattr(source, "_http_client"), client)
                self.assertIs(getattr(source, "_locator_fetcher"), fetcher)
                self.assertIs(getattr(source, "_cancel_event"), cancel_event)
        self.assertEqual(getattr(by_name["arxiv"], "_access_scope"), AccessScope("arxiv", "api"))
        self.assertEqual(
            getattr(by_name["unpaywall"], "_access_scope"), AccessScope("unpaywall", "api")
        )
        self.assertEqual(
            getattr(by_name["europe-pmc"], "_access_scope"),
            AccessScope("europe-pmc", "api"),
        )

    def test_direct_prefix_consumes_saved_hints_independent_of_current_provider_selection(
        self,
    ) -> None:
        dependencies, _client = _dependencies()
        registry = build_acquisition_registry(
            _configuration(("openalex", "crossref")),
            dependencies,
        )
        source = registry.source_bindings[0].source
        self.assertIsNotNone(source)
        request = _request(
            (
                _observation(10, "crossref", "https://crossref.test/paper.pdf"),
                _observation(11, "semantic-scholar", "https://s2.test/paper.pdf"),
                _observation(12, "openalex", "https://openalex.test/paper.pdf"),
                _observation(13, "crossref", "https://crossref.test/second.pdf"),
            )
        )
        evidence = build_acquisition_evidence(request)
        seen: list[tuple[str, ...]] = []

        def record(
            direct: DirectPdfSource,
            filtered_request: AcquisitionRequest,
            filtered_evidence: object,
            candidate_keys: CandidateKeyTracker,
        ) -> tuple[()]:
            del direct, filtered_evidence, candidate_keys
            seen.append(
                tuple(item.provenance.source_name for item in filtered_request.observations)
            )
            return ()

        with mock.patch.object(DirectPdfSource, "acquire", autospec=True, side_effect=record):
            self.assertEqual(
                tuple(source.acquire(request, evidence, CandidateKeyTracker())),
                (),
            )
        self.assertEqual(
            seen,
            [("crossref", "semantic-scholar", "openalex", "crossref")],
        )
        self.assertTrue(source.is_applicable(evidence))

        disabled_only = build_acquisition_evidence(
            _request((_observation(20, "semantic-scholar", "https://s2.test/only.pdf"),))
        )
        self.assertTrue(source.is_applicable(disabled_only))

    def test_disabled_sources_are_absent_and_unready_enabled_provider_fails_before_io(self) -> None:
        dependencies, _client = _dependencies()
        registry = build_acquisition_registry(
            _configuration(("unpaywall",), unpaywall_email="x@y.invalid"), dependencies
        )
        self.assertEqual(
            tuple(binding.source_name for binding in registry.source_bindings),
            ("direct", "unpaywall", "direct"),
        )
        self.assertEqual(
            tuple(item.provider_names for item in registry.registrations),
            ((), ("unpaywall",), ()),
        )
        for providers in (("unpaywall",), ("sci-hub",), ("wiley",)):
            with self.subTest(providers=providers):
                with self.assertRaises(AcquisitionRegistryError):
                    build_acquisition_registry(_configuration(providers), dependencies)

    def test_rejects_a_client_bound_to_another_coordinator_without_io(self) -> None:
        expected = AccessCoordinator(clock=lambda: 100.0)
        actual = AccessCoordinator(clock=lambda: 100.0)
        dependencies, _client = _dependencies(
            coordinator=expected,
            http_coordinator=actual,
        )
        with self.assertRaises(AcquisitionRegistryError) as caught:
            build_acquisition_registry(_configuration(("crossref",)), dependencies)
        self.assertEqual(caught.exception.code, "network-bypass")

    def test_browser_dependency_must_share_coordinator_but_is_not_registered_yet(self) -> None:
        dependencies, _client = _dependencies()
        different = AccessCoordinator(clock=lambda: 100.0)
        browser = BrowserClient(
            factory=lambda: object(),
            resolver=_NeverResolver(),
            coordinator=different,
            clock=lambda: 100.0,
        )
        with self.assertRaises(AcquisitionRegistryError) as caught:
            build_acquisition_registry(
                _configuration(("crossref",)),
                replace(dependencies, browser_client=browser),
            )
        self.assertEqual(caught.exception.code, "network-bypass")

        shared_browser = BrowserClient(
            factory=lambda: object(),
            resolver=_NeverResolver(),
            coordinator=dependencies.access_coordinator,
            clock=lambda: 100.0,
        )
        registry = build_acquisition_registry(
            _configuration(("crossref",)),
            replace(dependencies, browser_client=shared_browser),
        )
        self.assertEqual(
            tuple(binding.source_name for binding in registry.source_bindings),
            ("direct", "direct", "direct"),
        )

    def test_two_registries_share_the_process_http_client_and_coordinator(self) -> None:
        dependencies, client = _dependencies()
        first = build_acquisition_registry(_configuration(("crossref",)), dependencies)
        second = build_acquisition_registry(_configuration(("openalex",)), dependencies)
        for registry in (first, second):
            wrapper = cast(Any, registry.source_bindings[0].source)
            direct = cast(Any, getattr(wrapper, "_direct_source"))
            fetcher = cast(Any, getattr(direct, "_fetcher"))
            self.assertIs(getattr(fetcher, "_http_client"), client)
            self.assertIs(getattr(client, "_coordinator"), dependencies.access_coordinator)


if __name__ == "__main__":
    unittest.main()
