"""Bounded, provider-neutral request and response values.

These values deliberately contain no Literature, Publisher, Playwright, SDK or
credential objects.  They are request-local exchange values and are not
persisted in the model/catalog layer.
"""

from __future__ import annotations

import json
import math
import re
import threading
import unicodedata
from dataclasses import dataclass, field
from enum import Enum, unique
from typing import NoReturn

from sciretriever.model.primitives import Sha256, sha256_digest

_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
# Prompt/input parts are allowed to carry ordinary line-oriented text.  Keep
# the non-printing controls rejected while permitting tab, LF and CR, which
# are common in Markdown prompts and pretty-printed JSON input.
_PART_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_MAX_MODEL_BYTES = 512
_MAX_PART_BYTES = 16 * 1024 * 1024
_MAX_SCHEMA_BYTES = 1 * 1024 * 1024
_MAX_IMAGE_BYTES = 16 * 1024 * 1024
_MAX_IMAGE_COUNT = 16
_MAX_TEXT_COUNT = 64
_MAX_TOOL_COUNT = 32
_MAX_TOOL_SCHEMA_BYTES = 256 * 1024
_MAX_JSON_DEPTH = 32
_MAX_JSON_ITEMS = 65_536
_MAX_JSON_BYTES = 16 * 1024 * 1024
_MAX_RESULT_BYTES = 16 * 1024 * 1024
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


@unique
class AgentRole(str, Enum):
    ANALYSIS = "analysis"
    BROWSER = "browser"


@unique
class AgentCapability(str, Enum):
    STRUCTURED_TEXT = "structured-text"
    IMAGE_INPUT = "image-input"
    TOOL_DECISION = "tool-decision"


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
    # Count a conservative minimum before canonical serialization so a caller
    # cannot hand us a huge in-memory tree and force one unbounded allocation.
    # The exact encoded length is checked again by ``canonical_json_bytes``.
    byte_count[0] += 8
    if byte_count[0] > _MAX_JSON_BYTES:
        raise ValueError("JSON exceeds its byte budget")
    if value is None or type(value) is bool or type(value) is int or type(value) is float:
        return value
    if type(value) is str:
        try:
            encoded = value.encode("utf-8", errors="strict")
        except UnicodeEncodeError:
            raise ValueError("JSON strings must be valid UTF-8") from None
        byte_count[0] += len(encoded)
        if byte_count[0] > _MAX_JSON_BYTES:
            raise ValueError("JSON exceeds its byte budget")
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
                raise ValueError("JSON exceeds its byte budget")
            _validate_tree(
                child,
                depth=depth + 1,
                count=count,
                byte_count=byte_count,
            )
    elif type(value) is list:
        for child in value:
            _validate_tree(
                child,
                depth=depth + 1,
                count=count,
                byte_count=byte_count,
            )
    else:
        raise ValueError("value is not a JSON tree")
    return value


def parse_strict_json(value: object) -> object:
    """Parse finite, duplicate-free UTF-8 JSON with bounded recursion."""

    if not isinstance(value, (str, bytes)):
        raise TypeError("JSON must be text or bytes")
    try:
        text = value.decode("utf-8", errors="strict") if isinstance(value, bytes) else value
        if utf8_size(text) > _MAX_JSON_BYTES:
            raise ValueError("JSON exceeds its byte budget")
        parsed = json.loads(
            text,
            object_pairs_hook=_pairs,
            parse_constant=_finite,
        )
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
            raise ValueError("canonical JSON exceeds its byte budget")
        return encoded
    except (TypeError, ValueError, UnicodeEncodeError, RecursionError):
        raise ValueError("value is not canonical finite JSON") from None


def utf8_size(value: str) -> int:
    if type(value) is not str:
        raise TypeError("value must be text")
    try:
        return len(value.encode("utf-8", errors="strict"))
    except UnicodeEncodeError:
        raise ValueError("value must be valid UTF-8") from None


def _bounded_text(value: object, *, field: str, maximum: int) -> str:
    if type(value) is not str:
        raise TypeError(f"{field} must be text")
    normalized = unicodedata.normalize("NFC", value)
    if not normalized.strip() or _CONTROL.search(normalized) is not None:
        raise ValueError(f"{field} must be stable text")
    if utf8_size(normalized) > maximum:
        raise ValueError(f"{field} exceeds its byte budget")
    return normalized


