from __future__ import annotations

from typing import TypeVar

from sciretriever.core.literature.acceptance import (
    CompletionRejectedError,
    validate_completion_submission,
)
from sciretriever.model.literature import CompletionSubmission
from sciretriever.services.literature.ports import CompletionFactsRepository, CompletionPublisher

from .identity import LiteratureService, prepare_initial_ingest

ProjectionT = TypeVar("ProjectionT")
ResultT = TypeVar("ResultT")


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
    return publisher.publish_completion(submission, target_projection)


__all__ = (
    "LiteratureService",
    "accept_completion",
    "prepare_initial_ingest",
)
