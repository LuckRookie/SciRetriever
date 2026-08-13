"""Integrity-checked conversion of Parser Markdown and referenced resources."""

from __future__ import annotations

import hashlib
import io
from contextlib import AbstractContextManager, closing
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import BinaryIO, Final, NoReturn

from pydantic import ValidationError

from sciretriever.model.parsing import ParserArtifactRef
from sciretriever.model.primitives import Sha256, sha256_digest
from sciretriever.parsing.markdown import (
    MarkdownConversionBounds,
    MarkdownConversionError,
    MarkdownResourceUse,
    canonical_resource_path,
    normalize_parser_markdown,
)
from sciretriever.parsing.ports import (
    ParserArtifactContent,
    StagedParserArtifact,
    StagedParserResource,
)

_READ_CHUNK_BYTES: Final[int] = 1024 * 1024
_MEDIA_BY_SUFFIX: Final[dict[str, str]] = {
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".tex": "text/plain",
    ".txt": "text/plain",
    ".webp": "image/webp",
}


class ParserResourceConversionError(ValueError):
    """Stable, path-free rejection of staged Parser artifacts."""

    _CODES = frozenset(
        {
            "markdown-artifact-invalid",
            "resource-reference-invalid",
            "resource-reference-duplicate",
            "resource-reference-missing",
            "resource-artifact-invalid",
            "resource-budget-exceeded",
        }
    )

    def __init__(self, code: str) -> None:
        if code not in self._CODES:
            raise ValueError("unknown Parser resource conversion error code")
        self.code = code
        super().__init__(f"parser resource conversion rejected ({code})")

    def __repr__(self) -> str:
        return f"ParserResourceConversionError(code={self.code!r})"


def _fail(code: str) -> NoReturn:
    raise ParserResourceConversionError(code) from None


@dataclass(frozen=True, slots=True)
class ParserResourceBounds:
    """Hard limits for resources retained by one normalized Parser result."""

    max_resource_count: int = 4096
    max_resource_bytes: int = 32 * 1024 * 1024
    max_total_resource_bytes: int = 128 * 1024 * 1024

    def __post_init__(self) -> None:
        for value in (
            self.max_resource_count,
            self.max_resource_bytes,
            self.max_total_resource_bytes,
        ):
            if type(value) is not int or value <= 0:
                raise ValueError("Parser resource bounds must be positive integers")


class _MemoryArtifactContent:
    """Path-free immutable bytes that outlive private archive staging."""

    __slots__ = ("_payload",)

    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def open(self) -> AbstractContextManager[BinaryIO]:
        return closing(io.BytesIO(self._payload))

    def __repr__(self) -> str:
        return "_MemoryArtifactContent(<redacted>)"


@dataclass(frozen=True, slots=True)
class NormalizedParserArtifacts:
    """Normalized staged Markdown and only its actually referenced resources."""

    markdown: StagedParserArtifact = field(repr=False)
    resources: tuple[StagedParserResource, ...] = field(repr=False)


def _resource_bounds(value: ParserResourceBounds | None) -> ParserResourceBounds:
    if value is None:
        return ParserResourceBounds()
    if not isinstance(value, ParserResourceBounds):
        raise TypeError("resource_bounds must be ParserResourceBounds")
    return value


def _markdown_bounds(value: MarkdownConversionBounds | None) -> MarkdownConversionBounds:
    if value is None:
        return MarkdownConversionBounds()
    if not isinstance(value, MarkdownConversionBounds):
        raise TypeError("markdown_bounds must be MarkdownConversionBounds")
    return value


def _validated_descriptor(value: object, *, markdown: bool) -> ParserArtifactRef:
    code = "markdown-artifact-invalid" if markdown else "resource-artifact-invalid"
    if not isinstance(value, ParserArtifactRef):
        _fail(code)
    if (
        not isinstance(value.sha256, Sha256)
        or type(value.media_type) is not str
        or not value.media_type.strip()
        or type(value.byte_size) is not int
        or value.byte_size <= 0
        or (markdown and value.media_type != "text/markdown")
    ):
        _fail(code)
    try:
        checked = ParserArtifactRef.model_validate(value.model_dump())
    except (ValidationError, TypeError, ValueError):
        _fail(code)
    if checked != value:
        _fail(code)
    return checked


