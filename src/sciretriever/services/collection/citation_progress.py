from __future__ import annotations

from sciretriever.core.collection import collection_source_failed
from sciretriever.model.collection import (
    CollectionCounts,
    CollectionSourceResult,
    FinishCollectionRun,
)
from sciretriever.model.execution import FailureEvidence
from sciretriever.model.primitives import CollectionRunId, CollectionRunStatus, WorkId


class CitationProgress:
    __slots__ = (
        "existing_members",
        "failures",
        "new_count",
        "providers",
        "run_id",
        "seed_ids",
        "totals",
        "visited",
    )

    def __init__(
        self,
        run_id: CollectionRunId,
        providers: tuple[str, ...],
        seeds: tuple[WorkId, ...],
        existing_members: set[str],
    ) -> None:
        self.run_id = run_id
        self.providers = providers
        self.existing_members = existing_members
        self.seed_ids = frozenset(str(item) for item in seeds)
        self.visited = {str(item) for item in seeds}
        self.totals = {name: [0, 0, 0] for name in providers}
        self.failures: dict[str, FailureEvidence] = {}
        self.new_count = 0

    def discovered(self, provider: str, count: int) -> None:
        self.totals[provider][0] += count

    def missing(self, provider: str) -> None:
        self.totals[provider][2] += 1

    def accepted(self, provider: str, work_id: WorkId, is_new: bool) -> None:
        self.totals[provider][1] += 1
        if is_new:
            self.visited.add(str(work_id))
            self.new_count += 1

    def failed(self, provider: str, failure: FailureEvidence) -> None:
        self.failures[provider] = failure

    def command(
        self,
        status: CollectionRunStatus,
        stop_reason: str,
        through_provider: str | None = None,
    ) -> FinishCollectionRun:
        limit = len(self.providers)
        if through_provider is not None:
            limit = self.providers.index(through_provider) + 1
        source_results = tuple(
            CollectionSourceResult(
                ordinal=ordinal,
                source=name,
                discovered=self.totals[name][0],
                accepted=self.totals[name][1],
                missing=self.totals[name][2],
                failure_code=None if name not in self.failures else self.failures[name].code,
                failure_reason=None
                if name not in self.failures
                else self.failures[name].reason.value,
                failure_action=None
                if name not in self.failures
                else self.failures[name].action.value,
                retryable=None if name not in self.failures else self.failures[name].retryable,
            )
            for ordinal, name in enumerate(self.providers[:limit])
        )
        accepted = sum(item.accepted for item in source_results)
        new_members = sum(1 for item in self.visited if item not in self.existing_members) - sum(
            1 for item in self.seed_ids if item not in self.existing_members
        )
        new_members = min(new_members, accepted)
        counts = CollectionCounts(
            discovered=sum(item.discovered for item in source_results),
            accepted=accepted,
            new_members=new_members,
            existing_members=accepted - new_members,
            missing=sum(item.missing for item in source_results),
            source_failures=sum(collection_source_failed(item) for item in source_results),
        )
        return FinishCollectionRun(
            run_id=self.run_id,
            status=status,
            stop_reason=stop_reason,
            counts=counts,
            source_results=source_results,
        )


__all__ = ("CitationProgress",)
