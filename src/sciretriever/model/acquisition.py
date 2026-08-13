"""Neutral acquisition contracts shared by the acquisition and entry modules.

These models describe source hints, immutable asset facts, and the small set of
results an acquisition operation may expose.  They intentionally do not carry
URLs or transport objects for runtime candidates, and they do not make any
network, PDF, or storage decision.
"""

from __future__ import annotations

import re
from enum import Enum, unique
from typing import TypeAlias
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sciretriever.model.access import has_sensitive_query_parameter
from sciretriever.model.literature import VersionRole
from sciretriever.model.primitives import (
    AssetId,
    LiteratureAssetId,
    LiteratureId,
    RelativeArtifactPath,
    Sha256,
    SourceKind,
)
from sciretriever.model.provenance import Provenance

_CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")


class _AcquisitionModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


def _nonblank(value: str) -> str:
    candidate = value.strip()
    if not candidate:
        raise ValueError("must be a nonblank string")
    return candidate


def _optional_nonblank(value: str | None) -> str | None:
    if value is None:
        return None
    return _nonblank(value)


def _safe_absolute_url(value: str) -> str:
    candidate = _nonblank(value)
    if _CONTROL_CHARACTER.search(candidate) is not None:
        raise ValueError("must not contain control characters")
    try:
        parsed = urlsplit(candidate)
    except ValueError as error:
        raise ValueError("must be an absolute URL") from error
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("must be an absolute HTTP(S) URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("must not contain URL credentials")
    try:
        sensitive_query = has_sensitive_query_parameter(parsed.query)
    except (TypeError, ValueError):
        raise ValueError("URL query must be well formed") from None
    if sensitive_query:
        raise ValueError("must not contain credential query parameters")
    return candidate


@unique
class AssetHintKind(str, Enum):
    """The two source-declared meanings of an asset URL."""

    DIRECT_FILE = "direct-file"
    LANDING_PAGE = "landing-page"


@unique
class AssetRole(str, Enum):
    """Closed roles for assets and asset hints."""

    PRIMARY_PDF = "primary-pdf"
    SUPPLEMENTARY_PDF = "supplementary-pdf"
    XML = "xml"
    HTML = "html"
    SUPPLEMENTARY = "supplementary"


@unique
class AcquisitionPath(str, Enum):
    """The three serial stages of automatic PDF acquisition."""

    PUBLIC = "public"
    AUTHORIZED_PROVIDER_API = "authorized-provider-api"
    CONTROLLED_BROWSER = "controlled-browser"


class AssetHint(_AcquisitionModel):
    """A provider-declared, not-yet-verified asset access hint."""

    url: str
    kind: AssetHintKind
    media_type: str | None = None
    asset_role: AssetRole | None = None
    version_role: VersionRole | None = None
    access_status: str | None = None
    license: str | None = None

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        return _safe_absolute_url(value)

    @field_validator("kind", mode="before")
    @classmethod
    def validate_kind(cls, value: object) -> AssetHintKind:
        if isinstance(value, AssetHintKind):
            return value
        if isinstance(value, str):
            try:
                return AssetHintKind(value)
            except ValueError as error:
                raise ValueError("must be a supported asset hint kind") from error
        raise TypeError("must be a supported asset hint kind")

    @field_validator("asset_role", mode="before")
    @classmethod
    def validate_asset_role(cls, value: object) -> AssetRole | None:
        if value is None or isinstance(value, AssetRole):
            return value
        if isinstance(value, str):
            try:
                return AssetRole(value)
            except ValueError as error:
                raise ValueError("must be a supported asset role") from error
        raise TypeError("must be a supported asset role or null")

    @field_validator("version_role", mode="before")
    @classmethod
    def validate_version_role(cls, value: object) -> VersionRole | None:
        if value is None or isinstance(value, VersionRole):
            return value
        if isinstance(value, str):
            try:
                return VersionRole(value)
            except ValueError as error:
                raise ValueError("must be a supported version role") from error
        raise TypeError("must be a supported version role or null")

    @field_validator("media_type", "access_status", "license")
    @classmethod
    def validate_optional_text(cls, value: str | None) -> str | None:
        return _optional_nonblank(value)


class PdfCandidate(_AcquisitionModel):
    """A temporary candidate key used only inside one acquisition run."""

    candidate_key: str
    source_name: str
    acquisition_path: AcquisitionPath
    declared_media_type: str | None = None

    @field_validator("candidate_key", "source_name")
    @classmethod
    def validate_identity_text(cls, value: str) -> str:
        return _nonblank(value)

    @field_validator("declared_media_type")
    @classmethod
    def validate_declared_media_type(cls, value: str | None) -> str | None:
        return _optional_nonblank(value)

    @field_validator("acquisition_path", mode="before")
    @classmethod
    def validate_acquisition_path(cls, value: object) -> AcquisitionPath:
        if isinstance(value, AcquisitionPath):
            return value
        if isinstance(value, str):
            try:
                return AcquisitionPath(value)
            except ValueError as error:
                raise ValueError("must be a supported acquisition path") from error
        raise TypeError("must be a supported acquisition path")


class Asset(_AcquisitionModel):
    """An immutable file fact, independent of any Literature relationship."""

    asset_id: AssetId
    sha256: Sha256
    size_bytes: int = Field(strict=True, ge=0)
    media_type: str
    path: RelativeArtifactPath

    @field_validator("media_type")
    @classmethod
    def validate_media_type(cls, value: str) -> str:
        return _nonblank(value)


class LiteratureAsset(_AcquisitionModel):
    """A Literature-to-Asset role relation and its source provenance."""

    literature_asset_id: LiteratureAssetId
    literature_id: LiteratureId
    asset_id: AssetId
    role: AssetRole
    provenance: Provenance
    source_url: str | None = None

    @field_validator("role", mode="before")
    @classmethod
    def validate_role(cls, value: object) -> AssetRole:
        if isinstance(value, AssetRole):
            return value
        if isinstance(value, str):
            try:
                return AssetRole(value)
            except ValueError as error:
                raise ValueError("must be a supported asset role") from error
        raise TypeError("must be a supported asset role")

    @field_validator("source_url")
    @classmethod
    def validate_source_url(cls, value: str | None) -> str | None:
        return None if value is None else _safe_absolute_url(value)


class AcquiredPrimaryPdf(_AcquisitionModel):
    """A fully committed automatic primary PDF acquisition."""

    asset: Asset
    relation: LiteratureAsset
    candidate_key: str

    @field_validator("candidate_key")
    @classmethod
    def validate_candidate_key(cls, value: str) -> str:
        return _nonblank(value)

    @model_validator(mode="after")
    def validate_primary_relation(self) -> "AcquiredPrimaryPdf":
        if self.relation.role is not AssetRole.PRIMARY_PDF:
            raise ValueError("acquired result relation must be primary-pdf")
        if self.relation.asset_id != self.asset.asset_id:
            raise ValueError("acquired result relation must point to its asset")
        return self


class NoPrimaryPdf(_AcquisitionModel):
    """The field-free normal result after all automatic paths are exhausted."""

    pass


AcquisitionResult: TypeAlias = AcquiredPrimaryPdf | NoPrimaryPdf


class AcceptedManualPdf(_AcquisitionModel):
    """A committed manual PDF acceptance; the user path is not a Model field."""

    asset: Asset
    relation: LiteratureAsset

    @model_validator(mode="after")
    def validate_manual_relation(self) -> "AcceptedManualPdf":
        if self.relation.role is not AssetRole.PRIMARY_PDF:
            raise ValueError("manual result relation must be primary-pdf")
        if self.relation.asset_id != self.asset.asset_id:
            raise ValueError("manual result relation must point to its asset")
        if self.relation.source_url is not None:
            raise ValueError("manual result relation must not have a source URL")
        provenance = self.relation.provenance
        if provenance.source_kind is not SourceKind.USER or provenance.source_name != "manual-pdf":
            raise ValueError("manual result relation must use manual-pdf user provenance")
        if provenance.input_sha256 != self.asset.sha256:
            raise ValueError("manual provenance input hash must match the accepted asset")
        return self


class AutomaticPdfAcquisitionExhaustion(_AcquisitionModel):
    """The minimal durable fact that automatic PDF paths were exhausted."""

    literature_id: LiteratureId


__all__ = (
    "AcceptedManualPdf",
    "AcquiredPrimaryPdf",
    "AcquisitionPath",
    "AcquisitionResult",
    "Asset",
    "AssetHint",
    "AssetHintKind",
    "AssetRole",
    "AutomaticPdfAcquisitionExhaustion",
    "LiteratureAsset",
    "NoPrimaryPdf",
    "PdfCandidate",
)
