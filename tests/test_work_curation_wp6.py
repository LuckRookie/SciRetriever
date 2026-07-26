from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from sciretriever.catalog import create_catalog_engine, initialize_catalog
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.review_curation import ReviewQuery, ReviewRepository, ReviewResolutionHandler
from sciretriever.catalog.work_curation import (
    WorkCurationConflictError,
    WorkMergeHandler,
    WorkVersionRegroupHandler,
)
from sciretriever.catalog.curation import CurationOperationOwner, CurationRequest, CurationStaleError
from sciretriever.core.curation import ReviewDecision
from sciretriever.core.snapshots import SafeSnapshot
from work_curation_failpoint_cases import WorkCurationFailpointTests
from work_curation_stale_cases import WorkCurationStaleTests


class WorkCurationBaselineTests(unittest.TestCase):
    catalog: CatalogEngine
    temporary: TemporaryDirectory[str]
    work_a: str
    work_b: str
    preprint: str
    formal: str

    def setUp(self) -> None:
        workspace_guard = patch("sciretriever.catalog.engine.require_staged_write_override")
        workspace_guard.start()
        self.addCleanup(workspace_guard.stop)
        self.temporary = TemporaryDirectory(prefix="sciretriever-work-curation-wp6-")
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary.name) / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        self.work_a, self.work_b = str(uuid4()), str(uuid4())
        self.preprint, self.formal = str(uuid4()), str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("INSERT INTO works (id) VALUES (?),(?)", (self.work_a, self.work_b))
            connection.exec_driver_sql(
                "INSERT INTO work_versions "
                "(id,work_id,version_class,normalized_title,title,stable_version_key) VALUES "
                "(?,?,'preprint','paper','Paper','preprint'),"
                "(?,?,'formal_publication','paper','Paper','formal')",
                (self.preprint, self.work_a, self.formal, self.work_b),
            )

    def test_current_identity_keeps_distinct_versions_and_identifiers(self) -> None:
        identifier_a, identifier_b = str(uuid4()), str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO work_version_identifiers (id,work_version_id,namespace,value) "
                "VALUES (?,?,'doi','10.1/preprint'),(?,?,'doi','10.1/formal')",
                (identifier_a, self.preprint, identifier_b, self.formal),
            )

        with self.catalog.connect() as connection:
            topology = connection.exec_driver_sql(
                "SELECT wv.id,wv.work_id,wvi.value FROM work_versions wv "
                "JOIN work_version_identifiers wvi ON wvi.work_version_id=wv.id ORDER BY wvi.value"
            ).all()

        self.assertEqual(topology, [(self.formal, self.work_b, "10.1/formal"), (self.preprint, self.work_a, "10.1/preprint")])

    def test_current_preferred_recomputation_selects_formal_version(self) -> None:
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("UPDATE work_versions SET work_id=? WHERE id=?", (self.work_a, self.formal))
            from sciretriever.catalog.work_curation_state import recompute_preferred

            recompute_preferred(connection, self.work_a)

        with self.catalog.connect() as connection:
            preferred = connection.exec_driver_sql(
                "SELECT preferred_work_version_id FROM works WHERE id=?", (self.work_a,)
            ).scalar_one()

        self.assertEqual(preferred, self.formal)

    def test_evidentiary_rows_remain_owned_by_exact_version(self) -> None:
        observation_id = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO metadata_observations "
                "(id,work_version_id,provider,provider_record_id,field_name,value_json,provenance_json) "
                "VALUES (?,?,'fixture','record','title','\"Paper\"','{}')",
                (observation_id, self.preprint),
            )

        with self.catalog.connect() as connection:
            observation_owner = connection.exec_driver_sql(
                "SELECT work_version_id FROM metadata_observations WHERE id=?", (observation_id,)
            ).scalar_one()
            version_owned = {
                table: {
                    (str(row[2]), str(row[3]))
                    for row in connection.exec_driver_sql(f"PRAGMA foreign_key_list('{table}')")
                }
                for table in ("work_version_assets", "current_analyses", "package_versions")
            }

        self.assertEqual(observation_owner, self.preprint)
        self.assertTrue(all(("work_versions", "work_version_id") in links for links in version_owned.values()))


