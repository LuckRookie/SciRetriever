from __future__ import annotations

import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from sciretriever.infrastructure.storage.sqlite import (
    SqliteLiteratureRepository,
    create_or_open_catalog,
)
from sciretriever.model.library import CurationScope
from sciretriever.model.primitives import WorkId, WorkVersionId

UUIDS = tuple(f"20000000-0000-4000-8000-{value:012d}" for value in range(1, 6))


class TargetAssetSnapshotProvenanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-asset-snapshot-")
        self.addCleanup(self.temporary.cleanup)
        self.catalog = Path(self.temporary.name) / "catalog.sqlite"
        os.chmod(self.temporary.name, 0o700)
        with create_or_open_catalog(self.catalog):
            pass

    def seed_accepted_asset(self) -> CurationScope:
        work, version = WorkId(UUIDS[0]), WorkVersionId(UUIDS[1])
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute("INSERT INTO works(id) VALUES(?)", (str(work),))
            connection.execute(
                "INSERT INTO work_versions(id,work_id,version_role) VALUES(?,?,'formal')",
                (str(version), str(work)),
            )
            connection.execute(
                "INSERT INTO artifacts(id,kind,sha256,storage_path,byte_size,media_type) "
                "VALUES(?,'raw',?,'raw/a.pdf',3,'application/pdf')",
                (UUIDS[2], "1" * 64),
            )
            connection.execute("INSERT INTO raw_assets(artifact_id) VALUES(?)", (UUIDS[2],))
            connection.execute(
                "INSERT INTO work_version_assets(id,work_version_id,artifact_id,role,source_json) "
                "VALUES(?,?,?,'primary-pdf','{}')",
                (UUIDS[3], str(version), UUIDS[2]),
            )
            connection.execute(
                "INSERT INTO accepted_primary_assets(work_version_id,work_version_asset_id) "
                "VALUES(?,?)",
                (str(version), UUIDS[3]),
            )
            connection.execute(
                "INSERT INTO work_version_assets(id,work_version_id,artifact_id,role,source_json) "
                "VALUES(?,?,?,'supplementary','{}')",
                (UUIDS[4], str(version), UUIDS[2]),
            )
            connection.commit()
        return CurationScope(work_ids=(work,), work_version_ids=(version,))

    def test_artifact_and_asset_source_mutations_each_stale_snapshot(self) -> None:
        scope = self.seed_accepted_asset()
        repository = SqliteLiteratureRepository(self.catalog)
        original = repository.load_curation_snapshot(scope).token
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute(
                "UPDATE artifacts SET media_type='application/octet-stream' WHERE id=?", (UUIDS[2],)
            )
            connection.commit()
        artifact_changed = repository.load_curation_snapshot(scope).token
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute(
                "UPDATE work_version_assets SET source_json='{\"changed\":true}' WHERE id=?",
                (UUIDS[4],),
            )
            connection.commit()
        self.assertNotEqual(original, artifact_changed)
        self.assertNotEqual(artifact_changed, repository.load_curation_snapshot(scope).token)


if __name__ == "__main__":
    unittest.main()
