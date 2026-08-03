from __future__ import annotations

from uuid import uuid4

from sciretriever.core.collection import (
    CollectionRuleError,
    validate_citation_collection_request,
    validate_collection_acceptance,
    validate_existing_collection_acceptance,
    validated_citation_run_input,
)
from sciretriever.model.collection import (
    CitationCollectionRequest,
    CitationRunInput,
    CollectionAcceptance,
    CollectionRunRecord,
    StartCollectionRun,
)
from sciretriever.model.execution import Action, FailureEvidence, Reason
from sciretriever.model.literature import BibliographicObservation, InitialMetadata
from sciretriever.model.primitives import (
    CollectionId,
    CollectionRunId,
    CollectionRunStatus,
    WorkId,
    WorkVersionState,
)
from sciretriever.model.sources import CitationDiscoveryRequest

from .citation_evidence import citation_evidence, membership, seed_acceptance
from .citation_progress import CitationProgress
from .citation_source import discover_source
from .errors import CollectionAcceptanceConflict
from .membership import existing_work_ids
from .ports import CollectionUseCaseDependencies
from .run_finalization import CollectionRunFinalizer
from .seed_resolution import resolve_citation_input


class CitationCollectionUseCase:
    def __init__(self, dependencies: CollectionUseCaseDependencies) -> None:
        self._dependencies = dependencies

    def execute(  # noqa: C901
        self,
        collection_id: CollectionId,
        request: CitationCollectionRequest,
        requested_advance_to: WorkVersionState,
    ) -> CollectionRunRecord:
        validate_citation_collection_request(request)
        if self._dependencies.repository.get_definition(collection_id) is None:
            raise CollectionRuleError.for_field("collection_id", "must identify a collection")
        configured = tuple(item.name for item in self._dependencies.citation_sources)
        if any(item not in configured for item in request.providers):
            raise CollectionRuleError.for_field(
                "providers", "must name configured citation sources"
            )
        resolved = resolve_citation_input(
            request,
            self._dependencies.literature,
            self._dependencies.repository,
        )
        existing = existing_work_ids(self._dependencies.repository, collection_id)
        run_id = CollectionRunId(str(uuid4()))
        self._dependencies.repository.start_run(
            StartCollectionRun(
                run_id=run_id,
                collection_id=collection_id,
                mode="citation",
                topic_conditions=None,
                citation_input=validated_citation_run_input(resolved),
                requested_advance_to=requested_advance_to.value,
            )
        )
        return CitationRunExecutor(self._dependencies).execute(
            run_id, collection_id, resolved, existing
        )


class CitationRunExecutor:
    def __init__(self, dependencies: CollectionUseCaseDependencies) -> None:
        self._dependencies = dependencies

    def execute(  # noqa: C901
        self,
        run_id: CollectionRunId,
        collection_id: CollectionId,
        value: CitationRunInput,
        existing_members: set[str],
    ) -> CollectionRunRecord:
        sources = {item.name: item for item in self._dependencies.citation_sources}
        frontier = value.resolved_work_ids
        progress = CitationProgress(run_id, value.providers, frontier, existing_members)
        finalizer = CollectionRunFinalizer(self._dependencies.repository)
        paths: dict[str, tuple[WorkId, ...]] = {str(item): (item,) for item in frontier}
        stop_reason = "depth-limit"
        current_provider: str | None = None
        try:
            self._publish_seeds(collection_id, run_id, frontier)
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
                        observations = discover_source(
                            sources[provider], provider, request, value.direction, progress
                        )
                        for observation in observations:
                            try:
                                prepared = self._dependencies.literature.prepare_discovery(
                                    BibliographicObservation(
                                        provider=provider,
                                        provider_record_id=(
                                            f"citation:{parent}:{observation.direction.value}:"
                                            f"{observation.target_identifier.namespace}:"
                                            f"{observation.target_identifier.value}"
                                        ),
                                        source_priority=0,
                                        observed_at=self._dependencies.clock(),
                                        identifiers=(observation.target_identifier,),
                                        metadata=InitialMetadata(),
                                        version_role="other",
                                    )
                                )
                                target = prepared.work_id
                                is_new = str(target) not in progress.visited
                                if is_new and progress.new_count >= value.max_new:
                                    progress.missing(provider)
                                    stop_reason = "max-new"
                                    continue
                                full_path = parent_path + (target,)
                                target_membership = membership(collection_id, target, run_id)
                                cause, path = citation_evidence(
                                    target_membership,
                                    run_id,
                                    provider,
                                    parent,
                                    observation,
                                    full_path,
                                )
                                try:
                                    acceptance = CollectionAcceptance(
                                        bibliography=prepared,
                                        membership=target_membership,
                                        causes=(cause,),
                                        paths=(path,),
                                    )
                                    validate_collection_acceptance(acceptance)
                                    self._dependencies.publisher.publish(acceptance)
                                except CollectionAcceptanceConflict:
                                    progress.missing(provider)
                                    progress.failed(provider, _publication_failure())
                                    continue
                            except KeyboardInterrupt:
                                progress.missing(provider)
                                raise
                            except Exception:  # noqa: BLE001  # noqa: BROAD_EXCEPT_OK
                                progress.missing(provider)
                                raise
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
                        CollectionRunStatus.INTERRUPTED, "interrupted", current_provider
                    )
                )
            raise
        except Exception:  # noqa: BLE001  # noqa: BROAD_EXCEPT_OK
            if not finalizer.attempted:
                if current_provider is not None and current_provider not in progress.failures:
                    progress.failed(current_provider, _execution_failure())
                finalizer.finish(progress.command(CollectionRunStatus.FAILED, "execution-failed"))
            raise

    def _publish_seeds(
        self,
        collection_id: CollectionId,
        run_id: CollectionRunId,
        seeds: tuple[WorkId, ...],
    ) -> None:
        for seed in seeds:
            acceptance = seed_acceptance(collection_id, run_id, seed)
            validate_existing_collection_acceptance(acceptance)
            self._dependencies.publisher.publish_existing(acceptance)


def _publication_failure() -> FailureEvidence:
    return FailureEvidence(
        code="publication-conflict",
        reason=Reason(value="citation acceptance conflicted"),
        action=Action(value="Retry the citation collection."),
        retryable=True,
    )


def _execution_failure() -> FailureEvidence:
    return FailureEvidence(
        code="execution-failed",
        reason=Reason(value="citation execution failed"),
        action=Action(value="Inspect collection state and retry."),
        retryable=True,
    )


__all__ = ("CitationCollectionUseCase", "CitationRunExecutor")
