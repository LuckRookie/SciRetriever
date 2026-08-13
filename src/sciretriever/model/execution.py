"""Process-local database-completion request models.

These models carry only the user's requested completion scope and goal.  Entry
expands a selector, freezes targets, and reports the transient result in
memory; none of that execution state belongs in this module or in the catalog.
"""

from __future__ import annotations

from typing import Annotated, Literal, TypeAlias, TypeVar

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator

from sciretriever.model.library import LibraryQuery
from sciretriever.model.primitives import (
    DiscoveryRunId,
    LiteratureId,
    MetaLiteratureId,
)

BatchGoal: TypeAlias = Literal["ASSET_READY", "CONTENT_READY"]


class _ExecutionModel(BaseModel):
    """Frozen and closed strict configuration shared by execution inputs."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


_T = TypeVar("_T")


def _as_tuple(value: object, *, field_name: str) -> tuple[object, ...]:
    if isinstance(value, tuple):
        return value
    if isinstance(value, list):
        return tuple(value)
    raise TypeError(f"{field_name} must be a list or tuple")


def _deduplicate(values: tuple[_T, ...]) -> tuple[_T, ...]:
    """Deduplicate boundary values without changing their first-seen order."""

    result: list[_T] = []
    for value in values:
        if value not in result:
            result.append(value)
    return tuple(result)


class AllPendingSelector(_ExecutionModel):
    kind: Literal["all-pending"]


class DiscoveryRunSelector(_ExecutionModel):
    kind: Literal["discovery-run"]
    discovery_run_id: DiscoveryRunId


class ImportReportSelector(_ExecutionModel):
    kind: Literal["import-report"]
    meta_literature_ids: tuple[MetaLiteratureId, ...]

    @field_validator("meta_literature_ids", mode="before")
    @classmethod
    def normalize_ids(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="meta_literature_ids")

    @field_validator("meta_literature_ids")
    @classmethod
    def validate_ids(
        cls,
        value: tuple[MetaLiteratureId, ...],
    ) -> tuple[MetaLiteratureId, ...]:
        normalized = _deduplicate(value)
        if not normalized:
            raise ValueError("meta_literature_ids must be non-empty")
        return normalized


class QuerySelector(_ExecutionModel):
    kind: Literal["query"]
    query: LibraryQuery

    @field_validator("query", mode="before")
    @classmethod
    def require_library_query(cls, value: object, info: ValidationInfo) -> object:
        # A Python caller must pass the closed query Model itself.  JSON
        # deserialization necessarily starts with a mapping; Pydantic then
        # validates that mapping as LibraryQuery during the JSON round-trip.
        if info.mode == "python" and not isinstance(value, LibraryQuery):
            raise ValueError("query must be a LibraryQuery instance")
        return value


class MetaLiteratureSelector(_ExecutionModel):
    kind: Literal["meta-literatures"]
    meta_literature_ids: tuple[MetaLiteratureId, ...]

    @field_validator("meta_literature_ids", mode="before")
    @classmethod
    def normalize_ids(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="meta_literature_ids")

    @field_validator("meta_literature_ids")
    @classmethod
    def validate_ids(
        cls,
        value: tuple[MetaLiteratureId, ...],
    ) -> tuple[MetaLiteratureId, ...]:
        normalized = _deduplicate(value)
        if not normalized:
            raise ValueError("meta_literature_ids must be non-empty")
        return normalized


class LiteratureSelector(_ExecutionModel):
    kind: Literal["literatures"]
    literature_ids: tuple[LiteratureId, ...]

    @field_validator("literature_ids", mode="before")
    @classmethod
    def normalize_ids(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="literature_ids")

    @field_validator("literature_ids")
    @classmethod
    def validate_ids(
        cls,
        value: tuple[LiteratureId, ...],
    ) -> tuple[LiteratureId, ...]:
        normalized = _deduplicate(value)
        if not normalized:
            raise ValueError("literature_ids must be non-empty")
        return normalized


BatchSelector: TypeAlias = Annotated[
    AllPendingSelector
    | DiscoveryRunSelector
    | ImportReportSelector
    | QuerySelector
    | MetaLiteratureSelector
    | LiteratureSelector,
    Field(discriminator="kind"),
]


class BatchRequest(_ExecutionModel):
    selector: BatchSelector
    goal: BatchGoal


__all__ = (
    "AllPendingSelector",
    "BatchGoal",
    "BatchRequest",
    "BatchSelector",
    "DiscoveryRunSelector",
    "ImportReportSelector",
    "LiteratureSelector",
    "MetaLiteratureSelector",
    "QuerySelector",
)
