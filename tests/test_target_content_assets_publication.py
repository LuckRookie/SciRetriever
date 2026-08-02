from __future__ import annotations

import unittest
from dataclasses import replace
from pathlib import Path

from target_content_assets_support import (
    Fetcher,
    ProjectedPublisher,
    Resolver,
    candidate,
    pdf,
    stream,
)
from target_publisher_support import ScenarioFactory

from sciretriever.batching.api import TargetProjection, TargetResult
from sciretriever.collection.api import CollectionAcceptance
from sciretriever.content.assets import AssetAcceptancePolicy, ContentAssetService, ResolverTier
from sciretriever.content.model import ContentTarget, UnifiedMetadataSnapshot
from sciretriever.kernel import CanonicalJsonObject
from sciretriever.literature_store.filesystem import CoreArtifactStore
from sciretriever.literature_store.sqlite import (
    ContentAcceptancePublisher,
    StalePublicationError,
    open_read_only_snapshot,
)
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import AssetRole, BatchRunId, sha256_digest


class TargetContentPublicationTests(unittest.TestCase):
    def test_stale_second_primary_leaves_safe_orphan_and_one_catalog_winner(self) -> None:
        factory = ScenarioFactory()
        self.addCleanup(factory.cleanup)
        base = factory.collection()
        base.invoke()
        assert isinstance(base.command, CollectionAcceptance)
        prepared = base.command.bibliography
        snapshot = prepared.metadata_snapshot
        assert snapshot is not None
        first_batch = BatchRunId("00000000-0000-0000-0000-000000000010")
        second_batch = BatchRunId("00000000-0000-0000-0000-000000000011")
        factory.batch(base.path, first_batch, prepared.work_version_id)
        factory.batch(base.path, second_batch, prepared.work_version_id)
        content_target = ContentTarget(
            prepared.work_version_id,
            UnifiedMetadataSnapshot(
                snapshot.snapshot_id,
                snapshot.revision,
                "Atomic publication a",
                ("Ada",),
                (Identifier(namespace="doi", value="10.1000/publisher-a"),),
                publication_year=2026,
                sha256=snapshot.sha256,
            ),
            (),
            None,
            snapshot.revision,
            None,
            None,
        )
        storage = factory.root / "storage"
        publisher = ContentAcceptancePublisher(base.path)
        first_body = pdf(
            title="Atomic publication a", author="Ada", year=2026, doi="10.1000/publisher-a"
        )
        second_body = first_body + b"\n% ordinary-new-source"
        projection = TargetProjection(
            first_batch,
            prepared.work_version_id,
            TargetResult.PARTIALLY_ADVANCED,
            CanonicalJsonObject(()),
            (),
        )
        first = self._service(storage, publisher, projection, "first", first_body)
        second = self._service(
            storage,
            publisher,
            replace(projection, batch_run_id=second_batch),
            "second",
            second_body,
        )

        first.accept(content_target, AssetRole.PRIMARY_PDF)
        with self.assertRaises(StalePublicationError):
            second.accept(content_target, AssetRole.PRIMARY_PDF)

        second_hash = sha256_digest(second_body)
        self.assertTrue(
            (storage / "core" / "primary" / str(second_hash)[:2] / str(second_hash)).is_file()
        )
        with open_read_only_snapshot(base.path) as reader:
            self.assertEqual(
                reader.execute("SELECT count(*) FROM accepted_primary_assets").fetchone(), (1,)
            )

    @staticmethod
    def _service(
        storage: Path,
        publisher: ContentAcceptancePublisher,
        projection: TargetProjection,
        locator: str,
        body: bytes,
    ) -> ContentAssetService:
        item = candidate(locator)
        return ContentAssetService(
            (ResolverTier("first", (Resolver((item,)),), False),),
            Fetcher({locator: stream(body)}),
            CoreArtifactStore(storage),
            ProjectedPublisher(publisher, projection),
            AssetAcceptancePolicy(min_pdf_bytes=300),
        )


if __name__ == "__main__":
    unittest.main()
