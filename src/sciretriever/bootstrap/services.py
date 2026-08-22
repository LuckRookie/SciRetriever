"""Shared production adapter, identity, and readiness assembly helpers."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, NoReturn, cast
from uuid import uuid4

from sciretriever.agents import (
    AgentBudget,
    AgentFailure,
    AgentModelCapabilities,
    AgentPort,
    AgentRole,
    AgentRoleBinding,
    AgentRuntime,
)
from sciretriever.bootstrap.errors import BootstrapError
from sciretriever.bootstrap.graphs import BootstrapExternalDependencies
from sciretriever.configuration import CredentialLookup, RuntimeSecretLookup
from sciretriever.model.configuration import (
    AgentAuthentication,
    AgentProtocol,
    AgentProvider,
    Configuration,
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
    agents = configuration.agents
    if (
        any(
            value is None
            for value in (
                agents.provider,
                agents.protocol,
                agents.base_url,
                agents.analysis.model,
                agents.analysis.context_window_tokens,
                agents.analysis.max_output_tokens,
                agents.authentication,
                analysis.metadata_max_output_tokens,
                analysis.content_max_output_tokens,
                analysis.reference_max_output_tokens,
                analysis.max_input_bytes,
                analysis.max_chunk_bytes,
                analysis.max_chunk_count,
                analysis.max_total_llm_requests,
                analysis.max_total_output_tokens,
            )
        )
        or not agents.analysis.structured_output
    ):
        raise BootstrapError("analysis-not-ready")


def _require_reference_analysis_configuration(configuration: Configuration) -> None:
    analysis = configuration.analysis
    agents = configuration.agents
    if (
        any(
            value is None
            for value in (
                agents.provider,
                agents.protocol,
                agents.base_url,
                agents.analysis.model,
                agents.analysis.context_window_tokens,
                agents.analysis.max_output_tokens,
                agents.authentication,
                analysis.reference_max_output_tokens,
            )
        )
        or not agents.analysis.structured_output
    ):
        raise BootstrapError("analysis-not-ready")


def _required_production_configuration(configuration: Configuration) -> None:
    _require_paths_configuration(configuration)
    _require_parser_configuration(configuration)
    _require_analysis_configuration(configuration)


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
    """Build one shared provider budget for the explicitly required role set.

    Analysis remains the default so existing production assembly keeps its
    exact limits.  A Browser-only probe selects the Browser role's bounded
    context/output/deadline values instead of inheriting an unconfigured
    Analysis role's fallback one-token budget.
    """

    selected_roles = frozenset({AgentRole.ANALYSIS}) if required_roles is None else required_roles
    if (
        not isinstance(selected_roles, frozenset)
        or not selected_roles
        or any(not isinstance(role, AgentRole) for role in selected_roles)
    ):
        raise TypeError("required_roles must be a non-empty AgentRole set")
    analysis = configuration.analysis
    agents = configuration.agents
    role_configs = tuple(
        agents.analysis if role is AgentRole.ANALYSIS else agents.browser for role in selected_roles
    )
    deadline = min(role.deadline_seconds for role in role_configs)
    context_window_tokens = max(
        (role.context_window_tokens or 1_024 for role in role_configs),
        default=1_024,
    )
    max_output_tokens = max(
        (
            role.max_output_tokens
            or max(
                analysis.metadata_max_output_tokens or 1,
                analysis.content_max_output_tokens or 1,
                analysis.reference_max_output_tokens or 1,
            )
            for role in role_configs
        ),
        default=1,
    )
    context_input_bytes = max(1, context_window_tokens - max_output_tokens)
    return AgentBudget(
        max_input_bytes=(
            context_input_bytes
            if AgentRole.ANALYSIS not in selected_roles or analysis.max_input_bytes is None
            else min(analysis.max_input_bytes, context_input_bytes)
        ),
        max_output_tokens=max_output_tokens,
        context_window_tokens=context_window_tokens,
        connect_timeout_seconds=min(10.0, deadline),
        read_timeout_seconds=min(120.0, deadline),
        overall_timeout_seconds=deadline,
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
    agents = configuration.agents

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
    ) -> AgentPort:
        return _build_agents_runtime(
            configuration,
            secrets,
            http_client,
            coordinator,
            required_roles=frozenset({AgentRole.ANALYSIS}),
            optional_roles=frozenset({AgentRole.BROWSER}),
        )

    return BootstrapExternalDependencies(
        parser_factory=parser_factory,
        agents_factory=agents_factory,
        agents_analysis_model=agents.analysis.model or "",
        agents_analysis_budget=_agent_provider_limits(configuration),
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
    from sciretriever.agents import AgentFailure
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
    optional_roles: frozenset[AgentRole] = frozenset(),
) -> AgentPort:
    from sciretriever.agents.providers.anthropic import AnthropicMessagesAdapter
    from sciretriever.agents.providers.openai_chat import (
        OpenAIChatCompletionsAdapter,
    )
    from sciretriever.agents.providers.openai_responses import OpenAIResponsesAdapter

    selected_roles = frozenset({AgentRole.ANALYSIS}) if required_roles is None else required_roles
    if not isinstance(selected_roles, frozenset) or any(
        not isinstance(role, AgentRole) for role in selected_roles
    ):
        raise BootstrapError("agents-not-ready")
    if (
        not isinstance(optional_roles, frozenset)
        or any(not isinstance(role, AgentRole) for role in optional_roles)
        or selected_roles & optional_roles
        or not (selected_roles or optional_roles)
    ):
        raise BootstrapError("agents-not-ready")
    configured_roles = selected_roles | optional_roles

    def not_ready() -> BootstrapError:
        if selected_roles == frozenset({AgentRole.ANALYSIS}):
            return BootstrapError("analysis-not-ready")
        if selected_roles == frozenset({AgentRole.BROWSER}):
            return BootstrapError("browser-agent-not-ready")
        if not selected_roles and optional_roles == frozenset({AgentRole.BROWSER}):
            return BootstrapError("browser-agent-not-ready")
        return BootstrapError("agents-not-ready")

    if getattr(http_client, "_coordinator", None) is not coordinator:
        raise not_ready()
    agents = configuration.agents
    adapter_by_protocol = {
        AgentProtocol.OPENAI_RESPONSES: OpenAIResponsesAdapter,
        AgentProtocol.OPENAI_CHAT_COMPLETIONS: OpenAIChatCompletionsAdapter,
        AgentProtocol.ANTHROPIC_MESSAGES: AnthropicMessagesAdapter,
    }
    try:
        agents_api_key = secrets.agents_api_key
        if agents.authentication is AgentAuthentication.API_KEY and agents_api_key is None:
            raise not_ready()
        protocol = agents.protocol
        base_url = agents.base_url
        if protocol is None or base_url is None:
            raise not_ready()
        adapter = adapter_by_protocol[protocol]
        provider_name = (
            agents.provider.value
            if agents.provider is not AgentProvider.CUSTOM
            else agents.service_name or "custom"
        )
        adapter_port = cast(
            AgentPort,
            adapter(
                http_client=http_client,
                api_key=agents_api_key,
                base_url=base_url,
                provider_name=provider_name,
                limits=_agent_provider_limits(
                    configuration,
                    required_roles=configured_roles,
                ),
            ),
        )

        def role_binding(role: AgentRole, role_config: object) -> AgentRoleBinding | None:
            from sciretriever.model.configuration import AgentRoleConfig

            if not isinstance(role_config, AgentRoleConfig):
                raise not_ready()
            if (
                role_config.model is None
                or role_config.context_window_tokens is None
                or role_config.max_output_tokens is None
            ):
                return None
            capabilities = AgentModelCapabilities(
                context_window_tokens=role_config.context_window_tokens,
                max_output_tokens=role_config.max_output_tokens,
                structured_output=role_config.structured_output,
                image_input=role_config.image_input,
                tool_decision=role_config.tool_decision,
                supported_image_media_types=frozenset(role_config.image_media_types),
                max_image_count=role_config.image_count,
                max_image_bytes=role_config.image_bytes,
            )
            return AgentRoleBinding(
                role=role,
                model=role_config.model,
                capabilities=capabilities,
            )

        runtime = AgentRuntime(
            adapter=adapter_port,
            analysis=role_binding(AgentRole.ANALYSIS, agents.analysis),
            browser=role_binding(AgentRole.BROWSER, agents.browser),
        )
        readiness = runtime.readiness
        if any(
            not (
                readiness.analysis.ready if role is AgentRole.ANALYSIS else readiness.browser.ready
            )
            for role in selected_roles
        ):
            raise not_ready()
        return runtime
    except (AgentFailure, KeyError, TypeError, ValueError):
        raise not_ready() from None


def _browser_agent_declared(configuration: Configuration) -> bool:
    """Return whether the optional Browser role has any operator declaration."""

    return configuration.agents.browser.model is not None


def _browser_agent_dependency(
    configuration: Configuration,
    agent: AgentPort | None,
    *,
    model: str | None = None,
    budget: AgentBudget | None = None,
):
    """Convert a ready shared runtime to Acquisition's optional dependency.

    Production scoped graphs pass an :class:`AgentRuntime`, whose local
    readiness is authoritative.  The explicit low-level graph may inject a
    structural ``AgentPort`` instead; in that case a complete model/budget
    pair supplied by its explicit dependencies is the readiness declaration.
    No exception is swallowed here: malformed explicit values remain
    programming/configuration errors and fail closed at the Acquisition
    dependency boundary.
    """

    from sciretriever.acquisition.registry import BrowserAgentDependency

    if agent is None:
        return None
    if not isinstance(agent, AgentPort):
        raise TypeError("agent must implement AgentPort")
    if isinstance(agent, AgentRuntime):
        if not agent.readiness.browser.ready:
            return None
        selected_model = configuration.agents.browser.model if model is None else model
        selected_budget = (
            _agent_provider_limits(configuration, required_roles=frozenset({AgentRole.BROWSER}))
            if budget is None
            else budget
        )
    else:
        if model is None or budget is None:
            return None
        selected_model = model
        selected_budget = budget
    if selected_model is None:
        return None
    return BrowserAgentDependency(
        port=agent,
        model=selected_model,
        budget=selected_budget,
    )


__all__ = ()
