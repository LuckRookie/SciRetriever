"""Shared production adapter, identity, and readiness assembly helpers."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, NoReturn, cast
from uuid import uuid4

from sciretriever.analysis.ports import AnalysisLLMPort
from sciretriever.bootstrap.errors import BootstrapError
from sciretriever.bootstrap.graphs import BootstrapExternalDependencies
from sciretriever.configuration import CredentialLookup, RuntimeSecretLookup
from sciretriever.model.configuration import (
    AnalysisAuthentication,
    AnalysisProvider,
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
    if any(
        value is None
        for value in (
            analysis.provider,
            analysis.protocol,
            analysis.base_url,
            analysis.model,
            analysis.context_window_tokens,
            analysis.authentication,
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
    if any(
        value is None
        for value in (
            analysis.provider,
            analysis.protocol,
            analysis.base_url,
            analysis.model,
            analysis.context_window_tokens,
            analysis.authentication,
            analysis.reference_max_output_tokens,
        )
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


def _analysis_provider_limits(configuration: Configuration):  # noqa: ANN202
    from sciretriever.analysis.ports import LLMProviderLimits

    analysis = configuration.analysis
    return LLMProviderLimits(
        max_input_bytes=analysis.max_input_bytes or 1,
        max_output_tokens=max(
            analysis.metadata_max_output_tokens or 1,
            analysis.content_max_output_tokens or 1,
            analysis.reference_max_output_tokens or 1,
        ),
        context_window_tokens=analysis.context_window_tokens or 1_024,
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

    def analysis_factory(
        http_client: HttpClient,
        coordinator: AccessCoordinator,
    ) -> AnalysisLLMPort:
        return _build_analysis_llm(
            configuration,
            secrets,
            http_client,
            coordinator,
        )

    return BootstrapExternalDependencies(
        parser_factory=parser_factory,
        analysis_llm_factory=analysis_factory,
        analysis_model=analysis.model or "",
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
    from sciretriever.analysis.ports import AnalysisLLMFailure
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
    if isinstance(error, AnalysisLLMFailure):
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


def _build_analysis_llm(
    configuration: Configuration,
    secrets: RuntimeSecretLookup,
    http_client: HttpClient,
    coordinator: AccessCoordinator,
) -> AnalysisLLMPort:
    from sciretriever.analysis.ports import AnalysisLLMFailure
    from sciretriever.analysis.providers.anthropic import AnthropicAnalysisLLMAdapter
    from sciretriever.analysis.providers.openai import OpenAIAnalysisLLMAdapter
    from sciretriever.analysis.providers.openai_chat import (
        OpenAIChatCompletionsAnalysisLLMAdapter,
    )
    from sciretriever.model.configuration import AnalysisProtocol

    if getattr(http_client, "_coordinator", None) is not coordinator:
        raise BootstrapError("analysis-not-ready")
    analysis = configuration.analysis
    adapter_by_protocol = {
        AnalysisProtocol.OPENAI_RESPONSES: OpenAIAnalysisLLMAdapter,
        AnalysisProtocol.OPENAI_CHAT_COMPLETIONS: OpenAIChatCompletionsAnalysisLLMAdapter,
        AnalysisProtocol.ANTHROPIC_MESSAGES: AnthropicAnalysisLLMAdapter,
    }
    try:
        analysis_api_key = secrets.analysis_api_key
        if analysis.authentication is AnalysisAuthentication.API_KEY and analysis_api_key is None:
            raise BootstrapError("analysis-not-ready")
        protocol = analysis.protocol
        base_url = analysis.base_url
        if protocol is None or base_url is None:
            raise BootstrapError("analysis-not-ready")
        adapter = adapter_by_protocol[protocol]
        provider_name = (
            analysis.provider.value
            if analysis.provider is not AnalysisProvider.CUSTOM
            else analysis.service_name or "custom"
        )
        return cast(
            AnalysisLLMPort,
            adapter(
                http_client=http_client,
                api_key=analysis_api_key,
                base_url=base_url,
                provider_name=provider_name,
                limits=_analysis_provider_limits(configuration),
            ),
        )
    except (AnalysisLLMFailure, KeyError, TypeError, ValueError):
        raise BootstrapError("analysis-not-ready") from None


__all__ = ()
