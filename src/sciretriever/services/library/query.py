from __future__ import annotations

from sciretriever.model.library_details import (
    CollectionMembershipPage,
    GraphPage,
    WorkDetail,
    WorkVersionDetail,
)
from sciretriever.model.library_pages import LibraryPage, LibraryPageRequest
from sciretriever.model.library_query import QueryFilterV1
from sciretriever.model.primitives import CollectionId, WorkId, WorkVersionId

from .ports import LibraryReadPort


class LibraryService:
    def __init__(self, repository: LibraryReadPort) -> None:
        self._repository = repository

    def search(self, filters: QueryFilterV1, request: LibraryPageRequest) -> LibraryPage:
        return self._repository.search(filters, request)

    def get_work(self, work_id: WorkId, observations: bool = False) -> WorkDetail:
        return self._repository.get_work(work_id, observations)

    def get_version(
        self,
        version_id: WorkVersionId,
        observations: bool = False,
    ) -> WorkVersionDetail:
        return self._repository.get_version(version_id, observations)

    def references(
        self, version_id: WorkVersionId, unresolved: bool, limit: int, cursor: str | None
    ) -> GraphPage:
        return self._repository.references(version_id, unresolved, limit, cursor)

    def collection_memberships(
        self, collection_id: CollectionId, after: WorkId | None, limit: int
    ) -> CollectionMembershipPage:
        return self._repository.collection_memberships(collection_id, after, limit)

    def authority_fingerprint(self) -> str:
        return self._repository.authority_fingerprint()

    def drop_search_indexes(self) -> None:
        self._repository.drop_search_indexes()

    def rebuild_search_indexes(self) -> None:
        self._repository.rebuild_search_indexes()


__all__ = ("LibraryService",)