def _model_identity(value: object) -> str:
    """Apply the one model-identity contract used by all Agents values."""

    return _bounded_text(value, field="model", maximum=_MAX_MODEL_BYTES)


def _validate_closed_schema(  # noqa: C901
    schema: object,
    *,
    root: bool = False,
    depth: int = 0,
) -> None:
    """Validate the deliberately small closed JSON-Schema subset.

    Tool declarations are data sent to an external model, so accepting an
    arbitrary JSON-Schema dialect would make the wire contract provider
    dependent.  The subset supports the object/array/scalar shapes needed by
    Browser actions, recursive ``properties``/``items``, ``required``,
    ``enum``, ``const`` and ``anyOf``.  Every object schema must explicitly
    close ``additionalProperties``.
    """

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
        _bounded_text(schema["description"], field="tool schema description", maximum=4_096)
    if schema_type == "object":
        if schema.get("additionalProperties") is not False:
            raise ValueError("tool object schemas must be closed")
        properties = schema.get("properties", {})
        if type(properties) is not dict:
            raise ValueError("tool schema properties must be an object")
        for name, child in properties.items():
            _bounded_text(name, field="tool schema property", maximum=128)
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
class AgentTextPart:
    media_type: str
    text: str = field(repr=False)

    def __post_init__(self) -> None:
        if self.media_type not in {"text/plain", "application/json"}:
            raise ValueError("unsupported Agent text media type")
        if type(self.text) is not str:
            raise TypeError("text must be text")
        normalized = unicodedata.normalize("NFC", self.text)
        if not normalized.strip() or _PART_CONTROL.search(normalized) is not None:
            raise ValueError("text must be stable text")
        if utf8_size(normalized) > _MAX_PART_BYTES:
            raise ValueError("text exceeds its byte budget")
        if self.media_type == "application/json":
            parse_strict_json(normalized)
        object.__setattr__(self, "text", normalized)


@dataclass(frozen=True, slots=True, repr=False)
class AgentImagePart:
    media_type: str
    data: bytes = field(repr=False)
    width: int
    height: int

    def __post_init__(self) -> None:
        if self.media_type not in {"image/png", "image/jpeg", "image/webp"}:
            raise ValueError("unsupported Agent image media type")
        if type(self.data) is not bytes or not self.data or len(self.data) > _MAX_IMAGE_BYTES:
            raise ValueError("image bytes exceed the Agent boundary")
        if type(self.width) is not int or self.width < 1 or self.width > 32_768:
            raise ValueError("image width is invalid")
        if type(self.height) is not int or self.height < 1 or self.height > 32_768:
            raise ValueError("image height is invalid")


@dataclass(frozen=True, slots=True)
class AgentToolDeclaration:
    name: str
    input_schema: str = field(repr=False)
    description: str = "Return one declared action."

    def __post_init__(self) -> None:
        name = _bounded_text(self.name, field="tool name", maximum=128)
        if re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]*", name) is None:
            raise ValueError("tool name is invalid")
        object.__setattr__(self, "name", name)
        object.__setattr__(
            self,
            "description",
            _bounded_text(self.description, field="tool description", maximum=4_096),
        )
        if type(self.input_schema) is not str:
            raise TypeError("tool schema must be text")
        if utf8_size(self.input_schema) > _MAX_TOOL_SCHEMA_BYTES:
            raise ValueError("tool schema exceeds its byte budget")
        schema = parse_strict_json_object(self.input_schema)
        _validate_closed_schema(schema, root=True)
        object.__setattr__(
            self,
            "input_schema",
            canonical_json_bytes(schema).decode("utf-8", errors="strict"),
        )


@dataclass(frozen=True, slots=True, repr=False)
class AgentToolDecision:
    tool_name: str
    arguments: str = field(repr=False)
    provenance: "AgentProvenance"

    def __post_init__(self) -> None:
        tool_name = _bounded_text(self.tool_name, field="tool name", maximum=128)
        object.__setattr__(self, "tool_name", tool_name)
        if utf8_size(self.arguments) > _MAX_RESULT_BYTES:
            raise ValueError("tool arguments exceed the response boundary")
        parsed = parse_strict_json_object(self.arguments)
        canonical = canonical_json_bytes(parsed).decode("utf-8")
        object.__setattr__(self, "arguments", canonical)
        if not isinstance(self.provenance, AgentProvenance):
            raise TypeError("tool provenance must be AgentProvenance")


