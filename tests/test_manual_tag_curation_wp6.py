from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from sciretriever.catalog import TagRepository, WorkRepository, create_catalog_engine, initialize_catalog
from sciretriever.catalog.curation import (
    CurationNoChangeError,
    CurationOperationOwner,
    CurationRequest,
    CurationStaleError,
)
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.manual_tag_curation import (
    ManualTagAddHandler,
    ManualTagCurationConflictError,
    ManualTagRemoveHandler,
)
from sciretriever.core.curation import ReviewDecision
from sciretriever.core.snapshots import SafeSnapshot


class ManualTagCurationTests(unittest.TestCase):
    catalog: CatalogEngine

    def setUp(self) -> None:
        workspace_guard = patch("sciretriever.catalog.engine.require_staged_write_override")
        workspace_guard.start()
        self.addCleanup(workspace_guard.stop)
        self.temporary = TemporaryDirectory(prefix="sciretriever-manual-tag-wp6-")
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary.name) / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        self.version = WorkRepository(self.catalog).ingest_version(
            provider="provider", provider_record_id="tagged", title="Tagged",
            doi="10.14/manual-tag",
        )
        self.tag = TagRepository(self.catalog).add("manual-tag")

    @staticmethod
    def request(handler: ManualTagAddHandler | ManualTagRemoveHandler) -> CurationRequest:
        return CurationRequest(
            handler, ReviewDecision.NOT_REQUIRED, SafeSnapshot(()),
            operation_id=handler.operation_id,
        )

    def state(self) -> tuple[int, int]:
        with self.catalog.connect() as connection:
            links = connection.exec_driver_sql(
                "SELECT count(*) FROM manual_work_tags WHERE work_id=? AND tag_id=?",
                (self.version.work_id, self.tag.id),
            ).scalar_one()
            audits = connection.exec_driver_sql("SELECT count(*) FROM curation_operations").scalar_one()
        return int(links), int(audits)

    def test_add_remove_and_each_undo_restore_exact_link(self) -> None:
        owner = CurationOperationOwner(self.catalog)
        add = ManualTagAddHandler.load(self.catalog, self.version.work_id, self.tag.id)
        add_record = owner.apply(self.request(add))
        self.assertEqual(self.state(), (1, 1))
        owner.undo(add_record.id, add)
        self.assertEqual(self.state(), (0, 2))
        owner.apply(self.request(ManualTagAddHandler.load(
            self.catalog, self.version.work_id, self.tag.id,
        )))
        remove = ManualTagRemoveHandler.load(self.catalog, self.version.work_id, self.tag.id)
        remove_record = owner.apply(self.request(remove))
        self.assertEqual(self.state(), (0, 4))
        owner.undo(remove_record.id, remove)
        self.assertEqual(self.state(), (1, 5))

    def test_invalid_merged_and_duplicate_actions_are_zero_audit(self) -> None:
        for work_id, tag_id, code in (
            ("bad", self.tag.id, "malformed_id"),
            (str(uuid4()), self.tag.id, "unknown_work"),
            (self.version.work_id, str(uuid4()), "unknown_tag"),
        ):
            with self.subTest(code=code), self.assertRaises(ManualTagCurationConflictError) as raised:
                ManualTagAddHandler.load(self.catalog, work_id, tag_id)
            self.assertEqual(raised.exception.code, code)
        owner = CurationOperationOwner(self.catalog)
        with self.assertRaises(CurationNoChangeError):
            owner.apply(self.request(ManualTagRemoveHandler.load(
                self.catalog, self.version.work_id, self.tag.id,
            )))
        owner.apply(self.request(ManualTagAddHandler.load(
            self.catalog, self.version.work_id, self.tag.id,
        )))
        with self.assertRaises(CurationNoChangeError):
            owner.apply(self.request(ManualTagAddHandler.load(
                self.catalog, self.version.work_id, self.tag.id,
            )))
        self.assertEqual(self.state(), (1, 1))

    def test_load_apply_and_undo_stale_guards_preserve_independent_link(self) -> None:
        stale = ManualTagAddHandler.load(self.catalog, self.version.work_id, self.tag.id)
        from manual_curation_fixture import add_manual_tag
        add_manual_tag(self.catalog, self.version.work_id, self.tag.id)
        owner = CurationOperationOwner(self.catalog)
        with self.assertRaises(CurationStaleError):
            owner.apply(self.request(stale))
        remove = ManualTagRemoveHandler.load(self.catalog, self.version.work_id, self.tag.id)
        record = owner.apply(self.request(remove))
        add_manual_tag(self.catalog, self.version.work_id, self.tag.id)
        with self.assertRaises(CurationStaleError):
            owner.undo(record.id, remove)
        self.assertEqual(self.state(), (1, 3))

    def test_all_tag_table_family_failpoints_are_zero_write(self) -> None:
        handler = ManualTagAddHandler.load(self.catalog, self.version.work_id, self.tag.id)
        for phase in CurationOperationOwner.apply_failpoints(handler):
            with self.subTest(phase=phase):
                def failpoint(point: str, expected: str = phase) -> None:
                    if point == expected:
                        raise RuntimeError(expected)
                with self.assertRaises(RuntimeError):
                    CurationOperationOwner(self.catalog, test_failpoint=failpoint).apply(
                        self.request(handler),
                    )
                self.assertEqual(self.state(), (0, 0))
        record = CurationOperationOwner(self.catalog).apply(self.request(handler))
        for phase in CurationOperationOwner.undo_failpoints(handler):
            with self.subTest(phase=phase):
                def failpoint(point: str, expected: str = phase) -> None:
                    if point == expected:
                        raise RuntimeError(expected)
                with self.assertRaises(RuntimeError):
                    CurationOperationOwner(self.catalog, test_failpoint=failpoint).undo(
                        record.id, handler,
                    )
                self.assertEqual(self.state(), (1, 1))


if __name__ == "__main__":
    unittest.main()
