import hashlib
import importlib
from io import BytesIO
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import IdentityResolver, apply_migrations, create_catalog_engine
from sciretriever.normalization import NormalizationParameters
from sciretriever.storage import DerivedArtifactStore, RawAssetStore

NormalizationService = importlib.import_module("sciretriever.normalization").NormalizationService


class NormalizationServiceTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name)
        self.root = base / "store"
        self.root.mkdir()
        self.raw_store = RawAssetStore(self.root)
        self.derived_store = DerivedArtifactStore(self.root)
        self.catalog = create_catalog_engine(base / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        apply_migrations(self.catalog)
        self.work_id = IdentityResolver(self.catalog).create_or_reuse_work({"doi": "10.1/service"}).work.id
        payload = b"<article><title>Title</title><p>Complete body</p></article>"
        staged = self.raw_store.stage(BytesIO(payload), intent_id=str(uuid4()))
        publication = self.raw_store.publish(staged)
        self.raw_store.remove_staged(staged)
        self.raw_id = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, byte_size, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?)", (self.raw_id, publication.sha256, publication.storage_path, "application/xml", "xml", publication.byte_size, "{}"))
            connection.exec_driver_sql("INSERT INTO work_assets (work_id, raw_asset_id, asset_role) VALUES (?, ?, ?)", (self.work_id, self.raw_id, "xml"))

    def test_publication_registration_and_replay_without_parsing(self) -> None:
        service = NormalizationService(self.catalog, self.raw_store, self.derived_store)
        first = service.run(self.work_id)
        self.assertEqual(first.content.artifact_id, first.content_artifact.id)
        self.assertTrue(first.evidence)
        with patch("sciretriever.normalization.service.normalize_inputs", side_effect=AssertionError("reparsed")):
            replay = service.run(self.work_id)
        self.assertEqual(replay, first)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM normalized_artifacts").scalar_one(), 2)
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM processing_runs").scalar_one(), 1)

    def test_preexisting_active_run_is_recovered(self) -> None:
        service = NormalizationService(self.catalog, self.raw_store, self.derived_store)
        claimed = service.runs.claim_or_resume(
            self.work_id,
            "normalization",
            "sciretriever.normalizer",
            importlib.import_module("sciretriever.normalization").NORMALIZER_VERSION,
            NormalizationParameters().to_dict(),
            input_raw_asset_ids=(self.raw_id,),
        )
        self.assertEqual(claimed.state.value, "active")
        result = service.run(self.work_id)
        self.assertEqual(result.run.id, claimed.id)
        self.assertEqual(result.run.state.value, "succeeded")


if __name__ == "__main__":
    import unittest
    unittest.main()
