from pathlib import Path
import sys
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.core.package import NormalizedContent, SectionRecord
from sciretriever.enrichment import build_summary_input, deterministic_summary, normalize_tags


class EnrichmentTests(TestCase):
    def content(self) -> NormalizedContent:
        return NormalizedContent(
            "00000000-0000-4000-8000-000000000001",
            (
                SectionRecord("00000000-0000-4000-8000-000000000002", None, 0, "Methods", "Repeated block"),
                SectionRecord("00000000-0000-4000-8000-000000000003", None, 1, " Results ", "Repeated   block"),
            ), (), (),
        )

    def test_cleaning_dedup_fallback_and_tags_are_deterministic(self) -> None:
        content = self.content()
        projection = build_summary_input(content)
        self.assertEqual(projection.count("Repeated block"), 1)
        self.assertEqual(deterministic_summary(content, 20), "Methods\n\nRepeated")
        self.assertEqual(normalize_tags((" Results ", "methods", "METHODS")), ("methods", "results"))


if __name__ == "__main__":
    import unittest
    unittest.main()
