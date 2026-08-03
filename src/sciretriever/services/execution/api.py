# noqa: SIZE_OK - execution lifecycle orchestration remains with one service owner
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import uuid4

from sciretriever.core.execution import (
    derive_process_batch_status,
    nonexecuted_target_result,
    recover_interrupted_target,
    select_actual_targets,
    state_counts,
    steps_to_target,
)
from sciretriever.model.canonical_json import CanonicalJsonObject, assert_never
from sciretriever.model.execution import (
    ActualProcessTarget,
    BatchDetail,
    CurrentFailure,
    ProcessBatchScope,
    TargetResult,
    TargetResultEnvelope,
    TargetState,
    TargetStepRequest,
)
from sciretriever.model.primitives import (
    BatchRunId,
    BatchType,
    MissingStep,
    PublicationPhase,
    UtcTimestamp,
    WorkVersionState,
)

from .ports import (
    Clock,
    CoreWriteAcquirer,
    ExecutionRepository,
    InterruptionPort,
    StepProcessor,
)

NonexecutedOutcome = Literal["skipped", "not-started"]


@dataclass(frozen=True, slots=True)
class ExecutionServiceDependencies:
    repository: ExecutionRepository
    acquire_core_write: CoreWriteAcquirer
    clock: Clock
    processors: tuple[StepProcessor, ...]


