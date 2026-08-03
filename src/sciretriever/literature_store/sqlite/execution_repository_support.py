from __future__ import annotations

from collections.abc import Iterable

from pydantic import BaseModel

from sciretriever.model.canonical_json import (
    CanonicalJsonObject,
    CanonicalJsonValue,
    canonical_json_bytes,
    parse_canonical_json,
)
from sciretriever.model.execution import (
    ExecutionCandidate,
    RecoveryTarget,
    StateCounts,
    TargetResult,
    TargetResultEnvelope,
)
from sciretriever.model.primitives import BatchRunId, WorkVersionId, WorkVersionState

_SQL_PARAMETER_CHUNK = 500


class ExecutionPersistenceError(Exception):
    __slots__ = ("reason",)

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)

    def __str__(self) -> str:
        return self.reason


class InvalidProcessBatchDetailError(ExecutionPersistenceError):
    __slots__ = ()


def _canonical_model(value: BaseModel) -> str:
    parsed = parse_canonical_json(value.model_dump_json())
    return canonical_json_bytes(parsed).decode("ascii")


def _envelope_json(envelope: TargetResultEnvelope) -> str:
    result = parse_canonical_json(envelope.result.model_dump_json())
    return canonical_json_bytes(
        CanonicalJsonObject(
            (
                ("details", envelope.details),
                ("result", result),
            )
        )
    ).decode("ascii")


def _object_item(value: CanonicalJsonObject, key: str) -> CanonicalJsonValue | None:
    for item_key, item_value in value.entries:
        if item_key == key:
            return item_value
    return None


def _stored_result(payload: str | None) -> TargetResult | None:
    if payload is None:
        return None
    value = parse_canonical_json(payload)
    if not isinstance(value, CanonicalJsonObject):
        return None
    result = _object_item(value, "result")
    if not isinstance(result, CanonicalJsonObject):
        return None
    return TargetResult.model_validate_json(canonical_json_bytes(result))


def _chunks(values: tuple[WorkVersionId, ...]) -> Iterable[tuple[WorkVersionId, ...]]:
    for offset in range(0, len(values), _SQL_PARAMETER_CHUNK):
        yield values[offset : offset + _SQL_PARAMETER_CHUNK]


def _empty_process_counts(target_count: int) -> StateCounts:
    return StateCounts(
        kind="state",
        selected=target_count,
        completed=0,
        partially_advanced=0,
        missing=0,
        skipped=0,
        failed=0,
        not_started=target_count,
    )


def _execution_candidates(rows: Iterable[tuple[str, str]]) -> tuple[ExecutionCandidate, ...]:
    return tuple(
        ExecutionCandidate(
            work_version_id=WorkVersionId(str(version_id)),
            state=WorkVersionState(str(state)),
        )
        for version_id, state in rows
    )


def _candidate_from_state(
    work_version_id: WorkVersionId, state: str | None
) -> ExecutionCandidate | None:
    if state is None:
        return None
    return ExecutionCandidate(
        work_version_id=work_version_id,
        state=WorkVersionState(state),
    )


def _recovery_targets(
    batch_run_id: BatchRunId,
    rows: Iterable[tuple[str, str, str, int, str | None, str | None]],
) -> tuple[RecoveryTarget, ...]:
    return tuple(
        RecoveryTarget(
            batch_run_id=batch_run_id,
            work_version_id=WorkVersionId(str(row[0])),
            initial_state=WorkVersionState(str(row[1])),
            target_state=WorkVersionState(str(row[2])),
            current_state=None if row[5] is None else WorkVersionState(str(row[5])),
            started=bool(row[3]),
            result=_stored_result(row[4]),
        )
        for row in rows
    )


__all__ = (
    "ExecutionPersistenceError",
    "InvalidProcessBatchDetailError",
)
