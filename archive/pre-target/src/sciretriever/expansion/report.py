from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Iterator, TypeAlias

from sciretriever.completion.counts import InvocationCounts, JsonCountObject
from sciretriever.core.ids import validate_uuid
from sciretriever.integrations.graph import GraphIdentifier

JsonValue: TypeAlias = str | int | bool | None | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]


class ExpansionReportError(ValueError):
    pass


@dataclass(frozen=True, slots=True, order=True)
class FrontierNode:
    work_id: str
    work_version_id: str
    identifier: GraphIdentifier

    def __post_init__(self) -> None:
        validate_uuid(self.work_id, "work_id")
        validate_uuid(self.work_version_id, "work_version_id")


class ExpansionItemStatus(StrEnum):
    COMPLETE = "complete"
    INCOMPLETE = "incomplete"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


@dataclass(frozen=True, slots=True)
class ExpansionItem:
    node: FrontierNode
    status: ExpansionItemStatus

    def to_dict(self) -> JsonObject:
        return {
            "work_id": self.node.work_id,
            "work_version_id": self.node.work_version_id,
            "identifier": {
                "namespace": self.node.identifier.namespace.value,
                "value": self.node.identifier.value,
            },
            "status": self.status.value,
        }


@dataclass(frozen=True, slots=True)
class ExpansionLayerResult:
    items: tuple[ExpansionItem, ...]
    counts: InvocationCounts

    def __post_init__(self) -> None:
        if len(self.items) != self.counts.selected:
            raise ExpansionReportError("layer items must equal selected count")
        completed = sum(item.status is ExpansionItemStatus.COMPLETE for item in self.items)
        if completed != self.counts.succeeded:
            raise ExpansionReportError("layer COMPLETE items must equal succeeded count")

    def __iter__(self) -> Iterator[ExpansionItem]:
        return iter(self.items)


@dataclass(frozen=True, slots=True)
class ExpansionLayerCounts:
    provider_returned: int
    deduplicated_works: int
    created: int
    reused: int
    discovered: int
    existing: int
    completion: InvocationCounts
    completed: int

    def __post_init__(self) -> None:
        values = (
            self.provider_returned, self.deduplicated_works, self.created,
            self.reused, self.discovered, self.existing, self.completed,
        )
        if any(value < 0 for value in values):
            raise ExpansionReportError("layer counts cannot be negative")
        if self.created + self.reused != self.discovered:
            raise ExpansionReportError("created plus reused must equal discovered")
        if self.existing > self.discovered:
            raise ExpansionReportError("existing cannot exceed discovered")
        if self.completed != self.completion.succeeded:
            raise ExpansionReportError("completed must equal COMPLETE succeeded subset")

    @property
    def selected(self) -> int:
        return self.completion.selected

    @property
    def unique_targets(self) -> int:
        return self.completion.unique_targets

    @property
    def succeeded(self) -> int:
        return self.completion.succeeded

    @property
    def exhausted(self) -> int:
        return self.completion.exhausted

    @property
    def failed(self) -> int:
        return self.completion.failed

    @property
    def duplicates(self) -> int:
        return self.completion.duplicates

    @property
    def interrupted(self) -> int:
        return self.completion.interrupted

    def to_dict(self) -> JsonCountObject:
        return {
            "provider_returned": self.provider_returned,
            "deduplicated_works": self.deduplicated_works,
            "created": self.created,
            "reused": self.reused,
            "discovered": self.discovered,
            "existing": self.existing,
            "selected": self.selected,
            "unique_targets": self.unique_targets,
            "succeeded": self.succeeded,
            "completed": self.completed,
            "exhausted": self.exhausted,
            "failed": self.failed,
            "duplicates": self.duplicates,
            "interrupted": self.interrupted,
            "analysis_succeeded": self.completion.analysis_succeeded,
            "analysis_failed": self.completion.analysis_failed,
        }


@dataclass(frozen=True, slots=True)
class ExpansionLayer:
    depth: int
    items: tuple[ExpansionItem, ...]
    counts: ExpansionLayerCounts
    failed_providers: tuple[str, ...] = ()

    def to_dict(self) -> JsonObject:
        return {
            "depth": self.depth,
            "counts": {key: value for key, value in self.counts.to_dict().items()},
            "items": [item.to_dict() for item in self.items],
            "diagnostics": [
                {"provider": provider, "reason": "provider_failed"}
                for provider in self.failed_providers
            ],
        }


__all__ = (
    "ExpansionItem", "ExpansionItemStatus", "ExpansionLayer", "ExpansionLayerCounts",
    "ExpansionLayerResult", "ExpansionReportError", "FrontierNode",
)
