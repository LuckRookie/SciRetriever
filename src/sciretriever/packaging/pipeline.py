"""Bounded offline pipeline from accepted RawAssets to DocumentPackageVersion."""

from __future__ import annotations

from sciretriever.acquisition.admission import AdmissionService
from sciretriever.catalog.assets import AssetRepository
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.identity import IdentityResolver
from sciretriever.catalog.jobs import JobRepository
from sciretriever.catalog.packages import PackageSourceRepository
from sciretriever.catalog.processing import ProcessingRunRepository
from sciretriever.core.enums import AssetRole, PackageQuality
from sciretriever.storage import DerivedArtifactStore, RawAssetStore

from ..enrichment.models import Summarizer
from ..enrichment.service import GenericEnricher
from ..normalization.contracts import NormalizationParameters
from ..normalization.service import NormalizationService
from .publisher import PackagePublicationResult, PackagePublisher


class PackagePipeline:
    def __init__(
        self,
        catalog: CatalogEngine,
        raw_store: RawAssetStore,
        derived_store: DerivedArtifactStore,
        *,
        normalization_parameters: NormalizationParameters | None = None,
        summary_max_characters: int = 1_000,
    ) -> None:
        self.sources = PackageSourceRepository(catalog)
        self.runs = ProcessingRunRepository(catalog)
        self.completion_admission = AdmissionService(
            IdentityResolver(catalog),
            JobRepository(catalog),
            AssetRepository(catalog),
        )
        self.normalization = NormalizationService(catalog, raw_store, derived_store, normalization_parameters)
        self.enrichment = GenericEnricher(catalog, derived_store, summary_max_characters=summary_max_characters)
        self.publisher = PackagePublisher(catalog, derived_store)

    def run(
        self,
        *,
        work_id: str | None = None,
        raw_asset_id: str | None = None,
        work_version_id: str | None = None,
        summarizer: Summarizer | None = None,
        no_enrichment: bool = False,
    ) -> PackagePublicationResult:
        resolved = self.sources.resolve_work(
            work_id=work_id,
            raw_asset_id=raw_asset_id,
            work_version_id=work_version_id,
        )
        source_rows = self.sources.list_files(resolved)
        raw_ids = tuple(raw.id for _, raw in source_rows)
        acceptance = self.runs.claim_or_resume(
            resolved, "raw_acceptance", "sciretriever.raw_acceptance", "1", {},
            input_raw_asset_ids=raw_ids,
        )
        if acceptance.state.value != "succeeded":
            acceptance = self.runs.succeed(acceptance.id)
        normalized = self.normalization.run(resolved)
        enrichment = None if no_enrichment else self.enrichment.enrich(resolved, normalized, summarizer)
        publication = self.publisher.publish(resolved, acceptance, normalized, enrichment)
        if publication.package.quality is PackageQuality.LIMITED_XML_HTML:
            self.completion_admission.admit(
                self.sources.list_identifiers(resolved),
                provider="package-completion",
                asset_role=AssetRole.PRIMARY_PDF,
                provenance={"method": "package-quality-completion"},
            )
        return publication


__all__ = ("PackagePipeline",)
