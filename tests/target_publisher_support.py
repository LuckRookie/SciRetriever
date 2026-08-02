from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Protocol
from uuid import uuid4

from sciretriever.core.literature.completion import metadata_snapshot_sha256
from sciretriever.kernel import CanonicalJsonObject, canonical_json_bytes
from sciretriever.literature_store.sqlite import (
    CollectionAcceptancePublisher,
    CompletionPublisher,
    ContentAcceptancePublisher,
    ImportAcceptancePublisher,
    SqliteLiteratureRepository,
    create_or_open_catalog,
)
from sciretriever.model.assets import ArtifactKind, PrimaryPdfAcceptance, PublishedArtifact
from sciretriever.model.collection import CollectionAcceptance, CollectionMembershipFact
from sciretriever.model.documents import LightDocumentAcceptance
from sciretriever.model.execution import (
    ContentAcceptanceCommand,
    ImportAcceptanceCommand,
    ImportRecordProjection,
    ImportResult,
    TargetProjection,
    TargetResult,
)
from sciretriever.model.literature import (
    BibliographicObservation,
    CompletionAnalysisFact,
    CompletionProvenance,
    CompletionSubmission,
    FinalMetadataFact,
    Identifier,
    InitialMetadata,
    ReferenceSetFact,
    TagSetFact,
)
from sciretriever.model.primitives import (
    AnalysisArtifactId,
    AssetId,
    BatchRunId,
    CollectionId,
    CollectionRunId,
    LightDocumentId,
    MembershipId,
    MetadataSnapshotId,
    ReferenceSetId,
    RelativeArtifactPath,
    Sha256,
    TagSetId,
    UtcTimestamp,
    WorkVersionAssetId,
    sha256_digest,
)
from sciretriever.services.literature.api import prepare_initial_ingest

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
            provider="crossref",
            provider_record_id=f"record-{suffix}",
            source_priority=0,
            observed_at=UtcTimestamp("2026-07-31T00:00:00Z"),
            identifiers=(Identifier(namespace="doi", value=f"10.1000/publisher-{suffix}"),),
            metadata=InitialMetadata(
                title=f"Atomic publication {suffix}",
                authors=("Ada",),
                year=2026,
                item_type="article",
            ),
            version_role="formal",
        )
        return prepare_initial_ingest(SqliteLiteratureRepository(path), (observation,))

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
        return PublishedArtifact(kind=kind, path=path, sha256=digest, size=len(content))

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
            bibliography=prepared,
            membership=CollectionMembershipFact(
                membership_id=MembershipId(str(uuid4())),
                collection_id=collection_id,
                work_id=prepared.work_id,
                first_run_id=run_id,
            ),
            causes=(),
            paths=(),
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
        references = ReferenceSetFact(
            set_id=ReferenceSetId(str(uuid4())),
            work_version_id=prepared.work_version_id,
            revision=1,
            members=(),
        )
        tags = TagSetFact(
            set_id=TagSetId(str(uuid4())),
            work_version_id=prepared.work_version_id,
            revision=1,
            members=(),
        )
        record = ImportRecordProjection(
            batch_run_id=batch_id,
            work_version_id=prepared.work_version_id,
            input_ordinal=0,
            result=ImportResult(
                record_index=0,
                work_id=str(prepared.work_id),
                work_version_id=prepared.work_version_id,
                outcome="created",
                omissions=(),
                failure=None,
            ),
            details=CanonicalJsonObject((("reason", "accepted"),)),
        )
        return Scenario(
            path,
            ImportAcceptancePublisher(path, failpoint=callback),
            ImportAcceptanceCommand(
                bibliography=prepared,
                references=references,
                tags=tags,
                record=record,
            ),
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
            work_version_id=prepared.work_version_id,
            expected_metadata_id=snapshot.snapshot_id,
            expected_metadata_revision=snapshot.revision,
            expected_metadata_sha256=snapshot.sha256,
            artifact_id=AssetId(str(uuid4())),
            relation_id=WorkVersionAssetId(str(uuid4())),
            artifact=artifact,
            source=EMPTY,
        )
        target = TargetProjection(
            batch_run_id=batch_id,
            work_version_id=prepared.work_version_id,
            result=TargetResult(
                subject_type="work-version",
                subject_id=str(prepared.work_version_id),
                outcome="partially-advanced",
                initial_state="unreviewed",
                target_state="asset-ready",
                final_state="asset-ready",
                stage="acquisition",
                failure=None,
            ),
            details=EMPTY,
            failure_stages_to_clear=("acquisition",),
        )
        return Scenario(
            base.path,
            ContentAcceptancePublisher(base.path, failpoint=callback),
            ContentAcceptanceCommand(acceptance=acceptance, target=target),
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
            work_version_id=acceptance.work_version_id,
            expected_primary_relation_id=acceptance.relation_id,
            expected_primary_sha256=acceptance.artifact.sha256,
            document_id=LightDocumentId(str(uuid4())),
            artifact_id=AssetId(str(uuid4())),
            artifact=artifact,
            document=document,
            provenance=EMPTY,
        )
        target = TargetProjection(
            batch_run_id=base.command.target.batch_run_id,
            work_version_id=acceptance.work_version_id,
            result=TargetResult(
                subject_type="work-version",
                subject_id=str(acceptance.work_version_id),
                outcome="partially-advanced",
                initial_state="asset-ready",
                target_state="light-text-ready",
                final_state="light-text-ready",
                stage="parsing",
                failure=None,
            ),
            details=EMPTY,
            failure_stages_to_clear=("parsing",),
        )
        return Scenario(
            base.path,
            ContentAcceptancePublisher(base.path, failpoint=callback),
            ContentAcceptanceCommand(acceptance=light, target=target),
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
        proposal = CanonicalJsonObject(
            (
                ("schema_version", "1"),
                ("final_bibliography", EMPTY),
                ("classification", EMPTY),
                ("content_overview", EMPTY),
                ("research_objectives", ()),
                ("methods", ()),
                ("key_results", ()),
                ("conclusions_and_limitations", EMPTY),
                ("keywords_and_tags", EMPTY),
                ("references", ()),
            )
        )
        analysis_artifact = self.artifact(ArtifactKind.ANALYSIS, canonical_json_bytes(proposal))
        analysis = CompletionAnalysisFact(
            work_version_id=light.work_version_id,
            light_document_id=light.document_id,
            input_sha256=light.artifact.sha256,
            analysis_id=AnalysisArtifactId(str(uuid4())),
            artifact_id=AssetId(str(uuid4())),
            artifact_path=analysis_artifact.path,
            artifact_sha256=analysis_artifact.sha256,
            artifact_size=analysis_artifact.size,
            proposal=proposal,
        )
        final_values = CanonicalJsonObject((("title", "final"),))
        final_revision = row[1] + 1
        metadata = FinalMetadataFact(
            work_version_id=light.work_version_id,
            expected_snapshot_id=MetadataSnapshotId(row[0]),
            expected_revision=row[1],
            expected_sha256=Sha256(row[2]),
            snapshot_id=MetadataSnapshotId(str(uuid4())),
            revision=final_revision,
            sha256=metadata_snapshot_sha256(final_revision, final_values, EMPTY),
            values=final_values,
            provenance=EMPTY,
        )
        references = ReferenceSetFact(
            set_id=ReferenceSetId(str(uuid4())),
            work_version_id=light.work_version_id,
            revision=1,
            members=(),
        )
        tags = TagSetFact(
            set_id=TagSetId(str(uuid4())),
            work_version_id=light.work_version_id,
            revision=1,
            members=(),
        )
        provenance = CompletionProvenance(
            parser_identity="parser@1",
            model_provider="provider",
            model_identity="model@1",
            input_sha256=light.artifact.sha256,
            parameters_sha256=Sha256("4" * 64),
            evidence=EMPTY,
        )
        submission = CompletionSubmission(
            work_version_id=light.work_version_id,
            light_document_id=light.document_id,
            light_document_sha256=light.artifact.sha256,
            analysis=analysis,
            metadata=metadata,
            references=references,
            tags=tags,
            provenance=provenance,
        )
        target = TargetProjection(
            batch_run_id=base.command.target.batch_run_id,
            work_version_id=light.work_version_id,
            result=TargetResult(
                subject_type="work-version",
                subject_id=str(light.work_version_id),
                outcome="completed",
                initial_state="light-text-ready",
                target_state="completed",
                final_state="completed",
                stage="completion",
                failure=None,
            ),
            details=EMPTY,
            failure_stages_to_clear=("analysis", "feedback"),
        )
        return Scenario(
            base.path,
            CompletionPublisher(base.path, failpoint=callback),
            submission,
            "completion_bundles",
            target,
        )
