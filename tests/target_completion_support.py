from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import unittest
from uuid import uuid4

from sciretriever.batching.api import (
    ContentAcceptanceCommand, FailureStage, TargetProjection, TargetResult,
)
from sciretriever.batching.completion import CompletionContext, complete_analysis
from sciretriever.bibliography.api import CompletionOutcome, accept_completion
from sciretriever.content.api import (
    AnalysisProposalV1, LightDocumentAcceptance, PublishedArtifact, StagedArtifact,
)
from sciretriever.kernel import CanonicalJsonObject, MetadataSnapshotId, Sha256, WorkId
from sciretriever.literature_store.sqlite import (
    CompletionPublisher, SqliteBibliographyRepository, create_or_open_catalog,
    open_read_only_snapshot,
)
from sciretriever.literature_store.filesystem import CoreArtifactStore
from target_analysis_support import proposal_value
from target_publisher_support import ScenarioFactory


@dataclass(frozen=True, slots=True)
class PreparedCompletion:
    path: Path
    storage: Path
    context: CompletionContext
    target: TargetProjection
    proposal: AnalysisProposalV1
    publisher: CompletionPublisher


@dataclass(frozen=True, slots=True)
class AuthoritySnapshot:
    artifacts: tuple[tuple[str, ...], ...]
    analyses: tuple[tuple[str, ...], ...]
    metadata: tuple[tuple[str, ...], ...]
    metadata_pointer: tuple[tuple[str, ...], ...]
    references: tuple[tuple[str, ...], ...]
    reference_members: tuple[tuple[str, ...], ...]
    unresolved_references: tuple[tuple[str, ...], ...]
    tags: tuple[tuple[str, ...], ...]
    tag_members: tuple[tuple[str, ...], ...]
    bundles: tuple[tuple[str, ...], ...]
    fts: tuple[tuple[str, ...], ...]
    failures: tuple[tuple[str, ...], ...]
    target: tuple[tuple[str, ...], ...]
    state: tuple[tuple[str, ...], ...]


class FailingArtifactStore:
    def publish(self, artifact: StagedArtifact) -> PublishedArtifact:
        del artifact
        raise RuntimeError("artifact publication failed")


class InjectedFailure(RuntimeError):
    pass


