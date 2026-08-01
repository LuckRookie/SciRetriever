from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from sciretriever.catalog import create_catalog_engine, initialize_catalog
from sciretriever.catalog.author_curation import AuthorCurationConflictError, AuthorMergeHandler
from sciretriever.catalog.curation import (
    CurationBoundaryError,
    CurationOperationOwner,
    CurationRequest,
    CurationStaleError,
)
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.core.curation import ReviewDecision
from sciretriever.core.snapshots import SafeSnapshot, SnapshotBoundaryError


class AuthorCurationBaselineTests(unittest.TestCase):
    catalog: CatalogEngine
    temporary: TemporaryDirectory[str]

    def setUp(self) -> None:
        workspace_guard = patch("sciretriever.catalog.engine.require_staged_write_override")
        workspace_guard.start()
        self.addCleanup(workspace_guard.stop)
        self.temporary = TemporaryDirectory(prefix="sciretriever-author-curation-wp6-")
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary.name) / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)

    def test_authorship_order_and_affiliation_bytes_are_persisted(self) -> None:
        work_id, version_id, first_author, second_author = (str(uuid4()) for _ in range(4))
        first_affiliation = "  Institute of Exact Bytes, Lab A  "
        second_affiliation = "Department B\nUnit C"
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("INSERT INTO works (id) VALUES (?)", (work_id,))
            connection.exec_driver_sql(
                "INSERT INTO work_versions (id,work_id,normalized_title,title,stable_version_key) "
                "VALUES (?,?,'paper','Paper','manual')",
                (version_id, work_id),
            )
            connection.exec_driver_sql(
                "INSERT INTO authors (id,display_name,normalized_name) VALUES "
                "(?,'First','first'),(?,'Second','second')",
                (first_author, second_author),
            )
            connection.exec_driver_sql(
                "INSERT INTO authorships "
                "(id,work_version_id,author_id,position,affiliation) VALUES "
                "(?,?,?,0,?),(?,?,?,1,?)",
                (str(uuid4()), version_id, first_author, first_affiliation,
                 str(uuid4()), version_id, second_author, second_affiliation),
            )

        with self.catalog.connect() as connection:
            rows = connection.exec_driver_sql(
                "SELECT author_id,position,affiliation FROM authorships "
                "WHERE work_version_id=? ORDER BY position,id",
                (version_id,),
            ).all()

        self.assertEqual(
            rows,
            [(first_author, 0, first_affiliation), (second_author, 1, second_affiliation)],
        )


