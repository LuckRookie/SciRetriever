import itertools
import sys
from pathlib import Path
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.core.contracts import CandidateMetadata, Identifier
from sciretriever.discovery.dedup import deduplicate_candidates
from sciretriever.discovery.models import Candidate


def candidate(
    provider: str,
    rank: int,
    identifiers: tuple[tuple[str, str], ...] = (),
    *,
    title: str | None = None,
    abstract: str | None = None,
    authors: tuple[str, ...] = (),
    year: int | None = None,
    venue: str | None = None,
    keywords: tuple[str, ...] = (),
) -> Candidate:
    return Candidate(
        provider,
        rank,
        tuple(Identifier(namespace, value) for namespace, value in identifiers),
        CandidateMetadata(title, abstract, authors, year, venue, keywords),
    )


class DiscoveryDeduplicationTests(TestCase):
    def test_doi_chains_and_doi_pmid_intersections_merge_transitively(self) -> None:
        records = (
            candidate("crossref", 1, (("doi", "10.1/a"),), title="Paper"),
            candidate("europe-pmc", 2, (("doi", "10.1/a"), ("pmid", "7"))),
            candidate("arxiv", 3, (("pmid", "7"), ("arxiv", "2401.1"))),
        )
        result = deduplicate_candidates(records)
        self.assertEqual(len(result), 1)
        self.assertEqual(
            tuple((item.namespace, item.value) for item in result[0].identifiers),
            (("doi", "10.1/a"), ("pmid", "7"), ("arxiv", "2401.1")),
        )

    def test_title_only_record_enriches_safe_identifier_component(self) -> None:
        records = (
            candidate("crossref", 3, (("doi", "10.1/a"),), title="Same Paper", year=2020),
            candidate("europe-pmc", 1, title="same paper", abstract="Abstract", year=2020),
        )
        result = deduplicate_candidates(records)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].metadata.abstract, "Abstract")
        self.assertEqual(result[0].providers, ("crossref", "europe-pmc"))
        self.assertFalse(result[0].needs_review)

    def test_title_fallback_ignores_ascii_and_unicode_punctuation_and_symbols(self) -> None:
        records = (
            candidate(
                "crossref",
                1,
                (("doi", "10.1/a"),),
                title="A Study: Results",
                year=2020,
            ),
            candidate(
                "europe-pmc",
                1,
                title="Ａ study—results★",
                abstract="Available",
                year=2020,
            ),
            candidate("arxiv", 1, title="a study results", year=2020),
        )
        result = deduplicate_candidates(records)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].metadata.title, "A Study: Results")
        self.assertEqual(result[0].metadata.abstract, "Available")

    def test_same_title_conflicting_doi_or_year_marks_every_member_ambiguous(self) -> None:
        for second_id, second_year in (("10.1/b", 2020), ("10.1/a", 2021)):
            with self.subTest(second_id=second_id, second_year=second_year):
                records = (
                    candidate("crossref", 1, (("doi", "10.1/a"),), title="Same", year=2020),
                    candidate("arxiv", 1, (("doi", second_id),), title="same", year=second_year),
                )
                result = deduplicate_candidates(records)
                if second_id == "10.1/a":
                    self.assertEqual(len(result), 1)
                    self.assertNotIn("ambiguous_title_match", result[0].review_reasons)
                    self.assertIn("conflicting_year", result[0].review_reasons)
                else:
                    self.assertEqual(len(result), 2)
                    self.assertTrue(
                        all("ambiguous_title_match" in item.review_reasons for item in result)
                    )

        year_conflict = (
            candidate("crossref", 1, (("doi", "10.1/a"),), title="Year Same", year=2020),
            candidate("arxiv", 1, title="year same", year=2021),
        )
        result = deduplicate_candidates(year_conflict)
        self.assertEqual(len(result), 2)
        self.assertTrue(all("ambiguous_title_match" in item.review_reasons for item in result))

    def test_generic_title_with_doi_and_pmid_requires_author_corroboration(self) -> None:
        records = (
            candidate(
                "crossref",
                1,
                (("doi", "10.1/a"),),
                title="Editorial: Update",
                abstract="DOI abstract",
                authors=("Alice Example",),
                year=2020,
            ),
            candidate(
                "europe-pmc",
                1,
                (("pmid", "7"),),
                title="editorial update",
                abstract="PMID abstract",
                authors=("Bob Example",),
                year=2020,
            ),
        )
        result = deduplicate_candidates(records)
        self.assertEqual(len(result), 2)
        self.assertTrue(all("ambiguous_title_match" in item.review_reasons for item in result))

    def test_normalized_author_overlap_allows_doi_and_pmid_title_merge(self) -> None:
        records = (
            candidate(
                "crossref",
                1,
                (("doi", "10.1/a"),),
                title="Editorial: Update",
                abstract="DOI abstract",
                authors=("Alice Q. Example",),
                year=2020,
            ),
            candidate(
                "europe-pmc",
                1,
                (("pmid", "7"),),
                title="editorial update",
                abstract="PMID abstract",
                authors=("ＡＬＩＣＥ Q—EXAMPLE",),
                year=2020,
            ),
        )
        result = deduplicate_candidates(records)
        self.assertEqual(len(result), 1)
        self.assertEqual(
            tuple(identifier.namespace for identifier in result[0].identifiers),
            ("doi", "pmid"),
        )
        self.assertNotIn("ambiguous_title_match", result[0].review_reasons)

    def test_identifier_component_with_multiple_years_is_reviewed(self) -> None:
        records = (
            candidate(
                "crossref", 1, (("doi", "10.1/a"),),
                title="Paper", abstract="First", year=2020,
            ),
            candidate(
                "europe-pmc", 1, (("doi", "10.1/a"),),
                title="Paper", abstract="Second", year=2021,
            ),
        )
        result = deduplicate_candidates(records)
        self.assertEqual(len(result), 1)
        self.assertTrue(result[0].needs_review)
        self.assertEqual(result[0].review_reasons, ("conflicting_year",))

    def test_connected_component_with_two_dois_stays_merged_and_is_reviewed(self) -> None:
        records = (
            candidate("crossref", 1, (("doi", "10.1/a"), ("pmid", "7")), title="Paper"),
            candidate("europe-pmc", 1, (("doi", "10.1/b"), ("pmid", "7")), title="Paper"),
        )
        result = deduplicate_candidates(records)
        self.assertEqual(len(result), 1)
        self.assertIn("conflicting_strong_identifier", result[0].review_reasons)
        self.assertIn("missing_abstract", result[0].review_reasons)

    def test_component_uses_one_title_and_cannot_bridge_two_title_groups(self) -> None:
        records = (
            candidate("crossref", 1, (("doi", "10.1/a"),), title="Canonical: Study"),
            candidate("europe-pmc", 1, (("doi", "10.1/a"),), title="Bridge—Title"),
            candidate("custom", 1, title="bridge title", abstract="Other"),
        )
        result = deduplicate_candidates(records)
        self.assertEqual(len(result), 2)
        self.assertEqual(
            {item.metadata.title for item in result},
            {"Canonical: Study", "bridge title"},
        )

    def test_field_precedence_and_keyword_union(self) -> None:
        records = (
            candidate(
                "arxiv", 1, (("doi", "10.1/a"),), title="Arxiv title",
                abstract="Arxiv abstract", authors=("Arxiv Author",), year=2018,
                venue="Arxiv", keywords=("Machine Learning", "Chemistry"),
            ),
            candidate(
                "crossref", 9, (("doi", "10.1/a"),), title="Crossref title",
                abstract="Crossref abstract", authors=("Crossref Author",), year=2020,
                venue="Journal", keywords=("machine learning",),
            ),
            candidate(
                "europe-pmc", 5, (("doi", "10.1/a"),), title="PMC title",
                abstract="PMC abstract", authors=("PMC Author",), year=2019,
                venue="PMC", keywords=("Biology",),
            ),
        )
        merged = deduplicate_candidates(records)[0]
        self.assertEqual(merged.metadata.title, "Crossref title")
        self.assertEqual(merged.metadata.abstract, "PMC abstract")
        self.assertEqual(merged.metadata.authors, ("Crossref Author",))
        self.assertEqual(merged.metadata.year, 2020)
        self.assertEqual(merged.metadata.venue, "Journal")
        self.assertEqual(merged.metadata.keywords, ("Biology", "Chemistry", "machine learning"))

    def test_output_is_equal_for_every_input_permutation(self) -> None:
        records = (
            candidate("crossref", 2, (("doi", "10.1/a"),), title="Alpha", year=2020),
            candidate("europe-pmc", 1, (("doi", "10.1/a"), ("pmid", "1")), abstract="A"),
            candidate("arxiv", 3, title="alpha", keywords=("One",)),
            candidate("crossref", 1, (("doi", "10.1/b"),), title="Beta"),
            candidate("custom-z", 4, title="Gamma"),
        )
        expected = deduplicate_candidates(records)
        for permutation in itertools.permutations(records):
            self.assertEqual(deduplicate_candidates(permutation), expected)


if __name__ == "__main__":
    import unittest

    unittest.main()
