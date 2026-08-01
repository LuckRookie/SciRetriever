"""Format-neutral inputs and outputs for deterministic normalization."""

from __future__ import annotations

from dataclasses import dataclass
import math
import re

from sciretriever.core.enums import AssetRole
from sciretriever.core.ids import validate_uuid
from sciretriever.core.package import EvidenceLocator, NormalizedContent
from sciretriever.core.validation import validate_media_type, validate_sha256


_MINERU_SPAN_PATH = re.compile(
    r"^/pdf_info/(?P<page>0|[1-9][0-9]*)/para_blocks/(?:0|[1-9][0-9]*)"
    r"(?:/blocks/(?:0|[1-9][0-9]*))*/lines/(?:0|[1-9][0-9]*)/spans/(?:0|[1-9][0-9]*)$"
)


def _nonnegative_int(value: object, field_name: str) -> int:
    if type(value) is not int or value < 0:
        raise ValueError(f"{field_name} must be a non-negative integer")
    return value


def _span_page(path: object) -> int:
    if not isinstance(path, str):
        raise TypeError("structural_span_path must be a string")
    match = _MINERU_SPAN_PATH.fullmatch(path)
    if match is None:
        raise ValueError("structural_span_path must identify a MinerU PDF span")
    return int(match.group("page"))


@dataclass(frozen=True, slots=True)
class NormalizationParameters:
    max_input_bytes: int = 64 * 1024 * 1024
    max_pages: int = 2_000
    max_structural_units: int = 100_000
    max_depth: int = 256
    max_elements: int = 500_000
    max_text_characters: int = 20_000_000

    def __post_init__(self) -> None:
        for name in self.__dataclass_fields__:
            value = getattr(self, name)
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                raise ValueError(f"{name} must be a positive integer")

    def to_dict(self) -> dict[str, int]:
        return {name: getattr(self, name) for name in self.__dataclass_fields__}


@dataclass(frozen=True, slots=True)
class RawNormalizationInput:
    file_id: str
    role: AssetRole
    media_type: str
    sha256: str
    payload: bytes

    def __post_init__(self) -> None:
        validate_uuid(self.file_id, "file_id")
        if not isinstance(self.role, AssetRole):
            raise TypeError("role must be an AssetRole")
        validate_media_type(self.media_type)
        validate_sha256(self.sha256)
        if not isinstance(self.payload, bytes):
            raise TypeError("payload must be bytes")
        if not self.payload:
            raise ValueError("payload must not be empty")


@dataclass(frozen=True, slots=True)
class SourceUnit:
    unit_id: str
    file_id: str
    ordinal: int
    text: str
    structural_path: str

    def to_dict(self) -> dict[str, object]:
        return {
            "unit_id": self.unit_id,
            "file_id": self.file_id,
            "ordinal": self.ordinal,
            "text": self.text,
            "structural_path": self.structural_path,
        }


@dataclass(frozen=True, slots=True)
class PdfBoundingBox:
    left: float
    top: float
    right: float
    bottom: float

    def __post_init__(self) -> None:
        values = (self.left, self.top, self.right, self.bottom)
        if not all(type(value) is float and math.isfinite(value) for value in values):
            raise ValueError("PDF bounding-box coordinates must be finite numbers")
        if self.left < 0 or self.top < 0 or self.right <= self.left or self.bottom <= self.top:
            raise ValueError("PDF bounding box must have positive area")

    def to_list(self) -> list[float]:
        return [float(self.left), float(self.top), float(self.right), float(self.bottom)]


@dataclass(frozen=True, slots=True)
class PdfPageGeometry:
    page_index: int
    width: float
    height: float

    def __post_init__(self) -> None:
        _nonnegative_int(self.page_index, "page_index")
        if not all(type(value) is float and math.isfinite(value) and value > 0 for value in (self.width, self.height)):
            raise ValueError("PDF page dimensions must be finite positive numbers")

    def to_dict(self) -> dict[str, object]:
        return {"page_index": self.page_index, "width": float(self.width), "height": float(self.height)}


