from __future__ import annotations

import json
from typing import TYPE_CHECKING
from uuid import uuid4

from sciretriever.catalog.curation import (
    CurationBoundaryError,
    CurationOperationOwner,
    CurationRequest,
    CurationStaleError,
)
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.review_curation import ReviewResolutionHandler
from sciretriever.catalog.work_curation import (
    WorkCurationConflictError,
    WorkMergeHandler,
    WorkVersionRegroupHandler,
)
from sciretriever.core.curation import ReviewDecision
from sciretriever.core.snapshots import SafeSnapshot


if TYPE_CHECKING:
    import unittest

    class _TestCase(unittest.TestCase):
        catalog: CatalogEngine
        work_a: str
        work_b: str
        preprint: str
else:
    class _TestCase:
        pass


class WorkCurationStaleTests(_TestCase):
    catalog: CatalogEngine
    work_a: str
    work_b: str
    preprint: str

    def request(
        self,
        handler: WorkMergeHandler | WorkVersionRegroupHandler | ReviewResolutionHandler,
    ) -> CurationRequest:
        return CurationRequest(
            handler=handler,
            review_decision=ReviewDecision.CONFIRMED,
            evidence=SafeSnapshot.from_pairs((("decision", "user_confirmed"),)),
            operation_id=handler.operation_id,
        )

    def _database_state(self) -> bytes:
        with self.catalog.connect() as connection:
            values = {
                table: [list(row) for row in connection.exec_driver_sql(
                    f"SELECT * FROM {table} ORDER BY 1"
                ).all()]
                for table in (
                    "works", "work_versions", "identity_reviews",
                    "work_merge_lineage", "curation_operations",
                )
            }
        return json.dumps(
            values, ensure_ascii=True, separators=(",", ":"), sort_keys=True
        ).encode("ascii")

    def _insert_review(self) -> str:
        review_id = str(uuid4())
        payload = json.dumps(sorted((self.work_a, self.work_b)), separators=(",", ":"))
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO identity_reviews "
                "(id,identifiers_json,candidate_work_ids_json,reason) "
                "VALUES (?,'[]',?,'identifier_conflict')",
                (review_id, payload),
            )
        return review_id

    def test_review_resolution_rejects_intervening_resolution_without_writes(self) -> None:
        review_id = self._insert_review()
        handler = ReviewResolutionHandler.load(
            self.catalog, review_id, ReviewDecision.CONFIRMED
        )
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "UPDATE identity_reviews SET state='resolved',decision='rejected',"
                "updated_at='2026-07-25T01:02:03.000Z',"
                "resolved_at='2026-07-25T01:02:03.000Z' WHERE id=?",
                (review_id,),
            )
        before = self._database_state()

        with self.assertRaises(CurationStaleError):
            CurationOperationOwner(self.catalog).apply(self.request(handler))

        self.assertEqual(self._database_state(), before)

    def test_merge_rejects_intervening_source_version_without_writes(self) -> None:
        handler = WorkMergeHandler.load(self.catalog, self.work_a, self.work_b)
        added_version = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO work_versions "
                "(id,work_id,version_class,normalized_title,title,stable_version_key) "
                "VALUES (?,?,'accepted_manuscript','paper','Paper','accepted')",
                (added_version, self.work_a),
            )
        before = self._database_state()

        with self.assertRaises(CurationStaleError):
            CurationOperationOwner(self.catalog).apply(self.request(handler))

        self.assertEqual(self._database_state(), before)

    def test_merge_rejects_intervening_review_candidate_link_without_writes(self) -> None:
        review_id = self._insert_review()
        handler = WorkMergeHandler.load(self.catalog, self.work_a, self.work_b)
        third_work = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("INSERT INTO works (id) VALUES (?)", (third_work,))
            payload = json.dumps(
                sorted((self.work_a, self.work_b, third_work)), separators=(",", ":")
            )
            connection.exec_driver_sql(
                "UPDATE identity_reviews SET candidate_work_ids_json=? WHERE id=?",
                (payload, review_id),
            )
        before = self._database_state()

        with self.assertRaises(CurationStaleError):
            CurationOperationOwner(self.catalog).apply(self.request(handler))

        self.assertEqual(self._database_state(), before)

    def test_regroup_rejects_intervening_preferred_change_without_writes(self) -> None:
        handler = WorkVersionRegroupHandler.load(self.catalog, self.preprint, self.work_b)
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "UPDATE works SET preferred_work_version_id=?,"
                "preferred_version_is_manual=1 WHERE id=?",
                (self.preprint, self.work_a),
            )
        before = self._database_state()

        with self.assertRaises(CurationStaleError):
            CurationOperationOwner(self.catalog).apply(self.request(handler))

        self.assertEqual(self._database_state(), before)

    def test_merge_request_requires_the_handler_operation_id(self) -> None:
        handler = WorkMergeHandler.load(self.catalog, self.work_a, self.work_b)
        evidence = SafeSnapshot.from_pairs((("decision", "user_confirmed"),))

        with self.assertRaises(CurationBoundaryError):
            CurationRequest(handler, ReviewDecision.CONFIRMED, evidence)
        with self.assertRaises(CurationBoundaryError):
            CurationRequest(handler, ReviewDecision.CONFIRMED, evidence, str(uuid4()))

        before = self._database_state()
        self.assertEqual(self._database_state(), before)

    def test_merge_lineage_operation_id_equals_audit_id(self) -> None:
        handler = WorkMergeHandler.load(self.catalog, self.work_a, self.work_b)

        applied = CurationOperationOwner(self.catalog).apply(self.request(handler))

        with self.catalog.connect() as connection:
            lineage_id = connection.exec_driver_sql(
                "SELECT operation_id FROM work_merge_lineage WHERE source_work_id=?",
                (self.work_a,),
            ).scalar_one()
        self.assertEqual(lineage_id, applied.id)

    def test_merge_rejects_malformed_candidate_lists_without_writes(self) -> None:
        descending = tuple(sorted((self.work_a, self.work_b), reverse=True))
        malformed = (
            "{}", "[1]", f'["{self.work_a}","{self.work_a}"]',
            json.dumps(descending, separators=(",", ":")), f'[ "{self.work_a}"]',
            '["not-a-uuid"]', '{"items":[],"items":[]}',
        )
        for payload in malformed:
            with self.subTest(payload=payload):
                review_id = str(uuid4())
                with self.catalog.transaction() as connection:
                    connection.exec_driver_sql("DELETE FROM identity_reviews")
                    connection.exec_driver_sql("PRAGMA ignore_check_constraints=ON")
                    connection.exec_driver_sql(
                        "INSERT INTO identity_reviews "
                        "(id,identifiers_json,candidate_work_ids_json,reason) "
                        "VALUES (?,'[]',?,'identifier_conflict')",
                        (review_id, payload),
                    )
                    connection.exec_driver_sql("PRAGMA ignore_check_constraints=OFF")
                before = self._database_state()

                with self.assertRaises(WorkCurationConflictError):
                    WorkMergeHandler.load(self.catalog, self.work_a, self.work_b)

                self.assertEqual(self._database_state(), before)


__all__ = ("WorkCurationStaleTests",)
