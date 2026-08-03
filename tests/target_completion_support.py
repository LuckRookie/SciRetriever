from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from target_analysis_support import proposal_value

from sciretriever.core.analysis import analysis_bytes, assemble_completion_submission
from sciretriever.kernel import CanonicalJsonObject
from sciretriever.literature_store.sqlite import (
    CompletionPublisher,
    create_or_open_catalog,
    open_read_only_snapshot,
)
from sciretriever.model.analysis import AnalysisProposalV1, AnalysisTarget
from sciretriever.model.assets import ArtifactKind, PublishedArtifact, StagedArtifact
from sciretriever.model.documents import LightDocumentAcceptance
from sciretriever.model.execution import ContentAcceptanceCommand, TargetProjection, TargetResult
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

SqlValue = str | int | float | bytes | None


@dataclass(frozen=True, slots=True)
class PreparedCompletion:
    path: Path
    storage: Path
    context: AnalysisTarget
    target: TargetProjection
    proposal: AnalysisProposalV1
    publisher: CompletionPublisher


@dataclass(frozen=True, slots=True)
class AuthoritySnapshot:
    artifacts: tuple[tuple[SqlValue, ...], ...]
    analyses: tuple[tuple[SqlValue, ...], ...]
    metadata: tuple[tuple[SqlValue, ...], ...]
    metadata_pointer: tuple[tuple[SqlValue, ...], ...]
    references: tuple[tuple[SqlValue, ...], ...]
    reference_members: tuple[tuple[SqlValue, ...], ...]
    unresolved_references: tuple[tuple[SqlValue, ...], ...]
    tags: tuple[tuple[SqlValue, ...], ...]
    tag_members: tuple[tuple[SqlValue, ...], ...]
    bundles: tuple[tuple[SqlValue, ...], ...]
    fts: tuple[tuple[SqlValue, ...], ...]
    failures: tuple[tuple[SqlValue, ...], ...]
    target: tuple[tuple[SqlValue, ...], ...]
    state: tuple[tuple[SqlValue, ...], ...]


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


def authority_snapshot(
    path: Path,
    work_version_id: str,
    batch_run_id: str,
) -> AuthoritySnapshot:
    with open_read_only_snapshot(path) as reader:

        def rows(
            sql: str,
            values: tuple[SqlValue, ...] = (),
        ) -> tuple[tuple[SqlValue, ...], ...]:
            return tuple(reader.execute(sql, values).fetchall())

        return AuthoritySnapshot(
            rows(
                "SELECT id,kind,sha256,storage_path,byte_size FROM artifacts "
                "WHERE kind='analysis' ORDER BY id"
            ),
            rows(
                "SELECT id,artifact_id,sha256,input_sha256,proposal_json,provenance_json "
                "FROM analysis_artifacts ORDER BY id"
            ),
            rows(
                "SELECT id,revision,sha256,values_json,provenance_json FROM metadata_snapshots "
                "WHERE work_version_id=? ORDER BY revision",
                (work_version_id,),
            ),
            rows(
                "SELECT metadata_snapshot_id FROM work_version_current_metadata "
                "WHERE work_version_id=?",
                (work_version_id,),
            ),
            rows(
                "SELECT id,revision,complete FROM reference_sets "
                "WHERE work_version_id=? ORDER BY id",
                (work_version_id,),
            ),
            rows(
                "SELECT id,reference_set_id,ordinal,target_work_id,target_work_version_id,"
                "reference_json FROM reference_members ORDER BY id"
            ),
            rows(
                "SELECT id,reference_set_id,ordinal,raw_text,reference_json "
                "FROM unresolved_references ORDER BY id"
            ),
            rows(
                "SELECT id,revision,complete FROM tag_sets WHERE work_version_id=? ORDER BY id",
                (work_version_id,),
            ),
            rows("SELECT id,tag_set_id,name,evidence_json FROM tag_members ORDER BY id"),
            rows(
                "SELECT light_document_id,analysis_artifact_id,metadata_snapshot_id,"
                "reference_set_id,tag_set_id,identity_sha256 FROM completion_bundles "
                "WHERE work_version_id=?",
                (work_version_id,),
            ),
            rows(
                "SELECT 'metadata',content FROM metadata_fts WHERE work_version_id=? "
                "UNION ALL SELECT 'light',content FROM light_text_fts WHERE work_version_id=? "
                "UNION ALL SELECT 'analysis',content FROM analysis_fts "
                "WHERE work_version_id=? ORDER BY 1",
                (work_version_id, work_version_id, work_version_id),
            ),
            rows(
                "SELECT stage,code,reason,action,retryable FROM current_failures "
                "WHERE subject_id=? ORDER BY stage",
                (work_version_id,),
            ),
            rows(
                "SELECT started,result_json FROM batch_targets "
                "WHERE batch_run_id=? AND target_id=?",
                (batch_run_id, work_version_id),
            ),
            rows(
                "SELECT state FROM work_version_state_view WHERE work_version_id=?",
                (work_version_id,),
            ),
        )


__all__ = (
    "AuthoritySnapshot",
    "ArtifactPublicationFailure",
    "FailingArtifactStore",
    "PreparedCompletion",
    "authority_snapshot",
    "prepare_completion",
    "publish_completion_submission",
)
