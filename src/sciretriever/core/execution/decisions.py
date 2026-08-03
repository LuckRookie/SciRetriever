from __future__ import annotations

from typing import Final, Literal

from sciretriever.model.canonical_json import assert_never
from sciretriever.model.execution import (
    ActualProcessTarget,
    ExecutionCandidate,
    RecoveryTarget,
    StateCounts,
    TargetResult,
    TargetState,
)
from sciretriever.model.primitives import BatchStatus, MissingStep, WorkVersionState

_PROCESS_STEPS: Final = (
    MissingStep.PRIMARY_PDF,
    MissingStep.LIGHT_DOCUMENT,
    MissingStep.COMPLETION,
)


def steps_to_target(
    initial_state: WorkVersionState,
    target_state: WorkVersionState,
) -> tuple[MissingStep, ...]:
    return _PROCESS_STEPS[_state_position(initial_state) : _state_position(target_state)]


def select_actual_targets(
    candidates: tuple[ExecutionCandidate, ...],
    target_state: WorkVersionState,
    limit: int,
) -> tuple[ActualProcessTarget, ...]:
    unique_candidates = {candidate.work_version_id: candidate for candidate in candidates}
    actual_targets: list[ActualProcessTarget] = []
    for candidate in sorted(unique_candidates.values(), key=lambda item: str(item.work_version_id)):
        missing_steps = steps_to_target(candidate.state, target_state)
        if not missing_steps:
            continue
        actual_targets.append(
            ActualProcessTarget(
                work_version_id=candidate.work_version_id,
                initial_state=candidate.state,
                target_state=target_state,
                missing_step=missing_steps[0],
            )
        )
    return tuple(actual_targets[:limit])


def state_counts(results: tuple[TargetResult, ...]) -> StateCounts:
    completed = 0
    partially_advanced = 0
    missing = 0
    skipped = 0
    failed = 0
    not_started = 0
    for result in results:
        match result.outcome:
            case "completed":
                completed += 1
            case "partially-advanced":
                partially_advanced += 1
            case "missing":
                missing += 1
            case "skipped":
                skipped += 1
            case "failed":
                failed += 1
            case "not-started":
                not_started += 1
            case unreachable:
                assert_never(unreachable)
    return StateCounts(
        kind="state",
        selected=len(results),
        completed=completed,
        partially_advanced=partially_advanced,
        missing=missing,
        skipped=skipped,
        failed=failed,
        not_started=not_started,
    )


def derive_process_batch_status(
    counts: StateCounts,
    interrupted: bool,
    common_error: bool,
) -> BatchStatus:
    if interrupted:
        return BatchStatus.INTERRUPTED
    if common_error:
        return BatchStatus.FAILED
    if counts.selected == 0:
        return BatchStatus.NO_TARGET
    if counts.completed == counts.selected:
        return BatchStatus.COMPLETED
    if counts.completed + counts.partially_advanced > 0:
        return BatchStatus.PARTIAL
    return BatchStatus.FAILED


def recover_interrupted_target(target: RecoveryTarget) -> TargetResult:
    if target.result is not None:
        return target.result
    if target.current_state is None:
        final_state = target.initial_state
    else:
        final_state = target.current_state
    if not target.started:
        outcome = "not-started"
    elif target.current_state is None:
        outcome = "skipped"
    elif _state_position(target.current_state) >= _state_position(target.target_state):
        outcome = "completed"
    elif _state_position(target.current_state) > _state_position(target.initial_state):
        outcome = "partially-advanced"
    else:
        outcome = "failed"
    return TargetResult(
        subject_type="work-version",
        subject_id=str(target.work_version_id),
        outcome=outcome,
        initial_state=_target_state(target.initial_state),
        target_state=_target_state(target.target_state),
        final_state=_target_state(final_state),
        stage=None,
        failure=None,
    )


def nonexecuted_target_result(
    target: ActualProcessTarget,
    outcome: Literal["skipped", "not-started"],
) -> TargetResult:
    return TargetResult(
        subject_type="work-version",
        subject_id=str(target.work_version_id),
        outcome=outcome,
        initial_state=_target_state(target.initial_state),
        target_state=_target_state(target.target_state),
        final_state=_target_state(target.initial_state),
        stage=None,
        failure=None,
    )


def _state_position(state: WorkVersionState) -> int:
    match state:
        case WorkVersionState.UNREVIEWED:
            return 0
        case WorkVersionState.ASSET_READY:
            return 1
        case WorkVersionState.LIGHT_TEXT_READY:
            return 2
        case WorkVersionState.COMPLETED:
            return 3
        case unreachable:
            assert_never(unreachable)


def _target_state(state: WorkVersionState) -> TargetState:
    match state:
        case WorkVersionState.UNREVIEWED:
            return "unreviewed"
        case WorkVersionState.ASSET_READY:
            return "asset-ready"
        case WorkVersionState.LIGHT_TEXT_READY:
            return "light-text-ready"
        case WorkVersionState.COMPLETED:
            return "completed"
        case unreachable:
            assert_never(unreachable)


__all__ = (
    "derive_process_batch_status",
    "nonexecuted_target_result",
    "recover_interrupted_target",
    "select_actual_targets",
    "state_counts",
    "steps_to_target",
)
