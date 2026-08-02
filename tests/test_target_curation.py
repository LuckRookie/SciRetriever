from __future__ import annotations

import ast
import importlib
import os
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import ModuleType

from sciretriever.core.literature.curation import CurationPlanError
from sciretriever.literature_store.filesystem import LocalAdmissionBindingFactory
from sciretriever.literature_store.sqlite import (
    SqliteCurationTransaction,
    SqliteLiteratureRepository,
    create_or_open_catalog,
    open_read_only_snapshot,
)
from sciretriever.model.primitives import (
    WorkId,
    WorkVersionId,
)
from sciretriever.services.literature.api import CurationService

UUIDS = tuple(f"d0000000-0000-4000-8000-{value:012d}" for value in range(1, 60))


def _optional_module(name: str) -> ModuleType | None:
    try:
        return importlib.import_module(name)
    except ModuleNotFoundError:
        return None


def _assert_not_exported(
    test_case: unittest.TestCase, module: ModuleType | None, names: tuple[str, ...]
) -> None:
    if module is None:
        return
    exported = getattr(module, "__all__", ())
    for name in names:
        test_case.assertNotIn(name, vars(module))
        test_case.assertNotIn(name, exported)


def _assert_model_contract_ownership(
    test_case: unittest.TestCase, contract_names: tuple[str, ...]
) -> None:
    target_module = importlib.import_module("sciretriever.model.library")
    legacy_module = _optional_module("sciretriever.bibliography.model")
    for name in contract_names:
        if not hasattr(target_module, name):
            test_case.fail(f"target Model is missing migrated contract {name}")
        target = getattr(target_module, name)
        test_case.assertEqual(target.__module__, target_module.__name__)
        if legacy_module is not None:
            test_case.assertNotIn(name, legacy_module.__dict__)
    for facade_name in (
        "sciretriever.bibliography",
        "sciretriever.bibliography.api",
        "sciretriever.bibliography.curation",
    ):
        _assert_not_exported(test_case, _optional_module(facade_name), contract_names)
    if legacy_module is None:
        return
    legacy_file = legacy_module.__file__
    test_case.assertIsNotNone(legacy_file)
    assert legacy_file is not None
    legacy_path = Path(legacy_file)
    legacy_tree = ast.parse(legacy_path.read_text(encoding="utf-8"))
    legacy_definitions = {
        node.name
        for node in ast.walk(legacy_tree)
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
    }
    test_case.assertTrue(legacy_definitions.isdisjoint(contract_names))


def _assert_core_factory_ownership(
    test_case: unittest.TestCase, factory_names: tuple[str, ...]
) -> None:
    try:
        core_module = importlib.import_module("sciretriever.core.literature.curation")
    except ModuleNotFoundError as error:
        test_case.fail(f"target Core curation module is absent: {error.name}")
    legacy_plans = _optional_module("sciretriever.bibliography.curation_plans")
    for name in factory_names:
        if not hasattr(core_module, name):
            test_case.fail(f"target Core is missing migrated plan factory {name}")
        factory = getattr(core_module, name)
        test_case.assertEqual(factory.__module__, core_module.__name__)
        if legacy_plans is not None:
            test_case.assertNotIn(name, legacy_plans.__dict__)
    for facade_name in ("sciretriever.bibliography.api", "sciretriever.bibliography.curation"):
        _assert_not_exported(test_case, _optional_module(facade_name), factory_names)


class TargetCurationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-task13-")
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)
        self.catalog = self.root / "catalog.sqlite"
        with create_or_open_catalog(self.catalog):
            pass
        factory = LocalAdmissionBindingFactory()
        self.bound = factory.bind_catalog(self.catalog)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def service(self, checkpoint=None) -> CurationService:
        return CurationService(
            SqliteLiteratureRepository(self.catalog),
            SqliteCurationTransaction(self.catalog, checkpoint),
            lambda: self.bound.port.acquire_core_write(self.bound.identity),
        )

    def test_curation_contracts_and_plan_factories_have_target_ownership(self) -> None:
        _assert_model_contract_ownership(
            self,
            (
                "VersionMove",
                "ObservationMove",
                "IdentifierMove",
                "MembershipMove",
                "ReferenceRetarget",
                "RelationRetarget",
                "RelationDelete",
                "RepresentativeUpdate",
                "ValidatedVersionRelation",
                "ValidatedCurationPlan",
            ),
        )
        _assert_core_factory_ownership(
            self,
            (
                "same_version_plan",
                "related_versions_plan",
                "distinct_plan",
                "delete_version_plan",
                "delete_work_plan",
            ),
        )

    def seed(self) -> tuple[WorkId, WorkVersionId, WorkId, WorkVersionId, WorkVersionId]:
        left_work, right_work = WorkId(UUIDS[0]), WorkId(UUIDS[1])
        left, right, sibling = (
            WorkVersionId(UUIDS[2]),
            WorkVersionId(UUIDS[3]),
            WorkVersionId(UUIDS[4]),
        )
        with create_or_open_catalog(self.catalog) as connection:
            connection.executemany(
                "INSERT INTO works(id) VALUES(?)", ((str(left_work),), (str(right_work),))
            )
            connection.executemany(
                "INSERT INTO work_versions(id,work_id,version_role) VALUES(?,?,?)",
                (
                    (str(left), str(left_work), "formal"),
                    (str(right), str(right_work), "preprint"),
                    (str(sibling), str(right_work), "accepted-manuscript"),
                ),
            )
            connection.executemany(
                "INSERT INTO work_representative_versions(work_id,work_version_id) VALUES(?,?)",
                ((str(left_work), str(left)), (str(right_work), str(sibling))),
            )
            connection.executemany(
                "INSERT INTO stable_identifiers(id,work_version_id,namespace,value) "
                "VALUES(?,?,?,?)",
                ((UUIDS[5], str(left), "doi", "10.1/shared"), (UUIDS[6], str(right), "pmid", "22")),
            )
            connection.execute(
                "INSERT INTO metadata_observations"
                "(id,work_version_id,provider,provider_record_id,payload_sha256,payload_json,"
                "observed_at) VALUES(?,?,?,?,?,?,?)",
                (
                    UUIDS[7],
                    str(right),
                    "provider",
                    "record",
                    "a" * 64,
                    "{}",
                    "2026-07-31T00:00:00Z",
                ),
            )
            connection.execute(
                "INSERT INTO collections(id,name) VALUES(?,'collection')", (UUIDS[8],)
            )
            connection.execute(
                "INSERT INTO collection_runs(id,collection_id,mode,topic_conditions_json,"
                "requested_advance_to,status) VALUES(?,?,'topic','{}','completed','completed')",
                (UUIDS[9], UUIDS[8]),
            )
            for membership_id, work_id in ((UUIDS[10], left_work), (UUIDS[11], right_work)):
                connection.execute(
                    "INSERT INTO collection_memberships"
                    "(id,collection_id,work_id,first_collection_run_id) VALUES(?,?,?,?)",
                    (membership_id, UUIDS[8], str(work_id), UUIDS[9]),
                )
            connection.execute(
                "INSERT INTO collection_causes"
                "(id,membership_id,collection_run_id,kind,source) "
                "VALUES(?,?,?,'seed','source')",
                (UUIDS[12], UUIDS[11], UUIDS[9]),
            )
            connection.execute(
                "INSERT INTO collection_paths"
                "(id,membership_id,collection_run_id,direction,depth,work_ids_json) "
                "VALUES(?,?,?,'references',1,'[]')",
                (UUIDS[13], UUIDS[11], UUIDS[9]),
            )
            connection.execute(
                "INSERT INTO reference_sets(id,work_version_id,revision,complete) VALUES(?,?,1,1)",
                (UUIDS[14], str(left)),
            )
            connection.execute(
                "INSERT INTO reference_members"
                "(id,reference_set_id,ordinal,target_work_id,target_work_version_id,"
                "reference_json) "
                "VALUES(?,?,?,?,?,?)",
                (
                    UUIDS[15],
                    UUIDS[14],
                    0,
                    str(right_work),
                    str(right),
                    '{"raw_text":"raw evidence"}',
                ),
            )
            connection.commit()
        return left_work, left, right_work, right, sibling

    def topology(self) -> tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]]:
        with open_read_only_snapshot(self.catalog) as connection:
            versions = tuple(
                row[0] + ":" + row[1]
                for row in connection.execute("SELECT id,work_id FROM work_versions ORDER BY id")
            )
            memberships = tuple(
                row[0] + ":" + row[1]
                for row in connection.execute(
                    "SELECT id,work_id FROM collection_memberships ORDER BY id"
                )
            )
            references = tuple(
                str(row)
                for row in connection.execute(
                    "SELECT target_work_id,target_work_version_id "
                    "FROM reference_members ORDER BY id"
                )
            )
        return versions, memberships, references

    def test_same_version_transfers_complete_topology_and_deletes_empty_loser(self) -> None:
        left_work, left, right_work, right, sibling = self.seed()

        self.service().same_version(left, right, left)

        with open_read_only_snapshot(self.catalog) as connection:
            self.assertIsNone(
                connection.execute("SELECT 1 FROM works WHERE id=?", (str(right_work),)).fetchone()
            )
            self.assertEqual(
                connection.execute(
                    "SELECT work_id FROM work_versions WHERE id=?", (str(sibling),)
                ).fetchone(),
                (str(left_work),),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT work_version_id FROM metadata_observations WHERE id=?", (UUIDS[7],)
                ).fetchone(),
                (str(left),),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT work_version_id FROM stable_identifiers WHERE id=?", (UUIDS[6],)
                ).fetchone(),
                (str(left),),
            )
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM collection_memberships").fetchone(), (1,)
            )
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM collection_causes").fetchone(), (1,)
            )
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM collection_paths").fetchone(), (1,)
            )
            self.assertEqual(
                connection.execute(
                    "SELECT target_work_id,target_work_version_id FROM reference_members"
                ).fetchone(),
                (str(left_work), str(left)),
            )

    def test_related_versions_keeps_both_and_chooses_role_priority_representative(self) -> None:
        left_work, left, _, right, sibling = self.seed()

        self.service().related_versions(left, right, left_work)

        with open_read_only_snapshot(self.catalog) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM work_versions WHERE work_id=?", (str(left_work),)
                ).fetchone(),
                (3,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT work_version_id FROM work_representative_versions WHERE work_id=?",
                    (str(left_work),),
                ).fetchone(),
                (str(left),),
            )
            self.assertEqual(
                connection.execute("SELECT relation FROM work_version_relations").fetchone(),
                ("related-versions",),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT work_id FROM work_versions WHERE id=?", (str(sibling),)
                ).fetchone(),
                (str(left_work),),
            )

    def test_related_versions_reverse_replay_is_idempotent_after_work_merge(self) -> None:
        left_work, left, _, right, _ = self.seed()
        service = self.service()
        service.related_versions(left, right, left_work)

        service.related_versions(right, left, left_work)

        with open_read_only_snapshot(self.catalog) as connection:
            rows = connection.execute(
                "SELECT left_version_id,right_version_id,relation FROM work_version_relations"
            ).fetchall()
        self.assertEqual(rows, [(str(left), str(right), "related-versions")])

    def test_delete_version_rejects_last_and_work_delete_downgrades_inbound_evidence(self) -> None:
        left_work, left, right_work, _, _ = self.seed()
        with self.assertRaises(CurationPlanError):
            self.service().delete_work_version(left)

        self.service().delete_work(right_work)

        with open_read_only_snapshot(self.catalog) as connection:
            self.assertIsNone(
                connection.execute("SELECT 1 FROM works WHERE id=?", (str(right_work),)).fetchone()
            )
            self.assertEqual(
                connection.execute(
                    "SELECT raw_text,reference_json FROM unresolved_references"
                ).fetchone(),
                ("raw evidence", '{"raw_text":"raw evidence"}'),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT work_version_id FROM work_representative_versions WHERE work_id=?",
                    (str(left_work),),
                ).fetchone(),
                (str(left),),
            )

    def test_work_delete_removes_only_unshared_artifact_registrations(self) -> None:
        left_work, left, right_work, right, _ = self.seed()
        with create_or_open_catalog(self.catalog) as connection:
            connection.executemany(
                "INSERT INTO artifacts(id,kind,sha256,storage_path,byte_size) "
                "VALUES(?,'raw',?,?,1)",
                (
                    (UUIDS[20], "1" * 64, "primary/11/" + "1" * 64),
                    (UUIDS[21], "2" * 64, "primary/22/" + "2" * 64),
                ),
            )
            connection.executemany(
                "INSERT INTO raw_assets(artifact_id,asset_role,source_json) "
                "VALUES(?,'supplementary','{}')",
                ((UUIDS[20],), (UUIDS[21],)),
            )
            connection.executemany(
                "INSERT INTO work_version_assets(id,work_version_id,artifact_id,role) "
                "VALUES(?,?,?,'supplementary')",
                (
                    (UUIDS[22], str(left), UUIDS[20]),
                    (UUIDS[23], str(right), UUIDS[20]),
                    (UUIDS[24], str(right), UUIDS[21]),
                ),
            )
            connection.commit()

        self.service().delete_work(right_work)

        with open_read_only_snapshot(self.catalog) as connection:
            self.assertEqual(
                connection.execute("SELECT id FROM artifacts ORDER BY id").fetchall(),
                [(UUIDS[20],)],
            )
            self.assertEqual(
                connection.execute("SELECT artifact_id FROM raw_assets").fetchall(), [(UUIDS[20],)]
            )
            self.assertEqual(
                connection.execute("SELECT work_version_id FROM work_version_assets").fetchall(),
                [(str(left),)],
            )
            self.assertIsNotNone(
                connection.execute("SELECT 1 FROM works WHERE id=?", (str(left_work),)).fetchone()
            )

    def test_same_version_rebuilds_all_fts_rows_from_authoritative_current_facts(self) -> None:
        _, left, _, right, _ = self.seed()
        with create_or_open_catalog(self.catalog) as connection:
            metadata_hash = connection.execute(
                "SELECT sciretriever_metadata_sha256(1,'{\"title\":\"kept\"}','{}')"
            ).fetchone()[0]
            light_hash = connection.execute(
                'SELECT sciretriever_sha256(\'{"body":"light"}\')'
            ).fetchone()[0]
            analysis_hash = connection.execute(
                'SELECT sciretriever_sha256(\'{"summary":"analysis"}\')'
            ).fetchone()[0]
            connection.execute(
                "INSERT INTO metadata_snapshots VALUES(?,?,1,?,'{\"title\":\"kept\"}','{}')",
                (UUIDS[25], str(left), metadata_hash),
            )
            connection.execute(
                "INSERT INTO work_version_current_metadata VALUES(?,?)", (str(left), UUIDS[25])
            )
            connection.execute(
                "INSERT INTO artifacts VALUES(?, 'raw', ?, 'primary/44/value', 1, NULL)",
                (UUIDS[26], "4" * 64),
            )
            connection.execute("INSERT INTO raw_assets VALUES(?,'primary-pdf','{}')", (UUIDS[26],))
            connection.execute(
                "INSERT INTO work_version_assets VALUES(?,?,?,'primary-pdf')",
                (UUIDS[27], str(left), UUIDS[26]),
            )
            connection.execute(
                "INSERT INTO accepted_primary_assets VALUES(?,?)", (str(left), UUIDS[27])
            )
            connection.execute(
                "INSERT INTO artifacts VALUES(?, 'light-document', ?, 'light/55/value', ?, NULL)",
                (UUIDS[28], light_hash, len('{"body":"light"}')),
            )
            connection.execute(
                "INSERT INTO light_documents VALUES(?,?,?,?,?,'{\"body\":\"light\"}','{}',1)",
                (UUIDS[29], str(left), UUIDS[27], UUIDS[28], light_hash),
            )
            connection.execute(
                "INSERT INTO work_version_current_light_document VALUES(?,?)",
                (str(left), UUIDS[29]),
            )
            connection.execute(
                "INSERT INTO artifacts VALUES(?, 'analysis', ?, 'analysis/66/value', ?, NULL)",
                (UUIDS[30], analysis_hash, len('{"summary":"analysis"}')),
            )
            connection.execute(
                "INSERT INTO analysis_artifacts "
                "VALUES(?,?,?,?,?,?,'{\"summary\":\"analysis\"}','{}',1)",
                (UUIDS[31], str(left), UUIDS[29], UUIDS[30], analysis_hash, light_hash),
            )
            reference_set_id = connection.execute(
                "SELECT id FROM reference_sets WHERE work_version_id=?", (str(left),)
            ).fetchone()[0]
            connection.execute("INSERT INTO tag_sets VALUES(?,?,1,1)", (UUIDS[33], str(left)))
            connection.execute(
                "INSERT INTO completion_bundles(work_version_id,light_document_id,"
                "analysis_artifact_id,metadata_snapshot_id,reference_set_id,tag_set_id,"
                "identity_sha256) VALUES(?,?,?,?,?,?,?)",
                (str(left), UUIDS[29], UUIDS[31], UUIDS[25], reference_set_id, UUIDS[33], "a" * 64),
            )
            for table in ("metadata_fts", "light_text_fts", "analysis_fts"):
                connection.execute(
                    f"INSERT INTO {table}(work_version_id,content) VALUES(?,'stale')", (str(left),)
                )
            connection.commit()

        self.service().same_version(left, right, left)

        with open_read_only_snapshot(self.catalog) as connection:
            self.assertEqual(
                connection.execute("SELECT content FROM metadata_fts").fetchone(),
                ('{"title":"kept"}',),
            )
            self.assertEqual(
                connection.execute("SELECT content FROM light_text_fts").fetchone(),
                ('{"body":"light"}',),
            )
            self.assertEqual(
                connection.execute("SELECT content FROM analysis_fts").fetchone(),
                ('{"summary":"analysis"}',),
            )

    def test_failpoints_leave_second_connection_on_complete_old_topology(self) -> None:
        for checkpoint in (
            "observations",
            "identifiers",
            "memberships",
            "references",
            "relations",
            "versions",
            "representatives",
            "deletes",
            "artifact-registrations",
            "fts",
        ):
            with self.subTest(checkpoint=checkpoint):
                self.tearDown()
                self.setUp()
                _, left, _, right, _ = self.seed()
                old = self.topology()

                def fail(name: str) -> None:
                    if name == checkpoint:
                        raise RuntimeError(checkpoint)

                with self.assertRaises(RuntimeError):
                    self.service(fail).same_version(left, right, left)
                self.assertEqual(self.topology(), old)

    def test_subprocess_crash_at_each_mutation_keeps_old_topology(self) -> None:
        for checkpoint in (
            "observations",
            "identifiers",
            "memberships",
            "references",
            "relations",
            "versions",
            "representatives",
            "deletes",
            "artifact-registrations",
            "fts",
        ):
            with self.subTest(checkpoint=checkpoint):
                self.tearDown()
                self.setUp()
                _, left, _, right, _ = self.seed()
                old = self.topology()
                script = f"""
import os
from sciretriever.model.primitives import WorkVersionId
from sciretriever.literature_store.filesystem import LocalAdmissionBindingFactory
from sciretriever.literature_store.sqlite import (
    SqliteLiteratureRepository,
    SqliteCurationTransaction,
)
from sciretriever.services.literature.api import CurationService
catalog = {str(self.catalog)!r}
factory = LocalAdmissionBindingFactory()
bound = factory.bind_catalog(catalog)
def crash(name):
    if name == {checkpoint!r}:
        os._exit(91)
service = CurationService(
    SqliteLiteratureRepository(catalog),
    SqliteCurationTransaction(catalog, crash),
    lambda: bound.port.acquire_core_write(bound.identity),
)
service.same_version(
    WorkVersionId({str(left)!r}),
    WorkVersionId({str(right)!r}),
    WorkVersionId({str(left)!r}),
)
"""
                result = subprocess.run((sys.executable, "-c", script), check=False)
                self.assertEqual(result.returncode, 91)
                self.assertEqual(self.topology(), old)


if __name__ == "__main__":
    unittest.main()