def _read_verified(
    staged: object,
    *,
    markdown: bool,
    max_bytes: int,
    oversize_code: str,
) -> tuple[ParserArtifactRef, bytes]:
    code = "markdown-artifact-invalid" if markdown else "resource-artifact-invalid"
    if not isinstance(staged, StagedParserArtifact):
        _fail(code)
    descriptor = _validated_descriptor(staged.artifact, markdown=markdown)
    if descriptor.byte_size > max_bytes:
        _fail(oversize_code)
    if not isinstance(staged.content, ParserArtifactContent):
        _fail(code)

    payload = _read_content(
        staged.content,
        descriptor,
        max_bytes=max_bytes,
        code=code,
        oversize_code=oversize_code,
    )
    return descriptor, payload


def _read_content(
    content: ParserArtifactContent,
    descriptor: ParserArtifactRef,
    *,
    max_bytes: int,
    code: str,
    oversize_code: str,
) -> bytes:
    """Read one declared artifact in bounded chunks and verify its identity."""

    digest = hashlib.sha256()
    chunks: list[bytes] = []
    byte_size = 0
    try:
        with content.open() as stream:
            while True:
                chunk = stream.read(_READ_CHUNK_BYTES)
                if type(chunk) is not bytes:
                    _fail(code)
                if not chunk:
                    break
                byte_size += len(chunk)
                if byte_size > max_bytes:
                    _fail(oversize_code)
                if byte_size > descriptor.byte_size:
                    _fail(code)
                digest.update(chunk)
                chunks.append(chunk)
    except ParserResourceConversionError:
        raise
    except Exception:
        _fail(code)
    if byte_size != descriptor.byte_size or digest.hexdigest() != descriptor.sha256.root:
        _fail(code)
    return b"".join(chunks)


def _media_matches(reference: str, media_type: str, payload: bytes) -> bool:  # noqa: C901
    suffix = PurePosixPath(reference).suffix.casefold()
    expected = _MEDIA_BY_SUFFIX.get(suffix, "application/octet-stream")
    if media_type != expected:
        return False
    if expected == "image/png":
        return payload.startswith(b"\x89PNG\r\n\x1a\n")
    if expected == "image/jpeg":
        return len(payload) >= 4 and payload.startswith(b"\xff\xd8\xff")
    if expected == "image/gif":
        return payload.startswith((b"GIF87a", b"GIF89a"))
    if expected == "image/webp":
        return len(payload) >= 12 and payload[:4] == b"RIFF" and payload[8:12] == b"WEBP"
    if expected == "image/avif":
        return len(payload) >= 12 and payload[4:8] == b"ftyp" and b"avif" in payload[8:32]
    if expected == "image/bmp":
        return payload.startswith(b"BM")
    if expected == "application/pdf":
        return payload.startswith(b"%PDF-")
    if expected.startswith("text/") or expected in {"application/json", "image/svg+xml"}:
        try:
            decoded = payload.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return False
        if expected == "image/svg+xml":
            return "<svg" in decoded[:4096].casefold()
    return bool(payload)


def _candidate_index(
    candidates: tuple[StagedParserResource, ...],
    *,
    markdown_bounds: MarkdownConversionBounds,
) -> dict[str, StagedParserResource]:
    by_reference: dict[str, StagedParserResource] = {}
    folded_references: set[str] = set()
    for candidate in candidates:
        if not isinstance(candidate, StagedParserResource):
            _fail("resource-reference-invalid")
        try:
            canonical = canonical_resource_path(
                candidate.reference,
                bounds=markdown_bounds,
            )
        except MarkdownConversionError:
            _fail("resource-reference-invalid")
        folded = canonical.casefold()
        if canonical in by_reference or folded in folded_references:
            _fail("resource-reference-duplicate")
        by_reference[canonical] = candidate
        folded_references.add(folded)
    return by_reference


def _converted_resources(
    uses: tuple[MarkdownResourceUse, ...],
    *,
    candidates: dict[str, StagedParserResource],
    bounds: ParserResourceBounds,
) -> tuple[StagedParserResource, ...]:
    output: list[StagedParserResource] = []
    total_bytes = 0
    for use in uses:
        candidate = candidates.get(use.source_reference)
        if candidate is None:
            _fail("resource-reference-missing")
        descriptor, payload = _read_verified(
            candidate.artifact,
            markdown=False,
            max_bytes=bounds.max_resource_bytes,
            oversize_code="resource-budget-exceeded",
        )
        total_bytes += len(payload)
        if total_bytes > bounds.max_total_resource_bytes:
            _fail("resource-budget-exceeded")
        if not _media_matches(use.reference, descriptor.media_type, payload):
            _fail("resource-artifact-invalid")
        output.append(
            StagedParserResource(
                reference=use.reference,
                artifact=StagedParserArtifact(
                    artifact=descriptor,
                    content=_MemoryArtifactContent(payload),
                ),
            )
        )
    return tuple(sorted(output, key=lambda item: item.reference))


