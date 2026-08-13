"""Bounded normalization of Parser-produced Markdown resource references.

This module understands only enough Markdown syntax to identify local resources
that a rendered document actually consumes.  It deliberately does not infer
document structure, image meaning, references, or content usability.
"""

from __future__ import annotations

import html
import re
import unicodedata
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Final, Iterator, NoReturn
from urllib.parse import quote, unquote_to_bytes, urlsplit

_CONTROL_CHARACTER: Final[re.Pattern[str]] = re.compile(r"[\x00-\x1f\x7f]")
_PERCENT_ESCAPE: Final[re.Pattern[str]] = re.compile(r"%[0-9A-Fa-f]{2}")
_INVALID_PERCENT: Final[re.Pattern[str]] = re.compile(r"%(?![0-9A-Fa-f]{2})")
_WINDOWS_DRIVE: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z]:")
_REFERENCE_DEFINITION: Final[re.Pattern[str]] = re.compile(
    r"(?m)^(?P<indent> {0,3})\[(?P<label>[^\]\r\n]+)\]:[ \t]*(?P<destination>[^\r\n]*)"
)
_HTML_RESOURCE_START: Final[re.Pattern[str]] = re.compile(
    r"<(?:img|source)(?=[\s/>])",
    re.IGNORECASE,
)
_SRCSET_WIDTH_DESCRIPTOR: Final[re.Pattern[str]] = re.compile(r"[0-9]+w\Z")
_SRCSET_DENSITY_DESCRIPTOR: Final[re.Pattern[str]] = re.compile(
    r"(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?x\Z"
)
_ASCII_WHITESPACE: Final[frozenset[str]] = frozenset("\t\n\f\r ")
_SRCSET_URL_SAFE: Final[str] = "/!$()*+-.:;=@_~"


class MarkdownConversionError(ValueError):
    """Stable, content-free rejection of unsafe Parser Markdown."""

    _CODES = frozenset(
        {
            "markdown-invalid",
            "markdown-budget-exceeded",
            "markdown-reference-invalid",
            "markdown-reference-missing",
            "markdown-reference-duplicate",
        }
    )

    def __init__(self, code: str) -> None:
        if code not in self._CODES:
            raise ValueError("unknown Markdown conversion error code")
        self.code = code
        super().__init__(f"parser Markdown conversion rejected ({code})")

    def __repr__(self) -> str:
        return f"MarkdownConversionError(code={self.code!r})"


def _fail(code: str) -> NoReturn:
    raise MarkdownConversionError(code) from None


@dataclass(frozen=True, slots=True)
class MarkdownConversionBounds:
    """Hard limits for one Parser Markdown conversion attempt."""

    max_markdown_bytes: int = 8 * 1024 * 1024
    max_resource_references: int = 4096
    max_reference_characters: int = 2048
    max_percent_decode_rounds: int = 8

    def __post_init__(self) -> None:
        for value in (
            self.max_markdown_bytes,
            self.max_resource_references,
            self.max_reference_characters,
            self.max_percent_decode_rounds,
        ):
            if type(value) is not int or value <= 0:
                raise ValueError("Markdown conversion bounds must be positive integers")


@dataclass(frozen=True, slots=True)
class MarkdownResourceUse:
    """One unique local archive member consumed by normalized Markdown."""

    source_reference: str
    reference: str


@dataclass(frozen=True, slots=True)
class NormalizedMarkdown:
    """Normalized UTF-8 Markdown and its unique local resource uses."""

    payload: bytes = field(repr=False)
    resources: tuple[MarkdownResourceUse, ...]


@dataclass(frozen=True, slots=True)
class _Destination:
    start: int
    end: int
    raw: str
    wrapped: bool
    html_attribute: bool = False
    html_srcset: bool = False


@dataclass(frozen=True, slots=True)
class _ReferenceDefinition:
    label: str
    destination: _Destination


