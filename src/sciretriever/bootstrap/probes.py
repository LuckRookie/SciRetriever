"""No-Storage configuration probe session and explicit probe assembly."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from sciretriever.acquisition.sources.configured_sci_hub import ConfiguredLocatorResolver
from sciretriever.agents.failures import AgentFailure
from sciretriever.agents.providers.base import agent_request_endpoint
from sciretriever.bootstrap.browser import (
    _new_browser_runtime,
    _ProductionBrowserConfigurationProbePort,
)
from sciretriever.bootstrap.errors import BootstrapError
from sciretriever.bootstrap.services import (
    _build_agents_runtime,
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
    configuration_service_origin,
    configuration_status,
    configured_browser_group_policies,
    eligible_production_browser_access_keys,
    load_credentials,
    load_runtime_secrets,
    resolve_task_model,
    run_acquisition_configuration_probes,
    run_browser_configuration_probe,
    run_configuration_probes,
)
from sciretriever.model.configuration import (
    AgentConfigurationProbeDetails,
    AgentProtocol,
    AnalysisConfig,
    BrowserAccessStatus,
    BrowserConfig,
    BrowserConfigurationProbeResult,
    Configuration,
    ConfigurationProbeSummary,
    ConfigurationStatus,
    CoreConfigurationProbeFailureEvidence,
    CoreConfigurationProbeResult,
    MinerUConfigurationProbeDetails,
    ModelConfigurationProbeDetails,
    ModelProviderConfigurationProbeDetails,
    ParserConnectionMode,
    ProbeOutcome,
    ProviderName,
    normalize_model_provider_identity,
)
from sciretriever.network.admission import AccessCoordinator
from sciretriever.network.browser_control import BROWSER_OBSERVATION_MEDIA_TYPE
from sciretriever.network.http import HttpClient

if TYPE_CHECKING:
    from sciretriever.agents.providers.models import AgentModelCatalog
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

    def run_acquisition(
        self,
        *,
        provider: ProviderName | str | None = None,
        test_all: bool = False,
    ) -> ConfigurationProbeSummary:
        """Report the selected Download Source probe boundary without fetching a PDF."""

        return run_acquisition_configuration_probes(
            self.configuration,
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

    def run_model_provider(self, name: str) -> CoreConfigurationProbeResult:
        """Probe one exact Model Provider through its bounded catalog endpoint."""

        from sciretriever.agents.providers.models import AgentModelCatalogClient

        provider = self.configuration.providers.get(name)
        if provider is None:
            raise ValueError("Model Provider is unknown")
        details = ModelProviderConfigurationProbeDetails(
            provider=provider.name,
            protocol=provider.api,
            request_url=agent_request_endpoint(
                base_url=provider.base_url,
                endpoint_suffix="/models",
            ),
        )
        api_key = None
        if provider.requires_api_key:
            try:
                origin = configuration_service_origin(provider.base_url)
                api_key = self.credentials.model_secret_for_origin(provider.name, origin)
            except (ConfigurationError, TypeError, ValueError):
                api_key = None
            if api_key is None:
                return CoreConfigurationProbeResult(
                    service="agents",
                    outcome=ProbeOutcome.SKIPPED,
                    local_ready=False,
                    failure_code="model-provider-not-ready",
                    details=details,
                )
        try:
            catalog = AgentModelCatalogClient(
                http_client=self.http_client,
                protocol=provider.api,
                base_url=provider.base_url,
                api_key=api_key,
                provider_name=provider.name,
            ).list_models()
        except AgentFailure as error:
            return CoreConfigurationProbeResult(
                service="agents",
                outcome=ProbeOutcome.FAILED,
                local_ready=True,
                failure_code=error.failure.code,
                details=details,
                failure_evidence=_agent_failure_evidence(error),
            )
        except (ConfigurationError, TypeError, ValueError):
            return CoreConfigurationProbeResult(
                service="agents",
                outcome=ProbeOutcome.FAILED,
                local_ready=True,
                failure_code="model-provider-probe-failed",
                details=details,
            )
        return CoreConfigurationProbeResult(
            service="agents",
            outcome=ProbeOutcome.PASSED,
            local_ready=True,
            details=details.model_copy(
                update={
                    "catalog_count": len(catalog.models),
                    "catalog_truncated": catalog.truncated,
                }
            ),
        )

    def run_model(
        self,
        reference: str,
        *,
        image_input: bool = False,
    ) -> CoreConfigurationProbeResult:
        """Probe one reusable Model without changing either task selection."""

        model = self.configuration.models.get(reference)
        if model is None:
            raise ValueError("Model is unknown")
        provider = self.configuration.providers.get(model.provider)
        if provider is None:
            raise ValueError("Model Provider is unknown")
        details = ModelConfigurationProbeDetails(
            request_kind="model-image" if image_input else "model-text",
            reference=model.reference,
            provider=provider.name,
            model=model.model,
            protocol=provider.api,
            reasoning=model.reasoning,
            stream=model.stream,
            image_input=image_input,
            request_url=_agent_model_request_url(provider.api, provider.base_url),
        )
        if image_input and not model.image:
            return CoreConfigurationProbeResult(
                service="agents",
                outcome=ProbeOutcome.SKIPPED,
                local_ready=False,
                failure_code="model-image-not-ready",
                details=details,
            )
        if image_input:
            temporary = self.configuration.model_copy(
                update={"browser": BrowserConfig(model=model.reference)}
            )
            raw = self._with_configuration(temporary).run_browser_agent()
        else:
            temporary = self.configuration.model_copy(
                update={
                    "analysis": AnalysisConfig(
                        model=model.reference,
                        metadata_max_output_tokens=64,
                        content_max_output_tokens=64,
                        reference_max_output_tokens=64,
                        max_input_bytes=4_096,
                        max_chunk_bytes=4_096,
                        max_chunk_count=1,
                        max_total_llm_requests=3,
                        max_total_output_tokens=192,
                    )
                }
            )
            raw = self._with_configuration(temporary).run_agents()
        failure_code = raw.failure_code
        if raw.outcome is ProbeOutcome.SKIPPED:
            failure_code = "model-not-ready"
        response_parseable: bool | None = None
        if raw.outcome is ProbeOutcome.PASSED:
            response_parseable = True
        elif raw.failure_code in {
            "analysis-llm-probe-contract",
            "browser-agent-probe-contract",
        }:
            response_parseable = False
        return CoreConfigurationProbeResult(
            service="agents",
            outcome=raw.outcome,
            local_ready=raw.local_ready,
            failure_code=failure_code,
            details=details.model_copy(
                update={
                    "response_parseable": response_parseable,
                }
            ),
            failure_evidence=raw.failure_evidence,
        )

    def _with_configuration(
        self,
        configuration: Configuration,
    ) -> ProductionConfigurationProbeSession:
        return ProductionConfigurationProbeSession(
            configuration=configuration,
            credentials=self.credentials,
            status=self.status,
            probe_port=self.probe_port,
            access_coordinator=self.access_coordinator,
            http_client=self.http_client,
            browser_status=self.browser_status,
            browser_probe_port=self.browser_probe_port,
            browser_session_broker=self.browser_session_broker,
        )

    def run_agents(self) -> CoreConfigurationProbeResult:
        """Run one minimal strict Agents request without user Literature content."""

        from sciretriever.agents.api import (
            AgentCall,
            AgentCapability,
            AgentRole,
            AgentStructuredResult,
            AgentTextPart,
        )
        from sciretriever.model.primitives import sha256_digest

        runtime = configuration_runtime_status(
            self.configuration,
            credentials=self.credentials,
        )
        locally_ready = runtime.agents.analysis_reference_locally_ready
        if not locally_ready:
            return _core_probe_payload(
                "agents",
                outcome="skipped",
                local_ready=False,
                failure_code="analysis-not-ready",
            )
        details: dict[str, object] = {}
        try:
            provider, model = resolve_task_model(self.configuration, task="analyze")
            details = {
                "model_reference": model.reference,
                "provider": provider.name,
                "model": model.model,
                "protocol": provider.api.value,
                "stream": model.stream,
                "request_method": "POST",
                "request_url": _agent_model_request_url(
                    provider.api,
                    provider.base_url,
                ),
            }
            secrets = load_runtime_secrets(
                self.configuration,
                credentials=self.credentials,
                include_parser=False,
                include_agents=True,
            )
            runtime_adapter = _build_agents_runtime(
                self.configuration,
                secrets,
                self.http_client,
                self.access_coordinator,
                required_roles=frozenset({AgentRole.ANALYSIS}),
            )
            structured_input = '{"probe":"sciretriever-configuration"}'
            max_output_tokens = min(
                self.configuration.analysis.reference_max_output_tokens or 16,
                64,
            )
            request = AgentCall(
                role=AgentRole.ANALYSIS,
                required_capabilities=frozenset({AgentCapability.STRUCTURED_TEXT}),
                input_sha256=sha256_digest(structured_input.encode("utf-8")),
                text_parts=(
                    AgentTextPart(
                        media_type="text/plain",
                        text=(
                            "Return exactly one JSON object matching the schema. "
                            "Set ok to true. Do not add fields."
                        ),
                    ),
                    AgentTextPart(media_type="application/json", text=structured_input),
                ),
                response_schema=(
                    '{"type":"object","properties":{"ok":{"type":"boolean",'
                    '"const":true}},"required":["ok"],"additionalProperties":false}'
                ),
                max_output_tokens=max_output_tokens,
            )
            response = runtime_adapter.execute(request)
            if not isinstance(response, AgentStructuredResult):
                return _core_probe_payload(
                    "agents",
                    outcome="failed",
                    local_ready=True,
                    failure_code="analysis-llm-probe-contract",
                    details=details,
                )
            if response.value != {"ok": True}:
                return _core_probe_payload(
                    "agents",
                    outcome="failed",
                    local_ready=True,
                    failure_code="analysis-llm-probe-contract",
                    details=details,
                )
        except AgentFailure as error:
            return _core_probe_payload(
                "agents",
                outcome="failed",
                local_ready=True,
                failure_code=error.failure.code,
                details=details,
                failure_evidence=_agent_failure_evidence(error),
            )
        except (BootstrapError, ConfigurationError, TypeError, ValueError):
            return _core_probe_payload(
                "agents",
                outcome="failed",
                local_ready=True,
                failure_code="analysis-llm-probe-failed",
                details=details,
            )
        return _core_probe_payload(
            "agents",
            outcome="passed",
            local_ready=True,
            failure_code=None,
            details={
                **details,
                "strict_response_parseable": True,
            },
        )

    def run_browser_agent(self) -> CoreConfigurationProbeResult:
        """Probe the configured Browser Agent role with a synthetic request.

        This is deliberately separate from :meth:`run_agents`: the Browser
        role has an image-input and closed-tool contract, while Analysis uses
        a strict structured-text contract.  Readiness is evaluated entirely
        from the local configuration/credential snapshot before constructing
        the production runtime, so a missing optional Browser role cannot
        trigger network I/O.
        """

        from base64 import b64decode

        from sciretriever.agents.api import (
            AgentCall,
            AgentCapability,
            AgentImagePart,
            AgentRole,
            AgentTextPart,
            AgentToolCall,
            AgentToolDeclaration,
        )
        from sciretriever.model.primitives import sha256_digest

        details = _browser_agent_probe_details(self.configuration)
        # Fixed 1x1 white JPEG.  It is synthetic configuration input in the
        # same media format as a production Browser Observation,
        # never a page screenshot or a user document.
        image = b64decode(
            "/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0N"
            "Dh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/"
            "wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAA"
            "AAAAAAAAAAAAD/2gAIAQEAAD8AZn//2Q=="
        )
        try:
            _provider, model = resolve_task_model(self.configuration, task="browser")
            runtime_status = configuration_runtime_status(
                self.configuration,
                credentials=self.credentials,
            )
            role_ready = runtime_status.agents.browser_locally_ready and model.image
        except (ConfigurationError, TypeError, ValueError):
            return _core_probe_payload(
                "agents",
                outcome="skipped",
                local_ready=False,
                failure_code="browser-agent-not-ready",
                details=details,
            )

        if not role_ready:
            return _core_probe_payload(
                "agents",
                outcome="skipped",
                local_ready=False,
                failure_code="browser-agent-not-ready",
                details=details,
            )

        system_text = (
            "This is a bounded configuration probe. Return the declared stop "
            "tool with ok=true. Do not navigate, request external data, or "
            "describe the image."
        )
        user_text = '{"probe":"sciretriever-browser-agent","input":"synthetic"}'
        stop_tool = AgentToolDeclaration(
            name="probe_stop",
            description="Stop this configuration probe.",
            input_schema=(
                '{"type":"object","properties":{"ok":{"type":"boolean",'
                '"const":true}},"required":["ok"],"additionalProperties":false}'
            ),
        )
        max_output_tokens = 64
        request = AgentCall(
            role=AgentRole.BROWSER,
            required_capabilities=frozenset(
                {AgentCapability.IMAGE_INPUT, AgentCapability.TOOL_DECISION}
            ),
            input_sha256=sha256_digest(user_text.encode("utf-8") + image),
            text_parts=(
                AgentTextPart(media_type="text/plain", text=system_text),
                AgentTextPart(media_type="application/json", text=user_text),
            ),
            image_parts=(
                AgentImagePart(
                    media_type=BROWSER_OBSERVATION_MEDIA_TYPE,
                    data=image,
                    width=1,
                    height=1,
                ),
            ),
            tools=(stop_tool,),
            max_output_tokens=max_output_tokens,
        )
        try:
            secrets = load_runtime_secrets(
                self.configuration,
                credentials=self.credentials,
                include_parser=False,
                include_agents=True,
            )
            runtime_adapter = _build_agents_runtime(
                self.configuration,
                secrets,
                self.http_client,
                self.access_coordinator,
                required_roles=frozenset({AgentRole.BROWSER}),
            )
            response = runtime_adapter.execute(request)
            if not isinstance(response, AgentToolCall):
                return _core_probe_payload(
                    "agents",
                    outcome="failed",
                    local_ready=True,
                    failure_code="browser-agent-probe-contract",
                    details=details,
                )
            if response.tool_name != stop_tool.name or response.value != {"ok": True}:
                return _core_probe_payload(
                    "agents",
                    outcome="failed",
                    local_ready=True,
                    failure_code="browser-agent-probe-contract",
                    details=details,
                )
        except AgentFailure as error:
            failure_code = error.failure.code
            if failure_code == "agent-tool":
                failure_code = "browser-agent-probe-contract"
            return _core_probe_payload(
                "agents",
                outcome="failed",
                local_ready=True,
                failure_code=failure_code,
                details=details,
                failure_evidence=_agent_failure_evidence(error),
            )
        except (BootstrapError, ConfigurationError, TypeError, ValueError):
            return _core_probe_payload(
                "agents",
                outcome="failed",
                local_ready=True,
                failure_code="browser-agent-probe-failed",
                details=details,
            )
        return _core_probe_payload(
            "agents",
            outcome="passed",
            local_ready=True,
            failure_code=None,
            details={
                **details,
                "tool_decision_parseable": True,
                "model": model.model,
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
        details: dict[str, object] = {}
        try:
            secrets = load_runtime_secrets(
                self.configuration,
                credentials=self.credentials,
                include_parser=True,
                include_agents=False,
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
            details = {
                "request_method": "GET",
                "request_url": client.health_endpoint,
            }
            health = client.probe_health()
        except MinerUProtocol2Error as error:
            return _core_probe_payload(
                "mineru",
                outcome="failed",
                local_ready=True,
                failure_code=f"mineru-{error.code}",
                details=details,
                failure_evidence=_failure_evidence(
                    http_status=error.http_status,
                    access_code=error.access_code,
                ),
            )
        except (ConfigurationError, TypeError, ValueError):
            return _core_probe_payload(
                "mineru",
                outcome="failed",
                local_ready=True,
                failure_code="mineru-probe-failed",
                details=details,
            )
        return _core_probe_payload(
            "mineru",
            outcome="passed",
            local_ready=True,
            failure_code=None,
            details={
                **details,
                "health": health.status,
                "release": health.release,
                "api_protocol": health.api_protocol,
                "profile": "vlm-engine",
                "uploaded_pdf": False,
            },
        )


def fetch_agent_models(
    *,
    provider_name: str,
    api: AgentProtocol,
    base_url: str,
    api_key: str | None,
) -> AgentModelCatalog:
    """Fetch one bounded, non-persistent model page for the setup wizard.

    The caller must obtain explicit user intent before invoking this function.
    ``api_key`` remains request-local and is bound to ``base_url`` by the same
    Agents/Network policy used for model calls.
    """

    from sciretriever.agents.providers.models import AgentModelCatalogClient

    name = normalize_model_provider_identity(provider_name)
    if not isinstance(api, AgentProtocol):
        raise TypeError("api must be an AgentProtocol")
    _coordinator, _resolver, http_client = _new_shared_network()
    try:
        return AgentModelCatalogClient(
            http_client=http_client,
            protocol=api,
            base_url=base_url,
            api_key=api_key,
            provider_name=name,
        ).list_models()
    finally:
        http_client.close()


def _core_probe_payload(
    service: Literal["agents", "mineru"],
    *,
    outcome: str,
    local_ready: bool,
    failure_code: str | None,
    details: dict[str, object] | None = None,
    failure_evidence: CoreConfigurationProbeFailureEvidence | None = None,
) -> CoreConfigurationProbeResult:
    detail_payload = {} if details is None else details
    checked_details: AgentConfigurationProbeDetails | MinerUConfigurationProbeDetails
    if service == "agents":
        checked_details = AgentConfigurationProbeDetails.model_validate(detail_payload)
    else:
        checked_details = MinerUConfigurationProbeDetails.model_validate(detail_payload)
    return CoreConfigurationProbeResult(
        service=service,
        outcome=ProbeOutcome(outcome),
        local_ready=local_ready,
        failure_code=failure_code,
        details=checked_details,
        failure_evidence=failure_evidence,
    )


def _failure_evidence(
    *,
    http_status: int | None,
    access_code: str | None,
    remote_error: str | None = None,
) -> CoreConfigurationProbeFailureEvidence | None:
    if http_status is None and access_code is None:
        return None
    return CoreConfigurationProbeFailureEvidence.model_validate(
        {
            "http_status": http_status,
            "access_code": access_code,
            "remote_error": remote_error,
        }
    )


def _agent_failure_evidence(
    error: AgentFailure,
) -> CoreConfigurationProbeFailureEvidence | None:
    return _failure_evidence(
        http_status=error.http_status,
        access_code=error.access_code,
        remote_error=error.remote_error,
    )


def _browser_agent_probe_details(
    configuration: Configuration,
    *,
    tool_decision_parseable: bool | None = None,
) -> dict[str, object]:
    """Return the stable, secret-free Browser Agent probe disclosure."""

    try:
        provider, model = resolve_task_model(configuration, task="browser")
        request_url = _agent_model_request_url(provider.api, provider.base_url)
    except (AgentFailure, TypeError, ValueError):
        provider, model = None, None
        request_url = None
    return {
        "role": "browser-agent",
        "request_kind": "browser-agent-tool",
        "sends_user_literature": False,
        "sends_page_content": False,
        "sends_pdf": False,
        "may_consume_quota": True,
        "strict_response_parseable": None,
        "tool_decision_parseable": tool_decision_parseable,
        "image_input": True,
        "tool_decision": True,
        "image_count": 1,
        "tool_count": 1,
        "model_reference": None if model is None else model.reference,
        "provider": None if provider is None else provider.name,
        "model": None if model is None else model.model,
        "protocol": None if provider is None else provider.api.value,
        "stream": None if model is None else model.stream,
        "request_method": None if request_url is None else "POST",
        "request_url": request_url,
    }


def _agent_model_request_url(api: AgentProtocol, base_url: str) -> str:
    suffix = {
        AgentProtocol.OPENAI_RESPONSES: "/responses",
        AgentProtocol.OPENAI_CHAT_COMPLETIONS: "/chat/completions",
        AgentProtocol.ANTHROPIC_MESSAGES: "/messages",
    }[api]
    return agent_request_endpoint(base_url=base_url, endpoint_suffix=suffix)


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
        browser_runtime = _new_browser_runtime(
            configuration,
            access_coordinator=coordinator,
            resolver=resolver,
            browser_profile_home=credentials_home,
        )
        browser_probe_port = _ProductionBrowserConfigurationProbePort(
            browser_runtime.execution.browser_client,
            browser_runtime.execution.browser_scheduler,
            (
                eligible_production_browser_access_keys(configuration.browser)
                if browser_runtime.ready
                else frozenset()
            ),
            session_key=configuration.browser.profile or "browser-profile-missing",
            policy=configured_browser_group_policies(configuration.browser)["browser-generic"],
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
            runtime_availability=browser_runtime.availability,
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
        browser_session_broker=browser_runtime.execution.browser_session_broker,
    )


__all__ = (
    "ProductionConfigurationProbeSession",
    "build_production_configuration_probe_session",
    "fetch_agent_models",
)
