from __future__ import annotations

import unittest
from pathlib import Path
from uuid import uuid4

from target_content_assets_support import (
    Fetcher,
    ProjectedPublisher,
    Resolver,
    candidate,
    pdf,
    stream,
)

from sciretriever.infrastructure.storage.files import CoreArtifactStore
from sciretriever.infrastructure.storage.sqlite import (
    ContentAcceptancePublisher,
    StalePublicationError,
    create_or_open_catalog,
    open_read_only_snapshot,
)
from sciretriever.kernel import CanonicalJsonObject
from sciretriever.model.assets import ContentAssetSuccess, ContentTarget
from sciretriever.model.collection import CollectionAcceptance
from sciretriever.model.execution import TargetProjection, TargetResult
from sciretriever.model.literature import Identifier, UnifiedMetadataSnapshot
from sciretriever.model.primitives import (
    AssetRole,
    BatchRunId,
    MetadataSnapshotId,
    WorkId,
    WorkVersionId,
    sha256_digest,
)
from sciretriever.services.assets import (
    AssetAcceptancePolicy,
    AssetServiceDependencies,
    ContentAssetService,
    ResolverTier,
)
from tests.target_publisher_support import ScenarioFactory


class TargetContentPublicationTests(unittest.TestCase):
    def test_reused_bytes_return_the_persisted_artifact_identity(self) -> None:
        factory = ScenarioFactory()
        self.addCleanup(factory.cleanup)
        base = factory.collection()
        base.invoke()
        assert isinstance(base.command, CollectionAcceptance)
        prepared = base.command.bibliography
        snapshot = prepared.metadata_snapshot
        assert snapshot is not None
        first_batch = BatchRunId(str(uuid4()))
        factory.batch(base.path, first_batch, prepared.work_version_id)
        content_target = ContentTarget(
            work_version_id=prepared.work_version_id,
            current_metadata=UnifiedMetadataSnapshot(
                snapshot_id=snapshot.snapshot_id,
                revision=snapshot.revision,
                title="Atomic publication a",
                authors=("Ada",),
                identifiers=(Identifier(namespace="doi", value="10.1000/publisher-a"),),
                publication_year=2026,
                sha256=snapshot.sha256,
            ),
            accepted_content=(),
            current_accepted_content=None,
            expected_metadata_revision=snapshot.revision,
            expected_accepted_content_sha256=None,
            expected_accepted_content_revision=None,
        )
        body = pdf(title="Atomic publication a", author="Ada", year=2026, doi="10.1000/publisher-a")
        publisher = ContentAcceptancePublisher(base.path)
        first_projection = self._projection(
            first_batch,
            prepared.work_version_id,
        )
        first = self._service(
            factory.root / "storage", publisher, first_projection, "first", body
        ).accept(content_target, AssetRole.PRIMARY_PDF, first_projection)
        assert isinstance(first, ContentAssetSuccess)

        second_work_id = WorkId(str(uuid4()))
        second_version_id = WorkVersionId(str(uuid4()))
        second_metadata_id = MetadataSnapshotId(str(uuid4()))
        with create_or_open_catalog(base.path) as connection:
            metadata = connection.execute(
                "SELECT revision,sha256,values_json,provenance_json FROM metadata_snapshots "
                "WHERE id=?",
                (str(snapshot.snapshot_id),),
            ).fetchone()
            assert metadata is not None
            connection.execute("INSERT INTO works(id) VALUES(?)", (str(second_work_id),))
            connection.execute(
                "INSERT INTO work_versions(id,work_id,version_role) VALUES(?,?,'formal')",
                (str(second_version_id), str(second_work_id)),
            )
            connection.execute(
                "INSERT INTO metadata_snapshots(id,work_version_id,revision,sha256,values_json,"
                "provenance_json) VALUES(?,?,?,?,?,?)",
                (str(second_metadata_id), str(second_version_id), *metadata),
            )
            connection.execute(
                "INSERT INTO work_version_current_metadata(work_version_id,metadata_snapshot_id) "
                "VALUES(?,?)",
                (str(second_version_id), str(second_metadata_id)),
            )
            connection.commit()
        second_batch = BatchRunId(str(uuid4()))
        factory.batch(base.path, second_batch, second_version_id)
        second_target = content_target.model_copy(
            update={
                "work_version_id": second_version_id,
                "current_metadata": content_target.current_metadata.model_copy(
                    update={"snapshot_id": second_metadata_id}
                ),
            }
        )
        second = self._service(
            factory.root / "storage",
            publisher,
            self._projection(second_batch, second_version_id),
            "second",
            body,
        ).accept(
            second_target, AssetRole.PRIMARY_PDF, self._projection(second_batch, second_version_id)
        )

        assert isinstance(second, ContentAssetSuccess)
        self.assertEqual(second.asset_id, first.asset_id)
        with open_read_only_snapshot(base.path) as reader:
            persisted = reader.execute(
                "SELECT artifact_id FROM work_version_assets WHERE work_version_id=?",
                (str(second_version_id),),
            ).fetchone()
        self.assertEqual(persisted, (str(second.asset_id),))

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
            work_version_id=prepared.work_version_id,
            current_metadata=UnifiedMetadataSnapshot(
                snapshot_id=snapshot.snapshot_id,
                revision=snapshot.revision,
                title="Atomic publication a",
                authors=("Ada",),
                identifiers=(Identifier(namespace="doi", value="10.1000/publisher-a"),),
                publication_year=2026,
                sha256=snapshot.sha256,
            ),
            accepted_content=(),
            current_accepted_content=None,
            expected_metadata_revision=snapshot.revision,
            expected_accepted_content_sha256=None,
            expected_accepted_content_revision=None,
        )
        storage = factory.root / "storage"
        publisher = ContentAcceptancePublisher(base.path)
        first_body = pdf(
            title="Atomic publication a", author="Ada", year=2026, doi="10.1000/publisher-a"
        )
        second_body = first_body + b"\n% ordinary-new-source"
        projection = TargetProjection(
            batch_run_id=first_batch,
            work_version_id=prepared.work_version_id,
            result=TargetResult(
                subject_type="work-version",
                subject_id=str(prepared.work_version_id),
                outcome="partially-advanced",
                initial_state="unreviewed",
                target_state="asset-ready",
                final_state="asset-ready",
                stage="asset",
                failure=None,
            ),
            details=CanonicalJsonObject(()),
            failure_stages_to_clear=(),
        )
        first = self._service(storage, publisher, projection, "first", first_body)
        second = self._service(
            storage,
            publisher,
            projection.model_copy(update={"batch_run_id": second_batch}),
            "second",
            second_body,
        )

        first.accept(content_target, AssetRole.PRIMARY_PDF, projection)
        with self.assertRaises(StalePublicationError):
            second.accept(
                content_target,
                AssetRole.PRIMARY_PDF,
                projection.model_copy(update={"batch_run_id": second_batch}),
            )

        second_hash = sha256_digest(second_body)
        self.assertTrue(
            (storage / "core" / "raw" / str(second_hash)[:2] / str(second_hash)).is_file()
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
            AssetServiceDependencies(
                tiers=(ResolverTier("first", (Resolver((item,)),), False),),
                fetcher=Fetcher({locator: stream(body)}),
                store=CoreArtifactStore(storage),
                publisher=ProjectedPublisher(publisher, projection),
            ),
            AssetAcceptancePolicy(min_pdf_bytes=300),
        )

    @staticmethod
    def _projection(
        batch_id: BatchRunId,
        work_version_id: WorkVersionId,
    ) -> TargetProjection:
        return TargetProjection(
            batch_run_id=batch_id,
            work_version_id=work_version_id,
            result=TargetResult(
                subject_type="work-version",
                subject_id=str(work_version_id),
                outcome="partially-advanced",
                initial_state="unreviewed",
                target_state="asset-ready",
                final_state="asset-ready",
                stage="asset",
                failure=None,
            ),
            details=CanonicalJsonObject(()),
            failure_stages_to_clear=(),
        )


if __name__ == "__main__":
    unittest.main()