@dataclass(frozen=True, slots=True)
class _HtmlAttribute:
    name: str
    value_start: int | None
    value_end: int | None
    wrapped: bool
    next_cursor: int


def _bounds(value: MarkdownConversionBounds | None) -> MarkdownConversionBounds:
    if value is None:
        return MarkdownConversionBounds()
    if not isinstance(value, MarkdownConversionBounds):
        raise TypeError("bounds must be MarkdownConversionBounds")
    return value


def _decode_uri_path(value: str, bounds: MarkdownConversionBounds) -> str:
    candidate = value
    if len(candidate) > bounds.max_reference_characters:
        _fail("markdown-reference-invalid")
    for _round in range(bounds.max_percent_decode_rounds):
        if "%" not in candidate:
            break
        if _INVALID_PERCENT.search(candidate) is not None:
            _fail("markdown-reference-invalid")
        try:
            decoded = unquote_to_bytes(candidate).decode("utf-8", errors="strict")
        except (UnicodeDecodeError, UnicodeEncodeError, ValueError):
            _fail("markdown-reference-invalid")
        if decoded == candidate:
            break
        candidate = decoded
    if "%" in candidate and _PERCENT_ESCAPE.search(candidate) is not None:
        _fail("markdown-reference-invalid")
    if "%" in candidate:
        _fail("markdown-reference-invalid")
    return unicodedata.normalize("NFC", candidate)


def _canonical_parts(value: str, bounds: MarkdownConversionBounds) -> tuple[str, ...]:
    if type(value) is not str or not value or value != value.strip():
        _fail("markdown-reference-invalid")
    candidate = _decode_uri_path(value, bounds)
    if (
        not candidate
        or candidate != candidate.strip()
        or len(candidate) > bounds.max_reference_characters
        or _CONTROL_CHARACTER.search(candidate) is not None
        or "\\" in candidate
        or candidate.startswith(("/", "~/"))
        or _WINDOWS_DRIVE.match(candidate) is not None
    ):
        _fail("markdown-reference-invalid")
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        _fail("markdown-reference-invalid")
    if (
        parsed.scheme
        or parsed.netloc
        or parsed.query
        or parsed.fragment
        or parsed.path != candidate
    ):
        _fail("markdown-reference-invalid")

    raw_parts = candidate.split("/")
    if any(part in {"", ".."} for part in raw_parts):
        _fail("markdown-reference-invalid")
    parts = tuple(part for part in raw_parts if part != ".")
    if not parts or any(
        not part or part != part.strip() or _CONTROL_CHARACTER.search(part) is not None
        for part in parts
    ):
        _fail("markdown-reference-invalid")
    return parts


def canonical_resource_path(
    value: str,
    *,
    base_reference: str | None = None,
    bounds: MarkdownConversionBounds | None = None,
) -> str:
    """Decode and normalize one URI path into a safe POSIX relative path.

    Percent escapes are decoded repeatedly up to a hard bound before path
    validation.  This prevents single, mixed-case, and nested encodings from
    hiding parent traversal, backslashes, network URLs, or Windows drives.
    """

    checked_bounds = _bounds(bounds)
    parts = _canonical_parts(value, checked_bounds)
    if base_reference is not None:
        base_parts = _canonical_parts(base_reference, checked_bounds)
        parts = (*base_parts[:-1], *parts)
    result = "/".join(parts)
    if len(result) > checked_bounds.max_reference_characters:
        _fail("markdown-reference-invalid")
    return result


def _is_escaped(text: str, index: int) -> bool:
    backslashes = 0
    cursor = index - 1
    while cursor >= 0 and text[cursor] == "\\":
        backslashes += 1
        cursor -= 1
    return backslashes % 2 == 1


