import asyncio
from io import BytesIO
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import time
from unittest import TestCase

from PyPDF2 import PdfWriter

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition.candidate_executor import CandidateExecutor
from sciretriever.acquisition.identity_validation import ContentIdentityValidator
from sciretriever.acquisition.candidates import RuntimeDownloadCandidate, make_download_candidate_id
from sciretriever.acquisition.models import AcquisitionTarget
from sciretriever.acquisition.pacing import DocumentStartGate
from sciretriever.acquisition.service import WorkVersionAcquisitionService
from sciretriever.catalog import AssetRepository, IdentityResolver, create_catalog_engine, initialize_catalog
from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole
from sciretriever.errors import AcquisitionError
from sciretriever.network import HttpResponse
from sciretriever.storage import AssetAcceptanceCoordinator, RawAssetStore


def pdf_bytes(label: str) -> bytes:
    stream = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata({"/Subject": f"doi: 10.1000/p5 {label * 200}"})
    writer.write(stream)
    return stream.getvalue()


class Resolver:
    def __init__(self, name: str, urls: tuple[str, ...]) -> None:
        self.resolver_id = name
        self.name = name
        self.provider = name
        self.urls = urls

    def resolve(self, target, role, *, timeout):
        del target
        del timeout
        return tuple(RuntimeDownloadCandidate(
            make_download_candidate_id(self.name, self.resolver_id, role, f"rc1:c-{index}"),
            self.name, self.resolver_id, self.name, f"rc1:c-{index}", url,
            role, index, "https", "resolver", f"host:{self.name}-{index}.test",
            {"provider": self.name}, media_type_hint="application/pdf",
        ) for index, url in enumerate(self.urls))


class Transport:
    def __init__(self, responses: dict[str, tuple[float, int, bytes]]) -> None:
        self.responses = responses
        self.calls: list[str] = []

    def get(self, url, *, params=None, headers=None, timeout=None):
        del params, headers, timeout
        self.calls.append(url)
        delay, status, body = self.responses[url]
        time.sleep(delay)
        return HttpResponse(status, url, {"content-type": "application/pdf"}, body)

    def resolve_host(self, hostname):
        del hostname
        return ("192.0.2.1",)


class RecordingGate(DocumentStartGate):
    def __init__(self) -> None:
        super().__init__()
        self.calls: list[float] = []

    async def wait(self, applicable_interval: float = 0.0) -> float:
        self.calls.append(applicable_interval)
        return float(len(self.calls) - 1)


class ForegroundAcquisitionTests(TestCase):
    def setUp(self) -> None:
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.engine = create_catalog_engine(root / "catalog.sqlite")
        initialize_catalog(self.engine)
        self.addCleanup(self.engine.dispose)
        storage = root / "storage"
        storage.mkdir()
        self.assets = AssetRepository(self.engine)
        self.coordinator = AssetAcceptanceCoordinator(self.assets, RawAssetStore(storage))
        resolution = IdentityResolver(self.engine).create_or_reuse_work({"doi": "10.1000/p5"})
        assert resolution.work_version is not None
        self.work_version_id = resolution.work_version.id

    def service(
        self,
        transport: Transport,
        resolvers: dict[str, Resolver],
        gate: DocumentStartGate | None = None,
    ):
        return WorkVersionAcquisitionService(
            self.assets, self.coordinator, resolvers,
            CandidateExecutor(transport, identity_validator=ContentIdentityValidator()),
            document_gate=gate,
        )

    def run_acquisition(self, service, providers):
        return asyncio.run(service.acquire(
            self.work_version_id, AssetRole.PRIMARY_PDF,
            AcquisitionTarget((Identifier("doi", "10.1000/p5"),), role=AssetRole.PRIMARY_PDF),
            providers, timeout=1.0,
        ))

    def test_serial_provider_fallback_and_idempotent_reuse(self) -> None:
        urls = ("https://first.test/file", "https://second.test/file")
        transport = Transport({urls[0]: (0, 404, b""), urls[1]: (0, 200, pdf_bytes("second"))})
        gate = RecordingGate()
        service = self.service(transport, {
            "first": Resolver("first", (urls[0],)), "second": Resolver("second", (urls[1],)),
        }, gate)
        result = self.run_acquisition(service, ("first", "second"))
        self.assertEqual(result.status, "succeeded")
        self.assertIn(urls[1], transport.calls)
        calls = list(transport.calls)
        replay = self.run_acquisition(service, ("first", "second"))
        self.assertEqual(replay.status, "reused")
        self.assertEqual(transport.calls, calls)
        self.assertEqual(gate.calls, [0.0])

    def test_race_accepts_one_winner_and_late_loser_cannot_publish(self) -> None:
        fast = "https://fast.test/file"
        slow = "https://slow.test/file"
        transport = Transport({fast: (0.01, 200, pdf_bytes("fast")), slow: (0.2, 200, pdf_bytes("slow"))})
        result = self.run_acquisition(self.service(transport, {
            "fast": Resolver("fast", (fast,)), "slow": Resolver("slow", (slow,)),
        }), ("fast", "slow"))
        self.assertEqual(result.status, "succeeded")
        time.sleep(0.25)
        with self.engine.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM raw_assets").scalar_one(), 1)
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM diagnostic_records").scalar_one(), 0)

    def test_exhaustion_records_one_workversion_failure_without_asset(self) -> None:
        url = "https://bad.test/file"
        result = self.run_acquisition(self.service(
            Transport({url: (0, 200, b"not-pdf")}), {"bad": Resolver("bad", (url,))}
        ), ("bad",))
        self.assertEqual(result.status, "failed")
        with self.engine.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM raw_assets").scalar_one(), 0)
            self.assertEqual(connection.exec_driver_sql(
                "SELECT count(*) FROM diagnostic_records WHERE stage='acquisition' AND work_version_id=?",
                (self.work_version_id,),
            ).scalar_one(), 1)

    def test_existing_workversion_is_required(self) -> None:
        service = self.service(Transport({}), {"missing": Resolver("missing", ())})
        with self.assertRaises(AcquisitionError):
            asyncio.run(service.acquire(
                "00000000-0000-4000-8000-000000000001", AssetRole.PRIMARY_PDF,
                AcquisitionTarget((), role=AssetRole.PRIMARY_PDF),
                ("missing",), timeout=1.0,
            ))


if __name__ == "__main__":
    import unittest
    unittest.main()
