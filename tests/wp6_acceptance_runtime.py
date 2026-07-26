from __future__ import annotations

from io import BytesIO
from pathlib import Path

from PyPDF2 import PdfReader, PdfWriter

from sciretriever.acquisition import AcquisitionResult
from sciretriever.acquisition.existing_asset import ExistingAssetImporter
from sciretriever.analysis import AnalysisService
from sciretriever.catalog import (
    AssetRepository, CompletionFactsRepository, MetadataIngestionObservation,
    WorkRepository, WorkVersionDownloadRepository, create_catalog_engine,
    initialize_catalog,
)
from sciretriever.cli.analysis_runtime import AnalysisRuntimeServices
from sciretriever.cli.completion_runtime import (
    AcquisitionRuntimeConfig, AtomicAnalysisAdapter, CompletionRuntimeAdapters,
    OptionalAssetAdapter, RequiredPrimaryAdapter, WorkVersionIdentifierAdapter,
    assemble_completion_runtime,
)
from sciretriever.completion import MetadataResolutionPolicy
from sciretriever.config import MinerUConfig
from sciretriever.core.contracts import CandidateMetadata, Identifier
from sciretriever.discovery import MetadataSearchResult
from sciretriever.discovery.search_contracts import ExactMetadataOutput
from sciretriever.normalization import MinerUParsingService, MinerUSourceMapService
from sciretriever.storage import DerivedArtifactStore, RawAssetStore
from sciretriever.storage.coordinator import AssetAcceptanceCoordinator

from test_analysis_wp44 import FixtureProvider
from test_mineru_wp43 import CompletedClient, archive_bytes, middle_value


class OfflineBranchFailure(RuntimeError):
    def __str__(self) -> str:
        return "offline branch failure"


class OfflineMetadata:
    def __init__(self, repository: WorkRepository) -> None:
        self.repository = repository

    def resolve(self, request) -> ExactMetadataOutput:
        title = f"WP6 {request.doi.rsplit('/', 1)[-1]}"
        record = self.repository.ingest_metadata_batch(
            title=title,
            identifiers_to_persist=(Identifier("doi", request.doi),),
            observations=(MetadataIngestionObservation(
                "fixture", request.doi,
                (("doi", request.doi), ("title", title), ("language", "en")),
                (("provider", "fixture"),),
            ),),
            provider_precedence=("fixture",),
        )
        result = MetadataSearchResult(
            record, ("fixture",), (Identifier("doi", request.doi),),
            CandidateMetadata(title=title),
        )
        return ExactMetadataOutput(request.doi, result, ())


class OfflineAcquisition:
    def __init__(self, importer: ExistingAssetImporter, pdf_path: Path) -> None:
        self.importer = importer
        self.pdf_path = pdf_path
        self.fail_doi: str | None = None
        self.calls = 0

    async def acquire(self, work_version_id, role, target, providers, *, timeout):
        if any(
            item.namespace == "doi" and item.value == self.fail_doi
            for item in target.identifiers
        ):
            self.fail_doi = None
            raise OfflineBranchFailure
        self.calls += 1
        path = self.pdf_path
        if self.calls > 1:
            writer = PdfWriter()
            for page in PdfReader(self.pdf_path).pages:
                writer.add_page(page)
            writer.add_metadata({"/Subject": (f"offline WP6 {work_version_id} ") * 200})
            payload = BytesIO()
            writer.write(payload)
            path = self.pdf_path.with_name(f"{work_version_id}.pdf")
            path.write_bytes(payload.getvalue())
        result = self.importer.import_asset(path, work_version_id, role)
        disposition = "succeeded" if result.disposition == "imported" else "reused"
        return AcquisitionResult(work_version_id, disposition)


class AcceptanceRuntime:
    def __init__(self, root: Path, pdf_path: Path) -> None:
        self.catalog = create_catalog_engine(root / "catalog.sqlite", allow_repository_write=True)
        initialize_catalog(self.catalog)
        self.storage = root / "storage"
        self.storage.mkdir()
        self.raw_store = RawAssetStore(self.storage)
        self.derived_store = DerivedArtifactStore(self.storage)
        self.facts = CompletionFactsRepository(self.catalog)
        self.repository = WorkRepository(self.catalog)
        downloads = WorkVersionDownloadRepository(self.catalog)
        assets = AssetRepository(self.catalog)
        importer = ExistingAssetImporter(
            assets, AssetAcceptanceCoordinator(assets, self.raw_store)
        )
        self.metadata = OfflineMetadata(self.repository)
        self.acquisition = OfflineAcquisition(importer, pdf_path)
        configured = AcquisitionRuntimeConfig(
            downloads, self.acquisition, self.facts, ("fixture",), 1.0
        )
        provider = FixtureProvider()
        services = AnalysisRuntimeServices(
            self.facts, assets, self.raw_store,
            MinerUParsingService(
                self.catalog, self.derived_store,
                MinerUConfig(model="operator/model@fixture", poll_interval=0.01),
                CompletedClient(archive_bytes(middle_value())), sleep=lambda _: None,
            ),
            MinerUSourceMapService(
                self.catalog, self.raw_store, self.derived_store
            ),
            AnalysisService(
                self.catalog, self.derived_store, provider,
                configuration={"profile": "fixture"},
            ),
            10_000_000,
        )
        adapters = CompletionRuntimeAdapters(
            WorkVersionIdentifierAdapter(downloads), self.metadata,
            RequiredPrimaryAdapter(configured), AtomicAnalysisAdapter(services),
            OptionalAssetAdapter(configured),
        )
        policy = MetadataResolutionPolicy(("fixture",), ("fixture",))
        self.runtime = assemble_completion_runtime(self.catalog, adapters, policy)

    def table_count(self, table: str) -> int:
        with self.catalog.connect() as connection:
            return int(connection.exec_driver_sql(
                f"SELECT count(*) FROM {table}"
            ).scalar_one())

    def snapshot(self) -> tuple[int, ...]:
        return tuple(self.table_count(table) for table in (
            "works", "work_versions", "raw_assets", "current_analyses",
            "version_references", "diagnostic_records", "curation_operations",
            "package_versions",
        ))

    def close(self) -> None:
        self.catalog.dispose()


__all__ = ("AcceptanceRuntime",)
