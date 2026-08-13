"""Immutable query inputs and read projections for the local literature library.

The models in this module describe the boundary between a local read-only
query and the Literature/Storage modules.  They deliberately do not know how
to match a query, encode a cursor, open an artifact, or derive a Literature's
status.  Those decisions belong to the owning feature modules and their
adapters.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Literal, TypeAlias, TypeVar

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sciretriever.model.acquisition import Asset, LiteratureAsset
from sciretriever.model.analysis import LiteratureContent
from sciretriever.model.literature import (
    Identifier,
    Literature,
    LiteratureStatus,
    MetaLiterature,
    Reference,
    ReferenceSupport,
    VersionRole,
)
from sciretriever.model.metadata import MetadataObservation
from sciretriever.model.parsing import ParserResult
from sciretriever.model.primitives import (
    DiscoveryRunId,
    LiteratureId,
    Sha256,
)


class _LibraryModel(BaseModel):
    """Frozen and closed configuration shared by query-side projections."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


_T = TypeVar("_T")
_ORCID = re.compile(r"^\d{4}-\d{4}-\d{4}-[0-9X]{4}$")


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


def _deduplicate(values: tuple[_T, ...]) -> tuple[_T, ...]:
    """Remove repeated boundary values without changing caller order."""

    result: list[_T] = []
    for value in values:
        if value not in result:
            result.append(value)
    return tuple(result)


def _normalize_text_values(value: object, *, field_name: str) -> tuple[str, ...]:
    values = _as_tuple(value, field_name=field_name)
    return _deduplicate(tuple(_nonblank_text(item, field_name=field_name[:-1]) for item in values))


def _normalize_orcid(value: object) -> str:
    normalized = _nonblank_text(value, field_name="author_orcid").upper()
    if _ORCID.fullmatch(normalized) is None:
        raise ValueError("author_orcid must be a bare hyphenated ORCID")
    digits = normalized.replace("-", "")
    total = 0
    for digit in digits[:-1]:
        total = (total + int(digit)) * 2
    remainder = total % 11
    check = (12 - remainder) % 11
    expected = "X" if check == 10 else str(check)
    if digits[-1] != expected:
        raise ValueError("author_orcid has an invalid check digit")
    return normalized


def _normalize_enum_values(
    value: object,
    enum_type: type[VersionRole] | type[LiteratureStatus],
    *,
    field_name: str,
) -> tuple[VersionRole, ...] | tuple[LiteratureStatus, ...]:
    values = _as_tuple(value, field_name=field_name)
    normalized: list[VersionRole | LiteratureStatus] = []
    for item in values:
        if isinstance(item, enum_type):
            normalized.append(item)
            continue
        if not isinstance(item, str):
            raise TypeError(f"{field_name} must contain supported values")
        try:
            normalized.append(enum_type(item.strip()))
        except ValueError as error:
            raise ValueError(f"{field_name} must contain supported values") from error
    return _deduplicate(tuple(normalized))  # type: ignore[return-value]


LiteratureMissingStep: TypeAlias = Literal[
    "primary-pdf",
    "parser-result",
    "literature-content",
]

LibrarySort: TypeAlias = Literal[
    "publication-year-desc",
    "publication-year-asc",
    "title-asc",
    "title-desc",
    "relevance",
]

ReferenceDirection: TypeAlias = Literal["references", "cited-by"]


