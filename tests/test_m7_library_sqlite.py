from __future__ import annotations

import unittest
from unittest.mock import patch
from uuid import uuid4

from sciretriever.literature_store.sqlite import (
    ImportAcceptancePublisher,
    SqliteLibraryReadRepository,
    StalePublicationError,
    create_or_open_catalog,
)
from sciretriever.literature_store.sqlite.engine import open_read_only_snapshot
from sciretriever.model.execution import ImportAcceptanceCommand
from sciretriever.model.library import ExportSelectionRequest
from sciretriever.model.library_details import WorkVersionDetail
from sciretriever.model.library_query import QueryFilterV1
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import WorkVersionId
from sciretriever.services.library import (
    ImportAcceptancePublisher as ImportAcceptancePublisherPort,
)
from sciretriever.services.library import (
    LibraryExportSelectionPort,
    LibraryReadPort,
)
from tests.target_library_support import LibraryCase
from tests.target_publisher_support import ScenarioFactory


class M7LibrarySqliteTests(LibraryCase):
    def test_select_snapshot_returns_all_versions_from_one_read_snapshot(self) -> None:
        work_id, formal_id = self._publish("Alpha Work", "formal", "alpha-formal")
        _, other_formal_id = self._publish("Beta Work", "formal", "beta-formal")
        preprint_id = str(uuid4())
        snapshot_id = str(uuid4())
        with create_or_open_catalog(self.catalog) as connection:
            source = connection.execute(
                "SELECT revision,sha256,values_json,provenance_json "
                "FROM metadata_snapshots WHERE work_version_id=?",
                (formal_id,),
            ).fetchone()
            assert source is not None
            connection.execute(
                "INSERT INTO work_versions(id,work_id,version_role) VALUES(?,?,'preprint')",
                (preprint_id, work_id),
            )
            connection.execute(
                "INSERT INTO metadata_snapshots"
                "(id,work_version_id,revision,sha256,values_json,provenance_json) "
                "VALUES(?,?,1,sciretriever_metadata_sha256(1,?,?),?,?)",
                (snapshot_id, preprint_id, source[2], source[3], source[2], source[3]),
            )
            connection.execute(
                "INSERT INTO work_version_current_metadata VALUES(?,?)",
                (preprint_id, snapshot_id),
            )
            connection.execute(
                "INSERT INTO metadata_fts(work_version_id,content) VALUES(?,?)",
                (preprint_id, source[2]),
            )
            connection.commit()

        repository = SqliteLibraryReadRepository(self.catalog)
        read_port: LibraryReadPort = repository
        selection_port: LibraryExportSelectionPort = repository
        self.assertIs(read_port, selection_port)
        request = ExportSelectionRequest(filters=QueryFilterV1(), all_versions=False)
        with patch(
            "sciretriever.literature_store.sqlite.library_repository.open_read_only_snapshot",
            wraps=open_read_only_snapshot,
        ) as snapshots:
            candidates = selection_port.select_snapshot(request)

        self.assertEqual(snapshots.call_count, 1)
        self.assertEqual(
            tuple(str(item.work_version_id) for item in candidates),
            (formal_id, preprint_id, other_formal_id),
        )
        self.assertEqual(
            candidates[0].detail.metadata.values.identifiers,
            (Identifier(namespace="doi", value="10.1000/alpha-formal"),),
        )
        self.assertTrue(all(isinstance(item.detail, WorkVersionDetail) for item in candidates))
        self.assertTrue(all(isinstance(item.work_version_id, WorkVersionId) for item in candidates))

    def test_import_publisher_maps_duplicate_publication_to_stale_error(self) -> None:
        factory = ScenarioFactory()
        self.addCleanup(factory.cleanup)
        scenario = factory.imported()
        assert isinstance(scenario.command, ImportAcceptanceCommand)
        publisher: ImportAcceptancePublisherPort = ImportAcceptancePublisher(scenario.path)

        publisher.publish(scenario.command)

        with self.assertRaises(StalePublicationError):
            publisher.publish(scenario.command)


if __name__ == "__main__":
    unittest.main()
