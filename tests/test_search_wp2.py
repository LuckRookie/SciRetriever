import json
import os
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier, Event
from time import monotonic
from typing import Any
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import (
    MetadataIngestionObservation,
    RegistryRepository,
    WorkRepository,
    create_catalog_engine,
    initialize_catalog,
)
from sciretriever.core.contracts import Identifier, SearchSpec
from sciretriever.discovery import (
    MetadataSearchRequest,
    MetadataSearchService,
    ProviderRecord,
)
from sciretriever.errors import CatalogError, SearchError


class FakeProvider:
    def __init__(self, name, records=(), *, barrier=None, error=None):
        self.name = name
        self.records = tuple(records)
        self.barrier = barrier
        self.error = error
        self.specs = []

    def search(self, spec: SearchSpec):
        self.specs.append(spec)
        if self.barrier is not None:
            self.barrier.wait(timeout=2)
        if self.error is not None:
            raise self.error
        return self.records


class OrderedProvider(FakeProvider):
    def __init__(self, name, records, barrier, release, *, finishes_first):
        super().__init__(name, records, barrier=barrier)
        self.release = release
        self.finishes_first = finishes_first

    def search(self, spec: SearchSpec):
        self.specs.append(spec)
        self.barrier.wait(timeout=2)
        if self.finishes_first:
            self.release.set()
        else:
            self.release.wait(timeout=2)
        return self.records


class BlockingProvider(FakeProvider):
    def __init__(self, name, release):
        super().__init__(name)
        self.release = release

    def search(self, spec: SearchSpec):
        self.specs.append(spec)
        self.release.wait()
        return self.records


def record(
    provider,
    rank,
    title,
    doi=None,
    *,
    identifiers=(),
    abstract=None,
    authors=(),
    year=None,
    venue=None,
    publisher=None,
    keywords=(),
    publication_date=None,
    open_access_status=None,
    provider_record_id=None,
):
    raw_identifiers = tuple(identifiers)
    if doi is not None:
        raw_identifiers = (("doi", doi), *raw_identifiers)
    return ProviderRecord(
        provider,
        rank,
        raw_identifiers,
        title=title,
        abstract=abstract,
        authors=tuple(authors),
        year=year,
        venue=venue,
        keywords=tuple(keywords),
        publisher=publisher,
        publication_date=publication_date,
        open_access_status=open_access_status,
        provider_record_id=provider_record_id,
    )


