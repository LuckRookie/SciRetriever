from __future__ import annotations

from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from sciretriever.acquisition.models import AcquisitionResult, AcquisitionTarget
from sciretriever.acquisition.existing_asset import ExistingAssetImporter
from sciretriever.catalog.assets import AssetRepository
from sciretriever.catalog.completion_facts import CompletionFactsRepository
from sciretriever.catalog.download_selection import WorkVersionDownloadRecord
from sciretriever.catalog.engine import CatalogEngine, open_catalog_engine
from sciretriever.catalog.download_selection import WorkVersionDownloadRepository
from sciretriever.cli.acquisition_runtime import AcquisitionCliConfig, build_acquisition_service
from sciretriever.cli.analysis_runtime import (
    AnalysisCliRuntime, build_analysis_services,
)
from sciretriever.cli.analysis_completion import AtomicAnalysisAdapter
from sciretriever.cli.completion_unconfigured import (
    AnalysisOnlyRequiredPrimary, UNCONFIGURED_POLICY, UnconfiguredAnalysisPromotion,
    UnconfiguredExactMetadata, UnconfiguredOptionalAssets, UnconfiguredRequiredPrimary,
)
from sciretriever.cli.completion_context import (
    CommandCompletionRuntime, CompletionInvocationContext, CompletionRuntimeOptions,
)
from sciretriever.completion import (
    AtomicAnalysisPromotion,
    CompletionInvariantError,
    CompletionFactInspector,
    CompletionPipeline,
    CompletionServices,
    ExactMetadataResolution,
    MetadataResolutionPolicy,
    OptionalAssetAcquisition,
    OptionalAssetKind,
    OptionalAssetRequest,
    OptionalAssetResult,
    OutcomeDisposition,
    OutcomeReason,
    RequiredPrimaryAcquisition,
    RequiredPrimaryResult,
    WorkVersionIdentifierLookup,
)
from sciretriever.core.enums import AssetRole
from sciretriever.discovery.search import ExactMetadataResolver
from sciretriever.discovery.search_contracts import ExactMetadataOutput, ExactMetadataRequest
from sciretriever.errors import ConfigError
from sciretriever.storage.coordinator import AssetAcceptanceCoordinator
from sciretriever.storage.manager import RawAssetStore


class ExactMetadataAdapter:
    def __init__(self, resolver: ExactMetadataResolver) -> None:
        self.resolver = resolver
        self.failures = ()

    def resolve(self, request: ExactMetadataRequest) -> ExactMetadataOutput:
        output = self.resolver.resolve(request)
        self.failures = output.failures
        return output


class WorkVersionDownloadLookup(Protocol):
    def get(self, work_version_id: str) -> WorkVersionDownloadRecord: ...


class AcquisitionExecution(Protocol):
    async def acquire(self, work_version_id: str, role: AssetRole,
                      target: AcquisitionTarget, providers: tuple[str, ...],
                      *, timeout: float) -> AcquisitionResult: ...


class WorkVersionIdentifierAdapter:
    def __init__(self, repository: WorkVersionDownloadLookup) -> None:
        self.repository = repository

    def doi_for(self, work_version_id: str) -> str | None:
        record = self.repository.get(work_version_id)
        return next((value.value for value in record.identifiers
                     if value.namespace == "doi"), None)


def _target(record: WorkVersionDownloadRecord, role: AssetRole) -> AcquisitionTarget:
    return AcquisitionTarget(record.identifiers, record.direct_url, role, record.title,
                             record.authors, record.publication_year, record.publisher,
                             record.venue)


@dataclass(frozen=True, slots=True)
class AcquisitionRuntimeConfig:
    repository: WorkVersionDownloadLookup
    service: AcquisitionExecution
    facts: CompletionFactInspector
    providers: tuple[str, ...]
    timeout: float

    def __post_init__(self) -> None:
        if not self.providers or len(set(self.providers)) != len(self.providers):
            raise ValueError("acquisition providers must be unique and nonempty")
        if not isinstance(self.timeout, (int, float)) or isinstance(self.timeout, bool) or self.timeout <= 0:
            raise ValueError("acquisition timeout must be positive")


class RequiredPrimaryAdapter:
    def __init__(self, runtime: AcquisitionRuntimeConfig) -> None:
        self.runtime = runtime

    async def acquire(self, work_version_id: str) -> RequiredPrimaryResult:
        runtime = self.runtime
        before = runtime.facts.get(work_version_id)
        record = runtime.repository.get(work_version_id)
        result = await runtime.service.acquire(work_version_id, AssetRole.PRIMARY_PDF,
                                             _target(record, AssetRole.PRIMARY_PDF),
                                             runtime.providers, timeout=runtime.timeout)
        if result.work_version_id != work_version_id:
            raise CompletionInvariantError("acquisition owner returned a different WorkVersion")
        match result.status:
            case "succeeded":
                return RequiredPrimaryResult(work_version_id, OutcomeDisposition.ADVANCED,
                                             OutcomeReason.SUCCEEDED)
            case "reused":
                after = runtime.facts.get(work_version_id)
                if after != before:
                    return RequiredPrimaryResult(work_version_id, OutcomeDisposition.ADVANCED,
                                                 OutcomeReason.SUCCEEDED)
                return RequiredPrimaryResult(work_version_id, OutcomeDisposition.NOT_ADVANCED,
                                             OutcomeReason.ALREADY_SATISFIED)
            case "failed":
                return RequiredPrimaryResult(work_version_id, OutcomeDisposition.NOT_ADVANCED,
                                             OutcomeReason.EXHAUSTED)
            case _:
                raise ValueError("acquisition owner returned an unknown status")


