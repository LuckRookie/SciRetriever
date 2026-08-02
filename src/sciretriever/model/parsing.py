from __future__ import annotations

from enum import Enum, unique

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sciretriever.model.documents import LightDocumentV1
from sciretriever.model.primitives import AssetId, Sha256


class _ParsingValidationError(ValueError):
    pass


class _ParsingModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


@unique
class ParserTaskState(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class ParserRequest(_ParsingModel):
    pdf: bytes = Field(min_length=1, repr=False)
    asset_id: AssetId
    asset_sha256: Sha256
    resume_task_id: str | None = Field(
        default=None,
        max_length=1024,
        repr=False,
    )


class ParserTask(_ParsingModel):
    task_id: str = Field(max_length=1024)
    state: ParserTaskState
    archive: bytes | None = Field(default=None, repr=False)

    @model_validator(mode="after")
    def validate_archive_state(self) -> ParserTask:
        if (self.state is ParserTaskState.COMPLETED) != (self.archive is not None):
            raise _ParsingValidationError("completed parser tasks require archive bytes")
        if self.state is not ParserTaskState.COMPLETED and self.archive is not None:
            raise _ParsingValidationError("non-completed parser tasks cannot carry archive bytes")
        return self


class ParserProvenance(_ParsingModel):
    parser_name: str = Field(min_length=1, max_length=256)
    parser_version: str = Field(min_length=1, max_length=256)
    backend: str = Field(min_length=1, max_length=256)
    model: str = Field(min_length=1, max_length=512)
    parameters_sha256: Sha256
    input_sha256: Sha256
    task_id: str | None = Field(
        default=None,
        max_length=1024,
        repr=False,
    )

    @field_validator("parser_name", "parser_version", "backend", "model")
    @classmethod
    def validate_identity_text(cls, value: str) -> str:
        if not value.strip():
            raise _ParsingValidationError("must be a nonblank string")
        return value


class ParserResult(_ParsingModel):
    document: LightDocumentV1 = Field(repr=False)
    provenance: ParserProvenance


__all__ = (
    "ParserProvenance",
    "ParserRequest",
    "ParserResult",
    "ParserTask",
    "ParserTaskState",
)
