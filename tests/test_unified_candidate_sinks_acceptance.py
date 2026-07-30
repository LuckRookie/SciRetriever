from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock

from sciretriever.catalog import (
    ReadOnlyCatalogView,
    WorkRepository,
    create_catalog_engine,
    initialize_catalog,
    open_read_only_catalog_engine,
)
from sciretriever.core.contracts import DownloadManifestEntry, Identifier, SearchSpec
from sciretriever.discovery import (
    CandidatePreparer,
    CandidateRetrievalRequest,
    MetadataSearchRequest,
    MetadataSearchService,
    ProviderFailure,
    ProviderRecord,
)
from sciretriever.discovery.metadata_ingestion import MetadataIngestor
from sciretriever.discovery.models import RetrievedCandidate
from sciretriever.discovery.labeling import KeywordRuleLabeler
from sciretriever.discovery.manifest import discover_to_jsonl, write_manifest
from sciretriever.discovery.search_contracts import MetadataSearchOutput
from sciretriever.cli.search_completion_runtime import SearchCompletionRuntime
from sciretriever.errors import CatalogError, SearchError


RUN_ID, RETRIEVED_AT = "00000000-0000-4000-8000-000000000007", "2026-07-29T12:00:00Z"


class FakeProvider:
    def __init__(
        self,
        name: str,
        records: tuple[ProviderRecord, ...] = (),
        error: RuntimeError | None = None,
    ) -> None:
        self.name = name
        self.records = records
        self.error = error
        self.specs: list[SearchSpec] = []

    def search(self, spec: SearchSpec) -> tuple[ProviderRecord, ...]:
        self.specs.append(spec)
        if self.error is not None:
            raise self.error
        return self.records


def record(
    provider: str,
    rank: int,
    title: str | None,
    identifiers: tuple[tuple[str, str], ...],
    *,
    abstract: str | None = None,
    provider_record_id: str | None = None,
) -> ProviderRecord:
    return ProviderRecord(
        provider,
        rank,
        identifiers,
        title=title,
        abstract=abstract,
        year=2024,
        publisher=f"{provider} press",
        publication_date="2024-06-01",
        open_access_status="open",
        provider_record_id=provider_record_id,
    )


class UnifiedCandidateSinksAcceptanceTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-candidate-sinks-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.catalog_path = self.root / "catalog.sqlite"
        self.writable = create_catalog_engine(self.catalog_path)
        self.addCleanup(self.writable.dispose)
        initialize_catalog(self.writable)
        self.repository = WorkRepository(self.writable)

    def counts(self) -> tuple[int, ...]:
        with sqlite3.connect(self.catalog_path) as connection:
            return tuple(
                connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                for table in (
                    "works",
                    "work_versions",
                    "work_version_identifiers",
                    "metadata_observations",
                    "diagnostic_records",
                )
            )

    def read_only_view(self) -> ReadOnlyCatalogView:
        engine = open_read_only_catalog_engine(self.catalog_path)
        self.addCleanup(engine.dispose)
        return ReadOnlyCatalogView(engine)

    def test_one_candidate_truth_drives_read_only_manifest_and_catalog_sink(self) -> None:
        MetadataSearchService(
            {"high": FakeProvider("high", (record(
                "high", 1, "Historical title", (("doi", "10.7/history"),),
                abstract="historical abstract",
            ),))},
            self.repository,
        ).search(MetadataSearchRequest("seed", ("high",), ("high",)))
        before_manifest = self.counts()
        records = (
            record("low", 1, "Current title", (("doi", "10.7/history"),),
                   abstract="current abstract", provider_record_id="low-history"),
            record("low", 2, "Alpha", (("doi", "10.7/a"), ("pmid", "bridge")),
                   provider_record_id="low-a"),
            record("high", 2, "Beta", (("doi", "10.7/b"), ("pmid", "bridge")),
                   provider_record_id="high-b"),
            record("low", 3, "Beta fallback", (("doi", "10.7/b"),),
                   abstract="beta abstract", provider_record_id="low-b"),
            record("low", 4, None, (("arxiv", "titleless"),),
                   provider_record_id="titleless"),
            record("low", 5, "Gamma", (("doi", "10.7/c"),),
                   provider_record_id="low-c"),
        )
        spec = SearchSpec(
            "offline fixture",
            ("high", "low", "failed"),
            10,
            (("year_from", "2020"), ("year_to", "2025")),
        )
        request = CandidateRetrievalRequest(spec, spec.sources)
        failure = ProviderFailure("failed", "provider_error", "provider search failed")
        captured = CandidatePreparer().prepare(request, records, (failure,)).candidates
        providers = {
            "high": FakeProvider("high", tuple(item for item in records if item.provider == "high")),
            "low": FakeProvider("low", tuple(item for item in records if item.provider == "low")),
            "failed": FakeProvider("failed", error=RuntimeError("token=not-visible")),
        }
        output_path = self.root / "manifest.jsonl"
        prepared: list[tuple[RetrievedCandidate, ...]] = []
        original_prepare = CandidatePreparer.prepare

        def capture(preparer, retrieval_request, values, failures=(), **options):
            result = original_prepare(preparer, retrieval_request, values, failures, **options)
            prepared.append(result.candidates)
            return result

        with mock.patch.object(CandidatePreparer, "prepare", autospec=True, side_effect=capture):
            manifest = discover_to_jsonl(
                spec,
                output_path,
                providers=providers,
                catalog=self.read_only_view(),
                labeler=KeywordRuleLabeler("topic", "1", {"selected": ("title",)}),
                intake_run_id=RUN_ID,
                retrieved_at=RETRIEVED_AT,
            )

        self.assertEqual(prepared, [captured])
        self.assertEqual(self.counts(), before_manifest)
        self.assertEqual(manifest.failures, (failure,))
        self.assertEqual(
            tuple(provider.specs[0].filters for provider in providers.values()),
            (spec.filters, spec.filters, spec.filters),
        )
        self.assertEqual(len(captured), 4)
        self.assertEqual(
            tuple(
                next(identifier.value for identifier in item.identifiers
                     if identifier.namespace == "doi")
                for item in captured
            ),
            ("10.7/b", "10.7/history", "10.7/a", "10.7/c"),
        )
        self.assertEqual(tuple(item.metadata.title for item in captured),
                         ("Beta", "Current title", "Alpha", "Gamma"))
        self.assertEqual(tuple(len(item.observations) for item in captured), (2, 1, 1, 1))
        self.assertEqual(captured[0].metadata.abstract, "beta abstract")
        self.assertEqual(
            tuple(item.provider_record_id for item in captured[0].observations),
            ("high-b", "low-b"),
        )
        self.assertTrue(all(
            Identifier("pmid", "bridge") not in item.identifiers
            for item in captured if item.metadata.title in ("Alpha", "Beta")
        ))

        ingestor = MetadataIngestor(self.repository)
        first = ingestor.ingest_candidates(captured, spec.sources)
        persisted = self.counts()
        second = ingestor.ingest_candidates(captured, spec.sources)
        self.assertEqual(self.counts(), persisted)
        self.assertEqual(
            tuple(item.work_version.id for item in first),
            tuple(item.work_version.id for item in second),
        )
        historical_index = next(
            index for index, candidate in enumerate(captured)
            if Identifier("doi", "10.7/history") in candidate.identifiers
        )
        self.assertEqual(first[historical_index].metadata.title, "Historical title")
        self.assertEqual(captured[historical_index].metadata.title, "Current title")
        public = self.read_only_view().lookup_work(Identifier("doi", "10.7/a"))
        self.assertIsNotNone(public)
        completion = SearchCompletionRuntime.targets(MetadataSearchOutput(first, ()))[:2]
        self.assertEqual(completion, tuple(item.work_version.id for item in first[:2]))
        self.assertEqual(len(output_path.read_text(encoding="utf-8").splitlines()), 4)

    def test_all_failure_and_sink_errors_preserve_committed_state_and_old_bytes(self) -> None:
        output_path = self.root / "manifest.jsonl"
        old_bytes = b'{"old":true}\n'
        output_path.write_bytes(old_bytes)
        failures = {
            name: FakeProvider(name, error=RuntimeError(f"secret-{name}"))
            for name in ("high", "low")
        }
        before = self.counts()
        with self.assertRaisesRegex(SearchError, "high:provider_error; low:provider_error"):
            discover_to_jsonl(
                SearchSpec("offline", ("high", "low"), 2),
                output_path,
                providers=failures,
                catalog=self.read_only_view(),
                labeler=KeywordRuleLabeler("topic", "1", {}),
                intake_run_id=RUN_ID,
                retrieved_at=RETRIEVED_AT,
            )
        self.assertEqual((output_path.read_bytes(), self.counts()), (old_bytes, before))

        def interrupted_entries() -> Iterator[DownloadManifestEntry]:
            empty: tuple[DownloadManifestEntry, ...] = ()
            yield from empty
            raise KeyboardInterrupt

        with self.assertRaises(KeyboardInterrupt):
            write_manifest(interrupted_entries(), output_path)
        self.assertEqual(output_path.read_bytes(), old_bytes)
        self.assertEqual(tuple(self.root.glob(".manifest.jsonl.*.tmp")), ())

        with self.assertRaisesRegex(SearchError, "all metadata search providers failed"):
            MetadataSearchService(failures, self.repository).search(
                MetadataSearchRequest("offline", ("high", "low"), ("high", "low"))
            )
        after_search_failure = self.counts()
        self.assertEqual(after_search_failure[:4], before[:4])
        self.assertEqual(after_search_failure[4], before[4] + 1)

        self.repository.ingest_version(provider="p", provider_record_id="collision", title="Existing")
        self.repository.ingest_version(
            provider="seed", provider_record_id="identified", title="Owner", doi="10.7/owner"
        )
        before_conflict = self.counts()
        conflict = CandidatePreparer().prepare(
            CandidateRetrievalRequest(SearchSpec("q", ("p",), 2), ("p",)),
            (
                record("p", 1, "First", (("doi", "10.7/first"),)),
                record("p", 2, "Owner", (("doi", "10.7/owner"),),
                       provider_record_id="collision"),
            ),
        ).candidates
        with self.assertRaisesRegex(CatalogError, "observation owner conflicts"):
            MetadataIngestor(self.repository).ingest_candidates(conflict, ("p",))
        self.assertEqual(self.counts(), before_conflict)
        self.assertEqual(output_path.read_bytes(), old_bytes)


if __name__ == "__main__":
    import unittest

    unittest.main()
