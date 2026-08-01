from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase
from uuid import uuid4


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import ArtifactRegistration, ArtifactRepository, IdentityResolver, initialize_catalog, create_catalog_engine


class ArtifactRepositoryTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary.name) / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        self.work_version_id = IdentityResolver(self.catalog).create_or_reuse_work({"doi": "10.1/artifact"}).work_version.id
        self.raw_id = str(uuid4())
        sha = "a" * 64
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, byte_size, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (self.raw_id, sha, f"raw/aa/{sha}", "application/pdf", "pdf", 12, "{}"),
            )
        self.repository = ArtifactRepository(self.catalog)

    def test_pair_registration_and_replay_are_atomic(self) -> None:
        artifacts = tuple(
            ArtifactRegistration(
                str(uuid4()), kind, "1", f"derived/{kind}/aa/item-{index}", str(index + 1) * 64,
                "application/json", 10 + index, {"producer": "normalizer"},
            )
            for index, kind in enumerate(("normalized_content", "source_map"))
        )
        first = self.repository.register_pair_after_publication(self.work_version_id, self.raw_id, artifacts)
        second = self.repository.register_pair_after_publication(self.work_version_id, self.raw_id, artifacts)
        self.assertEqual(first, second)
        self.assertEqual(self.repository.list_for_work(self.work_version_id), first)
        self.assertEqual(self.repository.get(first[0].id), first[0])
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM normalized_artifacts").scalar_one(), 2)


if __name__ == "__main__":
    import unittest
    unittest.main()
