from io import BytesIO
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import threading
import time
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import IdentityResolver, initialize_catalog, create_catalog_engine
from sciretriever.core.enums import PackageQuality
from sciretriever.core.package import SOURCE_MAP_KIND
from sciretriever.packaging import PackagePipeline
from sciretriever.storage import DerivedArtifactStore, RawAssetStore


class PackagePublicationTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name)
        self.root = base / "store"
        self.root.mkdir()
        self.raw = RawAssetStore(self.root)
        self.derived = DerivedArtifactStore(self.root)
        self.catalog = create_catalog_engine(base / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        resolution = IdentityResolver(self.catalog).create_or_reuse_work({"doi": "10.1/published"})
        self.work_id = resolution.work.id
        self.work_version_id = resolution.work_version.id
        payload = b"<article><title>Title</title><p>Full text</p><ref>doi:10.1/published</ref></article>"
        staged = self.raw.stage(BytesIO(payload), intent_id=str(uuid4()))
        publication = self.raw.publish(staged)
        self.raw.remove_staged(staged)
        raw_id = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, byte_size, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?)", (raw_id, publication.sha256, publication.storage_path, "application/xml", "xml", publication.byte_size, "{}"))
            connection.exec_driver_sql("INSERT INTO work_version_assets (work_version_id, raw_asset_id, asset_role) VALUES (?, ?, ?)", (self.work_version_id, raw_id, "xml"))
        self.pipeline = PackagePipeline(self.catalog, self.raw, self.derived)

    def test_xml_only_publication_and_exact_replay(self) -> None:
        first = self.pipeline.run(work_id=self.work_id)
        self.assertTrue(first.created)
        self.assertIs(first.package.quality, PackageQuality.LIMITED_XML_HTML)
        self.assertEqual(first.package.limitations, ("missing_primary_pdf",))
        first.package.validate_hash()
        second = self.pipeline.run(work_id=self.work_id)
        self.assertFalse(second.created)
        self.assertEqual(second.package, first.package)
        self.assertEqual(second.record, first.record)
        source_map_id = next(
            artifact.artifact_id
            for artifact in first.package.artifacts
            if artifact.kind == SOURCE_MAP_KIND
        )
        artifact_ids = {artifact.artifact_id for artifact in first.package.artifacts}
        package_lineage = {
            item.stage.value: set(item.input_artifact_ids)
            for item in first.package.lineage
            if item.stage.value in {"package_validation", "publication"}
        }
        self.assertEqual(
            package_lineage,
            {"package_validation": artifact_ids, "publication": artifact_ids},
        )
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM package_versions").scalar_one(), 1)
            anchors = connection.exec_driver_sql(
                "SELECT stage, input_artifact_id FROM processing_runs "
                "WHERE stage IN ('package_validation', 'publication')"
            ).all()
            self.assertEqual(
                set(anchors),
                {("package_validation", source_map_id), ("publication", source_map_id)},
            )
            self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_key_check").all(), [])

    def test_interrupted_catalog_registration_recovers_durable_target(self) -> None:
        with patch.object(
            self.pipeline.publisher.versions,
            "register_published",
            side_effect=RuntimeError("interrupted after durable publication"),
        ), self.assertRaises(RuntimeError):
            self.pipeline.run(work_id=self.work_id)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM package_versions").scalar_one(), 0)
            self.assertEqual(
                connection.exec_driver_sql(
                    "SELECT count(*) FROM processing_runs WHERE stage = 'publication' AND state = 'active'"
                ).scalar_one(),
                1,
            )
        recovered = self.pipeline.run(work_id=self.work_id)
        self.assertTrue(recovered.created)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM package_versions").scalar_one(), 1)
            self.assertEqual(
                connection.exec_driver_sql("SELECT count(*) FROM processing_runs WHERE state = 'active'").scalar_one(),
                0,
            )

    def test_concurrent_identical_publications_converge_to_create_and_replay(self) -> None:
        barrier = threading.Barrier(2)
        results = []
        failures = []

        def execute() -> None:
            try:
                barrier.wait(timeout=2)
                results.append(self.pipeline.run(work_id=self.work_id))
            except BaseException as error:
                failures.append(error)

        threads = [threading.Thread(target=execute) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        self.assertEqual(failures, [])
        self.assertEqual(len(results), 2)
        self.assertEqual(sorted(result.created for result in results), [False, True])
        self.assertEqual(results[0].package, results[1].package)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM package_versions").scalar_one(), 1)
            self.assertEqual(connection.exec_driver_sql(
                "SELECT count(*) FROM processing_runs WHERE state = 'active'").scalar_one(), 0)


if __name__ == "__main__":
    import unittest
    unittest.main()
