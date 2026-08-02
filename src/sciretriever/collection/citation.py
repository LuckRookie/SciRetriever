from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID, uuid5

from sciretriever.collection.citation_progress import CitationProgress
from sciretriever.collection.ports import (
    BibliographyIngestionPort,
    CitationDiscoveryPort,
    CollectionAcceptancePublisher,
    CollectionRepository,
)
from sciretriever.collection.publisher_contracts import (
    CollectionAcceptance,
    CollectionAcceptanceConflict,
    CollectionCauseFact,
    CollectionCauseId,
    CollectionCauseKind,
    CollectionMembershipFact,
    CollectionPathFact,
    CollectionPathId,
    ExistingCollectionAcceptance,
)
from sciretriever.collection.run_finalization import CollectionRunFinalizer
from sciretriever.kernel import (
    Action,
    CanonicalJsonObject,
    FailureEvidence,
    Reason,
)
from sciretriever.model.collection import CitationRunInput, CollectionRunRecord
from sciretriever.model.literature import BibliographicObservation, InitialMetadata
from sciretriever.model.primitives import (
    CollectionId,
    CollectionRunId,
    CollectionRunStatus,
    MembershipId,
    UtcTimestamp,
    WorkId,
)
from sciretriever.model.sources import CitationDiscoveryRequest, CitationObservation

_NAMESPACE = UUID("f4fc7f3d-633b-4cc3-8ae7-e32c83cc932d")


@dataclass(frozen=True, slots=True)
class CitationSource:
    name: str
    port: CitationDiscoveryPort


class Clock(Protocol):
    def __call__(self) -> UtcTimestamp: ...


@dataclass(frozen=True, slots=True)
class CitationExecutionDependencies:
    repository: CollectionRepository
    bibliography: BibliographyIngestionPort
    publisher: CollectionAcceptancePublisher
    sources: tuple[CitationSource, ...]
    clock: Clock


def _membership(
    collection_id: CollectionId, work_id: WorkId, run_id: CollectionRunId
) -> CollectionMembershipFact:
    identifier = MembershipId(str(uuid5(_NAMESPACE, f"membership:{collection_id}:{work_id}")))
    return CollectionMembershipFact(identifier, collection_id, work_id, run_id)


def _cause_path(
    membership: CollectionMembershipFact,
    run_id: CollectionRunId,
    source: str,
    parent: WorkId,
    observation: CitationObservation,
    path: tuple[WorkId, ...],
) -> tuple[CollectionCauseFact, CollectionPathFact]:
    key = (
        f"{run_id}:{source}:{parent}:{observation.direction.value}:"
        f"{observation.target_identifier.namespace}:{observation.target_identifier.value}:"
        f"{':'.join(map(str, path))}"
    )
    cause = CollectionCauseFact(
        CollectionCauseId(str(uuid5(_NAMESPACE, f"cause:{key}"))),
        membership.membership_id,
        run_id,
        CollectionCauseKind.REFERENCE
        if observation.direction.value == "references"
        else CollectionCauseKind.CITED_BY,
        CanonicalJsonObject(
            (
                ("identifier", observation.target_identifier.model_dump_json()),
                ("provider", source),
            )
        ),
        path[0],
    )
    citation_path = CollectionPathFact(
        CollectionPathId(str(uuid5(_NAMESPACE, f"path:{key}"))),
        membership.membership_id,
        run_id,
        observation.direction,
        len(path) - 1,
        path,
    )
    return cause, citation_path


