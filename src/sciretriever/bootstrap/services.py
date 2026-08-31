"""Shared production adapter, identity, and readiness assembly helpers."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, NoReturn, cast
from uuid import uuid4

from sciretriever.agents.api import (
    AgentCallLimits,
    AgentFailure,
    AgentModelCapabilities,
    AgentRole,
    AgentRoleBinding,
    AgentRuntime,
)
from sciretriever.agents.ports import AgentProviderPort
from sciretriever.bootstrap.errors import BootstrapError
from sciretriever.bootstrap.graphs import BootstrapExternalDependencies
from sciretriever.configuration import CredentialLookup, RuntimeSecretLookup
from sciretriever.configuration.agent_setup import resolve_task_model
from sciretriever.model.configuration import (
    AgentProtocol,
    BrowserController,
    Configuration,
    ModelConfig,
    ParserConnectionMode,
)
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    ReferenceId,
    UtcTimestamp,
)
from sciretriever.network.admission import AccessCoordinator
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import ResolverLike
from sciretriever.parsing.ports import ParserPort

if TYPE_CHECKING:
    from sciretriever.metadata.api import MetadataApi
    from sciretriever.metadata.registry import MetadataRegistry


_AGENT_MAX_INPUT_BYTES = 8_388_608
_BROWSER_AGENT_MAX_OUTPUT_TOKENS = 256
_BROWSER_AGENT_MAX_IMAGE_BYTES = 4_194_304


class _UtcClock:
    __slots__ = ()

    def now(self) -> UtcTimestamp:
        return UtcTimestamp.model_validate(datetime.now(timezone.utc))


class _UuidLiteratureIds:
    __slots__ = ()

    def new_literature_id(self) -> LiteratureId:
        return LiteratureId(str(uuid4()))

    def new_meta_literature_id(self) -> MetaLiteratureId:
        return MetaLiteratureId(str(uuid4()))

    def new_reference_id(self) -> ReferenceId:
        return ReferenceId(str(uuid4()))


def _new_observation_id() -> ObservationId:
    return ObservationId(str(uuid4()))


def _new_provenance_id() -> ProvenanceId:
    return ProvenanceId(str(uuid4()))


def _require_paths_configuration(configuration: Configuration) -> None:
    if configuration.paths.catalog_path is None or configuration.paths.artifact_root is None:
        raise BootstrapError("paths-not-ready")


def _require_parser_configuration(configuration: Configuration) -> None:
    parsing = configuration.parsing
    if (
        parsing.base_url is None
        or parsing.connection_mode is None
        or parsing.model_identity is None
        or (
            parsing.connection_mode is ParserConnectionMode.REMOTE
            and not parsing.remote_upload_authorized
        )
    ):
        raise BootstrapError("parser-not-ready")


def _require_analysis_configuration(configuration: Configuration) -> None:
    analysis = configuration.analysis
    try:
        _provider, model = resolve_task_model(configuration, task="analyze")
    except (TypeError, ValueError):
        raise BootstrapError("analysis-not-ready") from None
    if any(
        value is None
        for value in (
            model.model,
            analysis.metadata_max_output_tokens,
            analysis.content_max_output_tokens,
            analysis.reference_max_output_tokens,
            analysis.max_input_bytes,
            analysis.max_chunk_bytes,
            analysis.max_chunk_count,
            analysis.max_total_llm_requests,
            analysis.max_total_output_tokens,
        )
    ):
        raise BootstrapError("analysis-not-ready")


def _require_reference_analysis_configuration(configuration: Configuration) -> None:
    analysis = configuration.analysis
    try:
        _provider, model = resolve_task_model(configuration, task="analyze")
    except (TypeError, ValueError):
        raise BootstrapError("analysis-not-ready") from None
    if any(
        value is None
        for value in (
            model.model,
            analysis.reference_max_output_tokens,
        )
    ):
        raise BootstrapError("analysis-not-ready")


def _require_browser_agent_configuration(configuration: Configuration) -> None:
    """Require the selected Browser role without changing Analysis readiness."""

    try:
        _provider, browser = resolve_task_model(configuration, task="download")
    except (TypeError, ValueError):
        raise BootstrapError("browser-agent-not-ready") from None
    if not browser.image:
        raise BootstrapError("browser-agent-not-ready")


def _required_production_configuration(configuration: Configuration) -> None:
    _require_paths_configuration(configuration)
    _require_parser_configuration(configuration)
    _require_analysis_configuration(configuration)
    if configuration.access.browser_controller is BrowserController.AGENT:
        _require_browser_agent_configuration(configuration)


def _analysis_limits(configuration: Configuration):  # noqa: ANN202
    from sciretriever.analysis.content import ContentAnalysisLimits

    analysis = configuration.analysis
    return ContentAnalysisLimits(
        max_input_bytes=analysis.max_input_bytes or 0,
        max_chunk_bytes=analysis.max_chunk_bytes or 0,
        max_chunk_count=analysis.max_chunk_count or 0,
        max_total_llm_requests=analysis.max_total_llm_requests or 0,
        max_total_output_tokens=analysis.max_total_output_tokens or 0,
    )


def _agent_provider_limits(
    configuration: Configuration,
    *,
    required_roles: frozenset[AgentRole] | None = None,
):  # noqa: ANN202
    """Build objective single-call limits for the explicitly required roles."""

    selected_roles = frozenset({AgentRole.ANALYSIS}) if required_roles is None else required_roles
    if (
        not isinstance(selected_roles, frozenset)
        or not selected_roles
        or any(not isinstance(role, AgentRole) for role in selected_roles)
    ):
        raise TypeError("required_roles must be a non-empty AgentRole set")
    analysis_outputs = (
        configuration.analysis.metadata_max_output_tokens or 1,
        configuration.analysis.content_max_output_tokens or 1,
        configuration.analysis.reference_max_output_tokens or 1,
    )
    output_by_role = {
        AgentRole.ANALYSIS: max(analysis_outputs),
        AgentRole.BROWSER: _BROWSER_AGENT_MAX_OUTPUT_TOKENS,
    }
    max_output_tokens = max(output_by_role[role] for role in selected_roles)
    return AgentCallLimits(
        max_input_bytes=_AGENT_MAX_INPUT_BYTES,
        max_output_tokens=max_output_tokens,
        context_window_tokens=_AGENT_MAX_INPUT_BYTES + max_output_tokens,
    )


def _production_dependencies(
    configuration: Configuration,
    secrets: RuntimeSecretLookup,
) -> BootstrapExternalDependencies:
    from sciretriever.network.admission import AccessPolicy, AccessScope
    from sciretriever.parsing.adapters.mineru import (
        MinerUProtocol2Error,
        MinerUProtocol2ServiceClient,
        OperatorManagedMinerUAdapter,
    )

    parser = configuration.parsing
    analysis = configuration.analysis

    def parser_factory(
        http_client: HttpClient,
        _coordinator: AccessCoordinator,
    ) -> ParserPort:
        try:
            service = MinerUProtocol2ServiceClient(
                http_client=http_client,
                base_url=parser.base_url or "",
                connection_mode=(parser.connection_mode or ParserConnectionMode.LOOPBACK).value,
                access_scope=AccessScope("mineru", "api", "protocol-2"),
                access_policy=AccessPolicy(max_concurrency=1),
                bearer_token=secrets.mineru_bearer_token,
                remote_upload_authorized=parser.remote_upload_authorized,
            )
            return cast(
                ParserPort,
                OperatorManagedMinerUAdapter(
                    service=service,
                    profile="vlm-engine",
                    model_identity=parser.model_identity or "",
                ),
            )
        except (MinerUProtocol2Error, TypeError, ValueError):
            raise BootstrapError("parser-not-ready") from None

    def agents_factory(
        http_client: HttpClient,
        coordinator: AccessCoordinator,
    ) -> AgentRuntime:
        required_roles = {AgentRole.ANALYSIS}
        if configuration.access.browser_controller is BrowserController.AGENT:
            required_roles.add(AgentRole.BROWSER)
        return _build_agents_runtime(
            configuration,
            secrets,
            http_client,
            coordinator,
            required_roles=frozenset(required_roles),
        )

    return BootstrapExternalDependencies(
        parser_factory=parser_factory,
        agents_factory=agents_factory,
        metadata_max_output_tokens=analysis.metadata_max_output_tokens or 0,
        content_max_output_tokens=analysis.content_max_output_tokens or 0,
        reference_max_output_tokens=analysis.reference_max_output_tokens or 0,
        analysis_max_input_bytes=analysis.max_input_bytes or 0,
        analysis_max_chunk_bytes=analysis.max_chunk_bytes or 0,
        analysis_max_chunk_count=analysis.max_chunk_count or 0,
        analysis_max_total_llm_requests=analysis.max_total_llm_requests or 0,
        analysis_max_total_output_tokens=analysis.max_total_output_tokens or 0,
    )


def _new_shared_network() -> tuple[AccessCoordinator, ResolverLike, HttpClient]:
    from sciretriever.network.http import SecureHttpTransport, SystemResolver

    coordinator = AccessCoordinator()
    resolver = SystemResolver()
    return (
        coordinator,
        resolver,
        HttpClient(
            resolver=resolver,
            transport=SecureHttpTransport(),
            coordinator=coordinator,
        ),
    )


def _raise_production_assembly_error(error: Exception) -> NoReturn:
    """Translate every production assembly failure to one stable safe code."""

    from sciretriever.acquisition.registry import AcquisitionRegistryError
    from sciretriever.agents.api import AgentFailure
    from sciretriever.metadata.registry import MetadataRegistryError
    from sciretriever.parsing.adapters.mineru import MinerUProtocol2Error
    from sciretriever.storage.files.output import AtomicOutputError
    from sciretriever.storage.files.paths import StoragePathError
    from sciretriever.storage.files.store import ArtifactStoreError
    from sciretriever.storage.sqlite.engine import CatalogError

    if isinstance(error, MetadataRegistryError):
        raise BootstrapError("metadata-not-ready") from None
    if isinstance(error, AcquisitionRegistryError):
        raise BootstrapError("acquisition-not-ready") from None
    if isinstance(error, MinerUProtocol2Error):
        raise BootstrapError("parser-not-ready") from None
    if isinstance(error, AgentFailure):
        raise BootstrapError("analysis-not-ready") from None
    if isinstance(
        error,
        (
            CatalogError,
            StoragePathError,
            ArtifactStoreError,
            AtomicOutputError,
            OSError,
        ),
    ):
        raise BootstrapError("storage-unavailable") from None
    raise BootstrapError("assembly-failed") from None


def _build_metadata_components(
    configuration: Configuration,
    credentials: CredentialLookup,
    coordinator: AccessCoordinator,
    http_client: HttpClient,
) -> tuple[MetadataRegistry, MetadataApi]:
    from sciretriever.metadata.api import MetadataApi
    from sciretriever.metadata.registry import MetadataAssemblyDependencies, build_metadata_registry
    from sciretriever.metadata.service import MetadataService

    registry = build_metadata_registry(
        configuration,
        credentials,
        MetadataAssemblyDependencies(
            http_client=http_client,
            access_coordinator=coordinator,
            observation_id_factory=_new_observation_id,
            provenance_id_factory=_new_provenance_id,
            clock=_UtcClock().now,
        ),
    )
    api = MetadataApi(
        MetadataService(
            topic_search_ports=registry.topic_search_ports,
            lookup_ports=registry.lookup_ports,
            reference_query_ports=registry.reference_query_ports,
        )
    )
    return registry, api


def _build_agents_runtime(  # noqa: C901
    configuration: Configuration,
    secrets: RuntimeSecretLookup,
    http_client: HttpClient,
    coordinator: AccessCoordinator,
    *,
    required_roles: frozenset[AgentRole] | None = None,
) -> AgentRuntime:
    from sciretriever.agents.providers.anthropic import AnthropicMessagesAdapter
    from sciretriever.agents.providers.openai_chat import (
        OpenAIChatCompletionsAdapter,
    )
    from sciretriever.agents.providers.openai_responses import OpenAIResponsesAdapter

    selected_roles = frozenset({AgentRole.ANALYSIS}) if required_roles is None else required_roles
    if (
        not isinstance(selected_roles, frozenset)
        or not selected_roles
        or any(not isinstance(role, AgentRole) for role in selected_roles)
    ):
        raise BootstrapError("agents-not-ready")

    def not_ready() -> BootstrapError:
        if selected_roles == frozenset({AgentRole.ANALYSIS}):
            return BootstrapError("analysis-not-ready")
        if selected_roles == frozenset({AgentRole.BROWSER}):
            return BootstrapError("browser-agent-not-ready")
        return BootstrapError("agents-not-ready")

    if getattr(http_client, "_coordinator", None) is not coordinator:
        raise not_ready()
    adapter_by_protocol = {
        AgentProtocol.OPENAI_RESPONSES: OpenAIResponsesAdapter,
        AgentProtocol.OPENAI_CHAT_COMPLETIONS: OpenAIChatCompletionsAdapter,
        AgentProtocol.ANTHROPIC_MESSAGES: AnthropicMessagesAdapter,
    }
    try:
        resolved = {
            role: resolve_task_model(
                configuration,
                task="analyze" if role is AgentRole.ANALYSIS else "download",
            )
            for role in selected_roles
        }
        roles_by_provider: dict[str, set[AgentRole]] = {}
        for role, (provider, _model) in resolved.items():
            roles_by_provider.setdefault(provider.name, set()).add(role)
        adapters: dict[str, AgentProviderPort] = {}
        for provider_name, roles in roles_by_provider.items():
            provider = next(
                item for item, _model in resolved.values() if item.name == provider_name
            )
            api_key = secrets.model_api_key(provider.name)
            if provider.requires_api_key and api_key is None:
                raise not_ready()
            adapter_type = adapter_by_protocol[provider.api]
            adapters[provider.name] = cast(
                AgentProviderPort,
                adapter_type(
                    http_client=http_client,
                    api_key=api_key,
                    base_url=provider.base_url,
                    provider_name=provider_name,
                    limits=_agent_provider_limits(
                        configuration,
                        required_roles=frozenset(roles),
                    ),
                ),
            )

        def role_binding(role: AgentRole, model: object) -> AgentRoleBinding | None:
            if not isinstance(model, ModelConfig):
                raise not_ready()
            limits = _agent_provider_limits(
                configuration,
                required_roles=frozenset({role}),
            )
            browser = role is AgentRole.BROWSER
            capabilities = AgentModelCapabilities(
                context_window_tokens=limits.context_window_tokens,
                max_output_tokens=limits.max_output_tokens,
                structured_output=not browser,
                image_input=browser and model.image,
                tool_decision=browser,
                supported_image_media_types=(
                    frozenset({"image/png"}) if browser and model.image else frozenset()
                ),
                max_image_count=1 if browser and model.image else 0,
                max_image_bytes=_BROWSER_AGENT_MAX_IMAGE_BYTES if browser and model.image else 0,
            )
            return AgentRoleBinding(
                role=role,
                model=model.model,
                capabilities=capabilities,
                reasoning_effort=model.reasoning,
                limits=limits,
            )

        analysis_resolved = resolved.get(AgentRole.ANALYSIS)
        browser_resolved = resolved.get(AgentRole.BROWSER)
        analysis_adapter = (
            None if analysis_resolved is None else adapters[analysis_resolved[0].name]
        )
        browser_adapter = None if browser_resolved is None else adapters[browser_resolved[0].name]
        runtime = AgentRuntime(
            adapter=analysis_adapter or browser_adapter,
            analysis_adapter=analysis_adapter,
            browser_adapter=browser_adapter,
            analysis=(
                None
                if analysis_resolved is None
                else role_binding(AgentRole.ANALYSIS, analysis_resolved[1])
            ),
            browser=(
                None
                if browser_resolved is None
                else role_binding(AgentRole.BROWSER, browser_resolved[1])
            ),
            configured_roles=selected_roles,
        )
        if not runtime.readiness(AgentRole.ANALYSIS).ready and AgentRole.ANALYSIS in selected_roles:
            raise BootstrapError("analysis-not-ready")
        if not runtime.readiness(AgentRole.BROWSER).ready and AgentRole.BROWSER in selected_roles:
            raise BootstrapError("browser-agent-not-ready")
        return runtime
    except (AgentFailure, KeyError, TypeError, ValueError):
        raise not_ready() from None


def _browser_agent_dependency(
    runtime: AgentRuntime,
):
    """Expose one ready shared Runtime to the selected Agent controller."""

    from sciretriever.acquisition.registry import BrowserAgentDependency

    if not isinstance(runtime, AgentRuntime):
        raise TypeError("runtime must be AgentRuntime")
    return BrowserAgentDependency(runtime=runtime)


__all__ = ()