class LibraryQuery(_LibraryModel):
    """Closed local-database filters; matching semantics live in Literature."""

    text: str | None = None
    title: str | None = None
    author: str | None = None
    author_orcids: tuple[str, ...] = ()
    identifiers: tuple[Identifier, ...] = ()

    publication_year_from: int | None = Field(default=None, strict=True, ge=1, le=9999)
    publication_year_to: int | None = Field(default=None, strict=True, ge=1, le=9999)
    venue: str | None = None
    publisher: str | None = None
    document_types: tuple[str, ...] = ()
    languages: tuple[str, ...] = ()
    keywords: tuple[str, ...] = ()

    version_roles: tuple[VersionRole, ...] = ()
    statuses: tuple[LiteratureStatus, ...] = ()
    missing_steps: tuple[LiteratureMissingStep, ...] = ()
    needs_manual_pdf: bool | None = None

    discovery_run_ids: tuple[DiscoveryRunId, ...] = ()

    @field_validator("text", "title", "author", "venue", "publisher", mode="before")
    @classmethod
    def normalize_optional_text(cls, value: object, info: object) -> str | None:
        if value is None:
            return None
        return _nonblank_text(value, field_name="query text")

    @field_validator("author_orcids", mode="before")
    @classmethod
    def normalize_author_orcids(cls, value: object) -> tuple[str, ...]:
        values = _as_tuple(value, field_name="author_orcids")
        return _deduplicate(tuple(_normalize_orcid(item) for item in values))

    @field_validator("identifiers", mode="before")
    @classmethod
    def normalize_identifiers(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="identifiers")

    @field_validator("identifiers")
    @classmethod
    def deduplicate_identifiers(cls, value: tuple[Identifier, ...]) -> tuple[Identifier, ...]:
        return _deduplicate(value)

    @field_validator("document_types", "languages", "keywords", mode="before")
    @classmethod
    def normalize_text_collections(cls, value: object, info: object) -> tuple[str, ...]:
        return _normalize_text_values(value, field_name="query values")

    @field_validator("version_roles", mode="before")
    @classmethod
    def normalize_version_roles(cls, value: object) -> tuple[VersionRole, ...]:
        normalized = _normalize_enum_values(
            value,
            VersionRole,
            field_name="version_roles",
        )
        return normalized  # type: ignore[return-value]

    @field_validator("statuses", mode="before")
    @classmethod
    def normalize_statuses(cls, value: object) -> tuple[LiteratureStatus, ...]:
        normalized = _normalize_enum_values(
            value,
            LiteratureStatus,
            field_name="statuses",
        )
        return normalized  # type: ignore[return-value]

    @field_validator("missing_steps", mode="before")
    @classmethod
    def normalize_missing_steps(cls, value: object) -> tuple[LiteratureMissingStep, ...]:
        values = _as_tuple(value, field_name="missing_steps")
        supported = {"primary-pdf", "parser-result", "literature-content"}
        normalized: list[str] = []
        for item in values:
            candidate = _nonblank_text(item, field_name="missing_step")
            if candidate not in supported:
                raise ValueError("missing_steps must contain supported values")
            normalized.append(candidate)
        return _deduplicate(tuple(normalized))  # type: ignore[return-value]

    @field_validator("discovery_run_ids", mode="before")
    @classmethod
    def normalize_discovery_run_ids(cls, value: object) -> tuple[DiscoveryRunId, ...]:
        values = _as_tuple(value, field_name="discovery_run_ids")
        normalized_values: list[DiscoveryRunId] = []
        for item in values:
            if isinstance(item, DiscoveryRunId):
                normalized_values.append(item)
            elif isinstance(item, str):
                normalized_values.append(DiscoveryRunId(item))
            else:
                raise TypeError("discovery_run_ids must contain DiscoveryRunId values")
        normalized = tuple(normalized_values)
        return _deduplicate(normalized)

    @model_validator(mode="after")
    def validate_year_range(self) -> "LibraryQuery":
        if (
            self.publication_year_from is not None
            and self.publication_year_to is not None
            and self.publication_year_from > self.publication_year_to
        ):
            raise ValueError("publication_year_from must not exceed publication_year_to")
        return self


class LibrarySearchRequest(_LibraryModel):
    """One local search request, including presentation and pagination inputs."""

    query: LibraryQuery
    sort: LibrarySort = "publication-year-desc"
    limit: int = Field(default=50, strict=True, ge=1)
    cursor: str | None = None

    @field_validator("cursor", mode="before")
    @classmethod
    def validate_cursor(cls, value: object) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str) or not value.strip():
            raise ValueError("cursor must be a nonblank opaque string")
        # A cursor is intentionally opaque.  Preserve its exact bytes rather
        # than trimming or attempting to decode it at this Model boundary.
        return value

    @model_validator(mode="after")
    def validate_relevance_query(self) -> "LibrarySearchRequest":
        if self.sort == "relevance" and self.query.text is None:
            raise ValueError("relevance sort requires a nonblank query text")
        return self


class LiteratureSearchItem(_LibraryModel):
    """A read-only item for one concrete Literature version."""

    literature: Literature
    metadata_revision: int = Field(strict=True, ge=1)
    metadata_sha256: Sha256
    missing_step: LiteratureMissingStep | None = None
    needs_manual_pdf: bool


class LibrarySearchPage(_LibraryModel):
    """A transient immutable page of concrete Literature search items."""

    items: tuple[LiteratureSearchItem, ...]
    total_count: int = Field(strict=True, ge=0)
    next_cursor: str | None = None

    @field_validator("items", mode="before")
    @classmethod
    def normalize_items(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="items")

    @field_validator("next_cursor", mode="before")
    @classmethod
    def validate_next_cursor(cls, value: object) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str) or not value.strip():
            raise ValueError("next_cursor must be a nonblank opaque string")
        return value

    @model_validator(mode="after")
    def reject_duplicate_items(self) -> "LibrarySearchPage":
        ids = tuple(item.literature.literature_id for item in self.items)
        if len(ids) != len(set(ids)):
            raise ValueError("search page items must not contain duplicate Literature")
        if len(self.items) > self.total_count:
            raise ValueError("search page item count cannot exceed total_count")
        return self


