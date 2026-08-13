"""Path-free Ports and private exchange values owned by Analysis.

The public neutral exchange values remain in :mod:`sciretriever.model.llm`.
This module owns the private prompt, bounded structured input, response schema,
and cancellation handle needed by Analysis provider adapters.  None of those
values may cross the Analysis business API or become persistent provenance.
"""

from __future__ import annotations

import json
import math
import re
import threading
import unicodedata
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from typing import BinaryIO, NoReturn, Protocol, cast, runtime_checkable

from sciretriever.model.analysis import ArtifactRef
from sciretriever.model.llm import LLMRequest, LLMStructuredResponse
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.parsing import ParserArtifactRef, ParserResult
from sciretriever.model.primitives import (
    AssetId,
    LiteratureId,
    Sha256,
    sha256_digest,
)
from sciretriever.model.report import StableFailure

_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_MAX_PROMPT_VERSION_BYTES = 1_024
_HARD_MAX_PROMPT_BYTES = 1_048_576
_HARD_MAX_INPUT_BYTES = 16_777_216
_HARD_MAX_SCHEMA_BYTES = 1_048_576


def _runtime_value(value: object) -> object:
    """Prevent static annotations from replacing intentional runtime checks."""

    return value


class _StrictJsonError(ValueError):
    pass


def _duplicate_key(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _StrictJsonError("structured JSON contains a duplicate key")
        result[key] = value
    return result


def _nonfinite_constant(value: str) -> NoReturn:
    del value
    raise _StrictJsonError("structured JSON contains a non-finite number")


def parse_strict_json_object(value: object) -> dict[str, object]:
    """Parse one finite, duplicate-free UTF-8 JSON object.

    The raised messages are fixed and never include the rejected bytes.  This
    helper intentionally validates syntax only; Analysis stage code owns every
    metadata/content/reference-lookup business schema.
    """

    if not isinstance(value, (str, bytes)):
        raise TypeError("structured JSON must be text or bytes")
    try:
        text = value.decode("utf-8", errors="strict") if isinstance(value, bytes) else value
        parsed = json.loads(
            text,
            object_pairs_hook=_duplicate_key,
            parse_constant=_nonfinite_constant,
        )
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
        _StrictJsonError,
        RecursionError,
        ValueError,
    ):
        raise ValueError("structured JSON must be one strict UTF-8 object") from None
    if not isinstance(parsed, dict):
        raise ValueError("structured JSON must be one strict UTF-8 object")
    result = cast(dict[str, object], parsed)
    try:
        json.dumps(result, ensure_ascii=False, allow_nan=False).encode("utf-8", errors="strict")
    except (TypeError, ValueError, UnicodeEncodeError, RecursionError):
        raise ValueError("structured JSON must be one strict UTF-8 object") from None
    return result


def canonical_json_bytes(value: object) -> bytes:
    """Encode a private, already-validated parameter value deterministically."""

    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError, RecursionError):
        raise ValueError("provider parameters are not canonical JSON") from None


def utf8_size(value: str) -> int:
    if type(value) is not str:
        raise TypeError("bounded value must be text")
    try:
        return len(value.encode("utf-8", errors="strict"))
    except UnicodeEncodeError:
        raise ValueError("bounded value must be valid UTF-8 text") from None


class AnalysisLLMFailure(RuntimeError):
    """Expected provider/access/protocol failure, already stable and redacted."""

    _MESSAGE = "analysis language-model provider call failed"

    def __init__(self, failure: object) -> None:
        if not isinstance(failure, StableFailure):
            raise TypeError("failure must be a StableFailure")
        super().__init__(self._MESSAGE)
        self.failure = failure

    def __repr__(self) -> str:
        return "<AnalysisLLMFailure>"


@dataclass(frozen=True, slots=True, repr=False)
class AnalysisLLMCall:
    """One private Analysis call around a neutral request descriptor."""

    request: LLMRequest
    prompt_version: str
    prompt: str = field(repr=False)
    structured_input: str = field(repr=False)
    response_schema: str = field(repr=False)
    cancel_event: threading.Event | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        request_value = _runtime_value(self.request)
        if not isinstance(request_value, LLMRequest):
            raise TypeError("request must be an LLMRequest")
        version = _prompt_version(self.prompt_version)
        object.__setattr__(self, "prompt_version", version)
        _bounded_nonblank_text(
            self.prompt,
            maximum_bytes=_HARD_MAX_PROMPT_BYTES,
            field_name="prompt",
        )
        _bounded_nonblank_text(
            self.structured_input,
            maximum_bytes=_HARD_MAX_INPUT_BYTES,
            field_name="structured input",
        )
        _bounded_nonblank_text(
            self.response_schema,
            maximum_bytes=_HARD_MAX_SCHEMA_BYTES,
            field_name="response schema",
        )
        parse_strict_json_object(self.structured_input)
        parse_strict_json_object(self.response_schema)
        if sha256_digest(self.structured_input.encode("utf-8")) != self.request.input_sha256:
            raise ValueError("structured input hash does not match the neutral request")
        if self.cancel_event is not None and not (
            hasattr(self.cancel_event, "is_set") and callable(self.cancel_event.is_set)
        ):
            raise TypeError("cancel_event must expose is_set()")

    def __repr__(self) -> str:
        return f"<AnalysisLLMCall kind={self.request.kind.value}>"


