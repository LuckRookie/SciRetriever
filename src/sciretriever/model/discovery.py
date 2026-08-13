"""Immutable contracts for bounded metadata discovery.

The discovery models are deliberately small.  They describe the input and the
durable facts produced by an Entry operation, but do not execute providers,
persist anything, or retain provider request state.  In particular, cursors,
pages, raw responses, and the complete discovery path belong to the provider
adapter and Entry's short-lived execution state, not to these models.
"""

from __future__ import annotations

import unicodedata
from typing import Annotated, Literal, TypeAlias, TypeVar

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sciretriever.model.primitives import (
    DiscoveryRunId,
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    UtcTimestamp,
)
from sciretriever.model.report import StableFailure


class _DiscoveryModel(BaseModel):
    """Frozen, closed, strict base for discovery contracts."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


def _nonblank_text(value: object, *, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    normalized = unicodedata.normalize("NFC", value.strip())
    if not normalized:
        raise ValueError(f"{field_name} must be nonblank")
    return normalized


def _as_tuple(value: object, *, field_name: str) -> tuple[object, ...]:
    if isinstance(value, tuple):
        return value
    if isinstance(value, list):
        return tuple(value)
    raise TypeError(f"{field_name} must be a list or tuple")


_T = TypeVar("_T")


def _deduplicate(values: tuple[_T, ...]) -> tuple[_T, ...]:
    """Return values in first-seen order without changing their meaning."""

    result: list[_T] = []
    for value in values:
        if value not in result:
            result.append(value)
    return tuple(result)


def _validate_provider_limits(
    providers: tuple["ProviderDiscoveryLimit", ...],
) -> tuple["ProviderDiscoveryLimit", ...]:
    if not providers:
        raise ValueError("providers must be non-empty")
    names = tuple(provider.provider_name for provider in providers)
    if len(names) != len(set(names)):
        raise ValueError("providers must have unique provider names")
    return providers


class ProviderDiscoveryLimit(_DiscoveryModel):
    """One provider's raw-item scan boundary for a complete DiscoveryRun."""

    provider_name: str
    scan_limit: int = Field(strict=True, ge=1)

    @field_validator("provider_name", mode="before")
    @classmethod
    def validate_provider_name(cls, value: object) -> str:
        return _nonblank_text(value, field_name="provider_name")


class TopicDiscoveryInput(_DiscoveryModel):
    """A bounded domain search input."""

    kind: Literal["topic"]
    query: str
    year_from: int | None = Field(default=None, strict=True, ge=1, le=9999)
    year_to: int | None = Field(default=None, strict=True, ge=1, le=9999)
    providers: tuple[ProviderDiscoveryLimit, ...]

    @field_validator("query", mode="before")
    @classmethod
    def validate_query(cls, value: object) -> str:
        return _nonblank_text(value, field_name="query")

    @field_validator("providers", mode="before")
    @classmethod
    def normalize_providers(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="providers")

    @field_validator("providers")
    @classmethod
    def validate_providers(
        cls,
        value: tuple[ProviderDiscoveryLimit, ...],
    ) -> tuple[ProviderDiscoveryLimit, ...]:
        return _validate_provider_limits(value)

    @model_validator(mode="after")
    def validate_year_range(self) -> "TopicDiscoveryInput":
        if (
            self.year_from is not None
            and self.year_to is not None
            and self.year_from > self.year_to
        ):
            raise ValueError("year_from must not be later than year_to")
        return self


