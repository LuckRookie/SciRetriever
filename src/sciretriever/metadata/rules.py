"""Closed, non-persistent contracts and pure rules for Metadata calls.

The values in this module describe one in-process invocation.  They are not
Catalog facts and deliberately contain no DiscoveryRun identity, acceptance or
deduplication decision, vendor payload, request/response object, page, cursor,
or score.
"""

from __future__ import annotations

import unicodedata
from typing import Literal, Protocol, TypeAlias, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sciretriever.model.discovery import DiscoverySourceOutcome
from sciretriever.model.metadata import (
    MetadataObservation,
    ProviderLiteratureKey,
    ProviderRelationObservation,
)
from sciretriever.model.report import StableFailure


class _InvocationModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


@runtime_checkable
class CancellationEvent(Protocol):
    """Process-local cancellation observed only while invoking a provider."""

    def is_set(self) -> bool: ...


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


class TopicSearchQuery(_InvocationModel):
    """The provider-neutral part of a topic discovery input."""

    query: str
    year_from: int | None = Field(default=None, strict=True, ge=1, le=9999)
    year_to: int | None = Field(default=None, strict=True, ge=1, le=9999)

    @field_validator("query", mode="before")
    @classmethod
    def normalize_query(cls, value: object) -> str:
        return _nonblank_text(value, field_name="query")

    @model_validator(mode="after")
    def validate_year_range(self) -> "TopicSearchQuery":
        if (
            self.year_from is not None
            and self.year_to is not None
            and self.year_from > self.year_to
        ):
            raise ValueError("year_from must not be later than year_to")
        return self


class MetadataLookupRequest(_InvocationModel):
    """One explicit lookup against exactly one provider capability."""

    provider_name: str
    key: ProviderLiteratureKey
    scan_limit: int = Field(strict=True, ge=1)

    @field_validator("provider_name", mode="before")
    @classmethod
    def normalize_provider_name(cls, value: object) -> str:
        return _nonblank_text(value, field_name="provider_name")


ReferenceQueryDirection: TypeAlias = Literal["references", "cited-by", "both"]


class ProviderReferenceQuery(_InvocationModel):
    """One provider's keys and run-wide raw-item boundary."""

    provider_name: str
    keys: tuple[ProviderLiteratureKey, ...]
    scan_limit: int = Field(strict=True, ge=1)

    @field_validator("provider_name", mode="before")
    @classmethod
    def normalize_provider_name(cls, value: object) -> str:
        return _nonblank_text(value, field_name="provider_name")

    @field_validator("keys", mode="before")
    @classmethod
    def normalize_keys(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="keys")

    @field_validator("keys")
    @classmethod
    def validate_keys(
        cls,
        value: tuple[ProviderLiteratureKey, ...],
    ) -> tuple[ProviderLiteratureKey, ...]:
        if not value:
            raise ValueError("keys must be non-empty")
        if len(value) != len({item.model_dump_json() for item in value}):
            raise ValueError("keys must not contain duplicates")
        return value


class MetadataReferenceQueryRequest(_InvocationModel):
    """A bounded reference call without recursion or Citation-Provider state."""

    direction: ReferenceQueryDirection
    providers: tuple[ProviderReferenceQuery, ...]

    @field_validator("providers", mode="before")
    @classmethod
    def normalize_providers(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="providers")

    @field_validator("providers")
    @classmethod
    def validate_providers(
        cls,
        value: tuple[ProviderReferenceQuery, ...],
    ) -> tuple[ProviderReferenceQuery, ...]:
        if not value:
            raise ValueError("providers must be non-empty")
        names = tuple(item.provider_name for item in value)
        if len(names) != len(set(names)):
            raise ValueError("providers must have unique provider names")
        return value


class ReferenceQueryContext(_InvocationModel):
    """Package-level neutral context passed to one reference adapter."""

    keys: tuple[ProviderLiteratureKey, ...]
    direction: ReferenceQueryDirection

    @field_validator("keys", mode="before")
    @classmethod
    def normalize_keys(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="keys")

    @field_validator("keys")
    @classmethod
    def validate_keys(
        cls,
        value: tuple[ProviderLiteratureKey, ...],
    ) -> tuple[ProviderLiteratureKey, ...]:
        if not value:
            raise ValueError("keys must be non-empty")
        return value


class NeutralMetadataItem(_InvocationModel):
    """Neutral facts produced from exactly one already-counted raw item."""

    observations: tuple[MetadataObservation, ...] = ()
    relations: tuple[ProviderRelationObservation, ...] = ()

    @field_validator("observations", "relations", mode="before")
    @classmethod
    def normalize_values(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="neutral item values")