def _mask_fences(text: str, masked: list[bool]) -> None:
    position = 0
    active_character: str | None = None
    active_length = 0
    for line in text.splitlines(keepends=True):
        body = line.rstrip("\r\n")
        stripped = body.lstrip(" ")
        indent = len(body) - len(stripped)
        run_character = stripped[:1]
        run_length = 0
        if indent <= 3 and run_character in {"`", "~"}:
            while run_length < len(stripped) and stripped[run_length] == run_character:
                run_length += 1

        is_fence = run_length >= 3
        if active_character is None:
            if is_fence:
                active_character = run_character
                active_length = run_length
                for index in range(position, position + len(line)):
                    masked[index] = True
        else:
            for index in range(position, position + len(line)):
                masked[index] = True
            if (
                is_fence
                and run_character == active_character
                and run_length >= active_length
                and not stripped[run_length:].strip()
            ):
                active_character = None
                active_length = 0
        position += len(line)


def _mask_inline_code(text: str, masked: list[bool]) -> None:
    cursor = 0
    while cursor < len(text):
        if masked[cursor] or text[cursor] != "`" or _is_escaped(text, cursor):
            cursor += 1
            continue
        run_length = 1
        while cursor + run_length < len(text) and text[cursor + run_length] == "`":
            run_length += 1
        closing = cursor + run_length
        found = -1
        marker = "`" * run_length
        while closing < len(text):
            candidate = text.find(marker, closing)
            if candidate < 0:
                break
            if not any(masked[candidate : candidate + run_length]):
                found = candidate
                break
            closing = candidate + run_length
        if found < 0:
            cursor += run_length
            continue
        for index in range(cursor, found + run_length):
            masked[index] = True
        cursor = found + run_length


def _mask_html_comments(text: str, masked: list[bool]) -> None:
    comment_start = 0
    while True:
        opening = text.find("<!--", comment_start)
        if opening < 0:
            break
        closing = text.find("-->", opening + 4)
        end = len(text) if closing < 0 else closing + 3
        if not any(masked[opening : min(opening + 4, len(text))]):
            for index in range(opening, end):
                masked[index] = True
        comment_start = end


def _masked_code(text: str) -> list[bool]:
    masked = [False] * len(text)
    _mask_fences(text, masked)
    _mask_inline_code(text, masked)
    _mask_html_comments(text, masked)
    return masked


def _closing_bracket(text: str, start: int, masked: list[bool]) -> int:
    depth = 1
    cursor = start
    while cursor < len(text):
        character = text[cursor]
        if masked[cursor] or _is_escaped(text, cursor):
            cursor += 1
            continue
        if character == "[":
            depth += 1
        elif character == "]":
            depth -= 1
            if depth == 0:
                return cursor
        cursor += 1
    return -1


def _angle_destination(text: str, start: int, limit: int) -> _Destination | None:
    end = start + 1
    while end < limit and text[end] not in "\r\n":
        if text[end] == ">" and not _is_escaped(text, end):
            return _Destination(start, end + 1, text[start + 1 : end], True)
        end += 1
    return None


def _bare_destination(
    text: str,
    start: int,
    limit: int,
    masked: list[bool],
) -> _Destination | None:
    cursor = start
    depth = 0
    while cursor < limit:
        if masked[cursor]:
            return None
        character = text[cursor]
        if character in "\r\n" or (character in " \t" and depth == 0):
            break
        if not _is_escaped(text, cursor):
            if character == "(":
                depth += 1
            elif character == ")":
                if depth == 0:
                    break
                depth -= 1
        cursor += 1
    if cursor == start or depth != 0:
        return None
    return _Destination(start, cursor, text[start:cursor], False)


def _destination_value(
    text: str,
    start: int,
    limit: int,
    masked: list[bool],
) -> _Destination | None:
    if start >= limit or text[start] in "\r\n)":
        return None
    if text[start] == "<":
        return _angle_destination(text, start, limit)
    return _bare_destination(text, start, limit, masked)


def _skip_horizontal_space(text: str, cursor: int, limit: int) -> int:
    while cursor < limit and text[cursor] in " \t":
        cursor += 1
    return cursor


