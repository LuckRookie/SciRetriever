from __future__ import annotations

import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from pydantic import ValidationError
from target_completion_support import prepare_completion
from target_publisher_support import ScenarioFactory

from sciretriever.batching.completion import complete_analysis
from sciretriever.bibliography.api import accept_completion
from sciretriever.bibliography.identity import prepare_initial_ingest
from sciretriever.interoperability.library import LibraryPageRequest, LibraryReadService
from sciretriever.literature_store.filesystem import CoreArtifactStore
from sciretriever.literature_store.sqlite import (
    SqliteBibliographyRepository,
    SqliteLibraryReadRepository,
    create_or_open_catalog,
)
from sciretriever.literature_store.sqlite.publisher_support import (
    StatementFailpoint,
    publish_bibliography,
)
from sciretriever.model.library import QueryFilterV1
from sciretriever.model.literature import BibliographicObservation, Identifier, InitialMetadata
from sciretriever.model.primitives import (
    CollectionId,
    UtcTimestamp,
    WorkId,
)


class TargetLibraryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-target-library-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)
        self.catalog = self.root / "catalog.sqlite"
        with create_or_open_catalog(self.catalog):
            pass

    def _publish(self, title: str, role: str, suffix: str) -> tuple[str, str]:
        observation = BibliographicObservation(
            provider="crossref",
            provider_record_id=f"record-{suffix}",
            source_priority=0,
            observed_at=UtcTimestamp("2026-07-31T00:00:00Z"),
            identifiers=(Identifier(namespace="doi", value=f"10.1000/{suffix}"),),
            metadata=InitialMetadata(
                title=title,
                authors=("Ada Lovelace",),
                year=2024,
                item_type="article",
                abstract="metadata alpha",
                venue="Journal Alpha",
                language="en",
            ),
            version_role=role,
        )
        prepared = prepare_initial_ingest(
            SqliteBibliographyRepository(self.catalog), (observation,)
        )
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute("BEGIN IMMEDIATE")
            publish_bibliography(connection, StatementFailpoint(None), prepared)
            connection.commit()
        return str(prepared.work_id), str(prepared.work_version_id)

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
        service = LibraryReadService(SqliteLibraryReadRepository(self.catalog))

        representative = service.search(QueryFilterV1(), LibraryPageRequest(100, None, False))
        all_versions = service.search(QueryFilterV1(), LibraryPageRequest(100, None, True))

        self.assertEqual(tuple(item.work_version_id for item in representative.items), (formal_id,))
        self.assertEqual(
            tuple(item.work_version_id for item in all_versions.items), (formal_id, other_id)
        )

    def test_filters_details_graph_extensions_and_fts_use_current_facts(self) -> None:
        work_id, version_id = self._publish("Alpha Search", "formal", "detail")
        collection_id, run_id, membership_id = (str(uuid4()) for _ in range(3))
        reference_id = str(uuid4())
        unresolved_id = str(uuid4())
        reference_set_id = str(uuid4())
        extension_id = str(uuid4())
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
            payload = (
                '{"artifact_id":null,"schema_version":"1","sha256":null,'
                '"value":{"term":"extension alpha"},"work_version_id":"%s"}' % version_id
            )
            connection.execute(
                "INSERT INTO opaque_extension_records "
                "VALUES('example.ns',?,1,sciretriever_sha256(?),?)",
                (extension_id, payload, payload),
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
        service = LibraryReadService(SqliteLibraryReadRepository(self.catalog))

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
            QueryFilterV1(extension_namespaces=("example.ns",)),
        )
        for query_filter in filters:
            self.assertEqual(
                len(service.search(query_filter, LibraryPageRequest(10, None, False)).items), 1
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
            QueryFilterV1(extension_namespaces=("absent.ns",)),
        )
        for query_filter in negative_filters:
            self.assertEqual(
                len(service.search(query_filter, LibraryPageRequest(10, None, False)).items), 0
            )

        detail = service.get_work(WorkId(work_id), True, ("example.ns",))
        resolved = service.references(version_id, True, 100, None)
        memberships = service.collection_memberships(CollectionId(collection_id), None, 1)

        self.assertEqual(detail.work_id, work_id)
        self.assertTrue(detail.versions[0].observations_included)
        self.assertEqual(detail.versions[0].extension_namespaces, ("example.ns",))
        self.assertEqual((len(resolved.edges), len(resolved.unresolved)), (1, 1))
        self.assertEqual(memberships.memberships[0][0], work_id)
        self.assertEqual(len(memberships.memberships[0][1].causes), 1)

        before = service.authority_fingerprint()
        service.drop_search_indexes()
        self.assertEqual(
            len(
                service.search(
                    QueryFilterV1(query="alpha"), LibraryPageRequest(10, None, False)
                ).items
            ),
            0,
        )
        service.rebuild_search_indexes()
        self.assertEqual(service.authority_fingerprint(), before)
        self.assertEqual(
            len(
                service.search(
                    QueryFilterV1(query="alpha"), LibraryPageRequest(10, None, False)
                ).items
            ),
            1,
        )

    def test_fts_rebuild_restores_metadata_light_and_analysis_current_projections(self) -> None:
        factory = ScenarioFactory()
        self.addCleanup(factory.cleanup)
        prepared = prepare_completion(factory)
        submission = complete_analysis(
            prepared.proposal,
            prepared.context,
            prepared.target,
            CoreArtifactStore(prepared.storage),
        )
        accept_completion(
            SqliteBibliographyRepository(prepared.path),
            prepared.publisher,
            submission,
            prepared.target,
        )
        service = LibraryReadService(SqliteLibraryReadRepository(prepared.path))

        before = service.authority_fingerprint()
        for term in ("Title", "atomic", "alpha"):
            self.assertEqual(
                len(
                    service.search(
                        QueryFilterV1(query=term), LibraryPageRequest(10, None, False)
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
                        QueryFilterV1(query=term), LibraryPageRequest(10, None, False)
                    ).items
                ),
                1,
            )


if __name__ == "__main__":
    unittest.main()
