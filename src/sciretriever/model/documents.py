from __future__ import annotations

import unicodedata
from typing import Final, Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, SkipValidation, field_validator, model_validator

from sciretriever.model.assets import PublishedArtifact
from sciretriever.model.canonical_json import CanonicalJsonObject
from sciretriever.model.literature import Author, Identifier
from sciretriever.model.primitives import (
    AssetId,
    LightDocumentId,
    Sha256,
    WorkId,
    WorkVersionAssetId,
    WorkVersionId,
)

_UUID_PATTERN: Final = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"


class _DocumentValidationError(ValueError):
    pass


class _DocumentModel(BaseModel):
    model_config = ConfigDict(
        arbitrary_types_allowed=True,
        extra="forbid",
        frozen=True,
        strict=True,
    )


class LightDocumentBounds(_DocumentModel):
    max_pages: int = Field(default=10_000, gt=0)
    max_blocks: int = Field(default=100_000, gt=0)
    max_spans: int = Field(default=500_000, gt=0)
    max_text_characters: int = Field(default=20_000_000, gt=0)
    max_table_cells: int = Field(default=1_000_000, gt=0)
    max_section_depth: int = Field(default=32, gt=0)


def _nonblank(value: str) -> str:
    if not value.strip():
        raise _DocumentValidationError("must be a nonblank string")
    return unicodedata.normalize("NFC", value)


def _optional_nonblank(value: str | None) -> str | None:
    return None if value is None else _nonblank(value)