def _inline_tail_is_valid(text: str, cursor: int, masked: list[bool]) -> bool:
    cursor = _skip_horizontal_space(text, cursor, len(text))
    if cursor >= len(text) or text[cursor] in "\r\n":
        return False
    if text[cursor] == ")":
        return True
    opener = text[cursor]
    closer = ")" if opener == "(" else opener
    if opener not in {'"', "'", "("}:
        return False
    cursor += 1
    while cursor < len(text) and text[cursor] not in "\r\n":
        if text[cursor] == closer and not _is_escaped(text, cursor) and not masked[cursor]:
            cursor = _skip_horizontal_space(text, cursor + 1, len(text))
            return cursor < len(text) and text[cursor] == ")"
        cursor += 1
    return False


def _definition_tail_is_valid(text: str, cursor: int, limit: int) -> bool:
    cursor = _skip_horizontal_space(text, cursor, limit)
    if cursor == limit:
        return True
    opener = text[cursor]
    closer = ")" if opener == "(" else opener
    if opener not in {'"', "'", "("}:
        return False
    cursor += 1
    while cursor < limit:
        if text[cursor] == closer and not _is_escaped(text, cursor):
            return _skip_horizontal_space(text, cursor + 1, limit) == limit
        cursor += 1
    return False


def _inline_destination(
    text: str,
    opening: int,
    masked: list[bool],
) -> _Destination | None:
    cursor = _skip_horizontal_space(text, opening + 1, len(text))
    destination = _destination_value(text, cursor, len(text), masked)
    if destination is None or not _inline_tail_is_valid(text, destination.end, masked):
        return None
    return destination


def _normalize_label(value: str) -> str:
    return " ".join(value.split()).casefold()


def _definitions(text: str, masked: list[bool]) -> dict[str, _ReferenceDefinition]:
    definitions: dict[str, _ReferenceDefinition] = {}
    for match in _REFERENCE_DEFINITION.finditer(text):
        if any(masked[match.start() : match.end()]):
            continue
        label = _normalize_label(match.group("label"))
        if not label or label in definitions:
            _fail("markdown-reference-duplicate")
        raw_destination = match.group("destination")
        absolute_start = match.start("destination")
        leading = len(raw_destination) - len(raw_destination.lstrip(" \t"))
        cursor = absolute_start + leading
        if cursor >= match.end():
            _fail("markdown-reference-invalid")
        destination = _destination_value(text, cursor, match.end(), masked)
        if destination is None or not _definition_tail_is_valid(
            text,
            destination.end,
            match.end(),
        ):
            _fail("markdown-reference-invalid")
        definitions[label] = _ReferenceDefinition(label=label, destination=destination)
    return definitions


def _markdown_image_destinations(  # noqa: C901
    text: str,
    masked: list[bool],
    definitions: dict[str, _ReferenceDefinition],
) -> list[_Destination]:
    destinations: list[_Destination] = []
    used_definitions: set[str] = set()
    cursor = 0
    while cursor < len(text) - 1:
        opening = text.find("![", cursor)
        if opening < 0:
            break
        if masked[opening] or _is_escaped(text, opening):
            cursor = opening + 2
            continue
        alt_end = _closing_bracket(text, opening + 2, masked)
        if alt_end < 0:
            cursor = opening + 2
            continue
        after = alt_end + 1
        while after < len(text) and text[after] in " \t":
            after += 1
        if after < len(text) and text[after] == "(":
            destination = _inline_destination(text, after, masked)
            if destination is None:
                _fail("markdown-reference-invalid")
            destinations.append(destination)
            cursor = destination.end
            continue

        label = text[opening + 2 : alt_end]
        if after < len(text) and text[after] == "[":
            reference_end = _closing_bracket(text, after + 1, masked)
            if reference_end < 0:
                _fail("markdown-reference-invalid")
            explicit = text[after + 1 : reference_end]
            if explicit:
                label = explicit
            cursor = reference_end + 1
        else:
            cursor = alt_end + 1
        normalized_label = _normalize_label(label)
        definition = definitions.get(normalized_label)
        if definition is None:
            _fail("markdown-reference-missing")
        if normalized_label not in used_definitions:
            destinations.append(definition.destination)
            used_definitions.add(normalized_label)
    return destinations


