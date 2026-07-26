from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Callable
import unittest
from unittest.mock import patch
from uuid import uuid4

from sqlalchemy.engine import Connection

from sciretriever.catalog import CatalogEngine, create_catalog_engine, initialize_catalog
from sciretriever.catalog.curation import CurationCapture, CurationStep
from sciretriever.core.curation import CurationAction, CurationSubjectKind
from sciretriever.core.snapshots import SafeSnapshot


@dataclass(frozen=True, slots=True)
class ProbeHandler:
    action: CurationAction
    subject_kind: CurationSubjectKind
    subject_id: str
    operation_id: str | None = None
    expected_before_sha256: str | None = None

    def capture(self, connection: Connection) -> CurationCapture:
        rows = connection.exec_driver_sql(
            "SELECT family, value FROM curation_probe ORDER BY family"
        ).all()
        values = tuple((str(row[0]), int(row[1])) for row in rows)
        snapshot = SafeSnapshot.from_pairs((("value", sum(value for _, value in values)),))
        footprint = json.dumps(values, separators=(",", ":")).encode("ascii")
        return CurationCapture(snapshot=snapshot, footprint=footprint)

    def steps(self) -> tuple[CurationStep, ...]:
        return (
            CurationStep("probe_alpha", self._set("alpha", 11), self._set("alpha", 1)),
            CurationStep("probe_beta", self._set("beta", 22), self._set("beta", 2)),
        )

    @staticmethod
    def _set(family: str, value: int) -> Callable[[Connection], None]:
        def mutate(connection: Connection) -> None:
            connection.exec_driver_sql(
                "UPDATE curation_probe SET value=? WHERE family=?", (value, family)
            )

        return mutate


@dataclass(frozen=True, slots=True)
class NoChangeProbeHandler(ProbeHandler):
    def steps(self) -> tuple[CurationStep, ...]:
        return (
            CurationStep("probe_alpha", self._set("alpha", 1), self._set("alpha", 1)),
            CurationStep("probe_beta", self._set("beta", 2), self._set("beta", 2)),
        )


class CurationCatalogCase(unittest.TestCase):
    catalog: CatalogEngine
    handler: ProbeHandler
    temporary: TemporaryDirectory[str]

    def setUp(self) -> None:
        workspace_guard = patch("sciretriever.catalog.engine.require_staged_write_override")
        workspace_guard.start()
        self.addCleanup(workspace_guard.stop)
        self.temporary = TemporaryDirectory(prefix="sciretriever-curation-wp6-")
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary.name) / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        subject_id = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("INSERT INTO works (id) VALUES (?)", (subject_id,))
            connection.exec_driver_sql(
                "CREATE TABLE curation_probe (family TEXT PRIMARY KEY, value INTEGER NOT NULL)"
            )
            connection.exec_driver_sql(
                "INSERT INTO curation_probe VALUES ('alpha', 1), ('beta', 2)"
            )
        self.handler = ProbeHandler(
            CurationAction.SET_PREFERRED, CurationSubjectKind.WORK, subject_id
        )

    def state(self) -> bytes:
        with self.catalog.connect() as connection:
            probe = connection.exec_driver_sql(
                "SELECT family, value FROM curation_probe ORDER BY family"
            ).all()
            audit = connection.exec_driver_sql(
                "SELECT * FROM curation_operations ORDER BY occurred_at, id"
            ).mappings().all()
        return json.dumps(
            {"audit": [dict(row) for row in audit], "probe": [list(row) for row in probe]},
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("ascii")


__all__ = ("CurationCatalogCase", "NoChangeProbeHandler", "ProbeHandler")
