from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import uuid4

from sciretriever.core.literature.completion import metadata_snapshot_sha256
from sciretriever.kernel import CanonicalJsonObject, canonical_json_bytes
from sciretriever.literature_store.sqlite import (
    CompletionPublisher,
    ContentAcceptancePublisher,
    create_or_open_catalog,
)
from sciretriever.model.assets import ArtifactKind, PrimaryPdfAcceptance
from sciretriever.model.collection import CollectionAcceptance
from sciretriever.model.documents import LightDocumentAcceptance
from sciretriever.model.execution import ContentAcceptanceCommand, TargetProjection, TargetResult
from sciretriever.model.literature import (
    CompletionAnalysisFact,
    CompletionProvenance,
    CompletionSubmission,
    FinalMetadataFact,
    ReferenceSetFact,
    TagSetFact,
)
from sciretriever.model.primitives import (
    AnalysisArtifactId,
    AssetId,
    BatchRunId,
    LightDocumentId,
    MetadataSnapshotId,
    ReferenceSetId,
    Sha256,
    TagSetId,
    WorkVersionAssetId,
)

if TYPE_CHECKING:
    from tests.target_publisher_support import Scenario, ScenarioFactory


def build_primary(factory: ScenarioFactory, callback=None) -> Scenario:
    from tests.target_publisher_support import EMPTY, Scenario

    base = factory.collection()
    base.invoke()
    assert isinstance(base.command, CollectionAcceptance)
    prepared = base.command.bibliography
    snapshot = prepared.metadata_snapshot
    assert snapshot is not None
    batch_id = BatchRunId(str(uuid4()))
    factory.batch(base.path, batch_id, prepared.work_version_id)
    artifact = factory.artifact(ArtifactKind.PRIMARY_PDF, b"%PDF-primary")
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


def build_light(factory: ScenarioFactory, callback=None) -> Scenario:
    from tests.target_publisher_support import EMPTY, Scenario

    base = factory.primary()
    base.invoke()
    assert isinstance(base.command, ContentAcceptanceCommand)
    acceptance = base.command.acceptance
    assert isinstance(acceptance, PrimaryPdfAcceptance)
    with create_or_open_catalog(base.path) as connection:
        connection.execute("UPDATE batch_targets SET result_json=NULL")
        connection.commit()
    document = CanonicalJsonObject((("blocks", (CanonicalJsonObject((("text", "atomic"),)),)),))
    artifact = factory.artifact(ArtifactKind.LIGHT_DOCUMENT, b'{"blocks":[{"text":"atomic"}]}')
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


def build_completion(factory: ScenarioFactory, callback=None) -> Scenario:
    from tests.target_publisher_support import EMPTY, Scenario

    base = factory.light()
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
    analysis_artifact = factory.artifact(ArtifactKind.ANALYSIS, canonical_json_bytes(proposal))
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
