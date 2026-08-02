from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator

from sciretriever.model.analysis import AnalysisProposalV1
from sciretriever.model.documents import LightDocumentV1
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


class LLMRequest(_LlmModel):
    document: LightDocumentV1 = Field(repr=False)
    model: str = Field(min_length=1, max_length=512)
    max_output_tokens: int = Field(strict=True, ge=1)

    @field_validator("model")
    @classmethod
    def validate_model_identity(cls, value: str) -> str:
        if not value.strip():
            raise _LlmValidationError("must be a nonblank string")
        return value


class LLMProvenance(_LlmModel):
    provider: str = Field(min_length=1, max_length=256)
    model: str = Field(min_length=1, max_length=512)
    input_sha256: Sha256
    parameters_sha256: Sha256

    @field_validator("provider", "model")
    @classmethod
    def validate_identity_text(cls, value: str) -> str:
        if not value.strip():
            raise _LlmValidationError("must be a nonblank string")
        return value


class LLMStructuredResponse(_LlmModel):
    proposal: AnalysisProposalV1 = Field(repr=False)
    provenance: LLMProvenance


__all__ = (
    "LLMProvenance",
    "LLMRequest",
    "LLMStructuredResponse",
)
