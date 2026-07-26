from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from sciretriever.catalog import create_catalog_engine, initialize_catalog
from sciretriever.catalog.author_curation import AuthorMergeHandler
from sciretriever.catalog.curation import (
    CurationAlreadyUndoneError,
    CurationOperationOwner,
    CurationRequest,
)
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.core.curation import ReviewDecision
from sciretriever.core.snapshots import SafeSnapshot


class InjectedAuthorFailure(Exception):
    __slots__ = ()


class AuthorMergeAtomicityTests(unittest.TestCase):
    catalog: CatalogEngine
    temporary: TemporaryDirectory[str]
    source: str
    target: str

    def setUp(self) -> None:
        workspace_guard = patch("sciretriever.catalog.engine.require_staged_write_override")
        workspace_guard.start()
        self.addCleanup(workspace_guard.stop)
        self.temporary = TemporaryDirectory(prefix="sciretriever-author-failpoints-wp6-")
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary.name) / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        work_id, version_id, self.source, self.target = (str(uuid4()) for _ in range(4))
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("INSERT INTO works (id) VALUES (?)", (work_id,))
            connection.exec_driver_sql(
                "INSERT INTO work_versions (id,work_id,normalized_title,title,stable_version_key) "
                "VALUES (?,?,'paper','Paper','manual')",
                (version_id, work_id),
            )
            connection.exec_driver_sql(
                "INSERT INTO authors (id,display_name,normalized_name,orcid) VALUES "
                "(?,'Source','source',NULL),(?,'Target','target','0000-0002-1825-0097')",
                (self.source, self.target),
            )
            connection.exec_driver_sql(
                "INSERT INTO authorships (id,work_version_id,author_id,position,affiliation) "
                "VALUES (?,?,?,0,' Affiliation ')",
                (str(uuid4()), version_id, self.source),
            )

    def state(self) -> bytes:
        with self.catalog.connect() as connection:
            values = {
                table: [list(row) for row in connection.exec_driver_sql(
                    f"SELECT * FROM {table} ORDER BY 1"
                ).all()]
                for table in ("authors", "authorships", "author_merge_lineage", "curation_operations")
            }
        return json.dumps(values, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("ascii")

    @staticmethod
    def request(handler: AuthorMergeHandler) -> CurationRequest:
        return CurationRequest(
            handler, ReviewDecision.CONFIRMED, handler.evidence, handler.operation_id
        )

    def test_every_apply_failpoint_rolls_back_all_families(self) -> None:
        for point in CurationOperationOwner.apply_failpoints(
            AuthorMergeHandler.load(self.catalog, self.source, self.target, SafeSnapshot(()))
        ):
            with self.subTest(point=point):
                handler = AuthorMergeHandler.load(self.catalog, self.source, self.target, SafeSnapshot(()))
                before = self.state()

                def fail(current: str) -> None:
                    if current == point:
                        raise InjectedAuthorFailure

                with self.assertRaises(InjectedAuthorFailure):
                    CurationOperationOwner(self.catalog, test_failpoint=fail).apply(self.request(handler))
                self.assertEqual(self.state(), before)

    def test_every_undo_failpoint_rolls_back_all_families(self) -> None:
        handler = AuthorMergeHandler.load(self.catalog, self.source, self.target, SafeSnapshot(()))
        applied = CurationOperationOwner(self.catalog).apply(self.request(handler))
        for point in CurationOperationOwner.undo_failpoints(handler):
            with self.subTest(point=point):
                before = self.state()

                def fail(current: str) -> None:
                    if current == point:
                        raise InjectedAuthorFailure

                with self.assertRaises(InjectedAuthorFailure):
                    CurationOperationOwner(self.catalog, test_failpoint=fail).undo(applied.id, handler)
                self.assertEqual(self.state(), before)

    def test_concurrent_undo_appends_exactly_one_child(self) -> None:
        handler = AuthorMergeHandler.load(self.catalog, self.source, self.target, SafeSnapshot(()))
        applied = CurationOperationOwner(self.catalog).apply(self.request(handler))

        def undo(_: int) -> str:
            try:
                CurationOperationOwner(self.catalog).undo(applied.id, handler)
            except CurationAlreadyUndoneError:
                return "already_undone"
            return "undone"

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = sorted(executor.map(undo, range(2)))
        with self.catalog.connect() as connection:
            child_count = connection.exec_driver_sql(
                "SELECT count(*) FROM curation_operations WHERE undo_of_operation_id=?",
                (applied.id,),
            ).scalar_one()
        self.assertEqual(outcomes, ["already_undone", "undone"])
        self.assertEqual(child_count, 1)


if __name__ == "__main__":
    unittest.main()
