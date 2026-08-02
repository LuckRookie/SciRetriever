from __future__ import annotations

from sciretriever.kernel import BoundaryError
from sciretriever.model.collection import (
    CollectionAcceptance,
    ExistingCollectionAcceptance,
)


class CollectionAcceptanceConflict(Exception):
    pass


def validate_collection_acceptance(value: CollectionAcceptance) -> None:
    if value.membership.work_id != value.bibliography.work_id:
        raise BoundaryError.for_field("membership", "must match accepted bibliography Work")
    _validate_collection_evidence(value)


def validate_existing_collection_acceptance(value: ExistingCollectionAcceptance) -> None:
    _validate_collection_evidence(value)


def _validate_collection_evidence(
    value: CollectionAcceptance | ExistingCollectionAcceptance,
) -> None:
    if any(
        item.membership_id != value.membership.membership_id for item in value.causes + value.paths
    ):
        raise BoundaryError.for_field("evidence", "must match collection membership")
    if any(item.run_id != value.membership.first_run_id for item in value.causes + value.paths):
        raise BoundaryError.for_field("evidence", "must match collection run")


__all__ = (
    "CollectionAcceptanceConflict",
    "validate_collection_acceptance",
    "validate_existing_collection_acceptance",
)
