from __future__ import annotations

import unittest
from dataclasses import replace as dataclass_replace
from uuid import uuid4

from pydantic import BaseModel
from target_completion_support import (
    FailingArtifactStore,
    authority_snapshot,
    prepare_completion,
    publish_completion_submission,
)

from sciretriever.core.analysis import analysis_bytes
from sciretriever.core.execution import build_target_result_envelope
from sciretriever.core.literature.acceptance import (
    CompletionRejectedError,
)
from sciretriever.infrastructure.storage import target_result_envelope_json
from sciretriever.infrastructure.storage.files import CoreArtifactStore
from sciretriever.infrastructure.storage.sqlite import (
    SqliteLiteratureRepository,
    create_or_open_catalog,
    open_read_only_snapshot,
)
from sciretriever.model.literature import CompletionOutcome
from sciretriever.services.literature.api import CompletionAcceptanceService, accept_completion
from tests.target_publisher_support import ScenarioFactory


def replace(value, **updates):
    if isinstance(value, BaseModel):
        return value.model_copy(update=updates)
    return dataclass_replace(value, **updates)


class TargetCompletionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.factory = ScenarioFactory()
        self.addCleanup(self.factory.cleanup)

    def _prepared(self, *, failpoint=None):
        prepared = prepare_completion(self.factory, failpoint)
        return (
            prepared.path,
            prepared.storage,
            prepared.context,
            prepared.target,
            prepared.proposal,
            prepared.publisher,
        )

    def test_complete_analysis_publishes_full_authority_and_exact_replay_is_write_free(
        self,
    ) -> None:
        path, storage, context, target, proposal, publisher = self._prepared()
        with create_or_open_catalog(path) as connection:
            for stage in ("analysis", "feedback", "parsing"):
                connection.execute(
                    "INSERT INTO current_failures VALUES (?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP)",
                    (
                        str(uuid4()),
                        "work-version",
                        str(context.work_version_id),
                        stage,
                        "x",
                        "x",
                        "x",
                    ),
                )
            connection.commit()
        submission = publish_completion_submission(
            proposal, context, target, CoreArtifactStore(storage)
        )
        acceptance_service = CompletionAcceptanceService(
            SqliteLiteratureRepository(path), publisher
        )
        outcome = acceptance_service.accept_completion(submission, target)
        replay = acceptance_service.accept_completion(submission, target)

        with create_or_open_catalog(path) as connection:
            connection.execute(
                "UPDATE batch_runs SET status='failed' WHERE id=?", (str(target.batch_run_id),)
            )
            connection.commit()
        terminal_replay = acceptance_service.accept_completion(submission, target)

        self.assertEqual(
            (outcome, replay, terminal_replay),
            (CompletionOutcome.PUBLISHED, CompletionOutcome.REPLAYED, CompletionOutcome.REPLAYED),
        )
        with open_read_only_snapshot(path) as reader:
            counts = tuple(
                reader.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                for table in (
                    "completion_bundles",
                    "analysis_artifacts",
                    "reference_members",
                    "unresolved_references",
                    "tag_members",
                    "metadata_fts",
                    "light_text_fts",
                    "analysis_fts",
                )
            )
            state = reader.execute(
                "SELECT state FROM work_version_state_view WHERE work_version_id=?",
                (str(context.work_version_id),),
            ).fetchone()
            failures = reader.execute(
                "SELECT stage FROM current_failures ORDER BY stage"
            ).fetchall()
            result_json = reader.execute(
                "SELECT result_json FROM batch_targets WHERE batch_run_id=? AND target_id=?",
                (str(target.batch_run_id), str(context.work_version_id)),
            ).fetchone()[0]
        self.assertEqual(counts, (1, 1, 1, 1, 3, 1, 1, 1))
        self.assertEqual(state, ("completed",))
        self.assertEqual(failures, [("parsing",)])
        self.assertEqual(
            result_json, target_result_envelope_json(build_target_result_envelope(target))
        )

    def test_artifact_is_durable_before_stale_acceptance_and_is_reused(self) -> None:
        path, storage, context, target, proposal, publisher = self._prepared()
        submission = publish_completion_submission(
            proposal, context, target, CoreArtifactStore(storage)
        )
        stale = replace(
            submission,
            metadata=replace(submission.metadata, expected_revision=context.metadata_revision + 1),
        )
        with self.assertRaises(CompletionRejectedError):
            accept_completion(SqliteLiteratureRepository(path), publisher, stale, target)
        artifact = storage / "core" / str(submission.analysis.artifact_path)
        self.assertEqual(artifact.read_bytes(), analysis_bytes(proposal))
        replay_submission = publish_completion_submission(
            proposal, context, target, CoreArtifactStore(storage)
        )
        self.assertEqual(replay_submission.analysis.artifact_id, submission.analysis.artifact_id)
        with open_read_only_snapshot(path) as reader:
            self.assertEqual(
                reader.execute("SELECT count(*) FROM analysis_artifacts").fetchone(), (0,)
            )

    def test_artifact_store_failure_writes_no_sql_authority(self) -> None:
        path, _storage, context, target, proposal, _publisher = self._prepared()
        before = authority_snapshot(path, str(context.work_version_id), str(target.batch_run_id))

        with self.assertRaisesRegex(RuntimeError, "artifact publication failed"):
            publish_completion_submission(proposal, context, target, FailingArtifactStore())

        self.assertEqual(
            authority_snapshot(path, str(context.work_version_id), str(target.batch_run_id)),
            before,
        )


if __name__ == "__main__":
    unittest.main()
