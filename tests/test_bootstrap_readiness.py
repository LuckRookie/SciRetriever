from __future__ import annotations

import logging
import os
import tempfile
import threading
import unittest
from contextlib import ExitStack
from pathlib import Path
from typing import Any, Mapping, cast
from unittest import mock

import sciretriever.bootstrap.assembly as bootstrap_assembly
import sciretriever.bootstrap.probes as bootstrap_probes
import sciretriever.bootstrap.storage as bootstrap_storage
from sciretriever.agents import AgentBudget, AgentPort, AgentRequest, AgentResult
from sciretriever.configuration import (
    ConfigurationError,
    initialize_browser_profile,
    load_credentials,
    load_runtime_secrets,
    parse_configuration,
    set_core_credentials,
    set_credentials,
)
from sciretriever.configuration.cloak_runtime import (
    CLOAKBROWSER_BROWSER_VERSION,
    CloakRuntimeStatus,
)
from sciretriever.model.configuration import (
    AgentProvider,
    Configuration,
    ParserConnectionMode,
    ProbeOutcome,
    ProviderCapability,
    ProviderName,
)
from sciretriever.model.library import LibraryQuery, LibrarySearchRequest
from sciretriever.model.parsing import ParserRequest
from sciretriever.network.cloakbrowser import CloakBrowserRuntimeAvailability
from sciretriever.parsing.ports import StagedParserOutput


class ProductionConfigurationContractTests(unittest.TestCase):
    def test_production_groups_use_only_the_frozen_ordinary_fields(self) -> None:
        configuration = parse_configuration(
            """
            [paths]
            catalog_path = "/tmp/catalog.sqlite3"
            artifact_root = "/tmp/artifacts"

            [parsing]
            base_url = "http://127.0.0.1:8000"
            connection_mode = "loopback"
            model_identity = "mineru-3.4.4-vlm"
            remote_upload_authorized = false

            [agents]
            provider = "openai"
            protocol = "openai-responses"
            base_url = "https://api.openai.com/v1"
            authentication = "api-key"
            [agents.analysis]
            model = "fixture-model"
            context_window_tokens = 2000000
            structured_output = true
            max_output_tokens = 1024
            [analysis]
            metadata_max_output_tokens = 256
            content_max_output_tokens = 1024
            reference_max_output_tokens = 256
            max_input_bytes = 1048576
            max_chunk_bytes = 1048576
            max_chunk_count = 1
            max_total_llm_requests = 3
            max_total_output_tokens = 1536

            [execution]
            max_concurrency = 4

            [library]
            max_input_bytes = 67108864
            """
        )

        self.assertEqual(configuration.paths.catalog_path, "/tmp/catalog.sqlite3")
        self.assertEqual(configuration.paths.artifact_root, "/tmp/artifacts")
        self.assertIs(configuration.parsing.connection_mode, ParserConnectionMode.LOOPBACK)
        self.assertIs(configuration.agents.provider, AgentProvider.OPENAI)

    def test_retired_paths_and_dynamic_runtime_fields_fail_closed(self) -> None:
        invalid = (
            '[paths]\ncatalog = "catalog.sqlite3"\n',
            '[paths]\nstorage_root = "artifacts"\n',
            '[parsing]\nsecret_ref = "env:MINERU_TOKEN"\n',
            '[analysis]\nsecret_ref = "env:OPENAI_API_KEY"\n',
            '[analysis]\nprovider = "openai"\nbase_url = "https://example.invalid"\n',
            '[analysis]\nruntime_factory = "package:callable"\n',
        )
        for payload in invalid:
            with self.subTest(payload=payload):
                with self.assertRaises(ConfigurationError):
                    parse_configuration(payload)

    def test_loopback_parser_forbids_remote_upload_authorization(self) -> None:
        with self.assertRaises(ConfigurationError):
            parse_configuration(
                """
                [parsing]
                connection_mode = "loopback"
                remote_upload_authorized = true
                """
            )

    def test_runtime_secrets_use_only_the_selected_core_credential_sections(self) -> None:
        selected = parse_configuration(
            """
            [parsing]
            base_url = "https://mineru.example.invalid"
            connection_mode = "remote"
            model_identity = "mineru-3.4.4-vlm"
            remote_upload_authorized = true
            [agents]
            provider = "anthropic"
            protocol = "anthropic-messages"
            base_url = "https://api.anthropic.com/v1"
            authentication = "api-key"
            [agents.analysis]
            model = "fixture-model"
            context_window_tokens = 128000
            structured_output = true
            max_output_tokens = 256
            """
        )
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_core_credentials(
                "mineru",
                secret="mineru-secret",
                origin="https://mineru.example.invalid",
                home=home,
            )
            credentials = set_core_credentials(
                "agents",
                secret="anthropic-secret",
                origin="https://api.anthropic.com",
                home=home,
            )
            parser_only = load_runtime_secrets(
                selected,
                credentials=credentials,
                include_agents=False,
            )
            analysis_only = load_runtime_secrets(
                selected,
                credentials=credentials,
                include_parser=False,
            )
        self.assertEqual(parser_only.mineru_bearer_token, "mineru-secret")
        self.assertIsNone(parser_only.agents_api_key)
        self.assertIsNone(analysis_only.mineru_bearer_token)
        self.assertEqual(analysis_only.agents_api_key, "anthropic-secret")
        self.assertNotIn("anthropic-secret", repr(analysis_only))


class ConfigurationReadinessTests(unittest.TestCase):
    def test_status_is_local_typed_and_separates_readiness_layers(self) -> None:
        import sciretriever.configuration as configuration_boundary
        from sciretriever.configuration import configuration_status, load_credentials
        from sciretriever.model.configuration import CredentialStatus

        configuration = parse_configuration(
            """
            [discovery]
            metadata_scan_limit = 10
            [sources.metadata]
            providers = ["crossref"]
            [sources.metadata.crossref]
            mode = "anonymous"
            """
        )
        with tempfile.TemporaryDirectory() as temporary:
            credentials = load_credentials(home=Path(temporary))
            with (
                mock.patch(
                    "sciretriever.network.http.HttpClient",
                    side_effect=AssertionError("status must not construct Network"),
                ),
                mock.patch(
                    "sciretriever.storage.sqlite.engine.CatalogEngine",
                    side_effect=AssertionError("status must not construct Catalog"),
                ),
                mock.patch.object(
                    configuration_boundary,
                    "load_credentials",
                    side_effect=AssertionError("offline status must not read default credentials"),
                ),
            ):
                status = configuration_status(configuration, credentials=credentials)

        crossref = next(
            item
            for item in status.capabilities
            if item.provider.value == "crossref" and item.capability.value == "metadata"
        )
        self.assertTrue(crossref.production_available)
        self.assertTrue(crossref.enabled)
        self.assertTrue(crossref.ordinary_parameters_ready)
        self.assertIs(crossref.credential.status, CredentialStatus.NOT_REQUIRED)
        self.assertTrue(crossref.access_policy_ready)
        self.assertTrue(crossref.local_ready)

    def test_fake_probes_report_passed_failed_and_skipped_without_short_circuit(self) -> None:
        import sciretriever.configuration as configuration_boundary
        from sciretriever.configuration import (
            configuration_status,
            load_credentials,
            run_configuration_probes,
        )
        from sciretriever.model.configuration import (
            ConfigurationProbeResult,
        )

        configuration = parse_configuration(
            """
            [discovery]
            metadata_scan_limit = 10
            [sources.metadata]
            providers = ["crossref", "web-of-science", "arxiv"]
            [sources.metadata.crossref]
            mode = "anonymous"
            """
        )
        probe = _FakeProbe(
            {
                ("crossref", "metadata"): ConfigurationProbeResult(
                    provider=ProviderName.CROSSREF,
                    capability=ProviderCapability.METADATA,
                    outcome=ProbeOutcome.PASSED,
                    local_ready=True,
                    network_reachable=True,
                    authentication_accepted=True,
                    api_product_usable=True,
                    minimal_response_parseable=True,
                ),
                ("arxiv", "metadata"): RuntimeError("secret provider response"),
            },
            supported=frozenset(
                {
                    (ProviderName.WEB_OF_SCIENCE, ProviderCapability.METADATA),
                    (ProviderName.CROSSREF, ProviderCapability.METADATA),
                    (ProviderName.ARXIV, ProviderCapability.METADATA),
                }
            ),
        )
        with tempfile.TemporaryDirectory() as temporary:
            credentials = load_credentials(home=Path(temporary))
            snapshot = configuration_status(configuration, credentials=credentials)
        with mock.patch.object(
            configuration_boundary,
            "load_credentials",
            side_effect=AssertionError("offline probes must not read default credentials"),
        ):
            summary = run_configuration_probes(
                configuration,
                probe,
                test_all=True,
                status_snapshot=snapshot,
            )

        self.assertEqual(
            tuple(result.outcome for result in summary.results),
            (ProbeOutcome.SKIPPED, ProbeOutcome.PASSED, ProbeOutcome.FAILED),
        )
        self.assertEqual(
            probe.calls,
            [("crossref", "metadata"), ("arxiv", "metadata")],
        )
        for result in summary.results:
            self.assertEqual(result.acquisition_entitlement, "not-proven")
            self.assertNotIn("secret provider response", repr(result))


class _FakeProbe:
    def __init__(
        self,
        results: Mapping[tuple[str, str], object],
        *,
        supported: frozenset[tuple[ProviderName, ProviderCapability]] | None = None,
    ) -> None:
        self._results = dict(results)
        self._supported = supported
        self.calls: list[tuple[str, str]] = []

    @property
    def supported_capabilities(
        self,
    ) -> frozenset[tuple[ProviderName, ProviderCapability]]:
        if self._supported is not None:
            return self._supported
        return frozenset(
            (ProviderName(provider), ProviderCapability(capability))
            for provider, capability in self._results
        )

    def probe(self, provider: Any, capability: Any) -> Any:
        key = (provider.value, capability.value)
        self.calls.append(key)
        result = self._results[key]
        if isinstance(result, BaseException):
            raise result
        return result


def _production_configuration(root: Path) -> Configuration:
    return parse_configuration(
        f"""
        [paths]
        catalog_path = {str(root / "catalog.sqlite3")!r}
        artifact_root = {str(root / "artifacts")!r}

        [parsing]
        base_url = "http://127.0.0.1:8000"
        connection_mode = "loopback"
        model_identity = "mineru-3.4.4-vlm"
        remote_upload_authorized = false

        [agents]
        provider = "openai"
        protocol = "openai-responses"
        base_url = "https://api.openai.com/v1"
        authentication = "api-key"
        [agents.analysis]
        model = "offline-model"
        context_window_tokens = 2000000
        structured_output = true
        max_output_tokens = 256
        [analysis]
        metadata_max_output_tokens = 256
        content_max_output_tokens = 256
        reference_max_output_tokens = 256
        max_input_bytes = 1048576
        max_chunk_bytes = 1048576
        max_chunk_count = 1
        max_total_llm_requests = 3
        max_total_output_tokens = 768
        """
    )


def _probe_configuration() -> Configuration:
    return parse_configuration(
        """
        [discovery]
        metadata_scan_limit = 11
        [sources.metadata]
        providers = ["crossref"]
        [sources.metadata.crossref]
        mode = "anonymous"
        """
    )


