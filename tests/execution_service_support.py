from __future__ import annotations

from types import TracebackType
from typing import Literal

from sciretriever.model.canonical_json import CanonicalJsonObject, assert_never
from sciretriever.model.execution import (
    ActualProcessTarget,
    BatchDetail,
    ExecutionCandidate,
    ExecutionStage,
    ProcessBatchScope,
    RecoverableProcessBatch,
    RecoveryTarget,
    TargetResult,
    TargetResultEnvelope,
    TargetStepOutcome,
    TargetStepRequest,
)
from sciretriever.model.primitives import (
    BatchRunId,
    MissingStep,
    UtcTimestamp,
    WorkVersionId,
    WorkVersionState,
)
from sciretriever.services.execution.ports import AdmissionGuard


class FakeGuard:
    def __init__(self, events: list[str]) -> None:
        self._events = events

    def __enter__(self) -> AdmissionGuard:
        self._events.append("admission-enter")
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self._events.append("admission-exit")


class FakeRepository:
    def __init__(self, states: dict[WorkVersionId, WorkVersionState]) -> None:
        self.states = states
        self.events: list[str] = []
        self.results: list[tuple[BatchRunId, TargetResultEnvelope, bool]] = []
        self.details: list[BatchDetail] = []
        self.recoverable: tuple[RecoverableProcessBatch, ...] = ()

    def list_recoverable_process_batches(self) -> tuple[RecoverableProcessBatch, ...]:
        self.events.append("recover")
        return self.recoverable

    def select_process_candidates(self, scope: ProcessBatchScope) -> tuple[ExecutionCandidate, ...]:
        self.events.append("select")
        selected = set(scope.selected_version_ids)
        return tuple(
            ExecutionCandidate(work_version_id=version_id, state=state)
            for version_id, state in self.states.items()
            if not selected or version_id in selected
        )

    def create_process_batch(
        self,
        batch_run_id: BatchRunId,
        scope: ProcessBatchScope,
        targets: tuple[ActualProcessTarget, ...],
    ) -> None:
        _ = scope
        self.events.append(f"create:{batch_run_id}:{len(targets)}")

    def mark_process_started(self, batch_run_id: BatchRunId, started_at: UtcTimestamp) -> None:
        _ = started_at
        self.events.append(f"batch-start:{batch_run_id}")

    def mark_target_started(self, batch_run_id: BatchRunId, work_version_id: WorkVersionId) -> None:
        self.events.append(f"target-start:{batch_run_id}:{work_version_id}")

    def get_process_candidate(self, work_version_id: WorkVersionId) -> ExecutionCandidate | None:
        state = self.states.get(work_version_id)
        if state is None:
            return None
        return ExecutionCandidate(work_version_id=work_version_id, state=state)

    def save_target_result(
        self,
        batch_run_id: BatchRunId,
        result: TargetResultEnvelope,
        *,
        started: bool,
    ) -> None:
        self.results.append((batch_run_id, result, started))

    def finish_process_batch(self, detail: BatchDetail) -> None:
        self.details.append(detail)


class ToggleInterruption:
    def __init__(self) -> None:
        self.interrupted = False


class FakeStepProcessor:
    def __init__(
        self,
        step: MissingStep,
        repository: FakeRepository,
        missing: frozenset[WorkVersionId] = frozenset(),
        interruption: ToggleInterruption | None = None,
        interrupt_after: WorkVersionId | None = None,
    ) -> None:
        self._step = step
        self._repository = repository
        self._missing = missing
        self._interruption = interruption
        self._interrupt_after = interrupt_after

    @property
    def step(self) -> MissingStep:
        return self._step

    def advance(self, request: TargetStepRequest) -> TargetStepOutcome:
        current = self._repository.states[request.work_version_id]
        if request.work_version_id in self._missing:
            outcome = "missing"
            final_state = current
        else:
            final_state = self._advanced_state()
            self._repository.states[request.work_version_id] = final_state
            outcome = "completed" if final_state is request.target_state else "partially-advanced"
        if self._interruption is not None and request.work_version_id == self._interrupt_after:
            self._interruption.interrupted = True
        result = TargetResult.model_validate(
            {
                "subject_type": "work-version",
                "subject_id": str(request.work_version_id),
                "outcome": outcome,
                "initial_state": request.initial_state.value,
                "target_state": request.target_state.value,
                "final_state": final_state.value,
                "stage": self._step_stage(),
                "failure": None,
            }
        )
        envelope = TargetResultEnvelope(result=result, details=CanonicalJsonObject(()))
        result_write: Literal["publisher-committed", "execution-required"] = (
            "execution-required" if outcome == "missing" else "publisher-committed"
        )
        return TargetStepOutcome(envelope=envelope, result_write=result_write)

    def _advanced_state(self) -> WorkVersionState:
        match self._step:
            case MissingStep.PRIMARY_PDF:
                return WorkVersionState.ASSET_READY
            case MissingStep.LIGHT_DOCUMENT:
                return WorkVersionState.LIGHT_TEXT_READY
            case MissingStep.COMPLETION:
                return WorkVersionState.COMPLETED
            case unreachable:
                assert_never(unreachable)

    def _step_stage(self) -> ExecutionStage:
        match self._step:
            case MissingStep.PRIMARY_PDF:
                return "asset"
            case MissingStep.LIGHT_DOCUMENT:
                return "light-document"
            case MissingStep.COMPLETION:
                return "completion"
            case unreachable:
                assert_never(unreachable)


def recovery_batch(
    batch_run_id: BatchRunId,
    scope: ProcessBatchScope,
    targets: tuple[RecoveryTarget, ...],
) -> RecoverableProcessBatch:
    return RecoverableProcessBatch(
        batch_run_id=batch_run_id,
        scope=scope,
        targets=targets,
        started_at=UtcTimestamp("2026-08-03T00:00:00Z"),
    )
