from __future__ import annotations

import unicodedata

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sciretriever.model.primitives import AssetId


class SourceLocator(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    asset_id: AssetId
    page_start: int = Field(ge=1)
    page_end: int = Field(ge=1)
    block_id: str
    char_start: int = Field(ge=0)
    char_end: int = Field(ge=0)

    @field_validator("block_id")
    @classmethod
    def validate_block_id(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must be a nonblank string")
        return unicodedata.normalize("NFC", value)

    @model_validator(mode="after")
    def validate_ranges(self) -> SourceLocator:
        if self.page_end < self.page_start:
            raise ValueError("page_end must be at least page_start")
        if self.char_end < self.char_start:
            raise ValueError("char_end must be at least char_start")
        return self


class EvidenceText(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    text: str
    evidence: tuple[SourceLocator, ...]

    @field_validator("text")
    @classmethod
    def validate_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must be a nonblank string")
        return unicodedata.normalize("NFC", value)