class ExecutionService:
    def __init__(self, dependencies: ExecutionServiceDependencies) -> None:
        self._dependencies = dependencies

    def run_process(
        self,
        scope: ProcessBatchScope,
        interruption: InterruptionPort | None = None,
    ) -> BatchDetail:
        with self._dependencies.acquire_core_write():
            self._close_abandoned_runs()
            candidates = self._dependencies.repository.select_process_candidates(scope)
            target_state = _work_version_state(scope.target_state)
            targets = select_actual_targets(candidates, target_state, scope.limit)
            batch_run_id = BatchRunId(str(uuid4()))
            self._dependencies.repository.create_process_batch(batch_run_id, scope, targets)
            if not targets:
                return self._finish(
                    batch_run_id,
                    scope,
                    None,
                    (),
                    interrupted=False,
                    common_error=None,
                )
            started_at = self._dependencies.clock()
            self._dependencies.repository.mark_process_started(batch_run_id, started_at)
            processors = self._processors_by_step()
            missing_steps_by_target = tuple(
                _target_missing_processor_steps(target, processors) for target in targets
            )
            missing_steps = _common_missing_processor_steps(missing_steps_by_target)
            if missing_steps:
                failure = self._capability_failure(missing_steps)
                capability_results = tuple(
                    self._save_nonexecuted_result(
                        batch_run_id, target, "not-started", started=False
                    )
                    for target in targets
                )
                return self._finish(
                    batch_run_id,
                    scope,
                    started_at,
                    capability_results,
                    interrupted=False,
                    common_error=failure,
                )

            results: list[TargetResult] = []
            for index, (target, target_missing_steps) in enumerate(
                zip(targets, missing_steps_by_target, strict=True)
            ):
                if interruption is not None and interruption.interrupted:
                    results.extend(
                        self._save_nonexecuted_result(
                            batch_run_id, pending, "not-started", started=False
                        )
                        for pending in targets[index:]
                    )
                    return self._finish(
                        batch_run_id,
                        scope,
                        started_at,
                        tuple(results),
                        interrupted=True,
                        common_error=None,
                    )
                if target_missing_steps:
                    results.append(
                        self._save_nonexecuted_result(
                            batch_run_id, target, "not-started", started=False
                        )
                    )
                    continue
                results.append(self._run_target(batch_run_id, target, processors))
            return self._finish(
                batch_run_id,
                scope,
                started_at,
                tuple(results),
                interrupted=False,
                common_error=None,
            )

    def _close_abandoned_runs(self) -> None:
        recoverable = self._dependencies.repository.list_recoverable_process_batches()
        for batch in recoverable:
            results: list[TargetResult] = []
            for target in batch.targets:
                result = recover_interrupted_target(target)
                if target.result is None:
                    self._dependencies.repository.save_target_result(
                        batch.batch_run_id,
                        TargetResultEnvelope(result=result, details=CanonicalJsonObject(())),
                        started=target.started,
                    )
                results.append(result)
            result_tuple = tuple(results)
            counts = state_counts(result_tuple)
            detail = BatchDetail(
                kind="batch-detail",
                batch_run_id=batch.batch_run_id,
                batch_type=BatchType.PROCESS,
                status=derive_process_batch_status(counts, interrupted=True, common_error=False),
                publication_phase=PublicationPhase.NONE,
                scope=batch.scope,
                target_state=batch.scope.target_state,
                stop_reason="abandoned",
                common_error=None,
                counts=counts,
                results=result_tuple,
                started_at=batch.started_at,
                finished_at=self._dependencies.clock(),
            )
            self._dependencies.repository.finish_process_batch(detail)

    def _processors_by_step(self) -> dict[MissingStep, StepProcessor]:
        return {processor.step: processor for processor in self._dependencies.processors}

    def _run_target(
        self,
        batch_run_id: BatchRunId,
        target: ActualProcessTarget,
        processors: dict[MissingStep, StepProcessor],
    ) -> TargetResult:
        candidate = self._dependencies.repository.get_process_candidate(target.work_version_id)
        if candidate is None or not steps_to_target(candidate.state, target.target_state):
            return self._save_nonexecuted_result(batch_run_id, target, "skipped", started=False)
        self._dependencies.repository.mark_target_started(batch_run_id, target.work_version_id)
        last_result: TargetResult | None = None
        while True:
            candidate = self._dependencies.repository.get_process_candidate(target.work_version_id)
            if candidate is None:
                return self._save_nonexecuted_result(batch_run_id, target, "skipped", started=True)
            missing_steps = steps_to_target(candidate.state, target.target_state)
            if not missing_steps:
                if last_result is None:
                    return self._save_nonexecuted_result(
                        batch_run_id, target, "skipped", started=True
                    )
                return last_result
            step = missing_steps[0]
            outcome = processors[step].advance(
                TargetStepRequest(
                    batch_run_id=batch_run_id,
                    work_version_id=target.work_version_id,
                    initial_state=target.initial_state,
                    target_state=target.target_state,
                )
            )
            match outcome.result_write:
                case "publisher-committed":
                    pass
                case "execution-required":
                    self._dependencies.repository.save_target_result(
                        batch_run_id, outcome.envelope, started=True
                    )
                case unreachable:
                    assert_never(unreachable)
            result = outcome.envelope.result
            last_result = result
            match result.outcome:
                case "completed" | "partially-advanced":
                    continue
                case "missing" | "skipped" | "failed" | "not-started":
                    return result
                case unreachable:
                    assert_never(unreachable)

    def _save_nonexecuted_result(
        self,
        batch_run_id: BatchRunId,
        target: ActualProcessTarget,
        outcome: NonexecutedOutcome,
        *,
        started: bool,
    ) -> TargetResult:
        result = nonexecuted_target_result(target, outcome)
        self._dependencies.repository.save_target_result(
            batch_run_id,
            TargetResultEnvelope(result=result, details=CanonicalJsonObject(())),
            started=started,
        )
        return result

    def _capability_failure(self, missing_steps: tuple[MissingStep, ...]) -> CurrentFailure:
        steps = ", ".join(str(step) for step in missing_steps)
        return CurrentFailure(
            stage="execution",
            code="required-capability-unavailable",
            reason=f"required processors are unavailable for: {steps}",
            action="configure required processors before retrying",
            retryable=True,
            updated_at=self._dependencies.clock(),
        )

    def _finish(
        self,
        batch_run_id: BatchRunId,
        scope: ProcessBatchScope,
        started_at: UtcTimestamp | None,
        results: tuple[TargetResult, ...],
        interrupted: bool,
        common_error: CurrentFailure | None,
    ) -> BatchDetail:
        counts = state_counts(results)
        detail = BatchDetail(
            kind="batch-detail",
            batch_run_id=batch_run_id,
            batch_type=BatchType.PROCESS,
            status=derive_process_batch_status(
                counts, interrupted=interrupted, common_error=common_error is not None
            ),
            publication_phase=PublicationPhase.NONE,
            scope=scope,
            target_state=scope.target_state,
            stop_reason="interrupted" if interrupted else None,
            common_error=common_error,
            counts=counts,
            results=results,
            started_at=started_at,
            finished_at=self._dependencies.clock(),
        )
        self._dependencies.repository.finish_process_batch(detail)
        return detail


def _target_missing_processor_steps(
    target: ActualProcessTarget,
    processors: dict[MissingStep, StepProcessor],
) -> tuple[MissingStep, ...]:
    return tuple(
        step
        for step in steps_to_target(target.initial_state, target.target_state)
        if step not in processors
    )


def _common_missing_processor_steps(
    missing_steps_by_target: tuple[tuple[MissingStep, ...], ...],
) -> tuple[MissingStep, ...]:
    if not missing_steps_by_target:
        return ()
    first_missing = missing_steps_by_target[0]
    return tuple(
        step
        for step in first_missing
        if all(step in target_missing_steps for target_missing_steps in missing_steps_by_target[1:])
    )


def _work_version_state(target_state: TargetState) -> WorkVersionState:
    match target_state:
        case "unreviewed":
            return WorkVersionState.UNREVIEWED
        case "asset-ready":
            return WorkVersionState.ASSET_READY
        case "light-text-ready":
            return WorkVersionState.LIGHT_TEXT_READY
        case "completed":
            return WorkVersionState.COMPLETED
        case unreachable:
            assert_never(unreachable)


__all__ = ("ExecutionService", "ExecutionServiceDependencies")
