from __future__ import annotations

from enum import Enum
from pathlib import Path
from typing import Annotated

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field

PositiveInt = Annotated[int, Field(strict=True, ge=1)]
PositiveFloat = Annotated[float, Field(strict=True, gt=0, le=3600)]
SecretReference = Annotated[str, Field(strict=True, pattern=r"^env:[A-Z][A-Z0-9_]{1,127}$")]


class _ConfigurationFieldError(ValueError):
    pass


class LLMProtocol(str, Enum):
    OPENAI = "openai"
    ANTHROPIC = "anthropic"


class ParserProtocol(str, Enum):
    LOOPBACK = "loopback"
    REMOTE = "remote"


def _parse_path(value: str | Path) -> Path:
    if isinstance(value, Path):
        return value
    if isinstance(value, str):
        return Path(value)
    raise _ConfigurationFieldError("path must be a string")


def _parse_string_tuple(value: list[str] | tuple[str, ...]) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        raise _ConfigurationFieldError("value must be an array of strings")
    if any(not isinstance(item, str) for item in value):
        raise _ConfigurationFieldError("array values must be strings")
    parsed = tuple(value)
    if any(not item.strip() for item in parsed):
        raise _ConfigurationFieldError("array values must be nonblank")
    if len(parsed) != len(set(parsed)):
        raise _ConfigurationFieldError("array values must be unique")
    return parsed


def _validate_model_identifier(value: str) -> str:
    if not value or any(character.isspace() for character in value):
        raise _ConfigurationFieldError("model identifiers must be nonblank and whitespace-free")
    return value


def _parse_llm_protocol(value: str | LLMProtocol) -> LLMProtocol:
    if isinstance(value, LLMProtocol):
        return value
    if not isinstance(value, str):
        raise _ConfigurationFieldError("analysis protocol must be a string")
    try:
        return LLMProtocol(value)
    except ValueError as error:
        raise _ConfigurationFieldError("analysis protocol is unsupported") from error


def _parse_parser_protocol(value: str | ParserProtocol) -> ParserProtocol:
    if isinstance(value, ParserProtocol):
        return value
    if not isinstance(value, str):
        raise _ConfigurationFieldError("parser protocol must be a string")
    try:
        return ParserProtocol(value)
    except ValueError as error:
        raise _ConfigurationFieldError("parser protocol is unsupported") from error


class StrictConfigModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


PathValue = Annotated[Path, BeforeValidator(_parse_path)]
ProviderTuple = Annotated[
    tuple[str, ...], BeforeValidator(_parse_string_tuple), Field(min_length=1)
]
StringTuple = Annotated[tuple[str, ...], BeforeValidator(_parse_string_tuple)]
ModelIdentifier = Annotated[
    str,
    Field(strict=True, min_length=1, max_length=256),
    AfterValidator(_validate_model_identifier),
]


class PathsConfig(StrictConfigModel):
    catalog: PathValue
    storage_root: PathValue


class CollectionConfig(StrictConfigModel):
    citation_providers: ProviderTuple
    topic_limit: Annotated[int, Field(strict=True, ge=1, le=100_000)] = 1000
    citation_max_new: Annotated[int, Field(strict=True, ge=1, le=100_000)] = 1000


class SourcesConfig(StrictConfigModel):
    providers: ProviderTuple
    timeout_seconds: PositiveFloat = 30.0
    max_concurrency: Annotated[int, Field(strict=True, ge=1, le=64)] = 4
    result_limit: Annotated[int, Field(strict=True, ge=1, le=100_000)] = 1000


class AssetsConfig(StrictConfigModel):
    providers: ProviderTuple
    timeout_seconds: PositiveFloat = 30.0
    provider_concurrency: Annotated[int, Field(strict=True, ge=1, le=64)] = 4
    host_concurrency: Annotated[int, Field(strict=True, ge=1, le=16)] = 2
    max_asset_bytes: Annotated[int, Field(strict=True, ge=1024, le=2_147_483_648)] = 104_857_600


class ParsingConfig(StrictConfigModel):
    protocol: Annotated[ParserProtocol, BeforeValidator(_parse_parser_protocol)]
    base_url: Annotated[str, Field(strict=True, min_length=1, max_length=2048)]
    model: ModelIdentifier
    secret_ref: SecretReference | None = Field(default=None, repr=False)
    timeout_seconds: PositiveFloat = 900.0
    remote_upload: bool = False
    max_pages: Annotated[int, Field(strict=True, ge=1, le=10_000)] = 2000
    max_blocks: Annotated[int, Field(strict=True, ge=1, le=2_000_000)] = 500_000
    max_source_units: Annotated[int, Field(strict=True, ge=1, le=1_000_000)] = 100_000


class AnalysisConfig(StrictConfigModel):
    protocol: Annotated[LLMProtocol, BeforeValidator(_parse_llm_protocol)]
    base_url: Annotated[str, Field(strict=True, min_length=1, max_length=2048)]
    model: ModelIdentifier
    secret_ref: SecretReference = Field(repr=False)
    timeout_seconds: PositiveFloat = 120.0
    max_output_tokens: Annotated[int, Field(strict=True, ge=1, le=131_072)] = 16_384
    max_input_characters: Annotated[int, Field(strict=True, ge=1, le=10_000_000)] = 200_000
    max_source_units: Annotated[int, Field(strict=True, ge=1, le=100_000)] = 5000


class ExecutionConfig(StrictConfigModel):
    max_targets: Annotated[int, Field(strict=True, ge=1, le=100_000)] = 1000
    max_concurrency: Annotated[int, Field(strict=True, ge=1, le=64)] = 4


class LibraryConfig(StrictConfigModel):
    max_input_bytes: Annotated[int, Field(strict=True, ge=1024, le=1_073_741_824)] = 67_108_864
    max_records: Annotated[int, Field(strict=True, ge=1, le=1_000_000)] = 100_000
    namespaces: Annotated[
        tuple[Annotated[str, Field(pattern=r"^[a-z][a-z0-9.-]{0,127}$")], ...],
        BeforeValidator(_parse_string_tuple),
    ] = ()
    max_results: Annotated[int, Field(strict=True, ge=1, le=1000)] = 100


class AccessConfig(StrictConfigModel):
    pass


class CredentialsConfig(StrictConfigModel):
    metadata: SecretReference | None = Field(default=None, repr=False)
    acquisition: SecretReference | None = Field(default=None, repr=False)


class TargetConfig(StrictConfigModel):
    schema_version: Annotated[int, Field(strict=True, ge=2, le=2)]
    paths: PathsConfig
    collection: CollectionConfig
    sources: SourcesConfig
    assets: AssetsConfig
    parsing: ParsingConfig
    analysis: AnalysisConfig
    execution: ExecutionConfig
    library: LibraryConfig
    access: AccessConfig
    credentials: CredentialsConfig


__all__ = (
    "AccessConfig",
    "AnalysisConfig",
    "AssetsConfig",
    "CollectionConfig",
    "CredentialsConfig",
    "ExecutionConfig",
    "LLMProtocol",
    "LibraryConfig",
    "ModelIdentifier",
    "ParserProtocol",
    "ParsingConfig",
    "PathsConfig",
    "PositiveFloat",
    "PositiveInt",
    "ProviderTuple",
    "SecretReference",
    "SourcesConfig",
    "StringTuple",
    "TargetConfig",
)
