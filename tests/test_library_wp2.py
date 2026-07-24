import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast
from unittest import TestCase

from sqlalchemy import insert


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import (
    AuthorRepository,
    LibraryFilters,
    LibraryReadRepository,
    ReferenceRepository,
    RegistryRepository,
    TagRepository,
    WorkRepository,
    create_catalog_engine,
    initialize_catalog,
    open_read_only_catalog_engine,
)
from sciretriever.catalog.models import metadata_observations
from sciretriever.catalog.repository import canonical_json
from sciretriever.core.contracts import Identifier
from sciretriever.core.ids import new_uuid4
from sciretriever.core.timestamps import utc_now_rfc3339


class LibraryWp2Tests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.path = Path(self.temporary_directory.name) / "catalog.sqlite"
        writable = create_catalog_engine(self.path)
        initialize_catalog(writable)
        works = WorkRepository(writable)
        registries = RegistryRepository(writable)
        publisher = registries.add("publisher", "Science Press", ("Sci Press",))
        venue = registries.add("venue", "Journal of Energy", ("J Energy",))

        self.target = works.ingest_version(
            provider="secret-provider", provider_record_id="provider-target",
            title="Solid Electrolyte Interfaces", doi="https://doi.org/10.1000/TARGET",
            version_class="formal_publication", publisher_id=publisher.id, venue_id=venue.id,
            metadata={"abstract": "A canonical solid electrolyte abstract", "publication_year": 2024,
                      "language": "en", "work_type": "article", "volume": "7", "issue": "2",
                      "pages": "1-9", "article_number": "A7", "open_access_status": "open"},
        )
        AuthorRepository(writable).add_authorship(self.target.id, "Ada Lovelace", 0)
        tag = TagRepository(writable).add("battery materials", aliases=("Battery",))
        TagRepository(writable).add_manual(self.target.work_id, tag.id)

        self.preprint = works.ingest_version(
            provider="secret-provider", provider_record_id="provider-preprint",
            title="Earlier Interface Draft", doi="10.1000/preprint", version_class="preprint",
        )
        self.formal = works.ingest_version(
            provider="secret-provider", provider_record_id="provider-formal",
            title="Interface Reference Source", doi="10.1000/formal",
            version_class="formal_publication", related_work_version_id=self.preprint.id,
            relation_evidence={"source": "backend-only"}, metadata={"publication_year": 2023},
        )
        self.ambiguous_one = works.ingest_version(
            provider="p", provider_record_id="amb-1", title="Ambiguous_Title", doi="10.1000/amb-1",
        )
        self.ambiguous_two = works.ingest_version(
            provider="p", provider_record_id="amb-2", title="Ambiguous Title", doi="10.1000/amb-2",
        )
        self.literal = works.ingest_version(
            provider="p", provider_record_id="literal", title=r"Percent 100% Under_score Back\slash",
            doi="10.1000/literal", metadata={"publication_year": 2022},
        )
        self.citing_preprint = works.ingest_version(
            provider="p", provider_record_id="citing-preprint",
            title="Nonpreferred Citing Draft", doi="10.1000/citing-preprint",
            version_class="preprint",
        )
        self.citing_formal = works.ingest_version(
            provider="p", provider_record_id="citing-formal",
            title="Preferred Citing Publication", doi="10.1000/citing-formal",
            version_class="formal_publication", related_work_version_id=self.citing_preprint.id,
            relation_evidence={"source": "version-link"},
        )

        ReferenceRepository(writable).add(
            self.formal.id, 0, "target raw secret", cited_work_id=self.target.work_id,
            identifier=Identifier("doi", "10.1000/target"),
        )
        ReferenceRepository(writable).add(
            self.target.id, 0, "ambiguous one raw", cited_work_id=self.ambiguous_one.work_id,
        )
        ReferenceRepository(writable).add(
            self.target.id, 1, "ambiguous two raw", cited_work_id=self.ambiguous_two.work_id,
        )
        ReferenceRepository(writable).add(
            self.citing_preprint.id, 0, "target from nonpreferred version",
            cited_work_id=self.target.work_id,
        )
        with writable.critical_transaction() as connection:
            connection.execute(insert(metadata_observations).values(
                id=new_uuid4(), work_version_id=self.target.id, provider="leaking-provider",
                provider_record_id="SECRET-RECORD", field_name="private_backend_key",
                value_json=canonical_json("solid electrolyte hidden observation"),
                provenance_json=canonical_json({"raw_path": "/secret/path", "hash": "SECRET-HASH"}),
                observed_at=utc_now_rfc3339(),
            ))
        writable.dispose()
        self.catalog = open_read_only_catalog_engine(self.path)
        self.addCleanup(self.catalog.dispose)
        self.library = LibraryReadRepository(self.catalog)

    def counts(self) -> dict[str, int]:
        names = (
            "works", "work_versions", "work_version_identifiers", "metadata_observations",
            "authors", "authorships", "publishers", "venues", "tags", "manual_work_tags",
            "version_references", "raw_assets", "normalized_artifacts",
        )
        with self.catalog.connect() as connection:
            return {name: connection.exec_driver_sql(f'SELECT count(*) FROM "{name}"').scalar_one()
                    for name in names}

    def test_exact_doi_work_id_and_nonpreferred_version_id(self) -> None:
        by_doi = self.library.exact_lookup(doi=" DOI:10.1000/TARGET ").items
        by_work = self.library.exact_lookup(work_id=self.target.work_id).items
        by_version = self.library.exact_lookup(work_version_id=self.preprint.id).items
        self.assertEqual(by_doi[0].work_id, self.target.work_id)
        self.assertEqual(by_work[0].work_version_id, self.target.id)
        self.assertEqual(
            self.library.exact_lookup(doi="10.1000/preprint").items[0].work_version_id,
            self.formal.id,
        )
        self.assertEqual(by_version[0].work_version_id, self.preprint.id)
        self.assertFalse(by_version[0].is_preferred)
        self.assertEqual(by_version[0].preferred_work_version_id, self.formal.id)

    def test_exact_title_returns_all_ambiguous_matches_deterministically(self) -> None:
        items = self.library.exact_lookup(title="  AMBIGUOUS—TITLE ").items
        self.assertEqual({item.work_id for item in items}, {
            self.ambiguous_one.work_id, self.ambiguous_two.work_id,
        })
        self.assertEqual(items, tuple(sorted(items, key=lambda item: item.work_id)))

    def test_exact_nonpreferred_title_returns_the_preferred_version(self) -> None:
        items = self.library.exact_lookup(title="earlier interface draft").items
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].work_id, self.preprint.work_id)
        self.assertEqual(items[0].work_version_id, self.formal.id)
        self.assertTrue(items[0].is_preferred)

    def test_keyword_searches_only_canonical_and_explicit_light_text(self) -> None:
        matches = self.library.search("solid electrolyte").items
        self.assertEqual([item.work_id for item in matches], [self.target.work_id])
        self.assertEqual(self.library.search("hidden observation").items, ())
        self.assertEqual(self.library.search("NEVER-EXPORT").items, ())

    def test_keyword_treats_percent_underscore_and_backslash_literally(self) -> None:
        self.assertEqual([item.work_id for item in self.library.search("100%").items], [self.literal.work_id])
        self.assertEqual([item.work_id for item in self.library.search("Under_score").items], [self.literal.work_id])
        self.assertEqual([item.work_id for item in self.library.search(r"Back\slash").items], [self.literal.work_id])
        self.assertEqual({item.work_id for item in self.library.search("%").items}, {
            self.literal.work_id,
        })
        self.assertEqual({item.work_id for item in self.library.search("_").items}, {
            self.ambiguous_one.work_id, self.literal.work_id,
        })

    def test_each_filter_and_combined_filters_use_normalized_exact_values(self) -> None:
        filters = (
            LibraryFilters(author="ADA LOVELACE"),
            LibraryFilters(publication_year=2024),
            LibraryFilters(publisher="ＳＣＩ—ＰＲＥＳＳ"),
            LibraryFilters(venue="j energy"),
            LibraryFilters(tag="BATTERY"),
            LibraryFilters(author="ada lovelace", publication_year=2024,
                           publisher="Science Press", venue="Journal of Energy",
                           tag="battery materials"),
        )
        for filter_value in filters:
            with self.subTest(filter_value=filter_value):
                self.assertEqual([item.work_id for item in self.library.search(filters=filter_value).items],
                                 [self.target.work_id])
        self.assertEqual(self.library.search(filters=LibraryFilters(
            author="Ada Lovelace", publication_year=2023,
        )).items, ())

    def test_references_and_cited_by_are_one_hop_and_preferred_version_based(self) -> None:
        references = self.library.references(work_id=self.target.work_id).items
        self.assertEqual([item.work_id for item in references], [
            self.ambiguous_one.work_id, self.ambiguous_two.work_id,
        ])
        self.assertEqual(self.library.references(work_version_id=self.preprint.id).items, ())
        cited_by = self.library.cited_by(self.target.work_id).items
        self.assertEqual({item.work_id for item in cited_by}, {
            self.formal.work_id, self.citing_formal.work_id,
        })
        source = next(item for item in cited_by if item.work_id == self.formal.work_id)
        self.assertEqual(source.work_version_id, self.formal.id)

    def test_cited_by_from_nonpreferred_version_returns_preferred_version(self) -> None:
        cited_by = self.library.cited_by(self.target.work_id).items
        citing = next(item for item in cited_by if item.work_id == self.citing_preprint.work_id)
        self.assertEqual(citing.work_version_id, self.citing_formal.id)
        self.assertTrue(citing.is_preferred)

    def test_empty_order_limit_and_selector_validation(self) -> None:
        self.assertEqual(self.library.search("no such value").items, ())
        all_items = self.library.search().items
        self.assertEqual(all_items, self.library.search().items)
        self.assertEqual(self.library.search(limit=2).items, all_items[:2])
        for bad_limit in (0, -1, True):
            with self.subTest(limit=bad_limit), self.assertRaises((TypeError, ValueError)):
                self.library.search(limit=bad_limit)
        with self.assertRaises(TypeError):
            self.library.search(limit=cast(int, 1.5))
        with self.assertRaisesRegex(ValueError, "exactly one"):
            self.library.exact_lookup()
        with self.assertRaisesRegex(ValueError, "exactly one"):
            self.library.exact_lookup(doi="10.1000/target", title="x")
        with self.assertRaisesRegex(ValueError, "canonical lowercase UUID"):
            self.library.exact_lookup(work_id="not-a-uuid")

    def test_safe_export_is_deterministic_and_has_no_backend_leakage(self) -> None:
        result = self.library.exact_lookup(
            work_id=self.target.work_id, include_light_content=True,
        )
        row = result.to_rows()[0]
        self.assertEqual(row["authors"], ["Ada Lovelace"])
        self.assertEqual(row["publisher"], "Science Press")
        self.assertEqual(row["venue"], "Journal of Energy")
        self.assertEqual(row["tags"], ["battery materials"])
        self.assertEqual(len(cast(list[object], row["light_content"])), 0)
        self.assertEqual(result.to_json(), result.to_json())
        self.assertEqual(json.loads(result.to_json()), list(result.to_rows()))
        self.assertEqual([json.loads(line) for line in result.to_jsonl().splitlines()], list(result.to_rows()))
        serialized = result.to_json()
        forbidden = (
            "SECRET-RECORD", "SECRET-HASH",
            "NEVER-EXPORT", "provider_record_id", "provenance_json", "storage_path",
            "sha256", "content_json", "raw_reference", "locator_json",
        )
        for value in forbidden:
            self.assertNotIn(value, serialized)

    def test_queries_accept_read_only_engine_without_mutating_rows(self) -> None:
        before = self.counts()
        self.library.exact_lookup(doi="10.1000/target", include_light_content=True)
        self.library.search("solid electrolyte", filters=LibraryFilters(publication_year=2024))
        self.library.references(work_id=self.target.work_id)
        self.library.cited_by(self.target.work_id)
        self.assertEqual(self.counts(), before)


if __name__ == "__main__":
    import unittest

    unittest.main()
