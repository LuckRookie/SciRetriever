from __future__ import annotations

from dataclasses import dataclass
from typing import TypeAlias, assert_never

from sciretriever.catalog.completion_facts import CompletionFacts, CompletionStage
from sciretriever.discovery.search_contracts import ExactMetadataRequest, validate_provider_selection

from .actions import CompletionAction, CompletionStop, required_actions
from .operations import ForceAnalysisRequest, ForceAnalysisResult, OptionalAssetRequest, OptionalAssetResult
from .outcomes import CompletionResult, OutcomeDisposition, OutcomeReason, StageOutcome
from .protocols import (AnalysisPromotionRequest, AtomicAnalysisPromotion,
                        CompletionFactInspector, ExactMetadataResolution,
                        OptionalAssetAcquisition, RequiredPrimaryAcquisition,
                        WorkVersionIdentifierLookup)
from .targets import CompletionTarget, DoiTarget, WorkVersionTarget


_STAGE_ORDER = {stage: index for index, stage in enumerate(CompletionStage)}


class CompletionInvariantError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class MetadataUnavailableResult:
    target: DoiTarget
    requested_stop: CompletionStop
    disposition: OutcomeDisposition = OutcomeDisposition.NOT_ADVANCED
    reason: OutcomeReason = OutcomeReason.EXHAUSTED

    def to_dict(self) -> dict[str, object]:
        return {"target": self.target.to_dict(), "work_version_id": None,
                "requested_stop": self.requested_stop.value,
                "final_stage": CompletionStage.METADATA_PENDING.value,
                "disposition": self.disposition.value, "reason": self.reason.value}


EnsureCompleteResult: TypeAlias = CompletionResult | MetadataUnavailableResult
ResolvedTarget: TypeAlias = tuple[str, CompletionFacts] | MetadataUnavailableResult


@dataclass(frozen=True, slots=True)
class MetadataResolutionPolicy:
    providers: tuple[str, ...]
    precedence: tuple[str, ...]
    timeout_seconds: float = 30.0
    max_concurrency: int = 8

    def __post_init__(self) -> None:
        validate_provider_selection(self.providers, self.precedence,
                                    self.timeout_seconds, self.max_concurrency)


@dataclass(frozen=True, slots=True)
class CompletionServices:
    facts: CompletionFactInspector
    identifiers: WorkVersionIdentifierLookup
    exact_metadata: ExactMetadataResolution
    required_primary: RequiredPrimaryAcquisition
    analysis_promotion: AtomicAnalysisPromotion
    optional_assets: OptionalAssetAcquisition


