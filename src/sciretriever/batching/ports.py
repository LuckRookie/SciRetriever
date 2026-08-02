from __future__ import annotations

from dataclasses import dataclass
from types import TracebackType
from typing import Protocol

from sciretriever.model.primitives import AdmissionBindingId, BatchRunId, Sha256, WorkVersionId


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


__all__ = ("AdmissionGuard", "AdmissionPort", "CatalogIdentity", "OutputIdentity")
