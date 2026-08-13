"""Parser-neutral contracts exchanged with the Parsing module."""

from __future__ import annotations

import json
import re
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import BinaryIO, Protocol, runtime_checkable
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sciretriever.model.primitives import AssetId, Sha256, SourceKind, sha256_digest
from sciretriever.model.provenance import Provenance

_CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")
_PARSER_CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_WINDOWS_DRIVE_PATH = re.compile(r"^[A-Za-z]:")


class _ParsingModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


@runtime_checkable
class StorageObjectRef(Protocol):
    """Path-free capability for opening one Storage-verified binary object."""

    def open(self) -> AbstractContextManager[BinaryIO]: ...


@dataclass(frozen=True, slots=True)
class ParserRequest:
    """The exact current-primary PDF input passed to one selected Parser."""

    source_asset_id: AssetId
    source_sha256: Sha256
    media_type: str
    content_ref: StorageObjectRef = field(repr=False)

    def __post_init__(self) -> None:
        if not isinstance(self.source_asset_id, AssetId):
            raise TypeError("source_asset_id must be an AssetId")
        if not isinstance(self.source_sha256, Sha256):
            raise TypeError("source_sha256 must be a Sha256")
        if self.media_type != "application/pdf":
            raise ValueError("ParserRequest media_type must be application/pdf")
        if not isinstance(self.content_ref, StorageObjectRef):
            raise TypeError("content_ref must be a path-free StorageObjectRef")


def _nonblank(value: str) -> str:
    candidate = value.strip()
    if not candidate:
        raise ValueError("must be a nonblank string")
    return candidate


def _safe_reference(value: str) -> str:
    candidate = _nonblank(value)
    if _CONTROL_CHARACTER.search(candidate) is not None:
        raise ValueError("resource reference must not contain control characters")
    try:
        parsed = urlsplit(candidate)
        path = PurePosixPath(candidate)
    except ValueError as error:
        raise ValueError("resource reference must be a safe relative path") from error
    invalid = (
        "\\" in candidate
        or bool(parsed.scheme or parsed.netloc or parsed.query or parsed.fragment)
        or path.is_absolute()
        or candidate != path.as_posix()
        or any(part in {"", ".", ".."} for part in candidate.split("/"))
    )
    if invalid:
        raise ValueError("resource reference must be a safe relative path")
    return candidate


def _parser_identity(value: str) -> str:
    if (
        not value
        or value != value.strip()
        or _PARSER_CONTROL_CHARACTER.search(value) is not None
        or "\\" in value
        or value.startswith("~")
        or _WINDOWS_DRIVE_PATH.match(value) is not None
    ):
        raise ValueError("parser identity must be stable and path-free")
    try:
        parsed = urlsplit(value)
    except ValueError as error:
        raise ValueError("parser identity must be stable and path-free") from error
    if (
        parsed.scheme
        or parsed.netloc
        or parsed.query
        or parsed.fragment
        or parsed.path != value
        or any(part in {"", ".", ".."} for part in value.split("/"))
    ):
        raise ValueError("parser identity must be stable and path-free")
    return value


class ParserArtifactRef(_ParsingModel):
    """A content-addressed immutable parser artifact descriptor."""

    sha256: Sha256
    media_type: str
    byte_size: int = Field(strict=True, ge=0)

    @field_validator("media_type")
    @classmethod
    def validate_media_type(cls, value: str) -> str:
        return _nonblank(value)


class ParserResource(_ParsingModel):
    """One local resource actually referenced by parser Markdown."""

    reference: str
    artifact: ParserArtifactRef

    @field_validator("reference")
    @classmethod
    def validate_reference(cls, value: str) -> str:
        return _safe_reference(value)


class ParserProvenance(_ParsingModel):
    """Parser-specific identity layered on the shared Provenance contract."""

    provenance: Provenance
    parser_version: str
    mode: str | None = None
    model_identity: str | None = None

    @field_validator("parser_version", "mode", "model_identity")
    @classmethod
    def validate_parser_identity(cls, value: str | None) -> str | None:
        return None if value is None else _parser_identity(value)

    @model_validator(mode="after")
    def validate_parser_context(self) -> "ParserProvenance":
        provenance = self.provenance
        if provenance.source_kind is not SourceKind.PARSER:
            raise ValueError("parser provenance must use source kind parser")
        if provenance.source_record_id is not None:
            raise ValueError("parser provenance cannot retain a source record ID")
        if provenance.input_sha256 is None:
            raise ValueError("parser provenance requires an input hash")
        if provenance.parameters_sha256 is None:
            raise ValueError("parser provenance requires a parameters hash")
        return self


