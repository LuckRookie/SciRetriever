from __future__ import annotations

import re

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

_HEADER_NAME = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")


class _AccessModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


class Header(_AccessModel):
    name: str
    value: str = Field(repr=False)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        if _HEADER_NAME.fullmatch(value) is None:
            raise ValueError("must be an HTTP field-name token")
        return value

    @field_validator("value")
    @classmethod
    def validate_value(cls, value: str) -> str:
        if any(
            (ord(character) < 32 and character != "\t") or ord(character) == 127
            for character in value
        ):
            raise ValueError("must not contain control characters")
        return value


class BoundedByteStream(_AccessModel):
    chunks: tuple[bytes, ...] = Field(repr=False)
    media_type: str
    final_locator: str
    size: int = Field(strict=True, ge=0)

    @field_validator("media_type", "final_locator")
    @classmethod
    def validate_nonblank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must be a nonblank string")
        return value

    @model_validator(mode="after")
    def validate_size(self) -> BoundedByteStream:
        if self.size != sum(len(chunk) for chunk in self.chunks):
            raise ValueError("size must match the byte chunks")
        return self


class TransportRequest(_AccessModel):
    method: str
    url: str
    headers: tuple[Header, ...]
    body: bytes | None = Field(repr=False)
    timeout_seconds: int = Field(strict=True, gt=0)
    max_response_bytes: int = Field(strict=True, ge=1)

    @field_validator("method")
    @classmethod
    def validate_method(cls, value: str) -> str:
        if _HEADER_NAME.fullmatch(value) is None:
            raise ValueError("must be an HTTP method token")
        return value

    @field_validator("url")
    @classmethod
    def validate_url_text(cls, value: str) -> str:
        if not value.strip() or any(ord(character) < 32 for character in value):
            raise ValueError("must be a nonblank URL-neutral locator")
        return value


class TransportResponse(_AccessModel):
    status: int = Field(strict=True, ge=100, le=599)
    final_url: str
    headers: tuple[Header, ...]
    body: bytes = Field(repr=False)

    @field_validator("final_url")
    @classmethod
    def validate_final_url_text(cls, value: str) -> str:
        if not value.strip() or any(ord(character) < 32 for character in value):
            raise ValueError("must be a nonblank URL-neutral locator")
        return value


__all__ = (
    "BoundedByteStream",
    "Header",
    "TransportRequest",
    "TransportResponse",
)
