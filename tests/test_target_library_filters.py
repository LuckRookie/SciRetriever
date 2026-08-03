from __future__ import annotations

from inspect import signature
from uuid import uuid4

from pydantic import ValidationError

from sciretriever.infrastructure.storage.sqlite import (
    SqliteLibraryReadRepository,
    create_or_open_catalog,
)
from sciretriever.model import library_views
from sciretriever.model.library_details import WorkVersionDetail
from sciretriever.model.library_pages import LibraryPageRequest
from sciretriever.model.library_query import QueryFilterV1
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import CollectionId, WorkId, WorkVersionId
from sciretriever.services.library import LibraryService
from tests.target_library_support import LibraryCase


class TargetLibraryFilterTests(LibraryCase):
    def test_filters_details_graph_and_fts_use_current_facts(self) -> None:
        work_id, version_id = self._publish("Alpha Search", "formal", "detail")
        collection_id, run_id, membership_id = (str(uuid4()) for _ in range(3))
        reference_id = str(uuid4())
        unresolved_id = str(uuid4())
        reference_set_id = str(uuid4())
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute(
                "INSERT INTO collections(id,name) VALUES(?,'topic')", (collection_id,)
            )
            connection.execute(
                "INSERT INTO collection_runs(id,collection_id,mode,topic_conditions_json,"
                "requested_advance_to,status) VALUES(?,?,'topic','{}','completed','running')",
                (run_id, collection_id),
            )
            connection.execute(
                "INSERT INTO collection_memberships VALUES(?,?,?,?)",
                (membership_id, collection_id, work_id, run_id),
            )
            connection.execute(
                "INSERT INTO collection_causes VALUES(?,?,?,'topic-match','{}',NULL,NULL)",
                (str(uuid4()), membership_id, run_id),
            )
            connection.execute(
                "INSERT INTO reference_sets VALUES(?,?,1,1)", (reference_set_id, version_id)
            )
            evidence = (
                '[{"asset_id":"00000000-0000-0000-0000-000000000101","block_id":"b1",'
                '"char_end":1,"char_start":0,"page_end":1,"page_start":1}]'
            )
            reference = (
                '{"authors":[],"evidence":%s,"identifiers":[],"publication_year":null,'
                '"raw_text":"cited evidence","reference_id":"%s","resolved_work_id":"%s",'
                '"resolved_work_version_id":null,"source":null,"title":"Alpha Search"}'
                % (evidence, reference_id, work_id)
            )
            connection.execute(
                "INSERT INTO reference_members VALUES(?,?,0,?,?,?)",
                (reference_id, reference_set_id, work_id, version_id, reference),
            )
            unresolved = (
                reference.replace(reference_id, unresolved_id)
                .replace(f'"resolved_work_id":"{work_id}"', '"resolved_work_id":null')
                .replace('"title":"Alpha Search"', '"title":null')
            )
            connection.execute(
                "INSERT INTO unresolved_references VALUES(?,?,1,'unresolved evidence',?)",
                (unresolved_id, reference_set_id, unresolved),
            )
            connection.execute(
                "INSERT INTO current_failures VALUES(?,?,?,?,?,?,?,1,?)",
                (
                    str(uuid4()),
                    "work-version",
                    version_id,
                    "analysis",
                    "missing",
                    "not complete",
                    "retry",
                    "2026-07-31T00:00:00Z",
                ),
            )
            connection.commit()
        service = LibraryService(SqliteLibraryReadRepository(self.catalog))

        filters = (
            QueryFilterV1(query="alpha"),
            QueryFilterV1(identifiers=(Identifier(namespace="doi", value="10.1000/detail"),)),
            QueryFilterV1(title="SEARCH"),
            QueryFilterV1(authors=("lovelace",)),
            QueryFilterV1(venues=("journal",)),
            QueryFilterV1(document_types=("article",)),
            QueryFilterV1(languages=("en",)),
            QueryFilterV1(collection_ids=(collection_id,)),
            QueryFilterV1(collection_modes=("topic",)),
            QueryFilterV1(discovery_relations=("member",)),
            QueryFilterV1(states=("unreviewed",)),
            QueryFilterV1(missing_steps=("primary-pdf",)),
            QueryFilterV1(has_current_failure=True),
            QueryFilterV1(year_from=2024, year_to=2024),
            QueryFilterV1(asset_available=False),
            QueryFilterV1(light_document_available=False),
            QueryFilterV1(analysis_available=False),
        )
        for query_filter in filters:
            self.assertEqual(
                len(
                    service.search(
                        query_filter,
                        LibraryPageRequest(limit=10, cursor=None, include_all_versions=False),
                    ).items
                ),
                1,
            )
        negative_filters = (
            QueryFilterV1(query="absent"),
            QueryFilterV1(identifiers=(Identifier(namespace="doi", value="10.1000/absent"),)),
            QueryFilterV1(title="absent"),
            QueryFilterV1(authors=("Grace",)),
            QueryFilterV1(venues=("absent",)),
            QueryFilterV1(document_types=("book",)),
            QueryFilterV1(languages=("fr",)),
            QueryFilterV1(collection_ids=(str(uuid4()),)),
            QueryFilterV1(collection_modes=("citation",)),
            QueryFilterV1(discovery_relations=("seed",)),
            QueryFilterV1(states=("completed",)),
            QueryFilterV1(missing_steps=("completion",)),
            QueryFilterV1(has_current_failure=False),
            QueryFilterV1(year_from=2025),
            QueryFilterV1(asset_available=True),
            QueryFilterV1(light_document_available=True),
            QueryFilterV1(analysis_available=True),
        )
        for query_filter in negative_filters:
            self.assertEqual(
                len(
                    service.search(
                        query_filter,
                        LibraryPageRequest(limit=10, cursor=None, include_all_versions=False),
                    ).items
                ),
                0,
            )

        detail = service.get_work(WorkId(work_id), True)
        resolved = service.references(WorkVersionId(version_id), True, 100, None)
        memberships = service.collection_memberships(CollectionId(collection_id), None, 1)
        self.assertEqual(str(detail.work_id), work_id)
        self.assertTrue(detail.versions[0].observations_included)
        self.assertEqual((len(resolved.edges), len(resolved.unresolved)), (1, 1))
        self.assertEqual(str(memberships.memberships[0][0]), work_id)
        self.assertEqual(len(memberships.memberships[0][1].causes), 1)
        self.assertEqual(type(detail).model_validate_json(detail.model_dump_json()), detail)
        self.assertEqual(type(resolved).model_validate_json(resolved.model_dump_json()), resolved)

        before = service.authority_fingerprint()
        service.drop_search_indexes()
        self.assertEqual(
            len(
                service.search(
                    QueryFilterV1(query="alpha"),
                    LibraryPageRequest(limit=10, cursor=None, include_all_versions=False),
                ).items
            ),
            0,
        )
        service.rebuild_search_indexes()
        self.assertEqual(service.authority_fingerprint(), before)
        self.assertEqual(
            len(
                service.search(
                    QueryFilterV1(query="alpha"),
                    LibraryPageRequest(limit=10, cursor=None, include_all_versions=False),
                ).items
            ),
            1,
        )

    def test_generic_extension_filter_is_absent(self) -> None:
        with self.assertRaises(ValidationError):
            QueryFilterV1.model_validate_json('{"extension_namespaces":["example.ns"]}')
        self.assertNotIn("extension_namespaces", WorkVersionDetail.model_fields)
        self.assertNotIn("extensions", WorkVersionDetail.model_fields)
        self.assertFalse(hasattr(library_views, "ExtensionResultView"))
        self.assertNotIn("namespaces", signature(LibraryService.get_work).parameters)
        self.assertNotIn("namespaces", signature(LibraryService.get_version).parameters)