class AuthorMergeTests(unittest.TestCase):
    catalog: CatalogEngine
    temporary: TemporaryDirectory[str]
    source: str
    target: str
    version: str

    def setUp(self) -> None:
        workspace_guard = patch("sciretriever.catalog.engine.require_staged_write_override")
        workspace_guard.start()
        self.addCleanup(workspace_guard.stop)
        self.temporary = TemporaryDirectory(prefix="sciretriever-author-merge-wp6-")
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary.name) / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        work_id, self.version, self.source, self.target = (str(uuid4()) for _ in range(4))
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("INSERT INTO works (id) VALUES (?)", (work_id,))
            connection.exec_driver_sql(
                "INSERT INTO work_versions (id,work_id,normalized_title,title,stable_version_key) "
                "VALUES (?,?,'paper','Paper','manual')",
                (self.version, work_id),
            )
            connection.exec_driver_sql(
                "INSERT INTO authors (id,display_name,normalized_name,orcid) VALUES "
                "(?,'Source','source',NULL),(?,'Target','target','0000-0002-1825-0097')",
                (self.source, self.target),
            )

    def evidence(self) -> SafeSnapshot:
        return SafeSnapshot.from_pairs((
            ("decision", "manual_author_identity"),
            ("manual_value", "same verified laboratory profile"),
            ("source_author_id", self.source),
            ("target_author_id", self.target),
            ("value", "same verified publication history"),
        ))

    def request(self, handler: AuthorMergeHandler, evidence: SafeSnapshot | None = None) -> CurationRequest:
        return CurationRequest(
            handler,
            ReviewDecision.CONFIRMED,
            handler.evidence if evidence is None else evidence,
            handler.operation_id,
        )

    def add_authorship(self, author_id: str, position: int, affiliation: str) -> str:
        authorship_id = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO authorships "
                "(id,work_version_id,author_id,position,affiliation) VALUES (?,?,?,?,?)",
                (authorship_id, self.version, author_id, position, affiliation),
            )
        return authorship_id

    def test_compatible_orcid_merge_preserves_collision_order_and_undo(self) -> None:
        source_link = self.add_authorship(self.source, 0, "  Source affiliation  ")
        target_link = self.add_authorship(self.target, 1, "Target\naffiliation")
        handler = AuthorMergeHandler.load(self.catalog, self.source, self.target, SafeSnapshot(()))

        applied = CurationOperationOwner(self.catalog).apply(self.request(handler))

        with self.catalog.connect() as connection:
            merged = connection.exec_driver_sql(
                "SELECT id,author_id,position,affiliation FROM authorships ORDER BY position,id"
            ).all()
            lineage = connection.exec_driver_sql(
                "SELECT source_author_id,target_author_id,operation_id FROM author_merge_lineage"
            ).one()
        self.assertEqual(
            merged,
            [(source_link, self.target, 0, "  Source affiliation  "),
             (target_link, self.target, 1, "Target\naffiliation")],
        )
        self.assertEqual(tuple(lineage), (self.source, self.target, applied.id))
        self.assertEqual(applied.operation.after.to_dict()["value"], "reassigned:2:collisions:1")

        undone = CurationOperationOwner(self.catalog).undo(applied.id, handler)

        with self.catalog.connect() as connection:
            restored = connection.exec_driver_sql(
                "SELECT id,author_id,position,affiliation FROM authorships ORDER BY position,id"
            ).all()
            children = connection.exec_driver_sql(
                "SELECT count(*) FROM curation_operations WHERE undo_of_operation_id=?",
                (applied.id,),
            ).scalar_one()
        self.assertEqual(
            restored,
            [(source_link, self.source, 0, "  Source affiliation  "),
             (target_link, self.target, 1, "Target\naffiliation")],
        )
        self.assertEqual(children, 1)
        self.assertEqual(undone.operation.undo_of, applied.id)

    def test_manual_evidence_allows_merge_without_orcid(self) -> None:
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("UPDATE authors SET orcid=NULL WHERE id=?", (self.target,))
        self.add_authorship(self.source, 0, "Affiliation")
        handler = AuthorMergeHandler.load(self.catalog, self.source, self.target, self.evidence())

        record = CurationOperationOwner(self.catalog).apply(self.request(handler))

        self.assertEqual(record.evidence, self.evidence())

    def test_source_orcid_target_missing_is_compatible_and_preserved(self) -> None:
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "UPDATE authors SET orcid=NULL WHERE id=?", (self.target,)
            )
            connection.exec_driver_sql(
                "UPDATE authors SET orcid='https://orcid.org/0000-0002-1825-0097' WHERE id=?",
                (self.source,),
            )
        self.add_authorship(self.source, 0, "Affiliation")
        handler = AuthorMergeHandler.load(self.catalog, self.source, self.target, SafeSnapshot(()))

        CurationOperationOwner(self.catalog).apply(self.request(handler))

        with self.catalog.connect() as connection:
            orcids = connection.exec_driver_sql(
                "SELECT id,orcid FROM authors WHERE id IN (?,?) ORDER BY id",
                (self.source, self.target),
            ).all()
        self.assertEqual({str(row[0]): row[1] for row in orcids}, {
            self.source: "https://orcid.org/0000-0002-1825-0097",
            self.target: None,
        })

    def test_conflicting_orcid_and_missing_evidence_reject_without_audit(self) -> None:
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "UPDATE authors SET orcid='0000-0001-5109-3700' WHERE id=?",
                (self.source,),
            )
        with self.assertRaises(AuthorCurationConflictError) as conflict:
            AuthorMergeHandler.load(self.catalog, self.source, self.target, self.evidence())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("UPDATE authors SET orcid=NULL", ())
        with self.assertRaises(AuthorCurationConflictError) as missing:
            AuthorMergeHandler.load(self.catalog, self.source, self.target, SafeSnapshot(()))
        with self.catalog.connect() as connection:
            audit_count = connection.exec_driver_sql("SELECT count(*) FROM curation_operations").scalar_one()
        self.assertEqual((conflict.exception.code, missing.exception.code), ("orcid_conflict", "missing_evidence"))
        self.assertEqual(audit_count, 0)

    def test_self_unknown_merged_and_misleading_evidence_reject(self) -> None:
        with self.assertRaises(AuthorCurationConflictError):
            AuthorMergeHandler.load(self.catalog, self.source, self.source, self.evidence())
        with self.assertRaises(AuthorCurationConflictError):
            AuthorMergeHandler.load(self.catalog, str(uuid4()), self.target, self.evidence())
        handler = AuthorMergeHandler.load(self.catalog, self.source, self.target, SafeSnapshot(()))
        misleading = SafeSnapshot.from_pairs((("decision", "other"),))
        with self.assertRaises(CurationBoundaryError):
            self.request(handler, misleading)

    def test_malformed_secret_and_path_like_evidence_rejects(self) -> None:
        for value in ("secret token", "/home/user/evidence", "https://example.test/evidence"):
            with self.subTest(value=value), self.assertRaises(SnapshotBoundaryError):
                SafeSnapshot.from_pairs((("value", value),))

    def test_stale_load_apply_and_stale_undo_reject_exactly(self) -> None:
        link_id = self.add_authorship(self.source, 0, "Before")
        handler = AuthorMergeHandler.load(self.catalog, self.source, self.target, SafeSnapshot(()))
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("UPDATE authorships SET affiliation='Independent' WHERE id=?", (link_id,))
        with self.assertRaises(CurationStaleError):
            CurationOperationOwner(self.catalog).apply(self.request(handler))
        fresh = AuthorMergeHandler.load(self.catalog, self.source, self.target, SafeSnapshot(()))
        applied = CurationOperationOwner(self.catalog).apply(self.request(fresh))
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("UPDATE authorships SET affiliation='After merge edit' WHERE id=?", (link_id,))
        with self.assertRaises(CurationStaleError):
            CurationOperationOwner(self.catalog).undo(applied.id, fresh)

    def test_operation_id_is_exact_and_repeat_apply_is_stale(self) -> None:
        self.add_authorship(self.source, 0, "Affiliation")
        handler = AuthorMergeHandler.load(self.catalog, self.source, self.target, SafeSnapshot(()))
        with self.assertRaises(CurationBoundaryError):
            CurationRequest(handler, ReviewDecision.CONFIRMED, handler.evidence)
        applied = CurationOperationOwner(self.catalog).apply(self.request(handler))
        with self.assertRaises(CurationStaleError):
            CurationOperationOwner(self.catalog).apply(self.request(handler))
        self.assertEqual(applied.id, handler.operation_id)


if __name__ == "__main__":
    unittest.main()
