"""Neutral metadata observations and provider relation contracts.

The module intentionally stores source observations without assigning them to a
local Literature.  Identity matching, precedence, and acceptance are owned by
the Literature feature module.
"""

from __future__ import annotations

import unicodedata
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sciretriever.model.primitives import ObservationId, SourceKind
from sciretriever.model.provenance import Provenance

if TYPE_CHECKING:
    from sciretriever.model.acquisition import AssetHint
    from sciretriever.model.literature import (
        Author,
        Identifier,
        VersionRole,
    )


class _MetadataModel(BaseModel):
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


def _optional_text(value: object, *, field_name: str) -> str | None:
    if value is None:
        return None
    return _nonblank_text(value, field_name=field_name)


def _as_tuple(value: object, *, field_name: str) -> tuple[object, ...]:
    if isinstance(value, tuple):
        return value
    if isinstance(value, list):
        return tuple(value)
    raise TypeError(f"{field_name} must be a list or tuple")


class LiteratureMetadata(_MetadataModel):
    """The single current metadata projection for one concrete Literature."""

    title: str | None = None
    authors: tuple["Author", ...] = ()
    abstract: str | None = None
    publication_date: str | None = None
    publication_year: int | None = Field(default=None, strict=True, ge=1, le=9999)
    document_type: str | None = None
    language: str | None = None
    venue: str | None = None
    publisher: str | None = None
    volume: str | None = None
    issue: str | None = None
    pages: str | None = None
    identifiers: tuple["Identifier", ...] = ()
    keywords: tuple[str, ...] = ()

    @field_validator(
        "title",
        "abstract",
        "publication_date",
        "document_type",
        "language",
        "venue",
        "publisher",
        "volume",
        "issue",
        "pages",
        mode="before",
    )
    @classmethod
    def normalize_optional_text(cls, value: object, info: object) -> str | None:
        return _optional_text(value, field_name="metadata field")

    @field_validator("authors", mode="before")
    @classmethod
    def normalize_authors(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="authors")

    @field_validator("identifiers", mode="before")
    @classmethod
    def normalize_identifiers(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="identifiers")

    @field_validator("keywords", mode="before")
    @classmethod
    def normalize_keywords(cls, value: object) -> tuple[str, ...]:
        raw_values = _as_tuple(value, field_name="keywords")
        normalized: list[str] = []
        for item in raw_values:
            normalized.append(_nonblank_text(item, field_name="keyword"))
        return tuple(normalized)


class ProviderLiteratureKey(_MetadataModel):
    """A provider-scoped location for a related literature record."""

    record_id: str | None = None
    identifiers: tuple["Identifier", ...] = ()

    @field_validator("record_id", mode="before")
    @classmethod
    def normalize_record_id(cls, value: object) -> str | None:
        return _optional_text(value, field_name="record_id")

    @field_validator("identifiers", mode="before")
    @classmethod
    def normalize_identifiers(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="identifiers")

    @model_validator(mode="after")
    def require_stable_position(self) -> "ProviderLiteratureKey":
        if self.record_id is None and not self.identifiers:
            raise ValueError("provider literature key needs a record_id or identifier")
        return self


class MetadataObservation(_MetadataModel):
    """One immutable provider or bibliographic-import source observation."""

    observation_id: ObservationId
    provenance: Provenance
    metadata: LiteratureMetadata
    version_role: "VersionRole | None" = None
    version_links: tuple[ProviderLiteratureKey, ...] = ()
    declared_keywords: tuple[str, ...] = ()
    reference_texts: tuple[str, ...] = ()
    reference_count: int | None = Field(default=None, strict=True, ge=0)
    cited_by_count: int | None = Field(default=None, strict=True, ge=0)
    # AssetHint is the neutral source-hint contract owned by Acquisition.
    asset_hints: tuple["AssetHint", ...] = ()

    @field_validator("version_role", mode="before")
    @classmethod
    def normalize_version_role(cls, value: object) -> object:
        if value is None:
            return None
        from sciretriever.model.literature import VersionRole

        if isinstance(value, VersionRole):
            return value
        if isinstance(value, str):
            try:
                return VersionRole(value)
            except ValueError as error:
                raise ValueError("version_role must be a supported value") from error
        raise TypeError("version_role must be a supported value")

    @field_validator("version_links", mode="before")
    @classmethod
    def normalize_version_links(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="version_links")

    @field_validator("declared_keywords", mode="before")
    @classmethod
    def normalize_declared_keywords(cls, value: object) -> tuple[str, ...]:
        raw_values = _as_tuple(value, field_name="declared_keywords")
        return tuple(_nonblank_text(item, field_name="declared_keyword") for item in raw_values)

    @field_validator("reference_texts", mode="before")
    @classmethod
    def normalize_reference_texts(cls, value: object) -> tuple[str, ...]:
        raw_values = _as_tuple(value, field_name="reference_texts")
        return tuple(_nonblank_text(item, field_name="reference_text") for item in raw_values)

    @field_validator("asset_hints", mode="before")
    @classmethod
    def normalize_asset_hints(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="asset_hints")

    @model_validator(mode="after")
    def validate_source_boundary(self) -> "MetadataObservation":
        kind = self.provenance.source_kind
        if kind is SourceKind.METADATA_PROVIDER:
            if self.provenance.source_record_id is None:
                raise ValueError("provider observation requires source_record_id")
            if self.provenance.input_sha256 is None:
                raise ValueError("provider observation requires input_sha256")
        elif kind is SourceKind.USER:
            if (
                self.provenance.source_name != "bibliographic-import"
                or self.provenance.source_record_id is not None
                or self.provenance.input_sha256 is not None
                or self.provenance.parameters_sha256 is not None
            ):
                raise ValueError(
                    "user observation must use the fixed bibliographic-import provenance"
                )
        else:
            raise ValueError("metadata observation source_kind must be metadata-provider or user")
        return self


class ProviderRelationObservation(_MetadataModel):
    """One provider-declared directed citing-to-cited edge."""

    observation_id: ObservationId
    provenance: Provenance
    citing: ProviderLiteratureKey
    cited: ProviderLiteratureKey

    @model_validator(mode="after")
    def validate_source_boundary(self) -> "ProviderRelationObservation":
        if self.provenance.source_kind is not SourceKind.METADATA_PROVIDER:
            raise ValueError("provider relation observation requires metadata-provider provenance")
        if self.citing == self.cited:
            raise ValueError("provider relation citing and cited records must differ")
        return self


__all__ = (
    "LiteratureMetadata",
    "MetadataObservation",
    "ProviderLiteratureKey",
    "ProviderRelationObservation",
)


def _finish_metadata_model_rebuild() -> None:
    from sciretriever.model.acquisition import AssetHint
    from sciretriever.model.literature import (
        Affiliation,
        Author,
        Identifier,
        Literature,
        VersionRole,
    )

    namespace: dict[str, object] = {
        "Affiliation": Affiliation,
        "Author": Author,
        "Identifier": Identifier,
        "Literature": Literature,
        "VersionRole": VersionRole,
        "AssetHint": AssetHint,
    }
    LiteratureMetadata.model_rebuild(_types_namespace=namespace)
    MetadataObservation.model_rebuild(_types_namespace=namespace)
    ProviderLiteratureKey.model_rebuild(_types_namespace=namespace)
    ProviderRelationObservation.model_rebuild(_types_namespace=namespace)
    Literature.model_rebuild(_types_namespace={"LiteratureMetadata": LiteratureMetadata})


_finish_metadata_model_rebuild()
