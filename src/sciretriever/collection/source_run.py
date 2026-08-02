from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol

from sciretriever.collection.ports import CollectionRepository, MetadataDiscoveryPort
from sciretriever.collection.publisher_contracts import CollectionAcceptanceConflict
from sciretriever.collection.run_finalization import CollectionRunFinalizer
from sciretriever.collection.run_results import collection_source_failed
from sciretriever.kernel.errors import BoundaryError
from sciretriever.model.collection import (
    CollectionCounts,
    CollectionRunRecord,
    CollectionSourceResult,
    FinishCollectionRun,
)
from sciretriever.model.execution import FailureEvidence
from sciretriever.model.primitives import CollectionRunId, CollectionRunStatus
from sciretriever.model.sources import MetadataDiscoveryRequest, MetadataObservation


class MetadataSourcePort(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def port(self) -> MetadataDiscoveryPort: ...


PublishObservation = Callable[[MetadataObservation, int], str]


@dataclass(slots=True)
class SourceProgress:
    """Accumulate durable progress while one metadata source is processed."""

    ordinal: int
    source: str
    accepted: int = 0
    missing: int = 0

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
                        raise BoundaryError.for_field(
                            "provider result",
                            "must match configured source",
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
                            _source_failure(
                                result.failure,
                                duplicate_failure,
                                progress.missing,
                            )
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
                except Exception:  # noqa: BLE001
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
        except Exception:  # noqa: BLE001
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
        partial = any(collection_source_failed(item) or item.missing for item in source_results)
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
            source_failures=sum(collection_source_failed(item) for item in source_results),
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


def _source_failure(
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


__all__ = ("SourceRunExecutor",)
