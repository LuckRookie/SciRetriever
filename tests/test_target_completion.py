from __future__ import annotations

import unittest
from dataclasses import replace
from uuid import uuid4

from target_completion_support import (
    CompletionDurabilityTests,
    FailingArtifactStore,
    authority_snapshot,
    prepare_completion,
)
from target_publisher_support import ScenarioFactory

from sciretriever.batching.completion import complete_analysis
from sciretriever.bibliography.api import (
    CompletionOutcome,
    CompletionRejectedError,
    CompletionSubmission,
    ReferenceMemberFact,
    ReferenceMemberId,
    accept_completion,
    metadata_snapshot_sha256,
)
from sciretriever.kernel import (
    BoundaryError,
    CanonicalJsonObject,
)
from sciretriever.literature_store.filesystem import CoreArtifactStore
from sciretriever.literature_store.sqlite import (
    SqliteBibliographyRepository,
    StalePublicationError,
    create_or_open_catalog,
    open_read_only_snapshot,
)
from sciretriever.model.primitives import (
    WorkId,
    WorkVersionId,
    sha256_digest,
)


class TargetCompletionDurabilityTests(CompletionDurabilityTests):
    pass


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
        submission = complete_analysis(proposal, context, target, CoreArtifactStore(storage))
        outcome = accept_completion(
            SqliteBibliographyRepository(path), publisher, submission, target
        )
        replay = accept_completion(
            SqliteBibliographyRepository(path), publisher, submission, target
        )

        self.assertEqual(
            (outcome, replay), (CompletionOutcome.PUBLISHED, CompletionOutcome.REPLAYED)
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
        self.assertEqual(counts, (1, 1, 1, 1, 3, 1, 1, 1))
        self.assertEqual(state, ("completed",))
        self.assertEqual(failures, [("parsing",)])

    def test_artifact_is_durable_before_stale_acceptance_and_is_reused(self) -> None:
        path, storage, context, target, proposal, publisher = self._prepared()
        submission = complete_analysis(proposal, context, target, CoreArtifactStore(storage))
        stale = replace(
            submission,
            metadata=replace(submission.metadata, expected_revision=context.metadata_revision + 1),
        )
        with self.assertRaises(CompletionRejectedError):
            accept_completion(SqliteBibliographyRepository(path), publisher, stale, target)
        artifact = storage / "core" / str(submission.analysis.artifact_path)
        self.assertEqual(artifact.read_bytes(), proposal.canonical_bytes())
        replay_submission = complete_analysis(proposal, context, target, CoreArtifactStore(storage))
        self.assertEqual(replay_submission.analysis.artifact_id, submission.analysis.artifact_id)
        with open_read_only_snapshot(path) as reader:
            self.assertEqual(
                reader.execute("SELECT count(*) FROM analysis_artifacts").fetchone(), (0,)
            )

    def test_reference_member_rejects_resolved_version_without_work(self) -> None:
        with self.assertRaisesRegex(BoundaryError, "requires target_work_id"):
            ReferenceMemberFact(
                ReferenceMemberId("00000000-0000-0000-0000-000000000301"),
                "invalid",
                CanonicalJsonObject(()),
                None,
                WorkVersionId("00000000-0000-0000-0000-000000000302"),
            )

    def test_reference_member_identity_is_scoped_to_completion_set(self) -> None:
        _path, storage, context, target, proposal, _publisher = self._prepared()
        first = complete_analysis(proposal, context, target, CoreArtifactStore(storage))
        other_context = replace(
            context,
            work_version_id=WorkVersionId(str(uuid4())),
            light_document_id=type(context.light_document_id)(str(uuid4())),
        )
        other_target = replace(target, work_version_id=other_context.work_version_id)
        second = complete_analysis(
            proposal,
            other_context,
            other_target,
            CoreArtifactStore(storage),
        )

        self.assertNotEqual(first.references.set_id, second.references.set_id)
        self.assertNotEqual(
            first.references.members[0].member_id,
            second.references.members[0].member_id,
        )

    def test_domain_gate_rejects_resolved_version_owned_by_other_work(self) -> None:
        path, storage, context, target, proposal, publisher = self._prepared()
        submission = complete_analysis(proposal, context, target, CoreArtifactStore(storage))
        foreign = self.factory.prepared(path, "foreign")
        members = (
            replace(
                submission.references.members[0],
                target_work_version_id=foreign.work_version_id,
            ),
            replace(
                submission.references.members[0],
                target_work_id=WorkId(str(uuid4())),
                target_work_version_id=None,
            ),
            replace(
                submission.references.members[0],
                target_work_version_id=WorkVersionId(str(uuid4())),
            ),
        )
        for member in members:
            invalid = replace(
                submission,
                references=replace(submission.references, members=(member,)),
            )
            with self.subTest(member=member):
                with self.assertRaisesRegex(CompletionRejectedError, "resolved reference"):
                    accept_completion(
                        SqliteBibliographyRepository(path),
                        publisher,
                        invalid,
                        target,
                    )

    def test_completed_replay_rejects_every_divergent_submission_fact(self) -> None:
        path, storage, context, target, proposal, publisher = self._prepared()
        submission = complete_analysis(proposal, context, target, CoreArtifactStore(storage))
        accept_completion(SqliteBibliographyRepository(path), publisher, submission, target)
        divergent_values = CanonicalJsonObject((("title", "divergent"),))
        divergent_metadata = replace(
            submission.metadata,
            values=divergent_values,
            sha256=metadata_snapshot_sha256(
                submission.metadata.revision,
                divergent_values,
                submission.metadata.provenance,
            ),
        )
        variants: tuple[CompletionSubmission, ...] = (
            replace(submission, metadata=divergent_metadata),
            replace(
                submission,
                references=replace(
                    submission.references,
                    members=(replace(submission.references.members[0], raw_text="divergent"),),
                ),
            ),
            replace(
                submission,
                tags=replace(
                    submission.tags,
                    members=(replace(submission.tags.members[0], name="divergent"),),
                ),
            ),
            replace(
                submission,
                provenance=replace(
                    submission.provenance,
                    evidence=CanonicalJsonObject((("changed", True),)),
                ),
            ),
            replace(
                submission,
                analysis=replace(
                    submission.analysis,
                    proposal=divergent_values,
                    artifact_sha256=sha256_digest(b'{"title":"divergent"}'),
                    artifact_size=len(b'{"title":"divergent"}'),
                ),
            ),
        )
        for divergent in variants:
            with self.subTest(divergent=divergent):
                with self.assertRaises((CompletionRejectedError, StalePublicationError)):
                    accept_completion(
                        SqliteBibliographyRepository(path),
                        publisher,
                        divergent,
                        target,
                    )

    def test_completed_replay_rejects_divergent_target_projection(self) -> None:
        path, storage, context, target, proposal, publisher = self._prepared()
        submission = complete_analysis(proposal, context, target, CoreArtifactStore(storage))
        accept_completion(SqliteBibliographyRepository(path), publisher, submission, target)
        divergent = replace(
            target,
            details=CanonicalJsonObject((("changed", True),)),
        )

        with self.assertRaises(StalePublicationError):
            publisher.publish_completion(submission, divergent)

    def test_transaction_rechecks_resolved_reference_topology(self) -> None:
        path, storage, context, target, proposal, publisher = self._prepared()
        submission = complete_analysis(proposal, context, target, CoreArtifactStore(storage))
        foreign = self.factory.prepared(path, "transaction-foreign")
        members = (
            replace(
                submission.references.members[0],
                target_work_version_id=foreign.work_version_id,
            ),
            replace(
                submission.references.members[0],
                target_work_id=WorkId(str(uuid4())),
                target_work_version_id=None,
            ),
            replace(
                submission.references.members[0],
                target_work_version_id=WorkVersionId(str(uuid4())),
            ),
        )
        for member in members:
            invalid = replace(
                submission,
                references=replace(submission.references, members=(member,)),
            )
            with self.subTest(member=member):
                with self.assertRaisesRegex(StalePublicationError, "topology"):
                    publisher.publish_completion(invalid, target)

    def test_artifact_store_failure_writes_no_sql_authority(self) -> None:
        path, _storage, context, target, proposal, _publisher = self._prepared()
        before = authority_snapshot(path, str(context.work_version_id), str(target.batch_run_id))

        with self.assertRaisesRegex(RuntimeError, "artifact publication failed"):
            complete_analysis(proposal, context, target, FailingArtifactStore())

        self.assertEqual(
            authority_snapshot(path, str(context.work_version_id), str(target.batch_run_id)),
            before,
        )


if __name__ == "__main__":
    unittest.main()
