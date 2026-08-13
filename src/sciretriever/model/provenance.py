"""The immutable seven-field provenance contract shared by Model modules."""

from __future__ import annotations

import unicodedata

from pydantic import BaseModel, ConfigDict, field_validator

from sciretriever.model.primitives import (
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
)


class Provenance(BaseModel):
    """A source trace without credentials, I/O objects, or business state."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )

    provenance_id: ProvenanceId
    source_kind: SourceKind
    source_name: str
    source_record_id: str | None
    observed_at: UtcTimestamp
    input_sha256: Sha256 | None
    parameters_sha256: Sha256 | None

    @field_validator("source_kind", mode="before")
    @classmethod
    def validate_source_kind(cls, value: object) -> SourceKind:
        if isinstance(value, SourceKind):
            return value
        if isinstance(value, str):
            try:
                return SourceKind(value)
            except ValueError as error:
                raise ValueError("must be a supported source kind") from error
        raise TypeError("must be a supported source kind")

    @field_validator("source_name")
    @classmethod
    def validate_source_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must be a nonblank string")
        return unicodedata.normalize("NFC", value)

    @field_validator("source_record_id")
    @classmethod
    def validate_source_record_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not value.strip():
            raise ValueError("must be a nonblank string or null")
        return unicodedata.normalize("NFC", value)


__all__ = ("Provenance",)
