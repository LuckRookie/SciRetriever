import importlib
import sqlite3
import sys
from dataclasses import FrozenInstanceError
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import (
    CatalogRepository,
    IdentityResolver,
    ReadOnlyCatalogView,
    apply_migrations,
    create_catalog_engine,
    open_read_only_catalog_engine,
)
from sciretriever.core.contracts import CandidateMetadata, Identifier
from sciretriever.discovery.models import MergedCandidate


labeling = importlib.import_module("sciretriever.discovery.labeling")
CatalogLabelDecision = labeling.CatalogLabelDecision
KeywordRuleLabeler = labeling.KeywordRuleLabeler
LabelInput = labeling.LabelInput
LabelResult = labeling.LabelResult
LabeledCandidate = labeling.LabeledCandidate
Labeler = labeling.Labeler
apply_label_decision = labeling.apply_label_decision
compare_candidate_with_catalog = labeling.compare_candidate_with_catalog
label_candidate = labeling.label_candidate
label_input_sha256 = labeling.label_input_sha256


def assign_attribute(value: object, name: str, replacement: object) -> None:
    setattr(value, name, replacement)


class SpyLabeler:
    def __init__(
        self,
        result: LabelResult = LabelResult(("live",)),
        *,
        taxonomy: str = "topic",
        taxonomy_version: str = "v1",
    ) -> None:
        self.taxonomy = taxonomy
        self.taxonomy_version = taxonomy_version
        self.result = result
        self.calls: list[LabelInput] = []

    def label(self, label_input: LabelInput) -> LabelResult:
        self.calls.append(label_input)
        return self.result


def merged_candidate(
    identifiers: tuple[Identifier, ...] = (),
    *,
    title: str | None = "Title",
    abstract: str | None = "Abstract",
    reasons: tuple[str, ...] = (),
) -> MergedCandidate:
    return MergedCandidate(
        identifiers,
        CandidateMetadata(title, abstract, ("Author",), 2026, "Venue", ("ignored",)),
        ("test-provider",),
        (("test-provider", 1),),
        bool(reasons),
        reasons,
    )


class LabelValueTests(TestCase):
    def test_value_types_are_frozen_and_protocol_is_structural(self) -> None:
        label_input = LabelInput("Title", None)
        result = LabelResult((" beta ", "alpha", "Beta", "Alpha"), True, "manual review")
        self.assertEqual(result.labels, ("Alpha", "Beta"))
        self.assertIsInstance(SpyLabeler(), Labeler)
        with self.assertRaises(FrozenInstanceError):
            assign_attribute(label_input, "title", "Changed")
        with self.assertRaises(FrozenInstanceError):
            assign_attribute(result, "labels", ())
        with self.assertRaises(ValueError):
            LabelResult(("one",), False, "unexpected")
        with self.assertRaises(ValueError):
            LabelResult((" ",))

    def test_hash_uses_only_exact_title_and_abstract_canonical_json(self) -> None:
        vectors = (
            (
                CandidateMetadata(),
                "f0738b7a419b50a38d05599f91a7b0ddbd5616eeb2fcc5be8ac7faf4e9265aea",
            ),
            (
                CandidateMetadata("Café 文献", "βeta abstract"),
                "39a834789f7d9276b8388f58ed9b34641e74f4eb7cc77b4cb212cc9529235f1a",
            ),
            (
                CandidateMetadata("Title", "Abstract"),
                "12a57891712762069ea64203675b1c3c163daf06fe9a2ab8ea87630c61ceca62",
            ),
        )
        for metadata, expected in vectors:
            with self.subTest(metadata=metadata):
                self.assertEqual(label_input_sha256(metadata), expected)

        changed_extras = CandidateMetadata(
            "Title", "Abstract", ("Different",), 1999, "Elsewhere", ("keyword",)
        )
        self.assertEqual(label_input_sha256(changed_extras), vectors[2][1])

    def test_keyword_rules_are_normalized_literal_and_order_independent(self) -> None:
        first = KeywordRuleLabeler(
            " topics ",
            " 1 ",
            {
                "Zulu": ("not present", "ＫＥＹ  word"),
                "Alpha": ("café",),
                " alpha ": ("CAFÉ",),
            },
        )
        second = KeywordRuleLabeler(
            "topics", "1", {" alpha ": ("café",), "Zulu": ("key word",), "Alpha": ("CAFÉ",)}
        )
        value = LabelInput("A CAFE\u0301 result", "Contains key\tword exactly")
        self.assertEqual(first.label(value), LabelResult(("Alpha", "Zulu")))
        self.assertEqual(second.label(value), first.label(value))
        self.assertEqual(first.taxonomy, "topics")
        self.assertEqual(first.taxonomy_version, "1")
        self.assertEqual(KeywordRuleLabeler("t", "v", {}).label(value), LabelResult(()))

    def test_custom_and_final_labels_are_case_insensitive_and_order_independent(self) -> None:
        first = LabelResult(("beta", " Alpha ", "alpha", "Beta"))
        second = LabelResult(tuple(reversed(("beta", " Alpha ", "alpha", "Beta"))))
        self.assertEqual(first.labels, ("Alpha", "Beta"))
        self.assertEqual(second, first)

        candidate = merged_candidate()
        labeled = LabeledCandidate(
            candidate.identifiers,
            candidate.metadata,
            candidate.providers,
            candidate.source_ranks,
            ("gamma", " Gamma ", "ALPHA", "alpha"),
            False,
            (),
        )
        self.assertEqual(labeled.labels, ("ALPHA", "Gamma"))

    def test_keyword_rules_reject_blank_configuration_values(self) -> None:
        invalid = (
            (" ", "v", {}),
            ("t", " ", {}),
            ("t", "v", {" ": ("term",)}),
            ("t", "v", {"label": (" ",)}),
        )
        for taxonomy, version, rules in invalid:
            with self.subTest(taxonomy=taxonomy, version=version, rules=rules):
                with self.assertRaises(ValueError):
                    KeywordRuleLabeler(taxonomy, version, rules)
        with self.assertRaises(TypeError):
            KeywordRuleLabeler("t", "v", {"label": "term"})


