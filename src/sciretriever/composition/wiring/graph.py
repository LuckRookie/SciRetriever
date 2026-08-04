from __future__ import annotations

from dataclasses import dataclass

from typing_extensions import assert_never

from sciretriever.composition.configuration import SecretResolver, resolve_secret_reference
from sciretriever.composition.configuration.validation import validate_configuration
from sciretriever.infrastructure.llm.analysis import (
    AnalysisAdapterSettings,
    AnthropicAnalysisAdapter,
    OpenAIAnalysisAdapter,
)
from sciretriever.infrastructure.sources.registry import ProviderRegistry
from sciretriever.infrastructure.storage.files.publication import CoreArtifactStore
from sciretriever.infrastructure.storage.sqlite import (
    CompletionPublisher,
    SqliteLibraryReadRepository,
    SqliteLiteratureRepository,
)
from sciretriever.model.configuration import LLMProtocol, TargetConfig
from sciretriever.services.analysis.api import AnalysisService, AnalysisServiceDependencies
from sciretriever.services.library.api import LibraryService
from sciretriever.services.literature.api import CompletionAcceptanceService, LiteratureService

from .provider_registry import (
    ProviderDependencies,
    build_provider_registry_from_configuration,
)


@dataclass(frozen=True, slots=True)
class ObjectGraph:
    literature: LiteratureService
    library: LibraryService
    providers: ProviderRegistry | None = None
    analysis: AnalysisService | None = None


def build_object_graph(
    config: TargetConfig,
    *,
    provider_dependencies: ProviderDependencies | None = None,
    secret_resolver: SecretResolver | None = None,
) -> ObjectGraph:
    """Build only services backed by concrete M9 repositories and adapters."""
    validated = validate_configuration(config)
    literature_repository = SqliteLiteratureRepository(validated.paths.catalog)
    literature = LiteratureService(literature_repository)
    library = LibraryService(SqliteLibraryReadRepository(validated.paths.catalog))
    providers = (
        None
        if provider_dependencies is None
        else build_provider_registry_from_configuration(validated, provider_dependencies)
    )
    analysis = None
    if secret_resolver is not None:
        secret = resolve_secret_reference(validated.analysis.secret_ref, secret_resolver)
        llm = _analysis_adapter(validated, secret)
        completion = CompletionAcceptanceService(
            literature_repository,
            CompletionPublisher(validated.paths.catalog),
        )
        analysis = AnalysisService(
            AnalysisServiceDependencies(
                llm=llm,
                artifact_store=CoreArtifactStore(validated.paths.storage_root),
                completion=completion,
            )
        )
    return ObjectGraph(
        literature=literature,
        library=library,
        providers=providers,
        analysis=analysis,
    )


def _analysis_adapter(
    config: TargetConfig, secret: str
) -> OpenAIAnalysisAdapter | AnthropicAnalysisAdapter:
    settings = AnalysisAdapterSettings(
        base_url=config.analysis.base_url,
        model=config.analysis.model,
        timeout_seconds=config.analysis.timeout_seconds,
        max_output_tokens=config.analysis.max_output_tokens,
        max_input_characters=config.analysis.max_input_characters,
    )
    match config.analysis.protocol:
        case LLMProtocol.OPENAI:
            return OpenAIAnalysisAdapter(settings, secret)
        case LLMProtocol.ANTHROPIC:
            return AnthropicAnalysisAdapter(settings, secret)
        case unreachable:
            assert_never(unreachable)


__all__ = ("ObjectGraph", "build_object_graph")
