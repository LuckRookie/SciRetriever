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
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM package_versions").scalar_one(), 1)
            self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_key_check").all(), [])

    def test_summarizer_failure_uses_fallback_and_is_recorded_once(self) -> None:
        class FailingSummarizer:
            name = "failing"
            version = "1"
            calls = 0

            def summarize(self, text: str, max_characters: int) -> str:
                self.calls += 1
                self.assert_clean = "  " not in text
                raise RuntimeError("injected failure")

        summarizer = FailingSummarizer()
        first = self.pipeline.run(work_id=self.work_id, summarizer=summarizer)
        self.assertIsNotNone(first.package.light_structure.summary)
        self.assertEqual(summarizer.calls, 1)
        self.assertTrue(summarizer.assert_clean)
        second = self.pipeline.run(work_id=self.work_id, summarizer=summarizer)
        self.assertEqual(second.package, first.package)
        self.assertEqual(summarizer.calls, 1)
        with self.catalog.connect() as connection:
            self.assertEqual(
                connection.exec_driver_sql(
                    "SELECT count(*) FROM failures WHERE category = 'summarizer_failed'"
                ).scalar_one(),
                1,
            )

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

    def test_concurrent_pipeline_calls_converge_without_duplicate_summary(self) -> None:
        class CountingSummarizer:
            name = "counting"
            version = "1"

            def __init__(self) -> None:
                self.calls = 0
                self.lock = threading.Lock()

            def summarize(self, text: str, max_characters: int) -> str:
                with self.lock:
                    self.calls += 1
                time.sleep(0.1)
                return text[:max_characters]

        summarizer = CountingSummarizer()
        barrier = threading.Barrier(2)
        results = []
        failures = []

        def execute() -> None:
            try:
                barrier.wait(timeout=2)
                results.append(self.pipeline.run(work_id=self.work_id, summarizer=summarizer))
            except BaseException as error:
                failures.append(error)

        threads = [threading.Thread(target=execute) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
        self.assertEqual(failures, [])
        self.assertEqual(len(results), 2)
        self.assertEqual(summarizer.calls, 1)
        self.assertEqual(sorted(result.created for result in results), [False, True])
        self.assertEqual(results[0].package, results[1].package)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM package_versions").scalar_one(), 1)
            self.assertEqual(
                connection.exec_driver_sql("SELECT count(*) FROM processing_runs WHERE state = 'active'").scalar_one(),
                0,
            )

    def test_changed_material_creates_next_version_and_then_replays(self) -> None:
        first = self.pipeline.run(work_id=self.work_id)
        changed = self.pipeline.run(work_id=self.work_id, no_enrichment=True)
        replay = self.pipeline.run(work_id=self.work_id, no_enrichment=True)
        self.assertEqual(first.package.package_version, 1)
        self.assertEqual(changed.package.package_version, 2)
        self.assertTrue(changed.created)
        self.assertFalse(replay.created)
        self.assertEqual(replay.package, changed.package)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM package_versions").scalar_one(), 2)


if __name__ == "__main__":
    import unittest
    unittest.main()
