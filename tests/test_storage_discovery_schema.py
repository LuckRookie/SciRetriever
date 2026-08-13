from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import sciretriever.storage.sqlite.engine as engine_module
from sciretriever.storage.sqlite.engine import (
    CatalogEngine,
    UnsupportedCatalogError,
    validate_catalog,
)
from sciretriever.storage.sqlite.schema import (
    SCHEMA_FINGERPRINT,
    SCHEMA_INDEXES,
    SCHEMA_MANIFEST,
    SCHEMA_TABLES,
    schema_fingerprint,
)
from sciretriever.storage.sqlite.schema_discovery import (
    DISCOVERY_SCHEMA_INDEXES,
    DISCOVERY_SCHEMA_MANIFEST,
    DISCOVERY_SCHEMA_TABLES,
    DISCOVERY_SCHEMA_TRIGGERS,
)


class StorageDiscoverySchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-discovery-schema-")
        self.addCleanup(self.temporary.cleanup)
        self.catalog = Path(self.temporary.name) / "catalog.sqlite"
        self.engine = CatalogEngine(self.catalog)

    @staticmethod
    def _insert_run(
        connection: sqlite3.Connection,
        run_id: str,
        kind: str,
        *,
        status: str = "RUNNING",
    ) -> None:
        connection.execute(
            "INSERT INTO discovery_runs(discovery_run_id,kind,status,started_at) VALUES (?,?,?,?)",
            (run_id, kind, status, "2026-08-11T00:00:00Z"),
        )

    @staticmethod
    def _insert_topic_input(
        connection: sqlite3.Connection,
        run_id: str,
        *,
        query: str = "bounded topic",
    ) -> None:
        connection.execute(
            "INSERT INTO topic_discovery_inputs("
            "discovery_run_id,kind,query,year_from,year_to) VALUES (?,?,?,?,?)",
            (run_id, "topic", query, 2020, 2026),
        )

    @staticmethod
    def _insert_citation_input(connection: sqlite3.Connection, run_id: str) -> None:
        connection.execute(
            "INSERT INTO citation_discovery_inputs("
            "discovery_run_id,kind,direction,max_depth,result_limit) VALUES (?,?,?,?,?)",
            (run_id, "citation", "both", 2, 50),
        )

    @staticmethod
    def _insert_literature(
        connection: sqlite3.Connection,
        meta_literature_id: str,
        literature_id: str,
    ) -> None:
        connection.execute(
            "INSERT INTO meta_literatures("
            "meta_literature_id,representative_literature_id) VALUES (?,?)",
            (meta_literature_id, literature_id),
        )
        connection.execute(
            "INSERT INTO literatures(literature_id,meta_literature_id,version_role) VALUES (?,?,?)",
            (literature_id, meta_literature_id, "other"),
        )

    @staticmethod
    def _insert_member(
        connection: sqlite3.Connection,
        meta_literature_id: str,
        literature_id: str,
    ) -> None:
        connection.execute(
            "INSERT INTO literatures(literature_id,meta_literature_id,version_role) VALUES (?,?,?)",
            (literature_id, meta_literature_id, "other"),
        )

    @staticmethod
    def _insert_owned_observation(
        connection: sqlite3.Connection,
        observation_id: str,
        literature_id: str,
    ) -> None:
        provenance_id = f"provenance-{observation_id}"
        connection.execute(
            "INSERT INTO provenances("
            "provenance_id,source_kind,source_name,source_record_id,observed_at,"
            "input_sha256,parameters_sha256) VALUES (?,?,?,?,?,?,?)",
            (
                provenance_id,
                "metadata-provider",
                "fixture-provider",
                f"record-{observation_id}",
                "2026-08-11T00:00:00Z",
                None,
                None,
            ),
        )
        connection.execute(
            "INSERT INTO metadata_observations(observation_id,provenance_id,title) VALUES (?,?,?)",
            (observation_id, provenance_id, "Observed title"),
        )
        connection.execute(
            "INSERT INTO literature_metadata_observations(literature_id,observation_id) "
            "VALUES (?,?)",
            (literature_id, observation_id),
        )

    def test_fresh_catalog_has_exact_discovery_manifest_and_no_forbidden_fallbacks(self) -> None:
        expected_columns = {
            "discovery_runs": (
                "discovery_run_id",
                "kind",
                "status",
                "started_at",
            ),
            "topic_discovery_inputs": (
                "discovery_run_id",
                "kind",
                "query",
                "year_from",
                "year_to",
            ),
            "citation_discovery_inputs": (
                "discovery_run_id",
                "kind",
                "direction",
                "max_depth",
                "result_limit",
            ),
            "citation_discovery_seeds": (
                "discovery_run_id",
                "seed_ordinal",
                "literature_id",
            ),
            "discovery_run_providers": (
                "discovery_run_id",
                "provider_ordinal",
                "provider_name",
                "scan_limit",
            ),
            "discovery_source_results": (
                "discovery_run_id",
                "provider_name",
                "outcome",
                "failure_code",
                "failure_reason",
                "failure_action",
                "failure_retryable",
            ),
            "discovery_results": (
                "discovery_run_id",
                "meta_literature_id",
            ),
            "topic_discovery_causes": (
                "discovery_run_id",
                "meta_literature_id",
                "metadata_observation_id",
                "actual_literature_id",
            ),
            "citation_discovery_causes": (
                "discovery_run_id",
                "meta_literature_id",
                "source_literature_id",
                "target_literature_id",
                "actual_literature_id",
                "depth",
            ),
        }
        expected_indexes = {
            "discovery_run_status_lookup": (
                "status",
                "started_at",
                "discovery_run_id",
            ),
            "citation_discovery_seed_literature_lookup": (
                "literature_id",
                "discovery_run_id",
                "seed_ordinal",
            ),
            "discovery_result_meta_lookup": (
                "meta_literature_id",
                "discovery_run_id",
            ),
            "topic_discovery_cause_observation_lookup": (
                "metadata_observation_id",
                "actual_literature_id",
                "discovery_run_id",
                "meta_literature_id",
            ),
            "citation_discovery_cause_source_lookup": (
                "source_literature_id",
                "discovery_run_id",
                "meta_literature_id",
                "depth",
                "target_literature_id",
            ),
            "citation_discovery_cause_target_lookup": (
                "target_literature_id",
                "discovery_run_id",
                "meta_literature_id",
                "depth",
                "source_literature_id",
            ),
        }
        self.assertEqual(set(expected_columns), set(DISCOVERY_SCHEMA_TABLES))
        self.assertEqual(set(expected_indexes), set(DISCOVERY_SCHEMA_INDEXES))
        self.assertEqual(
            set(DISCOVERY_SCHEMA_TRIGGERS),
            {
                "topic_discovery_cause_insert_closure",
                "topic_discovery_cause_update_identity",
                "citation_discovery_cause_insert_closure",
                "citation_discovery_cause_update_identity",
            },
        )
        self.assertEqual(
            SCHEMA_TABLES[-len(DISCOVERY_SCHEMA_TABLES) :],
            DISCOVERY_SCHEMA_TABLES,
        )
        self.assertEqual(
            SCHEMA_INDEXES[-len(DISCOVERY_SCHEMA_INDEXES) :],
            DISCOVERY_SCHEMA_INDEXES,
        )

        with self.engine.read_snapshot() as connection:
            for table_name, columns in expected_columns.items():
                with self.subTest(table=table_name):
                    self.assertEqual(
                        tuple(
                            row[1]
                            for row in connection.execute(f'PRAGMA table_info("{table_name}")')
                        ),
                        columns,
                    )
                    table_row = connection.execute(
                        "SELECT type,strict FROM pragma_table_list WHERE name=?",
                        (table_name,),
                    ).fetchone()
                    self.assertEqual(table_row, ("table", 1))

            explicit_indexes = tuple(
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='index' "
                    "AND name NOT LIKE 'sqlite_%' AND name IN ("
                    + ",".join("?" for _ in DISCOVERY_SCHEMA_INDEXES)
                    + ") ORDER BY name",
                    tuple(DISCOVERY_SCHEMA_INDEXES),
                )
            )
            self.assertEqual(explicit_indexes, tuple(sorted(DISCOVERY_SCHEMA_INDEXES)))
            for index_name, columns in expected_indexes.items():
                with self.subTest(index=index_name):
                    self.assertEqual(
                        tuple(
                            row[2]
                            for row in connection.execute(f'PRAGMA index_info("{index_name}")')
                        ),
                        columns,
                    )
            self.assertEqual(
                tuple(
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name"
                    )
                ),
                tuple(sorted(DISCOVERY_SCHEMA_TRIGGERS)),
            )

        discovery_sql = "\n".join(DISCOVERY_SCHEMA_MANIFEST).casefold()
        for forbidden in (
            " json",
            "details",
            "finished_at",
            "cursor",
            "request",
            "response",
            "score",
            "discovery_path",
            "selected_ids",
            "reference_id",
            "collection",
            "membership",
            "batch_run",
            "report",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, discovery_sql)

    def test_manifest_fingerprint_exact_objects_and_reopen_are_stable(self) -> None:
        self.assertEqual(
            SCHEMA_MANIFEST[-len(DISCOVERY_SCHEMA_MANIFEST) :],
            DISCOVERY_SCHEMA_MANIFEST,
        )
        self.assertEqual(schema_fingerprint(SCHEMA_MANIFEST), SCHEMA_FINGERPRINT)
        self.assertNotEqual(
            schema_fingerprint(SCHEMA_MANIFEST[: -len(DISCOVERY_SCHEMA_MANIFEST)]),
            SCHEMA_FINGERPRINT,
        )

        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                engine_module._schema_objects(connection),
                engine_module._schema_objects_from_manifest(SCHEMA_MANIFEST),
            )
            self.assertEqual(
                connection.execute("SELECT schema_fingerprint FROM schema_identity").fetchone(),
                (SCHEMA_FINGERPRINT,),
            )

        reopened = CatalogEngine.open(self.catalog)
        reopened.validate()
        with reopened.read_snapshot() as connection:
            self.assertEqual(
                connection.execute("SELECT schema_fingerprint FROM schema_identity").fetchone(),
                (SCHEMA_FINGERPRINT,),
            )

    def test_extra_schema_object_is_rejected_on_reopen(self) -> None:
        with self.engine.write_transaction() as connection:
            connection.execute("CREATE TABLE unexpected_discovery_cache(value TEXT) STRICT")

        with self.assertRaises(UnsupportedCatalogError):
            validate_catalog(self.catalog)
        with self.assertRaises(UnsupportedCatalogError):
            CatalogEngine.open(self.catalog)

    def test_topic_and_citation_inputs_are_mutually_typed_and_scalar_checked(self) -> None:
        with self.engine.write_transaction() as connection:
            self._insert_literature(connection, "meta-seed", "literature-seed")
            self._insert_run(connection, "run-topic", "topic")
            self._insert_topic_input(connection, "run-topic")
            self._insert_run(connection, "run-citation", "citation")
            self._insert_citation_input(connection, "run-citation")
            connection.execute(
                "INSERT INTO citation_discovery_seeds("
                "discovery_run_id,seed_ordinal,literature_id) VALUES (?,?,?)",
                ("run-citation", 0, "literature-seed"),
            )

            invalid_runs = (
                ("run-kind", "local", "RUNNING", "2026-08-11T00:00:00Z"),
                ("run-status", "topic", "CREATED", "2026-08-11T00:00:00Z"),
                ("run-empty-time", "topic", "RUNNING", "   "),
            )
            for values in invalid_runs:
                with self.subTest(run=values), self.assertRaises(sqlite3.IntegrityError):
                    connection.execute(
                        "INSERT INTO discovery_runs("
                        "discovery_run_id,kind,status,started_at) VALUES (?,?,?,?)",
                        values,
                    )

            with self.assertRaises(sqlite3.IntegrityError):
                self._insert_topic_input(connection, "run-citation")
            with self.assertRaises(sqlite3.IntegrityError):
                self._insert_citation_input(connection, "run-topic")
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO topic_discovery_inputs("
                    "discovery_run_id,kind,query,year_from,year_to) VALUES (?,?,?,?,?)",
                    ("run-topic-unknown", "topic", "query", 2020, 2026),
                )

            self._insert_run(connection, "run-bad-topic", "topic")
            invalid_topics = (
                ("topic", "   ", 2020, 2026),
                ("topic", "query", 0, 2026),
                ("topic", "query", 2027, 2026),
                ("citation", "query", 2020, 2026),
            )
            for kind, query, year_from, year_to in invalid_topics:
                with (
                    self.subTest(topic=(kind, query, year_from, year_to)),
                    self.assertRaises(sqlite3.IntegrityError),
                ):
                    connection.execute(
                        "INSERT INTO topic_discovery_inputs("
                        "discovery_run_id,kind,query,year_from,year_to) VALUES (?,?,?,?,?)",
                        ("run-bad-topic", kind, query, year_from, year_to),
                    )

            citation_cases = (
                ("sideways", 1, 1),
                ("both", -1, 1),
                ("both", 1, 0),
                ("references", 1.5, 1),
            )
            for index, (direction, max_depth, result_limit) in enumerate(citation_cases):
                run_id = f"run-bad-citation-{index}"
                self._insert_run(connection, run_id, "citation")
                with (
                    self.subTest(citation=(direction, max_depth, result_limit)),
                    self.assertRaises(sqlite3.IntegrityError),
                ):
                    connection.execute(
                        "INSERT INTO citation_discovery_inputs("
                        "discovery_run_id,kind,direction,max_depth,result_limit) "
                        "VALUES (?,?,?,?,?)",
                        (run_id, "citation", direction, max_depth, result_limit),
                    )

    def test_ordered_seeds_and_providers_enforce_fk_uniqueness_and_limits(self) -> None:
        with self.engine.write_transaction() as connection:
            self._insert_literature(connection, "meta-a", "literature-a")
            self._insert_literature(connection, "meta-b", "literature-b")
            self._insert_run(connection, "run-citation", "citation")
            self._insert_citation_input(connection, "run-citation")
            connection.executemany(
                "INSERT INTO citation_discovery_seeds("
                "discovery_run_id,seed_ordinal,literature_id) VALUES (?,?,?)",
                (
                    ("run-citation", 0, "literature-a"),
                    ("run-citation", 1, "literature-b"),
                ),
            )
            connection.executemany(
                "INSERT INTO discovery_run_providers("
                "discovery_run_id,provider_ordinal,provider_name,scan_limit) "
                "VALUES (?,?,?,?)",
                (
                    ("run-citation", 0, "provider-a", 10),
                    ("run-citation", 1, "provider-b", 20),
                ),
            )

            self.assertEqual(
                connection.execute(
                    "SELECT literature_id FROM citation_discovery_seeds "
                    "WHERE discovery_run_id=? ORDER BY seed_ordinal",
                    ("run-citation",),
                ).fetchall(),
                [("literature-a",), ("literature-b",)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT provider_name,scan_limit FROM discovery_run_providers "
                    "WHERE discovery_run_id=? ORDER BY provider_ordinal",
                    ("run-citation",),
                ).fetchall(),
                [("provider-a", 10), ("provider-b", 20)],
            )

            invalid_seeds = (
                ("run-citation", 0, "literature-b"),
                ("run-citation", 2, "literature-a"),
                ("run-citation", -1, "literature-b"),
                ("run-citation", 2, "missing-literature"),
                ("missing-run", 0, "literature-a"),
            )
            for values in invalid_seeds:
                with self.subTest(seed=values), self.assertRaises(sqlite3.IntegrityError):
                    connection.execute(
                        "INSERT INTO citation_discovery_seeds("
                        "discovery_run_id,seed_ordinal,literature_id) VALUES (?,?,?)",
                        values,
                    )

            invalid_providers = (
                ("run-citation", 0, "provider-c", 1),
                ("run-citation", 2, "provider-a", 1),
                ("run-citation", -1, "provider-c", 1),
                ("run-citation", 2, "   ", 1),
                ("run-citation", 2, "provider-c", 0),
                ("missing-run", 0, "provider-c", 1),
            )
            for values in invalid_providers:
                with (
                    self.subTest(provider=values),
                    self.assertRaises(sqlite3.IntegrityError),
                ):
                    connection.execute(
                        "INSERT INTO discovery_run_providers("
                        "discovery_run_id,provider_ordinal,provider_name,scan_limit) "
                        "VALUES (?,?,?,?)",
                        values,
                    )

    def test_source_results_have_three_outcomes_and_exact_failure_pairing(self) -> None:
        with self.engine.write_transaction() as connection:
            self._insert_run(connection, "run-topic", "topic")
            self._insert_topic_input(connection, "run-topic")
            connection.executemany(
                "INSERT INTO discovery_run_providers("
                "discovery_run_id,provider_ordinal,provider_name,scan_limit) "
                "VALUES (?,?,?,?)",
                (
                    ("run-topic", 0, "exhausted", 10),
                    ("run-topic", 1, "limited", 20),
                    ("run-topic", 2, "failed", 30),
                    ("run-topic", 3, "invalid", 40),
                ),
            )
            connection.executemany(
                "INSERT INTO discovery_source_results("
                "discovery_run_id,provider_name,outcome,failure_code,failure_reason,"
                "failure_action,failure_retryable) VALUES (?,?,?,?,?,?,?)",
                (
                    ("run-topic", "exhausted", "EXHAUSTED", None, None, None, None),
                    (
                        "run-topic",
                        "limited",
                        "SCAN_LIMIT_REACHED",
                        None,
                        None,
                        None,
                        None,
                    ),
                    (
                        "run-topic",
                        "failed",
                        "FAILED",
                        "provider-unavailable",
                        "Provider unavailable",
                        "Retry later",
                        1,
                    ),
                ),
            )

            invalid_results = (
                ("run-topic", "invalid", "FAILED", None, None, None, None),
                (
                    "run-topic",
                    "invalid",
                    "EXHAUSTED",
                    "unexpected",
                    "Unexpected",
                    "Do nothing",
                    0,
                ),
                ("run-topic", "invalid", "INTERRUPTED", None, None, None, None),
                (
                    "run-topic",
                    "invalid",
                    "FAILED",
                    "   ",
                    "Reason",
                    "Action",
                    0,
                ),
                (
                    "run-topic",
                    "invalid",
                    "FAILED",
                    "code",
                    "Reason",
                    "Action",
                    2,
                ),
                ("run-topic", "not-configured", "EXHAUSTED", None, None, None, None),
            )
            for values in invalid_results:
                with (
                    self.subTest(source_result=values),
                    self.assertRaises(sqlite3.IntegrityError),
                ):
                    connection.execute(
                        "INSERT INTO discovery_source_results("
                        "discovery_run_id,provider_name,outcome,failure_code,failure_reason,"
                        "failure_action,failure_retryable) VALUES (?,?,?,?,?,?,?)",
                        values,
                    )

            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO discovery_source_results("
                    "discovery_run_id,provider_name,outcome,failure_code,failure_reason,"
                    "failure_action,failure_retryable) VALUES (?,?,?,?,?,?,?)",
                    ("run-topic", "exhausted", "EXHAUSTED", None, None, None, None),
                )

    def test_topic_causes_require_a_topic_result_and_owned_actual_observation(self) -> None:
        with self.engine.write_transaction() as connection:
            self._insert_literature(connection, "meta-a", "literature-a")
            self._insert_literature(connection, "meta-b", "literature-b")
            self._insert_literature(connection, "meta-c", "literature-c")
            self._insert_owned_observation(connection, "observation-b", "literature-b")
            self._insert_run(connection, "run-topic", "topic")
            self._insert_topic_input(connection, "run-topic")
            connection.executemany(
                "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES (?,?)",
                (("run-topic", "meta-b"), ("run-topic", "meta-c")),
            )
            connection.execute(
                "INSERT INTO topic_discovery_causes("
                "discovery_run_id,meta_literature_id,metadata_observation_id,"
                "actual_literature_id) VALUES (?,?,?,?)",
                ("run-topic", "meta-b", "observation-b", "literature-b"),
            )

            actual = connection.execute(
                "SELECT cause.actual_literature_id,ownership.literature_id "
                "FROM topic_discovery_causes AS cause "
                "JOIN literature_metadata_observations AS ownership "
                "ON ownership.observation_id=cause.metadata_observation_id "
                "WHERE cause.discovery_run_id=? AND cause.meta_literature_id=?",
                ("run-topic", "meta-b"),
            ).fetchall()
            self.assertEqual(actual, [("literature-b", "literature-b")])

            self._insert_owned_observation(connection, "observation-b-2", "literature-b")
            connection.execute(
                "INSERT INTO topic_discovery_causes("
                "discovery_run_id,meta_literature_id,metadata_observation_id,"
                "actual_literature_id) VALUES (?,?,?,?)",
                ("run-topic", "meta-b", "observation-b-2", "literature-b"),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM topic_discovery_causes "
                    "WHERE discovery_run_id=? AND meta_literature_id=?",
                    ("run-topic", "meta-b"),
                ).fetchone(),
                (2,),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO topic_discovery_causes("
                    "discovery_run_id,meta_literature_id,metadata_observation_id,"
                    "actual_literature_id) VALUES (?,?,?,?)",
                    ("run-topic", "meta-b", "observation-b-2", "literature-b"),
                )

            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) "
                    "VALUES (?,?)",
                    ("run-topic", "meta-b"),
                )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) "
                    "VALUES (?,?)",
                    ("run-topic", "missing-meta"),
                )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO topic_discovery_causes("
                    "discovery_run_id,meta_literature_id,metadata_observation_id,"
                    "actual_literature_id) VALUES (?,?,?,?)",
                    ("run-topic", "meta-c", "observation-b", "literature-b"),
                )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO topic_discovery_causes("
                    "discovery_run_id,meta_literature_id,metadata_observation_id,"
                    "actual_literature_id) VALUES (?,?,?,?)",
                    ("run-topic", "meta-c", "observation-b", "literature-c"),
                )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO topic_discovery_causes("
                    "discovery_run_id,meta_literature_id,metadata_observation_id,"
                    "actual_literature_id) VALUES (?,?,?,?)",
                    ("run-topic", "meta-b", "missing-observation", "literature-b"),
                )

            connection.execute(
                "INSERT INTO provenances("
                "provenance_id,source_kind,source_name,observed_at) VALUES (?,?,?,?)",
                (
                    "unowned-provenance",
                    "metadata-provider",
                    "fixture-provider",
                    "2026-08-11T00:00:00Z",
                ),
            )
            connection.execute(
                "INSERT INTO metadata_observations(observation_id,provenance_id,title) "
                "VALUES (?,?,?)",
                ("unowned-observation", "unowned-provenance", "Unowned"),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO topic_discovery_causes("
                    "discovery_run_id,meta_literature_id,metadata_observation_id,"
                    "actual_literature_id) VALUES (?,?,?,?)",
                    ("run-topic", "meta-b", "unowned-observation", "literature-b"),
                )

            self._insert_owned_observation(connection, "observation-transfer", "literature-b")
            connection.execute(
                "INSERT INTO topic_discovery_causes("
                "discovery_run_id,meta_literature_id,metadata_observation_id,"
                "actual_literature_id) VALUES (?,?,?,?)",
                ("run-topic", "meta-b", "observation-transfer", "literature-b"),
            )

            self._insert_run(connection, "run-citation", "citation")
            self._insert_citation_input(connection, "run-citation")
            connection.execute(
                "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES (?,?)",
                ("run-citation", "meta-b"),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO topic_discovery_causes("
                    "discovery_run_id,meta_literature_id,metadata_observation_id,"
                    "actual_literature_id) VALUES (?,?,?,?)",
                    ("run-citation", "meta-b", "observation-b", "literature-b"),
                )

            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "UPDATE topic_discovery_causes SET metadata_observation_id=? "
                    "WHERE discovery_run_id=? AND metadata_observation_id=?",
                    ("observation-b-2", "run-topic", "observation-b"),
                )

        with self.assertRaises(sqlite3.IntegrityError):
            with self.engine.write_transaction() as connection:
                connection.execute(
                    "UPDATE topic_discovery_causes SET meta_literature_id=?,"
                    "actual_literature_id=? WHERE discovery_run_id=? "
                    "AND metadata_observation_id=?",
                    ("meta-c", "literature-c", "run-topic", "observation-transfer"),
                )

        with self.engine.write_transaction() as connection:
            connection.execute(
                "UPDATE literature_metadata_observations SET literature_id=? "
                "WHERE observation_id=?",
                ("literature-c", "observation-transfer"),
            )
            connection.execute(
                "UPDATE topic_discovery_causes SET meta_literature_id=?,"
                "actual_literature_id=? WHERE discovery_run_id=? "
                "AND metadata_observation_id=?",
                ("meta-c", "literature-c", "run-topic", "observation-transfer"),
            )
        with self.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT meta_literature_id,actual_literature_id "
                    "FROM topic_discovery_causes WHERE discovery_run_id=? "
                    "AND metadata_observation_id=?",
                    ("run-topic", "observation-transfer"),
                ).fetchone(),
                ("meta-c", "literature-c"),
            )

    def test_citation_causes_keep_actual_endpoints_depth_and_outlive_reference(self) -> None:
        with self.engine.write_transaction() as connection:
            self._insert_literature(connection, "meta-a", "literature-a")
            self._insert_literature(connection, "meta-b", "literature-b")
            self._insert_literature(connection, "meta-c", "literature-c")
            self._insert_literature(connection, "meta-shared", "literature-shared-a")
            self._insert_member(connection, "meta-shared", "literature-shared-b")
            self._insert_run(connection, "run-citation", "citation")
            self._insert_citation_input(connection, "run-citation")
            connection.execute(
                "INSERT INTO citation_discovery_seeds("
                "discovery_run_id,seed_ordinal,literature_id) VALUES (?,?,?)",
                ("run-citation", 0, "literature-a"),
            )
            connection.executemany(
                "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES (?,?)",
                (
                    ("run-citation", "meta-b"),
                    ("run-citation", "meta-c"),
                    ("run-citation", "meta-shared"),
                ),
            )

            connection.execute(
                "INSERT INTO provenances("
                "provenance_id,source_kind,source_name,source_record_id,observed_at) "
                "VALUES (?,?,?,?,?)",
                (
                    "relation-provenance",
                    "metadata-provider",
                    "fixture-provider",
                    "relation-1",
                    "2026-08-11T00:00:00Z",
                ),
            )
            connection.execute(
                "INSERT INTO provider_relation_observations(observation_id,provenance_id) "
                "VALUES (?,?)",
                ("relation-observation", "relation-provenance"),
            )
            connection.execute(
                "INSERT INTO literature_references("
                "reference_id,source_literature_id,target_literature_id) VALUES (?,?,?)",
                ("reference-a-b", "literature-a", "literature-b"),
            )
            connection.execute(
                "INSERT INTO provider_relation_reference_supports("
                "reference_id,observation_id) VALUES (?,?)",
                ("reference-a-b", "relation-observation"),
            )
            connection.execute(
                "INSERT INTO citation_discovery_causes("
                "discovery_run_id,meta_literature_id,source_literature_id,"
                "target_literature_id,actual_literature_id,depth) VALUES (?,?,?,?,?,?)",
                (
                    "run-citation",
                    "meta-b",
                    "literature-a",
                    "literature-b",
                    "literature-b",
                    1,
                ),
            )
            connection.execute(
                "INSERT INTO citation_discovery_causes("
                "discovery_run_id,meta_literature_id,source_literature_id,"
                "target_literature_id,actual_literature_id,depth) VALUES (?,?,?,?,?,?)",
                (
                    "run-citation",
                    "meta-b",
                    "literature-a",
                    "literature-b",
                    "literature-b",
                    2,
                ),
            )
            # Explicit actual endpoint binding remains unambiguous even when
            # both historical edge endpoints currently share the result Meta.
            connection.execute(
                "INSERT INTO citation_discovery_causes("
                "discovery_run_id,meta_literature_id,source_literature_id,"
                "target_literature_id,actual_literature_id,depth) VALUES (?,?,?,?,?,?)",
                (
                    "run-citation",
                    "meta-shared",
                    "literature-shared-a",
                    "literature-shared-b",
                    "literature-shared-b",
                    1,
                ),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT actual_literature_id FROM citation_discovery_causes "
                    "WHERE discovery_run_id=? AND meta_literature_id=?",
                    ("run-citation", "meta-shared"),
                ).fetchone(),
                ("literature-shared-b",),
            )

            actual = connection.execute(
                "SELECT cause.source_literature_id,cause.target_literature_id,cause.depth,"
                "cause.actual_literature_id "
                "FROM citation_discovery_causes AS cause "
                "WHERE cause.discovery_run_id=? AND cause.meta_literature_id=? "
                "AND cause.depth=?",
                ("run-citation", "meta-b", 1),
            ).fetchone()
            self.assertEqual(actual, ("literature-a", "literature-b", 1, "literature-b"))

            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO citation_discovery_causes("
                    "discovery_run_id,meta_literature_id,source_literature_id,"
                    "target_literature_id,actual_literature_id,depth) VALUES (?,?,?,?,?,?)",
                    (
                        "run-citation",
                        "meta-b",
                        "literature-a",
                        "literature-b",
                        "literature-b",
                        1,
                    ),
                )

            invalid_causes = (
                # The wrong result row already exists: no endpoint matching
                # that Meta must still be rejected.
                (
                    "run-citation",
                    "meta-c",
                    "literature-a",
                    "literature-b",
                    "literature-b",
                    1,
                ),
                ("run-citation", "meta-b", "literature-a", "literature-b", "literature-a", 3),
                ("run-citation", "meta-b", "literature-a", "literature-a", "literature-a", 1),
                ("run-citation", "meta-b", "literature-a", "literature-b", "literature-b", 0),
                ("run-citation", "meta-b", "missing", "literature-b", "literature-b", 1),
                ("run-citation", "meta-b", "literature-a", "missing", "literature-a", 1),
            )
            for values in invalid_causes:
                with (
                    self.subTest(citation_cause=values),
                    self.assertRaises(sqlite3.IntegrityError),
                ):
                    connection.execute(
                        "INSERT INTO citation_discovery_causes("
                        "discovery_run_id,meta_literature_id,source_literature_id,"
                        "target_literature_id,actual_literature_id,depth) VALUES (?,?,?,?,?,?)",
                        values,
                    )

            self._insert_run(connection, "run-topic", "topic")
            self._insert_topic_input(connection, "run-topic")
            connection.execute(
                "INSERT INTO discovery_results(discovery_run_id,meta_literature_id) VALUES (?,?)",
                ("run-topic", "meta-b"),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO citation_discovery_causes("
                    "discovery_run_id,meta_literature_id,source_literature_id,"
                    "target_literature_id,actual_literature_id,depth) VALUES (?,?,?,?,?,?)",
                    (
                        "run-topic",
                        "meta-b",
                        "literature-a",
                        "literature-b",
                        "literature-b",
                        1,
                    ),
                )

            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "UPDATE citation_discovery_causes SET actual_literature_id=? "
                    "WHERE discovery_run_id=? AND depth=?",
                    ("literature-a", "run-citation", 1),
                )

            connection.execute(
                "DELETE FROM provider_relation_reference_supports WHERE reference_id=?",
                ("reference-a-b",),
            )
            connection.execute(
                "DELETE FROM literature_references WHERE reference_id=?",
                ("reference-a-b",),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM citation_discovery_causes WHERE discovery_run_id=?",
                    ("run-citation",),
                ).fetchone(),
                (3,),
            )


if __name__ == "__main__":
    unittest.main()
