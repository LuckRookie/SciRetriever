"""P9 adapter/security tests plus product AC-5 through AC-9 coverage."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
import threading
import time
from tempfile import TemporaryDirectory
from typing import cast
from unittest import TestCase, mock
from PyPDF2 import PdfWriter

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition.admission import AdmissionService
from sciretriever.catalog import apply_migrations, create_catalog_engine
from sciretriever.catalog.assets import AssetRepository
from sciretriever.catalog.identity import IdentityResolver
from sciretriever.catalog.jobs import JobRepository
from sciretriever.catalog.models import metadata as catalog_metadata
from sciretriever.catalog.packages import PackageVersionRepository
from sciretriever.catalog.records import PackageVersionRecord
from sciretriever.catalog.repository import CatalogRepository
from sciretriever.cli.main import main
from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole, AttemptOutcome, JobState, PackageQuality
from sciretriever.errors import SciRetrieverError
from sciretriever.legacy import ExistingAssetImporter, LegacyPaperAdapter, LegacySQLiteReader
from sciretriever.packaging import PackagePipeline
from sciretriever.packaging.publisher import PackagePublisher
from sciretriever.storage.coordinator import AssetAcceptanceCoordinator
from sciretriever.storage.derived import DerivedArtifactStore
from sciretriever.storage.manager import RawAssetStore


XML_BYTES = b"<article><front><title-group><article-title>P9</article-title></title-group></front><body><p>Evidence text.</p></body></article>"


def valid_pdf() -> bytes:
    stream = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.add_blank_page(width=612, height=792)
    writer.add_metadata({"/Subject": "P9 acceptance evidence " * 100})
    writer.write(stream)
    return stream.getvalue()


def create_legacy(path: Path, count: int = 1) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.execute(
            "CREATE TABLE papers (id INTEGER PRIMARY KEY, title TEXT, authors JSON, abstract TEXT, "
            "doi TEXT, url TEXT, pub_year INTEGER, journal TEXT, keywords JSON, pdf_path TEXT)"
        )
        connection.executemany(
            "INSERT INTO papers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ((index, f"Title {index}", '["A"]', "Abstract", None, None, 2024, "Venue", '["key"]', None)
             for index in range(1, count + 1)),
        )
        connection.commit()
    finally:
        connection.close()


class P9AcceptanceTests(TestCase):
    def setUp(self) -> None:
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.catalog_path = self.root / "catalog.sqlite"
        self.storage_root = self.root / "storage"
        self.storage_root.mkdir()
        self.asset = self.root / "article.xml"
        self.asset.write_bytes(XML_BYTES)

    def importer(self):
        catalog = create_catalog_engine(self.catalog_path)
        apply_migrations(catalog)
        assets = AssetRepository(catalog)
        jobs = JobRepository(catalog)
        repository = CatalogRepository(catalog)
        importer = ExistingAssetImporter(
            AdmissionService(IdentityResolver(catalog), jobs, assets), repository, jobs, assets,
            AssetAcceptanceCoordinator(assets, RawAssetStore(self.storage_root)),
        )
        self.addCleanup(catalog.dispose)
        return catalog, assets, jobs, importer

    @staticmethod
    def catalog_counts(catalog) -> tuple[int, ...]:
        tables = (
            "works", "identifiers", "identity_reviews", "acquisition_jobs",
            "download_requests", "acquisition_attempts", "asset_intents",
            "raw_assets", "work_assets",
        )
        with catalog.connect() as connection:
            return tuple(
                connection.exec_driver_sql(f"SELECT count(*) FROM {table}").scalar_one()
                for table in tables
            )

    def test_neutral_adapter_mapping_and_malformed_values(self) -> None:
        row = {"id": 7, "title": " A title ", "authors": '["One", "Two"]', "abstract": "A", "doi": "DOI:10.1/X", "url": "https://example.test/p", "pub_year": 2020, "journal": "J", "keywords": '["k"]', "pdf_path": "paper.pdf", "notes": "excluded", "paper_metadata": '{"secret": 1}'}
        record = LegacyPaperAdapter.map(row, "source-a")
        self.assertEqual(record.metadata.authors, ("One", "Two"))
        self.assertEqual(record.metadata.venue, "J")
        self.assertEqual(record.identifiers[0], Identifier("legacy-paper", "source-a:7"))
        self.assertFalse(hasattr(record, "notes"))
        with self.assertRaises((TypeError, ValueError)):
            LegacyPaperAdapter.map({**row, "authors": "not-json"}, "source-a")

    def test_read_only_streaming_over_1000_and_schema_errors(self) -> None:
        database = self.root / "legacy.sqlite"
        create_legacy(database, 1005)
        before = database.read_bytes()
        rows = list(LegacySQLiteReader(database, batch_size=37).rows())
        self.assertEqual((len(rows), rows[0]["id"], rows[-1]["id"]), (1005, 1, 1005))
        self.assertEqual(database.read_bytes(), before)
        malformed = self.root / "malformed.sqlite"
        sqlite3.connect(malformed).close()
        with self.assertRaisesRegex(ValueError, "papers table"):
            list(LegacySQLiteReader(malformed).rows())

    def test_invalid_sources_have_zero_catalog_side_effects(self) -> None:
        catalog, _, _, importer = self.importer()
        identifiers = (Identifier("doi", "10.1/invalid"),)
        missing = self.root / "missing.xml"
        malformed = self.root / "malformed.xml"
        malformed.write_bytes(b"not xml" * 10)
        symlink = self.root / "link.xml"
        symlink.symlink_to(self.asset)
        oversized = self.root / "large.xml"
        oversized.write_bytes(b"x" * 65)
        bounded = ExistingAssetImporter(
            importer.admission, importer.catalog, importer.jobs, importer.assets,
            importer.coordinator, max_bytes=64,
        )
        cases = (
            (importer, missing, AssetRole.XML, None),
            (importer, malformed, AssetRole.XML, None),
            (importer, symlink, AssetRole.XML, None),
            (bounded, oversized, AssetRole.XML, None),
            (importer, self.asset, AssetRole.PRIMARY_PDF, None),
        )
        for candidate_importer, path, role, root in cases:
            with self.subTest(path=path.name, role=role.value):
                with self.assertRaises((OSError, SciRetrieverError, ValueError)):
                    candidate_importer.import_asset(path, identifiers, role, asset_root=root)
                self.assertEqual(self.catalog_counts(catalog), (0,) * 9)
        with mock.patch.object(importer, "_snapshot", side_effect=ValueError("asset changed while being read")):
            with self.assertRaisesRegex(ValueError, "changed"):
                importer.import_asset(self.asset, identifiers, AssetRole.XML)
        self.assertEqual(self.catalog_counts(catalog), (0,) * 9)

    def test_asset_root_rejects_absolute_escape_and_symlink_components(self) -> None:
        catalog, _, _, importer = self.importer()
        asset_root = self.root / "assets"
        asset_root.mkdir()
        outside = self.root / "outside.xml"
        outside.write_bytes(XML_BYTES)
        with self.assertRaisesRegex(ValueError, "escapes"):
            importer.resolve_asset(outside, asset_root=asset_root)
        real = asset_root / "real"
        real.mkdir()
        (real / "paper.xml").write_bytes(XML_BYTES)
        intermediate = asset_root / "alias"
        intermediate.symlink_to(real, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink components"):
            importer.resolve_asset(intermediate / "paper.xml", asset_root=asset_root)
        root_alias = self.root / "asset-root-alias"
        root_alias.symlink_to(asset_root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink components"):
            importer.resolve_asset(real / "paper.xml", asset_root=root_alias)

    def test_exact_replay_raw_hash_mode_and_neutral_provenance(self) -> None:
        _, assets, _, importer = self.importer()
        identifier = (Identifier("doi", "10.1/replay"),)
        first = importer.import_asset(self.asset, identifier, AssetRole.XML, source_id="legacy-a")
        conflicting = self.root / "missing.xml"
        second = importer.import_asset(conflicting, identifier, AssetRole.XML, source_id="legacy-a")
        self.assertEqual((first.work_id, first.raw_asset_id, first.sha256), (second.work_id, second.raw_asset_id, second.sha256))
        self.assertEqual(second.disposition, "replayed")
        raw = assets.get_raw_asset(first.raw_asset_id)
        self.assertEqual(first.sha256, hashlib.sha256(XML_BYTES).hexdigest())
        stored = self.storage_root / raw.storage_path
        self.assertEqual(stored.read_bytes(), XML_BYTES)
        self.assertEqual(stat.S_IMODE(stored.stat().st_mode), 0o400)
        provenance = json.loads(raw.provenance_json)
        self.assertEqual(provenance, {"method": "existing-asset-import", "source_id": "legacy-a"})
        self.assertNotIn(str(self.root), raw.provenance_json)

    def test_product_ac9_concurrent_imports_converge_to_one_work_and_role_asset(self) -> None:
        catalog, assets, _, importer = self.importer()
        contender_count = 8
        barrier = threading.Barrier(contender_count)
        results = []
        errors = []

        def run() -> None:
            try:
                barrier.wait()
                results.append(importer.import_asset(self.asset, (Identifier("doi", "10.1/concurrent"),), AssetRole.XML))
            except Exception as error:
                errors.append(error)

        threads = [threading.Thread(target=run) for _ in range(contender_count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(len(results), contender_count)
        self.assertEqual({item.raw_asset_id for item in results}, {results[0].raw_asset_id})
        self.assertEqual({item.sha256 for item in results}, {results[0].sha256})
        self.assertEqual({item.work_id for item in results}, {results[0].work_id})
        self.assertEqual(len(assets.get_work_assets(results[0].work_id)), 1)
        with catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM works").scalar_one(), 1)
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM acquisition_jobs WHERE state IN ('pending','active','retryable','paused')").scalar_one(), 0)

    def test_coordinator_failure_closes_attempt_and_job(self) -> None:
        catalog, _, jobs, importer = self.importer()
        importer.coordinator = mock.Mock()
        importer.coordinator.accept.side_effect = OSError("storage failed")
        with self.assertRaises(OSError):
            importer.import_asset(self.asset, (Identifier("doi", "10.1/fail"),), AssetRole.XML)
        work = CatalogRepository(catalog).lookup_work(Identifier("doi", "10.1/fail"))
        self.assertIsNotNone(work)
        with catalog.connect() as connection:
            job_id = connection.exec_driver_sql("SELECT id FROM acquisition_jobs WHERE work_id = ?", (work.id,)).scalar_one()
        job = jobs.get_job(job_id)
        self.assertIsNotNone(job)
        self.assertEqual(job.state, JobState.FAILED)
        attempt = jobs.list_attempts(job.id)[0]
        self.assertIsNotNone(attempt.finished_at)

    def test_finish_boundaries_leave_no_active_or_unfinished_lifecycle(self) -> None:
        catalog, _, jobs, importer = self.importer()
        with mock.patch.object(jobs, "finish_attempt_and_job", side_effect=OSError("finish failed")):
            with self.assertRaisesRegex(OSError, "finish failed"):
                importer.import_asset(self.asset, (Identifier("doi", "10.1/finish-success"),), AssetRole.XML)
        work = CatalogRepository(catalog).lookup_work(Identifier("doi", "10.1/finish-success"))
        self.assertIsNotNone(work)
        with catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM acquisition_jobs WHERE state='active'").scalar_one(), 0)
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM acquisition_attempts WHERE finished_at IS NULL").scalar_one(), 0)

        failing = self.root / "second.xml"
        failing.write_bytes(XML_BYTES)
        importer.coordinator = mock.Mock()
        importer.coordinator.accept.side_effect = OSError("coordinator failed")
        calls = 0

        def fail_atomic(*args, **kwargs):
            nonlocal calls
            calls += 1
            raise OSError("atomic finish failed")

        with mock.patch.object(jobs, "finish_attempt_and_job", side_effect=fail_atomic):
            with self.assertRaisesRegex(OSError, "coordinator failed"):
                importer.import_asset(failing, (Identifier("doi", "10.1/finish-failure"),), AssetRole.XML)
        self.assertEqual(calls, 1)
        with catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM acquisition_jobs WHERE state='active'").scalar_one(), 0)
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM acquisition_attempts WHERE finished_at IS NULL").scalar_one(), 0)

    def test_failed_winner_is_detected_without_full_wait(self) -> None:
        _, _, jobs, importer = self.importer()
        identifiers = (Identifier("doi", "10.1/failed-winner"),)
        admitted = importer.admission.admit(identifiers, provider="legacy-import", asset_role=AssetRole.XML)
        jobs.restart_foreground_job(cast(str, admitted.job_id))
        attempt = jobs.start_attempt(cast(str, admitted.job_id), "legacy-import")
        jobs.finish_attempt_and_job(attempt.id, AttemptOutcome.FAILED, JobState.FAILED)
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, "failed"):
            importer.import_asset(self.asset, identifiers, AssetRole.XML)
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertIsNotNone(jobs.get_attempt(attempt.id).finished_at)

    def test_catalog_cli_and_argument_exit_contracts(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(main(["catalog", "create", "--catalog", str(self.catalog_path)]), 0)
        self.assertIn("disposition=created", output.getvalue())
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = main(["catalog", "import-asset", "--catalog", str(self.catalog_path), "--storage-root", str(self.storage_root), "--asset", str(self.asset), "--asset-role", "xml", "--identifier", "doi=10.1/cli"])
        self.assertEqual(code, 0)
        for field in ("disposition=imported", "work_id=", "raw_asset_id=", "sha256="):
            self.assertIn(field, output.getvalue())
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            main(["catalog", "import-asset"])
        self.assertEqual(raised.exception.code, 2)
        base = ["catalog", "import-asset", "--catalog", str(self.catalog_path), "--storage-root", str(self.storage_root), "--asset", str(self.asset)]
        for tail in (("--asset-role", "xml", "--identifier", "broken"), ("--asset-role", "wrong", "--identifier", "doi=10.1/x")):
            error = io.StringIO()
            with contextlib.redirect_stderr(error), self.assertRaises(SystemExit) as raised:
                main([*base, *tail])
            self.assertEqual(raised.exception.code, 2)
            self.assertNotIn("Traceback", error.getvalue())

    def test_legacy_batch_one_shot_replay_and_integrity(self) -> None:
        database = self.root / "legacy.sqlite"
        asset_root = self.root / "assets"
        asset_root.mkdir()
        (asset_root / "paper.pdf").write_bytes(valid_pdf())
        create_legacy(database)
        connection = sqlite3.connect(database)
        connection.execute("UPDATE papers SET doi=?, pdf_path=? WHERE id=1", ("10.1/batch", "paper.pdf"))
        connection.commit()
        connection.close()
        self.assertEqual(main(["catalog", "create", "--catalog", str(self.catalog_path)]), 0)
        command = ["catalog", "import-legacy-db", "--catalog", str(self.catalog_path), "--storage-root", str(self.storage_root), "--legacy-db", str(database), "--asset-root", str(asset_root), "--legacy-source-id", "db-a"]
        first = io.StringIO()
        with contextlib.redirect_stdout(first), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(main(command), 0)
        self.assertIn("imported=1 replayed=0 skipped=0 failed=0", first.getvalue())
        second = io.StringIO()
        with contextlib.redirect_stdout(second), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(main(command), 0)
        self.assertIn("imported=0 replayed=1 skipped=0 failed=0", second.getvalue())
        check = sqlite3.connect(self.catalog_path)
        try:
            self.assertEqual(check.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(check.execute("PRAGMA foreign_key_check").fetchall(), [])
        finally:
            check.close()

    def test_retired_alias_refusal_and_no_legacy_orm_dependency(self) -> None:
        retired = REPOSITORY / "all.db"
        with self.assertRaises(PermissionError):
            LegacySQLiteReader(retired)
        source = (SRC / "sciretriever" / "legacy" / "importer.py").read_text(encoding="utf-8")
        self.assertNotIn("SciRetriever.database.model", source)
        self.assertNotIn("Optera", source)

    def test_product_ac5_duplicate_doi_has_one_work_and_no_duplicate_nonterminal_job(self) -> None:
        catalog, assets, jobs, _ = self.importer()
        service = AdmissionService(IdentityResolver(catalog), jobs, assets)
        identifier = (Identifier("doi", "10.1/ac5"),)
        first = service.admit(identifier, provider="legacy-import", asset_role=AssetRole.PRIMARY_PDF)
        second = service.admit(identifier, provider="legacy-import", asset_role=AssetRole.PRIMARY_PDF)
        self.assertEqual((first.work_id, first.job_id), (second.work_id, second.job_id))
        with catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM works").scalar_one(), 1)
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM acquisition_jobs WHERE state IN ('pending','active','retryable','paused')").scalar_one(), 1)

    def _publish_imported_xml(self):
        catalog, assets, jobs, importer = self.importer()
        imported = importer.import_asset(self.asset, (Identifier("doi", "10.1/package"),), AssetRole.XML)
        raw_store = RawAssetStore(self.storage_root)
        derived_store = DerivedArtifactStore(self.storage_root)
        publication = PackagePipeline(catalog, raw_store, derived_store).run(work_id=imported.work_id)
        return catalog, assets, jobs, imported, derived_store, publication

    def test_product_ac6_limited_xml_package_then_distinct_pending_pdf_job(self) -> None:
        catalog, assets, _, imported, _, publication = self._publish_imported_xml()
        self.assertIs(publication.package.quality, PackageQuality.LIMITED_XML_HTML)
        self.assertIn("missing_primary_pdf", publication.package.limitations)
        self.assertEqual(len(assets.get_work_assets(imported.work_id)), 1)
        with catalog.connect() as connection:
            pending = connection.exec_driver_sql(
                "SELECT asset_role, state FROM acquisition_jobs "
                "WHERE work_id = ? AND asset_role = ?",
                (imported.work_id, AssetRole.PRIMARY_PDF.value),
            ).all()
        self.assertEqual(pending, [(AssetRole.PRIMARY_PDF.value, JobState.PENDING.value)])

    def test_product_ac7_raw_immutability_and_normalized_evidence(self) -> None:
        _, assets, _, imported, _, publication = self._publish_imported_xml()
        raw = assets.get_raw_asset(imported.raw_asset_id)
        stored = self.storage_root / raw.storage_path
        self.assertEqual(raw.sha256, hashlib.sha256(XML_BYTES).hexdigest())
        self.assertEqual(stored.read_bytes(), XML_BYTES)
        self.assertEqual(stat.S_IMODE(stored.stat().st_mode), 0o400)
        self.assertTrue(publication.package.evidence)
        for evidence in publication.package.evidence:
            self.assertEqual(evidence.file_id, raw.id)
            self.assertLess(evidence.source_start, evidence.source_end)
            self.assertTrue(evidence.normalized_path.startswith("/"))

    def test_product_ac8_neutral_schema_and_stable_package_retrieval(self) -> None:
        catalog, _, _, imported, derived_store, publication = self._publish_imported_xml()
        columns = {column.name.lower() for table in catalog_metadata.tables.values() for column in table.columns}
        for forbidden in ("reaction", "molecule", "yield"):
            self.assertNotIn(forbidden, columns)
        record = PackageVersionRepository(catalog).get_by_document_hash(
            imported.work_id,
            publication.package.package_sha256,
        )
        self.assertIsNotNone(record)
        package_record = cast(PackageVersionRecord, record)
        self.assertEqual(package_record.sha256, publication.package.package_sha256)
        loaded = PackagePublisher(catalog, derived_store).load_by_document_hash(
            imported.work_id,
            publication.package.package_sha256,
        )
        self.assertEqual(loaded.document_id, imported.work_id)
        self.assertEqual(loaded.package_sha256, publication.package.package_sha256)
        retrieval_sources = (
            (SRC / "sciretriever" / "legacy" / "importer.py").read_text(encoding="utf-8"),
            (SRC / "sciretriever" / "packaging" / "publisher.py").read_text(encoding="utf-8"),
            (SRC / "sciretriever" / "catalog" / "packages.py").read_text(encoding="utf-8"),
        )
        self.assertTrue(all("SciRetriever.database.model" not in source for source in retrieval_sources))

    def test_same_raw_asset_preserves_each_work_import_provenance_in_package(self) -> None:
        catalog, _, _, importer = self.importer()
        first = importer.import_asset(
            self.asset,
            (Identifier("doi", "10.1/provenance-a"),),
            AssetRole.XML,
            source_id="archive-a",
        )
        second = importer.import_asset(
            self.asset,
            (Identifier("doi", "10.1/provenance-b"),),
            AssetRole.XML,
            source_id="archive-b",
        )
        self.assertNotEqual(first.work_id, second.work_id)
        self.assertEqual(first.raw_asset_id, second.raw_asset_id)

        pipeline = PackagePipeline(
            catalog,
            RawAssetStore(self.storage_root),
            DerivedArtifactStore(self.storage_root),
        )
        first_package = pipeline.run(work_id=first.work_id).package
        second_package = pipeline.run(work_id=second.work_id).package
        first_source = first_package.source_provenance[0]
        second_source = second_package.source_provenance[0]

        self.assertEqual(first_source.provider, "legacy-import")
        self.assertEqual(second_source.provider, "legacy-import")
        self.assertEqual(first_source.acquisition_method, "existing-asset-import")
        self.assertEqual(second_source.acquisition_method, "existing-asset-import")
        self.assertEqual(first_source.source_uri, "urn:sciretriever:legacy-source:archive-a")
        self.assertEqual(second_source.source_uri, "urn:sciretriever:legacy-source:archive-b")
        self.assertNotEqual(first_source.provenance_id, second_source.provenance_id)
        first_artifacts = {item.kind: item.artifact_id for item in first_package.artifacts}
        second_artifacts = {item.kind: item.artifact_id for item in second_package.artifacts}
        self.assertNotEqual(
            first_artifacts["normalized_content"],
            second_artifacts["normalized_content"],
        )
        self.assertNotEqual(first_artifacts["source_map"], second_artifacts["source_map"])
        self.assertEqual(first_package.files[0].file_id, second_package.files[0].file_id)


if __name__ == "__main__":
    import unittest
    unittest.main()