@dataclass(frozen=True, slots=True)
class AgentUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    response_bytes: int = 0

    def __post_init__(self) -> None:
        for field_name in ("input_tokens", "output_tokens", "response_bytes"):
            value = getattr(self, field_name)
            if type(value) is not int or value < 0:
                raise ValueError(f"{field_name} must be a nonnegative integer")


@dataclass(frozen=True, slots=True)
class AgentProvenance:
    provider: str
    model: str
    input_sha256: Sha256
    parameters_sha256: Sha256
    usage: AgentUsage = AgentUsage()

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "provider",
            _bounded_text(self.provider, field="provider", maximum=256),
        )
        object.__setattr__(
            self,
            "model",
            _model_identity(self.model),
        )
        if not isinstance(self.input_sha256, Sha256) or not isinstance(
            self.parameters_sha256, Sha256
        ):
            raise TypeError("Agent provenance hashes are invalid")
        if not isinstance(self.usage, AgentUsage):
            raise TypeError("Agent provenance usage must be AgentUsage")


@dataclass(frozen=True, slots=True)
class AgentStructuredResponse:
    result: str = field(repr=False)
    provenance: AgentProvenance

    def __post_init__(self) -> None:
        if type(self.result) is not str:
            raise TypeError("structured result must be text")
        if utf8_size(self.result) > _MAX_RESULT_BYTES:
            raise ValueError("structured result exceeds its byte budget")
        parsed = parse_strict_json_object(self.result)
        result = canonical_json_bytes(parsed).decode("utf-8", errors="strict")
        if utf8_size(result) > _MAX_RESULT_BYTES:
            raise ValueError("structured result exceeds its byte budget")
        object.__setattr__(self, "result", result)
        if not isinstance(self.provenance, AgentProvenance):
            raise TypeError("structured provenance must be AgentProvenance")

    @property
    def value(self) -> dict[str, object]:
        """Return a fresh parsed object; no mutable value is retained."""

        return parse_strict_json_object(self.result)


@dataclass(frozen=True, slots=True)
class AgentBudget:
    max_prompt_bytes: int = 131_072
    max_input_bytes: int = 8_388_608
    max_schema_bytes: int = 262_144
    max_request_bytes: int = 10_000_000
    max_response_bytes: int = 10_000_000
    max_result_bytes: int = 8_388_608
    max_output_tokens: int = 131_072
    context_window_tokens: int = 1_000_000
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
            "context_window_tokens",
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
                raise TypeError(f"{field_name} must be numeric")
            normalized = float(value)
            if not math.isfinite(normalized) or normalized <= 0:
                raise ValueError(f"{field_name} must be finite and positive")
            object.__setattr__(self, field_name, normalized)
        if self.overall_timeout_seconds < max(
            self.connect_timeout_seconds,
            self.read_timeout_seconds,
        ):
            raise ValueError("overall timeout must cover each phase timeout")
        if self.max_output_tokens > self.context_window_tokens:
            raise ValueError("output token budget must fit the context window")
        if type(self.max_redirects) is not int or type(self.max_retries) is not int:
            raise TypeError("Agent redirects and retries must be integers")
        if self.max_redirects != 0 or self.max_retries != 0:
            raise ValueError("Agent redirects and non-idempotent retries must be disabled")

    @classmethod
    def stricter(cls, *budgets: "AgentBudget") -> "AgentBudget":
        """Return one budget that cannot exceed any supplied budget."""

        if not budgets or any(not isinstance(value, cls) for value in budgets):
            raise TypeError("budgets must contain AgentBudget values")
        return cls(
            max_prompt_bytes=min(value.max_prompt_bytes for value in budgets),
            max_input_bytes=min(value.max_input_bytes for value in budgets),
            max_schema_bytes=min(value.max_schema_bytes for value in budgets),
            max_request_bytes=min(value.max_request_bytes for value in budgets),
            max_response_bytes=min(value.max_response_bytes for value in budgets),
            max_result_bytes=min(value.max_result_bytes for value in budgets),
            max_output_tokens=min(value.max_output_tokens for value in budgets),
            context_window_tokens=min(value.context_window_tokens for value in budgets),
            connect_timeout_seconds=min(value.connect_timeout_seconds for value in budgets),
            read_timeout_seconds=min(value.read_timeout_seconds for value in budgets),
            overall_timeout_seconds=min(value.overall_timeout_seconds for value in budgets),
        )


