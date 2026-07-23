"""Internal resolver protocol and fresh candidate validation."""

from __future__ import annotations

from typing import Protocol

from sciretriever.acquisition.candidates import RuntimeDownloadCandidate
from sciretriever.acquisition.models import AcquisitionTarget
from sciretriever.acquisition.plan import SourceEntry
from sciretriever.core.enums import AssetRole


class CandidateResolver(Protocol):
    resolver_id: str

    def resolve(
        self,
        target: AcquisitionTarget,
        source: SourceEntry,
        role: AssetRole,
    ) -> tuple[RuntimeDownloadCandidate, ...]: ...


def validate_resolved_candidates(
    source: SourceEntry,
    role: AssetRole,
    resolver_id: str,
    candidates: tuple[RuntimeDownloadCandidate, ...],
) -> tuple[RuntimeDownloadCandidate, ...]:
    if not isinstance(candidates, tuple):
        raise TypeError("resolver must return a tuple")
    by_id: dict[str, RuntimeDownloadCandidate] = {}
    cursors: set[str] = set()
    for candidate in candidates:
        if not isinstance(candidate, RuntimeDownloadCandidate):
            raise TypeError("resolver returned an invalid candidate")
        if (
            candidate.source_candidate_id != source.candidate_id
            or candidate.provider != source.provider
            or candidate.role is not role
            or candidate.resolver_id != resolver_id
        ):
            raise ValueError("resolved candidate does not belong to the requested source")
        if candidate.download_candidate_id in by_id or candidate.resolver_cursor in cursors:
            raise ValueError("resolver returned a duplicate candidate identity or cursor")
        by_id[candidate.download_candidate_id] = candidate
        cursors.add(candidate.resolver_cursor)
    return tuple(
        sorted(by_id.values(), key=lambda item: (item.priority, item.download_candidate_id))
    )


__all__ = ("CandidateResolver", "validate_resolved_candidates")
