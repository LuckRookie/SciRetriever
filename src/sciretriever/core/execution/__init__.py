from __future__ import annotations

from dataclasses import dataclass

from sciretriever.model.canonical_json import CanonicalJsonObject, canonical_json_bytes
from sciretriever.model.execution import (
    ContentAcceptanceCommand,
    ImportAcceptanceCommand,
    ImportRecordProjection,
    TargetProjection,
)
from sciretriever.model.primitives import WorkVersionId


@dataclass(frozen=True, slots=True)
class ExecutionRejectedError(Exception):
    reason: str

    def __str__(self) -> str:
        return self.reason


def canonical_target_projection(target: TargetProjection) -> bytes:
    return canonical_json_bytes(target_projection_canonical(target))


def target_projection_canonical(target: TargetProjection) -> CanonicalJsonObject:
    _validate_result_discriminator(target.details)
    return CanonicalJsonObject(
        (
            ("batch_run_id", str(target.batch_run_id)),
            ("work_version_id", str(target.work_version_id)),
            ("result", target.result.outcome),
            ("details", target.details),
            (
                "failure_stages_to_clear",
                tuple(target.failure_stages_to_clear),
            ),
        )
    )


def canonical_import_record_projection(record: ImportRecordProjection) -> bytes:
    _validate_result_discriminator(record.details)
    return canonical_json_bytes(
        CanonicalJsonObject(
            (
                ("result", record.result.outcome),
                ("details", record.details),
            )
        )
    )


def validate_target_alignment(
    target: TargetProjection,
    expected_work_version_id: WorkVersionId,
) -> None:
    if target.work_version_id != expected_work_version_id:
        raise ExecutionRejectedError("target and owner must share one WorkVersion")
    if target.result.subject_id != str(target.work_version_id):
        raise ExecutionRejectedError("target result subject must match target WorkVersion")


def validate_import_acceptance_command(command: ImportAcceptanceCommand) -> None:
    expected = command.bibliography.work_version_id
    if any(
        value != expected
        for value in (
            command.references.work_version_id,
            command.tags.work_version_id,
            command.record.work_version_id,
        )
    ):
        raise ExecutionRejectedError("import facts and result must share one WorkVersion")
    if (
        command.record.result.work_version_id is not None
        and command.record.result.work_version_id != expected
    ):
        raise ExecutionRejectedError("import result must match accepted WorkVersion")


def validate_content_acceptance_command(command: ContentAcceptanceCommand) -> None:
    acceptance = command.acceptance
    validate_target_alignment(command.target, acceptance.work_version_id)


def validate_completion_target(target: TargetProjection) -> None:
    validate_target_alignment(target, target.work_version_id)
    if target.result.outcome != "completed":
        raise ExecutionRejectedError("completion target result must be completed")
    if target.result.failure is not None:
        raise ExecutionRejectedError("completed target must not contain a failure")
    if target.failure_stages_to_clear != ("analysis", "feedback"):
        raise ExecutionRejectedError("completion may clear only analysis and feedback failures")


def _validate_result_discriminator(details: CanonicalJsonObject) -> None:
    if any(key == "result" for key, _value in details.entries):
        raise ExecutionRejectedError("result details must not contain a discriminator")


__all__ = (
    "ExecutionRejectedError",
    "canonical_import_record_projection",
    "canonical_target_projection",
    "target_projection_canonical",
    "validate_completion_target",
    "validate_content_acceptance_command",
    "validate_import_acceptance_command",
    "validate_target_alignment",
)
