from __future__ import annotations

import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from target_light_document_support import (
    ASSET_ID,
    TaskBoundaryService,
    manifest_blocks,
    parsed_document,
    parser_request,
    pdf_bytes,
)

from sciretriever.core.documents import document_bytes, validate_light_document
from sciretriever.infrastructure.parsers.mineru import (
    MinerUArchiveAdapter,
    MinerUArchiveBounds,
    MinerUServiceBounds,
    OperatorManagedMinerUAdapter,
)
from sciretriever.infrastructure.storage.files import CoreArtifactStore
from sciretriever.model.assets import AssetPublication, PublishedArtifact, StagedArtifact
from sciretriever.model.canonical_json import CanonicalJsonObject
from sciretriever.model.documents import LightDocumentBounds, LightPublicationTarget
from sciretriever.model.execution import (
    TargetProjection,
    TargetResult,
    ValidatedDocumentAcceptance,
)
from sciretriever.model.primitives import (
    BatchRunId,
    WorkVersionAssetId,
    WorkVersionId,
    sha256_digest,
)
from sciretriever.services.documents import DocumentServiceDependencies, LightDocumentService


class M5DocumentsCharacterizationTests(unittest.TestCase):
    def test_existing_document_round_trip_preserves_canonical_bytes(self) -> None:
        document = validate_light_document(
            parsed_document(), ASSET_ID, 2, manifest_blocks(), LightDocumentBounds()
        )

        round_tripped = type(document).model_validate_json(document.model_dump_json())

        self.assertEqual(round_tripped, document)
        self.assertEqual(document_bytes(round_tripped), document_bytes(document))

    def test_existing_parser_resume_does_not_submit_a_second_task(self) -> None:
        pdf = pdf_bytes()
        service = TaskBoundaryService("unused", "none")
        adapter = OperatorManagedMinerUAdapter(
            service,
            MinerUArchiveAdapter(MinerUArchiveBounds()),
            MinerUServiceBounds(max_polls=2),
        )

        result = adapter.parse(parser_request(pdf, resume_task_id="approved-task"))

        self.assertEqual(result.provenance.task_id, "approved-task")
        self.assertEqual((service.polls,), (1,))

    def test_existing_publication_publishes_artifact_before_catalog_acceptance(self) -> None:
        events: list[str] = []

        class Store:
            def __init__(self, root: Path) -> None:
                self._store = CoreArtifactStore(root)

            def publish(self, artifact: StagedArtifact) -> PublishedArtifact:
                events.append("artifact")
                return self._store.publish(artifact)

        class Sink:
            command: ValidatedDocumentAcceptance | None = None

            def publish(self, acceptance: ValidatedDocumentAcceptance) -> AssetPublication | None:
                events.append("catalog")
                self.command = acceptance
                return None

        pdf = pdf_bytes()
        document = validate_light_document(
            parsed_document(), ASSET_ID, 2, manifest_blocks(), LightDocumentBounds()
        )
        target = LightPublicationTarget(
            work_version_id=WorkVersionId("00000000-0000-0000-0000-000000000201"),
            primary_relation_id=WorkVersionAssetId("00000000-0000-0000-0000-000000000202"),
            primary_asset_id=ASSET_ID,
            primary_sha256=sha256_digest(pdf),
        )
        parser = OperatorManagedMinerUAdapter(
            TaskBoundaryService("unused", "none"),
            MinerUArchiveAdapter(MinerUArchiveBounds()),
            MinerUServiceBounds(max_polls=2),
        )

        with TemporaryDirectory(prefix="sciretriever-m5-characterization-") as directory:
            os.chmod(directory, 0o700)
            sink = Sink()
            projection = TargetProjection(
                batch_run_id=BatchRunId("00000000-0000-0000-0000-000000000203"),
                work_version_id=target.work_version_id,
                result=TargetResult(
                    subject_type="work-version",
                    subject_id=str(target.work_version_id),
                    outcome="partially-advanced",
                    initial_state="asset-ready",
                    target_state="light-text-ready",
                    final_state="light-text-ready",
                    stage="parsing",
                    failure=None,
                ),
                details=CanonicalJsonObject(()),
                failure_stages_to_clear=("parsing",),
            )
            publication = LightDocumentService(
                DocumentServiceDependencies(parser, Store(Path(directory) / "storage"), sink)
            ).accept(target, parser_request(pdf), projection)

        self.assertEqual(events, ["artifact", "catalog"])
        self.assertEqual(publication.artifact.sha256, sha256_digest(document_bytes(document)))
        self.assertIsNotNone(sink.command)


if __name__ == "__main__":
    unittest.main()
