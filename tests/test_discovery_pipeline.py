import sqlite3
import sys
from collections.abc import Mapping
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import (
    ReadOnlyCatalogView,
    apply_migrations,
    create_catalog_engine,
    open_read_only_catalog_engine,
)
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.records import WorkRecord
from sciretriever.core.contracts import Identifier, SearchSpec
from sciretriever.discovery.labeling import LabelInput, LabelResult
from sciretriever.discovery.manifest import discover_to_jsonl
from sciretriever.discovery.models import ProviderRecord
from sciretriever.discovery.pipeline import discover


RUN_ID = "00000000-0000-4000-8000-000000000001"
RETRIEVED_AT = "2026-07-20T12:00:00Z"


class Provider:
    def __init__(self, name, records, events=None, error=None):
        self.name = name
        self.records = tuple(records)
        self.events = events
        self.error = error

    def search(self, spec):
        if self.events is not None:
            self.events.append(f"search:{self.name}")
        if self.error is not None:
            raise self.error
        return self.records


class Labeler:
    taxonomy = "topic"
    taxonomy_version = "1"

    def __init__(self, events=None, result=LabelResult(("selected",)), error=None):
        self.events = events
        self.result = result
        self.error = error
        self.calls = []

    def label(self, label_input: LabelInput) -> LabelResult:
        if self.events is not None:
            self.events.append("label")
        self.calls.append(label_input)
        if self.error is not None:
            raise self.error
        return self.result


class InstrumentedCatalog(ReadOnlyCatalogView):
    def __init__(
        self,
        catalog: CatalogEngine,
        events: list[str],
        *,
        fail_on: str | None = None,
    ) -> None:
        super().__init__(catalog)
        self.events = events
        self.fail_on = fail_on

    def lookup_work(
        self,
        identifier: Identifier | Mapping[str, object],
    ) -> WorkRecord | None:
        normalized = identifier if isinstance(identifier, Identifier) else Identifier.from_dict(identifier)
        self.events.append(f"catalog:{normalized.value}")
        if normalized.value == self.fail_on:
            raise RuntimeError("catalog failed")
        return super().lookup_work(normalized)


def record(provider, rank, doi, title, abstract: str | None = "Abstract"):
    return ProviderRecord(
        provider,
        rank,
        (("doi", doi),),
        title=title,
        abstract=abstract,
        authors=("Author",),
        year=2026,
        venue="Venue",
    )


