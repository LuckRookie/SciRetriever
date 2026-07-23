"""Existing-asset security tests plus product AC-5 through AC-9 coverage."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import threading
import time
from tempfile import TemporaryDirectory
from typing import cast
from unittest import TestCase, mock

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition.admission import AdmissionService
from sciretriever.acquisition.existing_asset import ExistingAssetImporter
from sciretriever.catalog import create_catalog_engine, initialize_catalog
from sciretriever.catalog.assets import AssetRepository
from sciretriever.catalog.identity import IdentityResolver
from sciretriever.catalog.jobs import JobRepository
from sciretriever.catalog.models import metadata as catalog_metadata
from sciretriever.catalog.packages import PackageSourceRepository, PackageVersionRepository
from sciretriever.catalog.records import PackageVersionRecord
from sciretriever.catalog.repository import CatalogRepository
from sciretriever.cli.main import main
from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole, AttemptOutcome, JobState, PackageQuality
from sciretriever.errors import SciRetrieverError
from sciretriever.packaging import PackagePipeline
from sciretriever.packaging.publisher import PackagePublisher
from sciretriever.storage.coordinator import AssetAcceptanceCoordinator
from sciretriever.storage.derived import DerivedArtifactStore
from sciretriever.storage.manager import RawAssetStore


XML_BYTES = b"<article><front><title-group><article-title>P9</article-title></title-group></front><body><p>Evidence text.</p></body></article>"


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
        initialize_catalog(catalog)
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
            "raw_assets", "work_version_assets",
        )
        with catalog.connect() as connection:
            return tuple(
                connection.exec_driver_sql(f"SELECT count(*) FROM {table}").scalar_one()
                for table in tables
            )

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

    def test_parent_swap_between_resolution_and_open_is_rejected(self) -> None:
        catalog, _, _, importer = self.importer()
        asset_root = self.root / "assets"
        parent = asset_root / "incoming"
        parent.mkdir(parents=True)
        candidate = parent / "paper.xml"
        candidate.write_bytes(XML_BYTES)
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "paper.xml").write_bytes(XML_BYTES)
        original_snapshot = importer._snapshot

        def swap_parent(path: Path, *, expected_identity) -> bytes:
            parent.rename(asset_root / "original")
            parent.symlink_to(outside, target_is_directory=True)
            return original_snapshot(path, expected_identity=expected_identity)

        with mock.patch.object(importer, "_snapshot", side_effect=swap_parent):
            with self.assertRaises(OSError):
                importer.import_asset(
                    candidate,
                    (Identifier("doi", "10.1/parent-swap"),),
                    AssetRole.XML,
                    asset_root=asset_root,
                )
        self.assertEqual(self.catalog_counts(catalog), (0,) * 9)

    def test_regular_file_replacement_between_resolution_and_open_is_rejected(self) -> None:
        catalog, _, _, importer = self.importer()
        asset_root = self.root / "assets"
        asset_root.mkdir()
        candidate = asset_root / "paper.xml"
        candidate.write_bytes(XML_BYTES)
        original_snapshot = importer._snapshot

        def replace_file(path: Path, *, expected_identity) -> bytes:
            path.rename(asset_root / "original.xml")
            path.write_bytes(XML_BYTES)
            return original_snapshot(path, expected_identity=expected_identity)

        with mock.patch.object(importer, "_snapshot", side_effect=replace_file):
            with self.assertRaisesRegex(ValueError, "changed after path validation"):
                importer.import_asset(
                    candidate,
                    (Identifier("doi", "10.1/file-replacement"),),
                    AssetRole.XML,
                    asset_root=asset_root,
                )
        self.assertEqual(self.catalog_counts(catalog), (0,) * 9)

    def test_exact_replay_raw_hash_mode_and_neutral_provenance(self) -> None:
        catalog, assets, _, importer = self.importer()
        identifier = (Identifier("doi", "10.1/replay"),)
        first = importer.import_asset(self.asset, identifier, AssetRole.XML, source_id="manual-a")
        conflicting = self.root / "missing.xml"
        second = importer.import_asset(conflicting, identifier, AssetRole.XML, source_id="manual-a")
        self.assertEqual((first.work_id, first.raw_asset_id, first.sha256), (second.work_id, second.raw_asset_id, second.sha256))
        self.assertEqual(second.disposition, "replayed")
        raw = assets.get_raw_asset(first.raw_asset_id)
        self.assertEqual(first.sha256, hashlib.sha256(XML_BYTES).hexdigest())
        stored = self.storage_root / raw.storage_path
        self.assertEqual(stored.read_bytes(), XML_BYTES)
        self.assertEqual(stat.S_IMODE(stored.stat().st_mode), 0o400)
        provenance = json.loads(raw.provenance_json)
        self.assertEqual(provenance, {"method": "existing-asset-import", "source_id": "manual-a"})
        self.assertNotIn(str(self.root), raw.provenance_json)
        with catalog.connect() as connection:
            event_types = tuple(
                connection.exec_driver_sql(
                    "SELECT event_type FROM events ORDER BY occurred_at, id"
                ).scalars()
            )
        self.assertIn("existing_asset_import.started", event_types)
        self.assertNotIn("legacy_import.started", event_types)

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
        self.assertEqual(len(assets.get_work_version_assets(results[0].work_version_id)), 1)
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
            job_id = connection.exec_driver_sql(
                "SELECT id FROM acquisition_jobs WHERE work_version_id = ?",
                (work.preferred_work_version_id,),
            ).scalar_one()
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
        admitted = importer.admission.admit(
            identifiers,
            provider="existing-asset-import",
            asset_role=AssetRole.XML,
        )
        jobs.restart_foreground_job(cast(str, admitted.job_id))
        attempt = jobs.start_attempt(cast(str, admitted.job_id), "existing-asset-import")
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

    def test_product_ac5_duplicate_doi_has_one_work_and_no_duplicate_nonterminal_job(self) -> None:
        catalog, assets, jobs, _ = self.importer()
        service = AdmissionService(IdentityResolver(catalog), jobs, assets)
        identifier = (Identifier("doi", "10.1/ac5"),)
        first = service.admit(
            identifier,
            provider="existing-asset-import",
            asset_role=AssetRole.PRIMARY_PDF,
        )
        second = service.admit(
            identifier,
            provider="existing-asset-import",
            asset_role=AssetRole.PRIMARY_PDF,
        )
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
        self.assertEqual(len(assets.get_work_version_assets(imported.work_version_id)), 1)
        with catalog.connect() as connection:
            pending = connection.exec_driver_sql(
                "SELECT asset_role, state FROM acquisition_jobs "
                "WHERE work_version_id = ? AND asset_role = ?",
                (imported.work_version_id, AssetRole.PRIMARY_PDF.value),
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
            imported.work_version_id,
            publication.package.package_sha256,
        )
        self.assertIsNotNone(record)
        package_record = cast(PackageVersionRecord, record)
        self.assertEqual(package_record.sha256, publication.package.package_sha256)
        loaded = PackagePublisher(catalog, derived_store).load_by_document_hash(
            imported.work_version_id,
            publication.package.package_sha256,
        )
        self.assertEqual(loaded.document_id, imported.work_version_id)
        self.assertEqual(loaded.package_sha256, publication.package.package_sha256)
        retrieval_sources = (
            (SRC / "sciretriever" / "acquisition" / "existing_asset.py").read_text(encoding="utf-8"),
            (SRC / "sciretriever" / "packaging" / "publisher.py").read_text(encoding="utf-8"),
            (SRC / "sciretriever" / "catalog" / "packages.py").read_text(encoding="utf-8"),
        )
        self.assertTrue(all("SciRetriever." not in source for source in retrieval_sources))

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
        sources = PackageSourceRepository(catalog)
        with self.assertRaisesRegex(SciRetrieverError, "requires work_version_id"):
            sources.resolve_work(raw_asset_id=first.raw_asset_id)
        self.assertEqual(
            sources.resolve_work(
                raw_asset_id=first.raw_asset_id,
                work_version_id=first.work_version_id,
            ),
            first.work_version_id,
        )

        pipeline = PackagePipeline(
            catalog,
            RawAssetStore(self.storage_root),
            DerivedArtifactStore(self.storage_root),
        )
        first_package = pipeline.run(work_id=first.work_id).package
        second_package = pipeline.run(work_id=second.work_id).package
        first_source = first_package.source_provenance[0]
        second_source = second_package.source_provenance[0]

        self.assertEqual(first_source.provider, "existing-asset-import")
        self.assertEqual(second_source.provider, "existing-asset-import")
        self.assertEqual(first_source.acquisition_method, "existing-asset-import")
        self.assertEqual(second_source.acquisition_method, "existing-asset-import")
        self.assertEqual(first_source.source_uri, "urn:sciretriever:source:archive-a")
        self.assertEqual(second_source.source_uri, "urn:sciretriever:source:archive-b")
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
