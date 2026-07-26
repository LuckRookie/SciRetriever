from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from sciretriever.catalog import WorkRepository, create_catalog_engine, initialize_catalog
from sciretriever.catalog.curation import (
    CurationNoChangeError,
    CurationOperationOwner,
    CurationRequest,
    CurationStaleError,
)
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.preferred_curation import (
    PreferredClearHandler,
    PreferredCurationConflictError,
    PreferredSetHandler,
)
from sciretriever.core.curation import ReviewDecision
from sciretriever.core.snapshots import SafeSnapshot


class PreferredSelectionCharacterizationTests(unittest.TestCase):
    catalog: CatalogEngine
    temporary: TemporaryDirectory[str]
    works: WorkRepository

    def setUp(self) -> None:
        workspace_guard = patch("sciretriever.catalog.engine.require_staged_write_override")
        workspace_guard.start()
        self.addCleanup(workspace_guard.stop)
        self.temporary = TemporaryDirectory(prefix="sciretriever-preferred-wp6-")
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary.name) / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        self.works = WorkRepository(self.catalog)

    def test_deterministic_preferred_is_independent_of_observation_order(self) -> None:
        preprint = self.works.ingest_version(
            provider="arxiv", provider_record_id="preprint", title="Early Version",
            doi="10.1/preprint", version_class="preprint",
        )
        older = self.works.ingest_version(
            provider="crossref", provider_record_id="older", title="Older Formal",
            doi="10.1/older", version_class="formal_publication",
            publication_date="2024-01-01", provider_precedence=0,
            related_work_version_id=preprint.id,
            relation_evidence={"provider": "crossref"},
        )
        newer = self.works.ingest_version(
            provider="openalex", provider_record_id="newer", title="Newer Formal",
            doi="10.1/newer", version_class="formal_publication",
            publication_date="2025-01-01", provider_precedence=4,
            related_work_version_id=preprint.id,
            relation_evidence={"provider": "openalex"},
        )

        self.works.ingest_version(
            provider="late", provider_record_id="older-late", title="Older Formal",
            doi="10.1/older", version_class="formal_publication",
            publication_date="2024-01-01", provider_precedence=0,
        )

        with self.catalog.connect() as connection:
            preferred = connection.exec_driver_sql(
                "SELECT preferred_work_version_id FROM works WHERE id=?", (preprint.work_id,)
            ).scalar_one()
        self.assertEqual(preferred, newer.id)
        self.assertNotEqual(preferred, older.id)


