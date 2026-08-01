from __future__ import annotations

import re
from enum import Enum
from pathlib import Path
from typing import Annotated, Self
from urllib.parse import unquote, urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

PositiveInt = Annotated[int, Field(strict=True, ge=1)]
PositiveFloat = Annotated[float, Field(strict=True, gt=0, le=3600)]
SecretReference = Annotated[str, Field(pattern=r"^env:[A-Z][A-Z0-9_]{1,127}$")]
ProviderTuple = Annotated[tuple[str, ...], Field(min_length=1)]


class StrictConfigModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


class LLMProtocol(str, Enum):
    OPENAI = "openai"
    ANTHROPIC = "anthropic"


class ParserProtocol(str, Enum):
    LOOPBACK = "loopback"
    REMOTE = "remote"


class PathsConfig(StrictConfigModel):
    catalog: Path
    storage_root: Path

    @model_validator(mode="after")
    def validate_separation(self) -> Self:
        if _paths_overlap(self.catalog, self.storage_root):
            raise ValueError("catalog and storage_root must not overlap")
        return self


class CollectionConfig(StrictConfigModel):
    citation_providers: ProviderTuple
    topic_limit: Annotated[int, Field(strict=True, ge=1, le=100_000)] = 1000
    citation_max_new: Annotated[int, Field(strict=True, ge=1, le=100_000)] = 1000

    @field_validator("citation_providers", mode="before")
    @classmethod
    def parse_providers(cls, values: list[str] | tuple[str, ...]) -> tuple[str, ...]:
        return _parse_string_tuple(values)


class MetadataConfig(StrictConfigModel):
    providers: ProviderTuple
    timeout_seconds: PositiveFloat = 30.0
    max_concurrency: Annotated[int, Field(strict=True, ge=1, le=64)] = 4
    result_limit: Annotated[int, Field(strict=True, ge=1, le=100_000)] = 1000

    @field_validator("providers", mode="before")
    @classmethod
    def parse_providers(cls, values: list[str] | tuple[str, ...]) -> tuple[str, ...]:
        return _parse_string_tuple(values)


class AcquisitionConfig(StrictConfigModel):
    providers: ProviderTuple
    timeout_seconds: PositiveFloat = 30.0
    provider_concurrency: Annotated[int, Field(strict=True, ge=1, le=64)] = 4
    host_concurrency: Annotated[int, Field(strict=True, ge=1, le=16)] = 2
    max_asset_bytes: Annotated[int, Field(strict=True, ge=1024, le=2_147_483_648)] = 104_857_600

    @field_validator("providers", mode="before")
    @classmethod
    def parse_providers(cls, values: list[str] | tuple[str, ...]) -> tuple[str, ...]:
        return _parse_string_tuple(values)


class ParserConfig(StrictConfigModel):
    protocol: ParserProtocol
    base_url: str
    model: Annotated[str, Field(min_length=1, max_length=256)]
    secret_ref: SecretReference | None = Field(default=None, repr=False)
    timeout_seconds: PositiveFloat = 900.0
    remote_upload: bool = False
    max_pages: Annotated[int, Field(strict=True, ge=1, le=10_000)] = 2000
    max_blocks: Annotated[int, Field(strict=True, ge=1, le=2_000_000)] = 500_000
    max_source_units: Annotated[int, Field(strict=True, ge=1, le=1_000_000)] = 100_000

    @field_validator("protocol", mode="before")
    @classmethod
    def parse_protocol(cls, value: str | ParserProtocol) -> ParserProtocol:
        if not isinstance(value, str):
            raise ValueError("parser protocol must be a string")
        return ParserProtocol(value)

    @model_validator(mode="after")
    def validate_protocol(self) -> Self:
        parsed = _parse_base_url(self.base_url)
        match self.protocol:
            case ParserProtocol.LOOPBACK:
                if parsed.scheme != "http" or parsed.hostname not in {
                    "localhost",
                    "127.0.0.1",
                    "::1",
                }:
                    raise ValueError("loopback parser requires an explicit loopback HTTP origin")
                if self.secret_ref is not None or self.remote_upload:
                    raise ValueError("loopback parser forbids secret_ref and remote_upload")
            case ParserProtocol.REMOTE:
                if parsed.scheme != "https" or self.secret_ref is None or not self.remote_upload:
                    raise ValueError("remote parser requires HTTPS, secret_ref, and remote_upload")
        return self


