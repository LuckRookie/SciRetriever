from __future__ import annotations

from sciretriever.model.collection import (
    CollectionAcceptance,
    ExistingCollectionAcceptance,
)

from .errors import CollectionRuleError


def validate_collection_acceptance(value: CollectionAcceptance) -> None:
    """Validate a new collection membership against its bibliography and evidence."""
    if value.membership.work_id != value.bibliography.work_id:
        raise CollectionRuleError.for_field("membership", "must match accepted bibliography Work")
    _validate_collection_evidence(value)


def validate_existing_collection_acceptance(value: ExistingCollectionAcceptance) -> None:
    """Validate an existing collection membership against its evidence."""
    _validate_collection_evidence(value)


def _validate_collection_evidence(
    value: CollectionAcceptance | ExistingCollectionAcceptance,
) -> None:
    if any(
        item.membership_id != value.membership.membership_id for item in value.causes + value.paths
    ):
        raise CollectionRuleError.for_field("evidence", "must match collection membership")
    if any(item.run_id != value.membership.first_run_id for item in value.causes + value.paths):
        raise CollectionRuleError.for_field("evidence", "must match collection run")


__all__ = (
    "validate_collection_acceptance",
    "validate_existing_collection_acceptance",
)
