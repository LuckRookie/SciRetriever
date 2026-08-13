"""Neutral LLM exchange values owned by the Analysis boundary.

This module deliberately does not know about prompts, vendor SDK response
objects, provider credentials, or Analysis proposal models.  Analysis keeps
the private prompt and validates the returned text against its own business
contract; this module only binds a request to its input/model and carries the
already-normalized structured result text with de-identified provenance.
"""

from __future__ import annotations

from enum import Enum, unique

from pydantic import BaseModel, ConfigDict, Field, field_validator

from sciretriever.model.primitives import Sha256


class _LlmValidationError(ValueError):
    pass


class _LlmModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


@unique
class LLMRequestKind(str, Enum):
    """The three Analysis-owned meanings of a neutral LLM call."""

    METADATA = "metadata"
    CONTENT = "content"
    REFERENCE_LOOKUP = "reference-lookup"


class LLMRequest(_LlmModel):
    """A bounded request descriptor without prompt or credential material."""

    kind: LLMRequestKind
    input_sha256: Sha256
    model: str = Field(max_length=512)
    max_output_tokens: int = Field(strict=True, ge=1)

    @field_validator("kind", mode="before")
    @classmethod
    def validate_kind(cls, value: object) -> LLMRequestKind:
        if isinstance(value, LLMRequestKind):
            return value
        if isinstance(value, str):
            try:
                return LLMRequestKind(value)
            except ValueError as error:
                raise _LlmValidationError("must be a supported LLM request kind") from error
        raise TypeError("must be a supported LLM request kind")

    @field_validator("model")
    @classmethod
    def validate_model_identity(cls, value: str) -> str:
        candidate = value.strip()
        if not candidate:
            raise _LlmValidationError("model must be a nonblank string")
        return candidate


class LLMProvenance(_LlmModel):
    """Provider/model identity and hashes needed for the current call only."""

    provider: str = Field(max_length=256)
    model: str = Field(max_length=512)
    input_sha256: Sha256
    parameters_sha256: Sha256

    @field_validator("provider", "model")
    @classmethod
    def validate_identity_text(cls, value: str) -> str:
        candidate = value.strip()
        if not candidate:
            raise _LlmValidationError("identity must be a nonblank string")
        return candidate


class LLMStructuredResponse(_LlmModel):
    """A provider-neutral structured-result text and its call provenance.

    ``result`` is intentionally text rather than an untyped dictionary.  Analysis
    owns the closed schema for metadata/content/reference lookup and parses the
    text at its boundary; arbitrary vendor JSON, SDK objects and unknown
    business fields cannot leak through this Model module.
    """

    result: str = Field(repr=False, min_length=1, max_length=10_000_000)
    provenance: LLMProvenance

    @field_validator("result")
    @classmethod
    def validate_result(cls, value: str) -> str:
        if not value.strip():
            raise _LlmValidationError("result must be a nonblank string")
        return value


__all__ = (
    "LLMProvenance",
    "LLMRequest",
    "LLMRequestKind",
    "LLMStructuredResponse",
)
