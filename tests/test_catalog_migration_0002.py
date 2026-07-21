import hashlib
import importlib
from io import BytesIO
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase
from uuid import uuid4

from sqlalchemy.exc import IntegrityError


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

catalog_api = importlib.import_module("sciretriever.catalog")
catalog_migrate = importlib.import_module("sciretriever.catalog.migrate")
migration_0001 = importlib.import_module("sciretriever.catalog.migrations.0001_initial")
AssetAcceptanceCoordinator = importlib.import_module(
    "sciretriever.storage.coordinator"
).AssetAcceptanceCoordinator
RawAssetStore = importlib.import_module("sciretriever.storage.manager").RawAssetStore
AssetRole = importlib.import_module("sciretriever.core.enums").AssetRole
CatalogError = importlib.import_module("sciretriever.errors").CatalogError


def new_id() -> str:
    return str(uuid4())


_HISTORICAL_ASSET_INTENTS = """
CREATE TABLE asset_intents (
    id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES acquisition_jobs(id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES acquisition_attempts(id) ON DELETE SET NULL,
    raw_asset_id TEXT REFERENCES raw_assets(id) ON DELETE SET NULL,
    asset_role TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    temporary_path TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    expected_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (job_id, asset_role, expected_sha256)
)
"""

_P3_TRIGGER_NAMES = (
    "trg_raw_assets_insert_coherence",
    "trg_raw_assets_immutable_update",
    "trg_raw_assets_immutable_delete",
    "trg_asset_intents_initial_coherence",
    "trg_asset_intents_immutable_replay",
    "trg_asset_intents_state_transition",
    "trg_asset_intents_immutable_delete",
)