@dataclass(frozen=True, slots=True, repr=False)
class AgentRequest:
    role: AgentRole
    capabilities: frozenset["AgentCapability"]
    model: str
    input_sha256: Sha256
    text_parts: tuple[AgentTextPart, ...] = ()
    image_parts: tuple[AgentImagePart, ...] = ()
    response_schema: str | None = field(default=None, repr=False)
    tools: tuple[AgentToolDeclaration, ...] = ()
    history: tuple["AgentResult", ...] = field(default=(), repr=False)
    max_output_tokens: int = 1
    budget: AgentBudget = AgentBudget()
    cancel_event: threading.Event | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if not isinstance(self.role, AgentRole):
            raise TypeError("role must be AgentRole")
        model = _model_identity(self.model)
        object.__setattr__(self, "model", model)
        if not isinstance(self.input_sha256, Sha256):
            raise TypeError("input_sha256 must be Sha256")
        _validate_request_parts(self.text_parts, self.image_parts, self.tools)
        _validate_request_history(self.history)
        if type(self.max_output_tokens) is not int or self.max_output_tokens < 1:
            raise ValueError("max_output_tokens must be positive")
        if not isinstance(self.budget, AgentBudget):
            raise TypeError("budget must be AgentBudget")
        if self.response_schema is not None:
            if utf8_size(self.response_schema) > _MAX_SCHEMA_BYTES:
                raise ValueError("response schema exceeds its byte budget")
            parse_strict_json_object(self.response_schema)
        _validate_request_capabilities(
            self.capabilities,
            self.image_parts,
            self.tools,
            self.response_schema,
        )
        if self.cancel_event is not None and not callable(
            getattr(self.cancel_event, "is_set", None)
        ):
            raise TypeError("cancel_event must expose is_set()")

    @property
    def system_text(self) -> str:
        return self.text_parts[0].text if self.text_parts else ""

    @property
    def user_text(self) -> str:
        return self.text_parts[-1].text if self.text_parts else ""

    @property
    def structured_input(self) -> str:
        return self.user_text

    @property
    def prompt(self) -> str:
        return self.system_text

    def __repr__(self) -> str:
        capabilities = sorted(c.value for c in self.capabilities)
        return f"<AgentRequest role={self.role.value} capabilities={capabilities}>"


AgentResult = AgentStructuredResponse | AgentToolDecision


def _validate_request_parts(
    text_parts: object,
    image_parts: object,
    tools: object,
) -> None:
    if not isinstance(text_parts, tuple) or any(
        not isinstance(part, AgentTextPart) for part in text_parts
    ):
        raise TypeError("text_parts must contain AgentTextPart values")
    if not isinstance(image_parts, tuple) or any(
        not isinstance(part, AgentImagePart) for part in image_parts
    ):
        raise TypeError("image_parts must contain AgentImagePart values")
    if not text_parts and not image_parts:
        raise ValueError("Agent request requires bounded text or image input")
    if len(text_parts) > _MAX_TEXT_COUNT:
        raise ValueError("too many Agent text parts")
    if len(image_parts) > _MAX_IMAGE_COUNT:
        raise ValueError("too many Agent image parts")
    if not isinstance(tools, tuple) or any(
        not isinstance(tool, AgentToolDeclaration) for tool in tools
    ):
        raise TypeError("tools must contain AgentToolDeclaration values")
    if len(tools) > _MAX_TOOL_COUNT or len({tool.name for tool in tools}) != len(tools):
        raise ValueError("Agent tool declarations must be unique and bounded")


def _validate_request_history(history: object) -> None:
    if not isinstance(history, tuple) or any(
        not isinstance(item, (AgentStructuredResponse, AgentToolDecision)) for item in history
    ):
        raise TypeError("history must contain Agent result values")
    if len(history) > 32:
        raise ValueError("Agent history is too long")