class CatalogLabelReuseTests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.path = Path(self.temporary_directory.name) / "catalog.sqlite"
        self.catalog = create_catalog_engine(self.path)
        apply_migrations(self.catalog)
        self.repository = CatalogRepository(self.catalog)
        self.resolver = IdentityResolver(self.repository)

    def open_view(self) -> ReadOnlyCatalogView:
        self.catalog.dispose()
        engine = open_read_only_catalog_engine(self.path)
        self.addCleanup(engine.dispose)
        return ReadOnlyCatalogView(engine)

    def counts(self) -> tuple[int, int, int]:
        with sqlite3.connect(self.path) as connection:
            return tuple(
                connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                for table in ("works", "identifiers", "metadata_labels")
            )

    def create_work(self, identifiers: tuple[Identifier, ...]) -> str:
        resolution = self.resolver.create_or_reuse_work(identifiers)
        return resolution.work.id

    def test_no_catalog_work_calls_labeler_and_preserves_merged_review_reason(self) -> None:
        candidate = merged_candidate(abstract=None, reasons=("missing_abstract",))
        spy = SpyLabeler(LabelResult(("offline",), True, "uncertain_label"))
        result = label_candidate(candidate, self.open_view(), spy)
        self.assertIsInstance(result, LabeledCandidate)
        self.assertEqual(spy.calls, [LabelInput("Title", None)])
        self.assertEqual(result.labels, ("offline",))
        self.assertEqual(result.review_reasons, ("missing_abstract", "uncertain_label"))
        self.assertEqual(result.review_reason, "missing_abstract; uncertain_label")
        self.assertTrue(result.needs_review)

    def test_exact_cache_hit_reuses_stable_labels_without_writes_or_labeler_call(self) -> None:
        doi = Identifier("doi", "10.1000/cached")
        pmid = Identifier("pmid", "42")
        work_id = self.create_work((doi, pmid))
        candidate = merged_candidate((pmid, doi))
        digest = label_input_sha256(candidate.metadata)
        self.repository.add_metadata_label(work_id, "topic", "v1", digest, "zeta")
        self.repository.add_metadata_label(work_id, "topic", "v1", digest, "Alpha")
        self.repository.add_metadata_label(work_id, "topic", "v1", digest, " alpha ")
        self.repository.add_metadata_label(work_id, "topic", "v1", digest, "ZETA")
        before_counts = self.counts()
        with self.catalog.connect() as connection:
            connection.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)").one()
        self.catalog.dispose()
        before_bytes = self.path.read_bytes()
        engine = open_read_only_catalog_engine(self.path)
        view = ReadOnlyCatalogView(engine)
        spy = SpyLabeler()

        result = label_candidate(candidate, view, spy)
        engine.dispose()

        self.assertEqual(result.labels, ("Alpha", "ZETA"))
        self.assertEqual(spy.calls, [])
        self.assertEqual(self.path.read_bytes(), before_bytes)
        self.assertEqual(self.counts(), before_counts)

    def test_explicit_compare_and_apply_cache_hit_bypasses_labeler(self) -> None:
        doi = Identifier("doi", "10.1000/decision")
        work_id = self.create_work((doi,))
        candidate = merged_candidate((doi,), reasons=("existing_reason",))
        self.repository.add_metadata_label(
            work_id,
            "topic",
            "v1",
            label_input_sha256(candidate.metadata),
            "cached",
        )
        spy = SpyLabeler()

        decision = compare_candidate_with_catalog(candidate, self.open_view(), spy)
        self.assertIsInstance(decision, CatalogLabelDecision)
        self.assertEqual(decision.cached_labels, ("cached",))
        self.assertEqual(decision.review_reasons, ("existing_reason",))
        self.assertEqual(spy.calls, [])
        with self.assertRaises(FrozenInstanceError):
            assign_attribute(decision, "taxonomy", "changed")

        result = apply_label_decision(decision, spy)
        self.assertEqual(result.labels, ("cached",))
        self.assertEqual(spy.calls, [])
        with self.assertRaisesRegex(ValueError, "taxonomy and version"):
            apply_label_decision(decision, SpyLabeler(taxonomy_version="v2"))

    def test_cache_key_changes_miss_and_call_labeler(self) -> None:
        doi = Identifier("doi", "10.1000/key")
        work_id = self.create_work((doi,))
        original = merged_candidate((doi,))
        digest = label_input_sha256(original.metadata)
        self.repository.add_metadata_label(work_id, "topic", "v1", digest, "cached")
        view = self.open_view()

        cases = (
            (original, SpyLabeler(taxonomy="other")),
            (original, SpyLabeler(taxonomy_version="v2")),
            (merged_candidate((doi,), title="Changed"), SpyLabeler()),
            (merged_candidate((doi,), abstract="Changed"), SpyLabeler()),
        )
        for candidate, spy in cases:
            with self.subTest(candidate=candidate, taxonomy=spy.taxonomy, version=spy.taxonomy_version):
                result = label_candidate(candidate, view, spy)
                self.assertEqual(result.labels, ("live",))
                self.assertEqual(len(spy.calls), 1)

    def test_multiple_identifiers_for_one_work_still_reuse_cache(self) -> None:
        identifiers = (Identifier("doi", "10.1000/same"), Identifier("pmid", "77"))
        work_id = self.create_work(identifiers)
        candidate = merged_candidate(tuple(reversed(identifiers)))
        self.repository.add_metadata_label(
            work_id, "topic", "v1", label_input_sha256(candidate.metadata), "cached"
        )
        spy = SpyLabeler()
        result = label_candidate(candidate, self.open_view(), spy)
        self.assertEqual(result.labels, ("cached",))
        self.assertEqual(spy.calls, [])
        self.assertNotIn("catalog_identifier_conflict", result.review_reasons)

    def test_multiple_catalog_works_call_labeler_and_mark_conflict(self) -> None:
        doi = Identifier("doi", "10.1000/one")
        pmid = Identifier("pmid", "88")
        self.create_work((doi,))
        self.create_work((pmid,))
        spy = SpyLabeler()
        result = label_candidate(merged_candidate((pmid, doi)), self.open_view(), spy)
        self.assertEqual(len(spy.calls), 1)
        self.assertEqual(result.labels, ("live",))
        self.assertEqual(result.review_reasons, ("catalog_identifier_conflict",))
        self.assertTrue(result.needs_review)

    def test_cached_review_flags_and_mixed_states_are_deterministic(self) -> None:
        doi = Identifier("doi", "10.1000/review")
        work_id = self.create_work((doi,))
        candidate = merged_candidate((doi,), reasons=("existing_reason",))
        digest = label_input_sha256(candidate.metadata)
        self.repository.add_metadata_label(
            work_id, "topic", "v1", digest, "reviewed", needs_review=True
        )
        self.repository.add_metadata_label(work_id, "topic", "v1", digest, "clear")
        spy = SpyLabeler()
        result = label_candidate(candidate, self.open_view(), spy)
        self.assertEqual(spy.calls, [])
        self.assertEqual(result.labels, ("clear", "reviewed"))
        self.assertEqual(
            result.review_reasons,
            (
                "catalog_cached_label_needs_review",
                "catalog_cached_label_review_conflict",
                "existing_reason",
            ),
        )


if __name__ == "__main__":
    import unittest

    unittest.main()
