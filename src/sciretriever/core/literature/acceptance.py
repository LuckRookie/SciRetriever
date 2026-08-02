from __future__ import annotations

from dataclasses import dataclass

from sciretriever.core.literature.completion import (
    completion_analysis_sha256,
    metadata_snapshot_sha256,
)
from sciretriever.core.literature.state import derive_work_version_state
from sciretriever.model.canonical_json import canonical_json_bytes
from sciretriever.model.literature import CompletionSubmission, VersionFacts
from sciretriever.model.primitives import WorkVersionState


@dataclass(slots=True)
class CompletionRejectedError(Exception):
    reason: str

    def __str__(self) -> str:
        return self.reason


def validate_completion_submission(
    facts: VersionFacts,
    submission: CompletionSubmission,
) -> None:
    state = derive_work_version_state(facts)
    if state is WorkVersionState.COMPLETED:
        return
    if state is not WorkVersionState.LIGHT_TEXT_READY:
        raise CompletionRejectedError("work version is not ready for completion")
    validate_completion_submission_contract(submission)
    _validate_light_input(facts, submission)
    _validate_metadata_revision(facts, submission)


def validate_completion_submission_contract(submission: CompletionSubmission) -> None:
    _validate_submission_identity(submission)
    _validate_analysis(submission)
    _validate_artifact_hashes(submission)
    _validate_provenance(submission)
    _validate_proposal(submission)


def _validate_submission_identity(submission: CompletionSubmission) -> None:
    identities = (
        submission.analysis.work_version_id,
        submission.metadata.work_version_id,
        submission.references.work_version_id,
        submission.tags.work_version_id,
    )
    if any(value != submission.work_version_id for value in identities):
        raise CompletionRejectedError("completion facts must share one WorkVersion")
    for member in submission.references.members:
        if member.target_work_version_id is not None and member.target_work_id is None:
            raise CompletionRejectedError("resolved reference version requires target work")


def _validate_light_input(facts: VersionFacts, submission: CompletionSubmission) -> None:
    if (
        facts.current_light_document_id != submission.light_document_id
        or facts.current_light_sha256 != submission.light_document_sha256
    ):
        raise CompletionRejectedError("completion input is stale")


def _validate_analysis(submission: CompletionSubmission) -> None:
    if (
        submission.analysis.light_document_id != submission.light_document_id
        or submission.analysis.input_sha256 != submission.light_document_sha256
        or submission.provenance.input_sha256 != submission.light_document_sha256
    ):
        raise CompletionRejectedError("analysis artifact is incomplete or misaligned")


def _validate_metadata_revision(facts: VersionFacts, submission: CompletionSubmission) -> None:
    if (
        facts.metadata_snapshot_id != submission.metadata.expected_snapshot_id
        or facts.metadata_revision != submission.metadata.expected_revision
        or facts.metadata_sha256 != submission.metadata.expected_sha256
    ):
        raise CompletionRejectedError("metadata revision is stale")
    if submission.metadata.revision != submission.metadata.expected_revision + 1:
        raise CompletionRejectedError("final metadata revision must advance exactly once")


def _validate_provenance(submission: CompletionSubmission) -> None:
    if (
        not submission.provenance.parser_identity.strip()
        or not submission.provenance.model_provider.strip()
        or not submission.provenance.model_identity.strip()
    ):
        raise CompletionRejectedError("completion provenance is incomplete or misaligned")


def _validate_proposal(submission: CompletionSubmission) -> None:
    proposal = dict(submission.analysis.proposal.entries)
    required = {
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
    if set(proposal) != required or proposal.get("schema_version") != "1":
        raise CompletionRejectedError(
            "analysis artifact must contain the canonical nine-category proposal"
        )


def _validate_artifact_hashes(submission: CompletionSubmission) -> None:
    if completion_analysis_sha256(
        submission.analysis
    ) != submission.analysis.artifact_sha256 or submission.analysis.artifact_size != len(
        canonical_json_bytes(submission.analysis.proposal)
    ):
        raise CompletionRejectedError("analysis artifact identity is inconsistent")
    if (
        metadata_snapshot_sha256(
            submission.metadata.revision,
            submission.metadata.values,
            submission.metadata.provenance,
        )
        != submission.metadata.sha256
    ):
        raise CompletionRejectedError("final metadata hash is inconsistent")


__all__ = (
    "CompletionRejectedError",
    "validate_completion_submission",
    "validate_completion_submission_contract",
)