def prepare_completion(
    factory: ScenarioFactory, failpoint=None,
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
        connection.execute("UPDATE batch_targets SET result_json=NULL")
        connection.commit()
    assert metadata is not None
    storage = Path(factory.root) / f"storage-{uuid4()}"
    context = CompletionContext(
        light.work_version_id, light.document_id, light.artifact.sha256,
        MetadataSnapshotId(metadata[0]), metadata[1], Sha256(metadata[2]),
        "parser@1", "openai", "model@1", Sha256("8" * 64),
    )
    target = TargetProjection(
        base.command.target.batch_run_id, light.work_version_id,
        TargetResult.COMPLETED, CanonicalJsonObject(()),
        (FailureStage.ANALYSIS, FailureStage.FEEDBACK),
    )
    value = proposal_value()
    value["keywords_and_tags"] = {
        "keywords": ["Alpha", "shared"], "tags": ["Beta", "shared"],
    }
    value["references"] = [
        _reference("00000000-0000-0000-0000-000000000301", "resolved", str(WorkId(metadata[3]))),
        _reference("00000000-0000-0000-0000-000000000302", "unresolved", None),
    ]
    proposal = AnalysisProposalV1.model_validate_json(json.dumps(value))
    return PreparedCompletion(
        base.path, storage, context, target, proposal,
        CompletionPublisher(base.path, failpoint=failpoint),
    )


def _reference(identifier: str, raw_text: str, work_id: str | None):
    return {
        "reference_id": identifier, "raw_text": raw_text,
        "title": raw_text.title() if work_id is not None else None,
        "authors": [], "publication_year": 2020 if work_id is not None else None,
        "source": None, "identifiers": [], "resolved_work_id": work_id,
        "resolved_work_version_id": None,
        "evidence": [{
            "asset_id": "00000000-0000-0000-0000-000000000101",
            "page_start": 1, "page_end": 1, "block_id": "b1",
            "char_start": 0, "char_end": 5,
        }],
    }


def authority_snapshot(
    path: Path, work_version_id: str, batch_run_id: str,
) -> AuthoritySnapshot:
    with open_read_only_snapshot(path) as reader:
        rows = lambda sql, values=(): tuple(reader.execute(sql, values).fetchall())
        return AuthoritySnapshot(
            rows("SELECT id,kind,sha256,storage_path,byte_size FROM artifacts WHERE kind='analysis' ORDER BY id"),
            rows("SELECT id,artifact_id,sha256,input_sha256,proposal_json,provenance_json FROM analysis_artifacts ORDER BY id"),
            rows("SELECT id,revision,sha256,values_json,provenance_json FROM metadata_snapshots WHERE work_version_id=? ORDER BY revision", (work_version_id,)),
            rows("SELECT metadata_snapshot_id FROM work_version_current_metadata WHERE work_version_id=?", (work_version_id,)),
            rows("SELECT id,revision,complete FROM reference_sets WHERE work_version_id=? ORDER BY id", (work_version_id,)),
            rows("SELECT id,reference_set_id,ordinal,target_work_id,target_work_version_id,reference_json FROM reference_members ORDER BY id"),
            rows("SELECT id,reference_set_id,ordinal,raw_text,reference_json FROM unresolved_references ORDER BY id"),
            rows("SELECT id,revision,complete FROM tag_sets WHERE work_version_id=? ORDER BY id", (work_version_id,)),
            rows("SELECT id,tag_set_id,name,evidence_json FROM tag_members ORDER BY id"),
            rows("SELECT light_document_id,analysis_artifact_id,metadata_snapshot_id,reference_set_id,tag_set_id,identity_sha256 FROM completion_bundles WHERE work_version_id=?", (work_version_id,)),
            rows("SELECT 'metadata',content FROM metadata_fts WHERE work_version_id=? UNION ALL SELECT 'light',content FROM light_text_fts WHERE work_version_id=? UNION ALL SELECT 'analysis',content FROM analysis_fts WHERE work_version_id=? ORDER BY 1", (work_version_id, work_version_id, work_version_id)),
            rows("SELECT stage,code,reason,action,retryable FROM current_failures WHERE subject_id=? ORDER BY stage", (work_version_id,)),
            rows("SELECT started,result_json FROM batch_targets WHERE batch_run_id=? AND target_id=?", (batch_run_id, work_version_id)),
            rows("SELECT state FROM work_version_state_view WHERE work_version_id=?", (work_version_id,)),
        )


class CompletionDurabilityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.factory = ScenarioFactory()
        self.addCleanup(self.factory.cleanup)

    def test_completed_provider_observation_cannot_change_final_pointers_or_fts(self) -> None:
        prepared = prepare_completion(self.factory)
        submission = complete_analysis(
            prepared.proposal, prepared.context, prepared.target,
            CoreArtifactStore(prepared.storage),
        )
        accept_completion(
            SqliteBibliographyRepository(prepared.path), prepared.publisher,
            submission, prepared.target,
        )
        with create_or_open_catalog(prepared.path) as connection:
            before = connection.execute(
                "SELECT metadata_snapshot_id,reference_set_id,tag_set_id FROM completion_bundles WHERE work_version_id=?",
                (str(prepared.context.work_version_id),),
            ).fetchone()
            fts = connection.execute(
                "SELECT content FROM metadata_fts WHERE work_version_id=?",
                (str(prepared.context.work_version_id),),
            ).fetchone()
            connection.execute(
                "INSERT INTO metadata_observations VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)",
                (str(uuid4()), str(prepared.context.work_version_id), "later", "record", "9" * 64, '{}'),
            )
            connection.commit()
            after = connection.execute(
                "SELECT metadata_snapshot_id,reference_set_id,tag_set_id FROM completion_bundles WHERE work_version_id=?",
                (str(prepared.context.work_version_id),),
            ).fetchone()
            after_fts = connection.execute(
                "SELECT content FROM metadata_fts WHERE work_version_id=?",
                (str(prepared.context.work_version_id),),
            ).fetchone()
        self.assertEqual((after, after_fts), (before, fts))

    def test_every_completion_write_and_before_commit_is_complete_old_or_new(self) -> None:
        points: list[str] = []
        prepared = prepare_completion(self.factory, lambda point: points.append(point))
        submission = complete_analysis(
            prepared.proposal, prepared.context, prepared.target,
            CoreArtifactStore(prepared.storage),
        )
        accept_completion(
            SqliteBibliographyRepository(prepared.path), prepared.publisher,
            submission, prepared.target,
        )
        self.assertEqual(points[-1], "before-commit")
        for expected in points:
            def fail(point: str, expected: str = expected) -> None:
                if point == expected:
                    raise InjectedFailure(point)
            failed = prepare_completion(self.factory, fail)
            failed_submission = complete_analysis(
                failed.proposal, failed.context, failed.target,
                CoreArtifactStore(failed.storage),
            )
            old = authority_snapshot(
                failed.path, str(failed.context.work_version_id),
                str(failed.target.batch_run_id),
            )
            with self.assertRaises(InjectedFailure):
                accept_completion(
                    SqliteBibliographyRepository(failed.path), failed.publisher,
                    failed_submission, failed.target,
                )
            self.assertEqual(
                authority_snapshot(
                    failed.path, str(failed.context.work_version_id),
                    str(failed.target.batch_run_id),
                ),
                old,
            )
            outcome = accept_completion(
                SqliteBibliographyRepository(failed.path),
                CompletionPublisher(failed.path), failed_submission, failed.target,
            )
            self.assertEqual(outcome, CompletionOutcome.PUBLISHED)
            completed = authority_snapshot(
                failed.path, str(failed.context.work_version_id),
                str(failed.target.batch_run_id),
            )
            self.assertEqual(completed.state, (("completed",),))
            self.assertEqual(
                tuple(map(len, (
                    completed.bundles, completed.analyses, completed.references,
                    completed.tags,
                ))),
                (1, 1, 1, 1),
            )
            self.assertEqual(completed.target[0][0], 1)


__all__ = (
    "AuthoritySnapshot", "CompletionDurabilityTests", "FailingArtifactStore",
    "PreparedCompletion",
    "authority_snapshot", "prepare_completion",
)
