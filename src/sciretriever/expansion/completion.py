from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol, assert_never

from sciretriever.catalog.completion_facts import CompletionStage
from sciretriever.completion import (
    BatchItemResult,
    BatchItemStatus,
    CompletionPipeline,
    CompletionStop,
    WorkVersionTarget,
    run_completion_batch,
)
from sciretriever.completion.runner import DocumentStartPacer
from sciretriever.diagnostics.history import DiagnosticProjection, DiagnosticWriteRequest
from sciretriever.diagnostics.product import (
    DiagnosticSubjectKind,
    ProductFailure,
    ProductFailureAction,
    ProductFailureReason,
    ProductFailureStage,
    RerunGuidance,
)

from .service import (
    ExpansionContractError,
    ExpansionItem,
    ExpansionItemStatus,
    ExpansionLayerResult,
    FrontierNode,
)


class ExpansionDiagnosticAppender(Protocol):
    def append(self, request: DiagnosticWriteRequest) -> DiagnosticProjection: ...


@dataclass(frozen=True, slots=True)
class ExpansionCompletionServices:
    pipeline: CompletionPipeline
    pacer: DocumentStartPacer
    diagnostics: ExpansionDiagnosticAppender


class PipelineLayerCompletion:
    def __init__(self, services: ExpansionCompletionServices) -> None:
        self._services = services

    async def complete_layer(
        self, nodes: Sequence[FrontierNode]
    ) -> ExpansionLayerResult:
        batch = await run_completion_batch(
            self._services.pipeline,
            tuple(WorkVersionTarget(node.work_version_id) for node in nodes),
            CompletionStop.COMPLETE,
            start_pacer=self._services.pacer,
        )
        items = tuple(
            self._item(node, outcome) for node, outcome in zip(nodes, batch.items, strict=True)
        )
        return ExpansionLayerResult(items, batch.counts)

    def _item(self, node: FrontierNode, outcome: BatchItemResult) -> ExpansionItem:
        match outcome.status:
            case BatchItemStatus.SUCCEEDED:
                if outcome.final_stage is not CompletionStage.COMPLETE:
                    raise ExpansionContractError("successful expansion completion lacks COMPLETE facts")
                return ExpansionItem(node, ExpansionItemStatus.COMPLETE)
            case BatchItemStatus.EXHAUSTED:
                status = ExpansionItemStatus.INCOMPLETE
                reason = ProductFailureReason.CONTENT
                action = ProductFailureAction.REVIEW
                rerun = RerunGuidance.AFTER_REVIEW
            case BatchItemStatus.FAILED:
                status = ExpansionItemStatus.FAILED
                reason = ProductFailureReason.PROVIDER
                action = ProductFailureAction.RETRY
                rerun = RerunGuidance.RETRY
            case BatchItemStatus.DUPLICATE:
                raise ExpansionContractError("expansion layer contains duplicate WorkVersions")
            case BatchItemStatus.INTERRUPTED:
                status = ExpansionItemStatus.INTERRUPTED
                reason = ProductFailureReason.INTERRUPTED
                action = ProductFailureAction.NONE
                rerun = RerunGuidance.RETRY
            case unreachable:
                assert_never(unreachable)
        self._services.diagnostics.append(DiagnosticWriteRequest(
            ProductFailure(
                ProductFailureStage.EXPANSION,
                DiagnosticSubjectKind.EXPANSION,
                node.work_id,
                reason,
                action,
                rerun,
            ),
            rerun is RerunGuidance.RETRY,
            {
                "work_version_id": node.work_version_id,
                "completion_status": outcome.status.value,
                "final_stage": None if outcome.final_stage is None else outcome.final_stage.value,
            },
        ))
        return ExpansionItem(node, status)


__all__ = ("ExpansionCompletionServices", "PipelineLayerCompletion")
