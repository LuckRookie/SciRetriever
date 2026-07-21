"""Format-neutral inputs and outputs for deterministic normalization."""

from __future__ import annotations

from dataclasses import dataclass

from sciretriever.core.enums import AssetRole
from sciretriever.core.ids import validate_uuid
from sciretriever.core.package import EvidenceLocator, NormalizedContent
from sciretriever.core.validation import validate_media_type, validate_sha256


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
    "SourceUnit",
)
