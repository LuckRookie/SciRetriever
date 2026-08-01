from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol
from sciretriever.catalog.completion_facts import CompletionStage
from sciretriever.errors import SciRetrieverError

from .actions import CompletionStop
from .batch import BatchItemResult, BatchItemStatus, BatchPolicy, BatchResult, JsonObject
from .operations import ForceAnalysisRequest, ForceAnalysisResult
from .outcomes import OutcomeReason
from .pipeline import CompletionInvariantError, CompletionPipeline, MetadataUnavailableResult
from .targets import CompletionTarget, WorkVersionTarget


class DocumentStartPacer(Protocol):
    async def wait(self, applicable_interval: float = 0.0) -> float: ...


async def run_completion_batch(
    pipeline: CompletionPipeline,
    targets: Sequence[CompletionTarget],
    stop: CompletionStop,
    *,
    policy: BatchPolicy = BatchPolicy(),
    start_pacer: DocumentStartPacer | None = None,
) -> BatchResult:
    items: list[BatchItemResult] = []
    first_by_version: dict[str, int] = {}
    for index, target in enumerate(targets):
        work_version_id: str | None = None
        final_stage = None
        try:
            resolved = pipeline.resolve_target(target, stop)
            if isinstance(resolved, MetadataUnavailableResult):
                items.append(BatchItemResult.exhausted(target))
                continue
            work_version_id, initial = resolved
            final_stage = initial.stage
            previous = first_by_version.get(work_version_id)
            if previous is not None:
                items.append(BatchItemResult.duplicate(target, work_version_id, previous))
                continue
            first_by_version[work_version_id] = index
            if initial.stage is not CompletionStage.COMPLETE and start_pacer is not None:
                await start_pacer.wait()
            result = await pipeline.ensure_resolved(target, stop, work_version_id, initial)
            if result.reached_stop:
                items.append(BatchItemResult.succeeded(target, work_version_id,
                                                       result.final_stage, result))
            else:
                items.append(BatchItemResult.exhausted(target, work_version_id,
                                                       result.final_stage, result))
        except KeyboardInterrupt:
            items.extend(BatchItemResult.interrupted(value) for value in targets[index:])
            break
        except CompletionInvariantError:
            raise
        except (OSError, RuntimeError, SciRetrieverError):
            if work_version_id is not None:
                final_stage = pipeline.services.facts.get(work_version_id).stage
            items.append(BatchItemResult.failed(
                target, OutcomeReason.UNEXPECTED_FAILURE, work_version_id, final_stage,
            ))
    return BatchResult(policy, tuple(items))


@dataclass(frozen=True, slots=True)
class ForceAnalysisBatchItem:
    target: WorkVersionTarget
    status: BatchItemStatus
    result: ForceAnalysisResult | None = None
    reason: OutcomeReason | None = None
    duplicate_of: int | None = None

    def to_dict(self) -> JsonObject:
        return {
            "target": self.target.to_dict(),
            "status": self.status.value,
            "result": None if self.result is None else self.result.to_dict(),
            "reason": None if self.reason is None else self.reason.value,
            "duplicate_of": self.duplicate_of,
        }


@dataclass(frozen=True, slots=True)
class ForceAnalysisBatchResult:
    items: tuple[ForceAnalysisBatchItem, ...]

    @property
    def failed(self) -> int:
        return sum(item.status is BatchItemStatus.FAILED for item in self.items)

    @property
    def interrupted(self) -> bool:
        return any(item.status is BatchItemStatus.INTERRUPTED for item in self.items)

    def to_dict(self) -> JsonObject:
        return {
            "items": [item.to_dict() for item in self.items],
            "failed": self.failed,
            "interrupted": self.interrupted,
        }


def run_force_analysis_batch(
    pipeline: CompletionPipeline,
    targets: Sequence[WorkVersionTarget],
) -> ForceAnalysisBatchResult:
    items: list[ForceAnalysisBatchItem] = []
    first_by_version: dict[str, int] = {}
    for index, target in enumerate(targets):
        previous = first_by_version.get(target.work_version_id)
        if previous is not None:
            items.append(ForceAnalysisBatchItem(
                target, BatchItemStatus.DUPLICATE, duplicate_of=previous
            ))
            continue
        first_by_version[target.work_version_id] = index
        try:
            facts = pipeline.services.facts.get(target.work_version_id)
            result = pipeline.force_analysis(ForceAnalysisRequest(target, facts.current_revision))
            items.append(ForceAnalysisBatchItem(target, BatchItemStatus.SUCCEEDED, result=result))
        except KeyboardInterrupt:
            items.extend(ForceAnalysisBatchItem(
                value, BatchItemStatus.INTERRUPTED, reason=OutcomeReason.INTERRUPTED
            ) for value in targets[index:])
            break
        except CompletionInvariantError:
            raise
        except (OSError, RuntimeError, SciRetrieverError):
            items.append(ForceAnalysisBatchItem(
                target, BatchItemStatus.FAILED, reason=OutcomeReason.UNEXPECTED_FAILURE
            ))
    return ForceAnalysisBatchResult(tuple(items))


__all__ = (
    "ForceAnalysisBatchItem", "ForceAnalysisBatchResult", "run_completion_batch",
    "run_force_analysis_batch",
)
