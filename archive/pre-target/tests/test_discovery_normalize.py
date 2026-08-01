import sys
from dataclasses import FrozenInstanceError
from pathlib import Path
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.discovery.models import Candidate, MergedCandidate, ProviderRecord
from sciretriever.discovery.normalize import clean_text, normalize_record, normalize_records


class DiscoveryNormalizationTests(TestCase):
    def test_markup_unicode_controls_entities_and_whitespace_are_cleaned(self) -> None:
        record = ProviderRecord(
            "crossref",
            1,
            (("doi", " HTTPS://DOI.ORG/10.1000/Example "),),
            title="  <b>Ｆｕｌｌ</b>&nbsp; title\x00\n ",
            abstract="<p>A &amp; B</p><p>second</p>",
            authors=(" Ada\tLovelace ", "ada lovelace", "", "Grace Hopper"),
            venue=" <i>Journal</i> ",
            keywords=(" Machine Learning ", "machine learning", "AI"),
        )
        candidate = normalize_record(record)
        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate.metadata.title, "Full title")
        self.assertEqual(candidate.metadata.abstract, "A & B second")
        self.assertEqual(candidate.metadata.authors, ("Ada Lovelace", "Grace Hopper"))
        self.assertEqual(candidate.metadata.venue, "Journal")
        self.assertEqual(candidate.metadata.keywords, ("Machine Learning", "AI"))
        self.assertEqual(candidate.identifiers[0].value, "10.1000/example")
        self.assertEqual(clean_text("<span> </span>"), None)

    def test_invalid_identifiers_are_skipped_but_title_only_record_survives(self) -> None:
        record = ProviderRecord(
            "custom", 2, (("doi", "doi: "), ("arxiv", "arXiv: ")), title=" Valid title "
        )
        candidate = normalize_record(record)
        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate.identifiers, ())
        self.assertEqual(candidate.metadata.title, "Valid title")

    def test_records_without_title_or_valid_identifier_are_dropped(self) -> None:
        records = (
            ProviderRecord("custom", 1, (("doi", " "),), title="<b> </b>"),
            ProviderRecord("custom", 2, (("pmid", "123"),), title=None),
        )
        normalized = normalize_records(records)
        self.assertEqual(len(normalized), 1)
        self.assertIsNone(normalized[0].metadata.title)
        self.assertEqual(normalized[0].identifiers[0].value, "123")

    def test_identifiers_have_stable_namespace_order_and_duplicates_collapse(self) -> None:
        record = ProviderRecord(
            "custom",
            1,
            (
                ("url", "https://example.test/paper"),
                ("arxiv", "2401.00001"),
                ("pmid", "9"),
                ("doi", "10.1/X"),
                ("doi", "https://doi.org/10.1/x"),
                ("custom", "A"),
            ),
        )
        candidate = normalize_record(record)
        assert candidate is not None
        self.assertEqual(
            tuple(identifier.namespace for identifier in candidate.identifiers),
            ("doi", "pmid", "arxiv", "url", "custom"),
        )

    def test_public_candidate_records_are_frozen_and_slotted(self) -> None:
        candidate = normalize_record(ProviderRecord("custom", 1, (), title="Title"))
        assert candidate is not None
        self.assertIsInstance(candidate, Candidate)
        self.assertFalse(hasattr(candidate, "__dict__"))
        with self.assertRaises(FrozenInstanceError):
            setattr(candidate, "rank", 3)
        self.assertFalse(hasattr(MergedCandidate, "__dict__") and hasattr(candidate, "unexpected"))


if __name__ == "__main__":
    import unittest

    unittest.main()
