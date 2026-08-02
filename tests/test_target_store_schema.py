# noqa: SIZE_OK - one catalog fixture verifies the complete schema manifest
from __future__ import annotations

import hashlib
import os
import sqlite3
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory

from sciretriever.literature_store.filesystem import (
    AdvisoryLock,
    canonical_catalog_path,
)
from sciretriever.literature_store.sqlite import (
    SCHEMA_FINGERPRINT,
    SCHEMA_TABLES,
    UnsupportedCatalogError,
    create_or_open_catalog,
    validate_catalog,
)


class TargetStoreSchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-target-store-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)
        self.catalog = self.root / "catalog.sqlite"

    def test_fresh_catalog_has_complete_manifest_and_required_pragmas(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            tables = {
                row[0]
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            marker = connection.execute(
                "SELECT product,schema_version,schema_fingerprint FROM schema_identity"
            ).fetchone()
            self.assertEqual(marker, ("sciretriever", 2, SCHEMA_FINGERPRINT))
            self.assertTrue(set(SCHEMA_TABLES).issubset(tables))
            self.assertEqual(connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            self.assertEqual(connection.execute("PRAGMA synchronous").fetchone()[0], 2)
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_existing_validation_is_read_only_and_side_effect_free(self) -> None:
        with create_or_open_catalog(self.catalog):
            pass
        for suffix in ("-wal", "-shm"):
            Path(f"{self.catalog}{suffix}").unlink(missing_ok=True)
        before = self.catalog.stat()
        digest = hashlib.sha256(self.catalog.read_bytes()).hexdigest()

        validate_catalog(self.catalog)

        after = self.catalog.stat()
        self.assertEqual(
            (after.st_ino, after.st_size, after.st_mtime_ns),
            (before.st_ino, before.st_size, before.st_mtime_ns),
        )
        self.assertEqual(hashlib.sha256(self.catalog.read_bytes()).hexdigest(), digest)
        self.assertFalse(Path(f"{self.catalog}-wal").exists())
        self.assertFalse(Path(f"{self.catalog}-shm").exists())

    def test_unsupported_existing_files_fail_without_mutation(self) -> None:
        fixtures: tuple[bytes | None, ...] = (b"", b"not sqlite", None)
        for index, fixture in enumerate(fixtures):
            path = self.root / f"unsupported-{index}.sqlite"
            if fixture is None:
                with sqlite3.connect(path) as connection:
                    connection.execute("CREATE TABLE works(id TEXT PRIMARY KEY)")
            else:
                path.write_bytes(fixture)
            before = (path.stat().st_ino, path.stat().st_mtime_ns, path.read_bytes())
            with self.assertRaises(UnsupportedCatalogError):
                create_or_open_catalog(path)
            after = (path.stat().st_ino, path.stat().st_mtime_ns, path.read_bytes())
            self.assertEqual(after, before)
            self.assertFalse(Path(f"{path}-wal").exists())
            self.assertFalse(Path(f"{path}-shm").exists())

    def test_unsafe_aliases_and_permissions_fail_closed(self) -> None:
        victim = self.root / "victim.sqlite"
        victim.write_bytes(b"preserved")
        symlink = self.root / "symlink.sqlite"
        symlink.symlink_to(victim)
        hardlink = self.root / "hardlink.sqlite"
        os.link(victim, hardlink)
        for path in (symlink, hardlink):
            with self.subTest(path=path), self.assertRaises(UnsupportedCatalogError):
                create_or_open_catalog(path)
        self.assertEqual(victim.read_bytes(), b"preserved")
        os.chmod(self.root, 0o755)
        with self.assertRaises(UnsupportedCatalogError):
            create_or_open_catalog(self.root / "wrong-mode.sqlite")

    def test_direct_illegal_insert_matrix(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            work = "10000000-0000-0000-0000-000000000001"
            other = "10000000-0000-0000-0000-000000000002"
            version = "20000000-0000-0000-0000-000000000001"
            connection.execute("INSERT INTO works(id) VALUES (?)", (work,))
            connection.execute("INSERT INTO works(id) VALUES (?)", (other,))
            connection.execute(
                "INSERT INTO work_versions(id,work_id,version_role) VALUES (?,?,?)",
                (version, work, "formal"),
            )
            illegal = (
                (
                    "cross-work representative",
                    "INSERT INTO work_representative_versions(work_id,work_version_id) "
                    "VALUES (?,?)",
                    (other, version),
                ),
                (
                    "absolute artifact",
                    "INSERT INTO artifacts(id,kind,sha256,storage_path,byte_size) "
                    "VALUES ('a','raw','" + "a" * 64 + "','/tmp/x',1)",
                    (),
                ),
                (
                    "invalid batch type",
                    "INSERT INTO batch_runs(id,batch_type,status,scope_json,counts_json) "
                    "VALUES ('b','other','created','{}','{}')",
                    (),
                ),
                (
                    "invalid opaque revision",
                    "INSERT INTO opaque_extension_records("
                    "namespace,record_id,revision,payload_sha256,payload_json) "
                    "VALUES ('x','r',0,'" + "b" * 64 + "','{}')",
                    (),
                ),
            )
            for label, statement, parameters in illegal:
                with self.subTest(label=label), self.assertRaises(sqlite3.IntegrityError):
                    connection.execute(statement, parameters)

    def test_alignment_uniqueness_and_complete_parent_constraints(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            work_ids = (
                "10000000-0000-0000-0000-000000000001",
                "10000000-0000-0000-0000-000000000002",
            )
            version_ids = (
                "20000000-0000-0000-0000-000000000001",
                "20000000-0000-0000-0000-000000000002",
            )
            for work_id, version_id in zip(work_ids, version_ids, strict=True):
                connection.execute("INSERT INTO works(id) VALUES (?)", (work_id,))
                connection.execute(
                    "INSERT INTO work_versions(id,work_id,version_role) VALUES (?,?,'formal')",
                    (version_id, work_id),
                )
            digest = "c" * 64
            connection.execute(
                "INSERT INTO artifacts(id,kind,sha256,storage_path,byte_size) "
                "VALUES ('asset','raw',?,'raw/cc/value',1)",
                (digest,),
            )
            connection.execute("INSERT INTO raw_assets(artifact_id) VALUES ('asset')")
            connection.execute(
                "INSERT INTO work_version_assets(id,work_version_id,artifact_id,role,source_json) "
                "VALUES ('link',?,'asset','primary-pdf','{}')",
                (version_ids[0],),
            )
            connection.execute(
                "INSERT INTO accepted_primary_assets(work_version_id,work_version_asset_id) "
                "VALUES (?,'link')",
                (version_ids[0],),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO accepted_primary_assets("
                    "work_version_id,work_version_asset_id) VALUES (?,'link')",
                    (version_ids[1],),
                )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO light_documents("
                    "id,work_version_id,primary_asset_id,artifact_id,sha256,document_json,"
                    "provenance_json,complete) "
                    "VALUES ('light',?,'link','asset',?,'{}','{}',1)",
                    (version_ids[1], digest),
                )

    def test_collection_run_and_batch_target_constraints(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute(
                "INSERT INTO collections(id,name,created_at) "
                "VALUES ('collection','name','2026-01-01T00:00:00Z')"
            )
            connection.execute(
                "INSERT INTO collection_runs(id,collection_id,mode,topic_conditions_json,"
                "requested_advance_to,status) "
                "VALUES ('run','collection','topic','{}','completed','created')"
            )
            connection.execute(
                "INSERT INTO batch_runs("
                "id,batch_type,status,scope_json,counts_json,trigger_collection_run_id) "
                "VALUES ('batch','process','created','{}','{}','run')"
            )
            connection.execute(
                "INSERT INTO batch_targets("
                "id,batch_run_id,target_kind,target_id,input_ordinal) "
                "VALUES ('target','batch','work-version','version',0)"
            )
            illegal = (
                (
                    "INSERT INTO collection_runs("
                    "id,collection_id,mode,topic_conditions_json,citation_input_json,"
                    "requested_advance_to,status) "
                    "VALUES ('mixed','collection','topic','{}','{}','completed','created')"
                ),
                (
                    "INSERT INTO batch_runs("
                    "id,batch_type,status,scope_json,counts_json,trigger_collection_run_id) "
                    "VALUES ('second','process','created','{}','{}','run')"
                ),
                (
                    "INSERT INTO batch_targets("
                    "id,batch_run_id,target_kind,target_id,input_ordinal) "
                    "VALUES ('duplicate','batch','work-version','version',1)"
                ),
            )
            for statement in illegal:
                with self.assertRaises(sqlite3.IntegrityError):
                    connection.execute(statement)

    def test_collection_counts_and_ordered_source_results_are_closed_by_schema(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute("INSERT INTO collections(id,name) VALUES ('collection','name')")
            connection.execute(
                "INSERT INTO collection_runs("
                "id,collection_id,mode,topic_conditions_json,requested_advance_to,status) "
                "VALUES ('run','collection','topic','{}','completed','running')"
            )
            connection.execute(
                "UPDATE collection_runs SET status='partial',stop_reason='source-failure',"
                "discovered_count=3,accepted_count=2,new_member_count=1,existing_member_count=1,"
                "missing_count=1,source_failure_count=1 WHERE id='run'"
            )
            connection.execute(
                "INSERT INTO collection_source_results("
                "collection_run_id,source_ordinal,source_name,discovered_count,accepted_count,"
                "missing_count,failure_code,failure_reason,failure_action,retryable) "
                "VALUES ('run',0,'crossref',2,2,0,NULL,NULL,NULL,NULL)"
            )
            connection.execute(
                "INSERT INTO collection_source_results("
                "collection_run_id,source_ordinal,source_name,discovered_count,accepted_count,"
                "missing_count,failure_code,failure_reason,failure_action,retryable) "
                "VALUES ('run',1,'openalex',1,0,1,'timeout','timed out','retry',1)"
            )
            invalid = (
                "UPDATE collection_runs SET accepted_count=3 WHERE id='run'",
                (
                    "INSERT INTO collection_source_results("
                    "collection_run_id,source_ordinal,source_name,discovered_count,"
                    "accepted_count,missing_count) VALUES ('run',2,'crossref',0,0,0)"
                ),
                (
                    "INSERT INTO collection_source_results("
                    "collection_run_id,source_ordinal,source_name,discovered_count,"
                    "accepted_count,missing_count,failure_code) "
                    "VALUES ('run',2,'semantic-scholar',0,0,0,'broken')"
                ),
            )
            for statement in invalid:
                with self.assertRaises(sqlite3.IntegrityError):
                    connection.execute(statement)

    def test_schema_has_no_blob_or_absolute_path_defaults(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            for table in SCHEMA_TABLES:
                columns = connection.execute(f'PRAGMA table_info("{table}")').fetchall()
                self.assertNotIn("BLOB", {str(column[2]).upper() for column in columns})
            schema_sql = "\n".join(
                row[0] or ""
                for row in connection.execute(
                    "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"
                )
            )
            self.assertNotIn("package", schema_sql.lower())

    def test_bootstrap_failpoints_converge_without_partial_catalog(self) -> None:
        class InjectedCrash(BaseException):
            pass

        for checkpoint_name in ("after-temporary-fsync", "after-publication"):
            path = self.root / f"crash-{checkpoint_name}.sqlite"

            def crash(name: str) -> None:
                if name == checkpoint_name:
                    raise InjectedCrash(name)

            with self.subTest(checkpoint=checkpoint_name), self.assertRaises(InjectedCrash):
                create_or_open_catalog(path, checkpoint=crash)
            if checkpoint_name == "after-temporary-fsync":
                self.assertFalse(path.exists())
            with create_or_open_catalog(path) as connection:
                self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone(), ("ok",))
            self.assertEqual(tuple(self.root.glob(f".{path.name}.bootstrap-*.tmp")), ())

    def test_concurrent_bootstrap_converges_on_one_inode_and_schema(self) -> None:
        def create(_: int) -> tuple[int, str]:
            with create_or_open_catalog(self.catalog) as connection:
                marker = connection.execute(
                    "SELECT schema_fingerprint FROM schema_identity"
                ).fetchone()[0]
            return self.catalog.stat().st_ino, marker

        with ThreadPoolExecutor(max_workers=4) as executor:
            results = tuple(executor.map(create, range(4)))
        self.assertEqual(len({inode for inode, _ in results}), 1)
        self.assertEqual({fingerprint for _, fingerprint in results}, {SCHEMA_FINGERPRINT})

    def test_advisory_lock_is_nonblocking_and_scope_stable(self) -> None:
        scope = canonical_catalog_path(self.catalog)
        lock = AdvisoryLock(scope, "core-write")
        with lock.acquire():
            with self.assertRaises(BlockingIOError):
                with AdvisoryLock(scope, "core-write").acquire(blocking=False):
                    self.fail("conflicting lock unexpectedly acquired")


if __name__ == "__main__":
    unittest.main()
