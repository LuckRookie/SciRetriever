from __future__ import annotations

from collections.abc import Callable

from sciretriever.core.collection import CollectionRuleError
from sciretriever.model.collection import (
    CollectionCounts,
    CollectionRunRecord,
    CollectionSourceResult,
    FinishCollectionRun,
)
from sciretriever.model.primitives import CollectionRunId, CollectionRunStatus
from sciretriever.model.sources import MetadataDiscoveryRequest, MetadataObservation

from .errors import CollectionAcceptanceConflict
from .ports import CollectionRepository, MetadataSourcePort
from .run_finalization import CollectionRunFinalizer
from .source_progress import SourceProgress, source_failure

PublishObservation = Callable[[MetadataObservation, int], str]


class SourceRunExecutor:
    def __init__(
        self,
        repository: CollectionRepository,
        sources: tuple[MetadataSourcePort, ...],
        publish: PublishObservation,
    ) -> None:
        self._repository = repository
        self._sources = sources
        self._publish = publish

    def execute(  # noqa: C901
        self,
        run_id: CollectionRunId,
        request: MetadataDiscoveryRequest,
        existing: set[str],
    ) -> CollectionRunRecord:
        accepted: set[str] = set()
        source_results: list[CollectionSourceResult] = []
        finalizer = CollectionRunFinalizer(self._repository)
        try:
            for ordinal, source in enumerate(self._sources):
                progress = SourceProgress(ordinal, source.name)
                try:
                    result = source.port.search(request)
                    if result.provider != source.name:
                        raise CollectionRuleError.for_field(
                            "provider result", "must match configured source"
                        )
                    observations, duplicate_failure = _unique_observations(result.observations)
                    for observation in observations:
                        try:
                            work_id = self._publish(observation, ordinal)
                        except CollectionAcceptanceConflict:
                            progress.missing += 1
                        else:
                            progress.accepted += 1
                            accepted.add(work_id)
                    source_results.append(
                        progress.result(
                            source_failure(result.failure, duplicate_failure, progress.missing)
                        )
                    )
                except KeyboardInterrupt:
                    source_results.append(
                        progress.result(
                            (
                                "interrupted",
                                "collection run was interrupted",
                                "rerun collection to resume from durable facts",
                                True,
                            )
                        )
                    )
                    raise
                except Exception:  # noqa: BLE001  # noqa: BROAD_EXCEPT_OK
                    if progress.accepted or progress.missing:
                        source_results.append(
                            progress.result(
                                (
                                    "execution-failed",
                                    "source execution failed",
                                    "inspect the source adapter and retry collection",
                                    True,
                                )
                            )
                        )
                    raise
        except KeyboardInterrupt:
            self._finish(
                finalizer,
                run_id,
                CollectionRunStatus.INTERRUPTED,
                "interrupted",
                accepted,
                existing,
                source_results,
            )
            raise
        except Exception:  # noqa: BLE001  # noqa: BROAD_EXCEPT_OK
            self._finish(
                finalizer,
                run_id,
                CollectionRunStatus.FAILED,
                "execution-failed",
                accepted,
                existing,
                source_results,
            )
            raise
        partial = any(item.failure_code is not None or item.missing for item in source_results)
        return self._finish(
            finalizer,
            run_id,
            CollectionRunStatus.PARTIAL if partial else CollectionRunStatus.COMPLETED,
            "source-or-publication-failure" if partial else None,
            accepted,
            existing,
            source_results,
        )

    def _finish(
        self,
        finalizer: CollectionRunFinalizer,
        run_id: CollectionRunId,
        status: CollectionRunStatus,
        stop_reason: str | None,
        accepted: set[str],
        existing: set[str],
        source_results: list[CollectionSourceResult],
    ) -> CollectionRunRecord:
        new_members = len(accepted - existing)
        counts = CollectionCounts(
            discovered=sum(item.discovered for item in source_results),
            accepted=len(accepted),
            new_members=new_members,
            existing_members=len(accepted) - new_members,
            missing=sum(item.missing for item in source_results),
            source_failures=sum(item.failure_code is not None for item in source_results),
        )
        return finalizer.finish(
            FinishCollectionRun(
                run_id=run_id,
                status=status,
                stop_reason=stop_reason,
                counts=counts,
                source_results=tuple(source_results),
            )
        )


def _unique_observations(
    observations: tuple[MetadataObservation, ...],
) -> tuple[tuple[MetadataObservation, ...], tuple[str, ...]]:
    first_by_subject: dict[tuple[str, str], MetadataObservation] = {}
    conflicts: list[str] = []
    for observation in observations:
        subject = (observation.provider, observation.provider_record_id)
        first = first_by_subject.get(subject)
        if first is None:
            first_by_subject[subject] = observation
        elif not _same_facts(first, observation):
            conflicts.append(observation.provider_record_id)
    return tuple(first_by_subject.values()), tuple(dict.fromkeys(conflicts))


def _same_facts(first: MetadataObservation, second: MetadataObservation) -> bool:
    first_identifiers = tuple(sorted((item.namespace, item.value) for item in first.identifiers))
    second_identifiers = tuple(sorted((item.namespace, item.value) for item in second.identifiers))
    return (
        first.title == second.title
        and first.authors == second.authors
        and first.publication_year == second.publication_year
        and first_identifiers == second_identifiers
        and first.abstract == second.abstract
    )


__all__ = ("SourceRunExecutor",)
