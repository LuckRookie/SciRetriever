import importlib
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4

from sqlalchemy.exc import IntegrityError, OperationalError


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

catalog_api = importlib.import_module("sciretriever.catalog")
catalog_engine = importlib.import_module("sciretriever.catalog.engine")
catalog_schema = importlib.import_module("sciretriever.catalog.schema")
CatalogError = importlib.import_module("sciretriever.errors").CatalogError


EXPECTED_TABLES = {
    "acquisition_attempts",
    "acquisition_jobs",
    "asset_intents",
    "version_references",
    "domain_runs",
    "download_requests",
    "events",
    "failures",
    "identity_reviews",
    "identifiers",
    "light_structures",
    "metadata_labels",
    "normalized_artifacts",
    "package_versions",
    "processing_runs",
    "raw_assets",
    "work_version_assets",
    "work_versions",
    "work_version_identifiers",
    "metadata_observations",
    "authors",
    "authorships",
    "publishers",
    "publisher_aliases",
    "venues",
    "venue_aliases",
    "tags",
    "tag_aliases",
    "manual_work_tags",
    "generated_work_version_tags",
    "version_relations",
    "works",
}


def new_id() -> str:
    return str(uuid4())


class CatalogSchemaTests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.path = Path(self.temporary_directory.name) / "catalog.sqlite"

    def create_initialized_catalog(self, *, busy_timeout_ms: int = 5_000):
        catalog = catalog_api.create_catalog_engine(
            self.path,
            busy_timeout_ms=busy_timeout_ms,
        )
        self.addCleanup(catalog.dispose)
        self.assertIsNone(catalog_api.initialize_catalog(catalog))
        return catalog

    def insert_work(self, catalog, *, work_id: str | None = None) -> str:
        work_id = work_id or new_id()
        with catalog.transaction() as connection:
            connection.exec_driver_sql("INSERT INTO works (id) VALUES (?)", (work_id,))
        return work_id

    def insert_work_version(self, catalog) -> str:
        return catalog_api.WorkRepository(catalog).ingest_version(
            provider="fixture", provider_record_id=new_id(), title=f"Fixture {new_id()}"
        ).id

    def test_creation_existing_and_read_only_modes_are_explicit(self) -> None:
        missing = self.path
        with self.assertRaises(FileNotFoundError):
            catalog_api.open_catalog_engine(missing)
        with self.assertRaises(FileNotFoundError):
            catalog_api.open_read_only_catalog_engine(missing)
        self.assertFalse(missing.exists())

        created = catalog_api.create_catalog_engine(missing)
        self.addCleanup(created.dispose)
        self.assertTrue(missing.is_file())
        with self.assertRaises(FileExistsError):
            catalog_api.create_catalog_engine(missing)
        catalog_api.initialize_catalog(created)
        created.dispose()

        existing = catalog_api.open_catalog_engine(missing)
        existing.dispose()
        read_only = catalog_api.open_read_only_catalog_engine(missing)
        self.addCleanup(read_only.dispose)
        with read_only.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM works").scalar_one(), 0)
        with self.assertRaises(OperationalError):
            with read_only.transaction() as connection:
                connection.exec_driver_sql("INSERT INTO works (id) VALUES (?)", (new_id(),))
        with self.assertRaises(CatalogError):
            catalog_api.initialize_catalog(read_only)

    def test_concurrent_catalog_creation_has_exactly_one_winner(self) -> None:
        def create(_: int):
            try:
                return catalog_api.create_catalog_engine(self.path)
            except FileExistsError:
                return None

        with ThreadPoolExecutor(max_workers=8) as executor:
            results = tuple(executor.map(create, range(16)))
        winners = tuple(result for result in results if result is not None)
        self.assertEqual(len(winners), 1)
        winner = winners[0]
        self.addCleanup(winner.dispose)
        self.assertEqual(self.path.stat().st_mode & 0o077, 0)
        self.assertIsNone(catalog_api.initialize_catalog(winner))
        with winner.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM works").scalar_one(), 0)

    def test_failed_setup_only_removes_an_unchanged_reservation(self) -> None:
        with patch.object(catalog_engine, "_build_engine", side_effect=RuntimeError("setup failed")):
            with self.assertRaisesRegex(RuntimeError, "setup failed"):
                catalog_api.create_catalog_engine(self.path)
        self.assertFalse(self.path.exists())

        def mutate_reserved(path, **_kwargs):
            path.write_bytes(b"claimed by another owner")
            raise RuntimeError("setup failed after mutation")

        with patch.object(catalog_engine, "_build_engine", side_effect=mutate_reserved):
            with self.assertRaisesRegex(RuntimeError, "after mutation"):
                catalog_api.create_catalog_engine(self.path)
        self.assertEqual(self.path.read_bytes(), b"claimed by another owner")

    def test_creation_runs_repository_write_guard(self) -> None:
        repository_target = REPOSITORY / f".catalog-guard-{new_id()}.sqlite"
        with self.assertRaisesRegex(PermissionError, "staged SciRetriever repository"):
            catalog_api.create_catalog_engine(repository_target)
        self.assertFalse(repository_target.exists())

    def test_sqlite_pragmas_and_critical_transaction_locking(self) -> None:
        catalog = self.create_initialized_catalog(busy_timeout_ms=73)
        with catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_keys").scalar_one(), 1)
            self.assertEqual(connection.exec_driver_sql("PRAGMA busy_timeout").scalar_one(), 73)
            self.assertEqual(connection.exec_driver_sql("PRAGMA journal_mode").scalar_one(), "wal")

        contender = catalog_api.open_catalog_engine(self.path, busy_timeout_ms=0)
        self.addCleanup(contender.dispose)
        with catalog.connect() as reader:
            reader.exec_driver_sql("SELECT count(*) FROM works").scalar_one()
            with contender.critical_transaction() as writer:
                writer.exec_driver_sql("INSERT INTO works (id) VALUES (?)", (new_id(),))

        with catalog.critical_transaction():
            with self.assertRaises(OperationalError):
                with contender.critical_transaction():
                    pass

    def test_fresh_schema_initialization_refuses_existing_catalog(self) -> None:
        catalog = catalog_api.create_catalog_engine(self.path)
        self.addCleanup(catalog.dispose)

        self.assertIsNone(catalog_api.initialize_catalog(catalog))
        with self.assertRaisesRegex(CatalogError, "empty database"):
            catalog_api.initialize_catalog(catalog)
        with catalog.connect() as connection:
            tables = {
                row[0]
                for row in connection.exec_driver_sql(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
        self.assertNotIn("schema_migrations", tables)

    def test_failed_initialization_rolls_back_schema(self) -> None:
        catalog = catalog_api.create_catalog_engine(self.path)
        self.addCleanup(catalog.dispose)

        def fail_initialization(connection) -> None:
            connection.exec_driver_sql("CREATE TABLE should_rollback (id TEXT PRIMARY KEY)")
            raise RuntimeError("initialization failed")

        with patch.object(catalog_schema, "initialize_schema", side_effect=fail_initialization):
            with self.assertRaisesRegex(RuntimeError, "initialization failed"):
                catalog_api.initialize_catalog(catalog)

        with catalog.connect() as connection:
            tables = {
                row[0]
                for row in connection.exec_driver_sql(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
        self.assertNotIn("should_rollback", tables)
        self.assertNotIn("schema_migrations", tables)

    def test_schema_contains_required_neutral_tables_without_blobs(self) -> None:
        catalog = self.create_initialized_catalog()
        with catalog.connect() as connection:
            tables = {
                row[0]
                for row in connection.exec_driver_sql(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            self.assertEqual(tables, EXPECTED_TABLES)

            forbidden_columns = {"reaction", "molecule", "route", "yield", "bytes", "blob"}
            for table in sorted(tables):
                with self.subTest(table=table):
                    columns = connection.exec_driver_sql(f'PRAGMA table_info("{table}")').all()
                    self.assertTrue(columns)
                    self.assertTrue(forbidden_columns.isdisjoint(row[1].lower() for row in columns))
                    self.assertTrue(all("BLOB" not in row[2].upper() for row in columns))

            domain_columns = {
                row[1]
                for row in connection.exec_driver_sql('PRAGMA table_info("domain_runs")')
            }
            self.assertEqual(
                domain_columns,
                {
                    "id",
                    "package_version_id",
                    "status",
                    "output_pointer",
                    "output_sha256",
                    "created_at",
                    "updated_at",
                },
            )
            normalized_columns = {
                row[1]
                for row in connection.exec_driver_sql(
                    'PRAGMA table_info("normalized_artifacts")'
                )
            }
            self.assertIn("media_type", normalized_columns)
            self.assertIn("byte_size", normalized_columns)

    def test_identifier_foreign_key_and_uniqueness_are_enforced(self) -> None:
        catalog = self.create_initialized_catalog()
        work_one = self.insert_work(catalog)
        work_two = self.insert_work(catalog)

        with catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO identifiers (id, work_id, namespace, value) VALUES (?, ?, ?, ?)",
                (new_id(), work_one, "doi", "10.1000/example"),
            )
        with self.assertRaises(IntegrityError):
            with catalog.transaction() as connection:
                connection.exec_driver_sql(
                    "INSERT INTO identifiers (id, work_id, namespace, value) VALUES (?, ?, ?, ?)",
                    (new_id(), work_two, "doi", "10.1000/example"),
                )
        with self.assertRaises(IntegrityError):
            with catalog.transaction() as connection:
                connection.exec_driver_sql(
                    "INSERT INTO identifiers (id, work_id, namespace, value) VALUES (?, ?, ?, ?)",
                    (new_id(), new_id(), "pmid", "123"),
                )

    def test_nonterminal_acquisition_job_partial_unique_index(self) -> None:
        catalog = self.create_initialized_catalog()
        work_id = self.insert_work_version(catalog)
        with catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO acquisition_jobs (id, work_version_id, asset_role, state) VALUES (?, ?, ?, ?)",
                (new_id(), work_id, "primary_pdf", "pending"),
            )
        with self.assertRaises(IntegrityError):
            with catalog.transaction() as connection:
                connection.exec_driver_sql(
                    "INSERT INTO acquisition_jobs (id, work_version_id, asset_role, state) VALUES (?, ?, ?, ?)",
                    (new_id(), work_id, "primary_pdf", "paused"),
                )

        with catalog.transaction() as connection:
            for state in ("succeeded", "failed", "cancelled"):
                connection.exec_driver_sql(
                    "INSERT INTO acquisition_jobs (id, work_version_id, asset_role, state) VALUES (?, ?, ?, ?)",
                    (new_id(), work_id, "primary_pdf", state),
                )
            index_sql = connection.exec_driver_sql(
                "SELECT sql FROM sqlite_master WHERE type = 'index' "
                "AND name = 'uq_acquisition_jobs_nonterminal'"
            ).scalar_one()
        self.assertIn("WHERE state IN", index_sql)

    def test_domain_run_output_state_constraints_are_enforced_by_sql(self) -> None:
        catalog = self.create_initialized_catalog()
        work_id = self.insert_work_version(catalog)
        package_version_id = new_id()
        statement = (
            "INSERT INTO domain_runs "
            "(id, package_version_id, status, output_pointer, output_sha256) "
            "VALUES (?, ?, ?, ?, ?)"
        )
        with catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO package_versions "
                "(id, work_version_id, version, schema_version, quality, storage_path, sha256) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    package_version_id,
                    work_id,
                    1,
                    "1",
                    "pdf_backed",
                    "packages/direct/v1.json",
                    "a" * 64,
                ),
            )
            connection.exec_driver_sql(
                statement,
                (new_id(), package_version_id, "pending", None, None),
            )
            connection.exec_driver_sql(
                statement,
                (new_id(), package_version_id, "succeeded", "outputs/run.jsonl", "b" * 64),
            )

        invalid_outputs = (
            ("pending", "outputs/run.jsonl", None),
            ("pending", None, "c" * 64),
            ("active", "outputs/run.jsonl", "d" * 64),
            ("failed", "outputs/run.jsonl", "e" * 64),
            ("pending", "outputs/run.jsonl", "f" * 64),
            ("cancelled", "outputs/run.jsonl", "1" * 64),
            ("succeeded", None, None),
            ("succeeded", "outputs/run.jsonl", None),
            ("succeeded", None, "2" * 64),
            ("succeeded", "   ", "3" * 64),
        )
        for state, pointer, sha256 in invalid_outputs:
            with self.subTest(state=state, pointer=pointer, sha256=sha256):
                with self.assertRaises(IntegrityError):
                    with catalog.transaction() as connection:
                        connection.exec_driver_sql(
                            statement,
                            (new_id(), package_version_id, state, pointer, sha256),
                        )

    def test_hash_json_timestamp_and_review_constraints_are_enforced(self) -> None:
        catalog = self.create_initialized_catalog()
        work_id = self.insert_work_version(catalog)
        sha256 = "a" * 64
        with catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO raw_assets "
                "(id, sha256, storage_path, media_type, format, byte_size, provenance_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (new_id(), sha256, f"raw/{sha256[:2]}/{sha256}", "application/pdf", "pdf", 42, "{}"),
            )
            connection.exec_driver_sql(
                "INSERT INTO works (id, status, needs_review, review_reason) VALUES (?, ?, ?, ?)",
                (new_id(), "review", 1, "identifier ambiguity"),
            )

        invalid_statements = (
            (
                "INSERT INTO raw_assets "
                "(id, sha256, storage_path, media_type, format, byte_size, provenance_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (new_id(), sha256, "raw/bb/duplicate.pdf", "application/pdf", "pdf", 42, "{}"),
            ),
            (
                "INSERT INTO raw_assets "
                "(id, sha256, storage_path, media_type, format, byte_size, provenance_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (new_id(), "invalid", "raw/cc/file.pdf", "application/pdf", "pdf", 42, "{}"),
            ),
            (
                "INSERT INTO raw_assets "
                "(id, sha256, storage_path, media_type, format, byte_size, provenance_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (new_id(), "b" * 64, "raw/dd/file.pdf", "application/pdf", "pdf", 42, "not-json"),
            ),
            (
                "INSERT INTO raw_assets "
                "(id, sha256, storage_path, media_type, format, byte_size, provenance_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (new_id(), "d" * 64, "raw/ee/file.pdf", "application/pdf", "pdf", 42, '{ "a": 1 }'),
            ),
            (
                "INSERT INTO raw_assets "
                "(id, sha256, storage_path, media_type, format, byte_size, provenance_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (new_id(), "e" * 64, "raw/ff/file.pdf", "application/pdf", "pdf", 0, "{}"),
            ),
            (
                "INSERT INTO works (id, status, needs_review) VALUES (?, ?, ?)",
                (new_id(), "review", 0),
            ),
            (
                "INSERT INTO works (id, created_at) VALUES (?, ?)",
                (new_id(), "2026-07-20 12:00:00"),
            ),
        )
        for statement, parameters in invalid_statements:
            with self.subTest(statement=statement, parameters=parameters):
                with self.assertRaises(IntegrityError):
                    with catalog.transaction() as connection:
                        connection.exec_driver_sql(statement, parameters)

        with catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO metadata_labels "
                "(id, work_version_id, taxonomy, taxonomy_version, input_sha256, label) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (new_id(), work_id, "topic", "v1", "c" * 64, "candidate"),
            )
        with self.assertRaises(IntegrityError):
            with catalog.transaction() as connection:
                connection.exec_driver_sql(
                    "INSERT INTO metadata_labels "
                    "(id, work_version_id, taxonomy, taxonomy_version, input_sha256, label) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (new_id(), work_id, "topic", "v1", "c" * 64, "candidate"),
                )

    def test_asset_intent_sql_invariants_and_immutability(self) -> None:
        catalog = self.create_initialized_catalog()
        work_id = self.insert_work_version(catalog)
        job_id = new_id()
        attempt_id = new_id()
        intent_id = new_id()
        raw_id = new_id()
        sha256 = "7" * 64
        temporary_path = f"staging/{intent_id}.part"
        storage_path = f"raw/{sha256[:2]}/{sha256}"
        insert_intent = (
            "INSERT INTO asset_intents "
            "(id, work_version_id, job_id, attempt_id, raw_asset_id, asset_role, state, "
            "temporary_path, storage_path, expected_sha256, media_type, format, "
            "expected_byte_size, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        insert_raw = (
            "INSERT INTO raw_assets "
            "(id, sha256, storage_path, media_type, format, byte_size, provenance_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        valid = (
            intent_id, work_id, job_id, attempt_id, None, "primary_pdf", "pending",
            temporary_path, storage_path, sha256, "application/pdf", "pdf_v1", 42,
            '{"provider":"example"}',
        )
        with catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO acquisition_jobs (id, work_version_id, asset_role) VALUES (?, ?, ?)",
                (job_id, work_id, "primary_pdf"),
            )
            connection.exec_driver_sql(
                "INSERT INTO acquisition_attempts (id, job_id, provider) VALUES (?, ?, ?)",
                (attempt_id, job_id, "example"),
            )
            connection.exec_driver_sql(insert_intent, valid)
            connection.exec_driver_sql(
                insert_raw,
                (raw_id, sha256, storage_path, "application/pdf", "pdf_v1", 42, '{"provider":"example"}'),
            )

        invalid_fields = {
            7: "staging/wrong.part",
            8: f"raw/00/{sha256}",
            9: "INVALID",
            10: "Application/PDF",
            11: "pdf-v1",
            12: 0,
            13: '{ "provider": "example" }',
        }
        for index, replacement in invalid_fields.items():
            with self.subTest(index=index, replacement=replacement):
                parameters = list(valid)
                parameters[0] = new_id()
                if index == 7:
                    parameters[index] = replacement
                elif index == 8:
                    parameters[index] = replacement
                else:
                    parameters[index] = replacement
                    parameters[7] = f"staging/{parameters[0]}.part"
                with self.assertRaises(IntegrityError):
                    with catalog.transaction() as connection:
                        connection.exec_driver_sql(insert_intent, tuple(parameters))

        for media_type in (
            "application/",
            "/pdf",
            "application//pdf",
            "application/pdf; charset=utf-8",
            "!application/pdf",
            "application/!pdf",
        ):
            with self.subTest(media_type=media_type):
                parameters = list(valid)
                parameters[0] = new_id()
                parameters[7] = f"staging/{parameters[0]}.part"
                parameters[10] = media_type
                with self.assertRaises(IntegrityError):
                    with catalog.transaction() as connection:
                        connection.exec_driver_sql(insert_intent, tuple(parameters))

                raw_sha = format(8 + len(media_type), "x")[-1] * 64
                with self.assertRaises(IntegrityError):
                    with catalog.transaction() as connection:
                        connection.exec_driver_sql(
                            insert_raw,
                            (
                                new_id(),
                                raw_sha,
                                f"raw/{raw_sha[:2]}/{raw_sha}",
                                media_type,
                                "pdf_v1",
                                42,
                                '{"provider":"example"}',
                            ),
                        )

        one_character_format = list(valid)
        one_character_format[0] = new_id()
        one_character_format[7] = f"staging/{one_character_format[0]}.part"
        one_character_format[8] = f"raw/66/{'6' * 64}"
        one_character_format[9] = "6" * 64
        one_character_format[11] = "x"
        with catalog.transaction() as connection:
            connection.exec_driver_sql(insert_intent, tuple(one_character_format))

        coupled = list(valid)
        coupled[0] = new_id()
        coupled[4] = raw_id
        coupled[7] = f"staging/{coupled[0]}.part"
        invalid_couplings = (
            ("pending", raw_id),
            ("abandoned", raw_id),
            ("published", None),
            ("finalized", None),
        )
        for state, coupled_raw_id in invalid_couplings:
            with self.subTest(state=state, raw_asset_id=coupled_raw_id):
                parameters = list(coupled)
                parameters[0] = new_id()
                parameters[4] = coupled_raw_id
                parameters[6] = state
                parameters[7] = f"staging/{parameters[0]}.part"
                with self.assertRaises(IntegrityError):
                    with catalog.transaction() as connection:
                        connection.exec_driver_sql(insert_intent, tuple(parameters))

        with catalog.transaction() as connection:
            connection.exec_driver_sql(
                "UPDATE asset_intents SET state = 'published', raw_asset_id = ? WHERE id = ?",
                (raw_id, intent_id),
            )
            connection.exec_driver_sql(
                "UPDATE asset_intents SET state = 'finalized' WHERE id = ?", (intent_id,)
            )

        illegal_updates: list[tuple[str, tuple[object, ...]]] = [
            ("UPDATE asset_intents SET state = 'pending' WHERE id = ?", (intent_id,)),
            ("DELETE FROM asset_intents WHERE id = ?", (intent_id,)),
            ("UPDATE raw_assets SET byte_size = 43 WHERE id = ?", (raw_id,)),
            ("DELETE FROM raw_assets WHERE id = ?", (raw_id,)),
        ]
        immutable_changes = {
            "id": new_id(),
            "work_version_id": new_id(),
            "job_id": new_id(),
            "attempt_id": None,
            "asset_role": "html",
            "temporary_path": "staging/other.part",
            "storage_path": f"raw/88/{'8' * 64}",
            "expected_sha256": "8" * 64,
            "media_type": "text/html",
            "format": "html",
            "expected_byte_size": 43,
            "provenance_json": "{}",
            "created_at": "2026-07-20T12:00:01.000Z",
        }
        illegal_updates.extend(
            (f"UPDATE asset_intents SET {column} = ? WHERE id = ?", (value, intent_id))
            for column, value in immutable_changes.items()
        )
        for statement, parameters in illegal_updates:
            with self.subTest(statement=statement):
                with self.assertRaises(IntegrityError):
                    with catalog.transaction() as connection:
                        connection.exec_driver_sql(statement, parameters)

    def test_asset_triggers_are_present_after_initialization(self) -> None:
        catalog = self.create_initialized_catalog()
        with catalog.connect() as connection:
            triggers = {
                row[0]
                for row in connection.exec_driver_sql(
                    "SELECT name FROM sqlite_master WHERE type = 'trigger'"
                )
            }
        self.assertEqual(
            triggers,
            {
                "trg_works_preferred_version_insert",
                "trg_works_preferred_version_update",
                "trg_raw_assets_immutable_update",
                "trg_raw_assets_immutable_delete",
                "trg_raw_assets_insert_coherence",
                "trg_asset_intents_initial_coherence",
                "trg_asset_intents_immutable_replay",
                "trg_asset_intents_state_transition",
                "trg_asset_intents_immutable_delete",
            },
        )

    def test_asset_intent_cross_row_invariants_reject_adversarial_sql(self) -> None:
        catalog = self.create_initialized_catalog()
        work_a = self.insert_work_version(catalog)
        work_b = self.insert_work_version(catalog)
        job_a = new_id()
        job_b = new_id()
        job_xml = new_id()
        attempt_a = new_id()
        attempt_b = new_id()
        with catalog.transaction() as connection:
            for job_id, work_id, role in (
                (job_a, work_a, "primary_pdf"),
                (job_b, work_b, "primary_pdf"),
                (job_xml, work_a, "xml"),
            ):
                connection.exec_driver_sql(
                    "INSERT INTO acquisition_jobs (id, work_version_id, asset_role) VALUES (?, ?, ?)",
                    (job_id, work_id, role),
                )
            connection.exec_driver_sql(
                "INSERT INTO acquisition_attempts (id, job_id, provider) VALUES (?, ?, ?)",
                (attempt_a, job_a, "provider-a"),
            )
            connection.exec_driver_sql(
                "INSERT INTO acquisition_attempts (id, job_id, provider) VALUES (?, ?, ?)",
                (attempt_b, job_b, "provider-b"),
            )

        statement = (
            "INSERT INTO asset_intents "
            "(id, work_version_id, job_id, attempt_id, raw_asset_id, asset_role, state, "
            "temporary_path, storage_path, expected_sha256, media_type, format, "
            "expected_byte_size, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )

        def parameters(
            *,
            work_id: str = work_a,
            job_id: str = job_a,
            attempt_id: str | None = attempt_a,
            role: str = "primary_pdf",
            state: str = "pending",
            raw_asset_id: str | None = None,
            expected_sha256: str = "5" * 64,
        ) -> tuple[object, ...]:
            intent_id = new_id()
            return (
                intent_id,
                work_id,
                job_id,
                attempt_id,
                raw_asset_id,
                role,
                state,
                f"staging/{intent_id}.part",
                f"raw/{expected_sha256[:2]}/{expected_sha256}",
                expected_sha256,
                "application/pdf",
                "pdf",
                42,
                "{}",
            )

        initial_raw_id = new_id()
        initial_sha256 = "4" * 64
        with catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO raw_assets "
                "(id, sha256, storage_path, media_type, format, byte_size, provenance_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    initial_raw_id,
                    initial_sha256,
                    f"raw/44/{initial_sha256}",
                    "application/pdf",
                    "pdf",
                    42,
                    "{}",
                ),
            )

        adversarial = (
            parameters(work_id=work_a, job_id=job_b),
            parameters(job_id=job_xml, role="primary_pdf", attempt_id=None),
            parameters(attempt_id=attempt_b),
            parameters(
                state="published",
                raw_asset_id=initial_raw_id,
                expected_sha256=initial_sha256,
            ),
            parameters(
                state="finalized",
                raw_asset_id=initial_raw_id,
                expected_sha256=initial_sha256,
            ),
        )
        for values in adversarial:
            with self.subTest(values=values[:7]):
                with self.assertRaises(IntegrityError):
                    with catalog.transaction() as connection:
                        connection.exec_driver_sql(statement, values)

        mismatches = (
            ("media_type", "application/xml"),
            ("format", "xml"),
            ("byte_size", 43),
        )
        for index, (column, value) in enumerate(mismatches, start=5):
            sha256 = str(index) * 64
            valid = parameters(expected_sha256=sha256)
            intent_id = valid[0]
            raw_id = new_id()
            with catalog.transaction() as connection:
                connection.exec_driver_sql(statement, valid)
                connection.exec_driver_sql(
                    "INSERT INTO raw_assets "
                    "(id, sha256, storage_path, media_type, format, byte_size, provenance_json) "
                    f"VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        raw_id,
                        sha256,
                        f"raw/{sha256[:2]}/{sha256}",
                        value if column == "media_type" else "application/pdf",
                        value if column == "format" else "pdf",
                        value if column == "byte_size" else 42,
                        "{}",
                    ),
                )
            with self.subTest(raw_mismatch=column):
                with self.assertRaises(IntegrityError):
                    with catalog.transaction() as connection:
                        connection.exec_driver_sql(
                            "UPDATE asset_intents SET state = 'published', raw_asset_id = ? WHERE id = ?",
                            (raw_id, intent_id),
                        )

        expected_sha256 = "8" * 64
        actual_sha256 = "9" * 64
        hash_intent = parameters(expected_sha256=expected_sha256)
        hash_raw_id = new_id()
        with catalog.transaction() as connection:
            connection.exec_driver_sql(statement, hash_intent)
            connection.exec_driver_sql(
                "INSERT INTO raw_assets "
                "(id, sha256, storage_path, media_type, format, byte_size, provenance_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    hash_raw_id,
                    actual_sha256,
                    f"raw/99/{actual_sha256}",
                    "application/pdf",
                    "pdf",
                    42,
                    "{}",
                ),
            )
        with self.assertRaises(IntegrityError):
            with catalog.transaction() as connection:
                connection.exec_driver_sql(
                    "UPDATE asset_intents SET state = 'published', raw_asset_id = ? WHERE id = ?",
                    (hash_raw_id, hash_intent[0]),
                )

        with catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("PRAGMA integrity_check").scalar_one(), "ok")
            self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_key_check").all(), [])


if __name__ == "__main__":
    import unittest

    unittest.main()