class AnalysisConfig(StrictConfigModel):
    protocol: LLMProtocol
    base_url: str
    model: Annotated[str, Field(min_length=1, max_length=256)]
    secret_ref: SecretReference = Field(repr=False)
    timeout_seconds: PositiveFloat = 120.0
    max_output_tokens: Annotated[int, Field(strict=True, ge=1, le=131_072)] = 16_384
    max_input_characters: Annotated[int, Field(strict=True, ge=1, le=10_000_000)] = 200_000
    max_source_units: Annotated[int, Field(strict=True, ge=1, le=100_000)] = 5000

    @field_validator("protocol", mode="before")
    @classmethod
    def parse_protocol(cls, value: str | LLMProtocol) -> LLMProtocol:
        if not isinstance(value, str):
            raise ValueError("analysis protocol must be a string")
        return LLMProtocol(value)

    @model_validator(mode="after")
    def validate_base_url(self) -> Self:
        parsed = _parse_base_url(self.base_url)
        if parsed.scheme != "https":
            raise ValueError("analysis base_url must use HTTPS")
        return self


class ContentConfig(StrictConfigModel):
    acquisition: AcquisitionConfig
    parser: ParserConfig
    analysis: AnalysisConfig


class BatchingConfig(StrictConfigModel):
    max_targets: Annotated[int, Field(strict=True, ge=1, le=100_000)] = 1000
    max_concurrency: Annotated[int, Field(strict=True, ge=1, le=64)] = 4


class InteroperabilityConfig(StrictConfigModel):
    max_input_bytes: Annotated[int, Field(strict=True, ge=1024, le=1_073_741_824)] = 67_108_864
    max_records: Annotated[int, Field(strict=True, ge=1, le=1_000_000)] = 100_000


class CredentialsConfig(StrictConfigModel):
    metadata: SecretReference | None = Field(default=None, repr=False)
    acquisition: SecretReference | None = Field(default=None, repr=False)


class ExtensionsConfig(StrictConfigModel):
    namespaces: tuple[Annotated[str, Field(pattern=r"^[a-z][a-z0-9.-]{0,127}$")], ...] = ()
    max_results: Annotated[int, Field(strict=True, ge=1, le=1000)] = 100

    @field_validator("namespaces", mode="before")
    @classmethod
    def parse_namespaces(cls, values: list[str] | tuple[str, ...]) -> tuple[str, ...]:
        return _parse_string_tuple(values)


class TargetConfig(StrictConfigModel):
    schema_version: Annotated[int, Field(strict=True, ge=2, le=2)]
    paths: PathsConfig
    collection: CollectionConfig
    metadata: MetadataConfig
    content: ContentConfig
    batching: BatchingConfig
    interoperability: InteroperabilityConfig
    credentials: CredentialsConfig
    extensions: ExtensionsConfig


def _parse_base_url(value: str):
    if any(character.isspace() or ord(character) < 32 for character in value):
        raise ValueError("base_url contains unsafe characters")
    parsed = urlsplit(value)
    decoded_path = unquote(parsed.path).replace("\\", "/")
    if (
        not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or "//" in decoded_path
        or any(segment == ".." for segment in decoded_path.split("/"))
        or re.search(r"%2f|%5c", value, re.IGNORECASE)
    ):
        raise ValueError("base_url must be a safe origin or path without credentials or query data")
    return parsed


def _paths_overlap(left: Path, right: Path) -> bool:
    return left == right or left in right.parents or right in left.parents


def _parse_string_tuple(values: list[str] | tuple[str, ...]) -> tuple[str, ...]:
    if not isinstance(values, (list, tuple)) or any(not isinstance(value, str) for value in values):
        raise ValueError("expected an array of strings")
    parsed = tuple(values)
    if len(parsed) != len(set(parsed)):
        raise ValueError("duplicate values are not allowed")
    return parsed


__all__ = (
    "LLMProtocol",
    "ParserProtocol",
    "TargetConfig",
)
