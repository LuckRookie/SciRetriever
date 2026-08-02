from __future__ import annotations

from sciretriever.kernel.errors import BoundaryError
from sciretriever.model.collection import (
    CollectionCounts,
    CollectionSourceResult,
    FinishCollectionRun,
)
from sciretriever.model.primitives import CollectionRunStatus


def collection_source_failed(value: CollectionSourceResult) -> bool:
    return value.failure_code is not None


def validate_collection_counts(value: CollectionCounts) -> None:
    if value.accepted != value.new_members + value.existing_members:
        raise BoundaryError.for_field("accepted", "must equal new_members plus existing_members")
    if value.discovered < value.accepted + value.missing:
        raise BoundaryError.for_field("discovered", "must cover accepted and missing results")


def validate_collection_source_result(value: CollectionSourceResult) -> None:
    if value.discovered != value.accepted + value.missing:
        raise BoundaryError.for_field("source discovered", "must equal accepted plus missing")
    failure = (
        value.failure_code,
        value.failure_reason,
        value.failure_action,
        value.retryable,
    )
    if any(item is None for item in failure) != all(item is None for item in failure):
        raise BoundaryError.for_field("source failure", "fields must be all present or all absent")


def validate_finish_collection_run(value: FinishCollectionRun) -> None:
    terminal = frozenset(
        (
            CollectionRunStatus.NO_TARGET,
            CollectionRunStatus.COMPLETED,
            CollectionRunStatus.PARTIAL,
            CollectionRunStatus.FAILED,
            CollectionRunStatus.INTERRUPTED,
        )
    )
    if value.status not in terminal:
        raise BoundaryError.for_field("status", "must be a terminal collection run status")
    requires_reason = value.status in (
        CollectionRunStatus.PARTIAL,
        CollectionRunStatus.FAILED,
        CollectionRunStatus.INTERRUPTED,
    )
    if requires_reason and value.stop_reason is None:
        raise BoundaryError.for_field(
            "stop_reason", "is required for partial, failed, or interrupted"
        )
    if value.status is CollectionRunStatus.NO_TARGET and value.stop_reason is not None:
        raise BoundaryError.for_field("stop_reason", "is forbidden for no-target")
    validate_collection_counts(value.counts)
    for item in value.source_results:
        validate_collection_source_result(item)
    expected_ordinals = tuple(range(len(value.source_results)))
    if tuple(item.ordinal for item in value.source_results) != expected_ordinals:
        raise BoundaryError.for_field("source results", "must use contiguous configured order")
    sources = tuple(item.source for item in value.source_results)
    if len(set(sources)) != len(sources):
        raise BoundaryError.for_field("source results", "must contain unique sources")
    if value.counts.discovered != sum(item.discovered for item in value.source_results):
        raise BoundaryError.for_field("discovered", "must equal source discovered total")
    if value.counts.missing != sum(item.missing for item in value.source_results):
        raise BoundaryError.for_field("missing", "must equal source missing total")
    failures = sum(collection_source_failed(item) for item in value.source_results)
    if value.counts.source_failures != failures:
        raise BoundaryError.for_field("source_failures", "must equal failed source rows")


__all__ = (
    "collection_source_failed",
    "validate_collection_counts",
    "validate_collection_source_result",
    "validate_finish_collection_run",
)
