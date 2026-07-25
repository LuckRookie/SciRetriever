from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
from pathlib import Path
import stat
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase

from PyPDF2 import PdfWriter

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition.existing_asset import ExistingAssetImporter
from sciretriever.catalog import AssetRepository, IdentityResolver, create_catalog_engine, initialize_catalog
from sciretriever.core.enums import AssetRole
from sciretriever.errors import SciRetrieverError
from sciretriever.storage import AssetAcceptanceCoordinator, RawAssetStore


def pdf_bytes() -> bytes:
    stream = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata({"/Subject": "explicit import" * 200})
    writer.write(stream)
    return stream.getvalue()


class P9AcceptanceTests(TestCase):
    def setUp(self) -> None:
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.catalog = create_catalog_engine(self.root / "catalog.sqlite")
        initialize_catalog(self.catalog)
        self.addCleanup(self.catalog.dispose)
        self.storage_root = self.root / "storage"
        self.storage_root.mkdir()
        self.asset_root = self.root / "imports"
        self.asset_root.mkdir()
        self.assets = AssetRepository(self.catalog)
        self.importer = ExistingAssetImporter(
            self.assets,
            AssetAcceptanceCoordinator(self.assets, RawAssetStore(self.storage_root)),
        )
        resolution = IdentityResolver(self.catalog).create_or_reuse_work({"doi": "10.1000/import"})
        assert resolution.work_version is not None
        self.work_version_id = resolution.work_version.id
        self.asset = self.asset_root / "article.pdf"
        self.asset.write_bytes(pdf_bytes())

    def counts(self) -> tuple[int, int, int]:
        with self.catalog.connect() as connection:
            return tuple(connection.exec_driver_sql(f"SELECT count(*) FROM {table}").scalar_one() for table in (
                "asset_intents", "raw_assets", "work_version_assets"
            ))

    def test_invalid_sources_have_zero_catalog_side_effects(self) -> None:
        missing = self.asset_root / "missing.pdf"
        malformed = self.asset_root / "bad.pdf"
        malformed.write_bytes(b"not-pdf")
        oversized = ExistingAssetImporter(self.assets, self.importer.coordinator, max_bytes=8)
        cases = (
            (self.importer, missing),
            (self.importer, malformed),
            (oversized, self.asset),
        )
        for importer, path in cases:
            with self.subTest(path=path), self.assertRaises((OSError, ValueError, SciRetrieverError)):
                importer.import_asset(path, self.work_version_id, AssetRole.PRIMARY_PDF)
            self.assertEqual(self.counts(), (0, 0, 0))

    def test_asset_root_rejects_escape_and_symlink(self) -> None:
        outside = self.root / "outside.pdf"
        outside.write_bytes(pdf_bytes())
        link = self.asset_root / "link.pdf"
        link.symlink_to(outside)
        with self.assertRaises(ValueError):
            self.importer.import_asset("../outside.pdf", self.work_version_id, AssetRole.PRIMARY_PDF, asset_root=self.asset_root)
        with self.assertRaises(ValueError):
            self.importer.import_asset(link, self.work_version_id, AssetRole.PRIMARY_PDF, asset_root=self.asset_root)
        self.assertEqual(self.counts(), (0, 0, 0))

    def test_exact_replay_preserves_hash_mode_and_redacted_provenance(self) -> None:
        first = self.importer.import_asset(
            self.asset, self.work_version_id, AssetRole.PRIMARY_PDF, source_id="fixture"
        )
        second = self.importer.import_asset(
            self.asset, self.work_version_id, AssetRole.PRIMARY_PDF, source_id="other"
        )
        self.assertEqual(first.raw_asset_id, second.raw_asset_id)
        self.assertEqual(second.disposition, "replayed")
        raw = self.assets.get_raw_asset(first.raw_asset_id)
        assert raw is not None
        stored = self.storage_root / raw.storage_path
        self.assertEqual(stat.S_IMODE(stored.stat().st_mode), 0o400)
        provenance = json.loads(raw.provenance_json)
        self.assertNotIn(str(self.asset), json.dumps(provenance))
        self.assertEqual(self.counts(), (1, 1, 1))

    def test_replay_still_rejects_symlink_input(self) -> None:
        self.importer.import_asset(self.asset, self.work_version_id, AssetRole.PRIMARY_PDF)
        link = self.asset_root / "replay-link.pdf"
        link.symlink_to(self.asset)

        with self.assertRaisesRegex(ValueError, "not a symlink"):
            self.importer.import_asset(link, self.work_version_id, AssetRole.PRIMARY_PDF)
        self.assertEqual(self.counts(), (1, 1, 1))

    def test_concurrent_same_role_imports_converge(self) -> None:
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = tuple(executor.map(
                lambda _: self.importer.import_asset(
                    self.asset, self.work_version_id, AssetRole.PRIMARY_PDF
                ),
                range(4),
            ))
        self.assertEqual({result.raw_asset_id for result in results}, {results[0].raw_asset_id})
        self.assertEqual(self.counts(), (1, 1, 1))

    def test_existing_workversion_is_required_and_never_created_from_identifier(self) -> None:
        before = self.counts()
        with self.assertRaises(ValueError):
            self.importer.import_asset(
                self.asset,
                "00000000-0000-4000-8000-000000000001",
                AssetRole.PRIMARY_PDF,
            )
        self.assertEqual(self.counts(), before)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM works").scalar_one(), 1)


if __name__ == "__main__":
    import unittest
    unittest.main()
