from __future__ import annotations

from sciretriever.core.library import (
    delete_version_plan,
    delete_work_plan,
    distinct_plan,
    related_versions_plan,
    same_version_plan,
)
from sciretriever.model.library import CurationCommit
from sciretriever.model.primitives import WorkId, WorkVersionId

from .ports import (
    CoreWriteAcquirer,
    CurationTransactionPort,
    GuardedArtifactReconciler,
    LibraryCurationRepository,
)


class CurationService:
    def __init__(
        self,
        repository: LibraryCurationRepository,
        transaction: CurationTransactionPort,
        acquire_core_write: CoreWriteAcquirer,
        reconciler: GuardedArtifactReconciler | None = None,
    ) -> None:
        self._repository = repository
        self._transaction = transaction
        self._acquire_core_write = acquire_core_write
        self._reconciler = reconciler

    def same_version(
        self,
        left: WorkVersionId,
        right: WorkVersionId,
        survivor: WorkVersionId,
    ) -> CurationCommit:
        with self._acquire_core_write():
            topology = self._repository.load_curation_topology()
            commit = self._transaction.apply(same_version_plan(topology, left, right, survivor))
            self._reconcile()
            return commit

    def related_versions(
        self,
        left: WorkVersionId,
        right: WorkVersionId,
        survivor_work: WorkId,
    ) -> CurationCommit:
        with self._acquire_core_write():
            topology = self._repository.load_curation_topology()
            return self._transaction.apply(
                related_versions_plan(topology, left, right, survivor_work)
            )

    def distinct(self, left: WorkId, right: WorkId) -> CurationCommit:
        with self._acquire_core_write():
            topology = self._repository.load_curation_topology()
            return self._transaction.apply(distinct_plan(topology, left, right))

    def delete_work_version(self, identifier: WorkVersionId) -> CurationCommit:
        with self._acquire_core_write():
            topology = self._repository.load_curation_topology()
            commit = self._transaction.apply(delete_version_plan(topology, identifier))
            self._reconcile()
            return commit

    def delete_work(self, identifier: WorkId) -> CurationCommit:
        with self._acquire_core_write():
            topology = self._repository.load_curation_topology()
            commit = self._transaction.apply(delete_work_plan(topology, identifier))
            self._reconcile()
            return commit

    def _reconcile(self) -> None:
        if self._reconciler is not None:
            self._reconciler.reconcile_guarded()


__all__ = ("CurationService",)
