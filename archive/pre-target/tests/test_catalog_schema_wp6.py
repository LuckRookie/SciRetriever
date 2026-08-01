from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase
from uuid import uuid4

from sqlalchemy.engine import Connection
from sqlalchemy.exc import IntegrityError, OperationalError

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import create_catalog_engine, initialize_catalog, open_catalog_engine, open_read_only_catalog_engine
from sciretriever.core.curation import CurationAction

BASELINE_TABLES = {
    "asset_intents", "authors", "authorships", "current_analyses", "diagnostic_records",
    "domain_runs", "external_parser_attempts", "generated_work_version_metadata",
    "generated_work_version_tags", "identifiers", "identity_reviews", "manual_metadata_overrides",
    "manual_work_tags", "metadata_labels", "metadata_observations", "normalized_artifacts",
    "package_versions", "processing_runs", "provider_canonical_projections", "publisher_aliases",
    "publishers", "raw_assets", "tag_aliases", "tags", "venue_aliases", "venues",
    "version_references", "version_relations", "work_version_assets", "work_version_identifiers",
    "work_versions", "works",
}
OPERATION_SQL = (
    "INSERT INTO curation_operations (id, action, subject_kind, subject_id, before_snapshot_json, "
    "before_sha256, after_snapshot_json, after_sha256, stale_guard_sha256, evidence_json, "
    "review_decision, result, operation_sha256, undo_of_operation_id) "
    "VALUES (?, ?, ?, ?, '{}', ?, '{}', ?, ?, '{}', 'not_required', ?, ?, ?)"
)
HASH = "f" * 64


def operation_values(action: str, subject_kind: str, subject_id: str, undo_of: str | None = None) -> tuple[str | None, ...]:
    result = "undone" if action == "undo" else "applied"
    return (str(uuid4()), action, subject_kind, subject_id, HASH, HASH, HASH, result, HASH, undo_of)


def insert_catalog_subjects(connection: Connection) -> tuple[str, str, str, str]:
    work_id, version_id, author_id, review_id = (str(uuid4()) for _ in range(4))
    connection.exec_driver_sql("INSERT INTO works (id) VALUES (?)", (work_id,))
    connection.exec_driver_sql(
        "INSERT INTO work_versions (id, work_id, normalized_title, title, stable_version_key) "
        "VALUES (?, ?, 'title', 'Title', ?)", (version_id, work_id, f"manual:{version_id}"),
    )
    connection.exec_driver_sql(
        "INSERT INTO authors (id, display_name, normalized_name) VALUES (?, 'Author', 'author')",
        (author_id,),
    )
    connection.exec_driver_sql(
        "INSERT INTO identity_reviews (id, identifiers_json, candidate_work_ids_json, reason) "
        "VALUES (?, '[]', '[]', 'identity conflict')", (review_id,),
    )
    return work_id, version_id, author_id, review_id


class CatalogSchemaWp6CharacterizationTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "catalog.sqlite"

    def test_fresh_bootstrap_table_inventory_is_characterized(self) -> None:
        catalog = create_catalog_engine(self.path)
        self.addCleanup(catalog.dispose)
        initialize_catalog(catalog)
        with catalog.connect() as connection:
            tables = set(connection.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).scalars())
        self.assertTrue(BASELINE_TABLES.issubset(tables))

    def test_raw_asset_rows_remain_immutable_at_the_database_boundary(self) -> None:
        catalog = create_catalog_engine(self.path)
        self.addCleanup(catalog.dispose)
        initialize_catalog(catalog)
        raw_id, digest = str(uuid4()), "a" * 64
        with catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, byte_size, provenance_json) "
                "VALUES (?, ?, ?, 'application/pdf', 'pdf', 1, '{}')", (raw_id, digest, f"raw/aa/{digest}"),
            )
        with self.assertRaises(IntegrityError), catalog.transaction() as connection:
            connection.exec_driver_sql("UPDATE raw_assets SET byte_size=2 WHERE id=?", (raw_id,))
        with catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql(
                "SELECT byte_size FROM raw_assets WHERE id=?", (raw_id,)
            ).scalar_one(), 1)

    def test_missing_open_and_read_only_modes_are_characterized(self) -> None:
        with self.assertRaises(FileNotFoundError):
            open_catalog_engine(self.path)
        catalog = create_catalog_engine(self.path)
        initialize_catalog(catalog)
        catalog.dispose()
        opened = open_catalog_engine(self.path)
        opened.dispose()
        read_only = open_read_only_catalog_engine(self.path)
        self.addCleanup(read_only.dispose)
        with read_only.connect() as connection, self.assertRaises(OperationalError):
            connection.exec_driver_sql("INSERT INTO works (id) VALUES (?)", (str(uuid4()),))