class DiscoveryPipelineTests(TestCase):
    def setUp(self):
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.catalog_path = Path(self.temporary_directory.name) / "catalog.sqlite"
        writable = create_catalog_engine(self.catalog_path)
        apply_migrations(writable)
        writable.dispose()
        engine = open_read_only_catalog_engine(self.catalog_path)
        self.addCleanup(engine.dispose)
        self.catalog = ReadOnlyCatalogView(engine)

    def run_discover(self, spec, providers, labeler=None):
        return discover(
            spec,
            providers=providers,
            catalog=self.catalog,
            labeler=labeler or Labeler(),
            intake_run_id=RUN_ID,
            retrieved_at=RETRIEVED_AT,
        )

    def instrumented_catalog(
        self,
        events: list[str],
        *,
        fail_on: str | None = None,
    ) -> InstrumentedCatalog:
        engine = open_read_only_catalog_engine(self.catalog_path)
        self.addCleanup(engine.dispose)
        return InstrumentedCatalog(engine, events, fail_on=fail_on)

    def test_all_searches_finish_before_labeling_and_duplicates_label_once(self):
        events = []
        duplicate = record("crossref", 1, "10.1/same", "Same")
        providers = {
            "arxiv": Provider("arxiv", (record("arxiv", 2, "10.1/other", "Other"),), events),
            "crossref": Provider("crossref", (duplicate,), events),
            "europe-pmc": Provider(
                "europe-pmc", (record("europe-pmc", 1, "10.1/same", "Same"),), events
            ),
        }
        labeler = Labeler(events)
        entries = self.run_discover(
            SearchSpec("query", ("arxiv", "europe-pmc", "crossref"), 10),
            providers,
            labeler,
        )
        self.assertEqual(events[:3], ["search:crossref", "search:europe-pmc", "search:arxiv"])
        self.assertEqual(events[3:], ["label", "label"])
        self.assertEqual(len(entries), 2)
        self.assertEqual(len(labeler.calls), 2)

    def test_all_catalog_comparisons_finish_before_any_label(self):
        events = []
        labeler = Labeler(events)
        self.catalog = self.instrumented_catalog(events)

        entries = self.run_discover(
            SearchSpec("query", ("crossref",), 2),
            {
                "crossref": Provider(
                    "crossref",
                    (
                        record("crossref", 1, "10.1/a", "Alpha"),
                        record("crossref", 2, "10.1/b", "Beta"),
                    ),
                )
            },
            labeler,
        )

        self.assertEqual(events, ["catalog:10.1/a", "catalog:10.1/b", "label", "label"])
        self.assertEqual(len(entries), 2)

    def test_second_catalog_failure_causes_zero_label_calls(self):
        events = []
        labeler = Labeler(events)
        self.catalog = self.instrumented_catalog(events, fail_on="10.1/b")

        with self.assertRaisesRegex(RuntimeError, "catalog failed"):
            self.run_discover(
                SearchSpec("query", ("crossref",), 2),
                {
                    "crossref": Provider(
                        "crossref",
                        (
                            record("crossref", 1, "10.1/a", "Alpha"),
                            record("crossref", 2, "10.1/b", "Beta"),
                        ),
                    )
                },
                labeler,
            )

        self.assertEqual(events, ["catalog:10.1/a", "catalog:10.1/b"])
        self.assertEqual(labeler.calls, [])

    def test_global_limit_is_applied_after_merge_and_stable_sort(self):
        providers = {
            "arxiv": Provider("arxiv", (record("arxiv", 1, "10.1/a", "Arxiv first"),)),
            "crossref": Provider(
                "crossref",
                (
                    record("crossref", 2, "10.1/c2", "Crossref second"),
                    record("crossref", 1, "10.1/c1", "Crossref first"),
                ),
            ),
        }
        entries = self.run_discover(SearchSpec("query", ("arxiv", "crossref"), 2), providers)
        self.assertEqual(
            tuple(entry.identifiers[0].value for entry in entries),
            ("10.1/c1", "10.1/a"),
        )

    def test_missing_abstract_survives_and_combines_review_reasons(self):
        labeler = Labeler(result=LabelResult(("x",), True, "label_uncertain"))
        entries = self.run_discover(
            SearchSpec("query", ("crossref",), 1),
            {"crossref": Provider("crossref", (record("crossref", 1, "10.1/x", "Title", None),))},
            labeler,
        )
        self.assertTrue(entries[0].missing_abstract)
        self.assertTrue(entries[0].needs_review)
        self.assertEqual(entries[0].review_reason, "label_uncertain; missing_abstract")

    def test_missing_provider_and_failures_abort_without_manifest_replacement(self):
        output = Path(self.temporary_directory.name) / "manifest.jsonl"
        output.write_text("existing\n", encoding="utf-8")
        spec = SearchSpec("query", ("crossref", "arxiv"), 2)
        with self.assertRaisesRegex(ValueError, "missing discovery providers: arxiv"):
            self.run_discover(spec, {"crossref": Provider("crossref", ())})
        self.assertEqual(output.read_text(encoding="utf-8"), "existing\n")

        for provider, labeler in (
            (Provider("crossref", (), error=RuntimeError("search failed")), Labeler()),
            (Provider("crossref", (record("crossref", 1, "10.1/x", "Title"),)), Labeler(error=RuntimeError("label failed"))),
        ):
            with self.subTest(error=provider.error or labeler.error), self.assertRaises(RuntimeError):
                discover_to_jsonl(
                    SearchSpec("query", ("crossref",), 1),
                    output,
                    providers={"crossref": provider},
                    catalog=self.catalog,
                    labeler=labeler,
                    intake_run_id=RUN_ID,
                    retrieved_at=RETRIEVED_AT,
                )
            self.assertEqual(output.read_text(encoding="utf-8"), "existing\n")

    def test_mismatched_record_provider_preserves_existing_manifest(self):
        output = Path(self.temporary_directory.name) / "manifest.jsonl"
        output.write_text("existing\n", encoding="utf-8")
        labeler = Labeler()

        with self.assertRaisesRegex(
            ValueError,
            "provider 'crossref' returned a record for 'spoofed-source'",
        ):
            discover_to_jsonl(
                SearchSpec("query", ("crossref",), 1),
                output,
                providers={
                    "crossref": Provider(
                        "crossref",
                        (record("spoofed-source", 1, "10.1/x", "Title"),),
                    )
                },
                catalog=self.catalog,
                labeler=labeler,
                intake_run_id=RUN_ID,
                retrieved_at=RETRIEVED_AT,
            )

        self.assertEqual(labeler.calls, [])
        self.assertEqual(output.read_text(encoding="utf-8"), "existing\n")

    def test_provider_and_mapping_permutations_produce_identical_entries(self):
        first_records = (
            record("crossref", 1, "10.1/b", "Beta"),
            record("crossref", 1, "10.1/a", "Alpha"),
        )
        second_records = tuple(reversed(first_records))
        first = self.run_discover(
            SearchSpec("query", ("arxiv", "crossref"), 10),
            {
                "crossref": Provider("crossref", first_records),
                "arxiv": Provider("arxiv", (record("arxiv", 2, "10.1/z", "Zulu"),)),
            },
        )
        second = self.run_discover(
            SearchSpec("query", ("crossref", "arxiv"), 10),
            {
                "arxiv": Provider("arxiv", (record("arxiv", 2, "10.1/z", "Zulu"),)),
                "crossref": Provider("crossref", second_records),
            },
        )
        self.assertEqual(first, second)
        self.assertEqual(
            b"".join((entry.to_json_line() + "\n").encode() for entry in first),
            b"".join((entry.to_json_line() + "\n").encode() for entry in second),
        )

    def test_discovery_does_not_create_catalog_rows(self):
        def counts():
            with sqlite3.connect(self.catalog_path) as connection:
                return tuple(
                    connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                    for table in ("works", "identifiers", "metadata_labels")
                )

        before = counts()
        self.run_discover(
            SearchSpec("query", ("crossref",), 1),
            {"crossref": Provider("crossref", (record("crossref", 1, "10.1/x", "Title"),))},
        )
        self.assertEqual(counts(), before)


if __name__ == "__main__":
    import unittest

    unittest.main()