MetadataProviderInvocationOutcome: TypeAlias = DiscoverySourceOutcome | Literal["INTERRUPTED"]


class _MetadataProviderFacts(_InvocationModel):
    provider_name: str
    observations: tuple[MetadataObservation, ...]
    relations: tuple[ProviderRelationObservation, ...]
    raw_item_count: int = Field(strict=True, ge=0)
    failure: StableFailure | None = None

    @field_validator("provider_name", mode="before")
    @classmethod
    def normalize_provider_name(cls, value: object) -> str:
        return _nonblank_text(value, field_name="provider_name")

    @field_validator("observations", "relations", mode="before")
    @classmethod
    def normalize_values(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="provider result values")


class MetadataProviderInvocation(_MetadataProviderFacts):
    """Short-lived result of one bounded, optionally cancellable provider call.

    ``INTERRUPTED`` is deliberately confined to this in-process result.  It is
    not a durable discovery source outcome and carries no resumable provider
    state.  Neutral facts converted before cancellation remain available to
    the caller.
    """

    outcome: MetadataProviderInvocationOutcome

    @model_validator(mode="after")
    def validate_failure_pairing(self) -> "MetadataProviderInvocation":
        is_failed = self.outcome == "FAILED"
        if is_failed != (self.failure is not None):
            raise ValueError("failure is required only when provider outcome is FAILED")
        return self


class MetadataProviderResult(_MetadataProviderFacts):
    """Completed provider result retained by the original batch surfaces."""

    outcome: DiscoverySourceOutcome

    @model_validator(mode="after")
    def validate_failure_pairing(self) -> "MetadataProviderResult":
        is_failed = self.outcome == "FAILED"
        if is_failed != (self.failure is not None):
            raise ValueError("failure is required only when provider outcome is FAILED")
        return self


class MetadataBatchResult(_InvocationModel):
    """Provider results in the exact order requested by the caller."""

    providers: tuple[MetadataProviderResult, ...]

    @field_validator("providers", mode="before")
    @classmethod
    def normalize_providers(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="providers")

    @field_validator("providers")
    @classmethod
    def validate_providers(
        cls,
        value: tuple[MetadataProviderResult, ...],
    ) -> tuple[MetadataProviderResult, ...]:
        if not value:
            raise ValueError("providers must be non-empty")
        names = tuple(item.provider_name for item in value)
        if len(names) != len(set(names)):
            raise ValueError("providers must have unique provider names")
        return value


def relation_matches_query(
    relation: ProviderRelationObservation,
    query: ReferenceQueryContext,
) -> bool:
    """Return whether a canonical citing-to-cited edge matches the query direction."""

    if query.direction == "references":
        return any(_keys_overlap(key, relation.citing) for key in query.keys)
    if query.direction == "cited-by":
        return any(_keys_overlap(key, relation.cited) for key in query.keys)
    return any(
        _keys_overlap(key, relation.citing) or _keys_overlap(key, relation.cited)
        for key in query.keys
    )


def _keys_overlap(left: ProviderLiteratureKey, right: ProviderLiteratureKey) -> bool:
    if (
        left.record_id is not None
        and right.record_id is not None
        and left.record_id == right.record_id
    ):
        return True
    return any(identifier in right.identifiers for identifier in left.identifiers)


def _pagination_loop_failure() -> StableFailure:
    return StableFailure(
        code="metadata-pagination-loop",
        reason="The metadata provider pagination did not make progress.",
        action="Retry the request or update the provider adapter.",
        retryable=True,
    )


def _provider_protocol_failure() -> StableFailure:
    return StableFailure(
        code="metadata-provider-protocol",
        reason="The metadata provider returned an inconsistent page boundary.",
        action="Retry the request or update the provider adapter.",
        retryable=True,
    )


def _reference_direction_failure() -> StableFailure:
    return StableFailure(
        code="metadata-reference-direction",
        reason="The metadata provider returned an inconsistent citation direction.",
        action="Update the provider adapter before retrying this capability.",
        retryable=False,
    )


__all__ = (
    "CancellationEvent",
    "MetadataBatchResult",
    "MetadataLookupRequest",
    "MetadataProviderInvocation",
    "MetadataProviderInvocationOutcome",
    "MetadataProviderResult",
    "MetadataReferenceQueryRequest",
    "NeutralMetadataItem",
    "ProviderReferenceQuery",
    "ReferenceQueryContext",
    "ReferenceQueryDirection",
    "TopicSearchQuery",
)