class CitationDiscoveryInput(_DiscoveryModel):
    """A bounded citation expansion input."""

    kind: Literal["citation"]
    seed_literature_ids: tuple[LiteratureId, ...]
    direction: Literal["references", "cited-by", "both"]
    max_depth: int = Field(strict=True, ge=0)
    result_limit: int = Field(strict=True, ge=1)
    providers: tuple[ProviderDiscoveryLimit, ...]

    @field_validator("seed_literature_ids", mode="before")
    @classmethod
    def normalize_seeds(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="seed_literature_ids")

    @field_validator("seed_literature_ids")
    @classmethod
    def validate_seeds(cls, value: tuple[LiteratureId, ...]) -> tuple[LiteratureId, ...]:
        if not value:
            raise ValueError("seed_literature_ids must be non-empty")
        return _deduplicate(value)

    @field_validator("providers", mode="before")
    @classmethod
    def normalize_providers(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="providers")

    @field_validator("providers")
    @classmethod
    def validate_providers(
        cls,
        value: tuple[ProviderDiscoveryLimit, ...],
    ) -> tuple[ProviderDiscoveryLimit, ...]:
        return _validate_provider_limits(value)


DiscoveryInput: TypeAlias = Annotated[
    TopicDiscoveryInput | CitationDiscoveryInput,
    Field(discriminator="kind"),
]

DiscoveryRunStatus: TypeAlias = Literal[
    "RUNNING",
    "COMPLETED",
    "PARTIAL",
    "FAILED",
    "INTERRUPTED",
]


class DiscoveryRun(_DiscoveryModel):
    """The durable identity, input, state, and start time of one discovery."""

    discovery_run_id: DiscoveryRunId
    input: DiscoveryInput
    status: DiscoveryRunStatus
    started_at: UtcTimestamp


DiscoverySourceOutcome: TypeAlias = Literal[
    "EXHAUSTED",
    "SCAN_LIMIT_REACHED",
    "FAILED",
]


class DiscoverySourceResult(_DiscoveryModel):
    """The minimal durable terminal fact for one provider in one run."""

    discovery_run_id: DiscoveryRunId
    provider_name: str
    outcome: DiscoverySourceOutcome
    failure: StableFailure | None = None

    @field_validator("provider_name", mode="before")
    @classmethod
    def validate_provider_name(cls, value: object) -> str:
        return _nonblank_text(value, field_name="provider_name")

    @model_validator(mode="after")
    def validate_failure_pairing(self) -> "DiscoverySourceResult":
        is_failed = self.outcome == "FAILED"
        if is_failed != (self.failure is not None):
            raise ValueError("failure is required only when source outcome is FAILED")
        return self


class DiscoveryResult(_DiscoveryModel):
    """One result, naturally unique by run and MetaLiterature identity."""

    discovery_run_id: DiscoveryRunId
    meta_literature_id: MetaLiteratureId


class TopicDiscoveryCause(_DiscoveryModel):
    """The observation that caused a result to enter a topic discovery."""

    kind: Literal["topic"]
    discovery_run_id: DiscoveryRunId
    meta_literature_id: MetaLiteratureId
    metadata_observation_id: ObservationId


class CitationDiscoveryCause(_DiscoveryModel):
    """A direct, bounded citation edge that caused a discovery result."""

    kind: Literal["citation"]
    discovery_run_id: DiscoveryRunId
    meta_literature_id: MetaLiteratureId
    source_literature_id: LiteratureId
    target_literature_id: LiteratureId
    depth: int = Field(strict=True, ge=1)

    @model_validator(mode="after")
    def reject_self_edge(self) -> "CitationDiscoveryCause":
        if self.source_literature_id == self.target_literature_id:
            raise ValueError("citation source and target must differ")
        return self


DiscoveryCause: TypeAlias = Annotated[
    TopicDiscoveryCause | CitationDiscoveryCause,
    Field(discriminator="kind"),
]


__all__ = (
    "CitationDiscoveryCause",
    "CitationDiscoveryInput",
    "DiscoveryCause",
    "DiscoveryInput",
    "DiscoveryResult",
    "DiscoveryRun",
    "DiscoveryRunStatus",
    "DiscoverySourceOutcome",
    "DiscoverySourceResult",
    "ProviderDiscoveryLimit",
    "TopicDiscoveryCause",
    "TopicDiscoveryInput",
)