def _text_items(value: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(_nonblank(item) for item in value)


class LightDocumentAcceptance(_DocumentModel):
    work_version_id: WorkVersionId
    expected_primary_relation_id: WorkVersionAssetId
    expected_primary_sha256: Sha256
    document_id: LightDocumentId
    artifact_id: AssetId
    artifact: PublishedArtifact
    document: SkipValidation[CanonicalJsonObject]
    provenance: SkipValidation[CanonicalJsonObject]


class LightPublicationTarget(_DocumentModel):
    work_version_id: WorkVersionId
    primary_relation_id: WorkVersionAssetId
    primary_asset_id: AssetId
    primary_sha256: Sha256


from sciretriever.model.sources import Provenance  # noqa: E402


class SourceLocator(_DocumentModel):
    asset_id: AssetId
    page_start: int = Field(ge=1)
    page_end: int = Field(ge=1)
    block_id: str
    char_start: int = Field(ge=0)
    char_end: int = Field(ge=0)

    @field_validator("block_id")
    @classmethod
    def validate_block_id(cls, value: str) -> str:
        return _nonblank(value)

    @model_validator(mode="after")
    def validate_ranges(self) -> SourceLocator:
        if self.page_end < self.page_start:
            raise _DocumentValidationError("page_end must be at least page_start")
        if self.char_end <= self.char_start:
            raise _DocumentValidationError("char_end must be greater than char_start")
        return self


class EvidenceText(_DocumentModel):
    text: str
    evidence: tuple[SourceLocator, ...] = Field(min_length=1)

    @field_validator("text")
    @classmethod
    def validate_text(cls, value: str) -> str:
        return _nonblank(value)


class ParagraphBlock(_DocumentModel):
    kind: Literal["paragraph"]
    block_id: str
    text: str
    evidence: tuple[SourceLocator, ...] = Field(min_length=1)

    @field_validator("block_id", "text")
    @classmethod
    def validate_text_fields(cls, value: str) -> str:
        return _nonblank(value)


class ListBlock(_DocumentModel):
    kind: Literal["list"]
    block_id: str
    ordered: bool
    items: tuple[EvidenceText, ...] = Field(min_length=1)

    @field_validator("block_id")
    @classmethod
    def validate_block_id(cls, value: str) -> str:
        return _nonblank(value)


class TableBlock(_DocumentModel):
    kind: Literal["table"]
    block_id: str
    caption: EvidenceText | None
    columns: tuple[str, ...] = Field(min_length=1)
    rows: tuple[tuple[str, ...], ...]
    evidence: tuple[SourceLocator, ...] = Field(min_length=1)

    @field_validator("block_id")
    @classmethod
    def validate_block_id(cls, value: str) -> str:
        return _nonblank(value)

    @field_validator("columns")
    @classmethod
    def validate_columns(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        return _text_items(value)

    @field_validator("rows")
    @classmethod
    def validate_rows(cls, value: tuple[tuple[str, ...], ...]) -> tuple[tuple[str, ...], ...]:
        return tuple(_text_items(row) for row in value)

    @model_validator(mode="after")
    def validate_row_widths(self) -> TableBlock:
        if any(len(row) != len(self.columns) for row in self.rows):
            raise _DocumentValidationError("table rows must match columns")
        return self


class FormulaBlock(_DocumentModel):
    kind: Literal["formula"]
    block_id: str
    text: str
    label: str | None
    evidence: tuple[SourceLocator, ...] = Field(min_length=1)

    @field_validator("block_id", "text")
    @classmethod
    def validate_text_fields(cls, value: str) -> str:
        return _nonblank(value)

    @field_validator("label")
    @classmethod
    def validate_label(cls, value: str | None) -> str | None:
        return _optional_nonblank(value)


class FigureCaptionBlock(_DocumentModel):
    kind: Literal["figure-caption"]
    block_id: str
    text: str
    evidence: tuple[SourceLocator, ...] = Field(min_length=1)

    @field_validator("block_id", "text")
    @classmethod
    def validate_text_fields(cls, value: str) -> str:
        return _nonblank(value)


Block: TypeAlias = ParagraphBlock | ListBlock | TableBlock | FormulaBlock | FigureCaptionBlock


class Section(_DocumentModel):
    section_id: str
    level: int = Field(ge=1)
    title: EvidenceText | None
    blocks: tuple[Block, ...]
    children: tuple[Section, ...]

    @field_validator("section_id")
    @classmethod
    def validate_section_id(cls, value: str) -> str:
        return _nonblank(value)


Section.model_rebuild()


class ReferenceView(_DocumentModel):
    reference_id: str = Field(pattern=_UUID_PATTERN)
    raw_text: str
    title: str | None
    authors: tuple[Author, ...]
    publication_year: int | None = Field(default=None, ge=0, le=9999)
    source: str | None
    identifiers: tuple[Identifier, ...]
    resolved_work_id: WorkId | None
    resolved_work_version_id: WorkVersionId | None
    evidence: tuple[SourceLocator, ...] = Field(min_length=1)

    @field_validator("raw_text")
    @classmethod
    def validate_raw_text(cls, value: str) -> str:
        return _nonblank(value)

    @field_validator("title", "source")
    @classmethod
    def validate_optional_text(cls, value: str | None) -> str | None:
        return _optional_nonblank(value)

    @field_validator("identifiers")
    @classmethod
    def validate_identifiers(cls, value: tuple[Identifier, ...]) -> tuple[Identifier, ...]:
        if len(value) != len(set(value)):
            raise _DocumentValidationError("duplicate identifiers")
        return value


class LightDocumentV1(_DocumentModel):
    schema_version: Literal["1"]
    title: EvidenceText | None
    abstract: tuple[EvidenceText, ...]
    sections: tuple[Section, ...]
    references: tuple[ReferenceView, ...]
    provenance: tuple[Provenance, ...]

    @model_validator(mode="after")
    def validate_unique_entries(self) -> LightDocumentV1:
        reference_ids = tuple(item.reference_id for item in self.references)
        if len(reference_ids) != len(set(reference_ids)):
            raise _DocumentValidationError("duplicate references")
        provenance_ids = tuple(item.provenance_id for item in self.provenance)
        if len(provenance_ids) != len(set(provenance_ids)):
            raise _DocumentValidationError("duplicate provenance")
        return self


class LightDocumentPublication(_DocumentModel):
    document_id: LightDocumentId
    artifact_id: AssetId
    artifact: PublishedArtifact
    document: LightDocumentV1


__all__ = (
    "Author",
    "Block",
    "EvidenceText",
    "FigureCaptionBlock",
    "FormulaBlock",
    "LightDocumentBounds",
    "LightDocumentPublication",
    "LightDocumentV1",
    "LightDocumentAcceptance",
    "LightPublicationTarget",
    "ListBlock",
    "ParagraphBlock",
    "ReferenceView",
    "Section",
    "SourceLocator",
    "TableBlock",
)
