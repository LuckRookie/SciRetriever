from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import IdentityResolver, PackageVersionRepository, ProcessingRunRepository, apply_migrations, create_catalog_engine
from sciretriever.core.enums import PackageQuality, ProcessingRunState


class PackageRepositoryTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary.name) / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        apply_migrations(self.catalog)
        self.work_id = IdentityResolver(self.catalog).create_or_reuse_work({"doi": "10.1/package"}).work.id

    def test_registration_closes_publication_run_atomically(self) -> None:
        run = ProcessingRunRepository(self.catalog).claim_or_resume(
            self.work_id, "publication", "publisher", "1", {"material": "a"}
        )
        repository = PackageVersionRepository(self.catalog)
        record = repository.register_published(
            self.work_id, run.id, 1, "1", PackageQuality.PDF_BACKED,
            "derived/document_package/aa/package", "a" * 64, "2026-07-20T12:00:00.000Z",
        )
        self.assertEqual(repository.latest(self.work_id), record)
        self.assertEqual(repository.get(record.id), record)
        self.assertEqual(
            repository.register_published(
                self.work_id, run.id, 1, "1", "pdf_backed",
                "derived/document_package/aa/package", "a" * 64, "2026-07-20T12:00:00.000Z",
            ), record,
        )
        self.assertIs(ProcessingRunRepository(self.catalog).get(run.id).state, ProcessingRunState.SUCCEEDED)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("PRAGMA integrity_check").scalar_one(), "ok")
            self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_key_check").all(), [])


if __name__ == "__main__":
    import unittest
    unittest.main()