class CatalogMigration0002Tests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "catalog.sqlite"
        self.catalog = catalog_api.create_catalog_engine(self.path)
        self.addCleanup(self.catalog.dispose)

    def seed_revision_one(self, *, historical_intents: bool) -> None:
        with self.catalog.critical_transaction() as connection:
            connection.exec_driver_sql(catalog_migrate._CREATE_LEDGER)
            migration_0001.upgrade(connection)
            if historical_intents:
                connection.exec_driver_sql("DROP TABLE asset_intents")
                connection.exec_driver_sql(_HISTORICAL_ASSET_INTENTS)
            for name in _P3_TRIGGER_NAMES:
                connection.exec_driver_sql(f'DROP TRIGGER IF EXISTS "{name}"')
            connection.exec_driver_sql(
                "INSERT INTO schema_migrations (revision, description, applied_at) "
                "VALUES ('0001', 'historical P1 schema', '2026-07-20T12:00:00.000Z')"
            )

    def insert_work_job(self, *, role: str = "primary_pdf") -> tuple[str, str]:
        work_id = new_id()
        job_id = new_id()
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("INSERT INTO works (id) VALUES (?)", (work_id,))
            connection.exec_driver_sql(
                "INSERT INTO acquisition_jobs (id, work_id, asset_role) VALUES (?, ?, ?)",
                (job_id, work_id, role),
            )
        return work_id, job_id

    def assert_integral(self) -> None:
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("PRAGMA integrity_check").scalar_one(), "ok")
            self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_key_check").all(), [])

    def test_empty_historical_revision_upgrades_and_coordinator_operates(self) -> None:
        self.seed_revision_one(historical_intents=True)

        self.assertEqual(catalog_api.apply_migrations(self.catalog), ("0002",))
        self.assertEqual(catalog_api.applied_migrations(self.catalog), ("0001", "0002"))
        with self.catalog.connect() as connection:
            columns = {
                row[1] for row in connection.exec_driver_sql("PRAGMA table_info(asset_intents)")
            }
        self.assertTrue(
            {"media_type", "format", "expected_byte_size", "provenance_json"}.issubset(columns)
        )

        work_id, job_id = self.insert_work_job()
        store_root = Path(self.temporary.name) / "storage"
        store_root.mkdir()
        repository = catalog_api.AssetRepository(self.catalog)
        result = AssetAcceptanceCoordinator(repository, RawAssetStore(store_root)).accept(
            BytesIO(b"historical upgrade evidence"),
            work_id,
            job_id,
            AssetRole.PRIMARY_PDF,
            "application/pdf",
            "pdf",
            {"provider": "migration-test"},
        )
        self.assertEqual(result.raw_asset.sha256, hashlib.sha256(b"historical upgrade evidence").hexdigest())
        self.assertEqual(catalog_api.apply_migrations(self.catalog), ())
        self.assert_integral()

    def test_nonempty_historical_intents_fail_without_rebuild_or_ledger_change(self) -> None:
        self.seed_revision_one(historical_intents=True)
        work_id, job_id = self.insert_work_job()
        intent_id = new_id()
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO asset_intents "
                "(id, work_id, job_id, asset_role, temporary_path, storage_path, expected_sha256) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    intent_id,
                    work_id,
                    job_id,
                    "primary_pdf",
                    f"staging/{intent_id}.part",
                    f"raw/aa/{'a' * 64}",
                    "a" * 64,
                ),
            )

        with self.assertRaisesRegex(CatalogError, "cannot fabricate replay metadata for 1"):
            catalog_api.apply_migrations(self.catalog)

        self.assertEqual(catalog_api.applied_migrations(self.catalog), ("0001",))
        with self.catalog.connect() as connection:
            columns = {
                row[1] for row in connection.exec_driver_sql("PRAGMA table_info(asset_intents)")
            }
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM asset_intents").scalar_one(), 1)
        self.assertNotIn("media_type", columns)
        self.assert_integral()

    def test_current_coherent_rows_are_preserved_and_missing_triggers_restored(self) -> None:
        self.seed_revision_one(historical_intents=False)
        work_id, job_id = self.insert_work_job()
        intent_id = new_id()
        sha256 = "b" * 64
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO asset_intents "
                "(id, work_id, job_id, asset_role, temporary_path, storage_path, expected_sha256, "
                "media_type, format, expected_byte_size, provenance_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    intent_id,
                    work_id,
                    job_id,
                    "primary_pdf",
                    f"staging/{intent_id}.part",
                    f"raw/bb/{sha256}",
                    sha256,
                    "application/pdf",
                    "pdf",
                    42,
                    "{}",
                ),
            )

        self.assertEqual(catalog_api.apply_migrations(self.catalog), ("0002",))
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM asset_intents").scalar_one(), 1)
            triggers = {
                row[0]
                for row in connection.exec_driver_sql(
                    "SELECT name FROM sqlite_master WHERE type = 'trigger'"
                )
            }
        self.assertTrue(set(_P3_TRIGGER_NAMES).issubset(triggers))

        with self.assertRaises(IntegrityError):
            with self.catalog.transaction() as connection:
                other_id = new_id()
                connection.exec_driver_sql(
                    "INSERT INTO asset_intents "
                    "(id, work_id, job_id, raw_asset_id, asset_role, state, temporary_path, "
                    "storage_path, expected_sha256, media_type, format, expected_byte_size, provenance_json) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        other_id,
                        work_id,
                        job_id,
                        None,
                        "primary_pdf",
                        "finalized",
                        f"staging/{other_id}.part",
                        f"raw/cc/{'c' * 64}",
                        "c" * 64,
                        "application/pdf",
                        "pdf",
                        42,
                        "{}",
                    ),
                )
        self.assert_integral()

    def test_current_incoherent_intent_fails_without_ledger_or_trigger_changes(self) -> None:
        self.seed_revision_one(historical_intents=False)
        work_a, _ = self.insert_work_job()
        _, job_b = self.insert_work_job()
        intent_id = new_id()
        sha256 = "d" * 64
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO asset_intents "
                "(id, work_id, job_id, asset_role, temporary_path, storage_path, expected_sha256, "
                "media_type, format, expected_byte_size, provenance_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    intent_id,
                    work_a,
                    job_b,
                    "primary_pdf",
                    f"staging/{intent_id}.part",
                    f"raw/dd/{sha256}",
                    sha256,
                    "application/pdf",
                    "pdf",
                    42,
                    "{}",
                ),
            )

        with self.assertRaisesRegex(CatalogError, "1 incoherent asset intent"):
            catalog_api.apply_migrations(self.catalog)
        self.assertEqual(catalog_api.applied_migrations(self.catalog), ("0001",))
        with self.catalog.connect() as connection:
            self.assertEqual(
                connection.exec_driver_sql("SELECT count(*) FROM sqlite_master WHERE type='trigger'").scalar_one(),
                0,
            )
        self.assert_integral()

    def test_incoherent_historical_raw_asset_fails_closed_after_table_rebuild_rolls_back(self) -> None:
        self.seed_revision_one(historical_intents=True)
        raw_id = new_id()
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("PRAGMA ignore_check_constraints = ON")
            connection.exec_driver_sql(
                "INSERT INTO raw_assets "
                "(id, sha256, storage_path, media_type, format, byte_size, provenance_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (raw_id, "e" * 64, "wrong/path", "Application/PDF", "PDF", 0, '{ "x": 1 }'),
            )
            connection.exec_driver_sql("PRAGMA ignore_check_constraints = OFF")

        with self.assertRaisesRegex(CatalogError, "1 incoherent immutable raw asset"):
            catalog_api.apply_migrations(self.catalog)
        self.assertEqual(catalog_api.applied_migrations(self.catalog), ("0001",))
        with self.catalog.connect() as connection:
            columns = {
                row[1] for row in connection.exec_driver_sql("PRAGMA table_info(asset_intents)")
            }
            self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_key_check").all(), [])
        self.assertNotIn("media_type", columns)

    def test_fresh_database_applies_both_revisions_in_order(self) -> None:
        self.assertEqual(catalog_api.apply_migrations(self.catalog), ("0001", "0002"))
        self.assertEqual(catalog_api.applied_migrations(self.catalog), ("0001", "0002"))
        self.assertEqual(catalog_api.apply_migrations(self.catalog), ())
        self.assert_integral()


if __name__ == "__main__":
    import unittest

    unittest.main()
