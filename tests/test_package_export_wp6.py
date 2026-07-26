from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from uuid import uuid4

from sciretriever.catalog import IdentityResolver, create_catalog_engine, initialize_catalog
from sciretriever.core.export import ExportDestination, PackageExportRequest, PackageExportSelector
from sciretriever.errors import PackagingError
from sciretriever.packaging import PackageExporter, PackagePipeline
from sciretriever.storage import DerivedArtifactStore, RawAssetStore


class PackageExportWP6Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-package-export-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        storage = self.root / "storage"
        storage.mkdir()
        self.catalog_path = self.root / "catalog.sqlite"
        self.catalog = create_catalog_engine(self.catalog_path, allow_repository_write=True)
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        resolution = IdentityResolver(self.catalog).create_or_reuse_work(
            {"doi": "10.1/package-export"}
        )
        self.work_version_id = resolution.work_version.id
        self.raw_store = RawAssetStore(storage)
        self.derived_store = DerivedArtifactStore(storage)
        staged = self.raw_store.stage(
            BytesIO(b"<article><title>Package export</title><p>Canonical bytes</p></article>"),
            intent_id=str(uuid4()),
        )
        published = self.raw_store.publish(staged)
        self.raw_store.remove_staged(staged)
        raw_id = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, byte_size, provenance_json) "
                "VALUES (?, ?, ?, 'application/xml', 'xml', ?, '{}')",
                (raw_id, published.sha256, published.storage_path, published.byte_size),
            )
            connection.exec_driver_sql(
                "INSERT INTO work_version_assets (work_version_id, raw_asset_id, asset_role) "
                "VALUES (?, ?, 'xml')",
                (self.work_version_id, raw_id),
            )
        self.publication = PackagePipeline(
            self.catalog, self.raw_store, self.derived_store
        ).run(work_version_id=self.work_version_id)
        self.exporter = PackageExporter(self.catalog, self.derived_store)

    def request(self, destination: Path, *, exact: bool) -> PackageExportRequest:
        selector = PackageExportSelector(
            self.work_version_id,
            self.publication.record.version if exact else None,
            self.publication.record.sha256 if exact else None,
        )
        return PackageExportRequest(
            selector,
            ExportDestination.parse(destination, self.catalog_path),
        )

    def stored_bytes(self) -> bytes:
        return (self.derived_store.root / self.publication.record.storage_path).read_bytes()

    def test_latest_and_exact_export_preserve_stored_canonical_bytes(self) -> None:
        stored = self.stored_bytes()

        latest = self.exporter.export(self.request(self.root / "latest.json", exact=False))
        exact = self.exporter.export(self.request(self.root / "exact.json", exact=True))

        self.assertEqual(latest.package_version, self.publication.record.version)
        self.assertEqual(latest.package_sha256, self.publication.record.sha256)
        self.assertEqual(exact.package_version, self.publication.record.version)
        self.assertFalse(hasattr(latest, "record"))
        self.assertFalse(hasattr(latest, "storage_path"))
        self.assertEqual(latest.package_bytes, stored)
        self.assertEqual((self.root / "latest.json").read_bytes(), stored)
        self.assertEqual((self.root / "exact.json").read_bytes(), stored)

    def test_exact_version_and_hash_must_identify_the_same_snapshot(self) -> None:
        wrong_version = PackageExportRequest(
            PackageExportSelector(
                self.work_version_id, self.publication.record.version + 1, self.publication.record.sha256
            ),
            ExportDestination.parse(self.root / "wrong-version.json", self.catalog_path),
        )
        wrong_hash = PackageExportRequest(
            PackageExportSelector(self.work_version_id, self.publication.record.version, "a" * 64),
            ExportDestination.parse(self.root / "wrong-hash.json", self.catalog_path),
        )

        for request in (wrong_version, wrong_hash):
            with self.subTest(selector=request.selector), self.assertRaises(PackagingError):
                self.exporter.export(request)

    def test_tampered_or_noncanonical_stored_package_rejects_without_output(self) -> None:
        target = self.derived_store.root / self.publication.record.storage_path
        target.chmod(0o600)
        target.write_bytes(self.stored_bytes() + b" ")
        destination = self.root / "tampered.json"

        with self.assertRaises(PackagingError):
            self.exporter.export(self.request(destination, exact=False))

        self.assertFalse(destination.exists())

    def test_revalidates_unsafe_destination_at_write_time(self) -> None:
        destination = self.root / "destination.json"
        request = self.request(destination, exact=False)
        ordinary = self.root / "ordinary.json"
        ordinary.write_bytes(b"keep")
        os.link(ordinary, destination)

        with self.assertRaises(PackagingError):
            self.exporter.export(request)

        self.assertEqual(ordinary.read_bytes(), b"keep")
        self.assertEqual(destination.read_bytes(), b"keep")

    def test_concurrent_identical_exports_converge_to_exact_bytes(self) -> None:
        destination = self.root / "concurrent.json"
        requests = tuple(self.request(destination, exact=False) for _ in range(4))

        with ThreadPoolExecutor(max_workers=4) as executor:
            results = tuple(executor.map(self.exporter.export, requests))

        self.assertEqual({result.package_bytes for result in results}, {self.stored_bytes()})
        self.assertEqual(destination.read_bytes(), self.stored_bytes())


if __name__ == "__main__":
    unittest.main()
