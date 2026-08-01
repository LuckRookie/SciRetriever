from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, TypeVar, assert_never

from sciretriever.kernel import WorkId, WorkVersionId, WorkVersionState, canonical_json_bytes

from .model import WorkFacts
from .publisher_contracts import CompletionSubmission
from .state import VersionFacts, derive_work_version_state


class CompletionFactsRepository(Protocol):
    def get_work_facts(self, work_id: WorkId) -> WorkFacts | None: ...
    def get_version_facts(self, version_id: WorkVersionId) -> VersionFacts | None: ...


ProjectionT = TypeVar("ProjectionT", contravariant=True)
ResultT = TypeVar("ResultT", covariant=True)


class CompletionPublisher(Protocol[ProjectionT, ResultT]):
    def publish_completion(
        self, validated_submission: CompletionSubmission, target_projection: ProjectionT
    ) -> ResultT: ...


@dataclass(frozen=True, slots=True)
class CompletionRejectedError(Exception):
    reason: str

    def __str__(self) -> str:
        return self.reason


def _reject_unless(condition: bool, reason: str) -> None:
    if not condition:
        raise CompletionRejectedError(reason)


def accept_completion(
    repository: CompletionFactsRepository,
    publisher: CompletionPublisher[ProjectionT, ResultT],
    submission: CompletionSubmission,
    target_projection: ProjectionT,
) -> ResultT:
    for member in submission.references.members:
        if member.target_work_id is None:
            continue
        work = repository.get_work_facts(member.target_work_id)
        _reject_unless(work is not None, "resolved reference work does not exist")
        if member.target_work_version_id is None:
            continue
        version = repository.get_version_facts(member.target_work_version_id)
        _reject_unless(
            version is not None and version.work_id == member.target_work_id,
            "resolved reference version does not belong to work",
        )
    facts = repository.get_version_facts(submission.work_version_id)
    _reject_unless(facts is not None, "work version does not exist")
    assert facts is not None
    match derive_work_version_state(facts):
        case WorkVersionState.LIGHT_TEXT_READY:
            pass
        case WorkVersionState.COMPLETED:
            return publisher.publish_completion(submission, target_projection)
        case WorkVersionState.UNREVIEWED | WorkVersionState.ASSET_READY:
            raise CompletionRejectedError("work version is not ready for completion")
        case unreachable:
            assert_never(unreachable)
    _reject_unless(
        facts.current_light_document_id == submission.light_document_id
        and facts.current_light_sha256 == submission.light_document_sha256,
        "completion input is stale",
    )
    _reject_unless(
        submission.analysis.light_document_id == submission.light_document_id
        and submission.analysis.input_sha256 == submission.light_document_sha256,
        "analysis artifact is incomplete or misaligned",
    )
    _reject_unless(
        facts.metadata_snapshot_id == submission.metadata.expected_snapshot_id
        and facts.metadata_revision == submission.metadata.expected_revision
        and facts.metadata_sha256 == submission.metadata.expected_sha256,
        "metadata revision is stale",
    )
    _reject_unless(
        submission.metadata.revision == submission.metadata.expected_revision + 1,
        "final metadata revision must advance exactly once",
    )
    _reject_unless(
        submission.provenance.input_sha256 == submission.light_document_sha256
        and bool(submission.provenance.parser_identity.strip())
        and bool(submission.provenance.model_provider.strip())
        and bool(submission.provenance.model_identity.strip()),
        "completion provenance is incomplete or misaligned",
    )
    proposal = dict(submission.analysis.proposal.entries)
    _reject_unless(
        set(proposal)
        == {
            "schema_version",
            "final_bibliography",
            "classification",
            "content_overview",
            "research_objectives",
            "methods",
            "key_results",
            "conclusions_and_limitations",
            "keywords_and_tags",
            "references",
        }
        and proposal["schema_version"] == "1"
        and submission.analysis.artifact_sha256
        == submission.analysis.artifact_sha256.from_bytes(
            canonical_json_bytes(submission.analysis.proposal)
        ),
        "analysis artifact must contain the canonical nine-category proposal",
    )
    return publisher.publish_completion(submission, target_projection)


__all__ = (
    "CompletionFactsRepository",
    "CompletionPublisher",
    "CompletionRejectedError",
    "accept_completion",
)
