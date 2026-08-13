"""Fail-closed conversion of private MinerU 3.4.4 output archives.

The converter understands the selected ``vlm-engine`` archive profile only.
It validates the private JSON needed to establish backend, page, ordering, and
resource alignment, then delegates all public Markdown/resource normalization
to Parsing's shared conversion gate.  No MinerU JSON or archive path escapes
this module.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Final, NoReturn

from sciretriever.model.parsing import ParserArtifactRef
from sciretriever.parsing.archive import (
    ParserArchiveBounds,
    ParserArchiveError,
    ParserArchiveMember,
    extract_parser_archive,
)
from sciretriever.parsing.markdown import (
    MarkdownConversionBounds,
    MarkdownConversionError,
    canonical_resource_path,
)
from sciretriever.parsing.ports import (
    StagedParserArtifact,
    StagedParserResource,
)
from sciretriever.parsing.resources import (
    NormalizedParserArtifacts,
    ParserResourceBounds,
    ParserResourceConversionError,
    convert_parser_artifacts,
)

_READ_CHUNK_BYTES: Final[int] = 1024 * 1024
_MIDDLE_SUFFIX: Final[str] = "_middle.json"
_MODEL_SUFFIX: Final[str] = "_model.json"
_CONTENT_LIST_SUFFIX: Final[str] = "_content_list.json"
_SUPPORTED_BACKEND: Final[str] = "vlm"
_MEDIA_BY_SUFFIX: Final[dict[str, str]] = {
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".tex": "text/plain",
    ".txt": "text/plain",
    ".webp": "image/webp",
}


class MinerUConversionError(ValueError):
    """Stable, content-free rejection of one untrusted MinerU archive."""

    _CODES = frozenset(
        {
            "archive-invalid",
            "archive-budget",
            "primary-output-invalid",
            "json-invalid",
            "json-budget",
            "backend-mismatch",
            "page-mismatch",
            "content-list-invalid",
            "markdown-invalid",
            "resource-invalid",
        }
    )

    def __init__(self, code: str) -> None:
        if code not in self._CODES:
            raise ValueError("unknown MinerU conversion error code")
        self.code = code
        super().__init__(f"MinerU output conversion rejected ({code})")

    def __repr__(self) -> str:
        return f"MinerUConversionError(code={self.code!r})"


def _fail(code: str) -> NoReturn:
    raise MinerUConversionError(code) from None


@dataclass(frozen=True, slots=True)
class MinerUConversionBounds:
    """All effective local limits for one private MinerU archive."""

    archive_bounds: ParserArchiveBounds = field(default_factory=ParserArchiveBounds)
    markdown_bounds: MarkdownConversionBounds = field(default_factory=MarkdownConversionBounds)
    resource_bounds: ParserResourceBounds = field(default_factory=ParserResourceBounds)
    max_json_bytes: int = 16 * 1024 * 1024
    max_total_json_bytes: int = 32 * 1024 * 1024
    max_json_depth: int = 64
    max_json_elements: int = 1_000_000
    max_json_string_characters: int = 16 * 1024 * 1024

    def __post_init__(self) -> None:
        if not isinstance(self.archive_bounds, ParserArchiveBounds):
            raise TypeError("archive_bounds must be ParserArchiveBounds")
        if not isinstance(self.markdown_bounds, MarkdownConversionBounds):
            raise TypeError("markdown_bounds must be MarkdownConversionBounds")
        if not isinstance(self.resource_bounds, ParserResourceBounds):
            raise TypeError("resource_bounds must be ParserResourceBounds")
        for value in (
            self.max_json_bytes,
            self.max_total_json_bytes,
            self.max_json_depth,
            self.max_json_elements,
            self.max_json_string_characters,
        ):
            if type(value) is not int or value <= 0:
                raise ValueError("MinerU JSON bounds must be positive integers")


@dataclass(frozen=True, slots=True)
class ConvertedMinerUOutput:
    """Parser-neutral artifacts copied out of private archive staging."""

    page_count: int
    markdown: StagedParserArtifact = field(repr=False)
    resources: tuple[StagedParserResource, ...] = field(repr=False)


class _DuplicateJsonKey(ValueError):
    pass


class _InvalidJsonNumber(ValueError):
    pass


def _checked_bounds(value: MinerUConversionBounds | None) -> MinerUConversionBounds:
    if value is None:
        return MinerUConversionBounds()
    if not isinstance(value, MinerUConversionBounds):
        raise TypeError("bounds must be MinerUConversionBounds")
    return value


def _member_index(members: tuple[ParserArchiveMember, ...]) -> dict[str, ParserArchiveMember]:
    return {member.reference: member for member in members}


def _primary_members(
    members: tuple[ParserArchiveMember, ...],
) -> tuple[
    ParserArchiveMember,
    ParserArchiveMember,
    ParserArchiveMember,
    ParserArchiveMember,
]:
    middle_candidates = tuple(
        member for member in members if member.reference.endswith(_MIDDLE_SUFFIX)
    )
    if len(middle_candidates) != 1:
        _fail("primary-output-invalid")
    middle = middle_candidates[0]
    stem = middle.reference[: -len(_MIDDLE_SUFFIX)]
    if not stem:
        _fail("primary-output-invalid")
    by_reference = _member_index(members)
    markdown = by_reference.get(f"{stem}.md")
    model = by_reference.get(f"{stem}{_MODEL_SUFFIX}")
    content_list = by_reference.get(f"{stem}{_CONTENT_LIST_SUFFIX}")
    if markdown is None or model is None or content_list is None:
        _fail("primary-output-invalid")
    return markdown, middle, model, content_list


def _read_json_payload(
    member: ParserArchiveMember,
    *,
    bounds: MinerUConversionBounds,
) -> bytes:
    if member.byte_size <= 0:
        _fail("json-invalid")
    if member.byte_size > bounds.max_json_bytes:
        _fail("json-budget")
    chunks: list[bytes] = []
    byte_size = 0
    digest = hashlib.sha256()
    try:
        with member.content.open() as stream:
            while True:
                chunk = stream.read(_READ_CHUNK_BYTES)
                if type(chunk) is not bytes:
                    _fail("json-invalid")
                if not chunk:
                    break
                byte_size += len(chunk)
                if byte_size > member.byte_size or byte_size > bounds.max_json_bytes:
                    _fail("json-budget")
                digest.update(chunk)
                chunks.append(chunk)
    except MinerUConversionError:
        raise
    except Exception:
        _fail("json-invalid")
    if byte_size != member.byte_size or digest.hexdigest() != member.sha256.root:
        _fail("json-invalid")
    return b"".join(chunks)


def _object_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateJsonKey
        result[key] = value
    return result


def _invalid_constant(_value: str) -> NoReturn:
    raise _InvalidJsonNumber


def _finite_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise _InvalidJsonNumber
    return parsed


def _container_children(current: object) -> tuple[object, ...]:
    if isinstance(current, dict):
        for key in current:
            if type(key) is not str:
                _fail("json-invalid")
        return tuple(current.values())
    if isinstance(current, list):
        return tuple(current)
    if current is not None and type(current) not in {bool, int, float, str}:
        _fail("json-invalid")
    return ()


def _validate_json_budget(value: object, bounds: MinerUConversionBounds) -> None:
    stack: list[tuple[object, int]] = [(value, 1)]
    elements = 0
    string_characters = 0
    while stack:
        current, depth = stack.pop()
        if depth > bounds.max_json_depth:
            _fail("json-budget")
        elements += 1
        if elements > bounds.max_json_elements:
            _fail("json-budget")
        if isinstance(current, str):
            string_characters += len(current)
        if isinstance(current, dict):
            elements += len(current)
            string_characters += sum(len(key) for key in current)
        stack.extend((child, depth + 1) for child in _container_children(current))
        if elements > bounds.max_json_elements:
            _fail("json-budget")
        if string_characters > bounds.max_json_string_characters:
            _fail("json-budget")


def _load_json(payload: bytes, bounds: MinerUConversionBounds) -> object:
    try:
        text = payload.decode("utf-8", errors="strict")
        value = json.loads(
            text,
            object_pairs_hook=_object_pairs,
            parse_constant=_invalid_constant,
            parse_float=_finite_float,
        )
    except (_DuplicateJsonKey, _InvalidJsonNumber, UnicodeDecodeError, json.JSONDecodeError):
        _fail("json-invalid")
    except (RecursionError, ValueError):
        _fail("json-invalid")
    _validate_json_budget(value, bounds)
    return value


def _load_primary_json(
    middle: ParserArchiveMember,
    model: ParserArchiveMember,
    content_list: ParserArchiveMember,
    *,
    bounds: MinerUConversionBounds,
) -> tuple[object, object, object]:
    members = (middle, model, content_list)
    if sum(member.byte_size for member in members) > bounds.max_total_json_bytes:
        _fail("json-budget")
    middle_value = _load_json(_read_json_payload(middle, bounds=bounds), bounds)
    model_value = _load_json(_read_json_payload(model, bounds=bounds), bounds)
    content_list_value = _load_json(_read_json_payload(content_list, bounds=bounds), bounds)
    return middle_value, model_value, content_list_value


def _validate_expected_pages(expected_page_count: int) -> None:
    if type(expected_page_count) is not int or expected_page_count <= 0:
        raise ValueError("expected_page_count must be a positive integer")


def _validate_pdf_info(value: dict[object, object], *, expected_page_count: int) -> None:
    pdf_info = value.get("pdf_info")
    if not isinstance(pdf_info, list) or len(pdf_info) != expected_page_count:
        _fail("page-mismatch")
    for index, page in enumerate(pdf_info):
        if not isinstance(page, dict) or type(page.get("page_idx")) is not int:
            _fail("page-mismatch")
        if page.get("page_idx") != index:
            _fail("page-mismatch")


def _validate_middle_images(
    value: object,
    *,
    markdown_reference: str,
    members: dict[str, ParserArchiveMember],
    markdown_bounds: MarkdownConversionBounds,
) -> None:
    stack: list[object] = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            for key, child in current.items():
                if key == "image_path":
                    if type(child) is not str:
                        _fail("resource-invalid")
                    try:
                        reference = canonical_resource_path(
                            child,
                            base_reference=markdown_reference,
                            bounds=markdown_bounds,
                        )
                    except MarkdownConversionError:
                        _fail("resource-invalid")
                    member = members.get(reference)
                    if member is None or not _media_type(member.reference).startswith("image/"):
                        _fail("resource-invalid")
                else:
                    stack.append(child)
        elif isinstance(current, list):
            stack.extend(current)


def _validate_middle(
    value: object,
    *,
    expected_page_count: int,
    markdown_reference: str,
    members: dict[str, ParserArchiveMember],
    markdown_bounds: MarkdownConversionBounds,
) -> None:
    if not isinstance(value, dict):
        _fail("json-invalid")
    if value.get("_backend") != _SUPPORTED_BACKEND:
        _fail("backend-mismatch")
    _validate_pdf_info(value, expected_page_count=expected_page_count)
    _validate_middle_images(
        value,
        markdown_reference=markdown_reference,
        members=members,
        markdown_bounds=markdown_bounds,
    )


def _validate_model(value: object) -> None:
    if not isinstance(value, (dict, list)):
        _fail("json-invalid")


def _validate_content_list(value: object, *, expected_page_count: int) -> None:
    if not isinstance(value, list):
        _fail("content-list-invalid")
    previous_page = -1
    for item in value:
        if not isinstance(item, dict):
            _fail("content-list-invalid")
        page_index = item.get("page_idx")
        if (
            type(page_index) is not int
            or page_index < 0
            or page_index >= expected_page_count
            or page_index < previous_page
        ):
            _fail("content-list-invalid")
        previous_page = page_index


def _media_type(reference: str) -> str:
    return _MEDIA_BY_SUFFIX.get(
        PurePosixPath(reference).suffix.casefold(), "application/octet-stream"
    )


def _staged_artifact(member: ParserArchiveMember, media_type: str) -> StagedParserArtifact:
    return StagedParserArtifact(
        artifact=ParserArtifactRef(
            sha256=member.sha256,
            media_type=media_type,
            byte_size=member.byte_size,
        ),
        content=member.content,
    )


def _convert_public_artifacts(
    markdown: ParserArchiveMember,
    members: tuple[ParserArchiveMember, ...],
    *,
    bounds: MinerUConversionBounds,
) -> NormalizedParserArtifacts:
    candidates = tuple(
        StagedParserResource(
            reference=member.reference,
            artifact=_staged_artifact(member, _media_type(member.reference)),
        )
        for member in members
        if member is not markdown and _media_type(member.reference).startswith("image/")
    )
    try:
        normalized = convert_parser_artifacts(
            _staged_artifact(markdown, "text/markdown"),
            markdown_source_reference=markdown.reference,
            candidates=candidates,
            markdown_bounds=bounds.markdown_bounds,
            resource_bounds=bounds.resource_bounds,
        )
    except MarkdownConversionError:
        _fail("markdown-invalid")
    except ParserResourceConversionError as error:
        code = (
            "markdown-invalid" if error.code == "markdown-artifact-invalid" else "resource-invalid"
        )
        _fail(code)
    return normalized


def convert_mineru_archive(
    payload: bytes,
    *,
    expected_page_count: int,
    bounds: MinerUConversionBounds | None = None,
) -> ConvertedMinerUOutput:
    """Validate and convert one untrusted ``vlm-engine`` MinerU archive."""

    _validate_expected_pages(expected_page_count)
    checked = _checked_bounds(bounds)
    try:
        extracted = extract_parser_archive(payload, bounds=checked.archive_bounds)
    except ParserArchiveError as error:
        _fail("archive-budget" if error.code == "archive-budget" else "archive-invalid")

    try:
        with extracted:
            markdown, middle, model, content_list = _primary_members(extracted.members)
            middle_value, model_value, content_list_value = _load_primary_json(
                middle,
                model,
                content_list,
                bounds=checked,
            )
            members = _member_index(extracted.members)
            _validate_middle(
                middle_value,
                expected_page_count=expected_page_count,
                markdown_reference=markdown.reference,
                members=members,
                markdown_bounds=checked.markdown_bounds,
            )
            _validate_model(model_value)
            _validate_content_list(content_list_value, expected_page_count=expected_page_count)
            converted = _convert_public_artifacts(markdown, extracted.members, bounds=checked)
    except MinerUConversionError:
        raise
    except ParserArchiveError as error:
        _fail("archive-budget" if error.code == "archive-budget" else "archive-invalid")

    return ConvertedMinerUOutput(
        page_count=expected_page_count,
        markdown=converted.markdown,
        resources=converted.resources,
    )


__all__ = (
    "ConvertedMinerUOutput",
    "MinerUConversionBounds",
    "MinerUConversionError",
    "convert_mineru_archive",
)
