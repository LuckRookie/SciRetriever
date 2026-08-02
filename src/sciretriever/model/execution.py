from __future__ import annotations

import unicodedata

from pydantic import BaseModel, ConfigDict, field_validator


class _ExecutionModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class Reason(_ExecutionModel):
    value: str

    @field_validator("value")
    @classmethod
    def validate_value(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must be a nonblank string")
        return unicodedata.normalize("NFC", value)

    def __str__(self) -> str:
        return self.value


class Action(_ExecutionModel):
    value: str

    @field_validator("value")
    @classmethod
    def validate_value(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must be a nonblank string")
        return unicodedata.normalize("NFC", value)

    def __str__(self) -> str:
        return self.value


class FailureEvidence(_ExecutionModel):
    code: str
    reason: Reason
    action: Action
    retryable: bool

    @field_validator("code")
    @classmethod
    def validate_code(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must be a nonblank string")
        return unicodedata.normalize("NFC", value)