class PreferredCurationTests(unittest.TestCase):
    preprint_id: str
    formal_id: str
    work_id: str

    def setUp(self) -> None:
        workspace_guard = patch("sciretriever.catalog.engine.require_staged_write_override")
        workspace_guard.start()
        self.addCleanup(workspace_guard.stop)
        self.temporary = TemporaryDirectory(prefix="sciretriever-preferred-wp6-")
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary.name) / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        self.works = WorkRepository(self.catalog)
        preprint = self.works.ingest_version(
            provider="arxiv", provider_record_id="preprint", title="Early Version",
            doi="10.2/preprint", version_class="preprint",
        )
        formal = self.works.ingest_version(
            provider="crossref", provider_record_id="formal", title="Formal Version",
            doi="10.2/formal", version_class="formal_publication",
            related_work_version_id=preprint.id,
            relation_evidence={"provider": "crossref"},
        )
        self.preprint_id, self.formal_id, self.work_id = preprint.id, formal.id, preprint.work_id

    @staticmethod
    def request(handler: PreferredSetHandler | PreferredClearHandler) -> CurationRequest:
        return CurationRequest(
            handler, ReviewDecision.NOT_REQUIRED,
            SafeSnapshot(()),
            operation_id=handler.operation_id,
        )

    def preferred_state(self) -> tuple[str | None, int]:
        with self.catalog.connect() as connection:
            row = connection.exec_driver_sql(
                "SELECT preferred_work_version_id,preferred_version_is_manual "
                "FROM works WHERE id=?", (self.work_id,),
            ).one()
        return row[0], int(row[1])

    def audit_count(self) -> int:
        with self.catalog.connect() as connection:
            return int(connection.exec_driver_sql("SELECT count(*) FROM curation_operations").scalar_one())

    def test_set_observation_clear_and_undo_are_audited_and_exact(self) -> None:
        owner = CurationOperationOwner(self.catalog)
        set_handler = PreferredSetHandler.load(self.catalog, self.work_id, self.preprint_id)
        set_record = owner.apply(self.request(set_handler))
        self.assertEqual(self.preferred_state(), (self.preprint_id, 1))
        self.assertEqual(set_record.operation.before.to_dict()["value"], False)
        self.assertEqual(set_record.operation.after.to_dict()["value"], True)

        self.works.ingest_version(
            provider="late", provider_record_id="formal-late", title="Formal Version",
            doi="10.2/formal", version_class="formal_publication",
        )
        self.assertEqual(self.preferred_state(), (self.preprint_id, 1))

        clear_handler = PreferredClearHandler.load(self.catalog, self.work_id)
        clear_record = owner.apply(self.request(clear_handler))
        self.assertEqual(self.preferred_state(), (self.formal_id, 0))
        self.assertEqual(self.audit_count(), 2)

        undo = owner.undo(clear_record.id, clear_handler)
        self.assertEqual(self.preferred_state(), (self.preprint_id, 1))
        self.assertEqual(undo.operation.undo_of, clear_record.id)
        self.assertEqual(self.audit_count(), 3)

    def test_foreign_unknown_malformed_and_merged_ids_are_zero_write(self) -> None:
        foreign = self.works.ingest_version(
            provider="source", provider_record_id="foreign", title="Foreign",
            doi="10.2/foreign",
        )
        invalid_cases = (
            ("malformed", self.preprint_id, "malformed_id"),
            (str(uuid4()), self.preprint_id, "unknown_work"),
            (self.work_id, str(uuid4()), "unknown_version"),
            (self.work_id, foreign.id, "foreign_version"),
        )
        for work_id, version_id, code in invalid_cases:
            with self.subTest(code=code), self.assertRaises(PreferredCurationConflictError) as raised:
                PreferredSetHandler.load(self.catalog, work_id, version_id)
            self.assertEqual(raised.exception.code, code)
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "UPDATE works SET status='merged',merged_into_work_id=? WHERE id=?",
                (foreign.work_id, self.work_id),
            )
        with self.assertRaises(PreferredCurationConflictError) as raised:
            PreferredClearHandler.load(self.catalog, self.work_id)
        self.assertEqual(raised.exception.code, "merged_work")
        self.assertEqual(self.audit_count(), 0)

    def test_duplicate_action_and_state_drift_append_no_misleading_audit(self) -> None:
        owner = CurationOperationOwner(self.catalog)
        clear = PreferredClearHandler.load(self.catalog, self.work_id)
        with self.assertRaises(CurationNoChangeError):
            owner.apply(self.request(clear))
        self.assertEqual(self.audit_count(), 0)
        handler = PreferredSetHandler.load(self.catalog, self.work_id, self.preprint_id)
        owner.apply(self.request(handler))
        duplicate = PreferredSetHandler.load(self.catalog, self.work_id, self.preprint_id)
        with self.assertRaises(CurationNoChangeError):
            owner.apply(self.request(duplicate))
        stale = PreferredClearHandler.load(self.catalog, self.work_id)
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "UPDATE works SET preferred_work_version_id=?,preferred_version_is_manual=1 "
                "WHERE id=?", (self.formal_id, self.work_id),
            )
        with self.assertRaises(CurationStaleError):
            owner.apply(self.request(stale))
        self.assertEqual(self.preferred_state(), (self.formal_id, 1))
        self.assertEqual(self.audit_count(), 1)

    def test_stale_undo_and_every_preferred_failpoint_roll_back(self) -> None:
        owner = CurationOperationOwner(self.catalog)
        handler = PreferredSetHandler.load(self.catalog, self.work_id, self.preprint_id)
        record = owner.apply(self.request(handler))
        for phase in ("undo:before:works", "undo:after:works", "undo:before:audit", "undo:after:audit"):
            with self.subTest(phase=phase):
                def undo_failpoint(point: str, expected: str = phase) -> None:
                    if point == expected:
                        raise RuntimeError(expected)

                with self.assertRaises(RuntimeError):
                    CurationOperationOwner(
                        self.catalog, test_failpoint=undo_failpoint,
                    ).undo(record.id, handler)
                self.assertEqual(self.preferred_state(), (self.preprint_id, 1))
                self.assertEqual(self.audit_count(), 1)
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "UPDATE works SET preferred_work_version_id=? WHERE id=?",
                (self.formal_id, self.work_id),
            )
        with self.assertRaises(CurationStaleError):
            owner.undo(record.id, handler)
        self.assertEqual(self.preferred_state(), (self.formal_id, 1))
        self.assertEqual(self.audit_count(), 1)

        for phase in ("apply:before:works", "apply:after:works", "apply:before:audit", "apply:after:audit"):
            with self.subTest(phase=phase):
                with self.catalog.transaction() as connection:
                    connection.exec_driver_sql(
                        "UPDATE works SET preferred_work_version_id=?,preferred_version_is_manual=0 "
                        "WHERE id=?", (self.formal_id, self.work_id),
                    )
                current = PreferredSetHandler.load(self.catalog, self.work_id, self.preprint_id)

                def failpoint(point: str, expected: str = phase) -> None:
                    if point == expected:
                        raise RuntimeError(expected)

                with self.assertRaises(RuntimeError):
                    CurationOperationOwner(self.catalog, test_failpoint=failpoint).apply(self.request(current))
                self.assertEqual(self.preferred_state(), (self.formal_id, 0))
                self.assertEqual(self.audit_count(), 1)


if __name__ == "__main__":
    unittest.main()