@dataclass(frozen=True, slots=True)
class LLMProviderLimits:
    """Request-local hard limits applied before and during provider access."""

    max_prompt_bytes: int = 131_072
    max_input_bytes: int = 8_388_608
    max_schema_bytes: int = 262_144
    max_request_bytes: int = 10_000_000
    max_response_bytes: int = 10_000_000
    max_result_bytes: int = 8_388_608
    max_output_tokens: int = 131_072
    connect_timeout_seconds: float = 10.0
    read_timeout_seconds: float = 120.0
    overall_timeout_seconds: float = 180.0
    max_redirects: int = 0
    max_retries: int = 0

    def __post_init__(self) -> None:
        for field_name in (
            "max_prompt_bytes",
            "max_input_bytes",
            "max_schema_bytes",
            "max_request_bytes",
            "max_response_bytes",
            "max_result_bytes",
            "max_output_tokens",
        ):
            value = getattr(self, field_name)
            if type(value) is not int or value < 1:
                raise ValueError(f"{field_name} must be a positive integer")
        for field_name in (
            "connect_timeout_seconds",
            "read_timeout_seconds",
            "overall_timeout_seconds",
        ):
            value = getattr(self, field_name)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise TypeError(f"{field_name} must be a number")
            normalized = float(value)
            if not math.isfinite(normalized) or normalized <= 0:
                raise ValueError(f"{field_name} must be finite and positive")
            object.__setattr__(self, field_name, normalized)
        if self.overall_timeout_seconds < max(
            self.connect_timeout_seconds,
            self.read_timeout_seconds,
        ):
            raise ValueError("overall timeout must cover each phase timeout")
        if type(self.max_redirects) is not int or self.max_redirects != 0:
            raise ValueError("Analysis provider redirects must be disabled")
        if type(self.max_retries) is not int or self.max_retries != 0:
            raise ValueError("Analysis provider POST retries must be disabled")


@runtime_checkable
class AnalysisLLMPort(Protocol):
    """The only provider-level LLM capability visible inside Analysis."""

    @property
    def provider_name(self) -> str: ...

    def complete(self, call: AnalysisLLMCall) -> LLMStructuredResponse: ...


@dataclass(frozen=True, slots=True)
class ContentInputIdentity:
    """The complete CAS identity rechecked around both Analysis stages."""

    literature_id: LiteratureId
    primary_asset_id: AssetId
    primary_pdf_sha256: Sha256
    parser_result_sha256: Sha256
    input_metadata_revision: int
    input_metadata_sha256: Sha256

    def __post_init__(self) -> None:
        literature_id = _runtime_value(self.literature_id)
        primary_asset_id = _runtime_value(self.primary_asset_id)
        primary_pdf_sha256 = _runtime_value(self.primary_pdf_sha256)
        parser_result_sha256 = _runtime_value(self.parser_result_sha256)
        input_metadata_sha256 = _runtime_value(self.input_metadata_sha256)
        if not isinstance(literature_id, LiteratureId):
            raise TypeError("literature_id must be LiteratureId")
        if not isinstance(primary_asset_id, AssetId):
            raise TypeError("primary_asset_id must be AssetId")
        if not isinstance(primary_pdf_sha256, Sha256):
            raise TypeError("primary_pdf_sha256 must be Sha256")
        if not isinstance(parser_result_sha256, Sha256):
            raise TypeError("parser_result_sha256 must be Sha256")
        if type(self.input_metadata_revision) is not int or self.input_metadata_revision < 1:
            raise ValueError("input_metadata_revision must be a positive integer")
        if not isinstance(input_metadata_sha256, Sha256):
            raise TypeError("input_metadata_sha256 must be Sha256")