def _text(value: object) -> str:
    if isinstance(value, str):
        return value
    return str(value)


def _canonical_result_payload(
    *,
    source_asset_id: AssetId,
    source_sha256: Sha256,
    page_count: int,
    markdown: ParserArtifactRef,
    resources: tuple[ParserResource, ...],
    provenance: ParserProvenance,
) -> dict[str, object]:
    parser_provenance = provenance.provenance
    return {
        "markdown": {
            "byte_size": markdown.byte_size,
            "media_type": markdown.media_type,
            "sha256": _text(markdown.sha256.root),
        },
        "page_count": page_count,
        "parser": {
            "mode": provenance.mode,
            "model_identity": provenance.model_identity,
            "name": parser_provenance.source_name,
            "parameters_sha256": _text(parser_provenance.parameters_sha256.root),
            "version": provenance.parser_version,
        },
        "resources": [
            {
                "artifact": {
                    "byte_size": resource.artifact.byte_size,
                    "media_type": resource.artifact.media_type,
                    "sha256": _text(resource.artifact.sha256.root),
                },
                "reference": resource.reference,
            }
            for resource in sorted(resources, key=lambda item: item.reference)
        ],
        "source_asset_id": _text(source_asset_id.root),
        "source_sha256": _text(source_sha256.root),
    }


def parser_result_sha256(
    *,
    source_asset_id: AssetId,
    source_sha256: Sha256,
    page_count: int,
    markdown: ParserArtifactRef,
    resources: tuple[ParserResource, ...],
    provenance: ParserProvenance,
) -> Sha256:
    """Compute the deterministic hash of a normalized parser result manifest."""

    if not isinstance(provenance, ParserProvenance):
        raise TypeError("provenance must be ParserProvenance")
    checked_provenance = ParserProvenance.model_validate(provenance.model_dump())
    encoded = json.dumps(
        _canonical_result_payload(
            source_asset_id=source_asset_id,
            source_sha256=source_sha256,
            page_count=page_count,
            markdown=markdown,
            resources=resources,
            provenance=checked_provenance,
        ),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return sha256_digest(encoded)


class ParserResult(_ParsingModel):
    """The single parser-neutral current result for one source Asset."""

    source_asset_id: AssetId
    source_sha256: Sha256
    page_count: int = Field(strict=True, ge=1)
    markdown: ParserArtifactRef
    resources: tuple[ParserResource, ...] = ()
    result_sha256: Sha256
    provenance: ParserProvenance

    @field_validator("markdown")
    @classmethod
    def validate_markdown_media_type(cls, value: ParserArtifactRef) -> ParserArtifactRef:
        if value.media_type != "text/markdown":
            raise ValueError("parser Markdown artifact must use text/markdown")
        if value.byte_size == 0:
            raise ValueError("parser Markdown artifact must be non-empty")
        return value

    @field_validator("resources", mode="before")
    @classmethod
    def normalize_resources(cls, value: object) -> object:
        if isinstance(value, list):
            return tuple(value)
        return value

    @field_validator("resources")
    @classmethod
    def validate_resources(cls, value: tuple[ParserResource, ...]) -> tuple[ParserResource, ...]:
        ordered = tuple(sorted(value, key=lambda item: item.reference))
        references = tuple(item.reference for item in ordered)
        if len(references) != len(set(references)):
            raise ValueError("parser resources must have unique references")
        return ordered

    @model_validator(mode="after")
    def validate_result_alignment(self) -> "ParserResult":
        provenance = self.provenance.provenance
        if provenance.input_sha256 != self.source_sha256:
            raise ValueError("parser provenance input hash must match source hash")
        expected = parser_result_sha256(
            source_asset_id=self.source_asset_id,
            source_sha256=self.source_sha256,
            page_count=self.page_count,
            markdown=self.markdown,
            resources=self.resources,
            provenance=self.provenance,
        )
        if self.result_sha256 != expected:
            raise ValueError("result hash does not match the canonical parser manifest")
        return self


__all__ = (
    "ParserArtifactRef",
    "ParserProvenance",
    "ParserRequest",
    "ParserResource",
    "ParserResult",
    "StorageObjectRef",
    "parser_result_sha256",
)
