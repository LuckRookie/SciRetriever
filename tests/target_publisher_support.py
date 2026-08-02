from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Protocol
from uuid import uuid4

from sciretriever.batching.api import (
    ContentAcceptanceCommand,
    FailureStage,
    ImportAcceptanceCommand,
    TargetProjection,
    TargetResult,
)
from sciretriever.bibliography.api import (
    CompletionAnalysisFact,
    CompletionProvenance,
    CompletionSubmission,
    FinalMetadataFact,
    ReferenceSetFact,
    ReferenceSetId,
    TagSetFact,
    TagSetId,
    metadata_snapshot_sha256,
)
from sciretriever.bibliography.identity import prepare_initial_ingest
from sciretriever.bibliography.identity_model import BibliographicObservation, InitialMetadata
from sciretriever.collection.api import (
    CollectionAcceptance,
    CollectionMembershipFact,
)
from sciretriever.content.api import (
    ArtifactKind,
    LightDocumentAcceptance,
    PrimaryPdfAcceptance,
    PublishedArtifact,
)
from sciretriever.interoperability.ports import ImportRecordProjection, ImportResult
from sciretriever.kernel import CanonicalJsonObject
from sciretriever.literature_store.sqlite import (
    CollectionAcceptancePublisher,
    CompletionPublisher,
    ContentAcceptancePublisher,
    ImportAcceptancePublisher,
    SqliteBibliographyRepository,
    create_or_open_catalog,
)
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import (
    AnalysisArtifactId,
    AssetId,
    BatchRunId,
    CollectionId,
    CollectionRunId,
    LightDocumentId,
    MembershipId,
    MetadataSnapshotId,
    RelativeArtifactPath,
    Sha256,
    UtcTimestamp,
    WorkVersionAssetId,
    sha256_digest,
)

EMPTY = CanonicalJsonObject(())


class Publisher(Protocol):
    def publish(self, command) -> None: ...


@dataclass(frozen=True, slots=True)
class Scenario:
    path: Path
    publisher: Publisher | CompletionPublisher
    command: (
        CollectionAcceptance
        | ImportAcceptanceCommand
        | ContentAcceptanceCommand
        | CompletionSubmission
    )
    authority_table: str
    target: TargetProjection | None = None

    def invoke(self) -> None:
        if isinstance(self.publisher, CompletionPublisher):
            assert isinstance(self.command, CompletionSubmission)
            assert self.target is not None
            self.publisher.publish_completion(self.command, self.target)
        else:
            self.publisher.publish(self.command)


