from __future__ import annotations

from sciretriever.model.collection import MembershipPageRequest
from sciretriever.model.primitives import CollectionId

from .ports import CollectionRepository


def existing_work_ids(repository: CollectionRepository, collection_id: CollectionId) -> set[str]:
    members: set[str] = set()
    after = None
    while True:
        page = repository.list_memberships(
            MembershipPageRequest(
                collection_id=collection_id,
                after_work_id=after,
                limit=1000,
            )
        )
        members.update(str(item.work_id) for item in page.members)
        after = page.next_after_work_id
        if after is None:
            return members


__all__ = ("existing_work_ids",)