def _html_tag_end(text: str, start: int, masked: list[bool]) -> int:
    quote: str | None = None
    cursor = start
    while cursor < len(text):
        if masked[cursor]:
            return -1
        character = text[cursor]
        if quote is None and character in {'"', "'"}:
            quote = character
        elif quote == character:
            quote = None
        elif quote is None and character == ">":
            return cursor + 1
        cursor += 1
    return -1


def _html_resource_tags(text: str, masked: list[bool]) -> Iterator[tuple[int, int]]:
    cursor = 0
    while True:
        match = _HTML_RESOURCE_START.search(text, cursor)
        if match is None:
            return
        if masked[match.start()]:
            cursor = match.end()
            continue
        end = _html_tag_end(text, match.end(), masked)
        if end < 0:
            _fail("markdown-reference-invalid")
        yield match.start(), end
        cursor = end


def _html_attribute_bounds(tag: str) -> tuple[int, int]:
    start = _HTML_RESOURCE_START.match(tag)
    if start is None or not tag.endswith(">"):
        _fail("markdown-reference-invalid")
    limit = len(tag) - 1
    if limit > start.end() and tag[limit - 1] == "/":
        limit -= 1
    return start.end(), limit


def _skip_html_space(tag: str, cursor: int, limit: int) -> int:
    while cursor < limit and tag[cursor].isspace():
        cursor += 1
    return cursor


def _html_attribute_name(tag: str, cursor: int, limit: int) -> tuple[str, int]:
    name_start = cursor
    while cursor < limit and not tag[cursor].isspace() and tag[cursor] != "=":
        if tag[cursor] in {'"', "'", "<", ">", "`", "/"}:
            _fail("markdown-reference-invalid")
        cursor += 1
    if cursor == name_start:
        _fail("markdown-reference-invalid")
    return tag[name_start:cursor], cursor


def _quoted_html_attribute_value(
    tag: str,
    cursor: int,
    limit: int,
) -> tuple[int, int, int]:
    quote = tag[cursor]
    cursor += 1
    value_start = cursor
    while cursor < limit and tag[cursor] != quote:
        cursor += 1
    if cursor >= limit:
        _fail("markdown-reference-invalid")
    return value_start, cursor, cursor + 1


def _unquoted_html_attribute_value(
    tag: str,
    cursor: int,
    limit: int,
) -> tuple[int, int, int]:
    value_start = cursor
    while cursor < limit and not tag[cursor].isspace():
        if tag[cursor] in {'"', "'", "<", ">", "`", "="}:
            _fail("markdown-reference-invalid")
        cursor += 1
    if cursor == value_start:
        _fail("markdown-reference-invalid")
    return value_start, cursor, cursor


def _html_attribute_value(
    tag: str,
    cursor: int,
    limit: int,
) -> tuple[int, int, bool, int]:
    cursor = _skip_html_space(tag, cursor, limit)
    if cursor >= limit:
        _fail("markdown-reference-invalid")
    if tag[cursor] in {'"', "'"}:
        value_start, value_end, next_cursor = _quoted_html_attribute_value(
            tag,
            cursor,
            limit,
        )
        return value_start, value_end, True, next_cursor
    value_start, value_end, next_cursor = _unquoted_html_attribute_value(
        tag,
        cursor,
        limit,
    )
    return value_start, value_end, False, next_cursor


