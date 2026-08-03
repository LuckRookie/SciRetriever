from __future__ import annotations

from typing import Generic, TypeVar

from sciretriever.core.execution import (
    ExecutionRejectedError,
    build_target_result_envelope,
    target_projection_canonical,
    validate_completion_target,
)
from sciretriever.core.literature.acceptance import (
    CompletionRejectedError,
    validate_completion_submission,
)
from sciretriever.core.literature.completion import completion_submission_canonical
from sciretriever.model.canonical_json import CanonicalJsonObject, canonical_json_bytes
from sciretriever.model.execution import TargetProjection, ValidatedCompletionAcceptance
from sciretriever.model.literature import CompletionSubmission
from sciretriever.model.primitives import sha256_digest
from sciretriever.services.literature.ports import CompletionFactsRepository, CompletionPublisher

from .identity import LiteratureService, prepare_initial_ingest

ResultT = TypeVar("ResultT")


class CompletionAcceptanceService(Generic[ResultT]):
    def __init__(
        self,
        repository: CompletionFactsRepository,
        publisher: CompletionPublisher[ResultT],
    ) -> None:
        self._repository = repository
        self._publisher = publisher

    def accept_completion(
        self,
        submission: CompletionSubmission,
        target_projection: TargetProjection,
    ) -> ResultT:
        return accept_completion(
            self._repository,
            self._publisher,
            submission,
            target_projection,
        )


def accept_completion(
    repository: CompletionFactsRepository,
    publisher: CompletionPublisher[ResultT],
    submission: CompletionSubmission,
    target_projection: TargetProjection,
) -> ResultT:
    try:
        validate_completion_target(target_projection, submission.work_version_id)
    except ExecutionRejectedError as error:
        raise CompletionRejectedError(error.reason) from error
    for member in submission.references.members:
        if member.target_work_id is None:
            continue
        work = repository.get_work_facts(member.target_work_id)
        if work is None:
            raise CompletionRejectedError("resolved reference work does not exist")
        if member.target_work_version_id is None:
            continue
        version = repository.get_version_facts(member.target_work_version_id)
        if version is None or version.work_id != member.target_work_id:
            raise CompletionRejectedError("resolved reference version does not belong to work")
    facts = repository.get_version_facts(submission.work_version_id)
    if facts is None:
        raise CompletionRejectedError("work version does not exist")
    validate_completion_submission(facts, submission)
    result = CanonicalJsonObject(
        (
            ("submission", completion_submission_canonical(submission)),
            ("target", target_projection_canonical(target_projection)),
        )
    )
    identity_sha256 = sha256_digest(canonical_json_bytes(result))
    return publisher.publish_completion(
        ValidatedCompletionAcceptance(
            submission=submission,
            target_projection=target_projection,
            target_result=build_target_result_envelope(target_projection),
            identity_sha256=identity_sha256,
        )
    )


__all__ = (
    "CompletionAcceptanceService",
    "LiteratureService",
    "accept_completion",
    "prepare_initial_ingest",
)
