from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase
from uuid import uuid4


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import CitationRepository, EnrichmentRepository, IdentityResolver, initialize_catalog, create_catalog_engine
from sciretriever.core.contracts import Identifier


class EnrichmentRepositoryTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary.name) / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        resolver = IdentityResolver(self.catalog)
        self.work_version_id = resolver.create_or_reuse_work({"doi": "10.1/citing"}).work_version.id
        self.cited_id = resolver.create_or_reuse_work({"doi": "10.1/cited"}).work.id
        raw_id, self.artifact_id = str(uuid4()), str(uuid4())
        sha = "a" * 64
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, byte_size, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?)", (raw_id, sha, f"raw/aa/{sha}", "application/xml", "xml", 10, "{}"))
            connection.exec_driver_sql("INSERT INTO normalized_artifacts (id, work_version_id, raw_asset_id, kind, schema_version, storage_path, sha256, media_type, byte_size, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (self.artifact_id, self.work_version_id, raw_id, "normalized_content", "1", "derived/normalized/item", "b" * 64, "application/json", 10, "{}"))

    def test_light_results_and_citations_replay(self) -> None:
        enrichment = EnrichmentRepository(self.catalog)
        summary = enrichment.register_result(self.work_version_id, self.artifact_id, "summary", "1", "c" * 64, {"summary": "Text"})
        self.assertEqual(enrichment.register_result(self.work_version_id, self.artifact_id, "summary", "1", "c" * 64, {"summary": "Text"}), summary)
        citations = CitationRepository(self.catalog).register_identifier_links(
            self.work_version_id, self.artifact_id, (Identifier("doi", "10.1/cited"), Identifier("pmid", "999"))
        )
        self.assertEqual({item.cited_work_id for item in citations}, {self.cited_id, None})
        replay = CitationRepository(self.catalog).register_identifier_links(
            self.work_version_id, self.artifact_id, (Identifier("pmid", "999"), Identifier("doi", "10.1/cited"))
        )
        self.assertEqual(citations, replay)


if __name__ == "__main__":
    import unittest
    unittest.main()