class WorkCurationOperationTests(
    WorkCurationStaleTests,
    WorkCurationBaselineTests,
):
    def request(self, handler: WorkMergeHandler | WorkVersionRegroupHandler | ReviewResolutionHandler) -> CurationRequest:
        return CurationRequest(
            handler=handler,
            review_decision=ReviewDecision.CONFIRMED,
            evidence=SafeSnapshot.from_pairs((("decision", "user_confirmed"),)),
            operation_id=handler.operation_id,
        )

    def test_merge_and_undo_restore_exact_topology_and_preferred(self) -> None:
        handler = WorkMergeHandler.load(self.catalog, self.work_a, self.work_b)
        owner = CurationOperationOwner(self.catalog)

        applied = owner.apply(self.request(handler))

        with self.catalog.connect() as connection:
            merged = connection.exec_driver_sql(
                "SELECT status,merged_into_work_id,preferred_work_version_id FROM works WHERE id=?",
                (self.work_a,),
            ).one()
            owners = connection.exec_driver_sql("SELECT work_id FROM work_versions ORDER BY id").scalars().all()
        self.assertEqual(merged, ("merged", self.work_b, None))
        self.assertEqual(owners, [self.work_b, self.work_b])
        self.assertNotEqual(applied.before_sha256, applied.after_sha256)

        owner.undo(applied.id, handler)

        with self.catalog.connect() as connection:
            restored = connection.exec_driver_sql(
                "SELECT id,work_id FROM work_versions ORDER BY id"
            ).all()
            source = connection.exec_driver_sql(
                "SELECT status,merged_into_work_id FROM works WHERE id=?", (self.work_a,)
            ).one()
        self.assertEqual(set(restored), {(self.preprint, self.work_a), (self.formal, self.work_b)})
        self.assertEqual(source, ("active", None))
        with self.assertRaisesRegex(WorkCurationConflictError, "merge_cycle"):
            WorkMergeHandler.load(self.catalog, self.work_b, self.work_a)

    def test_regroup_and_undo_transfer_only_explicit_version(self) -> None:
        handler = WorkVersionRegroupHandler.load(self.catalog, self.preprint, self.work_b)
        owner = CurationOperationOwner(self.catalog)

        applied = owner.apply(self.request(handler))
        with self.catalog.connect() as connection:
            self.assertEqual(
                connection.exec_driver_sql("SELECT work_id FROM work_versions WHERE id=?", (self.preprint,)).scalar_one(),
                self.work_b,
            )

        owner.undo(applied.id, handler)
        with self.catalog.connect() as connection:
            self.assertEqual(
                connection.exec_driver_sql("SELECT work_id FROM work_versions WHERE id=?", (self.preprint,)).scalar_one(),
                self.work_a,
            )

    def test_review_query_resolution_and_undo_are_audited(self) -> None:
        review_id = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO identity_reviews "
                "(id,identifiers_json,candidate_work_ids_json,reason) VALUES (?,?,?,'identifier_conflict')",
                (review_id, '[{"namespace":"doi","value":"10.1/conflict"}]', f'["{self.work_a}","{self.work_b}"]'),
            )
        repository = ReviewRepository(self.catalog)
        pending = repository.query(ReviewQuery(state="pending", limit=10))
        self.assertEqual(tuple(item.id for item in pending), (review_id,))
        handler = ReviewResolutionHandler.load(self.catalog, review_id, ReviewDecision.REJECTED)
        owner = CurationOperationOwner(self.catalog)

        applied = owner.apply(self.request(handler))
        self.assertEqual(repository.query(ReviewQuery(state="resolved", limit=10))[0].decision, "rejected")

        owner.undo(applied.id, handler)
        self.assertEqual(repository.query(ReviewQuery(state="pending", limit=10))[0].id, review_id)

    def test_every_review_apply_and_undo_failpoint_rolls_back(self) -> None:
        review_id = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO identity_reviews (id,identifiers_json,candidate_work_ids_json,reason) "
                "VALUES (?,'[]','[]','general_review')", (review_id,),
            )
        handler = ReviewResolutionHandler.load(self.catalog, review_id, ReviewDecision.CONFIRMED)
        request = self.request(handler)

        def state() -> tuple[tuple[str, str | None], int]:
            with self.catalog.connect() as connection:
                row = connection.exec_driver_sql("SELECT state,decision FROM identity_reviews WHERE id=?", (review_id,)).one()
                count = connection.exec_driver_sql("SELECT count(*) FROM curation_operations").scalar_one()
            return (str(row[0]), row[1]), int(count)

        for point in CurationOperationOwner.apply_failpoints(handler):
            before = state()
            def inject(seen: str, expected: str = point) -> None:
                if seen == expected:
                    raise RuntimeError(expected)
            with self.assertRaises(RuntimeError):
                CurationOperationOwner(self.catalog, test_failpoint=inject).apply(request)
            self.assertEqual(state(), before)
        owner = CurationOperationOwner(self.catalog)
        applied = owner.apply(request)
        for point in CurationOperationOwner.undo_failpoints(handler):
            before = state()
            def inject(seen: str, expected: str = point) -> None:
                if seen == expected:
                    raise RuntimeError(expected)
            with self.assertRaises(RuntimeError):
                CurationOperationOwner(self.catalog, test_failpoint=inject).undo(applied.id, handler)
            self.assertEqual(state(), before)

    def test_self_conflict_unknown_and_no_change_reject_without_writes(self) -> None:
        with self.assertRaises(WorkCurationConflictError):
            WorkMergeHandler.load(self.catalog, self.work_a, self.work_a)
        with self.assertRaises(WorkCurationConflictError):
            WorkVersionRegroupHandler.load(self.catalog, self.preprint, self.work_a)
        with self.assertRaises(WorkCurationConflictError):
            WorkMergeHandler.load(self.catalog, str(uuid4()), self.work_a)

    def test_conflicting_doi_and_stale_undo_reject_with_zero_compensation(self) -> None:
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO identifiers (id,work_id,namespace,value) VALUES "
                "(?,?,'doi','10.1/a'),(?,?,'doi','10.1/b')",
                (str(uuid4()), self.work_a, str(uuid4()), self.work_b),
            )
        with self.assertRaises(WorkCurationConflictError):
            WorkMergeHandler.load(self.catalog, self.work_a, self.work_b)

        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("DELETE FROM identifiers")
        handler = WorkVersionRegroupHandler.load(self.catalog, self.preprint, self.work_b)
        owner = CurationOperationOwner(self.catalog)
        applied = owner.apply(self.request(handler))
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("UPDATE works SET needs_review=1 WHERE id=?", (self.work_b,))
        with self.assertRaises(CurationStaleError):
            owner.undo(applied.id, handler)


if __name__ == "__main__":
    unittest.main()