def _next_html_attribute(
    tag: str,
    cursor: int,
    limit: int,
) -> _HtmlAttribute | None:
    separator_start = cursor
    cursor = _skip_html_space(tag, cursor, limit)
    if cursor >= limit:
        return None
    if cursor == separator_start:
        _fail("markdown-reference-invalid")

    name, name_end = _html_attribute_name(tag, cursor, limit)
    cursor = _skip_html_space(tag, name_end, limit)
    if cursor >= limit or tag[cursor] != "=":
        return _HtmlAttribute(name, None, None, False, name_end)

    value_start, value_end, wrapped, cursor = _html_attribute_value(
        tag,
        cursor + 1,
        limit,
    )
    return _HtmlAttribute(name, value_start, value_end, wrapped, cursor)


def _skip_srcset_space(value: str, cursor: int) -> int:
    while cursor < len(value) and value[cursor] in _ASCII_WHITESPACE:
        cursor += 1
    return cursor


def _srcset_descriptor_kind(
    value: str,
    *,
    bounds: MarkdownConversionBounds,
) -> str | None:
    cursor = _skip_srcset_space(value, 0)
    tokens: list[str] = []
    while cursor < len(value):
        start = cursor
        while cursor < len(value) and value[cursor] not in _ASCII_WHITESPACE:
            cursor += 1
        tokens.append(value[start:cursor])
        cursor = _skip_srcset_space(value, cursor)
    if not tokens:
        return None
    if len(tokens) != 1 or len(tokens[0]) > bounds.max_reference_characters:
        _fail("markdown-reference-invalid")

    descriptor = tokens[0]
    if _SRCSET_WIDTH_DESCRIPTOR.fullmatch(descriptor) is not None:
        if not descriptor[:-1].strip("0"):
            _fail("markdown-reference-invalid")
        return "w"
    if _SRCSET_DENSITY_DESCRIPTOR.fullmatch(descriptor) is not None:
        try:
            density = Decimal(descriptor[:-1])
        except InvalidOperation:
            _fail("markdown-reference-invalid")
        if not density.is_finite() or density <= 0:
            _fail("markdown-reference-invalid")
        return "x"
    _fail("markdown-reference-invalid")


def _srcset_url_span(value: str, cursor: int) -> tuple[int, int, int, bool]:
    url_start = cursor
    while cursor < len(value) and value[cursor] not in _ASCII_WHITESPACE:
        cursor += 1
    url_end = cursor
    trailing_commas = 0
    while url_end > url_start and value[url_end - 1] == ",":
        trailing_commas += 1
        url_end -= 1
    if url_end == url_start or trailing_commas > 1:
        _fail("markdown-reference-invalid")
    return url_start, url_end, cursor, trailing_commas == 1


def _srcset_descriptor(
    value: str,
    cursor: int,
    *,
    bounds: MarkdownConversionBounds,
) -> tuple[str | None, int, bool]:
    cursor = _skip_srcset_space(value, cursor)
    descriptor_start = cursor
    while cursor < len(value) and value[cursor] != ",":
        cursor += 1
    descriptor_kind = _srcset_descriptor_kind(
        value[descriptor_start:cursor],
        bounds=bounds,
    )
    if cursor == len(value):
        return descriptor_kind, cursor, False
    return descriptor_kind, cursor + 1, True


