from __future__ import annotations

from sciretriever.collection.model import CollectionRunRecord
from sciretriever.collection.ports import CollectionRepository
from sciretriever.collection.run_results import FinishCollectionRun


class CollectionRunFinalizer:
    def __init__(self, repository: CollectionRepository) -> None:
        self._repository = repository
        self._attempted = False

    @property
    def attempted(self) -> bool:
        return self._attempted

    def finish(self, command: FinishCollectionRun) -> CollectionRunRecord:
        if self._attempted:
            raise AssertionError
        self._attempted = True
        return self._repository.finish_run(command)


__all__ = ("CollectionRunFinalizer",)