@dataclass(frozen=True, slots=True)
class PdfEvidenceLocator:
    evidence_id: str
    raw_asset_id: str
    raw_asset_sha256: str
    parser_artifact_id: str
    source_map_artifact_id: str
    source_unit_id: str
    page_index: int
    structural_span_path: str
    bbox: PdfBoundingBox
    source_start: int
    source_end: int
    document_start: int
    document_end: int

    def __post_init__(self) -> None:
        for value, name in ((self.evidence_id, "evidence_id"), (self.raw_asset_id, "raw_asset_id"), (self.parser_artifact_id, "parser_artifact_id"), (self.source_map_artifact_id, "source_map_artifact_id"), (self.source_unit_id, "source_unit_id")):
            validate_uuid(value, name)
        validate_sha256(self.raw_asset_sha256)
        _nonnegative_int(self.page_index, "page_index")
        if _span_page(self.structural_span_path) != self.page_index:
            raise ValueError("structural span page does not match page_index")
        if not isinstance(self.bbox, PdfBoundingBox):
            raise TypeError("bbox must be a PdfBoundingBox")
        for value, name in ((self.source_start, "source_start"), (self.source_end, "source_end"), (self.document_start, "document_start"), (self.document_end, "document_end")):
            _nonnegative_int(value, name)
        if not (self.source_start < self.source_end and self.document_start < self.document_end):
            raise ValueError("evidence offsets must identify non-empty text")
        if self.source_end - self.source_start != self.document_end - self.document_start:
            raise ValueError("source and document evidence lengths must match")

    def to_dict(self) -> dict[str, object]:
        return {
            "evidence_id": self.evidence_id, "raw_asset_id": self.raw_asset_id,
            "raw_asset_sha256": self.raw_asset_sha256, "parser_artifact_id": self.parser_artifact_id,
            "source_map_artifact_id": self.source_map_artifact_id, "source_unit_id": self.source_unit_id,
            "page_index": self.page_index, "structural_span_path": self.structural_span_path,
            "bbox": self.bbox.to_list(), "source_start": self.source_start, "source_end": self.source_end,
            "document_start": self.document_start, "document_end": self.document_end,
        }


@dataclass(frozen=True, slots=True)
class PdfSourceUnit:
    unit_id: str
    raw_asset_id: str
    ordinal: int
    page_index: int
    structural_span_path: str
    bbox: PdfBoundingBox
    text: str
    source_start: int
    source_end: int
    document_start: int
    document_end: int
    extraction_method: str

    def __post_init__(self) -> None:
        validate_uuid(self.unit_id, "unit_id")
        validate_uuid(self.raw_asset_id, "raw_asset_id")
        _nonnegative_int(self.ordinal, "ordinal")
        _nonnegative_int(self.page_index, "page_index")
        if _span_page(self.structural_span_path) != self.page_index:
            raise ValueError("structural span page does not match page_index")
        if not isinstance(self.bbox, PdfBoundingBox):
            raise TypeError("bbox must be a PdfBoundingBox")
        if not isinstance(self.text, str):
            raise TypeError("text must be a string")
        for value, name in ((self.source_start, "source_start"), (self.source_end, "source_end"), (self.document_start, "document_start"), (self.document_end, "document_end")):
            _nonnegative_int(value, name)
        if self.extraction_method != "mineru_vlm":
            raise ValueError("PDF source units require MinerU VLM extraction provenance")
        if not self.text or not (0 <= self.source_start < self.source_end <= len(self.text)):
            raise ValueError("source offsets must be within source-unit text")
        if (self.source_start, self.source_end) != (0, len(self.text)):
            raise ValueError("source offsets must cover the source-unit text")
        if self.document_end - self.document_start != len(self.text):
            raise ValueError("document offsets must cover the source-unit text")

    def to_dict(self) -> dict[str, object]:
        return {
            "unit_id": self.unit_id, "raw_asset_id": self.raw_asset_id, "ordinal": self.ordinal,
            "page_index": self.page_index, "structural_span_path": self.structural_span_path,
            "bbox": self.bbox.to_list(), "text": self.text, "source_start": self.source_start,
            "source_end": self.source_end, "document_start": self.document_start,
            "document_end": self.document_end, "extraction_method": self.extraction_method,
        }


@dataclass(frozen=True, slots=True)
class NormalizationDraft:
    content: NormalizedContent
    evidence: tuple[EvidenceLocator, ...]
    source_units: tuple[SourceUnit, ...]
    source_map_artifact_id: str

    def source_map_dict(self) -> dict[str, object]:
        return {
            "schema_version": "1",
            "source_map_artifact_id": self.source_map_artifact_id,
            "source_units": [unit.to_dict() for unit in self.source_units],
            "evidence": [item.to_dict() for item in self.evidence],
        }


__all__ = (
    "NormalizationDraft",
    "NormalizationParameters",
    "RawNormalizationInput",
    "PdfBoundingBox",
    "PdfEvidenceLocator",
    "PdfPageGeometry",
    "PdfSourceUnit",
    "SourceUnit",
)
