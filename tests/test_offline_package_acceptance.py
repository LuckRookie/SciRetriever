import asyncio
from io import BytesIO
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
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
from sciretriever.acquisition.service import WorkVersionAcquisitionService
from sciretriever.catalog import AssetRepository, IdentityResolver, create_catalog_engine, initialize_catalog
from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole
from sciretriever.network import HttpResponse
from sciretriever.normalization.contracts import NormalizationParameters
from sciretriever.packaging.pipeline import PackagePipeline
from sciretriever.storage import AssetAcceptanceCoordinator, DerivedArtifactStore, RawAssetStore


def pdf_bytes() -> bytes:
    stream = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata({
        "/Title": "Offline package acceptance",
        "/Subject": "doi: 10.1000/offline-package " + "evidence" * 200,
    })
    writer.write(stream)
    return stream.getvalue()


class Resolver:
    resolver_id = "offline"
    provider = "offline"

    def resolve(self, target, role, *, timeout):
        del target, timeout
        cursor = "rc1:offline"
        return (RuntimeDownloadCandidate(
            make_download_candidate_id(self.provider, self.resolver_id, role, cursor),
            self.provider, self.resolver_id, self.provider, cursor,
            "https://offline.test/article.pdf", role, 0, "https", "resolver",
            "host:offline.test", {"fixture": "offline"}, media_type_hint="application/pdf",
        ),)


class Transport:
    def __init__(self) -> None:
        self.calls = 0

    def get(self, url, *, params=None, headers=None, timeout=None):
        del params, headers, timeout
        self.calls += 1
        return HttpResponse(200, url, {"content-type": "application/pdf"}, pdf_bytes())

    def resolve_host(self, hostname):
        del hostname
        return ("192.0.2.1",)


class OfflinePackageAcceptanceTests(TestCase):
    def test_existing_workversion_acquisition_to_document_package_and_replay(self) -> None:
        with TemporaryDirectory() as directory:
            base = Path(directory)
            storage_root = base / "storage"
            storage_root.mkdir()
            catalog = create_catalog_engine(base / "catalog.sqlite")
            initialize_catalog(catalog)
            self.addCleanup(catalog.dispose)
            resolution = IdentityResolver(catalog).create_or_reuse_work(
                (Identifier("doi", "10.1000/offline-package"),)
            )
            assert resolution.work_version is not None
            version_id = resolution.work_version.id
            assets = AssetRepository(catalog)
            raw_store = RawAssetStore(storage_root)
            transport = Transport()
            service = WorkVersionAcquisitionService(
                assets,
                AssetAcceptanceCoordinator(assets, raw_store),
                {"offline": Resolver()},
                CandidateExecutor(transport, identity_validator=ContentIdentityValidator()),
            )
            target = AcquisitionTarget((Identifier("doi", "10.1000/offline-package"),))
            acquired = asyncio.run(service.acquire(
                version_id, AssetRole.PRIMARY_PDF, target, ("offline",), timeout=1.0
            ))
            replayed = asyncio.run(service.acquire(
                version_id, AssetRole.PRIMARY_PDF, target, ("offline",), timeout=1.0
            ))
            self.assertEqual(acquired.status, "succeeded")
            self.assertEqual(replayed.status, "reused")
            self.assertEqual(transport.calls, 1)

            pipeline = PackagePipeline(
                catalog,
                raw_store,
                DerivedArtifactStore(storage_root),
                normalization_parameters=NormalizationParameters(),
            )
            first = pipeline.run(work_version_id=version_id)
            replay = pipeline.run(work_version_id=version_id)
            self.assertEqual(first.record.id, replay.record.id)
            self.assertEqual(first.record.work_version_id, version_id)
            self.assertEqual(len(first.package.files), 1)
            self.assertEqual(first.package.files[0].file_id, acquired.raw_asset_id)


if __name__ == "__main__":
    import unittest
    unittest.main()
