from __future__ import annotations

from dataclasses import dataclass
from types import TracebackType
from typing import Protocol

from sciretriever.model.execution import (
    ActualProcessTarget,
    BatchDetail,
    ExecutionCandidate,
    ProcessBatchScope,
    RecoverableProcessBatch,
    TargetResultEnvelope,
    TargetStepOutcome,
    TargetStepRequest,
)
from sciretriever.model.primitives import (
    AdmissionBindingId,
    BatchRunId,
    MissingStep,
    Sha256,
    UtcTimestamp,
    WorkVersionId,
)


@dataclass(frozen=True, slots=True)
class CatalogIdentity:
    binding_id: AdmissionBindingId
    fingerprint: Sha256


@dataclass(frozen=True, slots=True)
class OutputIdentity:
    binding_id: AdmissionBindingId
    fingerprint: Sha256


class AdmissionGuard(Protocol):
    def __enter__(self) -> AdmissionGuard: ...

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None: ...


class AdmissionPort(Protocol):
    def acquire_core_write(self, catalog: CatalogIdentity) -> AdmissionGuard: ...

    def acquire_exchange_batch_owner(self, batch_run_id: BatchRunId) -> AdmissionGuard: ...

    def acquire_package_owner(
        self, catalog: CatalogIdentity, work_version_id: WorkVersionId
    ) -> AdmissionGuard: ...

    def acquire_output_path(self, output: OutputIdentity) -> AdmissionGuard: ...


class Clock(Protocol):
    def __call__(self) -> UtcTimestamp: ...


class CoreWriteAcquirer(Protocol):
    def __call__(self) -> AdmissionGuard: ...


class ExecutionRepository(Protocol):
    def list_recoverable_process_batches(self) -> tuple[RecoverableProcessBatch, ...]: ...

    def select_process_candidates(
        self, scope: ProcessBatchScope
    ) -> tuple[ExecutionCandidate, ...]: ...

    def create_process_batch(
        self,
        batch_run_id: BatchRunId,
        scope: ProcessBatchScope,
        targets: tuple[ActualProcessTarget, ...],
    ) -> None: ...

    def mark_process_started(self, batch_run_id: BatchRunId, started_at: UtcTimestamp) -> None: ...

    def mark_target_started(
        self, batch_run_id: BatchRunId, work_version_id: WorkVersionId
    ) -> None: ...

    def get_process_candidate(
        self, work_version_id: WorkVersionId
    ) -> ExecutionCandidate | None: ...

    def save_target_result(
        self,
        batch_run_id: BatchRunId,
        result: TargetResultEnvelope,
        *,
        started: bool,
    ) -> None: ...

    def finish_process_batch(self, detail: BatchDetail) -> None: ...


class StepProcessor(Protocol):
    @property
    def step(self) -> MissingStep: ...

    def advance(self, request: TargetStepRequest) -> TargetStepOutcome: ...


class InterruptionPort(Protocol):
    @property
    def interrupted(self) -> bool: ...


__all__ = (
    "AdmissionGuard",
    "AdmissionPort",
    "CatalogIdentity",
    "Clock",
    "CoreWriteAcquirer",
    "ExecutionRepository",
    "InterruptionPort",
    "OutputIdentity",
    "StepProcessor",
)
