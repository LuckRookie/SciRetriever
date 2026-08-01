from concurrent.futures import Future
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from threading import Barrier, Event
from time import monotonic
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.core.contracts import SearchSpec
from sciretriever.catalog import (
    WorkRepository,
    create_catalog_engine,
    initialize_catalog,
)
from sciretriever.discovery.models import ProviderRecord
from sciretriever.discovery.provider_collection import (
    ProviderCollectionRequest,
    ProviderCollector,
)
from sciretriever.discovery.search import MetadataSearchService
from sciretriever.discovery.search_contracts import MetadataSearchRequest


class RecordingProvider:
    def __init__(
        self,
        name: str,
        records: tuple[ProviderRecord, ...] = (),
        *,
        barrier: Barrier | None = None,
        error: RuntimeError | None = None,
    ) -> None:
        self.name = name
        self.records = records
        self.barrier = barrier
        self.error = error
        self.specs: list[SearchSpec] = []

    def search(self, spec: SearchSpec) -> tuple[ProviderRecord, ...]:
        self.specs.append(spec)
        if self.barrier is not None:
            self.barrier.wait(timeout=1)
        if self.error is not None:
            raise self.error
        return self.records


class BlockingProvider(RecordingProvider):
    def __init__(self, name: str, release: Event) -> None:
        super().__init__(name)
        self.release = release

    def search(self, spec: SearchSpec) -> tuple[ProviderRecord, ...]:
        self.specs.append(spec)
        self.release.wait()
        return ()


def request(
    sources: tuple[str, ...],
    *,
    filters: tuple[tuple[str, str], ...] = (),
    timeout: float = 1.0,
    concurrency: int = 2,
) -> ProviderCollectionRequest:
    return ProviderCollectionRequest(
        "query",
        sources,
        10,
        timeout,
        concurrency,
        precedence=sources,
        filters=filters,
    )


class ProviderCollectionTests(TestCase):
    def test_ordinary_search_passes_request_filters_to_provider(self) -> None:
        provider = RecordingProvider("provider")
        temporary = TemporaryDirectory(prefix="sciretriever-provider-collection-")
        self.addCleanup(temporary.cleanup)
        catalog = create_catalog_engine(Path(temporary.name) / "catalog.sqlite")
        self.addCleanup(catalog.dispose)
        initialize_catalog(catalog)
        request_filters = (("year_from", "2020"), ("year_to", "2025"))

        output = MetadataSearchService(
            {"provider": provider}, WorkRepository(catalog)
        ).search(MetadataSearchRequest(
            "query",
            ("provider",),
            ("provider",),
            filters=request_filters,
        ))

        self.assertEqual(output.results, ())
        self.assertEqual(
            (request_filters, provider.specs[0].filters),
            (request_filters, request_filters),
        )

    def test_concurrent_providers_receive_single_source_specs_with_filters(self) -> None:
        barrier = Barrier(2)
        first = RecordingProvider("first", barrier=barrier)
        second = RecordingProvider("second", barrier=barrier)

        result = ProviderCollector({"second": second, "first": first}).collect(request(
            ("first", "second"),
            filters=(("year_from", "2020"), ("year_to", "2025")),
        ))

        self.assertFalse(result.all_failed)
        self.assertEqual(first.specs, [SearchSpec(
            "query", ("first",), 10, (("year_from", "2020"), ("year_to", "2025"))
        )])
        self.assertEqual(second.specs, [SearchSpec(
            "query", ("second",), 10, (("year_from", "2020"), ("year_to", "2025"))
        )])

    def test_all_failed_is_explicit_and_empty_success_is_distinct(self) -> None:
        failed = RecordingProvider("failed", error=RuntimeError("token=TOP-SECRET"))
        empty = RecordingProvider("empty")

        partial = ProviderCollector({"failed": failed, "empty": empty}).collect(
            request(("failed", "empty"))
        )
        total = ProviderCollector({"failed": failed}).collect(request(("failed",)))

        self.assertFalse(partial.all_failed)
        self.assertEqual(partial.records, ())
        self.assertTrue(total.all_failed)
        self.assertEqual(
            (
                total.failures[0].provider,
                total.failures[0].category,
                total.failures[0].message,
            ),
            ("failed", "provider_error", "provider search failed"),
        )
        self.assertNotIn("TOP-SECRET", repr(total))

    def test_queued_provider_deadline_is_measured_from_collection_start(self) -> None:
        release = Event()
        collector = ProviderCollector({
            "blocked": BlockingProvider("blocked", release),
            "queued": BlockingProvider("queued", release),
        })

        started = monotonic()
        try:
            result = collector.collect(request(
                ("blocked", "queued"), timeout=0.03, concurrency=1
            ))
        finally:
            release.set()

        self.assertLess(monotonic() - started, 0.3)
        self.assertTrue(result.all_failed)
        self.assertEqual(
            tuple((item.provider, item.category) for item in result.failures),
            (("blocked", "timeout"), ("queued", "timeout")),
        )

    def test_downstream_filter_rejection_is_sanitized(self) -> None:
        class RejectingProvider(RecordingProvider):
            def search(self, spec: SearchSpec) -> tuple[ProviderRecord, ...]:
                self.specs.append(spec)
                raise ValueError("invalid year token=TOP-SECRET")

        provider = RejectingProvider("strict")

        result = ProviderCollector({"strict": provider}).collect(request(
            ("strict",), filters=(("year_from", "not-a-year"),)
        ))

        self.assertTrue(result.all_failed)
        self.assertEqual(provider.specs[0].filters, (("year_from", "not-a-year"),))
        self.assertEqual(
            (result.failures[0].category, result.failures[0].message),
            ("provider_error", "provider search failed"),
        )
        self.assertNotIn("TOP-SECRET", repr(result))

    def test_record_order_is_stable_when_completion_order_changes(self) -> None:
        first_record = ProviderRecord("first", 2, (), title="Zulu")
        second_record = ProviderRecord("second", 1, (), title="Alpha")

        def collect(first_finishes_first: bool) -> tuple[ProviderRecord, ...]:
            barrier = Barrier(2)
            release: Future[None] = Future()

            class OrderedProvider(RecordingProvider):
                def search(self, spec: SearchSpec) -> tuple[ProviderRecord, ...]:
                    self.specs.append(spec)
                    barrier.wait(timeout=1)
                    if self.name == "first" and first_finishes_first:
                        release.set_result(None)
                    elif self.name == "second" and not first_finishes_first:
                        release.set_result(None)
                    else:
                        release.result(timeout=1)
                    return self.records

            providers = {
                "first": OrderedProvider("first", (first_record,)),
                "second": OrderedProvider("second", (second_record,)),
            }
            return ProviderCollector(providers).collect(request(("first", "second"))).records

        self.assertEqual(collect(True), collect(False))
