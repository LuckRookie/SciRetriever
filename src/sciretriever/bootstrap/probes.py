"""No-Storage configuration probe session and explicit probe assembly."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from sciretriever.acquisition.sources.configured_sci_hub import ConfiguredLocatorResolver
from sciretriever.bootstrap.browser import (
    _new_acquisition_execution_runtime,
    _ProductionBrowserConfigurationProbePort,
)
from sciretriever.bootstrap.errors import BootstrapError
from sciretriever.bootstrap.services import (
    _build_analysis_llm,
    _new_observation_id,
    _new_provenance_id,
    _new_shared_network,
    _UtcClock,
)
from sciretriever.configuration import (
    BrowserConfigurationProbePort,
    ConfigurationError,
    CredentialLookup,
    browser_access_status,
    configuration_runtime_status,
    configuration_status,
    eligible_production_browser_access_keys,
    load_credentials,
    load_runtime_secrets,
    run_browser_configuration_probe,
    run_configuration_probes,
)
from sciretriever.model.configuration import (
    BrowserAccessStatus,
    BrowserConfigurationProbeResult,
    Configuration,
    ConfigurationProbeSummary,
    ConfigurationStatus,
    CoreConfigurationProbeResult,
    CoreCredentialService,
    LLMConfigurationProbeDetails,
    MinerUConfigurationProbeDetails,
    ParserConnectionMode,
    ProbeOutcome,
    ProviderName,
)
from sciretriever.network.admission import AccessCoordinator
from sciretriever.network.http import HttpClient

if TYPE_CHECKING:
    from sciretriever.metadata.registry import MetadataProbeRegistry
    from sciretriever.network.browser_sessions import BrowserSessionBroker


@dataclass(frozen=True, slots=True)
class ProductionConfigurationProbeSession:
    """A no-Storage configuration-test session from one credential snapshot."""

    configuration: Configuration
    credentials: CredentialLookup = field(repr=False)
    status: ConfigurationStatus
    probe_port: MetadataProbeRegistry = field(repr=False)
    access_coordinator: AccessCoordinator = field(repr=False)
    http_client: HttpClient = field(repr=False)
    browser_status: BrowserAccessStatus
    browser_probe_port: BrowserConfigurationProbePort = field(repr=False)
    browser_session_broker: BrowserSessionBroker = field(repr=False)

    def close(self) -> None:
        """Close any Browser session started by an explicit live probe."""

        self.browser_session_broker.close()

    def __enter__(self) -> ProductionConfigurationProbeSession:
        return self

    def __exit__(self, *unused: object) -> None:
        self.close()

    def run(
        self,
        *,
        provider: ProviderName | str | None = None,
        test_all: bool = False,
    ) -> ConfigurationProbeSummary:
        return run_configuration_probes(
            self.configuration,
            self.probe_port,
            provider=provider,
            test_all=test_all,
            status_snapshot=self.status,
        )

    def run_browser(self, access_key: str) -> BrowserConfigurationProbeResult:
        """Run one explicitly selected production-approved Browser target."""

        return run_browser_configuration_probe(
            access_key,
            self.browser_probe_port,
            status_snapshot=self.browser_status,
        )

    def run_llm(self) -> CoreConfigurationProbeResult:
        """Run one minimal strict LLM request without user Literature content."""

        from sciretriever.analysis.ports import (
            AnalysisLLMCall,
            AnalysisLLMFailure,
            parse_strict_json_object,
        )
        from sciretriever.model.llm import LLMRequest, LLMRequestKind
        from sciretriever.model.primitives import sha256_digest

        runtime = configuration_runtime_status(
            self.configuration,
            credentials=self.credentials,
        )
        locally_ready = runtime.analysis.reference_configuration_complete and (
            not runtime.analysis.api_key_required
            or (
                runtime.analysis.api_key_configured is True
                and runtime.analysis.credential_origin_matches is True
            )
        )
        if not locally_ready:
            return _core_probe_payload(
                "llm",
                outcome="skipped",
                local_ready=False,
                failure_code="analysis-not-ready",
            )
        try:
            secrets = load_runtime_secrets(
                self.configuration,
                credentials=self.credentials,
                include_parser=False,
                include_analysis=True,
            )
            adapter = _build_analysis_llm(
                self.configuration,
                secrets,
                self.http_client,
                self.access_coordinator,
            )
            structured_input = '{"probe":"sciretriever-configuration"}'
            response = adapter.complete(
                AnalysisLLMCall(
                    request=LLMRequest(
                        kind=LLMRequestKind.REFERENCE_LOOKUP,
                        input_sha256=sha256_digest(structured_input.encode("utf-8")),
                        model=self.configuration.analysis.model or "",
                        max_output_tokens=min(
                            self.configuration.analysis.reference_max_output_tokens or 16,
                            64,
                        ),
                    ),
                    prompt_version="configuration-probe-v1",
                    prompt=(
                        "Return exactly one JSON object matching the schema. "
                        "Set ok to true. Do not add fields."
                    ),
                    structured_input=structured_input,
                    response_schema=(
                        '{"type":"object","properties":{"ok":{"type":"boolean",'
                        '"const":true}},"required":["ok"],"additionalProperties":false}'
                    ),
                )
            )
            result = parse_strict_json_object(response.result)
            if result != {"ok": True}:
                return _core_probe_payload(
                    "llm",
                    outcome="failed",
                    local_ready=True,
                    failure_code="analysis-llm-probe-contract",
                )
        except AnalysisLLMFailure as error:
            return _core_probe_payload(
                "llm",
                outcome="failed",
                local_ready=True,
                failure_code=error.failure.code,
            )
        except (BootstrapError, ConfigurationError, TypeError, ValueError):
            return _core_probe_payload(
                "llm",
                outcome="failed",
                local_ready=True,
                failure_code="analysis-llm-probe-failed",
            )
        return _core_probe_payload(
            "llm",
            outcome="passed",
            local_ready=True,
            failure_code=None,
            details={
                "strict_response_parseable": True,
                "model": self.configuration.analysis.model,
                "protocol": (
                    None
                    if self.configuration.analysis.protocol is None
                    else self.configuration.analysis.protocol.value
                ),
            },
        )

    def run_mineru(self) -> CoreConfigurationProbeResult:
        """Run MinerU health/version/protocol checks without uploading a PDF."""

        from sciretriever.network.admission import AccessPolicy, AccessScope
        from sciretriever.parsing.adapters.mineru import (
            MinerUProtocol2Error,
            MinerUProtocol2ServiceClient,
        )

        runtime = configuration_runtime_status(
            self.configuration,
            credentials=self.credentials,
        )
        locally_ready = runtime.parsing.configuration_complete and (
            not runtime.parsing.bearer_token_required
            or (
                runtime.parsing.bearer_token_configured is True
                and runtime.parsing.credential_origin_matches is True
            )
        )
        if not locally_ready:
            return _core_probe_payload(
                "mineru",
                outcome="skipped",
                local_ready=False,
                failure_code="parser-not-ready",
            )
        try:
            secrets = load_runtime_secrets(
                self.configuration,
                credentials=self.credentials,
                include_parser=True,
                include_analysis=False,
            )
            parser = self.configuration.parsing
            client = MinerUProtocol2ServiceClient(
                http_client=self.http_client,
                base_url=parser.base_url or "",
                connection_mode=(parser.connection_mode or ParserConnectionMode.LOOPBACK).value,
                access_scope=AccessScope("mineru", "api", "protocol-2"),
                access_policy=AccessPolicy(max_concurrency=1),
                bearer_token=secrets.mineru_bearer_token,
                remote_upload_authorized=parser.remote_upload_authorized,
            )
            health = client.probe_health()
        except MinerUProtocol2Error as error:
            return _core_probe_payload(
                "mineru",
                outcome="failed",
                local_ready=True,
                failure_code=f"mineru-{error.code}",
            )
        except (ConfigurationError, TypeError, ValueError):
            return _core_probe_payload(
                "mineru",
                outcome="failed",
                local_ready=True,
                failure_code="mineru-probe-failed",
            )
        return _core_probe_payload(
            "mineru",
            outcome="passed",
            local_ready=True,
            failure_code=None,
            details={
                "health": health.status,
                "release": health.release,
                "api_protocol": health.api_protocol,
                "profile": "vlm-engine",
                "uploaded_pdf": False,
            },
        )


def _core_probe_payload(
    service: str,
    *,
    outcome: str,
    local_ready: bool,
    failure_code: str | None,
    details: dict[str, object] | None = None,
) -> CoreConfigurationProbeResult:
    service_name = CoreCredentialService(service)
    detail_payload = {} if details is None else details
    checked_details: LLMConfigurationProbeDetails | MinerUConfigurationProbeDetails
    if service_name is CoreCredentialService.LLM:
        checked_details = LLMConfigurationProbeDetails.model_validate(detail_payload)
    else:
        checked_details = MinerUConfigurationProbeDetails.model_validate(detail_payload)
    return CoreConfigurationProbeResult(
        service=service_name,
        outcome=ProbeOutcome(outcome),
        local_ready=local_ready,
        failure_code=failure_code,
        details=checked_details,
    )


def build_production_configuration_probe_session(
    configuration: Configuration,
    *,
    credentials_home: str | Path | None = None,
    configured_sci_hub_resolver: ConfiguredLocatorResolver | None = None,
) -> ProductionConfigurationProbeSession:
    """Build a complete config-test session without runtime services or Storage."""

    from sciretriever.metadata.registry import (
        MetadataAssemblyDependencies,
        MetadataRegistryError,
        build_metadata_probe_registry,
    )

    if not isinstance(configuration, Configuration):
        raise BootstrapError("configuration-invalid")
    coordinator, resolver, http_client = _new_shared_network()
    clock = _UtcClock()
    try:
        browser_runtime = _new_acquisition_execution_runtime(
            configuration,
            access_coordinator=coordinator,
            resolver=resolver,
            browser_profile_home=credentials_home,
        )
        browser_probe_port = _ProductionBrowserConfigurationProbePort(
            browser_runtime.browser_client,
            browser_runtime.browser_scheduler,
            eligible_production_browser_access_keys(configuration.access),
        )
        credentials = load_credentials(home=credentials_home)
        status = configuration_status(
            configuration,
            credentials=credentials,
            configured_sci_hub_resolver=configured_sci_hub_resolver,
        )
        probe_port = build_metadata_probe_registry(
            configuration,
            credentials,
            MetadataAssemblyDependencies(
                http_client=http_client,
                access_coordinator=coordinator,
                observation_id_factory=_new_observation_id,
                provenance_id_factory=_new_provenance_id,
                clock=clock.now,
            ),
        )
        browser_status = browser_access_status(
            configuration,
            home=credentials_home,
            probe_supported_access_keys=browser_probe_port.supported_access_keys,
        )
    except ConfigurationError:
        raise BootstrapError("configuration-invalid") from None
    except MetadataRegistryError:
        raise BootstrapError("metadata-not-ready") from None
    return ProductionConfigurationProbeSession(
        configuration=configuration,
        credentials=credentials,
        status=status,
        probe_port=probe_port,
        access_coordinator=coordinator,
        http_client=http_client,
        browser_status=browser_status,
        browser_probe_port=browser_probe_port,
        browser_session_broker=browser_runtime.browser_session_broker,
    )


__all__ = (
    "ProductionConfigurationProbeSession",
    "build_production_configuration_probe_session",
)