def _srcset_destinations(
    tag: str,
    attribute: _HtmlAttribute,
    *,
    absolute_start: int,
    bounds: MarkdownConversionBounds,
) -> list[_Destination]:
    if attribute.value_start is None or attribute.value_end is None:
        _fail("markdown-reference-invalid")
    value_start = attribute.value_start
    value = tag[value_start : attribute.value_end]
    if not value or html.unescape(value) != value or ",," in value:
        _fail("markdown-reference-invalid")

    destinations: list[_Destination] = []
    descriptor_kinds: list[str | None] = []
    cursor = _skip_srcset_space(value, 0)
    while cursor < len(value):
        if value[cursor] == ",":
            _fail("markdown-reference-invalid")
        url_start, url_end, cursor, separator = _srcset_url_span(value, cursor)
        descriptor_kind: str | None = None
        if not separator:
            descriptor_kind, cursor, separator = _srcset_descriptor(
                value,
                cursor,
                bounds=bounds,
            )

        destinations.append(
            _Destination(
                start=absolute_start + value_start + url_start,
                end=absolute_start + value_start + url_end,
                raw=value[url_start:url_end],
                wrapped=attribute.wrapped,
                html_attribute=True,
                html_srcset=True,
            )
        )
        descriptor_kinds.append(descriptor_kind)

        if not separator:
            break
        cursor = _skip_srcset_space(value, cursor)
        if cursor >= len(value) or value[cursor] == ",":
            _fail("markdown-reference-invalid")

    if not destinations:
        _fail("markdown-reference-invalid")
    kinds = {kind for kind in descriptor_kinds if kind is not None}
    if len(kinds) > 1 or (kinds == {"w"} and None in descriptor_kinds):
        _fail("markdown-reference-invalid")
    return destinations


def _html_resource_destinations(
    tag: str,
    *,
    absolute_start: int,
    bounds: MarkdownConversionBounds,
) -> list[_Destination]:
    """Lex exact ``src`` and ``srcset`` attributes from one resource tag.

    Names are compared as complete ASCII-case-insensitive tokens, keeping
    ``data-src``, ``data-srcset``, ``xlink:src``, and quoted lookalikes outside
    the closure.  Duplicate, ambiguous, or unsupported real attributes fail
    closed without exposing their values.
    """

    cursor, limit = _html_attribute_bounds(tag)
    destinations: list[_Destination] = []
    seen_src = False
    seen_srcset = False
    while cursor < limit:
        attribute = _next_html_attribute(tag, cursor, limit)
        if attribute is None:
            break
        cursor = attribute.next_cursor
        name = attribute.name.casefold()
        if name == "src":
            if seen_src or attribute.value_start is None or attribute.value_end is None:
                _fail("markdown-reference-invalid")
            seen_src = True
            destinations.append(
                _Destination(
                    start=absolute_start + attribute.value_start,
                    end=absolute_start + attribute.value_end,
                    raw=html.unescape(tag[attribute.value_start : attribute.value_end]),
                    wrapped=attribute.wrapped,
                    html_attribute=True,
                )
            )
        elif name == "srcset":
            if seen_srcset:
                _fail("markdown-reference-invalid")
            seen_srcset = True
            destinations.extend(
                _srcset_destinations(
                    tag,
                    attribute,
                    absolute_start=absolute_start,
                    bounds=bounds,
                )
            )
    return destinations


def _html_image_destinations(
    text: str,
    masked: list[bool],
    *,
    bounds: MarkdownConversionBounds,
) -> list[_Destination]:
    destinations: list[_Destination] = []
    for start, end in _html_resource_tags(text, masked):
        tag = text[start:end]
        destinations.extend(
            _html_resource_destinations(
                tag,
                absolute_start=start,
                bounds=bounds,
            )
        )
    return destinations


def _image_destinations(
    text: str,
    masked: list[bool],
    definitions: dict[str, _ReferenceDefinition],
    *,
    bounds: MarkdownConversionBounds,
) -> list[_Destination]:
    return [
        *_markdown_image_destinations(text, masked, definitions),
        *_html_image_destinations(text, masked, bounds=bounds),
    ]


def _render_destination(
    reference: str,
    wrapped: bool,
    *,
    html_attribute: bool,
    html_srcset: bool,
) -> str:
    if html_srcset:
        return quote(reference, safe=_SRCSET_URL_SAFE)
    if html_attribute:
        escaped = html.escape(reference, quote=True)
        return (
            escaped
            if wrapped or not any(character.isspace() for character in reference)
            else f'"{escaped}"'
        )
    if wrapped or any(character.isspace() or character in "()" for character in reference):
        return f"<{reference}>"
    return reference


