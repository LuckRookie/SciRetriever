from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from io import BytesIO

import anyio
from PyPDF2 import PdfWriter

from sciretriever.acquisition import AcquisitionResult
from sciretriever.acquisition.existing_asset import ExistingAssetImporter
from sciretriever.analysis import AnalysisService
from sciretriever.catalog import (
    AssetRepository,
    CompletionFactsRepository,
    MetadataIngestionObservation,
    WorkRepository,
    WorkVersionDownloadRepository,
    create_catalog_engine,
    initialize_catalog,
)
from sciretriever.cli.analysis_runtime import AnalysisRuntimeServices
from sciretriever.cli.completion_runtime import (
    AcquisitionRuntimeConfig,
    AtomicAnalysisAdapter,
    CompletionRuntimeAdapters,
    OptionalAssetAdapter,
    RequiredPrimaryAdapter,
    WorkVersionIdentifierAdapter,
    assemble_completion_runtime,
)
from sciretriever.completion import MetadataResolutionPolicy
from sciretriever.config import MinerUConfig
from sciretriever.core.contracts import CandidateMetadata, Identifier
from sciretriever.core.enums import AssetRole
from sciretriever.discovery import MetadataSearchResult
from sciretriever.discovery.search_contracts import ExactMetadataOutput, ExactMetadataRequest
from sciretriever.normalization import MinerUParsingService, MinerUSourceMapService
from sciretriever.storage import DerivedArtifactStore, RawAssetStore
from sciretriever.storage.coordinator import AssetAcceptanceCoordinator

from test_analysis_wp44 import FixtureProvider
from test_mineru_wp43 import CompletedClient, archive_bytes, middle_value


DOI = "10.1234/wp5-real"
POLICY = MetadataResolutionPolicy(("fixture",), ("fixture",))


def pdf_bytes(seed: str = "0") -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=300)
    writer.add_blank_page(width=300, height=200)
    writer.pages[-1].rotation = 90
    writer.add_metadata({"/Subject": ("offline completion acceptance " + seed) * 200})
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


class OfflineMetadataResolver:
    def __init__(self, repository: WorkRepository) -> None:
        self.repository = repository
        self.calls = 0

    def resolve(self, request) -> ExactMetadataOutput:
        self.calls += 1
        record = self.repository.ingest_metadata_batch(
            title="WP5 Real Fixture",
            identifiers_to_persist=(Identifier("doi", request.doi),),
            observations=(MetadataIngestionObservation(
                "fixture", request.doi,
                (("doi", request.doi), ("title", "WP5 Real Fixture"),
                 ("language", "en")),
                (("provider", "fixture"),),
            ),),
            provider_precedence=("fixture",),
        )
        result = MetadataSearchResult(
            record, ("fixture",), (Identifier("doi", request.doi),),
            CandidateMetadata(title="WP5 Real Fixture"),
        )
        return ExactMetadataOutput(request.doi, result, ())


class OfflineAcquisition:
    def __init__(self, importer: ExistingAssetImporter, pdf_path: Path) -> None:
        self.importer = importer
        self.pdf_path = pdf_path
        self.calls = 0
        self.fail_next = False
        self.raise_next = False
        self.race_gate = False

    async def acquire(self, work_version_id, role, target, providers, *, timeout):
        self.calls += 1
        if self.race_gate:
            await anyio.sleep(0)
        if self.raise_next:
            self.raise_next = False
            raise RuntimeError("offline acquisition failure")
        if self.fail_next:
            self.fail_next = False
            return AcquisitionResult(work_version_id, "failed")
        path = self.pdf_path.with_name(f"fixture-{self.calls}.pdf")
        path.write_bytes(pdf_bytes(str(self.calls)))
        result = self.importer.import_asset(path, work_version_id, role)
        return AcquisitionResult(work_version_id, "succeeded" if result.disposition == "imported" else "reused")


class InterruptibleAnalysis:
    def __init__(self, owner: AtomicAnalysisAdapter) -> None:
        self.owner = owner
        self.calls = 0
        self.fail_next = False

    def promote(self, request):
        self.calls += 1
        if self.fail_next:
            self.fail_next = False
            raise RuntimeError("offline analysis failure")
        return self.owner.promote(request)


