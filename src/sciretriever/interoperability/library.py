from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from sciretriever.interoperability.library_details import (
    CollectionMembershipPage,
    GraphPage,
    WorkDetail,
    WorkVersionDetail,
)
from sciretriever.interoperability.library_views import LibrarySummary
from sciretriever.kernel import BoundaryError
from sciretriever.model.library import QueryFilterV1
from sciretriever.model.primitives import (
    CollectionId,
    WorkId,
    WorkVersionId,
)


@dataclass(frozen=True, slots=True)
class LibraryPageRequest:
    limit: int
    cursor: str | None
    include_all_versions: bool

    def __post_init__(self) -> None:
        if not 1 <= self.limit <= 1000:
            raise BoundaryError.for_field("limit", "must be from 1 through 1000")


@dataclass(frozen=True, slots=True)
class LibraryPage:
    items: tuple[LibrarySummary, ...]
    next_cursor: str | None


class LibraryReadPort(Protocol):
    def search(self, filters: QueryFilterV1, request: LibraryPageRequest) -> LibraryPage: ...
    def get_work(
        self, work_id: WorkId, observations: bool, namespaces: tuple[str, ...]
    ) -> WorkDetail: ...
    def get_version(
        self, version_id: WorkVersionId, observations: bool, namespaces: tuple[str, ...]
    ) -> WorkVersionDetail: ...
    def references(
        self, version_id: WorkVersionId, unresolved: bool, limit: int, cursor: str | None
    ) -> GraphPage: ...
    def collection_memberships(
        self, collection_id: CollectionId, after: WorkId | None, limit: int
    ) -> CollectionMembershipPage: ...
    def authority_fingerprint(self) -> str: ...
    def drop_search_indexes(self) -> None: ...
    def rebuild_search_indexes(self) -> None: ...


class LibraryReadService:
    def __init__(self, repository: LibraryReadPort) -> None:
        self._repository = repository

    def search(self, filters: QueryFilterV1, request: LibraryPageRequest) -> LibraryPage:
        return self._repository.search(filters, request)

    def get_work(
        self, work_id: WorkId, observations: bool = False, namespaces: tuple[str, ...] = ()
    ) -> WorkDetail:
        return self._repository.get_work(work_id, observations, namespaces)

    def get_version(
        self,
        version_id: WorkVersionId,
        observations: bool = False,
        namespaces: tuple[str, ...] = (),
    ) -> WorkVersionDetail:
        return self._repository.get_version(version_id, observations, namespaces)

    def references(
        self, version_id: str, unresolved: bool, limit: int, cursor: str | None
    ) -> GraphPage:
        return self._repository.references(WorkVersionId(version_id), unresolved, limit, cursor)

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


__all__ = ("LibraryPage", "LibraryPageRequest", "LibraryReadPort", "LibraryReadService")
