import asyncio
from io import BytesIO
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import threading
import time
from typing import Mapping
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from PyPDF2 import PdfWriter

from sciretriever.acquisition.candidate_executor import CandidateExecutor
from sciretriever.acquisition.identity_validation import ContentIdentityValidator
from sciretriever.acquisition.candidates import RuntimeDownloadCandidate, make_download_candidate_id
from sciretriever.acquisition.models import AcquisitionTarget
from sciretriever.acquisition.service import WorkVersionAcquisitionService
from sciretriever.catalog import AssetRepository, IdentityResolver, create_catalog_engine, initialize_catalog
from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole
from sciretriever.network import HttpResponse, QueryParams
from sciretriever.storage import AssetAcceptanceCoordinator, RawAssetStore


def pdf_bytes(label: str = "foundation") -> bytes:
    stream = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata({"/Subject": "doi: 10.1000/wp3-foundation " + label * 200})
    writer.write(stream)
    return stream.getvalue()


class Resolver:
    def __init__(self, resolver_id: str, provider: str, urls: tuple[str, ...]) -> None:
        self.resolver_id = resolver_id
        self.provider = provider
        self.urls = urls

    def resolve(self, target, role, *, timeout):
        del target
        del timeout
        return tuple(
            RuntimeDownloadCandidate(
                make_download_candidate_id(self.provider, self.resolver_id, role, f"rc1:item-{index}"),
                self.provider,
                self.resolver_id,
                self.provider,
                f"rc1:item-{index}",
                url,
                role,
                index,
                "https",
                "resolver",
                f"host:{self.provider}-{index}.test",
                {"provider": self.provider, "index": index},
                media_type_hint="application/pdf",
            )
            for index, url in enumerate(self.urls)
        )


class Transport:
    def __init__(self, responses: Mapping[str, tuple[float, bytes]]) -> None:
        self.responses = responses
        self.calls: list[str] = []
        self.lock = threading.Lock()

    def get(self, url: str, *, params: QueryParams | None = None, headers=None, timeout=None):
        del params, headers, timeout
        with self.lock:
            self.calls.append(url)
        delay, body = self.responses[url]
        time.sleep(delay)
        return HttpResponse(200, url, {"content-type": "application/pdf"}, body)

    def resolve_host(self, hostname: str) -> tuple[str, ...]:
        del hostname
        return ("192.0.2.1",)


class WP3FoundationTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.catalog = create_catalog_engine(root / "catalog.sqlite")
        initialize_catalog(self.catalog)
        self.addCleanup(self.catalog.dispose)
        self.assets = AssetRepository(self.catalog)
        asset_root = root / "assets"
        asset_root.mkdir()
        self.store = RawAssetStore(asset_root)
        self.coordinator = AssetAcceptanceCoordinator(self.assets, self.store)
        resolution = IdentityResolver(self.catalog).create_or_reuse_work({"doi": "10.1000/wp3-foundation"})
        assert resolution.work_version is not None
        self.work_version_id = resolution.work_version.id

    def test_fresh_schema_has_no_durable_acquisition_tasks(self) -> None:
        with self.catalog.connect() as connection:
            tables = set(connection.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).scalars())
            intent_columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(asset_intents)")}
            failure_columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(failures)")}
        self.assertTrue({"download_requests", "acquisition_jobs", "acquisition_attempts"}.isdisjoint(tables))
        self.assertTrue({"job_id", "attempt_id"}.isdisjoint(intent_columns))
        self.assertTrue({"job_id", "attempt_id"}.isdisjoint(failure_columns))

    def test_provider_race_uses_sequential_candidates_and_has_one_winner(self) -> None:
        invalid = b"not a pdf"
        winner = pdf_bytes("winner")
        late = pdf_bytes("late")
        transport = Transport({
            "https://one.test/first": (0.0, invalid),
            "https://one.test/second": (0.01, winner),
            "https://two.test/late": (0.2, late),
        })
        service = WorkVersionAcquisitionService(
            self.assets,
            self.coordinator,
            {
                "one": Resolver("one", "one", ("https://one.test/first", "https://one.test/second")),
                "two": Resolver("two", "two", ("https://two.test/late",)),
            },
            CandidateExecutor(transport, identity_validator=ContentIdentityValidator()),
        )
        result = asyncio.run(service.acquire(
            self.work_version_id,
            AssetRole.PRIMARY_PDF,
            AcquisitionTarget((Identifier("doi", "10.1000/wp3-foundation"),), role=AssetRole.PRIMARY_PDF),
            ("one", "two"),
            timeout=1.0,
        ))
        self.assertEqual(result.status, "succeeded")
        self.assertLess(transport.calls.index("https://one.test/first"), transport.calls.index("https://one.test/second"))
        time.sleep(0.25)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM raw_assets").scalar_one(), 1)
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM work_version_assets").scalar_one(), 1)
            diagnostic = connection.exec_driver_sql(
                "SELECT outcome, details_json FROM acquisition_diagnostics"
            ).one()
        self.assertEqual(diagnostic[0], "succeeded")
        self.assertIn('"provider":"two"', diagnostic[1])

        reused = asyncio.run(service.acquire(
            self.work_version_id,
            AssetRole.PRIMARY_PDF,
            AcquisitionTarget((Identifier("doi", "10.1000/wp3-foundation"),), role=AssetRole.PRIMARY_PDF),
            ("one", "two"),
            timeout=1.0,
        ))
        self.assertEqual(reused.status, "reused")
        self.assertEqual(reused.raw_asset_id, result.raw_asset_id)

    def test_validation_failure_leaves_no_asset_and_records_overall_failure(self) -> None:
        transport = Transport({"https://bad.test/file": (0.0, b"html")})
        service = WorkVersionAcquisitionService(
            self.assets,
            self.coordinator,
            {"bad": Resolver("bad", "bad", ("https://bad.test/file",))},
            CandidateExecutor(transport),
        )
        result = asyncio.run(service.acquire(
            self.work_version_id,
            AssetRole.PRIMARY_PDF,
            AcquisitionTarget((), role=AssetRole.PRIMARY_PDF),
            ("bad",),
            timeout=1.0,
        ))
        self.assertEqual(result.status, "failed")
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM raw_assets").scalar_one(), 0)
            self.assertEqual(connection.exec_driver_sql("SELECT outcome FROM acquisition_diagnostics").scalar_one(), "failed")

    def test_concurrent_same_role_acceptance_converges(self) -> None:
        data = pdf_bytes("concurrent")
        barrier = threading.Barrier(2)
        results = []

        def accept() -> None:
            barrier.wait()
            results.append(self.coordinator.accept(
                BytesIO(data), self.work_version_id, AssetRole.PRIMARY_PDF,
                "application/pdf", "pdf", {"provider": "thread"},
            ))

        threads = [threading.Thread(target=accept) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(5)
        self.assertEqual(len(results), 2)
        self.assertEqual({item.raw_asset.id for item in results}, {results[0].raw_asset.id})
        self.assertEqual({item.intent.id for item in results}, {results[0].intent.id})


if __name__ == "__main__":
    import unittest
    unittest.main()