class CitationRunExecutor:
    def __init__(self, dependencies: CitationExecutionDependencies) -> None:
        self._dependencies = dependencies

    def execute(  # noqa: C901
        self,
        run_id: CollectionRunId,
        collection_id: CollectionId,
        value: CitationRunInput,
        existing_members: set[str],
    ) -> CollectionRunRecord:
        sources = {item.name: item.port for item in self._dependencies.sources}
        frontier = value.resolved_work_ids
        progress = CitationProgress(run_id, value.providers, frontier, existing_members)
        finalizer = CollectionRunFinalizer(self._dependencies.repository)
        paths: dict[str, tuple[WorkId, ...]] = {str(item): (item,) for item in frontier}
        stop_reason = "depth-limit"
        current_provider: str | None = None
        try:
            for seed in frontier:
                membership = _membership(collection_id, seed, run_id)
                cause = CollectionCauseFact(
                    CollectionCauseId(str(uuid5(_NAMESPACE, f"seed:{run_id}:{seed}"))),
                    membership.membership_id,
                    run_id,
                    CollectionCauseKind.SEED,
                    CanonicalJsonObject((("work_id", str(seed)),)),
                    seed,
                )
                seed_path = CollectionPathFact(
                    CollectionPathId(str(uuid5(_NAMESPACE, f"seed-path:{run_id}:{seed}"))),
                    membership.membership_id,
                    run_id,
                    None,
                    0,
                    (seed,),
                )
                self._dependencies.publisher.publish_existing(
                    ExistingCollectionAcceptance(
                        membership,
                        (cause,),
                        (seed_path,),
                    )
                )
            for layer in range(1, value.depth + 1):
                next_frontier: set[str] = set()
                for parent in frontier:
                    parent_path = paths[str(parent)]
                    for provider in value.providers:
                        current_provider = provider
                        request = CitationDiscoveryRequest(
                            seed=parent,
                            direction=value.direction,
                            limit=value.max_new,
                        )
                        try:
                            result = sources[provider].expand(request)
                            valid_result = result.provider == provider and all(
                                item.provider == provider
                                and item.source_work_id == parent
                                and item.direction.value in ("references", "cited-by")
                                and (
                                    value.direction.value == "both"
                                    or item.direction == value.direction
                                )
                                for item in result.observations
                            )
                            if not valid_result:
                                progress.failed(
                                    provider,
                                    FailureEvidence(
                                        code="provider-invalid-response",
                                        reason=Reason(
                                            value=f"{provider} citation response was invalid"
                                        ),
                                        action=Action(
                                            value="Check the citation provider response."
                                        ),
                                        retryable=False,
                                    ),
                                )
                                continue
                            observations = tuple(
                                sorted(
                                    set(result.observations),
                                    key=lambda item: (
                                        item.target_identifier.namespace,
                                        item.target_identifier.value,
                                        item.direction.value,
                                    ),
                                )
                            )
                        except KeyboardInterrupt:
                            progress.failed(
                                provider,
                                FailureEvidence(
                                    code="interrupted",
                                    reason=Reason(value="citation collection was interrupted"),
                                    action=Action(value="Rerun citation collection to resume."),
                                    retryable=True,
                                ),
                            )
                            raise
                        except (OSError, TimeoutError):
                            progress.failed(
                                provider,
                                FailureEvidence(
                                    code="provider-unavailable",
                                    reason=Reason(value=f"{provider} citation provider failed"),
                                    action=Action(value="Retry the citation provider."),
                                    retryable=True,
                                ),
                            )
                            continue
                        except Exception:  # noqa: BLE001
                            progress.failed(
                                provider,
                                FailureEvidence(
                                    code="provider-execution-failed",
                                    reason=Reason(
                                        value=f"{provider} citation provider execution failed"
                                    ),
                                    action=Action(value="Inspect the citation adapter and retry."),
                                    retryable=True,
                                ),
                            )
                            continue
                        if result.failure is not None:
                            progress.failed(provider, result.failure)
                        progress.discovered(provider, len(observations))
                        for ordinal, observation in enumerate(observations):
                            prepared = self._dependencies.bibliography.prepare_discovery(
                                BibliographicObservation(
                                    provider=provider,
                                    provider_record_id=f"citation:{parent}:{observation.direction.value}:{observation.target_identifier.namespace}:{observation.target_identifier.value}",
                                    source_priority=ordinal,
                                    observed_at=self._dependencies.clock(),
                                    identifiers=(observation.target_identifier,),
                                    metadata=InitialMetadata(),
                                    version_role="other",
                                ),
                            )
                            target = prepared.work_id
                            is_new = str(target) not in progress.visited
                            if is_new and progress.new_count >= value.max_new:
                                progress.missing(provider)
                                stop_reason = "max-new"
                                continue
                            full_path = parent_path + (target,)
                            membership = _membership(collection_id, target, run_id)
                            cause, citation_path = _cause_path(
                                membership,
                                run_id,
                                provider,
                                parent,
                                observation,
                                full_path,
                            )
                            try:
                                self._dependencies.publisher.publish(
                                    CollectionAcceptance(
                                        prepared,
                                        membership,
                                        (cause,),
                                        (citation_path,),
                                    )
                                )
                            except CollectionAcceptanceConflict:
                                progress.missing(provider)
                                progress.failed(
                                    provider,
                                    FailureEvidence(
                                        code="publication-conflict",
                                        reason=Reason(value="citation acceptance conflicted"),
                                        action=Action(value="Retry the citation collection."),
                                        retryable=True,
                                    ),
                                )
                                continue
                            progress.accepted(provider, target, is_new)
                            if is_new:
                                paths[str(target)] = full_path
                                next_frontier.add(str(target))
                if stop_reason == "max-new":
                    break
                if not next_frontier:
                    stop_reason = "no-new"
                    break
                frontier = tuple(WorkId(item) for item in sorted(next_frontier))
            status = (
                CollectionRunStatus.PARTIAL if progress.failures else CollectionRunStatus.COMPLETED
            )
            return finalizer.finish(progress.command(status, stop_reason))
        except KeyboardInterrupt:
            if not finalizer.attempted:
                finalizer.finish(
                    progress.command(
                        CollectionRunStatus.INTERRUPTED,
                        "interrupted",
                        current_provider,
                    )
                )
            raise
        except Exception:  # noqa: BLE001
            if not finalizer.attempted:
                if current_provider is not None and current_provider not in progress.failures:
                    progress.failed(
                        current_provider,
                        FailureEvidence(
                            code="execution-failed",
                            reason=Reason(value="citation execution failed"),
                            action=Action(value="Inspect collection state and retry."),
                            retryable=True,
                        ),
                    )
                finalizer.finish(
                    progress.command(
                        CollectionRunStatus.FAILED,
                        "execution-failed",
                    )
                )
            raise


__all__ = ("CitationExecutionDependencies", "CitationRunExecutor", "CitationSource")