@dataclass(frozen=True, slots=True, repr=False)
class ContentAnalysisInput:
    """The exact current Literature view consumed by both Analysis stages."""

    literature_id: LiteratureId
    primary_asset_id: AssetId
    primary_pdf_sha256: Sha256
    parser_result: ParserResult = field(repr=False)
    initial_metadata: LiteratureMetadata = field(repr=False)
    input_metadata_revision: int
    input_metadata_sha256: Sha256
    user_observations: tuple[MetadataObservation, ...] = field(default=(), repr=False)

    def __post_init__(self) -> None:
        literature_id = _runtime_value(self.literature_id)
        primary_asset_id = _runtime_value(self.primary_asset_id)
        primary_pdf_sha256 = _runtime_value(self.primary_pdf_sha256)
        parser_result = _runtime_value(self.parser_result)
        initial_metadata = _runtime_value(self.initial_metadata)
        input_metadata_sha256 = _runtime_value(self.input_metadata_sha256)
        user_observations = _runtime_value(self.user_observations)
        if not isinstance(literature_id, LiteratureId):
            raise TypeError("literature_id must be LiteratureId")
        if not isinstance(primary_asset_id, AssetId):
            raise TypeError("primary_asset_id must be AssetId")
        if not isinstance(primary_pdf_sha256, Sha256):
            raise TypeError("primary_pdf_sha256 must be Sha256")
        if not isinstance(parser_result, ParserResult):
            raise TypeError("parser_result must be ParserResult")
        if not isinstance(initial_metadata, LiteratureMetadata):
            raise TypeError("initial_metadata must be LiteratureMetadata")
        if type(self.input_metadata_revision) is not int or self.input_metadata_revision < 1:
            raise ValueError("input_metadata_revision must be a positive integer")
        if not isinstance(input_metadata_sha256, Sha256):
            raise TypeError("input_metadata_sha256 must be Sha256")
        if not isinstance(user_observations, tuple) or any(
            not isinstance(value, MetadataObservation)
            for value in cast(tuple[object, ...], user_observations)
        ):
            raise TypeError("user_observations must be MetadataObservation values")

    def __repr__(self) -> str:
        return "<ContentAnalysisInput>"

    def input_identity(self) -> ContentInputIdentity:
        return ContentInputIdentity(
            literature_id=self.literature_id,
            primary_asset_id=self.primary_asset_id,
            primary_pdf_sha256=self.primary_pdf_sha256,
            parser_result_sha256=self.parser_result.result_sha256,
            input_metadata_revision=self.input_metadata_revision,
            input_metadata_sha256=self.input_metadata_sha256,
        )


@dataclass(frozen=True, slots=True, repr=False)
class StagedContentMarkdown:
    """Canonical Markdown bytes offered to create-if-absent publication."""

    artifact: ArtifactRef
    content: bytes = field(repr=False)

    def __post_init__(self) -> None:
        artifact_value = _runtime_value(self.artifact)
        content_value = _runtime_value(self.content)
        if not isinstance(artifact_value, ArtifactRef):
            raise TypeError("artifact must be ArtifactRef")
        if type(content_value) is not bytes:
            raise TypeError("content must be bytes")
        if (
            artifact_value.media_type != "text/markdown"
            or not content_value
            or artifact_value.byte_size != len(content_value)
            or artifact_value.sha256 != sha256_digest(content_value)
        ):
            raise ValueError("content bytes must match the Markdown artifact")

    def __repr__(self) -> str:
        return f"<StagedContentMarkdown byte_size={self.artifact.byte_size}>"


@runtime_checkable
class AnalysisArtifactReadPort(Protocol):
    """Open one Parser artifact as a verified, context-managed stream."""

    def open_artifact(
        self,
        reference: ParserArtifactRef,
    ) -> AbstractContextManager[BinaryIO]: ...


@runtime_checkable
class AnalysisCurrentInputPort(Protocol):
    """Recheck the complete current PDF/ParserResult/metadata CAS identity."""

    def current_input_matches(self, identity: ContentInputIdentity) -> bool: ...


@runtime_checkable
class AnalysisArtifactPublicationPort(Protocol):
    """Create or reuse one immutable canonical Markdown object."""

    def publish_markdown(self, staged: StagedContentMarkdown) -> ArtifactRef: ...


def _prompt_version(value: object) -> str:
    if type(value) is not str:
        raise TypeError("prompt_version must be text")
    candidate = unicodedata.normalize("NFC", value.strip())
    if (
        not candidate
        or _CONTROL.search(candidate) is not None
        or utf8_size(candidate) > _MAX_PROMPT_VERSION_BYTES
    ):
        raise ValueError("prompt_version must be stable bounded text")
    return candidate


def _bounded_nonblank_text(value: object, *, maximum_bytes: int, field_name: str) -> str:
    if type(value) is not str:
        raise TypeError(f"{field_name} must be text")
    if not value.strip():
        raise ValueError(f"{field_name} must be nonblank")
    if utf8_size(value) > maximum_bytes:
        raise ValueError(f"{field_name} exceeds the hard Analysis boundary")
    return value


__all__ = (
    "AnalysisArtifactPublicationPort",
    "AnalysisArtifactReadPort",
    "AnalysisCurrentInputPort",
    "AnalysisLLMCall",
    "AnalysisLLMFailure",
    "AnalysisLLMPort",
    "ContentAnalysisInput",
    "ContentInputIdentity",
    "LLMProviderLimits",
    "StagedContentMarkdown",
)
