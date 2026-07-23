import asyncio
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition import (
    AcquisitionTarget,
    AdmissionService,
    MultiSourceOrchestrator,
    ProviderContent,
    RoutingMode,
    SourceEntry,
    SourcePlan,
)
from sciretriever.catalog import (
    AssetRepository,
    IdentityResolver,
    JobRepository,
    ReadOnlyCatalogView, initialize_catalog, create_catalog_engine,
open_read_only_catalog_engine,
)
from sciretriever.core.contracts import SearchSpec
from sciretriever.core.enums import AssetRole, PackageQuality
from sciretriever.discovery import discover
from sciretriever.discovery.labeling import KeywordRuleLabeler
from sciretriever.discovery.models import ProviderRecord
from sciretriever.packaging import PackagePipeline
from sciretriever.storage import AssetAcceptanceCoordinator, DerivedArtifactStore, RawAssetStore


RUN_ID = "00000000-0000-4000-8000-000000000001"
RETRIEVED_AT = "2026-07-21T12:00:00Z"


class FakeDiscoveryProvider:
    name = "offline"

    def search(self, spec: SearchSpec) -> tuple[ProviderRecord, ...]:
        if spec.query != "offline package acceptance":
            raise AssertionError("unexpected search specification")
        return (
            ProviderRecord(
                "offline",
                1,
                (("doi", "10.1000/offline-package"),),
                title="Offline Package Study",
                abstract="Complete offline acceptance article",
                authors=("Test Author",),
                year=2026,
                venue="Offline Journal",
            ),
        )


class FakeAcquisitionProvider:
    name = "offline-xml"

    def initial_url(self, target: AcquisitionTarget) -> str:
        return "https://offline.example/article.xml"

    def acquire(self, target: AcquisitionTarget, *, timeout: float) -> ProviderContent:
        del target, timeout
        payload = (
            b"<article><title>Offline Package Study</title><p>Complete body text.</p>"
            b"<table-wrap><caption><title>Measurements</title></caption><table>"
            b"<tr><th>Label</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr>"
            b"</table><table-wrap-foot><p>Measured offline.</p></table-wrap-foot>"
            b"</table-wrap><ref>doi:10.1000/offline-package</ref></article>"
        )
        return ProviderContent(
            AssetRole.XML,
            "application/xml",
            "xml",
            "https://offline.example/article.xml",
            self.name,
            payload,
            {"agent": "offline-acceptance"},
        )


class OfflinePackageAcceptanceTests(TestCase):
    def test_search_spec_through_acquisition_to_document_package(self) -> None:
        with TemporaryDirectory() as temporary:
            base = Path(temporary)
            storage_root = base / "storage"
            storage_root.mkdir()
            catalog = create_catalog_engine(base / "catalog.sqlite")
            self.addCleanup(catalog.dispose)
            initialize_catalog(catalog)

            read_only_engine = open_read_only_catalog_engine(base / "catalog.sqlite")
            try:
                entries = discover(
                    SearchSpec("offline package acceptance", ("offline",), 1),
                    providers={"offline": FakeDiscoveryProvider()},
                    catalog=ReadOnlyCatalogView(read_only_engine),
                    labeler=KeywordRuleLabeler(
                        "topic", "1", {"offline": ("offline",)},
                    ),
                    intake_run_id=RUN_ID,
                    retrieved_at=RETRIEVED_AT,
                )
            finally:
                read_only_engine.dispose()
            self.assertEqual(len(entries), 1)
            entry = entries[0]

            assets = AssetRepository(catalog)
            jobs = JobRepository(catalog)
            identity = IdentityResolver(catalog)
            admission = AdmissionService(identity, jobs, assets).admit(
                entry.identifiers,
                entry.metadata,
                provider="multi-source",
                asset_role=AssetRole.XML,
                source_plan=SourcePlan(
                    AssetRole.XML,
                    RoutingMode.SERIAL,
                    (SourceEntry("offline-xml", "offline-xml", 0),),
                ),
                provenance=entry.provenance.to_dict(),
            )
            raw_store = RawAssetStore(storage_root)
            acquisition = asyncio.run(
                MultiSourceOrchestrator(
                    jobs,
                    AssetAcceptanceCoordinator(assets, raw_store),
                    {"offline-xml": FakeAcquisitionProvider()},
                ).acquire(
                    admission,
                    AcquisitionTarget(entry.identifiers, role=AssetRole.XML),
                    SourcePlan(
                        AssetRole.XML,
                        RoutingMode.SERIAL,
                        (SourceEntry("offline-xml", "offline-xml", 0),),
                    ),
                    timeout=1,
                )
            )
            self.assertEqual(acquisition.status, "succeeded")

            pipeline = PackagePipeline(catalog, raw_store, DerivedArtifactStore(storage_root))
            resolution = identity.create_or_reuse_work(entry.identifiers, entry.metadata)
            first = pipeline.run(work_id=resolution.work.id)
            replay = pipeline.run(work_id=resolution.work.id)
            self.assertTrue(first.created)
            self.assertFalse(replay.created)
            self.assertEqual(replay.package, first.package)
            package = first.package
            package.validate_hash()
            self.assertIs(package.quality, PackageQuality.LIMITED_XML_HTML)
            self.assertEqual(package.identifiers, entry.identifiers)
            self.assertEqual(package.normalized_content.tables[0].caption, "Measurements")
            self.assertEqual(
                tuple(cell.text for cell in package.normalized_content.tables[0].cells),
                ("Label", "Value", "A", "1"),
            )
            self.assertTrue(package.evidence)
            self.assertIsNotNone(package.light_structure.summary)
            self.assertEqual({artifact.kind for artifact in package.artifacts}, {
                "light_structure", "normalized_content", "source_map",
            })
            with catalog.connect() as connection:
                self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM package_versions").scalar_one(), 1)
                self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_key_check").all(), [])


if __name__ == "__main__":
    import unittest

    unittest.main()
