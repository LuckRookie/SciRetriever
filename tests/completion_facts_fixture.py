from __future__ import annotations

from pathlib import Path
from io import BytesIO
import json
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase
from uuid import uuid4

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import (
    CompletionFactsRepository,
    CompletionStage,
    IdentityResolver,
    ManualMetadataRepository,
    MetadataIngestionObservation,
    TagRepository,
    WorkRepository,
    create_catalog_engine,
    initialize_catalog,
)
from sciretriever.analysis import AnalysisService
from sciretriever.config import MinerUConfig
from sciretriever.core.contracts import Identifier
from sciretriever.core.derivation import canonical_sha256
from sciretriever.normalization import MinerUParsingService, MinerUSourceMapService
from sciretriever.storage import DerivedArtifactStore, RawAssetStore

from test_analysis_wp44 import FixtureProvider
from test_mineru_wp43 import CompletedClient, archive_bytes, middle_value, pdf_bytes


class CompletionFactsFixture(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary.name) / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        self.repository = CompletionFactsRepository(self.catalog)
        self.storage = Path(self.temporary.name) / "storage"
        self.storage.mkdir()
        self.raw_store = RawAssetStore(self.storage)
        self.derived_store = DerivedArtifactStore(self.storage)

    def ingest(self, *, title: str = "Provider title", doi: str | None = "") -> str:
        if doi == "":
            doi = f"10.1234/{uuid4()}"
        identifiers = () if doi is None else (Identifier("doi", doi),)
        version = WorkRepository(self.catalog).ingest_metadata_batch(
            title=title,
            identifiers_to_persist=identifiers,
            observations=(MetadataIngestionObservation(
                "fixture", str(uuid4()), (("title", title), ("language", "en")),
                (("provider", "fixture"),),
            ),),
            provider_precedence=("fixture",),
        )
        return version.id

    def attach(self, work_version_id: str, *, role: str = "primary_pdf",
               media_type: str = "application/pdf", format_name: str = "pdf",
               content: bytes | None = None) -> str:
        value = content or ((pdf_bytes() + uuid4().bytes) if media_type == "application/pdf" else b"<article/>" + uuid4().bytes)
        staged = self.raw_store.stage(BytesIO(value), intent_id=str(uuid4()))
        published = self.raw_store.publish(staged)
        self.raw_store.remove_staged(staged)
        raw_id = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, byte_size, provenance_json) "
                "VALUES (?, ?, ?, ?, ?, ?, '{}')",
                (raw_id, published.sha256, published.storage_path, media_type, format_name, published.byte_size),
            )
            connection.exec_driver_sql(
                "INSERT INTO work_version_assets (work_version_id, raw_asset_id, asset_role) VALUES (?, ?, ?)",
                (work_version_id, raw_id, role),
            )
        return raw_id

    def complete(self) -> tuple[str, str, str]:
        work_version_id = self.ingest()
        pdf = pdf_bytes() + b"\n% fixture " + uuid4().hex.encode("ascii")
        raw_id = self.attach(work_version_id, content=pdf)
        parsed = MinerUParsingService(
            self.catalog,
            self.derived_store,
            MinerUConfig(model="operator/model@fixture", poll_interval=0.01),
            CompletedClient(archive_bytes(middle_value())),
            sleep=lambda _: None,
        ).run(work_version_id, raw_id, pdf)
        source = MinerUSourceMapService(
            self.catalog, self.raw_store, self.derived_store
        ).run(work_version_id, parsed)
        AnalysisService(
            self.catalog, self.derived_store, FixtureProvider(), configuration={"profile": "fixture"}
        ).run(work_version_id, source)
        facts = self.repository.get(work_version_id)
        if facts.current_analysis_id is None:
            self.fail("complete fixture did not create a current analysis")
        return work_version_id, raw_id, facts.current_analysis_id

    def replace_current_content(self, work_version_id: str, content: dict[str, object]) -> str:
        encoded = json.dumps(content, sort_keys=True, separators=(",", ":"))
        with self.catalog.transaction() as connection:
            current = connection.exec_driver_sql(
                "SELECT analysis_artifact_id, provenance_json FROM current_analyses WHERE work_version_id = ?",
                (work_version_id,),
            ).one()
            provenance = json.loads(current.provenance_json)
            provenance["document_sha256"] = canonical_sha256(content)
            encoded_provenance = json.dumps(provenance, sort_keys=True, separators=(",", ":"))
            connection.exec_driver_sql(
                "UPDATE current_analyses SET content_json = ?, provenance_json = ? WHERE work_version_id = ?",
                (encoded, encoded_provenance, work_version_id),
            )
            connection.exec_driver_sql(
                "UPDATE normalized_artifacts SET provenance_json = ? WHERE id = ?",
                (encoded_provenance, current.analysis_artifact_id),
            )
        return current.analysis_artifact_id
