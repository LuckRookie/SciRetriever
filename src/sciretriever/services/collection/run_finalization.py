from __future__ import annotations

from sciretriever.core.collection import validate_finish_collection_run
from sciretriever.model.collection import CollectionRunRecord, FinishCollectionRun

from .errors import CollectionRunFinalizationError
from .ports import CollectionRepository


class CollectionRunFinalizer:
    def __init__(self, repository: CollectionRepository) -> None:
        self._repository = repository
        self._attempted = False

    @property
    def attempted(self) -> bool:
        return self._attempted

    def finish(self, command: FinishCollectionRun) -> CollectionRunRecord:
        if self._attempted:
            raise CollectionRunFinalizationError
        self._attempted = True
        validate_finish_collection_run(command)
        return self._repository.finish_run(command)


__all__ = ("CollectionRunFinalizer",)
