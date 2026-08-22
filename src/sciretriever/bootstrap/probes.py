"""No-Storage configuration probe session and explicit probe assembly."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from sciretriever.acquisition.sources.configured_sci_hub import ConfiguredLocatorResolver
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
    configuration_status,
    eligible_production_browser_access_keys,
    load_credentials,
    load_runtime_secrets,
    run_browser_configuration_probe,
    run_configuration_probes,
)
from sciretriever.model.configuration import (
    AgentConfigurationProbeDetails,
    BrowserAccessStatus,
    BrowserConfigurationProbeResult,
    Configuration,
    ConfigurationProbeSummary,
    ConfigurationStatus,
    CoreConfigurationProbeResult,
    CoreCredentialService,
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

    def run_agents(self) -> CoreConfigurationProbeResult:
        """Run one minimal strict Agents request without user Literature content."""

        from sciretriever.agents import (
            AgentBudget,
            AgentCapability,
            AgentFailure,
            AgentRequest,
            AgentRole,
            AgentStructuredResponse,
            AgentTextPart,
            open_session,
            parse_strict_json_object,
        )
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
                "agents",
                outcome="skipped",
                local_ready=False,
                failure_code="analysis-not-ready",
            )
        try:
            secrets = load_runtime_secrets(
                self.configuration,
                credentials=self.credentials,
                include_parser=False,
                include_agents=True,
            )
            adapter = _build_agents_runtime(
                self.configuration,
                secrets,
                self.http_client,
                self.access_coordinator,
                required_roles=frozenset({AgentRole.ANALYSIS}),
            )
            structured_input = '{"probe":"sciretriever-configuration"}'
            max_output_tokens = min(
                self.configuration.agents.analysis.max_output_tokens or 16,
                64,
            )
            request = AgentRequest(
                role=AgentRole.ANALYSIS,
                capabilities=frozenset({AgentCapability.STRUCTURED_TEXT}),
                model=self.configuration.agents.analysis.model or "",
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
                budget=AgentBudget(max_output_tokens=max_output_tokens),
            )
            with open_session(adapter, max_turns=1, budget=request.budget) as session:
                response = session.complete(request)
            if not isinstance(response, AgentStructuredResponse):
                return _core_probe_payload(
                    "agents",
                    outcome="failed",
                    local_ready=True,
                    failure_code="analysis-llm-probe-contract",
                )
            result = parse_strict_json_object(response.result)
            if result != {"ok": True}:
                return _core_probe_payload(
                    "agents",
                    outcome="failed",
                    local_ready=True,
                    failure_code="analysis-llm-probe-contract",
                )
        except AgentFailure as error:
            return _core_probe_payload(
                "agents",
                outcome="failed",
                local_ready=True,
                failure_code=error.failure.code,
            )
        except (BootstrapError, ConfigurationError, TypeError, ValueError):
            return _core_probe_payload(
                "agents",
                outcome="failed",
                local_ready=True,
                failure_code="analysis-llm-probe-failed",
            )
        return _core_probe_payload(
            "agents",
            outcome="passed",
            local_ready=True,
            failure_code=None,
            details={
                "strict_response_parseable": True,
                "model": self.configuration.agents.analysis.model,
                "protocol": (
                    None
                    if self.configuration.agents.protocol is None
                    else self.configuration.agents.protocol.value
                ),
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

        from sciretriever.agents import (
            AgentBudget,
            AgentCapability,
            AgentFailure,
            AgentImagePart,
            AgentRequest,
            AgentRole,
            AgentTextPart,
            AgentToolDecision,
            AgentToolDeclaration,
            open_session,
            parse_strict_json_object,
        )
        from sciretriever.model.primitives import sha256_digest

        agents = self.configuration.agents
        role = agents.browser
        details = _browser_agent_probe_details(self.configuration)
        # Fixed 1x1 transparent PNG.  It is synthetic configuration input,
        # never a page screenshot or a user document.
        image = b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
            "+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        try:
            runtime_status = configuration_runtime_status(
                self.configuration,
                credentials=self.credentials,
            )
            role_ready = (
                role.model is not None
                and role.context_window_tokens is not None
                and role.max_output_tokens is not None
                and role.image_input
                and role.tool_decision
                and role.image_count >= 1
                and role.image_bytes >= len(image)
                and "image/png" in role.image_media_types
            )
            transport_ready = (
                agents.provider is not None
                and agents.protocol is not None
                and agents.base_url is not None
                and agents.authentication is not None
            )
            credential_ready = True
            if agents.authentication is not None and agents.authentication.value == "api-key":
                credential_ready = (
                    runtime_status.analysis.api_key_configured is True
                    and runtime_status.analysis.credential_origin_matches is True
                )
        except (ConfigurationError, TypeError, ValueError):
            return _core_probe_payload(
                "agents",
                outcome="skipped",
                local_ready=False,
                failure_code="browser-agent-not-ready",
                details=details,
            )

        if not (role_ready and transport_ready and credential_ready):
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
        max_output_tokens = min(role.max_output_tokens or 1, 64)
        budget = AgentBudget(
            max_prompt_bytes=4_096,
            max_input_bytes=4_096,
            max_schema_bytes=8_192,
            max_request_bytes=32_768,
            max_response_bytes=64_000,
            max_result_bytes=1_024,
            max_output_tokens=max_output_tokens,
            context_window_tokens=min(role.context_window_tokens or 1_024, 2_048),
            connect_timeout_seconds=min(role.deadline_seconds, 10.0),
            read_timeout_seconds=min(role.deadline_seconds, 20.0),
            overall_timeout_seconds=min(role.deadline_seconds, 30.0),
            max_redirects=0,
            max_retries=0,
        )
        request = AgentRequest(
            role=AgentRole.BROWSER,
            capabilities=frozenset({AgentCapability.IMAGE_INPUT, AgentCapability.TOOL_DECISION}),
            model=role.model or "",
            input_sha256=sha256_digest(user_text.encode("utf-8") + image),
            text_parts=(
                AgentTextPart(media_type="text/plain", text=system_text),
                AgentTextPart(media_type="application/json", text=user_text),
            ),
            image_parts=(AgentImagePart(media_type="image/png", data=image, width=1, height=1),),
            tools=(stop_tool,),
            max_output_tokens=max_output_tokens,
            budget=budget,
        )
        try:
            secrets = load_runtime_secrets(
                self.configuration,
                credentials=self.credentials,
                include_parser=False,
                include_agents=True,
            )
            adapter = _build_agents_runtime(
                self.configuration,
                secrets,
                self.http_client,
                self.access_coordinator,
                required_roles=frozenset({AgentRole.BROWSER}),
            )
            with open_session(adapter, max_turns=1, budget=budget) as session:
                response = session.complete(request)
            if not isinstance(response, AgentToolDecision):
                return _core_probe_payload(
                    "agents",
                    outcome="failed",
                    local_ready=True,
                    failure_code="browser-agent-probe-contract",
                    details=details,
                )
            if response.tool_name != stop_tool.name or parse_strict_json_object(
                response.arguments
            ) != {"ok": True}:
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
                "model": role.model,
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
    checked_details: AgentConfigurationProbeDetails | MinerUConfigurationProbeDetails
    if service_name is CoreCredentialService.AGENTS:
        checked_details = AgentConfigurationProbeDetails.model_validate(detail_payload)
    else:
        checked_details = MinerUConfigurationProbeDetails.model_validate(detail_payload)
    return CoreConfigurationProbeResult(
        service=service_name,
        outcome=ProbeOutcome(outcome),
        local_ready=local_ready,
        failure_code=failure_code,
        details=checked_details,
    )


def _browser_agent_probe_details(
    configuration: Configuration,
    *,
    tool_decision_parseable: bool | None = None,
) -> dict[str, object]:
    """Return the stable, secret-free Browser Agent probe disclosure."""

    protocol = configuration.agents.protocol
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
        "model": configuration.agents.browser.model,
        "protocol": None if protocol is None else protocol.value,
    }


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
                eligible_production_browser_access_keys(configuration.access)
                if browser_runtime.ready
                else frozenset()
            ),
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
)