class ScenarioFactory:
    def __init__(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-task9-repair-")
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)
        self.index = 0

    def cleanup(self) -> None:
        self.temporary.cleanup()

    def catalog(self) -> Path:
        self.index += 1
        path = self.root / f"scenario-{self.index}.sqlite"
        with create_or_open_catalog(path):
            pass
        return path

    @staticmethod
    def prepared(path: Path, suffix: str = "a"):
        observation = BibliographicObservation(
            "crossref",
            f"record-{suffix}",
            0,
            UtcTimestamp("2026-07-31T00:00:00Z"),
            (Identifier(namespace="doi", value=f"10.1000/publisher-{suffix}"),),
            InitialMetadata(f"Atomic publication {suffix}", ("Ada",), 2026, "article"),
            "formal",
        )
        return prepare_initial_ingest(SqliteBibliographyRepository(path), (observation,))

    @staticmethod
    def artifact(kind: ArtifactKind, content: bytes) -> PublishedArtifact:
        digest = sha256_digest(content)
        directories = {
            ArtifactKind.PRIMARY_PDF: "primary",
            ArtifactKind.SUPPLEMENTARY: "supplementary",
            ArtifactKind.LIGHT_DOCUMENT: "light-document",
            ArtifactKind.ANALYSIS: "analysis",
        }
        path = RelativeArtifactPath(f"{directories[kind]}/{str(digest)[:2]}/{digest}")
        return PublishedArtifact(kind, path, digest, len(content))

    @staticmethod
    def batch(path: Path, batch_id: BatchRunId, version_id, kind: str = "work-version") -> None:
        batch_type = "bibliography-import" if kind == "import-record" else "process"
        with create_or_open_catalog(path) as connection:
            connection.execute(
                "INSERT INTO batch_runs(id,batch_type,status,scope_json,counts_json) "
                "VALUES(?,?, 'running','{}','{}')",
                (str(batch_id), batch_type),
            )
            connection.execute(
                "INSERT INTO batch_targets(id,batch_run_id,target_kind,target_id,input_ordinal) "
                "VALUES(?,?,?,?,?)",
                (
                    str(uuid4()),
                    str(batch_id),
                    kind,
                    str(version_id),
                    0 if kind == "import-record" else None,
                ),
            )
            connection.commit()

    def collection(self, callback=None) -> Scenario:
        path, prepared = self.catalog(), None
        prepared = self.prepared(path)
        collection_id, run_id = CollectionId(str(uuid4())), CollectionRunId(str(uuid4()))
        with create_or_open_catalog(path) as connection:
            connection.execute(
                "INSERT INTO collections(id,name) VALUES(?,'target')", (str(collection_id),)
            )
            connection.execute(
                "INSERT INTO collection_runs(id,collection_id,mode,topic_conditions_json,"
                "requested_advance_to,status) VALUES(?,?,'topic','{}','completed','running')",
                (str(run_id), str(collection_id)),
            )
            connection.commit()
        command = CollectionAcceptance(
            prepared,
            CollectionMembershipFact(
                MembershipId(str(uuid4())), collection_id, prepared.work_id, run_id
            ),
            (),
            (),
        )
        return Scenario(
            path,
            CollectionAcceptancePublisher(path, failpoint=callback),
            command,
            "collection_memberships",
        )

    def imported(self, callback=None) -> Scenario:
        path = self.catalog()
        prepared = self.prepared(path)
        batch_id = BatchRunId(str(uuid4()))
        self.batch(path, batch_id, prepared.work_version_id, "import-record")
        references = ReferenceSetFact(ReferenceSetId(str(uuid4())), prepared.work_version_id, 1, ())
        tags = TagSetFact(TagSetId(str(uuid4())), prepared.work_version_id, 1, ())
        record = ImportRecordProjection(
            batch_id,
            prepared.work_version_id,
            0,
            ImportResult.CREATED,
            CanonicalJsonObject((("reason", "accepted"),)),
        )
        return Scenario(
            path,
            ImportAcceptancePublisher(path, failpoint=callback),
            ImportAcceptanceCommand(prepared, references, tags, record),
            "reference_sets",
        )

    def primary(self, callback=None) -> Scenario:
        base = self.collection()
        base.invoke()
        assert isinstance(base.command, CollectionAcceptance)
        prepared = base.command.bibliography
        snapshot = prepared.metadata_snapshot
        assert snapshot is not None
        batch_id = BatchRunId(str(uuid4()))
        self.batch(base.path, batch_id, prepared.work_version_id)
        artifact = self.artifact(ArtifactKind.PRIMARY_PDF, b"%PDF-primary")
        acceptance = PrimaryPdfAcceptance(
            prepared.work_version_id,
            snapshot.snapshot_id,
            snapshot.revision,
            snapshot.sha256,
            AssetId(str(uuid4())),
            WorkVersionAssetId(str(uuid4())),
            artifact,
            EMPTY,
        )
        target = TargetProjection(
            batch_id,
            prepared.work_version_id,
            TargetResult.PARTIALLY_ADVANCED,
            EMPTY,
            (FailureStage.ACQUISITION,),
        )
        return Scenario(
            base.path,
            ContentAcceptancePublisher(base.path, failpoint=callback),
            ContentAcceptanceCommand(acceptance, target),
            "accepted_primary_assets",
        )

    def light(self, callback=None) -> Scenario:
        base = self.primary()
        base.invoke()
        assert isinstance(base.command, ContentAcceptanceCommand)
        acceptance = base.command.acceptance
        assert isinstance(acceptance, PrimaryPdfAcceptance)
        with create_or_open_catalog(base.path) as connection:
            connection.execute("UPDATE batch_targets SET result_json=NULL")
            connection.commit()
        document = CanonicalJsonObject((("blocks", (CanonicalJsonObject((("text", "atomic"),)),)),))
        artifact = self.artifact(ArtifactKind.LIGHT_DOCUMENT, b'{"blocks":[{"text":"atomic"}]}')
        light = LightDocumentAcceptance(
            acceptance.work_version_id,
            acceptance.relation_id,
            acceptance.artifact.sha256,
            LightDocumentId(str(uuid4())),
            AssetId(str(uuid4())),
            artifact,
            document,
            EMPTY,
        )
        target = TargetProjection(
            base.command.target.batch_run_id,
            acceptance.work_version_id,
            TargetResult.PARTIALLY_ADVANCED,
            EMPTY,
            (FailureStage.PARSING,),
        )
        return Scenario(
            base.path,
            ContentAcceptancePublisher(base.path, failpoint=callback),
            ContentAcceptanceCommand(light, target),
            "light_documents",
        )

    def completion(self, callback=None) -> Scenario:
        base = self.light()
        base.invoke()
        assert isinstance(base.command, ContentAcceptanceCommand)
        light = base.command.acceptance
        assert isinstance(light, LightDocumentAcceptance)
        with create_or_open_catalog(base.path) as connection:
            row = connection.execute(
                "SELECT metadata_snapshot_id,revision,sha256 "
                "FROM work_version_current_metadata "
                "JOIN metadata_snapshots ON id=metadata_snapshot_id "
                "WHERE work_version_current_metadata.work_version_id=?",
                (str(light.work_version_id),),
            ).fetchone()
            connection.execute("UPDATE batch_targets SET result_json=NULL")
            connection.commit()
        assert row is not None
        analysis_artifact = self.artifact(ArtifactKind.ANALYSIS, b'{"nine":true}')
        analysis = CompletionAnalysisFact(
            light.work_version_id,
            light.document_id,
            light.artifact.sha256,
            AnalysisArtifactId(str(uuid4())),
            AssetId(str(uuid4())),
            analysis_artifact.path,
            analysis_artifact.sha256,
            analysis_artifact.size,
            CanonicalJsonObject((("nine", True),)),
        )
        final_values = CanonicalJsonObject((("title", "final"),))
        final_revision = row[1] + 1
        metadata = FinalMetadataFact(
            light.work_version_id,
            MetadataSnapshotId(row[0]),
            row[1],
            Sha256(row[2]),
            MetadataSnapshotId(str(uuid4())),
            final_revision,
            metadata_snapshot_sha256(final_revision, final_values, EMPTY),
            final_values,
            EMPTY,
        )
        references = ReferenceSetFact(ReferenceSetId(str(uuid4())), light.work_version_id, 1, ())
        tags = TagSetFact(TagSetId(str(uuid4())), light.work_version_id, 1, ())
        provenance = CompletionProvenance(
            "parser@1",
            "provider",
            "model@1",
            light.artifact.sha256,
            Sha256("4" * 64),
            EMPTY,
        )
        submission = CompletionSubmission(
            light.work_version_id,
            light.document_id,
            light.artifact.sha256,
            analysis,
            metadata,
            references,
            tags,
            provenance,
        )
        target = TargetProjection(
            base.command.target.batch_run_id,
            light.work_version_id,
            TargetResult.COMPLETED,
            EMPTY,
            (FailureStage.ANALYSIS, FailureStage.FEEDBACK),
        )
        return Scenario(
            base.path,
            CompletionPublisher(base.path, failpoint=callback),
            submission,
            "completion_bundles",
            target,
        )