class LiteratureAssetView(_LibraryModel):
    """A temporary composition of an existing Asset and LiteratureAsset fact."""

    asset: Asset
    literature_asset: LiteratureAsset


class LiteratureDetail(_LibraryModel):
    """A transient read projection for one concrete Literature."""

    literature: Literature
    meta_literature: MetaLiterature

    metadata_revision: int = Field(strict=True, ge=1)
    metadata_sha256: Sha256

    missing_step: LiteratureMissingStep | None = None
    needs_manual_pdf: bool

    metadata_observations: tuple[MetadataObservation, ...]

    primary_pdf: LiteratureAssetView | None = None
    additional_assets: tuple[LiteratureAssetView, ...] = ()

    parser_result: ParserResult | None = None
    content: LiteratureContent | None = None

    other_versions: tuple[LiteratureSearchItem, ...] = ()

    reference_count: int = Field(strict=True, ge=0)
    cited_by_count: int = Field(strict=True, ge=0)

    @field_validator("metadata_observations", "additional_assets", "other_versions", mode="before")
    @classmethod
    def normalize_collections(cls, value: object, info: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="detail collection")


class LiteratureReferenceRequest(_LibraryModel):
    """A paginated forward or reverse read of authoritative References."""

    literature_id: LiteratureId
    direction: ReferenceDirection
    limit: int = Field(default=50, strict=True, ge=1)
    cursor: str | None = None

    @field_validator("cursor", mode="before")
    @classmethod
    def validate_cursor(cls, value: object) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str) or not value.strip():
            raise ValueError("cursor must be a nonblank opaque string")
        return value


class LiteratureReferenceItem(_LibraryModel):
    """A relation page item with one non-recursive related Literature item."""

    reference: Reference
    related_literature: LiteratureSearchItem
    support_count: int = Field(strict=True, ge=1)


class LiteratureReferencePage(_LibraryModel):
    """A transient immutable page of forward or reverse Reference items."""

    items: tuple[LiteratureReferenceItem, ...]
    total_count: int = Field(strict=True, ge=0)
    next_cursor: str | None = None

    @field_validator("items", mode="before")
    @classmethod
    def normalize_items(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="items")

    @field_validator("next_cursor", mode="before")
    @classmethod
    def validate_next_cursor(cls, value: object) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str) or not value.strip():
            raise ValueError("next_cursor must be a nonblank opaque string")
        return value

    @model_validator(mode="after")
    def reject_duplicate_references(self) -> "LiteratureReferencePage":
        ids = tuple(item.reference.reference_id for item in self.items)
        if len(ids) != len(set(ids)):
            raise ValueError("reference page items must not contain duplicate References")
        if len(self.items) > self.total_count:
            raise ValueError("reference page item count cannot exceed total_count")
        return self


class ReferenceDetail(_LibraryModel):
    """A transient relation detail with both endpoints and exact supports."""

    reference: Reference
    source: LiteratureSearchItem
    target: LiteratureSearchItem
    supports: tuple[ReferenceSupport, ...]

    @field_validator("supports", mode="before")
    @classmethod
    def normalize_supports(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="supports")

    @model_validator(mode="after")
    def validate_relation_composition(self) -> "ReferenceDetail":
        if not self.supports:
            raise ValueError("reference detail requires at least one support")
        if self.source.literature.literature_id != self.reference.source_literature_id:
            raise ValueError("reference detail source must match the Reference source")
        if self.target.literature.literature_id != self.reference.target_literature_id:
            raise ValueError("reference detail target must match the Reference target")
        if any(support.reference_id != self.reference.reference_id for support in self.supports):
            raise ValueError("reference detail supports must match the Reference")
        support_keys = tuple(support.model_dump_json() for support in self.supports)
        if len(support_keys) != len(set(support_keys)):
            raise ValueError("reference detail supports must be unique")
        return self


__all__ = (
    "LibraryQuery",
    "LibrarySearchPage",
    "LibrarySearchRequest",
    "LibrarySort",
    "LiteratureAssetView",
    "LiteratureDetail",
    "LiteratureMissingStep",
    "LiteratureReferenceItem",
    "LiteratureReferencePage",
    "LiteratureReferenceRequest",
    "LiteratureSearchItem",
    "ReferenceDetail",
    "ReferenceDirection",
)
