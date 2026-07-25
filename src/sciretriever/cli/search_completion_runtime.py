from __future__ import annotations

from collections.abc import Mapping
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path

from sciretriever.catalog import CompletionFactsRepository, WorkRepository, open_catalog_engine
from sciretriever.catalog.download_selection import WorkVersionDownloadRepository
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.cli import metadata_runtime
from sciretriever.cli.acquisition_runtime import AcquisitionCliConfig, build_acquisition_service
from sciretriever.cli.analysis_runtime import AnalysisCliRuntime, build_analysis_services
from sciretriever.cli.completion_runtime import (
    AcquisitionRuntimeConfig, AtomicAnalysisAdapter, CompletionRuntime,
    CompletionRuntimeAdapters, ExactMetadataAdapter, OptionalAssetAdapter,
    RequiredPrimaryAdapter, WorkVersionIdentifierAdapter, assemble_completion_runtime,
)
from sciretriever.completion import (
    AnalysisPromotionRequest, AnalysisPromotionResult, MetadataResolutionPolicy,
    OptionalAssetRequest, OptionalAssetResult, RequiredPrimaryResult,
)
from sciretriever.discovery import MetadataSearchOutput
from sciretriever.discovery.providers.base import DiscoveryProvider


@dataclass(frozen=True, slots=True)
class SearchCliRuntime:
    catalog: Path
    level: str
    metadata: metadata_runtime.MetadataCliConfig
    storage_root: Path | None = None
    acquisition: AcquisitionCliConfig | None = None
    acquisition_timeout: float = 30.0
    analysis: AnalysisCliRuntime | None = None


@dataclass(slots=True)
class SearchCompletionRuntime:
    catalog: CatalogEngine
    completion: CompletionRuntime
    metadata_config: metadata_runtime.MetadataCliConfig
    metadata_providers: Mapping[str, DiscoveryProvider]
    exact_metadata: ExactMetadataAdapter

    def search(self) -> MetadataSearchOutput:
        return metadata_runtime.run_metadata_search(
            self.metadata_config, self.metadata_providers, WorkRepository(self.catalog))

    def exact_failures(self) -> list[dict[str, str]]:
        return [
            {"category": item.category, "message": item.message, "provider": item.provider}
            for item in self.exact_metadata.failures
        ]

    @staticmethod
    def targets(output: MetadataSearchOutput) -> tuple[str, ...]:
        return tuple(item.work_version.id for item in output.results)

    def close(self) -> None:
        self.catalog.dispose()


def build_search_completion_runtime(config: SearchCliRuntime) -> SearchCompletionRuntime:
    with ExitStack() as cleanup:
        catalog = open_catalog_engine(config.catalog)
        cleanup.callback(catalog.dispose)
        providers = metadata_runtime.build_metadata_providers(config.metadata)
        repository = WorkRepository(catalog)
        downloads = WorkVersionDownloadRepository(catalog)
        facts = CompletionFactsRepository(catalog)
        root = None if config.storage_root is None else config.storage_root.expanduser()
        if root is not None and (not root.is_dir() or root.is_symlink()):
            raise ValueError("storage root must be an existing real directory")
        if root is None:
            required = UnconfiguredRequiredAcquisition()
            optional = UnconfiguredOptionalAcquisition()
        else:
            if config.acquisition is None:
                raise ValueError("acquisition runtime is not configured")
            service = build_acquisition_service(config.acquisition, catalog, root)
            acquisition = AcquisitionRuntimeConfig(
                downloads, service, facts, config.acquisition.providers,
                config.acquisition_timeout,
            )
            required = RequiredPrimaryAdapter(acquisition)
            optional = OptionalAssetAdapter(acquisition)
        if config.level == "analyze":
            if root is None or config.analysis is None:
                raise ValueError("analysis runtime is not configured")
            analysis = AtomicAnalysisAdapter(build_analysis_services(config.analysis, catalog, root))
        else:
            analysis = UnconfiguredAnalysisPromotion()
        exact = ExactMetadataAdapter(metadata_runtime.build_exact_resolver(providers, repository))
        adapters = CompletionRuntimeAdapters(
            WorkVersionIdentifierAdapter(downloads), exact, required, analysis, optional,
        )
        metadata = config.metadata
        policy = MetadataResolutionPolicy(
            metadata.providers, metadata.precedence,
            metadata.provider_timeout, metadata.max_concurrency,
        )
        completion = assemble_completion_runtime(catalog, adapters, policy)
        cleanup.pop_all()
        return SearchCompletionRuntime(catalog, completion, metadata, providers, exact)


class UnconfiguredRequiredAcquisition:
    async def acquire(self, work_version_id: str) -> RequiredPrimaryResult:
        raise ValueError("required acquisition is not configured")


class UnconfiguredOptionalAcquisition:
    async def acquire(self, request: OptionalAssetRequest) -> OptionalAssetResult:
        raise ValueError("optional acquisition is not configured")


class UnconfiguredAnalysisPromotion:
    def promote(self, request: AnalysisPromotionRequest) -> AnalysisPromotionResult:
        raise ValueError("analysis is not configured")


__all__ = (
    "SearchCliRuntime", "SearchCompletionRuntime", "UnconfiguredAnalysisPromotion",
    "UnconfiguredOptionalAcquisition", "UnconfiguredRequiredAcquisition",
    "build_search_completion_runtime",
)
