"""Strict JSON values and closed tool declarations for one Agent call."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, NoReturn

from .messages import _bounded_text, utf8_size

if TYPE_CHECKING:
    from .calls import AgentProvenance

_MAX_JSON_DEPTH = 32
_MAX_JSON_ITEMS = 65_536
_MAX_JSON_BYTES = 16 * 1024 * 1024
_MAX_RESULT_BYTES = 16 * 1024 * 1024
_MAX_TOOL_SCHEMA_BYTES = 256 * 1024
MAX_TOOLS = 32
_SCHEMA_KEYS = frozenset(
    {
        "additionalProperties",
        "anyOf",
        "const",
        "description",
        "enum",
        "items",
        "properties",
        "required",
        "type",
    }
)
_SCHEMA_TYPES = frozenset({"array", "boolean", "integer", "null", "number", "object", "string"})


def _finite(value: str) -> NoReturn:
    del value
    raise ValueError("JSON must not contain non-finite numbers")


class _DuplicateKey(ValueError):
    pass


def _pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKey("JSON contains duplicate object keys")
        result[key] = value
    return result


def _validate_tree(  # noqa: C901
    value: object,
    *,
    depth: int = 0,
    count: list[int] | None = None,
    byte_count: list[int] | None = None,
) -> object:
    if count is None:
        count = [0]
    if byte_count is None:
        byte_count = [0]
    if depth > _MAX_JSON_DEPTH:
        raise ValueError("JSON is too deeply nested")
    count[0] += 1
    if count[0] > _MAX_JSON_ITEMS:
        raise ValueError("JSON contains too many values")
    if type(value) is float and not math.isfinite(value):
        raise ValueError("JSON must not contain non-finite numbers")
    byte_count[0] += 8
    if byte_count[0] > _MAX_JSON_BYTES:
        raise ValueError("JSON exceeds its byte limit")
    if value is None or type(value) in {bool, int, float}:
        return value
    if type(value) is str:
        try:
            encoded = value.encode("utf-8", errors="strict")
        except UnicodeEncodeError:
            raise ValueError("JSON strings must be valid UTF-8") from None
        byte_count[0] += len(encoded)
        if byte_count[0] > _MAX_JSON_BYTES:
            raise ValueError("JSON exceeds its byte limit")
        return value
    if type(value) is dict:
        for key, child in value.items():
            if type(key) is not str:
                raise ValueError("JSON object keys must be strings")
            try:
                encoded_key = key.encode("utf-8", errors="strict")
            except UnicodeEncodeError:
                raise ValueError("JSON strings must be valid UTF-8") from None
            byte_count[0] += len(encoded_key)
            if byte_count[0] > _MAX_JSON_BYTES:
                raise ValueError("JSON exceeds its byte limit")
            _validate_tree(child, depth=depth + 1, count=count, byte_count=byte_count)
        return value
    if type(value) is list:
        for child in value:
            _validate_tree(child, depth=depth + 1, count=count, byte_count=byte_count)
        return value
    raise ValueError("value is not a JSON tree")


def parse_strict_json(value: object) -> object:
    """Parse one finite, duplicate-free, bounded UTF-8 JSON value."""

    if not isinstance(value, (str, bytes)):
        raise TypeError("JSON must be text or bytes")
    try:
        text = value.decode("utf-8", errors="strict") if isinstance(value, bytes) else value
        if utf8_size(text) > _MAX_JSON_BYTES:
            raise ValueError("JSON exceeds its byte limit")
        parsed = json.loads(text, object_pairs_hook=_pairs, parse_constant=_finite)
        _validate_tree(parsed)
        json.dumps(parsed, ensure_ascii=False, allow_nan=False).encode("utf-8", errors="strict")
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
        _DuplicateKey,
        ValueError,
        TypeError,
        RecursionError,
    ):
        raise ValueError("JSON must be one finite duplicate-free value") from None
    return parsed


def parse_strict_json_object(value: object) -> dict[str, object]:
    parsed = parse_strict_json(value)
    if not isinstance(parsed, dict):
        raise ValueError("JSON must be one finite duplicate-free object")
    return parsed


def canonical_json_bytes(value: object) -> bytes:
    """Serialize a finite JSON tree to one stable UTF-8 representation."""

    try:
        _validate_tree(value)
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8", errors="strict")
        if len(encoded) > _MAX_JSON_BYTES:
            raise ValueError("canonical JSON exceeds its byte limit")
        return encoded
    except (TypeError, ValueError, UnicodeEncodeError, RecursionError):
        raise ValueError("value is not canonical finite JSON") from None


def _validate_closed_schema(  # noqa: C901
    schema: object,
    *,
    root: bool = False,
    depth: int = 0,
) -> None:
    if type(schema) is not dict:
        raise ValueError("tool schema nodes must be objects")
    if depth > 16:
        raise ValueError("tool schema is too deeply nested")
    if any(type(key) is not str or key not in _SCHEMA_KEYS for key in schema):
        raise ValueError("tool schema contains an unsupported keyword")
    schema_type = schema.get("type")
    if type(schema_type) is not str or schema_type not in _SCHEMA_TYPES:
        raise ValueError("tool schema type is invalid")
    if "description" in schema:
        _bounded_text(schema["description"], field_name="tool schema description", maximum=4_096)
    if schema_type == "object":
        if schema.get("additionalProperties") is not False:
            raise ValueError("tool object schemas must be closed")
        properties = schema.get("properties", {})
        if type(properties) is not dict:
            raise ValueError("tool schema properties must be an object")
        for name, child in properties.items():
            _bounded_text(name, field_name="tool schema property", maximum=128)
            _validate_closed_schema(child, depth=depth + 1)
        required = schema.get("required", [])
        if type(required) is not list or any(type(name) is not str for name in required):
            raise ValueError("tool schema required must be a string array")
        if len(required) != len(set(required)) or any(name not in properties for name in required):
            raise ValueError("tool schema required is inconsistent")
    elif "properties" in schema or "required" in schema or "additionalProperties" in schema:
        raise ValueError("object-only schema keywords are invalid here")
    if schema_type == "array":
        if "items" not in schema:
            raise ValueError("tool array schemas require items")
        _validate_closed_schema(schema["items"], depth=depth + 1)
    elif "items" in schema:
        raise ValueError("items is valid only for array schemas")
    if "enum" in schema:
        values = schema["enum"]
        if type(values) is not list or not values:
            raise ValueError("tool schema enum must be a nonempty array")
        for value in values:
            _validate_tree(value)
    if "const" in schema:
        _validate_tree(schema["const"])
    if "anyOf" in schema:
        alternatives = schema["anyOf"]
        if type(alternatives) is not list or not alternatives or len(alternatives) > 8:
            raise ValueError("tool schema anyOf is invalid")
        for alternative in alternatives:
            _validate_closed_schema(alternative, depth=depth + 1)
    if root and schema_type != "object":
        raise ValueError("tool schema root must be an object")


@dataclass(frozen=True, slots=True)
class AgentToolDeclaration:
    """One named tool with a closed strict JSON argument schema."""

    name: str
    input_schema: str = field(repr=False)
    description: str = "Return one declared action."

    def __post_init__(self) -> None:
        name = _bounded_text(self.name, field_name="tool name", maximum=128)
        if re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]*", name) is None:
            raise ValueError("tool name is invalid")
        object.__setattr__(self, "name", name)
        object.__setattr__(
            self,
            "description",
            _bounded_text(
                self.description,
                field_name="tool description",
                maximum=4_096,
            ),
        )
        if type(self.input_schema) is not str:
            raise TypeError("tool schema must be text")
        if utf8_size(self.input_schema) > _MAX_TOOL_SCHEMA_BYTES:
            raise ValueError("tool schema exceeds its byte limit")
        schema = parse_strict_json_object(self.input_schema)
        _validate_closed_schema(schema, root=True)
        object.__setattr__(
            self,
            "input_schema",
            canonical_json_bytes(schema).decode("utf-8", errors="strict"),
        )


@dataclass(frozen=True, slots=True, repr=False)
class AgentToolCall:
    """One provider-selected declared tool; arguments are never shown in repr."""

    tool_name: str
    arguments: str = field(repr=False)
    provenance: AgentProvenance

    def __post_init__(self) -> None:
        from .calls import AgentProvenance

        name = _bounded_text(self.tool_name, field_name="tool name", maximum=128)
        object.__setattr__(self, "tool_name", name)
        if type(self.arguments) is not str:
            raise TypeError("tool arguments must be text")
        if utf8_size(self.arguments) > _MAX_RESULT_BYTES:
            raise ValueError("tool arguments exceed the response boundary")
        parsed = parse_strict_json_object(self.arguments)
        object.__setattr__(
            self,
            "arguments",
            canonical_json_bytes(parsed).decode("utf-8", errors="strict"),
        )
        if not isinstance(self.provenance, AgentProvenance):
            raise TypeError("tool provenance must be AgentProvenance")

    @property
    def value(self) -> dict[str, object]:
        """Return a fresh argument object without retaining mutable state."""

        return parse_strict_json_object(self.arguments)


def _validate_tool_declarations(tools: object) -> tuple[AgentToolDeclaration, ...]:
    if not isinstance(tools, tuple) or any(
        not isinstance(tool, AgentToolDeclaration) for tool in tools
    ):
        raise TypeError("tools must contain AgentToolDeclaration values")
    if len(tools) > MAX_TOOLS or len({tool.name for tool in tools}) != len(tools):
        raise ValueError("Agent tool declarations must be unique and bounded")
    return tools


def validate_tool_arguments(declaration: AgentToolDeclaration, arguments: str) -> None:
    """Validate one provider tool call against its declared closed schema."""

    if not isinstance(declaration, AgentToolDeclaration):
        raise TypeError("declaration must be an AgentToolDeclaration")
    value = parse_strict_json_object(arguments)
    schema = parse_strict_json_object(declaration.input_schema)
    _validate_schema_value(schema, value)


def _validate_schema_value(  # noqa: C901
    schema: dict[str, object],
    value: object,
    *,
    depth: int = 0,
) -> None:
    if depth > 16:
        raise ValueError("tool value is too deeply nested")
    schema_type = schema["type"]
    if type(schema_type) is not str:
        raise ValueError("tool schema type is invalid")
    if not _schema_type_matches(schema_type, value):
        raise ValueError("tool value does not match its declared type")
    if "const" in schema and canonical_json_bytes(value) != canonical_json_bytes(schema["const"]):
        raise ValueError("tool value does not match its declared constant")
    if "enum" in schema:
        choices = schema["enum"]
        assert isinstance(choices, list)
        if not any(canonical_json_bytes(value) == canonical_json_bytes(item) for item in choices):
            raise ValueError("tool value is outside its declared enum")
    if schema_type == "object":
        assert isinstance(value, dict)
        properties = schema.get("properties", {})
        required = schema.get("required", [])
        assert isinstance(properties, dict)
        assert isinstance(required, list)
        if any(name not in value for name in required):
            raise ValueError("tool object is missing a required property")
        if any(type(name) is not str or name not in properties for name in value):
            raise ValueError("tool object contains an undeclared property")
        for name, child in value.items():
            assert isinstance(name, str)
            child_schema = properties[name]
            assert isinstance(child_schema, dict)
            _validate_schema_value(child_schema, child, depth=depth + 1)
    elif schema_type == "array":
        assert isinstance(value, list)
        item_schema = schema["items"]
        assert isinstance(item_schema, dict)
        for child in value:
            _validate_schema_value(item_schema, child, depth=depth + 1)
    if "anyOf" in schema:
        alternatives = schema["anyOf"]
        assert isinstance(alternatives, list)
        for alternative in alternatives:
            assert isinstance(alternative, dict)
            try:
                _validate_schema_value(alternative, value, depth=depth + 1)
            except ValueError:
                continue
            break
        else:
            raise ValueError("tool value does not match any declared alternative")


def _schema_type_matches(schema_type: str, value: object) -> bool:
    return {
        "null": value is None,
        "boolean": type(value) is bool,
        "integer": type(value) is int,
        "number": type(value) in {int, float},
        "string": type(value) is str,
        "array": type(value) is list,
        "object": type(value) is dict,
    }.get(schema_type, False)


__all__ = ("AgentToolCall", "AgentToolDeclaration")
