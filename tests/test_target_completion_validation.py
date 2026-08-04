# noqa: E501  # noqa: SIZE_OK
# Completion validation scenarios share one publication fixture.
from __future__ import annotations

import unittest
from dataclasses import replace as dataclass_replace
from uuid import uuid4

from pydantic import BaseModel

from sciretriever.core.literature.acceptance import (
    CompletionRejectedError,
    validate_completion_submission_contract,
)
from sciretriever.core.literature.completion import metadata_snapshot_sha256
from sciretriever.infrastructure.storage.files import CoreArtifactStore
from sciretriever.infrastructure.storage.sqlite import (
    SqliteLiteratureRepository,
    StalePublicationError,
)
from sciretriever.model.canonical_json import CanonicalJsonObject
from sciretriever.model.literature import CompletionSubmission, ReferenceMemberFact
from sciretriever.model.primitives import (
    ReferenceMemberId,
    WorkId,
    WorkVersionId,
    sha256_digest,
)
from sciretriever.services.literature.api import accept_completion
from tests.target_completion_support import (
    prepare_completion,
    publish_completion_submission,
    validated_completion,
)
from tests.target_publisher_support import ScenarioFactory


def replace(value, **updates):
    if isinstance(value, BaseModel):
        return value.model_copy(update=updates)
    return dataclass_replace(value, **updates)


class TargetCompletionValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.factory = ScenarioFactory()
        self.addCleanup(self.factory.cleanup)

    def _prepared(self):
        return prepare_completion(self.factory)

    def test_reference_member_rejects_resolved_version_without_work(self) -> None:
        prepared = self._prepared()
        valid = publish_completion_submission(
            prepared.proposal,
            prepared.context,
            prepared.target,
            CoreArtifactStore(prepared.storage),
        )
        invalid = valid.model_copy(
            update={
                "references": valid.references.model_copy(
                    update={
                        "members": (
                            ReferenceMemberFact(
                                member_id=ReferenceMemberId("00000000-0000-0000-0000-000000000301"),
                                raw_text="invalid",
                                reference=CanonicalJsonObject(()),
                                target_work_id=None,
                                target_work_version_id=WorkVersionId(
                                    "00000000-0000-0000-0000-000000000302"
                                ),
                            ),
                        )
                    }
                )
            }
        )
        with self.assertRaisesRegex(CompletionRejectedError, "requires target work"):
            validate_completion_submission_contract(invalid)

    def test_reference_member_identity_is_scoped_to_completion_set(self) -> None:
        prepared = self._prepared()
        first = publish_completion_submission(
            prepared.proposal,
            prepared.context,
            prepared.target,
            CoreArtifactStore(prepared.storage),
        )
        other_context = replace(
            prepared.context,
            work_version_id=WorkVersionId(str(uuid4())),
            light_document_id=type(prepared.context.light_document_id)(str(uuid4())),
        )
        other_target = replace(
            prepared.target,
            work_version_id=other_context.work_version_id,
            result=replace(
                prepared.target.result,
                subject_id=str(other_context.work_version_id),
            ),
        )
        second = publish_completion_submission(
            prepared.proposal,
            other_context,
            other_target,
            CoreArtifactStore(prepared.storage),
        )
        self.assertNotEqual(first.references.set_id, second.references.set_id)
        self.assertNotEqual(
            first.references.members[0].member_id,
            second.references.members[0].member_id,
        )

    def test_domain_gate_rejects_resolved_version_owned_by_other_work(self) -> None:
        prepared = self._prepared()
        submission = publish_completion_submission(
            prepared.proposal,
            prepared.context,
            prepared.target,
            CoreArtifactStore(prepared.storage),
        )
        foreign = self.factory.prepared(prepared.path, "foreign")
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
                        SqliteLiteratureRepository(prepared.path),
                        prepared.publisher,
                        invalid,
                        prepared.target,
                    )

    def test_completed_replay_rejects_every_divergent_submission_fact(self) -> None:
        prepared = self._prepared()
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
                        SqliteLiteratureRepository(prepared.path),
                        prepared.publisher,
                        divergent,
                        prepared.target,
                    )

    def test_completed_replay_rejects_divergent_target_projection(self) -> None:
        prepared = self._prepared()
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
        divergent = replace(
            prepared.target,
            details=CanonicalJsonObject((("changed", True),)),
        )
        with self.assertRaises(StalePublicationError):
            prepared.publisher.publish_completion(validated_completion(submission, divergent))

    def test_transaction_rechecks_resolved_reference_topology(self) -> None:
        prepared = self._prepared()
        submission = publish_completion_submission(
            prepared.proposal,
            prepared.context,
            prepared.target,
            CoreArtifactStore(prepared.storage),
        )
        foreign = self.factory.prepared(prepared.path, "transaction-foreign")
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
                    prepared.publisher.publish_completion(
                        validated_completion(invalid, prepared.target)
                    )


if __name__ == "__main__":
    unittest.main()
