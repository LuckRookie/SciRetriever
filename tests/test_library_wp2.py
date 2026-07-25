from library_wp2_fixture import *


class LibraryWp2Tests(LibraryWp2Fixture):
    def test_exact_doi_work_id_and_nonpreferred_version_id(self) -> None:
        by_doi = self.library.exact_lookup(doi=" DOI:10.1000/TARGET ").items
        by_work = self.library.exact_lookup(work_id=self.target.work_id).items
        by_version = self.library.exact_lookup(work_version_id=self.preprint.id).items
        self.assertEqual(by_doi[0].work_id, self.target.work_id)
        self.assertEqual(by_doi[0].work_version_id, self.target.id)
        self.assertEqual(by_doi[0].identifiers, (
            Identifier("doi", "10.1000/target"),
            Identifier("pmid", "12345678"),
            Identifier("arxiv", "2401.00001"),
        ))
        self.assertEqual(by_work[0].work_version_id, self.target.id)
        self.assertEqual(
            self.library.exact_lookup(doi="10.1000/preprint").items[0].work_version_id,
            self.preprint.id,
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
