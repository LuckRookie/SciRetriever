from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from target_analysis_support import AuthoritySnapshot, authority_snapshot, proposal_value

from sciretriever.core.analysis import analysis_bytes, assemble_completion_submission
from sciretriever.core.execution import (
    build_target_result_envelope,
    target_projection_canonical,
)
from sciretriever.core.literature.completion import completion_submission_canonical
from sciretriever.infrastructure.storage.sqlite import (
    CompletionPublisher,
    create_or_open_catalog,
)
from sciretriever.kernel import CanonicalJsonObject, canonical_json_bytes
from sciretriever.model.analysis import AnalysisProposalV1, AnalysisTarget
from sciretriever.model.assets import ArtifactKind, PublishedArtifact, StagedArtifact
from sciretriever.model.documents import LightDocumentAcceptance
from sciretriever.model.execution import (
    ContentAcceptanceCommand,
    TargetProjection,
    TargetResult,
    ValidatedCompletionAcceptance,
)
from sciretriever.model.literature import CompletionSubmission
from sciretriever.model.primitives import (
    MetadataSnapshotId,
    RelativeArtifactPath,
    Sha256,
    WorkId,
    sha256_digest,
)
from sciretriever.services.analysis import AnalysisArtifactStorePort
from tests.target_publisher_support import ScenarioFactory


@dataclass(frozen=True, slots=True)
class PreparedCompletion:
    path: Path
    storage: Path
    context: AnalysisTarget
    target: TargetProjection
    proposal: AnalysisProposalV1
    publisher: CompletionPublisher


class FailingArtifactStore:
    def publish(self, artifact: StagedArtifact) -> PublishedArtifact:
        del artifact
        raise ArtifactPublicationFailure


class ArtifactPublicationFailure(RuntimeError):
    def __str__(self) -> str:
        return "artifact publication failed"


def prepare_completion(
    factory: ScenarioFactory,
    failpoint=None,
) -> PreparedCompletion:
    base = factory.light()
    base.invoke()
    assert isinstance(base.command, ContentAcceptanceCommand)
    light = base.command.acceptance
    assert isinstance(light, LightDocumentAcceptance)
    with create_or_open_catalog(base.path) as connection:
        metadata = connection.execute(
            "SELECT c.metadata_snapshot_id,s.revision,s.sha256,v.work_id FROM "
            "work_version_current_metadata c JOIN metadata_snapshots s "
            "ON s.id=c.metadata_snapshot_id JOIN work_versions v ON v.id=c.work_version_id "
            "WHERE c.work_version_id=?",
            (str(light.work_version_id),),
        ).fetchone()
    assert metadata is not None
    storage = Path(factory.root) / f"storage-{uuid4()}"
    context = AnalysisTarget(
        work_version_id=light.work_version_id,
        light_document_id=light.document_id,
        light_document_sha256=light.artifact.sha256,
        metadata_snapshot_id=MetadataSnapshotId(metadata[0]),
        metadata_revision=metadata[1],
        metadata_sha256=Sha256(metadata[2]),
        parser_identity="parser@1",
        model_provider="openai",
        model_identity="model@1",
        parameters_sha256=Sha256("8" * 64),
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
        details=CanonicalJsonObject(()),
        failure_stages_to_clear=("analysis", "feedback"),
    )
    value = proposal_value()
    value["keywords_and_tags"] = {
        "keywords": ["Alpha", "shared"],
        "tags": ["Beta", "shared"],
    }
    value["references"] = [
        _reference("00000000-0000-0000-0000-000000000301", "resolved", str(WorkId(metadata[3]))),
        _reference("00000000-0000-0000-0000-000000000302", "unresolved", None),
    ]
    proposal = AnalysisProposalV1.model_validate_json(json.dumps(value))
    return PreparedCompletion(
        base.path,
        storage,
        context,
        target,
        proposal,
        CompletionPublisher(base.path, failpoint=failpoint),
    )


def publish_completion_submission(
    proposal: AnalysisProposalV1,
    context: AnalysisTarget,
    target: TargetProjection,
    artifact_store: AnalysisArtifactStorePort,
) -> CompletionSubmission:
    content = analysis_bytes(proposal)
    published = artifact_store.publish(
        StagedArtifact(
            kind=ArtifactKind.ANALYSIS,
            path=RelativeArtifactPath("staged"),
            sha256=sha256_digest(content),
            content=content,
        )
    )
    return assemble_completion_submission(proposal, context, target, published)


def validated_completion(
    submission: CompletionSubmission, target: TargetProjection
) -> ValidatedCompletionAcceptance:
    result = CanonicalJsonObject(
        (
            ("submission", completion_submission_canonical(submission)),
            ("target", target_projection_canonical(target)),
        )
    )
    return ValidatedCompletionAcceptance(
        submission=submission,
        target_projection=target,
        target_result=build_target_result_envelope(target),
        identity_sha256=sha256_digest(canonical_json_bytes(result)),
    )


def _reference(identifier: str, raw_text: str, work_id: str | None):
    return {
        "reference_id": identifier,
        "raw_text": raw_text,
        "title": raw_text.title() if work_id is not None else None,
        "authors": [],
        "publication_year": 2020 if work_id is not None else None,
        "source": None,
        "identifiers": [],
        "resolved_work_id": work_id,
        "resolved_work_version_id": None,
        "evidence": [
            {
                "asset_id": "00000000-0000-0000-0000-000000000101",
                "page_start": 1,
                "page_end": 1,
                "block_id": "b1",
                "char_start": 0,
                "char_end": 5,
            }
        ],
    }


__all__ = (
    "AuthoritySnapshot",
    "ArtifactPublicationFailure",
    "FailingArtifactStore",
    "PreparedCompletion",
    "authority_snapshot",
    "prepare_completion",
    "publish_completion_submission",
    "validated_completion",
)
