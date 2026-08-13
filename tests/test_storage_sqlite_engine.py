from __future__ import annotations

import os
import sqlite3
import stat
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, cast
from unittest.mock import patch

import sciretriever.storage.sqlite.artifacts as artifact_helpers
import sciretriever.storage.sqlite.engine as engine_module
from sciretriever.model.primitives import (
    ProvenanceId,
    RelativeArtifactPath,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.storage.files.paths import StorageRoot
from sciretriever.storage.files.reader import VerifiedReader, VerifiedReaderError
from sciretriever.storage.files.store import ArtifactReference, ArtifactStore
from sciretriever.storage.sqlite.artifacts import (
    ArtifactCatalogConflictError,
    ArtifactCatalogIntegrityError,
    ArtifactObject,
    get_artifact,
    get_provenance,
    register_artifact,
)
from sciretriever.storage.sqlite.engine import (
    CatalogEngine,
    CatalogPathError,
    UnsupportedCatalogError,
    canonical_catalog_path,
    create_or_open_catalog,
    open_read_only_snapshot,
    validate_catalog,
)
from sciretriever.storage.sqlite.schema import (
    SCHEMA_FINGERPRINT,
    SCHEMA_INDEXES,
    SCHEMA_MANIFEST,
    SCHEMA_TABLES,
    SCHEMA_VERSION,
)


class _InjectedCrash(BaseException):
    pass


class StorageSqliteEngineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-storage-sqlite-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)
        self.catalog = self.root / "catalog.sqlite"

    @staticmethod
    def _provenance(identifier: str = "00000000-0000-4000-8000-000000000001") -> Provenance:
        return Provenance(
            provenance_id=ProvenanceId(identifier),
            source_kind=SourceKind.ASSET_PROVIDER,
            source_name="fixture",
            source_record_id="record-1",
            observed_at=UtcTimestamp("2026-01-01T00:00:00Z"),
            input_sha256=None,
            parameters_sha256=None,
        )

    def test_fresh_catalog_has_exact_target_schema_and_required_connection_policy(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            tables = tuple(
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' "
                    "AND name NOT LIKE 'sqlite_%' ORDER BY name"
                )
            )
            expected_tables = tuple(
                name
                for object_type, name, _ in engine_module._expected_objects()
                if object_type == "table"
            )
            self.assertEqual(tables, expected_tables)
            self.assertTrue(set(SCHEMA_TABLES).issubset(tables))
            self.assertIn("literature_search_fts", tables)
            self.assertIn("literature_search_fts_data", tables)
            self.assertIn("literature_search_fts_idx", tables)
            indexes = tuple(
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='index' "
                    "AND name NOT LIKE 'sqlite_%' ORDER BY name"
                )
            )
            self.assertEqual(indexes, tuple(sorted(SCHEMA_INDEXES)))
            marker = connection.execute(
                "SELECT product,schema_version,schema_fingerprint FROM schema_identity"
            ).fetchone()
            self.assertEqual(marker, ("sciretriever", SCHEMA_VERSION, SCHEMA_FINGERPRINT))
            self.assertEqual(connection.execute("PRAGMA foreign_keys").fetchone(), (1,))
            self.assertEqual(connection.execute("PRAGMA busy_timeout").fetchone(), (5000,))
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone(), ("wal",))
            self.assertEqual(connection.execute("PRAGMA synchronous").fetchone(), (2,))
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone(), ("ok",))
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            columns = {
                name: tuple(
                    row[2].upper() for row in connection.execute(f'PRAGMA table_info("{name}")')
                )
                for name in SCHEMA_TABLES
            }
            self.assertTrue(all("BLOB" not in values for values in columns.values()))
            schema_sql = "\n".join(
                row[0] or ""
                for row in connection.execute(
                    "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"
                )
            )
            self.assertNotIn("JSON", schema_sql.upper())
            self.assertIn("LITERATURE", schema_sql.upper())
        self.assertGreater(len(SCHEMA_MANIFEST), 3)
        self.assertEqual(stat.S_IMODE(self.catalog.stat().st_mode), 0o600)

    def test_manifest_introspection_includes_explicit_indexes_and_fts_shadow_objects(self) -> None:
        manifest = (
            "CREATE TABLE documents(document_id INTEGER NOT NULL PRIMARY KEY,body TEXT NOT NULL)",
            "CREATE INDEX documents_body_index ON documents(body)",
            "CREATE VIRTUAL TABLE documents_fts USING fts5(body)",
        )
        expected = engine_module._schema_objects_from_manifest(manifest)
        names = {(object_type, name) for object_type, name, _ in expected}
        self.assertIn(("index", "documents_body_index"), names)
        self.assertIn(("table", "documents_fts"), names)
        self.assertIn(("table", "documents_fts_data"), names)
        self.assertIn(("table", "documents_fts_idx"), names)
        self.assertIn(("table", "documents_fts_docsize"), names)
        self.assertIn(("table", "documents_fts_config"), names)

        with sqlite3.connect(":memory:") as connection:
            for statement in manifest:
                connection.execute(statement)
            self.assertEqual(engine_module._schema_objects(connection), expected)

    def test_canonical_binding_rejects_symlink_hardlink_and_unsafe_permissions(self) -> None:
        victim = self.root / "victim.sqlite"
        victim.write_bytes(b"preserve")
        os.chmod(victim, 0o600)
        symlink = self.root / "symlink.sqlite"
        symlink.symlink_to(victim)
        hardlink = self.root / "hardlink.sqlite"
        os.link(victim, hardlink)
        for path in (symlink, hardlink):
            with self.subTest(path=path), self.assertRaises(CatalogPathError):
                canonical_catalog_path(path)
        symlink.unlink()
        hardlink.unlink()
        os.chmod(victim, 0o644)
        with self.assertRaises(CatalogPathError):
            canonical_catalog_path(victim)
        unsafe_parent = self.root / "unsafe"
        unsafe_parent.mkdir()
        os.chmod(unsafe_parent, 0o777)
        with self.assertRaises(CatalogPathError):
            canonical_catalog_path(unsafe_parent / "catalog.sqlite")

    def test_unknown_old_and_fingerprint_tampered_catalogs_fail_without_migration(self) -> None:
        self.catalog.write_bytes(b"not sqlite")
        os.chmod(self.catalog, 0o600)
        before = self.catalog.read_bytes()
        with self.assertRaises(UnsupportedCatalogError):
            create_or_open_catalog(self.catalog)
        self.assertEqual(self.catalog.read_bytes(), before)
        self.catalog.unlink()

        with sqlite3.connect(self.catalog) as connection:
            connection.execute("CREATE TABLE old_schema(value TEXT)")
        os.chmod(self.catalog, 0o600)
        before = self.catalog.read_bytes()
        with self.assertRaises(UnsupportedCatalogError):
            create_or_open_catalog(self.catalog)
        self.assertEqual(self.catalog.read_bytes(), before)
        self.catalog.unlink()

        with create_or_open_catalog(self.catalog) as connection:
            connection.execute(
                "UPDATE schema_identity SET schema_fingerprint=?",
                ("f" * 64,),
            )
            connection.commit()
        with self.assertRaises(UnsupportedCatalogError):
            validate_catalog(self.catalog)

    def test_validate_catalog_does_not_modify_or_leave_sidecars(self) -> None:
        with create_or_open_catalog(self.catalog):
            pass
        before = self.catalog.read_bytes()
        before_names = tuple(sorted(path.name for path in self.root.iterdir()))
        validate_catalog(self.catalog)
        self.assertEqual(self.catalog.read_bytes(), before)
        self.assertEqual(
            tuple(sorted(path.name for path in self.root.iterdir())),
            before_names,
        )

        self.catalog.unlink()
        self.catalog.write_bytes(b"not sqlite")
        os.chmod(self.catalog, 0o600)
        before = self.catalog.read_bytes()
        before_names = tuple(sorted(path.name for path in self.root.iterdir()))
        with self.assertRaises(UnsupportedCatalogError):
            validate_catalog(self.catalog)
        self.assertEqual(self.catalog.read_bytes(), before)
        self.assertEqual(
            tuple(sorted(path.name for path in self.root.iterdir())),
            before_names,
        )

    def test_integrity_tampering_fails_closed_without_repair(self) -> None:
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute(
                "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,"
                "relative_path) VALUES (?,?,?,?,?)",
                ("a", "a" * 64, 1, "text/plain", "objects/a"),
            )
            connection.commit()
        with sqlite3.connect(self.catalog) as connection:
            connection.execute("PRAGMA journal_mode=DELETE")
        with self.assertRaises(UnsupportedCatalogError):
            validate_catalog(self.catalog)

    def test_bootstrap_failpoints_leave_no_partial_temp_and_recover_publication(self) -> None:
        for checkpoint_name in ("after-temporary-fsync", "after-publication"):
            path = self.root / f"{checkpoint_name}.sqlite"

            def crash(name: str, expected: str = checkpoint_name) -> None:
                if name == expected:
                    raise _InjectedCrash(name)

            with self.subTest(checkpoint=checkpoint_name), self.assertRaises(_InjectedCrash):
                create_or_open_catalog(path, checkpoint=crash)
            if checkpoint_name == "after-temporary-fsync":
                self.assertFalse(path.exists())
            with create_or_open_catalog(path) as connection:
                self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone(), ("ok",))
            self.assertEqual(tuple(self.root.glob(f".{path.name}.bootstrap-*.tmp")), ())

    def test_concurrent_create_if_absent_converges_on_one_inode_and_fingerprint(self) -> None:
        barrier = threading.Barrier(4)

        def create(_: int) -> tuple[int, str]:
            barrier.wait()
            with create_or_open_catalog(self.catalog) as connection:
                fingerprint = connection.execute(
                    "SELECT schema_fingerprint FROM schema_identity"
                ).fetchone()[0]
            return self.catalog.stat().st_ino, fingerprint

        with ThreadPoolExecutor(max_workers=4) as executor:
            results = tuple(executor.map(create, range(4)))
        self.assertEqual(len({inode for inode, _ in results}), 1)
        self.assertEqual({fingerprint for _, fingerprint in results}, {SCHEMA_FINGERPRINT})

    def test_engine_short_transactions_commit_and_rollback(self) -> None:
        engine = CatalogEngine(self.catalog)
        with engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO provenances(provenance_id,source_kind,source_name,"
                "source_record_id,observed_at,input_sha256,parameters_sha256) "
                "VALUES (?,?,?,?,?,?,?)",
                ("p", "user", "fixture", None, "2026-01-01T00:00:00Z", None, None),
            )
        with self.assertRaises(RuntimeError):
            with engine.write_transaction() as connection:
                connection.execute("DELETE FROM provenances")
                raise RuntimeError("rollback sentinel")
        with engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM provenances").fetchone(), (1,)
            )

    def test_read_only_snapshot_is_query_only_and_writes_are_rejected(self) -> None:
        with create_or_open_catalog(self.catalog):
            pass
        with open_read_only_snapshot(self.catalog) as connection:
            self.assertEqual(connection.execute("PRAGMA query_only").fetchone(), (1,))
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute(
                    "INSERT INTO provenances(provenance_id,source_kind,source_name,"
                    "observed_at) VALUES ('x','user','x','2026-01-01T00:00:00Z')"
                )

    def test_artifact_and_provenance_registration_is_idempotent_and_conflicts_are_rejected(
        self,
    ) -> None:
        engine = CatalogEngine(self.catalog)
        provenance = self._provenance()
        root = StorageRoot(self.root / "artifacts")
        store = ArtifactStore(root)
        reader = VerifiedReader(root)
        content = b"artifact"
        reference = store.publish(
            content,
            sha256=sha256_digest(content),
            byte_size=len(content),
            media_type="application/octet-stream",
        )
        first: ArtifactObject | None = None
        second: ArtifactObject | None = None
        with reader.acquire(reference) as lease:
            first = register_artifact(
                engine,
                "00000000-0000-4000-8000-000000000002",
                lease,
                provenance,
            )
        assert first is not None
        with reader.acquire(reference) as lease:
            second = register_artifact(
                engine,
                first.artifact_id,
                lease,
                provenance,
            )
        assert second is not None
        self.assertEqual(first, second)
        self.assertEqual(get_artifact(engine, first.artifact_id), first)
        self.assertEqual(get_provenance(engine, provenance.provenance_id), provenance)
        other = b"different"
        other_reference = store.publish(
            other,
            sha256=sha256_digest(other),
            byte_size=len(other),
            media_type=first.media_type,
        )
        with self.assertRaises(ArtifactCatalogConflictError):
            with reader.acquire(other_reference) as lease:
                register_artifact(engine, first.artifact_id, lease)
        with reader.acquire(reference) as lease:
            with self.assertRaises(ArtifactCatalogConflictError):
                register_artifact(
                    engine,
                    "00000000-0000-4000-8000-000000000003",
                    lease,
                )

    def test_artifact_rejects_invalid_technical_values_without_path_or_secret_echo(self) -> None:
        engine = CatalogEngine(self.catalog)
        manual = ArtifactReference(
            path=RelativeArtifactPath("objects/item"),
            sha256=Sha256("a" * 64),
            byte_size=1,
            media_type="text/plain",
        )
        cases: tuple[object, ...] = (
            "/absolute",
            "../escape",
            manual,
            RelativeArtifactPath("objects/item"),
        )
        for value in cases:
            with (
                self.subTest(value=value),
                self.assertRaises(ArtifactCatalogIntegrityError) as context,
            ):
                register_artifact(engine, "id", value)  # type: ignore[arg-type]
            self.assertNotIn("/absolute", str(context.exception))
            self.assertNotIn("escape", str(context.exception))
        with self.assertRaises(TypeError):
            cast(Any, register_artifact)(
                engine,
                "raw-scalars",
                RelativeArtifactPath("objects/item"),
                Sha256("a" * 64),
                1,
                "text/plain",
            )
        self.assertIsNone(get_artifact(engine, "id"))

    def test_registration_rolls_back_artifact_and_provenance_when_object_changes_before_commit(
        self,
    ) -> None:
        engine = CatalogEngine(self.catalog)
        root = StorageRoot(self.root / "rollback-artifacts")
        store = ArtifactStore(root)
        reader = VerifiedReader(root)
        content = b"registration rollback"
        reference = store.publish(
            content,
            sha256=sha256_digest(content),
            byte_size=len(content),
            media_type="application/octet-stream",
        )
        target = root.canonical_path / reference.path.root
        provenance = self._provenance("00000000-0000-4000-8000-000000000004")

        def delete_after_insert(connection: sqlite3.Connection, artifact: ArtifactObject) -> object:
            result = original_insert(connection, artifact)
            target.unlink()
            return result

        original_insert = artifact_helpers._insert_or_verify_artifact
        with reader.acquire(reference) as lease:
            with patch.object(
                artifact_helpers,
                "_insert_or_verify_artifact",
                side_effect=delete_after_insert,
            ):
                with self.assertRaises(ArtifactCatalogIntegrityError):
                    register_artifact(engine, "rollback-artifact", lease, provenance)

        self.assertIsNone(get_artifact(engine, "rollback-artifact"))
        self.assertIsNone(get_provenance(engine, provenance.provenance_id))

        # Re-publish the same bytes to prove the failed registration did not
        # leave the formal object in an unsafe partial state.
        repaired = store.publish(
            content,
            sha256=sha256_digest(content),
            byte_size=len(content),
            media_type="application/octet-stream",
        )
        self.assertEqual(repaired.path, reference.path)
        replacement = root.canonical_path / reference.path.root

        def replace_after_insert(
            connection: sqlite3.Connection, artifact: ArtifactObject
        ) -> object:
            result = original_insert(connection, artifact)
            replacement.unlink()
            evidence = replacement.with_name("replacement")
            evidence.write_bytes(content)
            os.chmod(evidence, 0o600)
            evidence.rename(replacement)
            return result

        with reader.acquire(repaired) as lease:
            with patch.object(
                artifact_helpers,
                "_insert_or_verify_artifact",
                side_effect=replace_after_insert,
            ):
                with self.assertRaises(ArtifactCatalogIntegrityError):
                    register_artifact(engine, "replacement-artifact", lease, provenance)

        self.assertIsNone(get_artifact(engine, "replacement-artifact"))
        self.assertIsNone(get_provenance(engine, provenance.provenance_id))

    def test_hand_built_reference_is_not_a_registration_capability(self) -> None:
        engine = CatalogEngine(self.catalog)
        root = StorageRoot(self.root / "manual-reference-artifacts")
        store = ArtifactStore(root)
        reader = VerifiedReader(root)
        content = b"manual reference"
        published = store.publish(
            content,
            sha256=sha256_digest(content),
            byte_size=len(content),
            media_type="application/octet-stream",
        )
        manual = ArtifactReference(
            path=published.path,
            sha256=published.sha256,
            byte_size=published.byte_size,
            media_type=published.media_type,
        )
        with self.assertRaises(ArtifactCatalogIntegrityError):
            register_artifact(engine, "manual-reference", manual)  # type: ignore[arg-type]
        with self.assertRaises(VerifiedReaderError):
            reader.acquire(manual)
        self.assertIsNone(get_artifact(engine, "manual-reference"))

    def test_registration_rejects_lease_whose_formal_object_is_missing(self) -> None:
        engine = CatalogEngine(self.catalog)
        root = StorageRoot(self.root / "missing-artifacts")
        store = ArtifactStore(root)
        reader = VerifiedReader(root)
        content = b"missing formal object"
        reference = store.publish(
            content,
            sha256=sha256_digest(content),
            byte_size=len(content),
            media_type="application/octet-stream",
        )
        target = root.canonical_path / reference.path.root
        provenance = self._provenance("00000000-0000-4000-8000-000000000005")
        with reader.acquire(reference) as lease:
            target.unlink()
            with self.assertRaises(ArtifactCatalogIntegrityError):
                register_artifact(engine, "missing-artifact", lease, provenance)
        self.assertIsNone(get_artifact(engine, "missing-artifact"))
        self.assertIsNone(get_provenance(engine, provenance.provenance_id))


if __name__ == "__main__":
    unittest.main()
