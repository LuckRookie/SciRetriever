from __future__ import annotations

import unicodedata

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import (
    CitationDirection,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
    WorkId,
)


class _SourceModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class Provenance(_SourceModel):
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


from sciretriever.model.execution import FailureEvidence  # noqa: E402


class MetadataDiscoveryRequest(_SourceModel):
    query: str
    year_from: int | None
    year_to: int | None
    limit: int = Field(ge=1)

    @field_validator("query")
    @classmethod
    def validate_query(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must be nonblank text")
        return value

    @model_validator(mode="after")
    def validate_year_range(self) -> MetadataDiscoveryRequest:
        if (
            self.year_from is not None
            and self.year_to is not None
            and self.year_from > self.year_to
        ):
            raise ValueError("year range must be ordered")
        return self


class MetadataObservation(_SourceModel):
    provider: str
    provider_record_id: str
    title: str
    authors: tuple[str, ...]
    publication_year: int | None
    identifiers: tuple[Identifier, ...]
    abstract: str | None

    @field_validator("provider", "provider_record_id", "title")
    @classmethod
    def validate_nonblank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must be nonblank text")
        return value


class ProviderDiscoveryResult(_SourceModel):
    provider: str
    observations: tuple[MetadataObservation, ...]
    failure: FailureEvidence | None


class CitationDiscoveryRequest(_SourceModel):
    seed: WorkId
    direction: CitationDirection
    limit: int = Field(ge=1)


class CitationObservation(_SourceModel):
    provider: str
    source_work_id: WorkId
    target_identifier: Identifier
    direction: CitationDirection


class ProviderCitationResult(_SourceModel):
    provider: str
    observations: tuple[CitationObservation, ...]
    failure: FailureEvidence | None