class MetadataSearchWp2Tests(TestCase):
    def setUp(self):
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary_directory.name) / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        self.repository = WorkRepository(self.catalog)

    def counts(self, *tables):
        with self.catalog.connect() as connection:
            return tuple(
                connection.exec_driver_sql(f'SELECT count(*) FROM "{table}"').scalar_one()
                for table in tables
            )

    def request(self, providers, *, precedence=None, limit=100):
        selected = tuple(providers)
        return MetadataSearchRequest(
            "query",
            selected,
            tuple(precedence or selected),
            limit=limit,
            provider_timeout_seconds=2,
            max_concurrency=4,
        )

    def test_providers_start_concurrently_without_completion_order_writes(self):
        barrier = Barrier(2)
        providers = {
            "a": FakeProvider("a", (record("a", 1, "Alpha", "10.1/a"),), barrier=barrier),
            "b": FakeProvider("b", (record("b", 1, "Beta", "10.1/b"),), barrier=barrier),
        }
        output = MetadataSearchService(providers, self.repository).search(self.request(("a", "b")))
        self.assertEqual(tuple(item.metadata.title for item in output.results), ("Alpha", "Beta"))
        self.assertEqual(self.counts("works", "work_versions"), (2, 2))

    def test_provider_and_record_order_do_not_change_merge_projection(self):
        first = record("high", 2, "Canonical Title", "10.1/stable", abstract="preferred")
        second = record("low", 1, "Other Title", "10.1/stable", abstract="fallback", year=2025)
        service = MetadataSearchService(
            {"low": FakeProvider("low", (second,)), "high": FakeProvider("high", (first,))},
            self.repository,
        )
        output = service.search(self.request(("low", "high"), precedence=("high", "low")))
        result = output.results[0]
        self.assertEqual((result.metadata.title, result.metadata.abstract, result.metadata.year),
                         ("Canonical Title", "preferred", 2025))
        self.assertEqual(result.work_version.title, "Canonical Title")

    def test_forced_completion_order_does_not_change_projection(self):
        high = record("high", 1, "Canonical", "10.1/order", abstract="preferred")
        low = record("low", 1, "Fallback", "10.1/order", year=2025)

        def run(high_finishes_first, path):
            catalog = create_catalog_engine(Path(self.temporary_directory.name) / path)
            self.addCleanup(catalog.dispose)
            initialize_catalog(catalog)
            barrier = Barrier(2)
            release = Event()
            providers = {
                "high": OrderedProvider("high", (high,), barrier, release,
                                        finishes_first=high_finishes_first),
                "low": OrderedProvider("low", (low,), barrier, release,
                                       finishes_first=not high_finishes_first),
            }
            return MetadataSearchService(providers, WorkRepository(catalog)).search(
                MetadataSearchRequest(
                    "query", ("low", "high"), ("high", "low"),
                    provider_timeout_seconds=2,
                )
            ).results[0].metadata

        self.assertEqual(run(True, "first.sqlite"), run(False, "second.sqlite"))

    def test_each_provider_has_a_finite_independent_deadline(self):
        release = Event()
        service = MetadataSearchService(
            {
                "blocked": BlockingProvider("blocked", release),
                "good": FakeProvider("good", (record("good", 1, "Good", "10.1/good"),)),
            },
            self.repository,
        )
        try:
            output = service.search(MetadataSearchRequest(
                "query", ("blocked", "good"), ("good", "blocked"),
                provider_timeout_seconds=0.05,
            ))
        finally:
            release.set()
        self.assertEqual(len(output.results), 1)
        self.assertEqual(output.failures, (
            output.failures[0].__class__("blocked", "timeout", "provider deadline exceeded"),
        ))

    def test_queued_and_running_providers_share_a_finite_collection_bound(self):
        release = Event()
        providers = {
            "good": FakeProvider("good", (record("good", 1, "Good", "10.1/good"),)),
            **{name: BlockingProvider(name, release) for name in ("b1", "b2", "b3", "b4")},
        }
        started = monotonic()
        try:
            output = MetadataSearchService(providers, self.repository).search(
                MetadataSearchRequest(
                    "query",
                    ("good", "b1", "b2", "b3", "b4"),
                    ("good", "b1", "b2", "b3", "b4"),
                    provider_timeout_seconds=0.05,
                    max_concurrency=2,
                )
            )
        finally:
            release.set()
        self.assertLess(monotonic() - started, 0.5)
        self.assertEqual(len(output.results), 1)
        self.assertEqual(
            tuple((failure.provider, failure.category, failure.message) for failure in output.failures),
            tuple((name, "timeout", "provider deadline exceeded") for name in ("b1", "b2", "b3", "b4")),
        )

    def test_hung_provider_does_not_keep_cli_process_alive(self):
        script = """
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
from sciretriever.catalog import WorkRepository, create_catalog_engine, initialize_catalog
from sciretriever.core.contracts import SearchSpec
from sciretriever.discovery import MetadataSearchRequest, MetadataSearchService, ProviderRecord

class Never:
    name = "never"
    def search(self, spec: SearchSpec):
        Event().wait()

class Good:
    name = "good"
    def search(self, spec: SearchSpec):
        return (ProviderRecord("good", 1, (("doi", "10.1/good"),), title="Good"),)

with TemporaryDirectory() as directory:
    catalog = create_catalog_engine(Path(directory) / "catalog.sqlite")
    initialize_catalog(catalog)
    MetadataSearchService({"never": Never(), "good": Good()}, WorkRepository(catalog)).search(
        MetadataSearchRequest("q", ("never", "good"), ("good", "never"), provider_timeout_seconds=0.05)
    )
    catalog.dispose()
print("finished")
"""
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=REPOSITORY,
            env={**os.environ, "PYTHONPATH": str(SRC)},
            capture_output=True,
            text=True,
            timeout=1.5,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "finished\n")

    def test_partial_failure_continues_and_all_failure_creates_no_rows(self):
        partial = MetadataSearchService(
            {
                "good": FakeProvider("good", (record("good", 1, "Good", "10.1/good"),)),
                "bad": FakeProvider("bad", error=RuntimeError("offline failure")),
            },
            self.repository,
        ).search(self.request(("good", "bad")))
        self.assertEqual(len(partial.results), 1)
        self.assertEqual(partial.failures[0].provider, "bad")

        empty_catalog = create_catalog_engine(Path(self.temporary_directory.name) / "empty.sqlite")
        self.addCleanup(empty_catalog.dispose)
        initialize_catalog(empty_catalog)
        failing = MetadataSearchService(
            {"a": FakeProvider("a", error=RuntimeError("a")),
             "b": FakeProvider("b", error=RuntimeError("b"))},
            WorkRepository(empty_catalog),
        )
        with self.assertRaisesRegex(SearchError, "all metadata search providers failed: a:provider_error; b:provider_error"):
            failing.search(self.request(("b", "a")))
        with empty_catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM works").scalar_one(), 0)

    def test_provider_failure_messages_are_sanitized(self):
        secret = "token=do-not-expose"
        output = MetadataSearchService(
            {
                "good": FakeProvider("good", (record("good", 1, "Good", "10.1/good"),)),
                "bad": FakeProvider("bad", error=RuntimeError(secret)),
            },
            self.repository,
        ).search(self.request(("good", "bad")))
        self.assertEqual(output.failures[0].message, "provider search failed")
        self.assertNotIn(secret, repr(output.failures))

    def test_conflicting_dois_never_merge_through_shared_identifier_or_title(self):
        records = (
            record("p", 1, "Same Title", "10.1/a", identifiers=(("pmid", "bridge"),)),
            record("p", 2, "Same Title", identifiers=(("pmid", "bridge"), ("arxiv", "bridge"))),
            record("p", 3, "Same Title", "10.1/b", identifiers=(("arxiv", "bridge"),)),
        )
        output = MetadataSearchService(
            {"p": FakeProvider("p", records)}, self.repository
        ).search(self.request(("p",)))
        self.assertEqual(len(output.results), 3)
        self.assertEqual(
            {next(identifier.value for identifier in item.identifiers if identifier.namespace == "doi")
             for item in output.results if any(
                 identifier.namespace == "doi" for identifier in item.identifiers
             )},
            {"10.1/a", "10.1/b"},
        )
        with self.catalog.connect() as connection:
            bridge_aliases = connection.exec_driver_sql(
                "SELECT count(*) FROM work_version_identifiers "
                "WHERE (namespace = 'pmid' OR namespace = 'arxiv') AND value = 'bridge'"
            ).scalar_one()
            review_count = connection.exec_driver_sql(
                "SELECT count(*) FROM works WHERE needs_review = 1 "
                "AND review_reason = 'conflicting DOI bridge evidence'"
            ).scalar_one()
        self.assertEqual(bridge_aliases, 0)
        self.assertEqual(review_count, 3)

    def test_later_doi_adopts_unique_exact_title_provisional_version(self):
        provisional = MetadataSearchService(
            {"first": FakeProvider("first", (record("first", 1, "Split Run"),))},
            self.repository,
        ).search(self.request(("first",))).results[0]
        identified = MetadataSearchService(
            {"second": FakeProvider("second", (record("second", 1, "Split—Run", "10.1/split"),))},
            self.repository,
        ).search(self.request(("second",))).results[0]
        self.assertEqual(identified.work_version.id, provisional.work_version.id)
        self.assertFalse(identified.work_version.is_provisional)
        self.assertEqual(self.counts("works", "work_versions"), (1, 1))

    def test_later_doi_does_not_adopt_non_provisional_version_by_title_alone(self):
        venue = RegistryRepository(self.catalog).add("venue", "Known Journal")
        existing = self.repository.ingest_version(
            provider="seed",
            provider_record_id="complete",
            title="Complete Work",
            publication_date="2024-01-01",
            venue_id=venue.id,
        )
        self.assertFalse(existing.is_provisional)

        identified = MetadataSearchService(
            {
                "later": FakeProvider(
                    "later", (record("later", 1, "Complete Work", "10.1/complete"),)
                )
            },
            self.repository,
        ).search(self.request(("later",))).results[0]

        self.assertNotEqual(identified.work_version.id, existing.id)
        self.assertEqual(self.counts("works", "work_versions"), (1, 2))

    def test_late_result_conflict_rolls_back_whole_search(self):
        observation_owner = self.repository.ingest_version(
            provider="p", provider_record_id="conflict-record", title="Observation Owner"
        )
        identifier_owner = self.repository.ingest_version(
            provider="seed", provider_record_id="identifier-owner",
            title="Identifier Owner", doi="10.1/conflict",
        )
        before = self.counts("works", "work_versions", "metadata_observations")
        records = (
            record("p", 1, "Atomic First", "10.1/atomic"),
            record(
                "p", 2, "Identifier Owner", "10.1/conflict",
                provider_record_id="conflict-record",
            ),
        )
        with self.assertRaisesRegex(CatalogError, "observation owner conflicts"):
            MetadataSearchService(
                {"p": FakeProvider("p", records)}, self.repository
            ).search(self.request(("p",)))
        self.assertEqual(
            self.counts("works", "work_versions", "metadata_observations"), before
        )
        self.assertNotEqual(observation_owner.id, identifier_owner.id)

    def test_doi_and_no_doi_exact_title_enrich_and_limit_is_post_merge(self):
        providers = {
            "high": FakeProvider("high", (
                record("high", 1, "Same", "10.1/same", abstract="abstract"),
                record("high", 2, "Other", "10.1/other"),
            )),
            "low": FakeProvider("low", (record("low", 1, "Same", year=2024),)),
        }
        output = MetadataSearchService(providers, self.repository).search(
            self.request(("high", "low"), limit=1)
        )
        self.assertEqual(len(output.results), 1)
        self.assertEqual(output.results[0].metadata.title, "Same")
        self.assertEqual(output.results[0].metadata.year, 2024)
        self.assertEqual(self.counts("work_versions"), (1,))

    def test_exact_title_merge_uses_precedence_despite_conflicting_years(self):
        for index, records in enumerate((
            {
                "high": (record("high", 1, "Exact Title", "10.1/year", year=2020),),
                "low": (record("low", 1, "Exact—Title", year=2021),),
            },
            {
                "high": (record("high", 1, "Exact Title", year=2020),),
                "low": (record("low", 1, "Exact—Title", year=2021),),
            },
        )):
            with self.subTest(has_doi=bool(records["high"][0].raw_identifiers)):
                catalog = create_catalog_engine(
                    Path(self.temporary_directory.name) / f"years-{index}.sqlite"
                )
                self.addCleanup(catalog.dispose)
                initialize_catalog(catalog)
                output = MetadataSearchService(
                    {name: FakeProvider(name, values) for name, values in records.items()},
                    WorkRepository(catalog),
                ).search(MetadataSearchRequest(
                    "query", ("low", "high"), ("high", "low"),
                ))
                self.assertEqual(len(output.results), 1)
                self.assertEqual(output.results[0].metadata.year, 2020)

    def test_default_limit_persists_only_first_100_merged_works(self):
        records = tuple(
            record("p", rank, f"Work {rank:03d}", f"10.1/work-{rank:03d}")
            for rank in range(1, 102)
        )
        output = MetadataSearchService(
            {"p": FakeProvider("p", records)}, self.repository
        ).search(MetadataSearchRequest("query", ("p",), ("p",)))
        self.assertEqual(len(output.results), 100)
        self.assertEqual(self.counts("works", "work_versions"), (100, 100))

    def test_observations_are_canonical_idempotent_and_keywords_do_not_create_tags(self):
        providers = {
            "high": FakeProvider("high", (
                record("high", 9, "Observed", "10.1/observed", abstract="A",
                       authors=("Alex Kim",), venue="Unknown Venue", publisher="Unknown Press",
                       keywords=("topic-a",)),
            )),
            "low": FakeProvider("low", (
                record("low", 1, "Observed low", "10.1/observed", year=2026,
                       keywords=("topic-b",)),
            )),
        }
        service = MetadataSearchService(providers, self.repository)
        request = self.request(("low", "high"), precedence=("high", "low"))
        first = service.search(request)
        before = self.counts(
            "works", "work_versions", "metadata_observations", "authors", "authorships",
            "publishers", "venues", "tags", "manual_work_tags", "generated_work_version_tags",
        )
        second = service.search(request)
        self.assertEqual(first.results[0].work_version.id, second.results[0].work_version.id)
        self.assertEqual(
            self.counts(
                "works", "work_versions", "metadata_observations", "authors", "authorships",
                "publishers", "venues", "tags", "manual_work_tags", "generated_work_version_tags",
            ),
            before,
        )
        self.assertEqual(first.results[0].work_version.publisher_id, None)
        self.assertEqual(first.results[0].work_version.venue_id, None)
        with self.catalog.connect() as connection:
            rows = connection.exec_driver_sql(
                "SELECT field_name, provenance_json FROM metadata_observations ORDER BY field_name"
            ).all()
        self.assertIn("keywords", {row[0] for row in rows})
        self.assertTrue(all("provider_record_id" in json.loads(row[1]) for row in rows))

    def test_same_name_authors_are_not_merged_across_versions(self):
        output = MetadataSearchService(
            {"p": FakeProvider("p", (
                record("p", 1, "One", "10.1/one", authors=("Alex Kim",)),
                record("p", 2, "Two", "10.1/two", authors=("Alex Kim",)),
            ))},
            self.repository,
        ).search(self.request(("p",)))
        self.assertEqual(len(output.results), 2)
        self.assertEqual(self.counts("authors", "authorships"), (2, 2))

    def test_repeated_non_doi_identifier_reuses_owning_version(self):
        first = MetadataSearchService(
            {"p1": FakeProvider("p1", (
                record("p1", 1, "Same Work", identifiers=(("pmid", "12345"),)),
            ))},
            self.repository,
        ).search(self.request(("p1",))).results[0]
        second = MetadataSearchService(
            {"p2": FakeProvider("p2", (
                record("p2", 1, "Same Work", identifiers=(("pmid", "12345"),)),
            ))},
            self.repository,
        ).search(self.request(("p2",))).results[0]
        self.assertEqual(first.work_version.id, second.work_version.id)
        self.assertEqual(self.counts("works", "work_versions", "work_version_identifiers"), (1, 1, 1))

    def test_repeated_title_only_provider_record_reuses_observation_owner(self):
        provider = FakeProvider("p", (record("p", 1, "Title Only"),))
        service = MetadataSearchService({"p": provider}, self.repository)
        first = service.search(self.request(("p",))).results[0]
        before = self.counts("works", "work_versions", "metadata_observations")
        second = service.search(self.request(("p",))).results[0]
        self.assertEqual(first.work_version.id, second.work_version.id)
        self.assertEqual(self.counts("works", "work_versions", "metadata_observations"), before)

    def test_observation_owner_identifier_owner_conflict_rolls_back(self):
        title_only = MetadataSearchService(
            {"p": FakeProvider("p", (record("p", 1, "Title Only"),))},
            self.repository,
        ).search(self.request(("p",))).results[0]
        identified = MetadataSearchService(
            {"q": FakeProvider("q", (record("q", 1, "Identified", "10.1/owner"),))},
            self.repository,
        ).search(self.request(("q",))).results[0]
        with self.catalog.connect() as connection:
            provider_record_id = connection.exec_driver_sql(
                "SELECT provider_record_id FROM metadata_observations "
                "WHERE work_version_id = ? AND provider = 'p' LIMIT 1",
                (title_only.work_version.id,),
            ).scalar_one()
        before = self.counts("works", "work_versions", "metadata_observations", "work_version_identifiers")
        observation = MetadataIngestionObservation(
            provider="p",
            provider_record_id=provider_record_id,
            fields=(("title", "Conflicting Title"), ("doi", "10.1/owner")),
            provenance=(("provider", "p"), ("provider_record_id", provider_record_id)),
        )
        with self.assertRaisesRegex(
            CatalogError, "metadata observation owner conflicts with identifier owner"
        ):
            self.repository.ingest_metadata_batch(
                title="Conflicting Title",
                identifiers_to_persist=(Identifier("doi", "10.1/owner"),),
                observations=(observation,),
                provider_precedence=("p",),
            )
        self.assertEqual(
            self.counts("works", "work_versions", "metadata_observations", "work_version_identifiers"),
            before,
        )
        self.assertNotEqual(title_only.work_version.id, identified.work_version.id)
        with self.catalog.connect() as connection:
            conflicting_rows = connection.exec_driver_sql(
                "SELECT count(*) FROM metadata_observations WHERE value_json = ?",
                (json.dumps("Conflicting Title", separators=(",", ":")),),
            ).scalar_one()
        self.assertEqual(conflicting_rows, 0)

    def test_later_lower_precedence_observations_fill_only(self):
        registries = RegistryRepository(self.catalog)
        publisher = registries.add("publisher", "Known Press")
        venue = registries.add("venue", "Known Journal")
        first = MetadataSearchService(
            {
                "high": FakeProvider("high", (
                    record("high", 1, "Canonical", "10.1/fill-only", abstract="preferred",
                           authors=("High Author",), year=2024, venue="Known Journal",
                           publisher="Known Press", open_access_status="open"),
                )),
                "low": FakeProvider("low", error=RuntimeError("temporarily unavailable")),
            },
            self.repository,
        ).search(self.request(("high", "low"), precedence=("high", "low"))).results[0]
        second = MetadataSearchService(
            {
                "high": FakeProvider("high", error=RuntimeError("temporarily unavailable")),
                "low": FakeProvider("low", (
                    record("low", 1, "Replacement", "10.1/fill-only", abstract="replacement",
                           authors=("Low Author",), year=2025, venue="Unknown Venue",
                           publisher="Unknown Press", open_access_status="closed"),
                )),
            },
            self.repository,
        ).search(self.request(("high", "low"), precedence=("high", "low"))).results[0]
        self.assertEqual(first.work_version.id, second.work_version.id)
        self.assertEqual(
            (second.work_version.title, second.work_version.abstract,
             second.work_version.publication_year, second.work_version.publisher_id,
             second.work_version.venue_id, second.work_version.open_access_status),
            ("Canonical", "preferred", 2024, publisher.id, venue.id, "open"),
        )
        with self.catalog.connect() as connection:
            author_names = connection.exec_driver_sql(
                "SELECT a.display_name FROM authorships s JOIN authors a ON a.id = s.author_id "
                "WHERE s.work_version_id = ? ORDER BY s.position",
                (second.work_version.id,),
            ).scalars().all()
        self.assertEqual(author_names, ["High Author"])
        self.assertEqual(
            (second.metadata.title, second.metadata.abstract, second.metadata.authors,
             second.metadata.year, second.metadata.venue),
            ("Canonical", "preferred", ("High Author",), 2024, "Known Journal"),
        )

    def test_persisted_observations_reproject_independent_of_ingestion_order(self):
        def run(path, batches):
            catalog = create_catalog_engine(Path(self.temporary_directory.name) / path)
            self.addCleanup(catalog.dispose)
            initialize_catalog(catalog)
            registries = RegistryRepository(catalog)
            publisher = registries.add("publisher", "Known Press")
            venue = registries.add("venue", "Known Journal")
            repository = WorkRepository(catalog)
            result = None
            for available in batches:
                providers = {
                    "high": FakeProvider(
                        "high",
                        (record("high", 1, "Zeta", "10.1/order-set", abstract="Z abstract",
                                authors=("Z Author",), year=2026, venue="Known Journal",
                                publisher="Known Press"),)
                        if available == "high" else (),
                        error=RuntimeError("unavailable") if available != "high" else None,
                    ),
                    "low": FakeProvider(
                        "low",
                        (record("low", 1, "Alpha", "10.1/order-set", abstract="A abstract",
                                authors=("A Author",), year=2025),)
                        if available == "low" else (),
                        error=RuntimeError("unavailable") if available != "low" else None,
                    ),
                }
                result = MetadataSearchService(providers, repository).search(
                    MetadataSearchRequest("query", ("low", "high"), ("high", "low"))
                ).results[0]
            if result is None:
                raise AssertionError("test requires at least one ingestion batch")
            with catalog.connect() as connection:
                authors = tuple(connection.exec_driver_sql(
                    "SELECT a.display_name FROM authorships s JOIN authors a ON a.id = s.author_id "
                    "WHERE s.work_version_id = ? ORDER BY s.position",
                    (result.work_version.id,),
                ).scalars())
            return (
                result.work_version.title,
                result.work_version.abstract,
                result.work_version.publication_year,
                result.work_version.publisher_id == publisher.id,
                result.work_version.venue_id == venue.id,
                authors,
            )

        expected = ("Zeta", "Z abstract", 2026, True, True, ("Z Author",))
        self.assertEqual(run("order-low-high.sqlite", ("low", "high")), expected)
        self.assertEqual(run("order-high-low.sqlite", ("high", "low")), expected)

    def test_same_provider_multiple_records_use_stable_value_tiebreak(self):
        def run(path, values):
            catalog = create_catalog_engine(Path(self.temporary_directory.name) / path)
            self.addCleanup(catalog.dispose)
            initialize_catalog(catalog)
            result = MetadataSearchService(
                {"p": FakeProvider("p", values)}, WorkRepository(catalog)
            ).search(MetadataSearchRequest("query", ("p",), ("p",))).results[0]
            with catalog.connect() as connection:
                authors = tuple(connection.exec_driver_sql(
                    "SELECT a.display_name FROM authorships s JOIN authors a ON a.id = s.author_id "
                    "WHERE s.work_version_id = ? ORDER BY s.position",
                    (result.work_version.id,),
                ).scalars())
            return result.work_version.title, result.work_version.abstract, authors

        alpha = record("p", 1, "Alpha", "10.1/same-provider", abstract="Alpha abstract",
                       authors=("Alpha Author",))
        zeta = record("p", 1, "Zeta", "10.1/same-provider", abstract="Zeta abstract",
                      authors=("Zeta Author",))
        expected = ("Alpha", "Alpha abstract", ("Alpha Author",))
        self.assertEqual(run("same-forward.sqlite", (alpha, zeta)), expected)
        self.assertEqual(run("same-reverse.sqlite", (zeta, alpha)), expected)

    def test_provider_record_publisher_is_type_validated(self):
        invalid_publisher: Any = 123
        with self.assertRaisesRegex(TypeError, "publisher must be a string or None"):
            ProviderRecord("p", 1, (), title="Title", publisher=invalid_publisher)

    def test_provider_ownership_and_record_types_fail_before_persistence(self):
        service = MetadataSearchService(
            {"owned": FakeProvider("other", (record("owned", 1, "Title", "10.1/x"),))},
            self.repository,
        )
        with self.assertRaisesRegex(SearchError, "all metadata search providers failed"):
            service.search(self.request(("owned",)))
        invalid = MetadataSearchService(
            {"owned": FakeProvider("owned", ("not-a-record",))},
            self.repository,
        )
        with self.assertRaisesRegex(SearchError, "all metadata search providers failed"):
            invalid.search(self.request(("owned",)))
        self.assertEqual(self.counts("works", "work_versions"), (0, 0))


if __name__ == "__main__":
    import unittest

    unittest.main()
