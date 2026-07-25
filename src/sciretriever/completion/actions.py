"""Completion stop ceilings and their executable action table."""
from __future__ import annotations
from enum import StrEnum
from typing import assert_never
from sciretriever.catalog.completion_facts import CompletionStage

class CompletionStop(StrEnum):
    METADATA = "metadata"
    ASSET = "asset"
    COMPLETE = "complete"

class CompletionAction(StrEnum):
    RESOLVE_METADATA = "resolve_metadata"
    ACQUIRE_PRIMARY = "acquire_primary"
    PROMOTE_ANALYSIS = "promote_analysis"

def _missing_actions(stage: CompletionStage) -> tuple[CompletionAction, ...]:
    match stage:
        case CompletionStage.METADATA_PENDING:
            return (CompletionAction.RESOLVE_METADATA, CompletionAction.ACQUIRE_PRIMARY, CompletionAction.PROMOTE_ANALYSIS)
        case CompletionStage.ASSET_PENDING:
            return (CompletionAction.ACQUIRE_PRIMARY, CompletionAction.PROMOTE_ANALYSIS)
        case CompletionStage.ANALYSIS_PENDING:
            return (CompletionAction.PROMOTE_ANALYSIS,)
        case CompletionStage.COMPLETE:
            return ()
        case unreachable:
            assert_never(unreachable)

def required_actions(stage: CompletionStage, stop: CompletionStop) -> tuple[CompletionAction, ...]:
    match stop:
        case CompletionStop.METADATA:
            allowed = frozenset({CompletionAction.RESOLVE_METADATA})
        case CompletionStop.ASSET:
            allowed = frozenset({CompletionAction.RESOLVE_METADATA, CompletionAction.ACQUIRE_PRIMARY})
        case CompletionStop.COMPLETE:
            allowed = frozenset(CompletionAction)
        case unreachable:
            assert_never(unreachable)
    return tuple(action for action in _missing_actions(stage) if action in allowed)

__all__ = ("CompletionAction", "CompletionStop", "required_actions")