def _validate_request_capabilities(
    capabilities: object,
    image_parts: tuple[AgentImagePart, ...],
    tools: tuple[AgentToolDeclaration, ...],
    response_schema: str | None,
) -> None:
    if not isinstance(capabilities, frozenset) or any(
        not isinstance(value, AgentCapability) for value in capabilities
    ):
        raise TypeError("capabilities must be an AgentCapability set")
    if not capabilities:
        raise ValueError("at least one Agent capability is required")
    structured = AgentCapability.STRUCTURED_TEXT in capabilities
    tool_decision = AgentCapability.TOOL_DECISION in capabilities
    image_input = AgentCapability.IMAGE_INPUT in capabilities
    if structured and response_schema is None:
        raise ValueError("structured-text requests require a response schema")
    if not structured and response_schema is not None:
        raise ValueError("response schema requires structured-text capability")
    if image_input and not image_parts:
        raise ValueError("image-input requests require image parts")
    if not image_input and image_parts:
        raise ValueError("image parts require image-input capability")
    if tool_decision and not tools:
        raise ValueError("tool-decision requests require tool declarations")
    if not tool_decision and tools:
        raise ValueError("tool declarations require tool-decision capability")
    if structured and tool_decision:
        raise ValueError("structured-text and tool-decision cannot be mixed")


def request_input_hash(value: str) -> Sha256:
    return sha256_digest(value.encode("utf-8"))


def validate_tool_arguments(declaration: AgentToolDeclaration, arguments: str) -> None:
    """Validate one provider tool decision against its declared closed schema."""

    if not isinstance(declaration, AgentToolDeclaration):
        raise TypeError("declaration must be an AgentToolDeclaration")
    value = parse_strict_json_object(arguments)
    schema = parse_strict_json_object(declaration.input_schema)
    _validate_schema_value(schema, value)


def _validate_schema_value(schema: dict[str, object], value: object, *, depth: int = 0) -> None:
    if depth > 16:
        raise ValueError("tool value is too deeply nested")
    schema_type = schema["type"]
    if type(schema_type) is not str:
        raise ValueError("tool schema type is invalid")
    if not _schema_type_matches(schema_type, value):
        raise ValueError("tool value does not match its declared type")
    _validate_schema_literals(schema, value)
    if schema_type == "object":
        _validate_schema_object(schema, value, depth=depth)
    elif schema_type == "array":
        _validate_schema_array(schema, value, depth=depth)
    _validate_schema_alternatives(schema, value, depth=depth)


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


def _validate_schema_literals(schema: dict[str, object], value: object) -> None:
    if "const" in schema and not _json_values_equal(value, schema["const"]):
        raise ValueError("tool value does not match its declared constant")
    if "enum" in schema:
        choices = schema["enum"]
        assert isinstance(choices, list)
        if not any(_json_values_equal(value, choice) for choice in choices):
            raise ValueError("tool value is outside its declared enum")


def _validate_schema_object(
    schema: dict[str, object],
    value: object,
    *,
    depth: int,
) -> None:
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


def _validate_schema_array(
    schema: dict[str, object],
    value: object,
    *,
    depth: int,
) -> None:
    assert isinstance(value, list)
    item_schema = schema["items"]
    assert isinstance(item_schema, dict)
    for child in value:
        _validate_schema_value(item_schema, child, depth=depth + 1)


def _validate_schema_alternatives(
    schema: dict[str, object],
    value: object,
    *,
    depth: int,
) -> None:
    if "anyOf" not in schema:
        return
    alternatives = schema["anyOf"]
    assert isinstance(alternatives, list)
    for alternative in alternatives:
        assert isinstance(alternative, dict)
        try:
            _validate_schema_value(alternative, value, depth=depth + 1)
        except ValueError:
            continue
        return
    raise ValueError("tool value does not match any declared alternative")


def _json_values_equal(left: object, right: object) -> bool:
    return canonical_json_bytes(left) == canonical_json_bytes(right)


__all__ = (
    "AgentBudget",
    "AgentCapability",
    "AgentImagePart",
    "AgentProvenance",
    "AgentRequest",
    "AgentResult",
    "AgentRole",
    "AgentStructuredResponse",
    "AgentTextPart",
    "AgentToolDecision",
    "AgentToolDeclaration",
    "AgentUsage",
    "canonical_json_bytes",
    "parse_strict_json",
    "parse_strict_json_object",
    "request_input_hash",
    "utf8_size",
    "validate_tool_arguments",
)