def convert_parser_artifacts(
    markdown: StagedParserArtifact,
    *,
    markdown_source_reference: str,
    candidates: tuple[StagedParserResource, ...],
    markdown_bounds: MarkdownConversionBounds | None = None,
    resource_bounds: ParserResourceBounds | None = None,
) -> NormalizedParserArtifacts:
    """Normalize one staged Markdown artifact and retain exactly its resources.

    Candidate resources are treated as untrusted.  Only candidates referenced
    by real Markdown image/resource syntax are opened and copied into bounded,
    path-free immutable byte capabilities.  Private JSON, layout files, origin
    copies, and unreferenced images therefore never enter the returned value.
    """

    checked_markdown_bounds = _markdown_bounds(markdown_bounds)
    checked_resource_bounds = _resource_bounds(resource_bounds)
    _descriptor, markdown_payload = _read_verified(
        markdown,
        markdown=True,
        max_bytes=checked_markdown_bounds.max_markdown_bytes,
        oversize_code="markdown-artifact-invalid",
    )
    try:
        normalized = normalize_parser_markdown(
            markdown_payload,
            source_reference=markdown_source_reference,
            bounds=checked_markdown_bounds,
        )
    except MarkdownConversionError as error:
        if error.code in {"markdown-invalid", "markdown-budget-exceeded"}:
            _fail("markdown-artifact-invalid")
        raise

    if not isinstance(candidates, tuple):
        raise TypeError("candidates must be a tuple")
    if (
        len(candidates) > checked_resource_bounds.max_resource_count
        or len(normalized.resources) > checked_resource_bounds.max_resource_count
    ):
        _fail("resource-budget-exceeded")

    by_reference = _candidate_index(
        candidates,
        markdown_bounds=checked_markdown_bounds,
    )
    output = _converted_resources(
        normalized.resources,
        candidates=by_reference,
        bounds=checked_resource_bounds,
    )

    normalized_descriptor = ParserArtifactRef(
        sha256=sha256_digest(normalized.payload),
        media_type="text/markdown",
        byte_size=len(normalized.payload),
    )
    return NormalizedParserArtifacts(
        markdown=StagedParserArtifact(
            artifact=normalized_descriptor,
            content=_MemoryArtifactContent(normalized.payload),
        ),
        resources=output,
    )


def validate_normalized_parser_artifacts(
    markdown: StagedParserArtifact,
    *,
    resources: tuple[StagedParserResource, ...],
    markdown_bounds: MarkdownConversionBounds | None = None,
    resource_bounds: ParserResourceBounds | None = None,
) -> NormalizedParserArtifacts:
    """Accept already-public Markdown and its exact staged resource closure.

    This is the single P2 gate used by the Parsing service after an adapter has
    produced parser-neutral output.  It deliberately reuses the conversion
    kernel for bounded reads, URI/path parsing, reference canonicalization,
    media/signature checks, and path-free byte capabilities.  Unlike adapter
    conversion, it rejects any rewrite and every unreferenced staged resource.
    """

    if not isinstance(resources, tuple):
        _fail("resource-reference-invalid")
    try:
        normalized = convert_parser_artifacts(
            markdown,
            markdown_source_reference="parser-result.md",
            candidates=resources,
            markdown_bounds=markdown_bounds,
            resource_bounds=resource_bounds,
        )
    except ParserResourceConversionError:
        raise
    except MarkdownConversionError as error:
        code = (
            "markdown-artifact-invalid"
            if error.code in {"markdown-invalid", "markdown-budget-exceeded"}
            else "resource-reference-invalid"
        )
        _fail(code)

    if normalized.markdown.artifact != markdown.artifact:
        _fail("resource-reference-invalid")
    declared_references = tuple(sorted(resource.reference for resource in resources))
    accepted_references = tuple(resource.reference for resource in normalized.resources)
    if declared_references != accepted_references:
        _fail("resource-reference-invalid")
    return normalized


__all__ = (
    "NormalizedParserArtifacts",
    "ParserResourceBounds",
    "ParserResourceConversionError",
    "convert_parser_artifacts",
    "validate_normalized_parser_artifacts",
)
