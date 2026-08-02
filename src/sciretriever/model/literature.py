from __future__ import annotations

import unicodedata

from pydantic import BaseModel, ConfigDict, field_validator


class Identifier(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    namespace: str
    value: str

    def __hash__(self) -> int:
        return hash((self.namespace, self.value))

    @field_validator("namespace", "value")
    @classmethod
    def validate_nonblank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must be a nonblank string")
        return unicodedata.normalize("NFC", value)
