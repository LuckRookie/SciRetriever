import importlib
import sys
from enum import Enum
from pathlib import Path
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

enums = importlib.import_module("sciretriever.core.enums")
errors = importlib.import_module("sciretriever.errors")


class EnumTests(TestCase):
    ENUM_VALUES = {
        enums.AssetRole: ("primary_pdf", "supplementary_pdf", "xml", "html"),
        enums.JobState: (
            "pending",
            "active",
            "retryable",
            "paused",
            "succeeded",
            "failed",
            "cancelled",
        ),
        enums.AttemptOutcome: ("succeeded", "failed", "retryable", "cancelled"),
        enums.ProcessingStage: (
            "raw_acceptance",
            "normalization",
            "enrichment",
            "package_validation",
            "publication",
        ),
        enums.PackageQuality: ("pdf_backed", "limited_xml_html"),
        enums.DomainRunStatus: (
            "pending",
            "active",
            "succeeded",
            "failed",
            "cancelled",
        ),
    }

    def test_exact_stable_string_values(self) -> None:
        for enum_type, expected in self.ENUM_VALUES.items():
            with self.subTest(enum=enum_type.__name__):
                self.assertTrue(issubclass(enum_type, str))
                self.assertTrue(issubclass(enum_type, Enum))
                self.assertEqual(tuple(member.value for member in enum_type), expected)
                self.assertTrue(all(member == member.value for member in enum_type))

    def test_nonterminal_job_states_are_exact_and_frozen(self) -> None:
        expected = frozenset(
            {
                enums.JobState.PENDING,
                enums.JobState.ACTIVE,
                enums.JobState.RETRYABLE,
                enums.JobState.PAUSED,
            }
        )
        self.assertIsInstance(enums.NONTERMINAL_JOB_STATES, frozenset)
        self.assertEqual(enums.NONTERMINAL_JOB_STATES, expected)
        self.assertTrue(
            enums.NONTERMINAL_JOB_STATES.isdisjoint(
                {
                    enums.JobState.SUCCEEDED,
                    enums.JobState.FAILED,
                    enums.JobState.CANCELLED,
                }
            )
        )

    def test_enum_names_and_values_exclude_domain_vocabulary(self) -> None:
        forbidden = {"reaction", "molecule", "route", "yield", "confidence", "priority", "score"}
        for enum_type in self.ENUM_VALUES:
            vocabulary = {enum_type.__name__.lower()}
            vocabulary.update(member.name.lower() for member in enum_type)
            vocabulary.update(member.value.lower() for member in enum_type)
            with self.subTest(enum=enum_type.__name__):
                self.assertTrue(forbidden.isdisjoint(vocabulary))


class ErrorTests(TestCase):
    ERROR_NAMES = (
        "SearchError",
        "DownloadError",
        "RetryError",
        "RateLimitError",
        "AuthenticationError",
        "ParseError",
        "ValidationError",
        "AcquisitionError",
        "NormalizationError",
        "PackagingError",
        "CatalogError",
    )

    def test_neutral_errors_inherit_directly_from_base(self) -> None:
        self.assertTrue(issubclass(errors.ConfigError, errors.SciRetrieverError))
        for name in self.ERROR_NAMES:
            error_type = getattr(errors, name)
            with self.subTest(error=name):
                self.assertEqual(error_type.__bases__, (errors.SciRetrieverError,))

    def test_error_names_exclude_domain_vocabulary(self) -> None:
        forbidden = ("reaction", "molecule", "route", "yield", "confidence", "priority", "score")
        for name in self.ERROR_NAMES:
            with self.subTest(error=name):
                self.assertFalse(any(word in name.lower() for word in forbidden))


if __name__ == "__main__":
    import unittest

    unittest.main()