def _normalization_entries(
    destinations: list[_Destination],
    *,
    canonical_source: str,
    bounds: MarkdownConversionBounds,
) -> tuple[dict[tuple[int, int], str], dict[str, MarkdownResourceUse]]:
    replacements: dict[tuple[int, int], str] = {}
    raw_by_reference: dict[str, str] = {}
    resources: dict[str, MarkdownResourceUse] = {}
    for destination in destinations:
        reference = canonical_resource_path(
            destination.raw,
            base_reference=canonical_source,
            bounds=bounds,
        )
        previous_raw = raw_by_reference.get(reference)
        if previous_raw is not None and previous_raw != destination.raw:
            _fail("markdown-reference-duplicate")
        raw_by_reference[reference] = destination.raw
        resources[reference] = MarkdownResourceUse(
            source_reference=reference,
            reference=reference,
        )
        key = (destination.start, destination.end)
        replacement = _render_destination(
            reference,
            destination.wrapped,
            html_attribute=destination.html_attribute,
            html_srcset=destination.html_srcset,
        )
        previous_replacement = replacements.get(key)
        if previous_replacement is not None and previous_replacement != replacement:
            _fail("markdown-reference-duplicate")
        replacements[key] = replacement
    return replacements, resources


def normalize_parser_markdown(
    payload: bytes,
    *,
    source_reference: str,
    bounds: MarkdownConversionBounds | None = None,
) -> NormalizedMarkdown:
    """Validate UTF-8 Markdown and rewrite actual local resource references."""

    checked_bounds = _bounds(bounds)
    if type(payload) is not bytes or not payload:
        _fail("markdown-invalid")
    if len(payload) > checked_bounds.max_markdown_bytes:
        _fail("markdown-budget-exceeded")
    try:
        text = payload.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        _fail("markdown-invalid")
    if not text.strip():
        _fail("markdown-invalid")

    canonical_source = canonical_resource_path(source_reference, bounds=checked_bounds)
    masked = _masked_code(text)
    definitions = _definitions(text, masked)
    destinations = _image_destinations(
        text,
        masked,
        definitions,
        bounds=checked_bounds,
    )
    if len(destinations) > checked_bounds.max_resource_references:
        _fail("markdown-budget-exceeded")

    replacements, resources = _normalization_entries(
        destinations,
        canonical_source=canonical_source,
        bounds=checked_bounds,
    )

    normalized = text
    last_start = len(text)
    for (start, end), replacement in sorted(replacements.items(), reverse=True):
        if start < 0 or end <= start or end > last_start:
            _fail("markdown-reference-duplicate")
        normalized = f"{normalized[:start]}{replacement}{normalized[end:]}"
        last_start = start
    normalized_payload = normalized.encode("utf-8")
    if not normalized_payload or len(normalized_payload) > checked_bounds.max_markdown_bytes:
        _fail("markdown-budget-exceeded")
    return NormalizedMarkdown(
        payload=normalized_payload,
        resources=tuple(resources[key] for key in sorted(resources)),
    )


def validated_markdown_resource_references(
    payload: bytes,
    *,
    bounds: MarkdownConversionBounds | None = None,
) -> tuple[str, ...]:
    """Return the exact resource set of already-normalized public Markdown.

    Unlike adapter conversion, this validator has no private archive base.  It
    is intended for the service acceptance boundary: any destination that
    would still require decoding or rewriting is rejected rather than silently
    accepted under a different manifest reference.
    """

    normalized = normalize_parser_markdown(
        payload,
        source_reference="parser-result.md",
        bounds=bounds,
    )
    if normalized.payload != payload:
        _fail("markdown-reference-invalid")
    return tuple(resource.reference for resource in normalized.resources)


__all__ = (
    "MarkdownConversionBounds",
    "MarkdownConversionError",
    "MarkdownResourceUse",
    "NormalizedMarkdown",
    "canonical_resource_path",
    "normalize_parser_markdown",
    "validated_markdown_resource_references",
)