class CatalogSchemaWp6TargetTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary.name) / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)

    def test_polymorphic_curation_subjects_reject_orphans_without_mutation(self) -> None:
        cases = (
            ("merge_work", "work", None), ("set_metadata", "work_version", None),
            ("merge_author", "author", None), ("resolve_review", "review", None),
            ("undo", "operation", str(uuid4())),
        )
        for action, kind, undo_of in cases:
            with self.subTest(kind=kind), self.assertRaises(IntegrityError), self.catalog.transaction() as connection:
                connection.exec_driver_sql(OPERATION_SQL, operation_values(action, kind, undo_of or str(uuid4()), undo_of))
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM curation_operations").scalar_one(), 0)

    def test_existing_polymorphic_subjects_and_typed_resolve_review_persist(self) -> None:
        with self.catalog.transaction() as connection:
            work_id, version_id, author_id, review_id = insert_catalog_subjects(connection)
            values = (
                ("merge_work", "work", work_id), ("set_metadata", "work_version", version_id),
                ("merge_author", "author", author_id),
                (CurationAction.RESOLVE_REVIEW.value, "review", review_id),
            )
            for action, kind, subject_id in values:
                connection.exec_driver_sql(OPERATION_SQL, operation_values(action, kind, subject_id))
        with self.catalog.connect() as connection:
            rows = tuple(map(tuple, connection.exec_driver_sql(
                "SELECT action, subject_kind, subject_id FROM curation_operations ORDER BY action"
            ).all()))
        self.assertIn(("resolve_review", "review", review_id), rows)
        self.assertEqual(len(rows), 4)

    def test_legacy_identity_review_subject_is_rejected(self) -> None:
        with self.catalog.transaction() as connection:
            review_id = insert_catalog_subjects(connection)[3]
        with self.assertRaises(IntegrityError), self.catalog.transaction() as connection:
            connection.exec_driver_sql(OPERATION_SQL, operation_values("resolve_review", "identity_review", review_id))

    def test_fresh_schema_has_only_approved_wp6_primitives(self) -> None:
        with self.catalog.connect() as connection:
            tables = set(connection.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).scalars())
        self.assertTrue({"diagnostic_records", "curation_operations", "work_merge_lineage", "author_merge_lineage"}.issubset(tables))
        self.assertTrue({"events", "failures", "acquisition_diagnostics"}.isdisjoint(tables))
        self.assertFalse([table for table in tables if any(term in table for term in ("migration", "task", "job", "expansion_status")) and table != "external_parser_attempts"])

    def test_pre_identity_diagnostic_is_representable_without_catalog_subject(self) -> None:
        diagnostic_id = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO diagnostic_records (id, stage, subject_kind, input_fingerprint, reason, action, "
                "retryable, summary, details_json) VALUES (?, 'metadata', 'input', ?, 'provider', 'retry', 1, "
                "'metadata unavailable', '{}')", (diagnostic_id, "a" * 64),
            )
        with self.catalog.connect() as connection:
            row = connection.exec_driver_sql(
                "SELECT subject_kind, input_fingerprint, work_id FROM diagnostic_records WHERE id=?",
                (diagnostic_id,),
            ).one()
        self.assertEqual(tuple(row), ("input", "a" * 64, None))

    def test_audit_rows_are_append_only_and_undo_link_is_unique(self) -> None:
        with self.catalog.transaction() as connection:
            work_id = insert_catalog_subjects(connection)[0]
            original = operation_values("merge_work", "work", work_id)
            connection.exec_driver_sql(OPERATION_SQL, original)
            undo = operation_values("undo", "operation", str(original[0]), str(original[0]))
            connection.exec_driver_sql(OPERATION_SQL, undo)
        with self.assertRaises(IntegrityError), self.catalog.transaction() as connection:
            connection.exec_driver_sql("UPDATE curation_operations SET evidence_json='{}' WHERE id=?", (original[0],))
        with self.assertRaises(IntegrityError), self.catalog.transaction() as connection:
            connection.exec_driver_sql(OPERATION_SQL, operation_values("undo", "operation", str(original[0]), str(original[0])))
        with self.catalog.transaction() as connection:
            second = operation_values("merge_work", "work", work_id)
            connection.exec_driver_sql(OPERATION_SQL, second)
        with self.assertRaises(IntegrityError), self.catalog.transaction() as connection:
            connection.exec_driver_sql(OPERATION_SQL, operation_values("undo", "operation", str(original[0]), str(second[0])))
        with self.catalog.connect() as connection:
            linked = connection.exec_driver_sql(
                "SELECT id FROM curation_operations WHERE undo_of_operation_id=?", (original[0],)
            ).scalar_one()
        self.assertEqual(linked, undo[0])

    def test_work_and_author_merge_lineage_reject_cycles_atomically(self) -> None:
        work_a, work_b, author_a, author_b = (str(uuid4()) for _ in range(4))
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("INSERT INTO works (id) VALUES (?),(?)", (work_a, work_b))
            connection.exec_driver_sql(
                "INSERT INTO authors (id,display_name,normalized_name) VALUES (?,'A','a'),(?,'B','b')",
                (author_a, author_b),
            )
            work_op, author_op = operation_values("merge_work", "work", work_a), operation_values("merge_author", "author", author_a)
            connection.exec_driver_sql(OPERATION_SQL, work_op)
            connection.exec_driver_sql(OPERATION_SQL, author_op)
            connection.exec_driver_sql("INSERT INTO work_merge_lineage VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))", (work_a, work_b, work_op[0]))
            connection.exec_driver_sql("INSERT INTO author_merge_lineage VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))", (author_a, author_b, author_op[0]))
        with self.assertRaises(IntegrityError), self.catalog.transaction() as connection:
            reverse = operation_values("merge_work", "work", work_b)
            connection.exec_driver_sql(OPERATION_SQL, reverse)
            connection.exec_driver_sql("INSERT INTO work_merge_lineage VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))", (work_b, work_a, reverse[0]))
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM work_merge_lineage").scalar_one(), 1)

    def test_checks_foreign_keys_and_indexes_fail_closed(self) -> None:
        invalid = (
            ("diagnostic_records", "(id,stage,subject_kind,reason,action,retryable,summary,details_json) VALUES (?,'metadata','input','provider','retry',1,'x','{}')", (str(uuid4()),)),
            ("curation_operations", "(id,action,subject_kind,subject_id,before_snapshot_json,before_sha256,after_snapshot_json,after_sha256,stale_guard_sha256,evidence_json) VALUES (?,'unknown','work',?,'{}',?,'{}',?,?,'{}')", (str(uuid4()), str(uuid4()), "d" * 64, "d" * 64, "d" * 64)),
            ("curation_operations", "(id,action,subject_kind,subject_id,before_snapshot_json,before_sha256,after_snapshot_json,after_sha256,stale_guard_sha256,evidence_json) VALUES (?,'merge_work','work',?,?,?,'{}',?,?,'{}')", (str(uuid4()), str(uuid4()), '"' + "x" * 16385 + '"', "e" * 64, "e" * 64, "e" * 64)),
            ("work_merge_lineage", "(source_work_id,target_work_id,operation_id) VALUES (?,?,?)", (str(uuid4()), str(uuid4()), str(uuid4()))),
        )
        for table, sql, parameters in invalid:
            with self.subTest(table=table), self.assertRaises(IntegrityError), self.catalog.transaction() as connection:
                connection.exec_driver_sql(f"INSERT INTO {table} {sql}", parameters)
        with self.catalog.connect() as connection:
            foreign_tables = {row[2] for row in connection.exec_driver_sql("PRAGMA foreign_key_list('work_merge_lineage')")}
            indexes = set(connection.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='index'").scalars())
        self.assertEqual(foreign_tables, {"works", "curation_operations"})
        self.assertTrue({"ix_diagnostic_records_stage_occurred_at", "ix_curation_operations_subject_occurred_at", "ix_work_merge_lineage_target_work_id", "ix_author_merge_lineage_target_author_id"}.issubset(indexes))
