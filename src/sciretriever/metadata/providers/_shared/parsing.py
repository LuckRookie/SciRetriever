"""Vendor-neutral, bounded JSON/XML parsing mechanics.

These helpers validate byte and structural boundaries only.  They know no
provider path, endpoint, field mapping, pagination token, or business
identity.  Adapters must explicitly select the keys and XML siblings they
understand and immediately convert those values into the neutral Metadata
models; the parsed vendor document is never a model or persistence value.
"""

from __future__ import annotations

import json
import unicodedata
from typing import NoReturn, cast
from xml.etree import ElementTree

from .failures import (
    invalid_record_failure,
    malformed_json_failure,
    malformed_xml_failure,
    response_too_large_failure,
    unknown_shape_failure,
    unsafe_xml_failure,
)


class _InvalidJsonConstant(ValueError):
    pass


class _DuplicateJsonKey(ValueError):
    pass


def _reject_json_constant(value: str) -> NoReturn:
    del value
    raise _InvalidJsonConstant


def _json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateJsonKey
        result[key] = value
    return result


def _bounded_bytes(payload: bytes, *, max_bytes: int) -> bytes:
    if type(payload) is not bytes:
        raise TypeError("payload must be bytes")
    if type(max_bytes) is not int:
        raise TypeError("max_bytes must be an integer")
    if max_bytes < 1:
        raise ValueError("max_bytes must be positive")
    if len(payload) > max_bytes:
        raise response_too_large_failure()
    return payload


def parse_bounded_json(payload: bytes, *, max_bytes: int) -> object:
    """Decode one strict UTF-8 JSON document inside an adapter-owned budget."""

    bounded = _bounded_bytes(payload, max_bytes=max_bytes)
    try:
        text = bounded.decode("utf-8")
        value = json.loads(
            text,
            object_pairs_hook=_json_object,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, _InvalidJsonConstant, _DuplicateJsonKey):
        raise malformed_json_failure() from None
    return cast(object, value)


def parse_bounded_xml(payload: bytes, *, max_bytes: int) -> ElementTree.Element:
    """Parse one UTF-8 XML document while rejecting DTD/entity declarations."""

    bounded = _bounded_bytes(payload, max_bytes=max_bytes)
    try:
        text = bounded.decode("utf-8")
    except UnicodeDecodeError:
        raise malformed_xml_failure() from None
    folded = text.casefold()
    if "<!doctype" in folded or "<!entity" in folded:
        raise unsafe_xml_failure()
    try:
        return ElementTree.fromstring(text)
    except ElementTree.ParseError:
        raise malformed_xml_failure() from None


def require_json_object(value: object) -> dict[str, object]:
    """Return a JSON object or fail with the fixed unknown-shape failure."""

    if type(value) is not dict:
        raise unknown_shape_failure()
    result = cast(dict[object, object], value)
    if any(type(key) is not str for key in result):
        raise unknown_shape_failure()
    return cast(dict[str, object], result)


def require_json_array(value: object) -> tuple[object, ...]:
    """Return JSON array items in source order, including duplicates."""

    if type(value) is not list:
        raise unknown_shape_failure()
    return tuple(cast(list[object], value))


def _expected_xml_tags(value: str | tuple[str, ...]) -> tuple[str, ...]:
    tags = (value,) if isinstance(value, str) else value
    if not isinstance(tags, tuple) or not tags:
        raise TypeError("expected XML tags must be a non-empty string or tuple")
    if any(type(tag) is not str or not tag for tag in tags):
        raise ValueError("expected XML tags must be non-empty strings")
    return tags


def require_xml_root(
    value: ElementTree.Element,
    expected_tag: str | tuple[str, ...],
) -> ElementTree.Element:
    """Require an exact root QName supplied by the provider adapter."""

    if not isinstance(value, ElementTree.Element):
        raise TypeError("value must be an XML Element")
    if value.tag not in _expected_xml_tags(expected_tag):
        raise unknown_shape_failure()
    return value


def xml_children(
    value: ElementTree.Element,
    expected_tag: str | tuple[str, ...],
) -> tuple[ElementTree.Element, ...]:
    """Select only whitelisted direct-child QNames while preserving order."""

    if not isinstance(value, ElementTree.Element):
        raise TypeError("value must be an XML Element")
    tags = _expected_xml_tags(expected_tag)
    return tuple(child for child in value if child.tag in tags)


def optional_nonblank_string(value: object) -> str | None:
    """Normalize an optional vendor string; blank strings mean no declared value."""

    if value is None:
        return None
    if type(value) is not str:
        raise invalid_record_failure()
    normalized = unicodedata.normalize("NFC", value.strip())
    return normalized or None


def strict_nonnegative_integer(value: object) -> int:
    """Accept only a real JSON/Python integer greater than or equal to zero."""

    if type(value) is not int or value < 0:
        raise invalid_record_failure()
    return value


def optional_nonnegative_integer(value: object) -> int | None:
    if value is None:
        return None
    return strict_nonnegative_integer(value)


__all__ = (
    "optional_nonblank_string",
    "optional_nonnegative_integer",
    "parse_bounded_json",
    "parse_bounded_xml",
    "require_json_array",
    "require_json_object",
    "require_xml_root",
    "strict_nonnegative_integer",
    "xml_children",
)