class OptionalAssetAdapter:
    def __init__(self, runtime: AcquisitionRuntimeConfig) -> None:
        self.runtime = runtime

    async def acquire(self, request: OptionalAssetRequest) -> OptionalAssetResult:
        work_version_id = request.target.work_version_id
        role = AssetRole.XML if request.kind is OptionalAssetKind.XML else AssetRole.HTML
        runtime = self.runtime
        before = runtime.facts.get(work_version_id).stage
        record = runtime.repository.get(work_version_id)
        result = await runtime.service.acquire(work_version_id, role, _target(record, role),
                                               runtime.providers, timeout=runtime.timeout)
        if result.work_version_id != work_version_id:
            raise CompletionInvariantError("acquisition owner returned a different WorkVersion")
        match result.status:
            case "succeeded":
                return OptionalAssetResult(request, OutcomeDisposition.ADVANCED,
                                           OutcomeReason.SUCCEEDED, before)
            case "reused":
                return OptionalAssetResult(request, OutcomeDisposition.NOT_ADVANCED,
                                           OutcomeReason.ALREADY_SATISFIED, before)
            case "failed":
                return OptionalAssetResult(request, OutcomeDisposition.NOT_ADVANCED,
                                           OutcomeReason.EXHAUSTED, before)
            case _:
                raise ValueError("acquisition owner returned an unknown status")


@dataclass(frozen=True, slots=True)
class CompletionRuntimeAdapters:
    identifiers: WorkVersionIdentifierLookup
    exact_metadata: ExactMetadataResolution
    required_primary: RequiredPrimaryAcquisition
    analysis_promotion: AtomicAnalysisPromotion
    optional_assets: OptionalAssetAcquisition


@dataclass(frozen=True, slots=True)
class CompletionRuntime:
    facts: CompletionFactsRepository
    pipeline: CompletionPipeline
    adapters: CompletionRuntimeAdapters


def build_command_completion_runtime(
    catalog_path: Path,
    storage_root: Path,
    *,
    acquisition: AcquisitionCliConfig | None = None,
    acquisition_timeout: float = 30.0,
    analysis: AnalysisCliRuntime | None = None,
) -> CommandCompletionRuntime:
    with ExitStack() as cleanup:
        catalog = open_catalog_engine(catalog_path)
        cleanup.callback(catalog.dispose)
        context = CompletionInvocationContext(catalog, storage_root)
        options = CompletionRuntimeOptions(
            acquisition, acquisition_timeout, analysis,
        )
        completion = build_completion_runtime(context, options)
        cleanup.pop_all()
        return CommandCompletionRuntime(catalog, completion)


def build_completion_runtime(
    context: CompletionInvocationContext,
    options: CompletionRuntimeOptions,
) -> CompletionRuntime:
    catalog = context.catalog
    downloads = WorkVersionDownloadRepository(catalog)
    facts = CompletionFactsRepository(catalog)
    if options.acquisition is None:
        required = (
            AnalysisOnlyRequiredPrimary()
            if options.analysis is not None
            else UnconfiguredRequiredPrimary()
        )
        optional = UnconfiguredOptionalAssets()
    else:
        owner = build_acquisition_service(options.acquisition, catalog, context.storage_root)
        configured = AcquisitionRuntimeConfig(
            downloads, owner, facts, options.acquisition.providers,
            options.acquisition_timeout,
        )
        required = RequiredPrimaryAdapter(configured)
        optional = OptionalAssetAdapter(configured)
    analysis = options.analysis
    promotion = UnconfiguredAnalysisPromotion() if analysis is None else AtomicAnalysisAdapter(
        lambda: build_analysis_services(analysis, catalog, context.storage_root)
    )
    adapters = CompletionRuntimeAdapters(
        WorkVersionIdentifierAdapter(downloads), UnconfiguredExactMetadata(),
        required, promotion, optional,
    )
    return assemble_completion_runtime(catalog, adapters, UNCONFIGURED_POLICY)


def assemble_completion_runtime(catalog: CatalogEngine, adapters: CompletionRuntimeAdapters,
                                metadata_policy: MetadataResolutionPolicy) -> CompletionRuntime:
    facts = CompletionFactsRepository(catalog)
    services = CompletionServices(facts, adapters.identifiers, adapters.exact_metadata,
                                  adapters.required_primary, adapters.analysis_promotion,
                                  adapters.optional_assets)
    pipeline = CompletionPipeline(services, metadata_policy)
    return CompletionRuntime(facts, pipeline, adapters)


def build_existing_asset_importer(
    catalog: CatalogEngine, storage_root: Path,
) -> ExistingAssetImporter:
    assets = AssetRepository(catalog)
    return ExistingAssetImporter(
        assets,
        AssetAcceptanceCoordinator(assets, RawAssetStore(storage_root)),
    )


__all__ = ("AcquisitionExecution", "AcquisitionRuntimeConfig", "AtomicAnalysisAdapter",
           "CompletionInvocationContext", "CompletionRuntime", "CompletionRuntimeAdapters",
           "CompletionRuntimeOptions", "ExactMetadataAdapter",
           "OptionalAssetAdapter", "RequiredPrimaryAdapter", "WorkVersionDownloadLookup",
           "WorkVersionIdentifierAdapter", "assemble_completion_runtime",
           "build_completion_runtime", "build_existing_asset_importer")
