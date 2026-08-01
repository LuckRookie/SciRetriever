import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from sqlalchemy.exc import IntegrityError


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import (
    AuthorRepository,
    ReferenceRepository,
    RegistryRepository,
    TagRepository,
    WorkRepository,
    create_catalog_engine,
    initialize_catalog,
    normalize_title,
)
from sciretriever.core.contracts import Identifier
from sciretriever.errors import CatalogError


class CatalogWp1Tests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary_directory.name) / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        self.assertIsNone(initialize_catalog(self.catalog))
        self.works = WorkRepository(self.catalog)

    def counts(self, *tables: str) -> tuple[int, ...]:
        with self.catalog.connect() as connection:
            return tuple(connection.exec_driver_sql(f'SELECT count(*) FROM "{table}"').scalar_one() for table in tables)

    def test_fresh_schema_has_wp1_tables_and_no_work_owned_content_tables(self) -> None:
        required = {
            "works", "work_versions", "work_version_identifiers", "metadata_observations",
            "authors", "authorships", "publishers", "publisher_aliases", "venues",
            "venue_aliases", "tags", "tag_aliases", "manual_work_tags",
            "generated_work_version_tags", "work_version_assets", "version_relations",
            "version_references",
            "package_versions",
        }
        with self.catalog.connect() as connection:
            tables = {row[0] for row in connection.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )}
            work_columns = {row[1] for row in connection.exec_driver_sql('PRAGMA table_info("works")')}
            package_columns = {row[1] for row in connection.exec_driver_sql('PRAGMA table_info("package_versions")')}
        self.assertTrue(required.issubset(tables))
        self.assertTrue({"work_assets", "citations"}.isdisjoint(tables))
        self.assertTrue({"title", "abstract", "publication_year", "venue"}.isdisjoint(work_columns))
        self.assertIn("work_version_id", package_columns)
        self.assertNotIn("work_id", package_columns)

    def test_provider_observations_are_idempotent_and_do_not_inflate_versions(self) -> None:
        first = self.works.ingest_version(
            provider="crossref", provider_record_id="r1", title="A Stable Paper", doi="10.1/stable",
            metadata={"abstract": " one ", "language": " en ", "publication_year": 2025},
        )
        repeated = self.works.ingest_version(
            provider="crossref", provider_record_id="r1", title="A Stable Paper", doi="10.1/stable",
            metadata={"abstract": " one ", "language": " en ", "publication_year": 2025},
        )
        second_provider = self.works.ingest_version(
            provider="openalex", provider_record_id="o1", title="A Stable Paper", doi="10.1/stable",
            metadata={"abstract": "two", "language": "fr", "publication_year": 2026},
        )
        self.assertEqual(first.id, repeated.id)
        self.assertEqual(first.id, second_provider.id)
        self.assertEqual((first.abstract, first.language, first.publication_year), ("one", "en", 2025))
        self.assertEqual(
            (second_provider.abstract, second_provider.language, second_provider.publication_year),
            ("one", "en", 2025),
        )
        self.assertEqual(self.counts("works", "work_versions", "metadata_observations"), (1, 1, 10))
        self.assertEqual(len(self.works.list_observations(first.id)), 10)

    def test_title_normalization_matches_the_versioned_identity_rule(self) -> None:
        self.assertEqual(normalize_title("  Ａ_B—C™  "), "a b ctm")

    def test_doi_conflict_refuses_title_merge_and_doi_completion_converges(self) -> None:
        provisional = self.works.ingest_version(
            provider="local", provider_record_id="p1", title="Exact Title",
            version_class="formal_publication", publication_date="2026-01-01",
            venue_id=self._venue().id,
        )
        completed = self.works.ingest_version(
            provider="crossref", provider_record_id="p2", title="Exact Title", doi="10.1/complete",
            version_class="formal_publication", publication_date="2026-01-01",
            venue_id=provisional.venue_id,
        )
        conflict = self.works.ingest_version(
            provider="crossref", provider_record_id="p3", title="Exact Title", doi="10.1/conflict",
            version_class="formal_publication", publication_date="2026-01-01",
            venue_id=provisional.venue_id,
        )
        self.assertEqual(completed.id, provisional.id)
        self.assertNotEqual(conflict.work_id, completed.work_id)
        self.assertEqual(self.counts("works", "work_versions", "metadata_observations"), (2, 2, 5))

    def test_missing_version_evidence_is_provider_idempotent_but_provisional(self) -> None:
        first = self.works.ingest_version(provider="source", provider_record_id="x", title="Unknown Version")
        repeated = self.works.ingest_version(provider="source", provider_record_id="x", title="Unknown Version")
        other = self.works.ingest_version(provider="source", provider_record_id="y", title="Unknown Version")
        self.assertTrue(first.is_provisional)
        self.assertEqual(first.id, repeated.id)
        self.assertNotEqual(first.id, other.id)

    def test_multiple_versions_have_deterministic_automatic_preference(self) -> None:
        preprint = self.works.ingest_version(
            provider="arxiv", provider_record_id="a1", title="Versioned Work", doi="10.1/preprint",
            version_class="preprint",
        )
        formal = self.works.ingest_version(
            provider="crossref", provider_record_id="c1", title="Published Version", doi="10.1/formal",
            version_class="formal_publication",
            related_work_version_id=preprint.id,
            relation_evidence={"provider": "crossref", "record_id": "c1"},
        )
        relations = self.works.list_relations(formal.id)
        self.assertEqual(len(relations), 1)
        self.assertEqual(relations[0].source_work_version_id, formal.id)
        self.assertEqual(relations[0].target_work_version_id, preprint.id)
        self.assertEqual(relations[0].relation_type, "is_version_of")
        with self.catalog.connect() as connection:
            preferred = connection.exec_driver_sql(
                "SELECT preferred_work_version_id FROM works WHERE id = ?", (preprint.work_id,)
            ).scalar_one()
        self.assertEqual(preferred, formal.id)
        self.works.ingest_version(
            provider="openalex", provider_record_id="c2", title="Published Version", doi="10.1/formal",
            version_class="formal_publication",
        )
        with self.catalog.connect() as connection:
            observed = connection.exec_driver_sql(
                "SELECT preferred_work_version_id FROM works WHERE id = ?", (preprint.work_id,)
            ).scalar_one()
        self.assertEqual(observed, formal.id)

    def test_preferred_version_database_guard_rejects_cross_work_assignment(self) -> None:
        first = self.works.ingest_version(
            provider="source", provider_record_id="first", title="First", doi="10.1/first"
        )
        second = self.works.ingest_version(
            provider="source", provider_record_id="second", title="Second", doi="10.1/second"
        )
        with self.assertRaises(IntegrityError):
            with self.catalog.transaction() as connection:
                connection.exec_driver_sql(
                    "UPDATE works SET preferred_work_version_id = ? WHERE id = ?",
                    (second.id, first.work_id),
                )

    def test_conservative_authors_registries_tags_and_reverse_references(self) -> None:
        venue = self._venue()
        registries = RegistryRepository(self.catalog)
        publisher = registries.add(
            "publisher",
            "Example Press",
            ("Example Publishing", "Example Academic Press"),
        )
        self.assertEqual(registries.resolve("publisher", "Example Press"), publisher)
        self.assertEqual(registries.resolve("publisher", "Example Publishing"), publisher)
        with self.assertRaisesRegex(CatalogError, "existing alias"):
            registries.add("publisher", "Example Publishing")
        with self.assertRaisesRegex(CatalogError, "canonical name"):
            registries.add("publisher", "Other Press", ("Example Press",))
        self.assertEqual(registries.resolve("venue", "J Test"), venue)
        self.assertEqual(registries.resolve("venue", "Ｊ－ＴＥＳＴ"), venue)

        source = self.works.ingest_version(provider="p", provider_record_id="s", title="Source", doi="10.1/source")
        target = self.works.ingest_version(provider="p", provider_record_id="t", title="Target", doi="10.1/target")
        author_repository = AuthorRepository(self.catalog)
        first, _ = author_repository.add_authorship(source.id, "Alex Kim", 0)
        second, _ = author_repository.add_authorship(target.id, "Alex Kim", 0)
        identified, _ = author_repository.add_authorship(source.id, "A. Kim", 1, orcid="0000-0001-0000-0001")
        reused, _ = author_repository.add_authorship(target.id, "Alex Kim", 1, orcid="0000-0001-0000-0001")
        self.assertNotEqual(first.id, second.id)
        self.assertEqual(identified.id, reused.id)

        tags = TagRepository(self.catalog)
        tag = tags.add("machine learning", aliases=("ML", "机器学习"))
        self.assertEqual(tags.add("Machine—Learning").id, tag.id)
        self.assertEqual(tags.resolve("ｍｌ"), tag)
        with self.assertRaisesRegex(CatalogError, "existing alias"):
            tags.add("ML")
        with self.assertRaisesRegex(CatalogError, "canonical name"):
            tags.add("statistics", aliases=("machine learning",))
        from manual_curation_fixture import add_manual_tag
        add_manual_tag(self.catalog, source.work_id, tag.id)
        self.assertEqual(self.counts("manual_work_tags", "generated_work_version_tags"), (1, 0))

        reference = ReferenceRepository(self.catalog).add(
            source.id, 0, "Target reference", cited_work_id=target.work_id,
            identifier=Identifier("doi", "10.1/target"),
        )
        self.assertEqual(ReferenceRepository(self.catalog).cited_by(target.work_id), (reference,))
        with self.catalog.connect() as connection:
            self.assertNotIn("cited_by", {row[1] for row in connection.exec_driver_sql('PRAGMA table_info("version_references")')})

    def test_publisher_and_venue_are_fill_only_canonical_version_metadata(self) -> None:
        registries = RegistryRepository(self.catalog)
        publisher = registries.add("publisher", "Canonical Press")
        venue = registries.add("venue", "Canonical Journal")
        first = self.works.ingest_version(
            provider="source-a",
            provider_record_id="record-a",
            title="Canonical Metadata",
            doi="10.1/canonical-metadata",
            publisher_id=publisher.id,
            venue_id=venue.id,
            metadata={"abstract": "First abstract", "publication_year": 2024},
        )
        other_publisher = registries.add("publisher", "Other Press")
        repeated = self.works.ingest_version(
            provider="source-b",
            provider_record_id="record-b",
            title="Canonical Metadata",
            doi="10.1/canonical-metadata",
            publisher_id=other_publisher.id,
            metadata={"abstract": "Replacement abstract", "publication_year": 2025},
        )
        self.assertEqual(first.id, repeated.id)
        self.assertEqual(
            (
                repeated.publisher_id,
                repeated.venue_id,
                repeated.abstract,
                repeated.publication_year,
            ),
            (publisher.id, venue.id, "First abstract", 2024),
        )

    def _venue(self):
        return RegistryRepository(self.catalog).add("venue", "Journal of Testing", ("J Test",))


if __name__ == "__main__":
    import unittest

    unittest.main()
