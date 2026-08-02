from __future__ import annotations

from sciretriever.model.collection import CollectionSourceResult
from sciretriever.model.execution import FailureEvidence


class SourceProgress:
    __slots__ = ("accepted", "missing", "ordinal", "source")

    def __init__(self, ordinal: int, source: str) -> None:
        self.ordinal = ordinal
        self.source = source
        self.accepted = 0
        self.missing = 0

    def result(
        self,
        failure: tuple[str, str, str, bool] | None,
    ) -> CollectionSourceResult:
        fields = (None, None, None, None) if failure is None else failure
        return CollectionSourceResult(
            ordinal=self.ordinal,
            source=self.source,
            discovered=self.accepted + self.missing,
            accepted=self.accepted,
            missing=self.missing,
            failure_code=fields[0],
            failure_reason=fields[1],
            failure_action=fields[2],
            retryable=fields[3],
        )


def source_failure(
    failure: FailureEvidence | None,
    duplicate_subjects: tuple[str, ...],
    missing: int,
) -> tuple[str, str, str, bool] | None:
    if duplicate_subjects:
        subjects = ",".join(duplicate_subjects)
        return (
            "conflicting-source-subject",
            f"source returned conflicting facts for subjects {subjects}",
            "correct the provider response before retrying collection",
            False,
        )
    if missing:
        return (
            "publication-conflict",
            "publication conflict for one or more source subjects",
            "retry collection after refreshing bibliography identity",
            True,
        )
    if failure is None:
        return None
    return failure.code, failure.reason.value, failure.action.value, failure.retryable


__all__ = ("SourceProgress", "source_failure")
