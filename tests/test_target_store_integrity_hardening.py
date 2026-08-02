# noqa: SIZE_OK - one trigger matrix covers cross-table integrity invariants
from __future__ import annotations

import hashlib
import os
import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from sciretriever.core.literature.completion import metadata_snapshot_sha256
from sciretriever.kernel import CanonicalJsonObject
from sciretriever.literature_store.sqlite import (
    SCHEMA_FINGERPRINT,
    OpaqueExtensionConflictError,
    OpaqueExtensionRecordStore,
    UnsupportedCatalogError,
    create_or_open_catalog,
    validate_catalog,
)
from sciretriever.model.primitives import ExtensionRecordId


class TargetStoreIntegrityHardeningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-debug6-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)
        self.catalog = self.root / "catalog.sqlite"

    def test_exact_marker_partial_schema_is_rejected(self) -> None:
        with sqlite3.connect(self.catalog) as connection:
            connection.execute(
                "CREATE TABLE schema_identity("
                "singleton INTEGER PRIMARY KEY,product TEXT,schema_version INTEGER,"
                "schema_fingerprint TEXT)"
            )
            connection.execute(
                "INSERT INTO schema_identity VALUES (1,'sciretriever',2,?)",
                (SCHEMA_FINGERPRINT,),
            )
        os.chmod(self.catalog, 0o600)

        with self.assertRaises(UnsupportedCatalogError):
            validate_catalog(self.catalog)

    def test_missing_trigger_with_exact_marker_is_rejected(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute("DROP TRIGGER trg_primary_role_insert")
            connection.commit()

        with self.assertRaises(UnsupportedCatalogError):
            validate_catalog(self.catalog)

    def test_accepted_primary_relation_cannot_drift_on_update(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            self._insert_primary(connection)
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "UPDATE work_version_assets SET role='supplementary-pdf' WHERE id='asset-link'"
                )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "UPDATE work_version_assets SET work_version_id='other-version' "
                    "WHERE id='asset-link'"
                )

    def test_completion_rejects_analysis_from_other_light_document(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            self._insert_completion_parents(connection)
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO completion_bundles("
                    "work_version_id,light_document_id,analysis_artifact_id,"
                    "metadata_snapshot_id,reference_set_id,tag_set_id) "
                    "VALUES ('version','light-2','analysis-1','metadata','references','tags')"
                )

    def test_completion_rejects_analysis_input_hash_mismatch_and_update(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            self._insert_completion_parents(
                connection, analysis_light="light-2", input_hash="f" * 64
            )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO completion_bundles("
                    "work_version_id,light_document_id,analysis_artifact_id,"
                    "metadata_snapshot_id,reference_set_id,tag_set_id) "
                    "VALUES ('version','light-2','analysis-1','metadata','references','tags')"
                )

    def test_opaque_store_canonicalizes_hashes_and_enforces_cas(self) -> None:
        with create_or_open_catalog(self.catalog):
            pass
        store = OpaqueExtensionRecordStore(self.catalog)
        record_id = ExtensionRecordId("30000000-0000-0000-0000-000000000001")
        payload = CanonicalJsonObject((("b", 1), ("a", 2)))

        created = store.compare_and_set("example", record_id, None, payload)
        loaded = store.get("example", record_id)

        self.assertEqual(loaded, created)
        self.assertEqual(created.payload, CanonicalJsonObject((("a", 2), ("b", 1))))
        with self.assertRaises(OpaqueExtensionConflictError):
            store.compare_and_set("example", record_id, None, payload)
        updated = store.compare_and_set("example", record_id, 1, CanonicalJsonObject((("c", 3),)))
        self.assertEqual(updated.revision, 2)

    def test_opaque_direct_sql_shape_guards_remain_independent(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            cases = (
                (0, "0" * 64, "{}"),
                (1, "short", "{}"),
                (1, "A" * 64, "{}"),
                (1, "0" * 64, '{"b":1,"a":2}'),
                (1, "0" * 64, '{ "a": 1 }'),
            )
            for revision, digest, payload in cases:
                with (
                    self.subTest(revision=revision, digest=digest),
                    self.assertRaises(sqlite3.IntegrityError),
                ):
                    connection.execute(
                        "INSERT INTO opaque_extension_records("
                        "namespace,record_id,revision,payload_sha256,payload_json) "
                        "VALUES ('raw',hex(randomblob(16)),?,?,?)",
                        (revision, digest, payload),
                    )

    def test_opaque_direct_sql_rejects_wrong_well_shaped_digest(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO opaque_extension_records VALUES ('raw','wrong',1,?, '{}')",
                    ("0" * 64,),
                )
        validate_catalog(self.catalog)

    def test_opaque_direct_sql_accepts_exact_digest(self) -> None:
        digest = hashlib.sha256(b"{}").hexdigest()
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute(
                "INSERT INTO opaque_extension_records VALUES ('raw','correct',1,?, '{}')",
                (digest,),
            )
            connection.commit()
        validate_catalog(self.catalog)

    def test_opaque_external_connection_without_functions_fails_closed(self) -> None:
        with create_or_open_catalog(self.catalog):
            pass
        digest = hashlib.sha256(b"{}").hexdigest()
        with sqlite3.connect(self.catalog) as connection:
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute(
                    "INSERT INTO opaque_extension_records VALUES ('raw','external',1,?, '{}')",
                    (digest,),
                )

    def test_completed_light_hash_cannot_drift(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            self._insert_valid_completion(connection)
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "UPDATE light_documents SET sha256=? WHERE id='light-2'", ("9" * 64,)
                )

    def test_completed_analysis_identity_cannot_drift(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            self._insert_valid_completion(connection)
            for assignment in (
                "light_document_id='light-1'",
                f"input_sha256='{'9' * 64}'",
            ):
                with self.subTest(assignment=assignment), self.assertRaises(sqlite3.IntegrityError):
                    connection.execute(
                        f"UPDATE analysis_artifacts SET {assignment} WHERE id='analysis-1'"
                    )

    def test_completed_current_light_pointer_cannot_drift(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            self._insert_valid_completion(connection)
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "UPDATE work_version_current_light_document SET light_document_id='light-1' "
                    "WHERE work_version_id='version'"
                )

    def test_completed_current_metadata_pointer_cannot_be_removed(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            self._insert_valid_completion(connection)
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "DELETE FROM work_version_current_metadata WHERE work_version_id='version'"
                )

    def test_completion_can_be_removed_before_parent_replacement(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            self._insert_valid_completion(connection)
            connection.execute("DELETE FROM completion_bundles WHERE work_version_id='version'")
            connection.execute(
                "UPDATE work_version_current_light_document SET light_document_id='light-1' "
                "WHERE work_version_id='version'"
            )
            connection.execute(
                "UPDATE analysis_artifacts SET light_document_id='light-1',input_sha256=? "
                "WHERE id='analysis-1'",
                (hashlib.sha256(b'{"id":"light-1"}').hexdigest(),),
            )
            connection.execute(
                "INSERT INTO completion_bundles("
                "work_version_id,light_document_id,analysis_artifact_id,metadata_snapshot_id,"
                "reference_set_id,tag_set_id,identity_sha256) "
                "VALUES ('version','light-1','analysis-1','metadata','references','tags','"
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')"
            )
            connection.commit()
        validate_catalog(self.catalog)

    @staticmethod
    def _insert_primary(connection: sqlite3.Connection) -> None:
        connection.execute("INSERT INTO works(id) VALUES ('work')")
        connection.execute("INSERT INTO works(id) VALUES ('other-work')")
        connection.execute(
            "INSERT INTO work_versions(id,work_id,version_role) VALUES ('version','work','formal')"
        )
        connection.execute(
            "INSERT INTO work_versions(id,work_id,version_role) "
            "VALUES ('other-version','other-work','formal')"
        )
        connection.execute(
            "INSERT INTO artifacts(id,kind,sha256,storage_path,byte_size) "
            "VALUES ('raw','raw',?,'raw/aa/value',1)",
            ("a" * 64,),
        )
        connection.execute("INSERT INTO raw_assets(artifact_id) VALUES ('raw')")
        connection.execute(
            "INSERT INTO work_version_assets(id,work_version_id,artifact_id,role,source_json) "
            "VALUES ('asset-link','version','raw','primary-pdf','{}')"
        )
        connection.execute(
            "INSERT INTO accepted_primary_assets(work_version_id,work_version_asset_id) "
            "VALUES ('version','asset-link')"
        )

    @classmethod
    def _insert_completion_parents(
        cls,
        connection: sqlite3.Connection,
        analysis_light: str = "light-1",
        input_hash: str = "1" * 64,
    ) -> None:
        cls._insert_primary(connection)
        for identifier in ("light-1", "light-2"):
            payload = f'{{"id":"{identifier}"}}'
            digest = hashlib.sha256(payload.encode("ascii")).hexdigest()
            artifact = f"artifact-{identifier}"
            connection.execute(
                "INSERT INTO artifacts(id,kind,sha256,storage_path,byte_size) "
                "VALUES (?,'light-document',?,?,?)",
                (artifact, digest, f"light/{identifier}", len(payload)),
            )
            connection.execute(
                "INSERT INTO light_documents("
                "id,work_version_id,primary_asset_id,artifact_id,sha256,document_json,"
                "provenance_json,complete) VALUES (?,'version','asset-link',?,?,?,'{}',1)",
                (identifier, artifact, digest, payload),
            )
        connection.execute(
            "INSERT INTO work_version_current_light_document VALUES ('version','light-2')"
        )
        metadata_digest = metadata_snapshot_sha256(
            1, CanonicalJsonObject(()), CanonicalJsonObject(())
        )
        connection.execute(
            "INSERT INTO metadata_snapshots("
            "id,work_version_id,revision,sha256,values_json,provenance_json) "
            "VALUES ('metadata','version',1,?,'{}','{}')",
            (str(metadata_digest),),
        )
        connection.execute(
            "INSERT INTO work_version_current_metadata VALUES ('version','metadata')"
        )
        connection.execute("INSERT INTO reference_sets VALUES ('references','version',1,1)")
        connection.execute("INSERT INTO tag_sets VALUES ('tags','version',1,1)")
        proposal_digest = hashlib.sha256(b"{}").hexdigest()
        connection.execute(
            "INSERT INTO artifacts(id,kind,sha256,storage_path,byte_size) "
            "VALUES ('analysis-artifact','analysis',?,'analysis/value',2)",
            (proposal_digest,),
        )
        connection.execute(
            "INSERT INTO analysis_artifacts("
            "id,work_version_id,light_document_id,artifact_id,sha256,input_sha256,"
            "proposal_json,provenance_json,nine_categories_complete) "
            "VALUES ('analysis-1','version',?,'analysis-artifact',?,?,'{}','{}',1)",
            (analysis_light, proposal_digest, input_hash),
        )

    @classmethod
    def _insert_valid_completion(cls, connection: sqlite3.Connection) -> None:
        cls._insert_completion_parents(
            connection,
            analysis_light="light-2",
            input_hash=hashlib.sha256(b'{"id":"light-2"}').hexdigest(),
        )
        connection.execute(
            "INSERT INTO completion_bundles("
            "work_version_id,light_document_id,analysis_artifact_id,metadata_snapshot_id,"
            "reference_set_id,tag_set_id,identity_sha256) "
            "VALUES ('version','light-2','analysis-1','metadata','references','tags','"
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')"
        )


if __name__ == "__main__":
    unittest.main()
