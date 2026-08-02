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
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    provenance_id: ProvenanceId
    source_kind: SourceKind
    source_name: str
    source_record_id: str | None
    observed_at: UtcTimestamp
    input_sha256: Sha256 | None
    parameters_sha256: Sha256 | None

    @field_validator("source_name")
    @classmethod
    def validate_source_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must be a nonblank string")
        return unicodedata.normalize("NFC", value)

    @field_validator("source_record_id")
    @classmethod
    def normalize_source_record_id(cls, value: str | None) -> str | None:
        return None if value is None else unicodedata.normalize("NFC", value)