class RealCompletionFixture:
    @classmethod
    def create(cls) -> RealCompletionFixture:
        return cls()

    def __init__(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-wp5-real-")
        root = Path(self.temporary.name)
        self.catalog = create_catalog_engine(
            root / "catalog.sqlite", allow_repository_write=True
        )
        initialize_catalog(self.catalog)
        self.storage = root / "storage"
        self.storage.mkdir()
        self.pdf_path = root / "fixture.pdf"
        self.pdf_path.write_bytes(pdf_bytes())
        self.facts = CompletionFactsRepository(self.catalog)
        self.repository = WorkRepository(self.catalog)
        self.downloads = WorkVersionDownloadRepository(self.catalog)
        assets = AssetRepository(self.catalog)
        raw_store = RawAssetStore(self.storage)
        importer = ExistingAssetImporter(
            assets, AssetAcceptanceCoordinator(assets, raw_store)
        )
        self.metadata = OfflineMetadataResolver(self.repository)
        self.acquisition = OfflineAcquisition(importer, self.pdf_path)
        configured = AcquisitionRuntimeConfig(
            self.downloads, self.acquisition, self.facts, ("fixture",), 1.0
        )
        derived = DerivedArtifactStore(self.storage)
        services = AnalysisRuntimeServices(
            self.facts,
            assets,
            raw_store,
            MinerUParsingService(
                self.catalog, derived,
                MinerUConfig(model="operator/model@fixture", poll_interval=0.01),
                CompletedClient(archive_bytes(middle_value())),
                sleep=lambda _: None,
            ),
            MinerUSourceMapService(self.catalog, raw_store, derived),
            AnalysisService(
                self.catalog, derived, FixtureProvider(),
                configuration={"profile": "fixture"},
            ),
            10_000_000,
        )
        self.analysis = InterruptibleAnalysis(AtomicAnalysisAdapter(lambda: services))
        adapters = CompletionRuntimeAdapters(
            WorkVersionIdentifierAdapter(self.downloads),
            self.metadata,
            RequiredPrimaryAdapter(configured),
            self.analysis,
            OptionalAssetAdapter(configured),
        )
        self.runtime = assemble_completion_runtime(self.catalog, adapters, POLICY)

    def ingest(self, doi: str) -> str:
        output = self.metadata.resolve(ExactMetadataRequest(
            doi, ("fixture",), ("fixture",), 1.0, 1
        ))
        if output.result is None:
            raise AssertionError("offline metadata fixture did not persist a WorkVersion")
        return output.result.work_version.id

    def counts(self) -> tuple[int, ...]:
        tables = (
            "works", "work_versions", "metadata_observations",
            "provider_canonical_projections", "raw_assets",
            "work_version_assets", "current_analyses", "processing_runs",
            "normalized_artifacts",
        )
        with self.catalog.connect() as connection:
            return tuple(connection.exec_driver_sql(
                f"SELECT count(*) FROM {table}"
            ).scalar_one() for table in tables)

    def persisted_ids(self, work_version_id: str) -> tuple[str, str, str, str, int]:
        with self.catalog.connect() as connection:
            raw_id, raw_hash = connection.exec_driver_sql(
                "SELECT a.id, a.sha256 FROM raw_assets a "
                "JOIN work_version_assets wa ON wa.raw_asset_id = a.id "
                "WHERE wa.work_version_id = ? AND wa.asset_role = 'primary_pdf'",
                (work_version_id,),
            ).one()
            current_id, revision, run_id, artifact_id = connection.exec_driver_sql(
                "SELECT id, revision, processing_run_id, analysis_artifact_id "
                "FROM current_analyses WHERE work_version_id = ?",
                (work_version_id,),
            ).one()
            artifact_version, artifact_kind = connection.exec_driver_sql(
                "SELECT work_version_id, kind FROM normalized_artifacts WHERE id = ?",
                (artifact_id,),
            ).one()
            run_output = connection.exec_driver_sql(
                "SELECT output_artifact_id FROM processing_runs WHERE id = ?",
                (run_id,),
            ).scalar_one()
        if (artifact_version, artifact_kind, run_output) != (
            work_version_id, "analysis", artifact_id,
        ):
            raise AssertionError("analysis artifact, run, and current projection are not aligned")
        return raw_id, raw_hash, current_id, artifact_id, revision

    def close(self) -> None:
        self.catalog.dispose()
        self.temporary.cleanup()
