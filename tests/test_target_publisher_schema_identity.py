from __future__ import annotations

import hashlib
import os
import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from sciretriever.core.literature.completion import metadata_snapshot_sha256
from sciretriever.infrastructure.storage.sqlite import (
    UnsupportedCatalogError,
    create_or_open_catalog,
    validate_catalog,
)
from sciretriever.model.canonical_json import CanonicalJsonObject


class TargetPublisherSchemaIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-publisher-schema-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)
        self.catalog = self.root / "catalog.sqlite"

    def test_supported_raw_writes_reject_false_canonical_hash_identity(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute("INSERT INTO works(id) VALUES ('work')")
            connection.execute(
                "INSERT INTO work_versions(id,work_id,version_role) "
                "VALUES ('version','work','formal')"
            )
            false_digest = "0" * 64
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO metadata_snapshots VALUES ('metadata','version',1,?,'{}','{}')",
                    (false_digest,),
                )
            canonical_digest = hashlib.sha256(b"{}").hexdigest()
            metadata_digest = metadata_snapshot_sha256(
                1,
                CanonicalJsonObject(()),
                CanonicalJsonObject(()),
            )
            connection.execute(
                "INSERT INTO metadata_snapshots VALUES ('metadata','version',1,?,'{}','{}')",
                (str(metadata_digest),),
            )
            connection.execute(
                "INSERT INTO artifacts(id,kind,sha256,storage_path,byte_size) "
                "VALUES ('raw','raw',?,'primary/aa/value',1)",
                ("a" * 64,),
            )
            connection.execute("INSERT INTO raw_assets VALUES ('raw')")
            connection.execute(
                "INSERT INTO work_version_assets VALUES "
                "('primary','version','raw','primary-pdf','{}')"
            )
            connection.execute("INSERT INTO accepted_primary_assets VALUES ('version','primary')")
            connection.execute(
                "INSERT INTO artifacts(id,kind,sha256,storage_path,byte_size) "
                "VALUES ('light-artifact','light-document',?,'light-document/44/value',2)",
                (canonical_digest,),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO light_documents "
                    "VALUES ('light','version','primary','light-artifact',?,'{}','{}',1)",
                    (false_digest,),
                )
            connection.execute("UPDATE artifacts SET byte_size=3 WHERE id='light-artifact'")
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO light_documents "
                    "VALUES ('light','version','primary','light-artifact',?,'{}','{}',1)",
                    (canonical_digest,),
                )
            connection.execute(
                "INSERT INTO artifacts(id,kind,sha256,storage_path,byte_size) "
                "VALUES ('wrong-kind','raw',?,'primary/44/wrong',2)",
                (canonical_digest,),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO light_documents "
                    "VALUES ('light-wrong-kind','version','primary','wrong-kind',?,'{}','{}',1)",
                    (canonical_digest,),
                )
            connection.execute("UPDATE artifacts SET byte_size=2 WHERE id='light-artifact'")
            connection.execute(
                "INSERT INTO light_documents "
                "VALUES ('light','version','primary','light-artifact',?,'{}','{}',1)",
                (canonical_digest,),
            )
            connection.execute(
                "INSERT INTO artifacts(id,kind,sha256,storage_path,byte_size) "
                "VALUES ('analysis-artifact','analysis',?,'analysis/44/value',2)",
                (canonical_digest,),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO analysis_artifacts "
                    "VALUES ('analysis','version','light','analysis-artifact',?,?, '{}','{}',1)",
                    (false_digest, canonical_digest),
                )

    def test_catalog_validation_rejects_rows_forged_with_false_hash_udf(self) -> None:
        with create_or_open_catalog(self.catalog):
            pass
        false_digest = "0" * 64
        with sqlite3.connect(self.catalog) as connection:
            connection.create_function(
                "sciretriever_canonical_json",
                1,
                lambda payload: payload,
                deterministic=True,
            )
            connection.create_function(
                "sciretriever_metadata_sha256",
                3,
                lambda revision, values, provenance: false_digest,
                deterministic=True,
            )
            connection.execute("INSERT INTO works(id) VALUES ('work')")
            connection.execute(
                "INSERT INTO work_versions(id,work_id,version_role) "
                "VALUES ('version','work','formal')"
            )
            connection.execute(
                "INSERT INTO metadata_snapshots VALUES ('metadata','version',1,?,'{}','{}')",
                (false_digest,),
            )
            connection.commit()
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")

        with self.assertRaises(UnsupportedCatalogError):
            validate_catalog(self.catalog)


if __name__ == "__main__":
    unittest.main()
