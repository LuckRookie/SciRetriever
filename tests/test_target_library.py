from __future__ import annotations

import unittest
from uuid import uuid4

from pydantic import ValidationError
from target_completion_support import prepare_completion, publish_completion_submission

from sciretriever.infrastructure.storage.files import CoreArtifactStore
from sciretriever.infrastructure.storage.sqlite import (
    SqliteLibraryReadRepository,
    SqliteLiteratureRepository,
    create_or_open_catalog,
)
from sciretriever.model.library_pages import LibraryPageRequest
from sciretriever.model.library_query import QueryFilterV1
from sciretriever.model.primitives import CollectionId
from sciretriever.services.library import LibraryService
from sciretriever.services.literature.api import accept_completion
from tests.target_library_support import LibraryCase
from tests.target_publisher_support import ScenarioFactory


class TargetLibraryTests(LibraryCase):
    def test_query_filter_rejects_duplicates_ranges_and_blank_values(self) -> None:
        with self.assertRaises(ValidationError):
            QueryFilterV1(authors=("Ada", "Ada"))
        with self.assertRaises(ValidationError):
            QueryFilterV1(year_from=2025, year_to=2024)
        with self.assertRaises(ValidationError):
            QueryFilterV1(title=" ")

    def test_representative_and_all_version_results_are_deterministic(self) -> None:
        work_id, formal_id = self._publish("Alpha Work", "formal", "formal")
        other_id = str(uuid4())
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
                (other_id, work_id),
            )
            connection.execute(
                "INSERT INTO metadata_snapshots"
                "(id,work_version_id,revision,sha256,values_json,provenance_json) "
                "VALUES(?,?,1,sciretriever_metadata_sha256(1,?,?),?,?)",
                (snapshot_id, other_id, source[2], source[3], source[2], source[3]),
            )
            connection.execute(
                "INSERT INTO work_version_current_metadata VALUES(?,?)", (other_id, snapshot_id)
            )
            connection.execute(
                "INSERT INTO metadata_fts(work_version_id,content) VALUES(?,?)",
                (other_id, source[2]),
            )
            connection.commit()
        service = LibraryService(SqliteLibraryReadRepository(self.catalog))

        representative = service.search(
            QueryFilterV1(),
            LibraryPageRequest(limit=100, cursor=None, include_all_versions=False),
        )
        all_versions = service.search(
            QueryFilterV1(),
            LibraryPageRequest(limit=100, cursor=None, include_all_versions=True),
        )

        self.assertEqual(
            tuple(str(item.work_version_id) for item in representative.items),
            (formal_id,),
        )
        self.assertEqual(
            tuple(str(item.work_version_id) for item in all_versions.items), (formal_id, other_id)
        )

    def test_fts_rebuild_restores_metadata_light_and_analysis_current_projections(self) -> None:
        factory = ScenarioFactory()
        self.addCleanup(factory.cleanup)
        prepared = prepare_completion(factory)
        submission = publish_completion_submission(
            prepared.proposal,
            prepared.context,
            prepared.target,
            CoreArtifactStore(prepared.storage),
        )
        accept_completion(
            SqliteLiteratureRepository(prepared.path),
            prepared.publisher,
            submission,
            prepared.target,
        )
        service = LibraryService(SqliteLibraryReadRepository(prepared.path))

        before = service.authority_fingerprint()
        for term in ("Title", "atomic", "alpha"):
            self.assertEqual(
                len(
                    service.search(
                        QueryFilterV1(query=term),
                        LibraryPageRequest(limit=10, cursor=None, include_all_versions=False),
                    ).items
                ),
                1,
            )
        service.drop_search_indexes()
        service.rebuild_search_indexes()

        self.assertEqual(service.authority_fingerprint(), before)
        for term in ("Title", "atomic", "alpha"):
            self.assertEqual(
                len(
                    service.search(
                        QueryFilterV1(query=term),
                        LibraryPageRequest(limit=10, cursor=None, include_all_versions=False),
                    ).items
                ),
                1,
            )

    def test_collection_page_returns_membership_for_requested_collection(self) -> None:
        work_id, _version_id = self._publish("Multi Collection Work", "formal", "multi")
        first_collection = "00000000-0000-0000-0000-000000000001"
        requested_collection = "00000000-0000-0000-0000-000000000002"
        with create_or_open_catalog(self.catalog) as connection:
            for collection_id, name in (
                (first_collection, "First"),
                (requested_collection, "Requested"),
            ):
                run_id = f"10000000-0000-0000-0000-{collection_id[-12:]}"
                membership_id = f"20000000-0000-0000-0000-{collection_id[-12:]}"
                connection.execute(
                    "INSERT INTO collections(id,name) VALUES(?,?)",
                    (collection_id, name),
                )
                connection.execute(
                    "INSERT INTO collection_runs(id,collection_id,mode,topic_conditions_json,"
                    "requested_advance_to,status) VALUES(?,?,'topic','[]','unreviewed','created')",
                    (run_id, collection_id),
                )
                connection.execute(
                    "INSERT INTO collection_memberships"
                    "(id,collection_id,work_id,first_collection_run_id) VALUES(?,?,?,?)",
                    (membership_id, collection_id, work_id, run_id),
                )
            connection.commit()

        page = LibraryService(SqliteLibraryReadRepository(self.catalog)).collection_memberships(
            CollectionId(requested_collection), None, 10
        )

        self.assertEqual(len(page.memberships), 1)
        self.assertEqual(str(page.memberships[0][1].collection_id), requested_collection)


if __name__ == "__main__":
    unittest.main()
