from __future__ import annotations

import os
from contextlib import AbstractContextManager
from dataclasses import dataclass
from types import TracebackType
from uuid import uuid4

from sciretriever.batching.ports import (
    AdmissionGuard,
    AdmissionPort,
    CatalogIdentity,
    OutputIdentity,
)
from sciretriever.literature_store.filesystem.admission_order import (
    AdmissionOrderTracker,
    HeldAdmission,
)
from sciretriever.literature_store.filesystem.locks import (
    AdvisoryLock,
    CanonicalCatalogPath,
    FilesystemSafetyError,
    canonical_catalog_path,
    verify_absent_entry,
    verify_catalog_entry,
)
from sciretriever.model.primitives import AdmissionBindingId, BatchRunId, Sha256, WorkVersionId


class AdmissionConflictError(Exception):
    __slots__ = ("identity",)

    def __init__(self, identity: str) -> None:
        self.identity = identity
        super().__init__(identity)

    def __str__(self) -> str:
        return f"admission conflict: {self.identity}"


class AdmissionBindingError(Exception):
    __slots__ = ("reason",)

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)

    def __str__(self) -> str:
        return self.reason


@dataclass(frozen=True, slots=True)
class BoundCatalogAdmission:
    identity: CatalogIdentity
    port: AdmissionPort


class _Binding:
    __slots__ = ("scope", "fingerprint", "output")

    def __init__(self, scope: CanonicalCatalogPath, fingerprint: Sha256, output: bool) -> None:
        self.scope = scope
        self.fingerprint = fingerprint
        self.output = output


class _Guard:
    def __init__(
        self,
        owner: LocalAdmissionPort,
        entry: HeldAdmission,
        manager: AbstractContextManager[None],
        binding: _Binding,
    ) -> None:
        self._owner = owner
        self._entry = entry
        self._manager = manager
        self._binding = binding
        self._active = True

    def __enter__(self) -> AdmissionGuard:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        if self._active:
            self._active = False
            try:
                self._owner._refresh(self._binding)
            finally:
                try:
                    self._manager.__exit__(exc_type, exc_value, traceback)
                finally:
                    self._owner._released(self._entry)


class LocalAdmissionPort:
    def __init__(
        self,
        bindings: dict[AdmissionBindingId, _Binding],
        catalog: CatalogIdentity,
        tracker: AdmissionOrderTracker,
    ) -> None:
        self._bindings = bindings
        self._catalog = catalog
        self._tracker = tracker

    def _binding(self, identity: CatalogIdentity | OutputIdentity) -> _Binding:
        binding = self._bindings.get(identity.binding_id)
        if binding is None or binding.fingerprint != identity.fingerprint:
            raise AdmissionBindingError("admission identity is unknown or mismatched")
        return binding

    def _acquire(self, binding: _Binding, name: str, rank: int) -> AdmissionGuard:
        kind = name.split("-", 1)[0]
        entry = self._tracker.add(rank, str(binding.fingerprint), kind)
        try:
            if binding.scope.final_inode is None:
                verify_absent_entry(binding.scope)
            else:
                verify_catalog_entry(binding.scope)
        except FilesystemSafetyError:
            self._tracker.remove(entry)
            raise
        manager = AdvisoryLock(binding.scope, name).acquire(blocking=False, serialize_root=False)
        try:
            manager.__enter__()
        except BlockingIOError as error:
            self._tracker.remove(entry)
            raise AdmissionConflictError(f"{binding.fingerprint}:{name}") from error
        except FilesystemSafetyError:
            self._tracker.remove(entry)
            raise
        return _Guard(self, entry, manager, binding)

    def _refresh(self, binding: _Binding) -> None:
        if binding.output and binding.scope.final_inode is None and binding.scope.path.exists():
            binding.scope = canonical_catalog_path(binding.scope.path)

    def _released(self, entry: HeldAdmission) -> None:
        self._tracker.remove(entry)

    def acquire_core_write(self, catalog: CatalogIdentity) -> AdmissionGuard:
        return self._acquire(self._binding(catalog), "core-write", 10)

    def acquire_exchange_batch_owner(self, batch_run_id: BatchRunId) -> AdmissionGuard:
        return self._acquire(self._binding(self._catalog), f"batch-{batch_run_id}", 20)

    def acquire_package_owner(
        self, catalog: CatalogIdentity, work_version_id: WorkVersionId
    ) -> AdmissionGuard:
        return self._acquire(self._binding(catalog), f"package-publish-{work_version_id}", 20)

    def acquire_output_path(self, output: OutputIdentity) -> AdmissionGuard:
        return self._acquire(self._binding(output), "output", 30)


class LocalAdmissionBindingFactory:
    def __init__(self) -> None:
        self._bindings: dict[AdmissionBindingId, _Binding] = {}
        self._tracker = AdmissionOrderTracker()

    def _bind(
        self, path: str | os.PathLike[str], *, output: bool
    ) -> tuple[AdmissionBindingId, _Binding]:
        try:
            scope = canonical_catalog_path(path)
        except FilesystemSafetyError as error:
            raise AdmissionBindingError(str(error)) from error
        identifier = AdmissionBindingId(str(uuid4()))
        binding = _Binding(scope, Sha256(scope.identity), output)
        self._bindings[identifier] = binding
        return identifier, binding

    def bind_catalog(self, path: str | os.PathLike[str]) -> BoundCatalogAdmission:
        identifier, binding = self._bind(path, output=False)
        identity = CatalogIdentity(identifier, binding.fingerprint)
        return BoundCatalogAdmission(
            identity, LocalAdmissionPort(self._bindings, identity, self._tracker)
        )

    def bind_output(self, path: str | os.PathLike[str]) -> OutputIdentity:
        identifier, binding = self._bind(path, output=True)
        return OutputIdentity(identifier, binding.fingerprint)
