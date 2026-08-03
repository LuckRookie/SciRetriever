from __future__ import annotations

import unittest
from uuid import uuid4

from sciretriever.literature_store.filesystem import CoreArtifactStore
from sciretriever.literature_store.sqlite import (
    CompletionPublisher,
    SqliteLiteratureRepository,
    create_or_open_catalog,
)
from sciretriever.model.literature import CompletionOutcome
from sciretriever.services.literature.api import accept_completion
from tests.target_completion_support import (
    authority_snapshot,
    prepare_completion,
    publish_completion_submission,
)
from tests.target_publisher_support import ScenarioFactory


class InjectedFailure(RuntimeError):
    pass


class CompletionDurabilityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.factory = ScenarioFactory()
        self.addCleanup(self.factory.cleanup)

    def test_completed_provider_observation_cannot_change_final_pointers_or_fts(self) -> None:
        prepared = prepare_completion(self.factory)
        submission = publish_completion_submission(
            prepared.proposal,
            prepared.context,
            prepared.target,
            CoreArtifactStore(prepared.storage),
        )
        accept_completion(
            SqliteLiteratureRepository(prepared.path),
            prepared.publisher,
            submission,
            prepared.target,
        )
        with create_or_open_catalog(prepared.path) as connection:
            before = connection.execute(
                "SELECT metadata_snapshot_id,reference_set_id,tag_set_id "
                "FROM completion_bundles WHERE work_version_id=?",
                (str(prepared.context.work_version_id),),
            ).fetchone()
            fts = connection.execute(
                "SELECT content FROM metadata_fts WHERE work_version_id=?",
                (str(prepared.context.work_version_id),),
            ).fetchone()
            connection.execute(
                "INSERT INTO metadata_observations VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)",
                (
                    str(uuid4()),
                    str(prepared.context.work_version_id),
                    "later",
                    "record",
                    "9" * 64,
                    "{}",
                ),
            )
            connection.commit()
            after = connection.execute(
                "SELECT metadata_snapshot_id,reference_set_id,tag_set_id "
                "FROM completion_bundles WHERE work_version_id=?",
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
        submission = publish_completion_submission(
            prepared.proposal,
            prepared.context,
            prepared.target,
            CoreArtifactStore(prepared.storage),
        )
        accept_completion(
            SqliteLiteratureRepository(prepared.path),
            prepared.publisher,
            submission,
            prepared.target,
        )
        self.assertEqual(points[-1], "before-commit")
        for expected in points:

            def fail(point: str, expected: str = expected) -> None:
                if point == expected:
                    raise InjectedFailure(point)

            failed = prepare_completion(self.factory, fail)
            failed_submission = publish_completion_submission(
                failed.proposal,
                failed.context,
                failed.target,
                CoreArtifactStore(failed.storage),
            )
            old = authority_snapshot(
                failed.path,
                str(failed.context.work_version_id),
                str(failed.target.batch_run_id),
            )
            with self.assertRaises(InjectedFailure):
                accept_completion(
                    SqliteLiteratureRepository(failed.path),
                    failed.publisher,
                    failed_submission,
                    failed.target,
                )
            self.assertEqual(
                authority_snapshot(
                    failed.path,
                    str(failed.context.work_version_id),
                    str(failed.target.batch_run_id),
                ),
                old,
            )
            outcome = accept_completion(
                SqliteLiteratureRepository(failed.path),
                CompletionPublisher(failed.path),
                failed_submission,
                failed.target,
            )
            self.assertEqual(outcome, CompletionOutcome.PUBLISHED)
            completed = authority_snapshot(
                failed.path,
                str(failed.context.work_version_id),
                str(failed.target.batch_run_id),
            )
            self.assertEqual(completed.state, (("completed",),))
            self.assertEqual(
                tuple(
                    map(
                        len,
                        (
                            completed.bundles,
                            completed.analyses,
                            completed.references,
                            completed.tags,
                        ),
                    )
                ),
                (1, 1, 1, 1),
            )
            self.assertEqual(completed.target[0][0], 1)