class CompletionPipeline:
    def __init__(self, services: CompletionServices,
                 metadata_policy: MetadataResolutionPolicy) -> None:
        self.services = services
        self.metadata_policy = metadata_policy

    def _metadata_request(self, doi: str) -> ExactMetadataRequest:
        policy = self.metadata_policy
        return ExactMetadataRequest(doi, policy.providers, policy.precedence,
                                    policy.timeout_seconds, policy.max_concurrency)

    @staticmethod
    def _progress(before: CompletionFacts, after: CompletionFacts) -> bool:
        if _STAGE_ORDER[after.stage] < _STAGE_ORDER[before.stage]:
            raise CompletionInvariantError("completion facts regressed")
        return after != before

    async def _act(self, action: CompletionAction, before: CompletionFacts) -> tuple[StageOutcome, CompletionFacts]:
        claimed = OutcomeDisposition.ADVANCED
        reason = OutcomeReason.SUCCEEDED
        match action:
            case CompletionAction.RESOLVE_METADATA:
                doi = self.services.identifiers.doi_for(before.work_version_id)
                if doi is None:
                    claimed = OutcomeDisposition.NOT_ADVANCED
                    reason = OutcomeReason.EXHAUSTED
                else:
                    resolved = self.services.exact_metadata.resolve(self._metadata_request(doi))
                    if (resolved.result is not None
                            and resolved.result.work_version.id != before.work_version_id):
                        raise CompletionInvariantError("metadata resolved a different WorkVersion")
                    claimed = OutcomeDisposition.NOT_ADVANCED
                    reason = OutcomeReason.EXHAUSTED
            case CompletionAction.ACQUIRE_PRIMARY:
                owner = await self.services.required_primary.acquire(before.work_version_id)
                claimed, reason = owner.disposition, owner.reason
            case CompletionAction.PROMOTE_ANALYSIS:
                self.services.analysis_promotion.promote(AnalysisPromotionRequest(before.work_version_id))
            case unreachable:
                assert_never(unreachable)
        after = self.services.facts.get(before.work_version_id)
        progressed = self._progress(before, after)
        if claimed is OutcomeDisposition.ADVANCED and not progressed:
            raise CompletionInvariantError("owner reported advancement without fact progress")
        if not progressed:
            return StageOutcome(action, OutcomeDisposition.NOT_ADVANCED, reason,
                                before.stage, before.stage), after
        expected = {
            CompletionAction.RESOLVE_METADATA: CompletionStage.ASSET_PENDING,
            CompletionAction.ACQUIRE_PRIMARY: CompletionStage.ANALYSIS_PENDING,
            CompletionAction.PROMOTE_ANALYSIS: CompletionStage.COMPLETE,
        }[action]
        if _STAGE_ORDER[after.stage] < _STAGE_ORDER[expected]:
            raise CompletionInvariantError("fact progress did not satisfy the owner action")
        return StageOutcome(action, OutcomeDisposition.ADVANCED, OutcomeReason.SUCCEEDED,
                            before.stage, expected), after

    def resolve_target(self, target: CompletionTarget,
                       stop: CompletionStop) -> ResolvedTarget:
        if isinstance(target, DoiTarget):
            resolved = self.services.exact_metadata.resolve(self._metadata_request(target.doi))
            if resolved.result is None:
                return MetadataUnavailableResult(target, stop)
            work_version_id = resolved.result.work_version.id
        else:
            work_version_id = target.work_version_id
        return work_version_id, self.services.facts.get(work_version_id)

    async def ensure_resolved(self, target: CompletionTarget, stop: CompletionStop,
                              work_version_id: str,
                              initial: CompletionFacts) -> CompletionResult:
        current = initial
        outcomes: list[StageOutcome] = []
        while actions := required_actions(current.stage, stop):
            action = actions[0]
            outcome, fresh = await self._act(action, current)
            outcomes.append(outcome)
            if outcome.disposition is OutcomeDisposition.NOT_ADVANCED:
                break
            current = fresh
        return CompletionResult(target, work_version_id, stop, initial.stage,
                                current.stage, tuple(outcomes))

    async def ensure_complete(self, target: CompletionTarget,
                              stop: CompletionStop) -> EnsureCompleteResult:
        resolved = self.resolve_target(target, stop)
        if isinstance(resolved, MetadataUnavailableResult):
            return resolved
        work_version_id, initial = resolved
        return await self.ensure_resolved(target, stop, work_version_id, initial)

    def force_analysis(self, request: ForceAnalysisRequest) -> ForceAnalysisResult:
        before = self.services.facts.get(request.target.work_version_id)
        if before.stage is not CompletionStage.COMPLETE:
            raise CompletionInvariantError("force analysis requires COMPLETE facts")
        if before.current_analysis_id is None or before.current_revision != request.expected_revision:
            raise CompletionInvariantError("force analysis expectation is stale")
        promoted = self.services.analysis_promotion.promote(AnalysisPromotionRequest(
            request.target.work_version_id, before.current_analysis_id, replace_current=True))
        after = self.services.facts.get(request.target.work_version_id)
        if (after.stage is not CompletionStage.COMPLETE
                or after.current_revision != before.current_revision + 1
                or after.current_analysis_id == before.current_analysis_id
                or promoted.current_analysis_id != after.current_analysis_id
                or promoted.revision != after.current_revision):
            raise CompletionInvariantError("force analysis did not publish one replacement")
        current_analysis_id = after.current_analysis_id
        if current_analysis_id is None:
            raise CompletionInvariantError("force analysis lost the current identity")
        return ForceAnalysisResult(request, before.current_revision,
                                   after.current_revision, current_analysis_id)

    async def acquire_optional(self, request: OptionalAssetRequest) -> OptionalAssetResult:
        before = self.services.facts.get(request.target.work_version_id)
        owner = await self.services.optional_assets.acquire(request)
        after = self.services.facts.get(request.target.work_version_id)
        if after.stage is not before.stage or owner.stage_before is not before.stage:
            raise CompletionInvariantError("optional acquisition changed completion stage")
        return owner


__all__ = ("CompletionInvariantError", "CompletionPipeline", "CompletionServices",
           "EnsureCompleteResult", "MetadataResolutionPolicy", "MetadataUnavailableResult",
           "ResolvedTarget")