def _ready_cloak_probe_patches() -> ExitStack:
    stack = ExitStack()
    stack.enter_context(
        mock.patch(
            "sciretriever.bootstrap.browser.CloakRuntimeManager.status",
            return_value=CloakRuntimeStatus(
                presence="configured",
                ready=True,
                version=CLOAKBROWSER_BROWSER_VERSION,
                signature_verified=True,
            ),
        )
    )
    stack.enter_context(
        mock.patch(
            "sciretriever.bootstrap.browser.cloakbrowser_runtime_availability",
            return_value=CloakBrowserRuntimeAvailability(
                cloak_wrapper_available=True,
                playwright_api_available=True,
                binary_executable_available=True,
                headed_display_available=True,
                browser_version=CLOAKBROWSER_BROWSER_VERSION,
            ),
        )
    )
    return stack


def _passed_probe(provider: ProviderName) -> Any:
    from sciretriever.model.configuration import ConfigurationProbeResult

    return ConfigurationProbeResult(
        provider=provider,
        capability=ProviderCapability.METADATA,
        outcome=ProbeOutcome.PASSED,
        local_ready=True,
        network_reachable=True,
        authentication_accepted=True,
        api_product_usable=True,
        minimal_response_parseable=True,
    )


class BootstrapObjectGraphTests(unittest.TestCase):
    def _dependencies(
        self,
        *,
        parser_factory: Any | None = None,
        agents_factory: Any | None = None,
    ) -> Any:
        from sciretriever.bootstrap import BootstrapExternalDependencies

        return BootstrapExternalDependencies(
            parser_factory=parser_factory or (lambda _http, _coordinator: _OfflineParser()),
            agents_factory=agents_factory or (lambda _http, _coordinator: _OfflineAgents()),
            agents_analysis_model="offline-contract-model",
            agents_analysis_budget=AgentBudget(
                max_input_bytes=1_048_576,
                max_output_tokens=1_024,
                context_window_tokens=2_000_000,
            ),
            metadata_max_output_tokens=256,
            content_max_output_tokens=256,
            reference_max_output_tokens=256,
        )

    def test_production_analysis_budget_preserves_configured_context_and_deadline(self) -> None:
        from sciretriever.bootstrap.services import _production_dependencies

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            configuration = _production_configuration(root)
            credentials_home = root / "home"
            credentials_home.mkdir(mode=0o700)
            set_core_credentials(
                "agents",
                secret="offline-key",
                origin="https://api.openai.com",
                home=credentials_home,
            )
            secrets = load_runtime_secrets(
                configuration,
                credentials=load_credentials(home=credentials_home),
                include_parser=False,
            )
            budget = _production_dependencies(
                configuration,
                secrets,
            ).agents_analysis_budget

        self.assertEqual(budget.max_input_bytes, 1_048_576)
        self.assertEqual(budget.max_output_tokens, 256)
        self.assertEqual(budget.context_window_tokens, 2_000_000)
        self.assertEqual(budget.overall_timeout_seconds, 180.0)

    def test_reference_only_analysis_receives_a_usable_agent_input_budget(self) -> None:
        from sciretriever.bootstrap.services import _agent_provider_limits

        configuration = parse_configuration(
            """
            [agents]
            provider = "custom"
            service_name = "fixture-service"
            protocol = "openai-responses"
            base_url = "http://127.0.0.1:8765/v1"
            authentication = "none"
            [agents.analysis]
            model = "fixture-model"
            context_window_tokens = 128000
            max_output_tokens = 256
            structured_output = true
            [analysis]
            reference_max_output_tokens = 256
            """
        )

        budget = _agent_provider_limits(configuration)

        self.assertEqual(budget.max_input_bytes, 127_744)
        self.assertEqual(budget.context_window_tokens, 128_000)

    def test_browser_agent_dependency_is_typed_and_complete(self) -> None:
        from sciretriever.acquisition.registry import BrowserAgentDependency

        budget = AgentBudget(max_input_bytes=1024, max_output_tokens=64)
        offline = _OfflineAgents()
        dependency = BrowserAgentDependency(
            port=offline,
            model="offline-browser-model",
            budget=budget,
        )
        self.assertIs(dependency.port, offline)
        self.assertEqual(dependency.model, "offline-browser-model")
        self.assertIs(dependency.budget, budget)
        with self.assertRaises(TypeError):
            BrowserAgentDependency(
                port=offline,
                model="offline-browser-model",
                budget=object(),  # type: ignore[arg-type]
            )

    def test_full_and_scoped_acquisition_use_the_same_production_web_profiles(
        self,
    ) -> None:
        import sciretriever.bootstrap as bootstrap
        from sciretriever.acquisition import registry as acquisition_registry
        from sciretriever.network.admission import AccessScope
        from sciretriever.network.policy import normalize_url

        captured: list[Any] = []
        original = acquisition_registry.build_acquisition_registry

        def record(configuration: Any, dependencies: Any) -> Any:
            captured.append(dependencies.web_access_profile_resolver)
            return original(configuration, dependencies)

        with tempfile.TemporaryDirectory(prefix="sciretriever-web-profiles-") as temporary:
            root = Path(temporary)
            full_root = root / "full"
            scoped_root = root / "scoped"
            full_root.mkdir(mode=0o700)
            scoped_root.mkdir(mode=0o700)
            full_configuration = _production_configuration(full_root)
            credentials_home = root / "home"
            credentials_home.mkdir(mode=0o700)
            set_core_credentials(
                "agents",
                secret="offline-key",
                origin="https://api.openai.com",
                home=credentials_home,
            )
            scoped_configuration = parse_configuration(
                f"""
                [paths]
                catalog_path = {str(scoped_root / "catalog.sqlite3")!r}
                artifact_root = {str(scoped_root / "artifacts")!r}
                """
            )
            with mock.patch.object(
                acquisition_registry,
                "build_acquisition_registry",
                side_effect=record,
            ):
                bootstrap.build_production_object_graph(
                    full_configuration,
                    credentials_home=credentials_home,
                    configure_process_logging=False,
                )
                bootstrap.build_production_object_graph(
                    scoped_configuration,
                    scope=bootstrap.ProductionEntryScope.ASSET_COMPLETION,
                    configure_process_logging=False,
                )

        self.assertEqual(len(captured), 2)
        for resolver in captured:
            api_scope, api_policy = resolver.resolve(
                normalize_url("https://api.springernature.com/meta/v2/json")
            )
            content_scope, content_policy = resolver.resolve(
                normalize_url("https://link.springer.com/content/pdf/example.pdf")
            )
            unknown_scope, unknown_policy = resolver.resolve(
                normalize_url("https://repository.example.invalid/paper.pdf")
            )
            self.assertEqual(api_scope, AccessScope("springer", "web"))
            self.assertEqual(content_scope, AccessScope("springerlink", "web"))
            self.assertNotEqual(content_scope, api_scope)
            self.assertEqual(api_policy, content_policy)
            self.assertGreaterEqual(content_policy.min_start_interval, 1.0)
            self.assertEqual(content_policy.cooldown_after_completion, 0.0)
            self.assertEqual(
                unknown_scope,
                AccessScope("repository.example.invalid", "web"),
            )
            self.assertGreaterEqual(unknown_policy.min_start_interval, 1.0)
            self.assertEqual(unknown_policy.cooldown_after_completion, 0.0)

    def test_full_and_scoped_completion_own_one_shared_acquisition_runtime(self) -> None:
        import sciretriever.bootstrap as bootstrap
        from sciretriever.acquisition.browser_admission import BrowserAdmissionController
        from sciretriever.acquisition.cohort import TieredCohortExecutor
        from sciretriever.acquisition.registry import AcquisitionRegistry
        from sciretriever.acquisition.tiered_service import TieredAcquisitionService
        from sciretriever.network.browser import BrowserClient
        from sciretriever.network.browser_scheduler import BrowserGroupScheduler
        from sciretriever.network.browser_sessions import BrowserSessionBroker

        forbidden = AssertionError("object graph construction performed external I/O")
        with tempfile.TemporaryDirectory(prefix="sciretriever-p76-graph-") as temporary:
            root = Path(temporary)
            full_root = root / "full"
            scoped_root = root / "scoped"
            full_root.mkdir(mode=0o700)
            scoped_root.mkdir(mode=0o700)
            home = root / "home"
            home.mkdir(mode=0o700)
            initialize_browser_profile("fixture-profile", home=home)
            scoped_configuration = parse_configuration(
                f"""
                [paths]
                catalog_path = {str(scoped_root / "catalog.sqlite3")!r}
                artifact_root = {str(scoped_root / "artifacts")!r}

                [execution]
                max_concurrency = 5

                [access]
                browser_enabled = true
                browser_profile = "fixture-profile"
                browser_max_concurrency = 3
                """
            )
            with (
                mock.patch(
                    "sciretriever.network.http.SystemResolver.resolve",
                    side_effect=forbidden,
                ),
                mock.patch(
                    "sciretriever.network.http.SecureHttpTransport.send",
                    side_effect=forbidden,
                ),
                mock.patch.object(BrowserSessionBroker, "acquire", side_effect=forbidden),
                mock.patch.object(BrowserGroupScheduler, "execute", side_effect=forbidden),
                _ready_cloak_probe_patches(),
            ):
                full = bootstrap.build_object_graph(
                    Configuration(),
                    catalog_path=full_root / "catalog.sqlite3",
                    artifact_root=full_root / "artifacts",
                    external_dependencies=self._dependencies(),
                    credentials_home=home,
                )
                scoped = cast(
                    bootstrap.DatabaseCompletionObjectGraph,
                    bootstrap.build_production_object_graph(
                        scoped_configuration,
                        scope=bootstrap.ProductionEntryScope.ASSET_COMPLETION,
                        credentials_home=home,
                        configure_process_logging=False,
                    ),
                )

            for graph in (full, scoped):
                registry = cast(AcquisitionRegistry, graph.acquisition_registry)
                runtime = graph.acquisition_runtime
                service = cast(TieredAcquisitionService, cast(Any, graph.acquisition_api)._service)
                self.assertIs(registry.profile_catalog, registry.route_registry.profile_catalog)
                self.assertIs(registry.planner.profile_catalog, registry.profile_catalog)
                self.assertIs(service._route_registry, registry.route_registry)
                self.assertIs(service._planner, registry.planner)
                self.assertIs(service._cohort_executor, runtime.cohort_executor)
                self.assertIsInstance(runtime.cohort_executor, TieredCohortExecutor)
                self.assertIsInstance(runtime.browser_admission, BrowserAdmissionController)
                self.assertIsInstance(runtime.browser_scheduler, BrowserGroupScheduler)
                self.assertIsInstance(runtime.browser_session_broker, BrowserSessionBroker)
                self.assertIs(
                    runtime.cohort_executor._browser_admission,
                    runtime.browser_admission,
                )
                self.assertIs(
                    runtime.cohort_executor._browser_scheduler,
                    runtime.browser_scheduler,
                )
                self.assertIs(cast(Any, graph.http_client)._coordinator, graph.access_coordinator)
                self.assertIs(runtime.browser_client, graph.browser_client)
                self.assertEqual(runtime.browser_session_broker._lanes, {})
                self.assertIsNone(runtime.browser_session_broker._shared)
                self.assertEqual(runtime.browser_scheduler._policies, {})
                self.assertEqual(
                    tuple(
                        binding.spec.route_key
                        for binding in registry.route_registry.bindings
                        if binding.spec.tier.value == "controlled-browser"
                    ),
                    (
                        "browser:acs-publications",
                        "browser:aip-publishing",
                        "browser:elsevier-sciencedirect",
                        "browser:iopscience",
                        "browser:oxford-academic",
                        "browser:rsc-publishing",
                        "browser:science-aaas",
                        "browser:springerlink",
                        "browser:wiley-online-library",
                    ),
                )

            self.assertEqual(full.acquisition_runtime.cohort_executor._max_concurrency, 4)
            self.assertEqual(full.acquisition_runtime.browser_scheduler._max_concurrency, 5)
            self.assertFalse(
                full.acquisition_runtime.browser_admission._configuration.explicitly_enabled
            )
            self.assertIsNone(full.browser_client)
            self.assertFalse(
                full.acquisition_runtime.browser_admission._configuration.execution_confirmed
            )
            self.assertFalse(
                full.acquisition_runtime.browser_admission._configuration.runtime_ready
            )
            full_registry = cast(AcquisitionRegistry, full.acquisition_registry)
            full_browser = full_registry.route_registry.binding_for("browser:springerlink")
            self.assertEqual(full_browser.spec.readiness.value, "disabled")
            self.assertIsNone(full_browser.adapter)
            self.assertEqual(scoped.acquisition_runtime.cohort_executor._max_concurrency, 5)
            self.assertEqual(scoped.acquisition_runtime.browser_scheduler._max_concurrency, 3)
            self.assertTrue(
                scoped.acquisition_runtime.browser_admission._configuration.explicitly_enabled
            )
            self.assertIsInstance(scoped.browser_client, BrowserClient)
            self.assertTrue(
                scoped.acquisition_runtime.browser_admission._configuration.execution_confirmed
            )
            self.assertTrue(
                scoped.acquisition_runtime.browser_admission._configuration.runtime_ready
            )
            scoped_registry = cast(AcquisitionRegistry, scoped.acquisition_registry)
            scoped_browser = scoped_registry.route_registry.binding_for("browser:springerlink")
            self.assertEqual(scoped_browser.spec.readiness.value, "ready")
            self.assertIsNotNone(scoped_browser.adapter)
            full.acquisition_runtime.browser_session_broker.close()
            scoped.acquisition_runtime.browser_session_broker.close()

    def test_scoped_content_and_asset_reuse_one_agent_runtime_for_browser_routes(self) -> None:
        import sciretriever.bootstrap as bootstrap
        from sciretriever.agents import (
            AgentModelCapabilities,
            AgentRole,
            AgentRoleBinding,
            AgentRuntime,
        )

        with tempfile.TemporaryDirectory(prefix="sciretriever-cba55-agent-graph-") as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            initialize_browser_profile("fixture-profile", home=home)

            def configuration_for(
                graph_root: Path,
                *,
                content: bool,
                authentication: str = "none",
                browser_capability: bool = True,
                agent_base_url: str = "http://127.0.0.1:8765/v1",
            ) -> Configuration:
                graph_root.mkdir(mode=0o700)
                browser_capabilities = (
                    """
                    image_input = true
                    image_media_types = ["image/png"]
                    image_count = 1
                    image_bytes = 100000
                    tool_decision = true
                    """
                    if browser_capability
                    else ""
                )
                analysis = (
                    """
                    [agents.analysis]
                    model = "analysis-model"
                    context_window_tokens = 128000
                    max_output_tokens = 256
                    structured_output = true
                    [analysis]
                    metadata_max_output_tokens = 64
                    content_max_output_tokens = 64
                    reference_max_output_tokens = 64
                    max_input_bytes = 1024
                    max_chunk_bytes = 1024
                    max_chunk_count = 1
                    max_total_llm_requests = 3
                    max_total_output_tokens = 192
                    [parsing]
                    base_url = "http://127.0.0.1:8000"
                    connection_mode = "loopback"
                    model_identity = "mineru-fixture"
                    """
                    if content
                    else ""
                )
                return parse_configuration(
                    f"""
                    [paths]
                    catalog_path = {str(graph_root / "catalog.sqlite3")!r}
                    artifact_root = {str(graph_root / "artifacts")!r}
                    [agents]
                    provider = "custom"
                    service_name = "fixture-agents"
                    protocol = "openai-responses"
                    base_url = {agent_base_url!r}
                    authentication = {authentication!r}
                    [agents.browser]
                    model = "browser-model"
                    context_window_tokens = 128000
                    max_output_tokens = 256
                    {browser_capabilities}
                    [access]
                    browser_enabled = true
                    browser_profile = "fixture-profile"
                    {analysis}
                    """
                )

            capabilities = AgentModelCapabilities(
                context_window_tokens=128000,
                max_output_tokens=256,
                structured_output=True,
                image_input=True,
                tool_decision=True,
                supported_image_media_types=frozenset({"image/png"}),
                max_image_count=1,
                max_image_bytes=100000,
            )
            shared = _OfflineAgents()
            runtime = AgentRuntime(
                adapter=shared,
                analysis=AgentRoleBinding(
                    role=AgentRole.ANALYSIS,
                    model="analysis-model",
                    capabilities=capabilities,
                ),
                browser=AgentRoleBinding(
                    role=AgentRole.BROWSER,
                    model="browser-model",
                    capabilities=capabilities,
                ),
            )
            calls: list[tuple[object, object]] = []

            def build_agents(*_args: object, **kwargs: object) -> AgentRuntime:
                calls.append((kwargs.get("required_roles"), kwargs.get("optional_roles")))
                return runtime

            with (
                mock.patch.object(
                    bootstrap_assembly, "_build_agents_runtime", side_effect=build_agents
                ),
                _ready_cloak_probe_patches(),
            ):
                content = cast(
                    bootstrap.DatabaseCompletionObjectGraph,
                    bootstrap.build_production_object_graph(
                        configuration_for(root / "content", content=True),
                        scope=bootstrap.ProductionEntryScope.CONTENT_COMPLETION,
                        credentials_home=home,
                        configure_process_logging=False,
                    ),
                )
                asset = cast(
                    bootstrap.DatabaseCompletionObjectGraph,
                    bootstrap.build_production_object_graph(
                        configuration_for(root / "asset", content=False),
                        scope=bootstrap.ProductionEntryScope.ASSET_COMPLETION,
                        credentials_home=home,
                        configure_process_logging=False,
                    ),
                )

            try:
                content_routes = [
                    binding.adapter
                    for binding in cast(Any, content.acquisition_registry).route_registry.bindings
                    if binding.adapter is not None
                    and binding.spec.tier.value == "controlled-browser"
                ]
                self.assertEqual(len(content_routes), 9)
                self.assertEqual(
                    {id(getattr(route, "_browser_agent_port")) for route in content_routes},
                    {id(runtime)},
                )
                analysis = cast(Any, content.entry_api)._operation._analysis
                self.assertIs(cast(Any, analysis)._content_service._agents, runtime)
                self.assertIs(cast(Any, analysis)._reference_lookup_stage._agents, runtime)

                asset_routes = [
                    binding.adapter
                    for binding in cast(Any, asset.acquisition_registry).route_registry.bindings
                    if binding.adapter is not None
                    and binding.spec.tier.value == "controlled-browser"
                ]
                self.assertEqual(len(asset_routes), 9)
                self.assertEqual(
                    {id(getattr(route, "_browser_agent_port")) for route in asset_routes},
                    {id(runtime)},
                )
            finally:
                content.close()
                asset.close()

            with _ready_cloak_probe_patches():
                missing_credential = cast(
                    bootstrap.DatabaseCompletionObjectGraph,
                    bootstrap.build_production_object_graph(
                        configuration_for(
                            root / "missing-credential",
                            content=False,
                            authentication="api-key",
                            agent_base_url="https://agents.example.invalid/v1",
                        ),
                        scope=bootstrap.ProductionEntryScope.ASSET_COMPLETION,
                        credentials_home=home,
                        configure_process_logging=False,
                    ),
                )
                missing_capability = cast(
                    bootstrap.DatabaseCompletionObjectGraph,
                    bootstrap.build_production_object_graph(
                        configuration_for(
                            root / "missing-capability",
                            content=False,
                            browser_capability=False,
                        ),
                        scope=bootstrap.ProductionEntryScope.ASSET_COMPLETION,
                        credentials_home=home,
                        configure_process_logging=False,
                    ),
                )
            try:
                for graph in (missing_credential, missing_capability):
                    routes = [
                        binding.adapter
                        for binding in cast(Any, graph.acquisition_registry).route_registry.bindings
                        if binding.adapter is not None
                        and binding.spec.tier.value == "controlled-browser"
                    ]
                    self.assertEqual(len(routes), 9)
                    self.assertTrue(
                        all(getattr(route, "_browser_agent_port") is None for route in routes)
                    )
            finally:
                missing_credential.close()
                missing_capability.close()

            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0][0], frozenset({AgentRole.ANALYSIS}))
            self.assertEqual(calls[0][1], frozenset({AgentRole.BROWSER}))
            self.assertEqual(calls[1][0], frozenset())
            self.assertEqual(calls[1][1], frozenset({AgentRole.BROWSER}))

    def test_local_library_scope_uses_only_paths_and_no_external_assembly(self) -> None:
        import sciretriever.bootstrap as bootstrap

        with tempfile.TemporaryDirectory(prefix="sciretriever-e13-local-") as temporary:
            root = Path(temporary)
            configuration = parse_configuration(
                f"""
                [paths]
                catalog_path = {str(root / "catalog.sqlite3")!r}
                artifact_root = {str(root / "artifacts")!r}
                """
            )
            forbidden = AssertionError("local scope constructed an external capability")
            with (
                mock.patch.object(
                    bootstrap_assembly,
                    "load_runtime_secrets",
                    side_effect=forbidden,
                ),
                mock.patch.object(
                    bootstrap_assembly,
                    "load_credentials",
                    side_effect=forbidden,
                ),
                mock.patch(
                    "sciretriever.metadata.registry.build_metadata_registry",
                    side_effect=forbidden,
                ),
                mock.patch(
                    "sciretriever.acquisition.registry.build_acquisition_registry",
                    side_effect=forbidden,
                ),
            ):
                graph = cast(
                    bootstrap.LocalLibraryObjectGraph,
                    bootstrap.build_production_object_graph(
                        configuration,
                        scope=bootstrap.ProductionEntryScope.LOCAL_LIBRARY,
                        configure_process_logging=False,
                    ),
                )

            page = graph.entry_api.search_literature(LibrarySearchRequest(query=LibraryQuery()))
            self.assertEqual(page.items, ())
            self.assertTrue((root / "catalog.sqlite3").is_file())
            self.assertTrue((root / "artifacts").is_dir())

    def test_citation_scope_uses_only_reference_analysis_configuration(self) -> None:
        import sciretriever.bootstrap as bootstrap
        from sciretriever.analysis.api import AnalysisApi

        with tempfile.TemporaryDirectory(prefix="sciretriever-e13-citation-") as temporary:
            root = Path(temporary)
            configuration = parse_configuration(
                f"""
                [paths]
                catalog_path = {str(root / "catalog.sqlite3")!r}
                artifact_root = {str(root / "artifacts")!r}

                [discovery]
                metadata_scan_limit = 11

                [sources.metadata]
                providers = ["crossref"]

                [sources.metadata.crossref]
                mode = "anonymous"

                [agents]
                provider = "openai"
                protocol = "openai-responses"
                base_url = "https://api.openai.com/v1"
                authentication = "api-key"
                [agents.analysis]
                model = "reference-only-model"
                context_window_tokens = 128000
                structured_output = true
                max_output_tokens = 256
                [analysis]
                reference_max_output_tokens = 256
                """
            )
            credentials_home = root / "home"
            credentials_home.mkdir(mode=0o700)
            set_core_credentials(
                "agents",
                secret="reference-only-secret",
                origin="https://api.openai.com",
                home=credentials_home,
            )
            forbidden = AssertionError("citation scope constructed content analysis or Parser")
            with (
                mock.patch(
                    "sciretriever.parsing.adapters.mineru.OperatorManagedMinerUAdapter.__init__",
                    side_effect=forbidden,
                ),
                mock.patch(
                    "sciretriever.parsing.service.ParsingService.__init__",
                    side_effect=forbidden,
                ),
                mock.patch(
                    "sciretriever.analysis.service.AnalysisService.__init__",
                    side_effect=forbidden,
                ),
                mock.patch(
                    "sciretriever.storage.sqlite.analysis_artifacts.AnalysisArtifactReader.__init__",
                    side_effect=forbidden,
                ),
                mock.patch(
                    "sciretriever.storage.sqlite.analysis_inputs.SqliteAnalysisCurrentInputs.__init__",
                    side_effect=forbidden,
                ),
                mock.patch(
                    "sciretriever.storage.analysis_artifacts.AnalysisArtifactPublisher.__init__",
                    side_effect=forbidden,
                ),
            ):
                graph = cast(
                    bootstrap.CitationDiscoveryObjectGraph,
                    bootstrap.build_production_object_graph(
                        configuration,
                        scope=bootstrap.ProductionEntryScope.CITATION_DISCOVERY,
                        credentials_home=credentials_home,
                        configure_process_logging=False,
                    ),
                )

            operation = cast(Any, graph.entry_api)._operation
            analysis = cast(AnalysisApi, operation._analysis)
            self.assertIsInstance(analysis, AnalysisApi)
            with self.assertRaisesRegex(RuntimeError, "content analysis is not assembled"):
                analysis.analyze_content(cast(Any, object()))
            self.assertTrue((root / "catalog.sqlite3").is_file())
            self.assertTrue((root / "artifacts").is_dir())

    def test_external_scopes_keep_their_required_capabilities_fail_closed(self) -> None:
        import sciretriever.bootstrap as bootstrap

        with tempfile.TemporaryDirectory(prefix="sciretriever-e13-external-") as temporary:
            root = Path(temporary)
            configuration = parse_configuration(
                f"""
                [paths]
                catalog_path = {str(root / "catalog.sqlite3")!r}
                artifact_root = {str(root / "artifacts")!r}
                """
            )
            cases = (
                (bootstrap.ProductionEntryScope.TOPIC_DISCOVERY, "metadata-not-ready"),
                (bootstrap.ProductionEntryScope.CITATION_DISCOVERY, "analysis-not-ready"),
                (bootstrap.ProductionEntryScope.CONTENT_COMPLETION, "parser-not-ready"),
            )
            for scope, code in cases:
                with self.subTest(scope=scope):
                    with self.assertRaises(bootstrap.BootstrapError) as raised:
                        bootstrap.build_production_object_graph(
                            configuration,
                            scope=scope,
                            credentials_home=root / "home",
                            configure_process_logging=False,
                        )
                    self.assertEqual(raised.exception.code, code)

            with (
                mock.patch.object(
                    bootstrap_assembly,
                    "load_runtime_secrets",
                ) as load_secrets,
                mock.patch.object(
                    bootstrap_assembly,
                    "load_credentials",
                ) as load_credentials,
                mock.patch(
                    "sciretriever.parsing.adapters.mineru.OperatorManagedMinerUAdapter",
                    side_effect=AssertionError("asset completion constructed Parser"),
                ),
                mock.patch(
                    "sciretriever.agents.providers.openai_responses.OpenAIResponsesAdapter",
                    side_effect=AssertionError("asset completion constructed Analysis"),
                ),
            ):
                graph = bootstrap.build_production_object_graph(
                    configuration,
                    scope=bootstrap.ProductionEntryScope.ASSET_COMPLETION,
                    credentials_home=root / "home",
                    configure_process_logging=False,
                )
            self.assertIsInstance(graph.entry_api, object)
            load_secrets.assert_called_once_with(
                configuration,
                credentials=None,
                include_parser=False,
                include_agents=False,
            )
            load_credentials.assert_not_called()

    def test_scoped_core_missing_credentials_remain_route_scoped(self) -> None:
        import sciretriever.bootstrap as bootstrap

        with tempfile.TemporaryDirectory(prefix="sciretriever-core-preflight-") as temporary:
            root = Path(temporary)
            configuration = parse_configuration(
                f"""
                [paths]
                catalog_path = {str(root / "catalog.sqlite3")!r}
                artifact_root = {str(root / "artifacts")!r}

                [sources.acquisition]
                providers = ["core"]
                """
            )
            graph = bootstrap.build_production_object_graph(
                configuration,
                scope=bootstrap.ProductionEntryScope.ASSET_COMPLETION,
                credentials_home=root / "empty-home",
                configure_process_logging=False,
            )

        operation = cast(Any, graph.entry_api)._operation
        service = cast(Any, operation._acquisition)._service
        binding = service._route_registry.binding_for("api:core")
        self.assertEqual(binding.spec.readiness.value, "unconfigured")
        self.assertIsNone(binding.adapter)

    def test_scoped_wiley_missing_credentials_remain_route_scoped(self) -> None:
        import sciretriever.bootstrap as bootstrap

        with tempfile.TemporaryDirectory(prefix="sciretriever-wiley-preflight-") as temporary:
            root = Path(temporary)
            configuration = parse_configuration(
                f"""
                [paths]
                catalog_path = {str(root / "catalog.sqlite3")!r}
                artifact_root = {str(root / "artifacts")!r}

                [sources.acquisition]
                providers = ["wiley"]
                """
            )
            graph = bootstrap.build_production_object_graph(
                configuration,
                scope=bootstrap.ProductionEntryScope.ASSET_COMPLETION,
                credentials_home=root / "empty-home",
                configure_process_logging=False,
            )

        operation = cast(Any, graph.entry_api)._operation
        service = cast(Any, operation._acquisition)._service
        binding = service._route_registry.binding_for("api:wiley-tdm-v1")
        self.assertEqual(binding.spec.readiness.value, "unconfigured")
        self.assertIsNone(binding.adapter)

    def test_fresh_catalog_builds_an_explicit_application_object_graph(self) -> None:
        from sciretriever.bootstrap import (
            ApplicationObjectGraph,
            build_object_graph,
        )
        from sciretriever.entry.api import EntryApi
        from sciretriever.storage.files.output import AtomicOutput
        from sciretriever.storage.files.paths import StorageRoot
        from sciretriever.storage.files.reader import VerifiedReader
        from sciretriever.storage.files.store import ArtifactStore
        from sciretriever.storage.sqlite.artifact_references import (
            SqliteArtifactReferenceStore,
        )
        from sciretriever.storage.sqlite.discovery_repository import (
            SqliteDiscoveryRepository,
        )
        from sciretriever.storage.sqlite.engine import CatalogEngine
        from sciretriever.storage.sqlite.entry_reader import SqliteEntryReader

        with tempfile.TemporaryDirectory(prefix="sciretriever-e11-") as temporary:
            root = Path(temporary)
            graph = build_object_graph(
                Configuration(),
                catalog_path=root / "catalog.sqlite3",
                artifact_root=root / "artifacts",
                external_dependencies=self._dependencies(),
                credentials_home=root / "home",
            )

        self.assertIsInstance(graph, ApplicationObjectGraph)
        self.assertIsInstance(graph.catalog_engine, CatalogEngine)
        self.assertIsInstance(graph.storage_root, StorageRoot)
        self.assertIsInstance(graph.artifact_store, ArtifactStore)
        self.assertIsInstance(graph.verified_reader, VerifiedReader)
        self.assertIsInstance(graph.atomic_user_output, AtomicOutput)
        self.assertIsInstance(graph.discovery_repository, SqliteDiscoveryRepository)
        self.assertIsInstance(graph.entry_reader, SqliteEntryReader)
        self.assertIsInstance(graph.artifact_reference_store, SqliteArtifactReferenceStore)
        self.assertIsInstance(graph.entry_api, EntryApi)
        registry = cast(Any, graph.metadata_registry)
        http_client = cast(Any, graph.http_client)
        artifact_store = cast(Any, graph.artifact_store)
        verified_reader = cast(Any, graph.verified_reader)
        self.assertIs(graph.topic_provider_limits, registry.topic_limits)
        self.assertIs(graph.citation_provider_limits, registry.citation_limits)
        self.assertIs(http_client._coordinator, graph.access_coordinator)
        self.assertIs(artifact_store._root, graph.storage_root)
        self.assertIs(verified_reader._root, graph.storage_root)
        for operation in EntryApi.__slots__:
            self.assertTrue(callable(getattr(graph.entry_api, operation)))

    def test_write_admission_recovers_artifact_orphans_before_business_writes(self) -> None:
        from sciretriever.bootstrap import build_object_graph
        from sciretriever.model.primitives import sha256_digest

        with tempfile.TemporaryDirectory(prefix="sciretriever-e11-recovery-") as temporary:
            root = Path(temporary)
            graph = build_object_graph(
                Configuration(),
                catalog_path=root / "catalog.sqlite3",
                artifact_root=root / "artifacts",
                external_dependencies=self._dependencies(),
                credentials_home=root / "home",
            )
            payload = b"post-commit-orphan"
            published = cast(Any, graph.artifact_store).publish(
                payload,
                sha256=sha256_digest(payload),
                byte_size=len(payload),
                media_type="application/octet-stream",
            )
            physical = root / "artifacts" / published.path.root
            self.assertTrue(physical.is_file())

            with cast(Any, graph.write_admission).acquire_nowait():
                self.assertFalse(physical.exists())

            with cast(Any, graph.write_admission).acquire_nowait():
                self.assertFalse(physical.exists())

    def test_write_admission_reconciles_only_at_operation_boundaries(self) -> None:
        from sciretriever.bootstrap import build_object_graph
        from sciretriever.model.primitives import sha256_digest

        with tempfile.TemporaryDirectory(prefix="sciretriever-e11-boundaries-") as temporary:
            root = Path(temporary)
            graph = build_object_graph(
                Configuration(),
                catalog_path=root / "catalog.sqlite3",
                artifact_root=root / "artifacts",
                external_dependencies=self._dependencies(),
                credentials_home=root / "home",
            )
            payload = b"published during admitted operation"

            with cast(Any, graph.write_admission).acquire_nowait():
                published = cast(Any, graph.artifact_store).publish(
                    payload,
                    sha256=sha256_digest(payload),
                    byte_size=len(payload),
                    media_type="text/markdown",
                )
                physical = root / "artifacts" / published.path.root
                self.assertTrue(physical.is_file())

            self.assertFalse(physical.exists())

    def test_business_exception_is_not_masked_by_exit_reconciliation(self) -> None:
        from sciretriever.bootstrap import build_object_graph
        from sciretriever.storage.files.reconciliation import ArtifactStoreReconciler

        with tempfile.TemporaryDirectory(prefix="sciretriever-e11-exit-order-") as temporary:
            root = Path(temporary)
            graph = build_object_graph(
                Configuration(),
                catalog_path=root / "catalog.sqlite3",
                artifact_root=root / "artifacts",
                external_dependencies=self._dependencies(),
                credentials_home=root / "home",
            )
            original = RuntimeError("business failure sentinel")

            with (
                mock.patch.object(
                    ArtifactStoreReconciler,
                    "reconcile_admitted",
                    wraps=cast(Any, graph.artifact_reconciler).reconcile_admitted,
                ) as reconcile,
                self.assertRaises(RuntimeError) as caught,
            ):
                with cast(Any, graph.write_admission).acquire_nowait():
                    raise original

            self.assertIs(caught.exception, original)
            self.assertEqual(reconcile.call_count, 1)

    def test_full_graph_wires_shared_network_storage_and_entry_precedence(self) -> None:
        from sciretriever.bootstrap import build_object_graph

        parser_arguments: list[tuple[object, object]] = []
        llm_arguments: list[tuple[object, object]] = []
        shared_agent = _OfflineAgents()

        def parser_factory(http: object, coordinator: object) -> _OfflineParser:
            parser_arguments.append((http, coordinator))
            return _OfflineParser()

        def agents_factory(http: object, coordinator: object) -> _OfflineAgents:
            llm_arguments.append((http, coordinator))
            return shared_agent

        configuration = parse_configuration(
            """
            [discovery]
            metadata_scan_limit = 7
            [sources.metadata]
            providers = ["crossref", "arxiv"]
            [sources.metadata.crossref]
            mode = "anonymous"
            [sources.acquisition]
            providers = ["arxiv"]
            """
        )
        with tempfile.TemporaryDirectory(prefix="sciretriever-e11-wire-") as temporary:
            root = Path(temporary)
            graph = build_object_graph(
                configuration,
                catalog_path=root / "catalog.sqlite3",
                artifact_root=root / "artifacts",
                external_dependencies=self._dependencies(
                    parser_factory=parser_factory,
                    agents_factory=agents_factory,
                ),
                credentials_home=root / "home",
            )
            cast(Any, graph.catalog_engine).validate()

            metadata_registry = cast(Any, graph.metadata_registry)
            expected_precedence = tuple(
                registration.provider_name for registration in metadata_registry.registrations
            )
            for registration in metadata_registry.registrations:
                self.assertIs(registration.adapter._http_client, graph.http_client)
                self.assertIs(
                    registration.adapter._access_coordinator,
                    graph.access_coordinator,
                )

            acquisition_registry = cast(Any, graph.acquisition_registry)
            for binding in acquisition_registry.route_registry.bindings:
                source = binding.adapter
                if hasattr(source, "_direct_source"):
                    source = source._direct_source
                fetcher = getattr(source, "_fetcher", None)
                if fetcher is None:
                    fetcher = getattr(source, "_locator_fetcher", None)
                if fetcher is not None:
                    self.assertIs(fetcher._http_client, graph.http_client)
            doi_landing_resolver = acquisition_registry.planner._doi_landing
            self.assertIs(
                doi_landing_resolver._http_client,
                graph.http_client,
            )

            self.assertIs(cast(Any, graph.discovery_repository)._engine, graph.catalog_engine)
            self.assertIs(cast(Any, graph.entry_reader)._engine, graph.catalog_engine)
            self.assertIs(
                cast(Any, graph.artifact_reference_store)._engine,
                graph.catalog_engine,
            )

            entry = cast(Any, graph.entry_api)
            topic = entry._discover_topic_operation
            citations = entry._discover_citations_operation
            completion = entry._complete_database_operation
            manual = entry._admit_manual_pdf_operation
            bibliography = entry._import_bibliography_operation.__self__
            library = entry._export_artifact_operation.__self__
            for operation in (topic, citations, completion, manual, bibliography):
                self.assertIs(operation._write_admission, graph.write_admission)
            self.assertIs(library._output, graph.atomic_user_output)
            self.assertIs(bibliography._output, graph.atomic_user_output)
            self.assertEqual(topic._provider_precedence, expected_precedence)
            self.assertEqual(citations._provider_precedence, expected_precedence)
            self.assertEqual(bibliography._provider_precedence, expected_precedence)

            analysis = cast(Any, completion)._analysis
            self.assertIs(cast(Any, analysis)._content_service._agents, shared_agent)
            self.assertIs(cast(Any, analysis)._reference_lookup_stage._agents, shared_agent)

        self.assertEqual(parser_arguments, [(graph.http_client, graph.access_coordinator)])
        self.assertEqual(llm_arguments, [(graph.http_client, graph.access_coordinator)])

    def test_parser_and_llm_preflight_fail_before_either_storage_root(self) -> None:
        from sciretriever.bootstrap import BootstrapError, build_object_graph

        cases = (
            (
                self._dependencies(parser_factory=lambda _http, _coordinator: object()),
                "parser-not-ready",
            ),
            (
                self._dependencies(agents_factory=lambda _http, _coordinator: object()),
                "analysis-not-ready",
            ),
        )
        with tempfile.TemporaryDirectory(prefix="sciretriever-e11-preflight-") as temporary:
            root = Path(temporary)
            for index, (dependencies, code) in enumerate(cases):
                with self.subTest(code=code):
                    catalog = root / f"catalog-{index}.sqlite3"
                    artifacts = root / f"artifacts-{index}"
                    with self.assertRaises(BootstrapError) as raised:
                        build_object_graph(
                            Configuration(),
                            catalog_path=catalog,
                            artifact_root=artifacts,
                            external_dependencies=dependencies,
                            credentials_home=root / "home",
                        )
                    self.assertEqual(raised.exception.code, code)
                    self.assertFalse(catalog.exists())
                    self.assertFalse(artifacts.exists())

    def test_fresh_foundation_failure_removes_only_the_owned_pair(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-e11-rollback-") as temporary:
            root = Path(temporary)
            catalog = root / "catalog.sqlite3"
            artifacts = root / "artifacts"
            unrelated = root / "unrelated.lock"
            unrelated.write_text("keep", encoding="utf-8")
            with mock.patch(
                "sciretriever.storage.files.store.ArtifactStore",
                side_effect=RuntimeError("after-catalog"),
            ):
                with self.assertRaises(RuntimeError):
                    bootstrap_storage._build_storage_foundation(catalog, artifacts)

            self.assertFalse(catalog.exists())
            self.assertFalse(artifacts.exists())
            self.assertEqual(unrelated.read_text(encoding="utf-8"), "keep")

    def test_fresh_foundation_closes_owned_descriptors_on_success_and_failure(self) -> None:
        import sciretriever.bootstrap as bootstrap

        with tempfile.TemporaryDirectory(prefix="sciretriever-e11-fd-") as temporary:
            root = Path(temporary)
            opened: list[int] = []
            real_owned_node = bootstrap_storage._owned_node

            def record_owned(path: Path, *, directory: bool) -> Any:
                node = real_owned_node(path, directory=directory)
                opened.append(node.descriptor)
                return node

            with mock.patch.object(
                bootstrap_storage,
                "_owned_node",
                side_effect=record_owned,
            ):
                graph = bootstrap.build_object_graph(
                    Configuration(),
                    catalog_path=root / "ok.sqlite3",
                    artifact_root=root / "ok-artifacts",
                    external_dependencies=self._dependencies(),
                    credentials_home=root / "home",
                )
            self.assertIsInstance(graph.entry_api, object)
            self.assertGreaterEqual(len(opened), 2)
            for descriptor in opened:
                with self.assertRaises(OSError):
                    os.fstat(descriptor)

            opened.clear()
            with (
                mock.patch.object(
                    bootstrap_storage,
                    "_owned_node",
                    side_effect=record_owned,
                ),
                mock.patch(
                    "sciretriever.storage.files.store.ArtifactStore",
                    side_effect=KeyboardInterrupt(),
                ),
                self.assertRaises(KeyboardInterrupt),
            ):
                bootstrap_storage._build_storage_foundation(
                    root / "failed.sqlite3",
                    root / "failed-artifacts",
                )
            for descriptor in opened:
                with self.assertRaises(OSError):
                    os.fstat(descriptor)

    def test_fresh_success_creates_no_sidecar_or_storage_lock(self) -> None:
        from sciretriever.bootstrap import build_object_graph

        with tempfile.TemporaryDirectory(prefix="sciretriever-e11-sidecar-") as temporary:
            root = Path(temporary)
            catalog = root / "catalog.sqlite3"
            artifacts = root / "artifacts"
            graph = build_object_graph(
                Configuration(),
                catalog_path=catalog,
                artifact_root=artifacts,
                external_dependencies=self._dependencies(),
                credentials_home=root / "home",
            )
            cast(Any, graph.catalog_engine).validate()
            for suffix in ("-wal", "-shm", "-journal"):
                self.assertFalse(Path(f"{catalog}{suffix}").exists())
            self.assertFalse((root / ".sciretriever-locks").exists())

    def test_fresh_rollback_preserves_nonempty_or_replaced_evidence(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-e11-race-") as temporary:
            root = Path(temporary)
            for scenario in ("nonempty", "replaced"):
                with self.subTest(scenario=scenario):
                    artifacts = root / scenario
                    os.mkdir(artifacts, 0o700)
                    owned = bootstrap_storage._owned_node(artifacts, directory=True)
                    if scenario == "nonempty":
                        (artifacts / "evidence").write_text("keep", encoding="utf-8")
                    else:
                        artifacts.rmdir()
                        os.mkdir(artifacts, 0o700)
                    bootstrap_storage._rollback_fresh_storage(
                        bootstrap_storage._FreshStorageOwnership(artifact_root=owned)
                    )
                    self.assertTrue(artifacts.exists())

    def test_logging_occurs_only_after_a_complete_graph(self) -> None:
        from sciretriever.bootstrap import build_object_graph

        with tempfile.TemporaryDirectory(prefix="sciretriever-e11-logging-") as temporary:
            root = Path(temporary)
            configured: list[int] = []
            with mock.patch(
                "sciretriever.logging.api.configure_logging",
                side_effect=lambda *, level: configured.append(level),
            ):
                build_object_graph(
                    Configuration(),
                    catalog_path=root / "ok.sqlite3",
                    artifact_root=root / "ok-artifacts",
                    external_dependencies=self._dependencies(),
                    credentials_home=root / "home",
                    configure_process_logging=True,
                )
            self.assertEqual(configured, [20])

            configured.clear()
            with mock.patch(
                "sciretriever.logging.api.configure_logging",
                side_effect=lambda *, level: configured.append(level),
            ):
                with self.assertRaises(RuntimeError):
                    with mock.patch(
                        "sciretriever.storage.sqlite.discovery_repository.SqliteDiscoveryRepository",
                        side_effect=RuntimeError("post-storage"),
                    ):
                        build_object_graph(
                            Configuration(),
                            catalog_path=root / "failed.sqlite3",
                            artifact_root=root / "failed-artifacts",
                            external_dependencies=self._dependencies(),
                            credentials_home=root / "home",
                            configure_process_logging=True,
                        )
            self.assertEqual(configured, [])
            self.assertFalse((root / "failed.sqlite3").exists())
            self.assertFalse((root / "failed-artifacts").exists())

    def test_logging_failure_restores_logger_and_rolls_back_fresh_storage(self) -> None:
        from sciretriever.bootstrap import BootstrapError, build_object_graph

        logger = logging.getLogger("sciretriever")
        host_handler = logging.NullHandler()
        before_handlers = list(logger.handlers)
        before_level = logger.level
        before_propagate = logger.propagate
        before_disabled = logger.disabled
        logger.handlers[:] = [host_handler]
        logger.setLevel(logging.WARNING)
        logger.propagate = True
        logger.disabled = True
        installed = logging.NullHandler()

        def partial_failure(*, level: int) -> None:
            del level
            logger.addHandler(installed)
            logger.setLevel(logging.DEBUG)
            logger.propagate = False
            logger.disabled = False
            raise RuntimeError("sentinel-secret /private/catalog.sqlite3")

        try:
            with tempfile.TemporaryDirectory(prefix="sciretriever-e11-logfail-") as temporary:
                root = Path(temporary)
                with (
                    mock.patch(
                        "sciretriever.logging.api.configure_logging",
                        side_effect=partial_failure,
                    ),
                    self.assertRaises(BootstrapError) as raised,
                ):
                    build_object_graph(
                        Configuration(),
                        catalog_path=root / "catalog.sqlite3",
                        artifact_root=root / "artifacts",
                        external_dependencies=self._dependencies(),
                        credentials_home=root / "home",
                        configure_process_logging=True,
                    )
                self.assertEqual(raised.exception.code, "assembly-failed")
                self.assertIsNone(raised.exception.__cause__)
                self.assertNotIn("sentinel-secret", repr(raised.exception))
                self.assertFalse((root / "catalog.sqlite3").exists())
                self.assertFalse((root / "artifacts").exists())
            self.assertEqual(logger.handlers, [host_handler])
            self.assertEqual(logger.level, logging.WARNING)
            self.assertTrue(logger.propagate)
            self.assertTrue(logger.disabled)
        finally:
            logger.handlers[:] = before_handlers
            logger.setLevel(before_level)
            logger.propagate = before_propagate
            logger.disabled = before_disabled

    def test_scoped_logging_failure_restores_logger_and_rolls_back_fresh_storage(self) -> None:
        import sciretriever.bootstrap as bootstrap

        logger = logging.getLogger("sciretriever")
        host_handler = logging.NullHandler()
        before_handlers = list(logger.handlers)
        before_level = logger.level
        before_propagate = logger.propagate
        before_disabled = logger.disabled
        logger.handlers[:] = [host_handler]
        logger.setLevel(logging.WARNING)
        logger.propagate = True
        logger.disabled = True
        installed = logging.NullHandler()

        def partial_failure(*, level: int) -> None:
            del level
            logger.addHandler(installed)
            logger.setLevel(logging.DEBUG)
            logger.propagate = False
            logger.disabled = False
            raise RuntimeError("sentinel-secret /private/catalog.sqlite3")

        try:
            with tempfile.TemporaryDirectory(prefix="sciretriever-e13-logfail-") as temporary:
                root = Path(temporary)
                configuration = parse_configuration(
                    f"""
                    [paths]
                    catalog_path = {str(root / "catalog.sqlite3")!r}
                    artifact_root = {str(root / "artifacts")!r}
                    """
                )
                with (
                    mock.patch(
                        "sciretriever.logging.api.configure_logging",
                        side_effect=partial_failure,
                    ),
                    self.assertRaises(bootstrap.BootstrapError) as raised,
                ):
                    bootstrap.build_production_object_graph(
                        configuration,
                        scope=bootstrap.ProductionEntryScope.LOCAL_LIBRARY,
                        configure_process_logging=True,
                    )
                self.assertEqual(raised.exception.code, "assembly-failed")
                self.assertIsNone(raised.exception.__cause__)
                self.assertNotIn("sentinel-secret", repr(raised.exception))
                self.assertNotIn(str(root), repr(raised.exception))
                self.assertFalse((root / "catalog.sqlite3").exists())
                self.assertFalse((root / "artifacts").exists())
            self.assertEqual(logger.handlers, [host_handler])
            self.assertEqual(logger.level, logging.WARNING)
            self.assertTrue(logger.propagate)
            self.assertTrue(logger.disabled)
        finally:
            logger.handlers[:] = before_handlers
            logger.setLevel(before_level)
            logger.propagate = before_propagate
            logger.disabled = before_disabled

    def test_production_graph_loads_credentials_once(self) -> None:
        import sciretriever.bootstrap as bootstrap
        import sciretriever.configuration as configuration_boundary

        with tempfile.TemporaryDirectory(prefix="sciretriever-e11-single-") as temporary:
            root = Path(temporary)
            configuration = _production_configuration(root)
            credentials_home = root / "home"
            credentials_home.mkdir(mode=0o700)
            set_core_credentials(
                "agents",
                secret="offline-key",
                origin="https://api.openai.com",
                home=credentials_home,
            )
            original = configuration_boundary.load_credentials
            calls: list[object] = []

            def one_load(*, home: Any = None) -> Any:
                calls.append(home)
                if len(calls) > 1:
                    raise AssertionError("credentials must not be read twice")
                return original(home=home)

            with mock.patch.object(
                bootstrap_assembly,
                "load_credentials",
                side_effect=one_load,
            ):
                graph = bootstrap.build_production_object_graph(
                    configuration,
                    credentials_home=credentials_home,
                    configure_process_logging=False,
                )
            self.assertEqual(len(calls), 1)
            self.assertIsInstance(graph.entry_api, object)

    def test_production_assembly_performs_no_external_io(self) -> None:
        import sciretriever.bootstrap as bootstrap

        def forbidden(label: str) -> Any:
            return mock.patch(label, side_effect=AssertionError(f"external I/O: {label}"))

        with tempfile.TemporaryDirectory(prefix="sciretriever-e11-noio-") as temporary:
            root = Path(temporary)
            configuration = _production_configuration(root)
            credentials_home = root / "home"
            credentials_home.mkdir(mode=0o700)
            set_core_credentials(
                "agents",
                secret="offline-key",
                origin="https://api.openai.com",
                home=credentials_home,
            )
            with (
                forbidden("sciretriever.network.http.SystemResolver.resolve"),
                forbidden("sciretriever.network.http.SecureHttpTransport.send"),
                forbidden("sciretriever.network.http.HttpClient.request"),
                forbidden("sciretriever.network.browser.BrowserClient.run"),
                forbidden(
                    "sciretriever.parsing.adapters.mineru.MinerUProtocol2ServiceClient.health"
                ),
                forbidden(
                    "sciretriever.parsing.adapters.mineru.OperatorManagedMinerUAdapter.parse"
                ),
                forbidden("sciretriever.agents.providers.base.ProviderHttpAdapterBase.complete"),
                forbidden("sciretriever.metadata.registry.MetadataProbeRegistry.probe"),
            ):
                graph = bootstrap.build_production_object_graph(
                    configuration,
                    credentials_home=credentials_home,
                    configure_process_logging=False,
                )
            self.assertIsInstance(graph.entry_api, object)

    def test_production_errors_are_stable_path_secret_free_and_without_cause(self) -> None:
        import sciretriever.bootstrap as bootstrap
        from sciretriever.acquisition.registry import AcquisitionRegistryError
        from sciretriever.metadata.registry import MetadataRegistryError
        from sciretriever.storage.files.store import ArtifactStoreError

        with tempfile.TemporaryDirectory(prefix="sciretriever-e11-errors-") as temporary:
            root = Path(temporary)
            configuration = _production_configuration(root)
            credentials_home = root / "home"
            credentials_home.mkdir(mode=0o700)
            set_core_credentials(
                "agents",
                secret="offline-key",
                origin="https://api.openai.com",
                home=credentials_home,
            )
            cases: tuple[tuple[str, str, type[Exception]], ...] = (
                (
                    "sciretriever.metadata.registry.build_metadata_registry",
                    "metadata-not-ready",
                    MetadataRegistryError,
                ),
                (
                    "sciretriever.acquisition.registry.build_acquisition_registry",
                    "acquisition-not-ready",
                    AcquisitionRegistryError,
                ),
                (
                    "sciretriever.storage.files.store.ArtifactStore",
                    "storage-unavailable",
                    ArtifactStoreError,
                ),
                (
                    "sciretriever.storage.sqlite.discovery_repository.SqliteDiscoveryRepository",
                    "assembly-failed",
                    RuntimeError,
                ),
            )
            for index, (target, expected, exception_type) in enumerate(cases):
                with self.subTest(code=expected):
                    secret = f"sentinel-secret-{index}"
                    error = exception_type(f"{secret} {root / 'private.sqlite3'}")
                    with (
                        mock.patch(target, side_effect=error),
                        self.assertRaises(bootstrap.BootstrapError) as raised,
                    ):
                        bootstrap.build_production_object_graph(
                            configuration,
                            credentials_home=credentials_home,
                            configure_process_logging=False,
                        )
                    self.assertEqual(raised.exception.code, expected)
                    self.assertIsNone(raised.exception.__cause__)
                    self.assertNotIn(secret, repr(raised.exception))
                    self.assertNotIn(str(root), repr(raised.exception))
                    self.assertFalse((root / "catalog.sqlite3").exists())
                    self.assertFalse((root / "artifacts").exists())

    def test_scoped_storage_and_internal_type_errors_use_stable_assembly_codes(self) -> None:
        import sciretriever.bootstrap as bootstrap
        from sciretriever.storage.files.store import ArtifactStoreError

        with tempfile.TemporaryDirectory(prefix="sciretriever-e13-errors-") as temporary:
            root = Path(temporary)
            cases: tuple[tuple[type[Exception], str], ...] = (
                (ArtifactStoreError, "storage-unavailable"),
                (TypeError, "assembly-failed"),
            )
            for index, (exception_type, expected) in enumerate(cases):
                with self.subTest(code=expected):
                    catalog = root / f"catalog-{index}.sqlite3"
                    artifacts = root / f"artifacts-{index}"
                    configuration = parse_configuration(
                        f"""
                        [paths]
                        catalog_path = {str(catalog)!r}
                        artifact_root = {str(artifacts)!r}
                        """
                    )
                    secret = f"sentinel-secret-{index}"
                    error = exception_type(f"{secret} {root / 'private.sqlite3'}")
                    with (
                        mock.patch(
                            "sciretriever.storage.files.store.ArtifactStore",
                            side_effect=error,
                        ),
                        self.assertRaises(bootstrap.BootstrapError) as raised,
                    ):
                        bootstrap.build_production_object_graph(
                            configuration,
                            scope=bootstrap.ProductionEntryScope.LOCAL_LIBRARY,
                            configure_process_logging=False,
                        )
                    self.assertEqual(raised.exception.code, expected)
                    self.assertIsNone(raised.exception.__cause__)
                    self.assertNotIn(secret, repr(raised.exception))
                    self.assertNotIn(str(root), repr(raised.exception))
                    self.assertFalse(catalog.exists())
                    self.assertFalse(artifacts.exists())

    def test_probe_session_uses_one_snapshot_and_no_runtime_or_storage(self) -> None:
        import sciretriever.bootstrap as bootstrap
        import sciretriever.configuration as configuration_boundary

        configuration = _probe_configuration()
        loads: list[object] = []
        status_bundles: list[object] = []
        registry_bundles: list[object] = []
        original_status = bootstrap_probes.configuration_status
        from sciretriever.metadata import registry as metadata_registry_boundary

        original_registry = metadata_registry_boundary.build_metadata_probe_registry

        def load_once(*, home: Any = None) -> Any:
            loads.append(home)
            return first if len(loads) == 1 else second

        def record_status(
            value: Configuration,
            *,
            credentials: Any = None,
            configured_sci_hub_resolver: Any = None,
        ) -> Any:
            status_bundles.append(credentials)
            return original_status(
                value,
                credentials=credentials,
                configured_sci_hub_resolver=configured_sci_hub_resolver,
            )

        def record_registry(value: Any, credentials: Any, dependencies: Any) -> Any:
            registry_bundles.append(credentials)
            return original_registry(value, credentials, dependencies)

        forbidden = (
            "sciretriever.storage.sqlite.engine.CatalogEngine",
            "sciretriever.storage.files.paths.StorageRoot",
            "sciretriever.storage.files.store.ArtifactStore",
            "sciretriever.entry.api.EntryApi",
            "sciretriever.logging.api.configure_logging",
        )
        with tempfile.TemporaryDirectory(prefix="sciretriever-e11-probe-") as temporary:
            root = Path(temporary)
            first = load_credentials(home=root / "first-home")
            second_home = root / "second-home"
            second_home.mkdir(mode=0o700)
            set_credentials(
                ProviderName.CORE,
                {"api_key": "must-never-load"},
                home=second_home,
            )
            second = load_credentials(home=second_home)
            patches = [
                mock.patch(name, side_effect=AssertionError("probe session side effect"))
                for name in forbidden
            ]
            with (
                patches[0],
                patches[1],
                patches[2],
                patches[3],
                patches[4],
                mock.patch.object(
                    bootstrap_probes,
                    "load_credentials",
                    side_effect=load_once,
                ),
                mock.patch.object(
                    bootstrap_probes,
                    "configuration_status",
                    side_effect=record_status,
                ),
                mock.patch.object(
                    metadata_registry_boundary,
                    "build_metadata_probe_registry",
                    side_effect=record_registry,
                ),
                mock.patch.object(
                    bootstrap_probes,
                    "load_runtime_secrets",
                    side_effect=AssertionError("probe session read runtime environment"),
                ),
                mock.patch(
                    "sciretriever.metadata.providers.crossref.CrossrefAdapter.probe_metadata",
                    side_effect=AssertionError("factory invoked a probe"),
                ) as probe,
            ):
                session = bootstrap.build_production_configuration_probe_session(
                    configuration,
                    credentials_home=root / "home",
                )
                self.assertEqual(probe.call_count, 0)

            self.assertEqual(loads, [root / "home"])
            self.assertEqual(status_bundles, [first])
            self.assertEqual(registry_bundles, [first])
            self.assertIs(session.probe_port.http_client, session.http_client)
            self.assertIs(
                session.probe_port.access_coordinator,
                session.access_coordinator,
            )
            self.assertIs(session.http_client._coordinator, session.access_coordinator)
            self.assertEqual(session.browser_status.production_route_count, 9)
            self.assertEqual(session.browser_status.automatic_route_count, 9)
            self.assertFalse(session.browser_status.automatic_acquisition_available)
            self.assertFalse(session.browser_status.runtime.launch_assessed)
            self.assertEqual(session.browser_status.mode, "headed-fixed-profile")
            self.assertFalse(session.browser_status.interactive_authentication_supported)
            self.assertEqual(session.browser_status.article_entitlement, "checked-per-article")
            self.assertEqual(
                session.browser_probe_port.supported_access_keys,
                frozenset(),
            )
            self.assertEqual(
                session.probe_port.supported_capabilities,
                frozenset(
                    (provider, ProviderCapability.METADATA)
                    for provider in (
                        ProviderName.WEB_OF_SCIENCE,
                        ProviderName.CROSSREF,
                        ProviderName.SEMANTIC_SCHOLAR,
                        ProviderName.ARXIV,
                        ProviderName.OPENALEX,
                        ProviderName.EUROPE_PMC,
                        ProviderName.ELSEVIER,
                        ProviderName.SPRINGER,
                        ProviderName.DATACITE,
                        ProviderName.CORE,
                        ProviderName.OPENCITATIONS,
                    )
                ),
            )
            self.assertFalse(root.joinpath("catalog.sqlite3").exists())
            self.assertFalse(root.joinpath("artifacts").exists())

            with (
                mock.patch.object(
                    bootstrap_probes,
                    "load_credentials",
                    side_effect=AssertionError("run reread credentials"),
                ),
                mock.patch.object(
                    configuration_boundary,
                    "configuration_status",
                    side_effect=AssertionError("run recomputed status"),
                ),
                mock.patch.object(
                    type(session.probe_port),
                    "probe",
                    return_value=_passed_probe(ProviderName.CROSSREF),
                ) as run_probe,
            ):
                summary = session.run(provider=ProviderName.CROSSREF)
                browser = session.run_browser("springerlink")
            self.assertTrue(summary.passed)
            self.assertIs(browser.outcome, ProbeOutcome.SKIPPED)
            self.assertEqual(
                browser.failure_code,
                "browser-disabled",
            )
            self.assertEqual(browser.navigation_count, 0)
            run_probe.assert_called_once_with(
                ProviderName.CROSSREF,
                ProviderCapability.METADATA,
            )

    def test_probe_session_selection_is_named_or_enabled_and_metadata_only(self) -> None:
        import sciretriever.bootstrap as bootstrap

        with tempfile.TemporaryDirectory(prefix="sciretriever-e11-selection-") as temporary:
            root = Path(temporary)
            session = bootstrap.build_production_configuration_probe_session(
                _probe_configuration(),
                credentials_home=root / "home",
            )
            calls: list[tuple[ProviderName, ProviderCapability]] = []

            def pass_probe(
                provider: ProviderName,
                capability: ProviderCapability,
            ) -> Any:
                calls.append((provider, capability))
                return _passed_probe(provider)

            with mock.patch.object(
                type(session.probe_port),
                "probe",
                side_effect=pass_probe,
            ):
                named = session.run(provider=ProviderName.ARXIV)
                all_enabled = session.run(test_all=True)
                skipped = session.run(provider=ProviderName.WEB_OF_SCIENCE)

            self.assertEqual(
                calls,
                [
                    (ProviderName.ARXIV, ProviderCapability.METADATA),
                    (ProviderName.CROSSREF, ProviderCapability.METADATA),
                ],
            )
            self.assertTrue(named.passed)
            self.assertTrue(all_enabled.passed)
            self.assertEqual(skipped.results[0].outcome, ProbeOutcome.SKIPPED)
            self.assertTrue(
                all(
                    result.capability is ProviderCapability.METADATA
                    for summary in (named, all_enabled, skipped)
                    for result in summary.results
                )
            )

    def test_enabled_production_browser_probe_uses_the_publisher_session_key(self) -> None:
        import sciretriever.bootstrap as bootstrap
        from sciretriever.model.access import AccessFailure
        from sciretriever.network.browser import BrowserClient

        with tempfile.TemporaryDirectory(prefix="sciretriever-browser-probe-") as temporary:
            home = Path(temporary) / "home"
            home.mkdir(mode=0o700)
            initialize_browser_profile("fixture-profile", home=home)
            configuration = parse_configuration(
                """
                [access]
                browser_enabled = true
                browser_profile = "fixture-profile"
                """
            )
            with _ready_cloak_probe_patches():
                session = bootstrap.build_production_configuration_probe_session(
                    configuration,
                    credentials_home=home,
                )
            no_download = AccessFailure(
                code="no-download",
                reason="The fixture Browser produced no download.",
                action="Inspect the fixture Browser state.",
                retryable=False,
            )
            with mock.patch.object(
                BrowserClient,
                "run",
                return_value=no_download,
            ) as run_browser:
                result = session.run_browser("springerlink")

            self.assertIs(result.outcome, ProbeOutcome.FAILED)
            self.assertEqual(result.failure_code, "browser-probe-target-unreachable")
            self.assertEqual(run_browser.call_count, 1)
            session_key = run_browser.call_args.kwargs["session_key"]
            self.assertIs(type(session_key), str)
            self.assertEqual(session_key, "springerlink")
            self.assertIs(run_browser.call_args.kwargs["navigation_only"], False)

    def test_each_browser_probe_keeps_its_own_policy_session_and_landing_origin(
        self,
    ) -> None:
        import sciretriever.bootstrap as bootstrap
        from sciretriever.model.access import AccessFailure
        from sciretriever.network.admission import AccessPolicy, AccessScope
        from sciretriever.network.browser import (
            BrowserClient,
            BrowserDestinationKind,
            BrowserPageObservation,
        )

        expected = {
            "acs-publications": (
                "acs-publications",
                "acs-publications",
                "https://pubs.acs.org",
                30.0,
            ),
            "aip-publishing": (
                "aip-publishing",
                "aip-publishing",
                "https://pubs.aip.org",
                30.0,
            ),
            "elsevier-sciencedirect": (
                "elsevier",
                "elsevier",
                "https://www.sciencedirect.com",
                20.0,
            ),
            "iopscience": (
                "iopscience",
                "iopscience",
                "https://iopscience.iop.org",
                30.0,
            ),
            "oxford-academic": (
                "oxford-academic",
                "oxford-academic",
                "https://academic.oup.com",
                30.0,
            ),
            "rsc-publishing": (
                "rsc-publishing",
                "rsc-publishing",
                "https://pubs.rsc.org",
                30.0,
            ),
            "science-aaas": (
                "science-aaas",
                "science-aaas",
                "https://www.science.org",
                30.0,
            ),
            "springerlink": (
                "springerlink",
                "springerlink",
                "https://link.springer.com",
                10.0,
            ),
            "wiley-online-library": (
                "wiley",
                "wiley",
                "https://onlinelibrary.wiley.com",
                20.0,
            ),
        }
        with tempfile.TemporaryDirectory(prefix="sciretriever-browser-probes-") as temporary:
            home = Path(temporary) / "home"
            home.mkdir(mode=0o700)
            initialize_browser_profile("fixture-profile", home=home)
            configuration = parse_configuration(
                """
                [access]
                browser_enabled = true
                browser_profile = "fixture-profile"
                """
            )
            with _ready_cloak_probe_patches():
                session = bootstrap.build_production_configuration_probe_session(
                    configuration,
                    credentials_home=home,
                )

            self.assertEqual(session.browser_status.production_route_count, 9)
            self.assertEqual(session.browser_status.automatic_route_count, 9)
            self.assertTrue(session.browser_status.automatic_acquisition_available)
            targets = cast(Any, session.browser_probe_port)._targets
            self.assertEqual(set(targets), set(expected))
            for access_key, (group, session_key, origin, interval) in expected.items():
                with self.subTest(access_key=access_key):
                    target = targets[access_key]
                    self.assertEqual(target.policy.rate_limit_group, group)
                    self.assertEqual(target.policy.minimum_start_interval, interval)
                    self.assertEqual(target.session_key, session_key)
                    self.assertEqual(target.rule.landing_origin, origin)

            no_download = AccessFailure(
                code="no-download",
                reason="The fixture Browser produced no download.",
                action="Inspect the fixture Browser state.",
                retryable=False,
            )
            observed: list[tuple[AccessScope, str, AccessPolicy, str]] = []

            def reached(
                _client: BrowserClient,
                scope: AccessScope,
                request: str,
                policy: AccessPolicy,
                **kwargs: Any,
            ) -> AccessFailure:
                destination_guard = cast(Any, kwargs["destination_guard"])
                destination_guard.check(
                    request,
                    BrowserDestinationKind.INITIAL_NAVIGATION,
                )
                flow_session = mock.Mock()
                flow_session.observe.return_value = BrowserPageObservation(
                    locator=request,
                    status_code=200,
                )
                cast(Any, kwargs["controller"]).execution.run(flow_session)
                observed.append((scope, request, policy, cast(str, kwargs["session_key"])))
                return no_download

            with mock.patch.object(
                BrowserClient,
                "run",
                autospec=True,
                side_effect=reached,
            ) as run_browser:
                results = {access_key: session.run_browser(access_key) for access_key in expected}
                unknown = session.run_browser("unknown-publisher")

            self.assertTrue(
                all(result.outcome is ProbeOutcome.PASSED for result in results.values())
            )
            self.assertTrue(
                all(result.article_entitlement == "not-proven" for result in results.values())
            )
            self.assertIs(unknown.outcome, ProbeOutcome.SKIPPED)
            self.assertEqual(unknown.failure_code, "browser-production-route-unavailable")
            self.assertEqual(run_browser.call_count, len(expected))
            self.assertEqual(
                observed,
                [
                    (
                        AccessScope(group, "web"),
                        f"{origin}/",
                        AccessPolicy(max_concurrency=1),
                        session_key,
                    )
                    for group, session_key, origin, _interval in expected.values()
                ],
            )

    def test_springerlink_probe_rejects_login_redirect_as_target_unreachable(self) -> None:
        import sciretriever.bootstrap as bootstrap
        from sciretriever.model.access import AccessFailure
        from sciretriever.network.browser import (
            BrowserClient,
            BrowserDestinationKind,
            BrowserPageObservation,
        )

        with tempfile.TemporaryDirectory(prefix="sciretriever-browser-probe-") as temporary:
            home = Path(temporary) / "home"
            home.mkdir(mode=0o700)
            initialize_browser_profile("fixture-profile", home=home)
            configuration = parse_configuration(
                """
                [access]
                browser_enabled = true
                browser_profile = "fixture-profile"
                """
            )
            with _ready_cloak_probe_patches():
                session = bootstrap.build_production_configuration_probe_session(
                    configuration,
                    credentials_home=home,
                )
            no_download = AccessFailure(
                code="no-download",
                reason="The fixture Browser produced no download.",
                action="Inspect the fixture Browser state.",
                retryable=False,
            )

            def redirected_login(*_args: object, **kwargs: Any) -> AccessFailure:
                destination_guard = cast(Any, kwargs["destination_guard"])
                destination_guard.check(
                    "https://idp.springer.com/authorize",
                    BrowserDestinationKind.NAVIGATION,
                )
                controller = cast(Any, kwargs["controller"])
                flow_session = mock.Mock()
                flow_session.observe.return_value = BrowserPageObservation(
                    locator="https://idp.springer.com/authorize",
                    status_code=200,
                )
                controller.execution.run(flow_session)
                return no_download

            with mock.patch.object(
                BrowserClient,
                "run",
                side_effect=redirected_login,
            ):
                result = session.run_browser("springerlink")

            self.assertIs(result.outcome, ProbeOutcome.FAILED)
            self.assertEqual(result.failure_code, "browser-probe-target-unreachable")
            self.assertTrue(result.browser_launched)
            self.assertFalse(result.minimal_target_reached)
            self.assertEqual(result.article_entitlement, "not-proven")
            self.assertEqual(result.navigation_count, 1)

    def test_wiley_probe_accepts_reviewed_landing_origin_alias(self) -> None:
        import sciretriever.bootstrap as bootstrap
        from sciretriever.model.access import AccessFailure
        from sciretriever.network.browser import (
            BrowserClient,
            BrowserDestinationKind,
            BrowserPageObservation,
        )

        with tempfile.TemporaryDirectory(prefix="sciretriever-browser-probe-alias-") as temporary:
            home = Path(temporary) / "home"
            home.mkdir(mode=0o700)
            initialize_browser_profile("fixture-profile", home=home)
            configuration = parse_configuration(
                """
                [access]
                browser_enabled = true
                browser_profile = "fixture-profile"
                """
            )
            with _ready_cloak_probe_patches():
                session = bootstrap.build_production_configuration_probe_session(
                    configuration,
                    credentials_home=home,
                )
            no_download = AccessFailure(
                code="no-download",
                reason="The fixture Browser produced no download.",
                action="Inspect the fixture Browser state.",
                retryable=False,
            )

            def reached_alias(*_args: object, **kwargs: Any) -> AccessFailure:
                destination_guard = cast(Any, kwargs["destination_guard"])
                destination_guard.check(
                    "https://onlinelibrary.wiley.com/",
                    BrowserDestinationKind.INITIAL_NAVIGATION,
                )
                controller = cast(Any, kwargs["controller"])
                flow_session = mock.Mock()
                flow_session.observe.return_value = BrowserPageObservation(
                    locator="https://advanced.onlinelibrary.wiley.com/doi/10.1000/fixture",
                    status_code=200,
                )
                controller.execution.run(flow_session)
                return no_download

            with mock.patch.object(BrowserClient, "run", side_effect=reached_alias):
                result = session.run_browser("wiley-online-library")

            self.assertIs(result.outcome, ProbeOutcome.PASSED)
            self.assertTrue(result.minimal_target_reached)
            self.assertEqual(result.navigation_count, 1)

    def test_wiley_probe_uses_reviewed_challenge_dependency_facts(self) -> None:
        import sciretriever.bootstrap as bootstrap
        from sciretriever.model.access import AccessFailure
        from sciretriever.network.browser import (
            BrowserClient,
            BrowserDestinationKind,
            BrowserPageObservation,
            BrowserRequestObservation,
        )

        with tempfile.TemporaryDirectory(
            prefix="sciretriever-browser-probe-challenge-"
        ) as temporary:
            home = Path(temporary) / "home"
            home.mkdir(mode=0o700)
            initialize_browser_profile("fixture-profile", home=home)
            configuration = parse_configuration(
                """
                [access]
                browser_enabled = true
                browser_profile = "fixture-profile"
                """
            )
            with _ready_cloak_probe_patches():
                session = bootstrap.build_production_configuration_probe_session(
                    configuration,
                    credentials_home=home,
                )
            no_download = AccessFailure(
                code="no-download",
                reason="The fixture Browser produced no download.",
                action="Inspect the fixture Browser state.",
                retryable=False,
            )

            def reached_with_challenge(*_args: object, **kwargs: Any) -> AccessFailure:
                destination_guard = cast(Any, kwargs["destination_guard"])
                destination_guard.check(
                    "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/v1",
                    BrowserDestinationKind.REQUEST,
                )
                destination_guard.check_request(
                    BrowserRequestObservation(
                        locator="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/v1",
                        kind=BrowserDestinationKind.REQUEST,
                        resource_type="script",
                        is_navigation=False,
                        is_top_frame=False,
                        frame_depth=1,
                        frame_ancestry=("https://onlinelibrary.wiley.com/",),
                        top_frame_locator="https://onlinelibrary.wiley.com/",
                    )
                )
                cast(Any, kwargs["controller"]).execution.run(
                    mock.Mock(
                        observe=mock.Mock(
                            return_value=BrowserPageObservation(
                                locator="https://advanced.onlinelibrary.wiley.com/doi/10.1000/fixture",
                                status_code=200,
                            )
                        )
                    )
                )
                return no_download

            with mock.patch.object(BrowserClient, "run", side_effect=reached_with_challenge):
                result = session.run_browser("wiley-online-library")

        self.assertIs(result.outcome, ProbeOutcome.PASSED)
        self.assertTrue(result.challenge_dependency_declared)
        self.assertEqual(result.challenge_resource_admitted_count, 1)
        self.assertEqual(result.challenge_resource_blocked_count, 0)
        self.assertFalse(result.persisted)
        payload = result.model_dump(mode="json")
        self.assertEqual(payload["challenge_dependency_declared"], True)
        self.assertEqual(payload["challenge_resource_admitted_count"], 1)
        self.assertEqual(payload["challenge_resource_blocked_count"], 0)
        self.assertNotIn("cloudflare", str(payload).casefold())

    def test_wiley_probe_rejects_unreviewed_challenge_and_login_origins(self) -> None:
        import sciretriever.bootstrap as bootstrap
        from sciretriever.model.access import AccessFailure
        from sciretriever.network.browser import (
            BrowserClient,
            BrowserDestinationKind,
            BrowserPageObservation,
            BrowserRequestObservation,
        )

        with tempfile.TemporaryDirectory(prefix="sciretriever-browser-probe-guard-") as temporary:
            home = Path(temporary) / "home"
            home.mkdir(mode=0o700)
            initialize_browser_profile("fixture-profile", home=home)
            configuration = parse_configuration(
                """
                [access]
                browser_enabled = true
                browser_profile = "fixture-profile"
                """
            )
            with _ready_cloak_probe_patches():
                session = bootstrap.build_production_configuration_probe_session(
                    configuration,
                    credentials_home=home,
                )
            no_download = AccessFailure(
                code="no-download",
                reason="The fixture Browser produced no download.",
                action="Inspect the fixture Browser state.",
                retryable=False,
            )

            def rejected_challenge(*_args: object, **kwargs: Any) -> AccessFailure:
                destination_guard = cast(Any, kwargs["destination_guard"])
                with self.assertRaises(ValueError):
                    destination_guard.check(
                        "https://idp.wiley.com/login",
                        BrowserDestinationKind.NAVIGATION,
                    )
                destination_guard.check(
                    "https://challenges.cloudflare.com/other/not-reviewed",
                    BrowserDestinationKind.REQUEST,
                )
                with self.assertRaises(ValueError):
                    destination_guard.check_request(
                        BrowserRequestObservation(
                            locator="https://challenges.cloudflare.com/other/not-reviewed",
                            kind=BrowserDestinationKind.REQUEST,
                            resource_type="script",
                            is_navigation=False,
                            is_top_frame=False,
                            frame_depth=1,
                            frame_ancestry=("https://onlinelibrary.wiley.com/",),
                            top_frame_locator="https://onlinelibrary.wiley.com/",
                        )
                    )
                cast(Any, kwargs["controller"]).execution.run(
                    mock.Mock(
                        observe=mock.Mock(
                            return_value=BrowserPageObservation(
                                locator="https://onlinelibrary.wiley.com/",
                                status_code=200,
                            )
                        )
                    )
                )
                return no_download

            with mock.patch.object(BrowserClient, "run", side_effect=rejected_challenge):
                result = session.run_browser("wiley-online-library")

        self.assertIs(result.outcome, ProbeOutcome.FAILED)
        self.assertEqual(result.failure_code, "browser-probe-challenge-resource-blocked")
        self.assertTrue(result.browser_launched)
        self.assertTrue(result.minimal_target_reached)
        self.assertTrue(result.challenge_dependency_declared)
        self.assertEqual(result.challenge_resource_admitted_count, 0)
        self.assertEqual(result.challenge_resource_blocked_count, 1)
        self.assertEqual(result.navigation_count, 1)


class _OfflineParser:
    def parse(
        self,
        request: ParserRequest,
        *,
        cancel_event: threading.Event | None = None,
    ) -> StagedParserOutput:
        del request, cancel_event
        raise AssertionError("construction must not invoke the Parser")


class _OfflineAgents(AgentPort):
    @property
    def provider_name(self) -> str:
        return "offline-analysis"

    def complete(self, request: AgentRequest) -> AgentResult:
        del request
        raise AssertionError("construction must not invoke the LLM")


if __name__ == "__main__":
    unittest.main()
