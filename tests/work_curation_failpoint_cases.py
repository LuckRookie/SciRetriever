from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from sciretriever.catalog import create_catalog_engine, initialize_catalog
from sciretriever.catalog.curation import CurationOperationOwner, CurationRequest
from sciretriever.catalog.work_curation import WorkMergeHandler
from sciretriever.core.curation import ReviewDecision
from sciretriever.core.snapshots import SafeSnapshot


class InjectedWorkCurationFailure(Exception):
    __slots__ = ("point",)

    def __init__(self, point: str) -> None:
        self.point = point


class WorkCurationFailpointTests(unittest.TestCase):
    def _exercise(self, failpoint: str, *, undo: bool) -> None:
        with patch("sciretriever.catalog.engine.require_staged_write_override"), TemporaryDirectory(
            prefix="sciretriever-work-failpoint-wp6-"
        ) as temporary:
            catalog = create_catalog_engine(Path(temporary) / "catalog.sqlite")
            self.addCleanup(catalog.dispose)
            initialize_catalog(catalog)
            source, target, version = str(uuid4()), str(uuid4()), str(uuid4())
            with catalog.transaction() as connection:
                connection.exec_driver_sql("INSERT INTO works (id) VALUES (?),(?)", (source, target))
                connection.exec_driver_sql(
                    "INSERT INTO work_versions "
                    "(id,work_id,version_class,normalized_title,title,stable_version_key) "
                    "VALUES (?,?,'preprint','paper','Paper','preprint')",
                    (version, source),
                )
            handler = WorkMergeHandler.load(catalog, source, target)
            request = CurationRequest(
                handler, ReviewDecision.CONFIRMED,
                SafeSnapshot.from_pairs((("decision", "failpoint"),)), handler.operation_id,
            )
            owner = CurationOperationOwner(catalog)
            applied = owner.apply(request) if undo else None
            before = self._state(catalog)

            def inject(point: str) -> None:
                if point == failpoint:
                    raise InjectedWorkCurationFailure(point)

            failing = CurationOperationOwner(catalog, test_failpoint=inject)
            with self.assertRaises(InjectedWorkCurationFailure):
                if applied is None:
                    failing.apply(request)
                else:
                    failing.undo(applied.id, handler)
            self.assertEqual(self._state(catalog), before)

    @staticmethod
    def _state(catalog) -> bytes:
        with catalog.connect() as connection:
            values = {
                table: [list(row) for row in connection.exec_driver_sql(f"SELECT * FROM {table} ORDER BY 1").all()]
                for table in ("works", "work_versions", "work_merge_lineage", "curation_operations")
            }
        return json.dumps(values, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("ascii")

    def test_every_merge_apply_family_failpoint_rolls_back(self) -> None:
        with patch("sciretriever.catalog.engine.require_staged_write_override"), TemporaryDirectory() as temporary:
            catalog = create_catalog_engine(Path(temporary) / "catalog.sqlite")
            self.addCleanup(catalog.dispose)
            initialize_catalog(catalog)
            source, target = str(uuid4()), str(uuid4())
            with catalog.transaction() as connection:
                connection.exec_driver_sql("INSERT INTO works (id) VALUES (?),(?)", (source, target))
            handler = WorkMergeHandler.load(catalog, source, target)
            points = CurationOperationOwner.apply_failpoints(handler)
        for point in points:
            with self.subTest(point=point):
                self._exercise(point, undo=False)

    def test_every_merge_undo_family_failpoint_rolls_back(self) -> None:
        with patch("sciretriever.catalog.engine.require_staged_write_override"), TemporaryDirectory() as temporary:
            catalog = create_catalog_engine(Path(temporary) / "catalog.sqlite")
            self.addCleanup(catalog.dispose)
            initialize_catalog(catalog)
            source, target = str(uuid4()), str(uuid4())
            with catalog.transaction() as connection:
                connection.exec_driver_sql("INSERT INTO works (id) VALUES (?),(?)", (source, target))
            handler = WorkMergeHandler.load(catalog, source, target)
            points = CurationOperationOwner.undo_failpoints(handler)
        for point in points:
            with self.subTest(point=point):
                self._exercise(point, undo=True)


__all__ = ("WorkCurationFailpointTests",)
