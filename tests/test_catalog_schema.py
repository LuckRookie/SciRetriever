from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sqlite3
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase
from uuid import uuid4

from sqlalchemy.exc import IntegrityError, OperationalError

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import create_catalog_engine, initialize_catalog, open_catalog_engine, open_read_only_catalog_engine
from sciretriever.errors import CatalogError


REMOVED_TASK_TABLES = {"download_requests", "acquisition_jobs", "acquisition_attempts"}


def new_id() -> str:
    return str(uuid4())


class CatalogSchemaTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "catalog.sqlite"

    def create_catalog(self):
        catalog = create_catalog_engine(self.path)
        initialize_catalog(catalog)
        self.addCleanup(catalog.dispose)
        return catalog

    @staticmethod
    def insert_version(connection) -> str:
        work_id = new_id()
        version_id = new_id()
        connection.exec_driver_sql("INSERT INTO works (id) VALUES (?)", (work_id,))
        connection.exec_driver_sql(
            "INSERT INTO work_versions (id, work_id, normalized_title, title, stable_version_key) VALUES (?, ?, ?, ?, ?)",
            (version_id, work_id, "schema test", "Schema Test", f"doi:{version_id}"),
        )
        return version_id

    def test_creation_open_and_read_only_modes_are_explicit(self) -> None:
        with self.assertRaises(FileNotFoundError):
            open_catalog_engine(self.path)
        catalog = self.create_catalog()
        catalog.dispose()
        opened = open_catalog_engine(self.path)
        opened.dispose()
        read_only = open_read_only_catalog_engine(self.path)
        self.assertTrue(read_only.read_only)
        with read_only.connect() as connection:
            with self.assertRaises(OperationalError):
                connection.exec_driver_sql("INSERT INTO works (id) VALUES (?)", (new_id(),))
        read_only.dispose()

    def test_concurrent_catalog_creation_has_exactly_one_winner(self) -> None:
        def create() -> bool:
            try:
                engine = create_catalog_engine(self.path)
                initialize_catalog(engine)
                engine.dispose()
                return True
            except (CatalogError, FileExistsError):
                return False
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = tuple(executor.map(lambda _: create(), range(4)))
        self.assertEqual(sum(results), 1)

    def test_fresh_schema_has_workversion_diagnostics_and_no_task_tables_or_columns(self) -> None:
        catalog = self.create_catalog()
        with catalog.connect() as connection:
            tables = set(connection.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).scalars())
            self.assertIn("acquisition_diagnostics", tables)
            self.assertTrue(REMOVED_TASK_TABLES.isdisjoint(tables))
            for table in tables:
                columns = {row[1] for row in connection.exec_driver_sql(f'PRAGMA table_info("{table}")')}
                self.assertNotIn("BLOB", {str(row[2]).upper() for row in connection.exec_driver_sql(f'PRAGMA table_info("{table}")')})
                if table in {"asset_intents", "failures"}:
                    self.assertTrue({"job_id", "attempt_id"}.isdisjoint(columns))

    def test_foreign_keys_and_version_role_hash_intent_uniqueness(self) -> None:
        catalog = self.create_catalog()
        with catalog.transaction() as connection:
            version_id = self.insert_version(connection)
            values = (
                new_id(), version_id, "primary_pdf", "pending",
                "a" * 64, "application/pdf", "pdf", 42, '{"provider":"test"}',
            )
            connection.exec_driver_sql(
                "INSERT INTO asset_intents (id, work_version_id, asset_role, state, temporary_path, storage_path, expected_sha256, media_type, format, expected_byte_size, provenance_json) "
                "VALUES (?, ?, ?, ?, 'staging/' || ? || '.part', 'raw/aa/' || ?, ?, ?, ?, ?, ?)",
                (values[0], values[1], values[2], values[3], values[0], values[4], values[4], values[5], values[6], values[7], values[8]),
            )
            with self.assertRaises(IntegrityError):
                connection.exec_driver_sql(
                    "INSERT INTO asset_intents (id, work_version_id, asset_role, temporary_path, storage_path, expected_sha256, media_type, format, expected_byte_size, provenance_json) "
                    "VALUES (?, ?, 'primary_pdf', 'staging/' || ? || '.part', 'raw/aa/' || ?, ?, 'application/pdf', 'pdf', 42, '{\"provider\":\"test\"}')",
                    (new_id(), version_id, new_id(), "a" * 64, "a" * 64),
                )
            with self.assertRaises(IntegrityError):
                connection.exec_driver_sql(
                    "INSERT INTO asset_intents (id, work_version_id, asset_role, temporary_path, storage_path, expected_sha256, media_type, format, expected_byte_size, provenance_json) "
                    "VALUES (?, ?, 'primary_pdf', 'staging/' || ? || '.part', 'raw/bb/' || ?, ?, 'application/pdf', 'pdf', 42, '{}')",
                    (new_id(), new_id(), new_id(), "b" * 64, "b" * 64),
                )

    def test_asset_intent_sql_state_transitions_and_replay_fields_are_immutable(self) -> None:
        catalog = self.create_catalog()
        with catalog.transaction() as connection:
            version_id = self.insert_version(connection)
            intent_id = new_id()
            digest = "c" * 64
            connection.exec_driver_sql(
                "INSERT INTO asset_intents (id, work_version_id, asset_role, temporary_path, storage_path, expected_sha256, media_type, format, expected_byte_size, provenance_json) VALUES (?, ?, 'primary_pdf', ?, ?, ?, 'application/pdf', 'pdf', 42, '{}')",
                (intent_id, version_id, f"staging/{intent_id}.part", f"raw/cc/{digest}", digest),
            )
            with self.assertRaises(IntegrityError):
                connection.exec_driver_sql("UPDATE asset_intents SET expected_byte_size=43 WHERE id=?", (intent_id,))
            with self.assertRaises(IntegrityError):
                connection.exec_driver_sql("UPDATE asset_intents SET state='finalized' WHERE id=?", (intent_id,))
            raw_id = new_id()
            connection.exec_driver_sql(
                "INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, byte_size, provenance_json) VALUES (?, ?, ?, 'application/pdf', 'pdf', 42, '{}')",
                (raw_id, digest, f"raw/cc/{digest}"),
            )
            connection.exec_driver_sql("UPDATE asset_intents SET state='published', raw_asset_id=? WHERE id=?", (raw_id, intent_id))
            connection.exec_driver_sql("UPDATE asset_intents SET state='finalized' WHERE id=?", (intent_id,))
            with self.assertRaises(IntegrityError):
                connection.exec_driver_sql("DELETE FROM asset_intents WHERE id=?", (intent_id,))

    def test_raw_assets_are_sql_immutable_and_coherent(self) -> None:
        catalog = self.create_catalog()
        digest = "d" * 64
        with catalog.transaction() as connection:
            raw_id = new_id()
            connection.exec_driver_sql(
                "INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, byte_size, provenance_json) VALUES (?, ?, ?, 'application/pdf', 'pdf', 42, '{}')",
                (raw_id, digest, f"raw/dd/{digest}"),
            )
            for statement in (
                "UPDATE raw_assets SET byte_size=43 WHERE id=?",
                "DELETE FROM raw_assets WHERE id=?",
            ):
                with self.assertRaises(IntegrityError):
                    connection.exec_driver_sql(statement, (raw_id,))

    def test_acquisition_diagnostics_are_workversion_scoped_and_json_checked(self) -> None:
        catalog = self.create_catalog()
        with catalog.transaction() as connection:
            version_id = self.insert_version(connection)
            connection.exec_driver_sql(
                "INSERT INTO acquisition_diagnostics (id, work_version_id, asset_role, outcome, details_json) VALUES (?, ?, 'primary_pdf', 'failed', '{}')",
                (new_id(), version_id),
            )
            for outcome, details in (("pending", "{}"), ("failed", "not-json")):
                with self.assertRaises(IntegrityError):
                    connection.exec_driver_sql(
                        "INSERT INTO acquisition_diagnostics (id, work_version_id, asset_role, outcome, details_json) VALUES (?, ?, 'primary_pdf', ?, ?)",
                        (new_id(), version_id, outcome, details),
                    )

    def test_asset_triggers_exist_without_task_references(self) -> None:
        catalog = self.create_catalog()
        with catalog.connect() as connection:
            rows = connection.exec_driver_sql(
                "SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name"
            ).all()
        names = {row[0] for row in rows}
        self.assertTrue({
            "trg_raw_assets_immutable_update",
            "trg_raw_assets_immutable_delete",
            "trg_asset_intents_initial_coherence",
            "trg_asset_intents_state_transition",
            "trg_asset_intents_immutable_replay",
            "trg_asset_intents_immutable_delete",
        }.issubset(names))
        sql = "\n".join(row[1] or "" for row in rows)
        self.assertNotIn("acquisition_jobs", sql)
        self.assertNotIn("acquisition_attempts", sql)

    def test_sqlite_integrity_and_foreign_key_checks_are_clean(self) -> None:
        catalog = self.create_catalog()
        with catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("PRAGMA integrity_check").scalar_one(), "ok")
            self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_key_check").all(), [])
            self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_keys").scalar_one(), 1)
            self.assertEqual(connection.exec_driver_sql("PRAGMA journal_mode").scalar_one().lower(), "wal")


if __name__ == "__main__":
    import unittest
    unittest.main()
