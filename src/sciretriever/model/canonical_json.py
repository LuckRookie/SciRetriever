from __future__ import annotations

import json
import math
from typing import NoReturn, TypeAlias


class CanonicalJsonError(ValueError):
    """Raised when a value cannot be represented as canonical JSON."""


CanonicalJsonScalar: TypeAlias = None | bool | int | float | str


class CanonicalJsonObject:
    __slots__ = ("_entries",)

    def __init__(self, entries: tuple[tuple[str, "CanonicalJsonValue"], ...]) -> None:
        keys = tuple(key for key, _value in entries)
        if not all(isinstance(key, str) for key in keys):
            raise CanonicalJsonError("object keys must be strings")
        if len(keys) != len(set(keys)):
            raise CanonicalJsonError("object keys must be unique")
        for _key, value in entries:
            _validate_value(value)
        object.__setattr__(self, "_entries", tuple(sorted(entries, key=lambda item: item[0])))

    @property
    def entries(self) -> tuple[tuple[str, "CanonicalJsonValue"], ...]:
        return self._entries

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, CanonicalJsonObject):
            return NotImplemented
        return self.entries == other.entries

    def __hash__(self) -> int:
        return hash(self.entries)


CanonicalJsonValue: TypeAlias = (
    CanonicalJsonScalar | tuple["CanonicalJsonValue", ...] | CanonicalJsonObject
)
CanonicalJsonInput: TypeAlias = (
    CanonicalJsonScalar | list["CanonicalJsonInput"] | dict[str, "CanonicalJsonInput"]
)
JsonOutput: TypeAlias = CanonicalJsonScalar | list["JsonOutput"] | dict[str, "JsonOutput"]


def assert_never(value: NoReturn) -> NoReturn:
    raise AssertionError(f"unhandled canonical JSON value: {value!r}")


def _validate_value(value: CanonicalJsonValue) -> None:
    match value:
        case None | bool() | int() | str():
            return
        case float() if math.isfinite(value):
            return
        case float():
            raise CanonicalJsonError("numbers must be finite")
        case tuple():
            for item in value:
                _validate_value(item)
        case CanonicalJsonObject():
            return
        case _:
            raise CanonicalJsonError("must contain only canonical JSON values")
            assert_never(value)


def _freeze(value: CanonicalJsonInput) -> CanonicalJsonValue:
    match value:
        case None | bool() | int() | str():
            return value
        case float() if math.isfinite(value):
            return value
        case float():
            raise CanonicalJsonError("numbers must be finite")
        case list():
            return tuple(_freeze(item) for item in value)
        case dict():
            return CanonicalJsonObject(tuple((key, _freeze(item)) for key, item in value.items()))
        case _:
            raise CanonicalJsonError("must contain only canonical JSON values")
            assert_never(value)


def _thaw(value: CanonicalJsonValue) -> JsonOutput:
    match value:
        case None | bool() | int() | float() | str():
            return value
        case tuple():
            return [_thaw(item) for item in value]
        case CanonicalJsonObject(entries=entries):
            return {key: _thaw(item) for key, item in entries}
        case _:
            raise CanonicalJsonError("must contain only canonical JSON values")
            assert_never(value)


def _reject_constant(value: str) -> CanonicalJsonInput:
    raise CanonicalJsonError(f"contains non-finite number {value}")


def _object(entries: list[tuple[str, CanonicalJsonInput]]) -> CanonicalJsonInput:
    keys = tuple(key for key, _value in entries)
    if len(keys) != len(set(keys)):
        raise CanonicalJsonError("object keys must be unique")
    return dict(entries)


def parse_canonical_json(payload: str) -> CanonicalJsonValue:
    if not isinstance(payload, str):
        raise CanonicalJsonError("must be a JSON string")
    try:
        decoded: CanonicalJsonInput = json.loads(
            payload,
            parse_constant=_reject_constant,
            object_pairs_hook=_object,
        )
    except (CanonicalJsonError, json.JSONDecodeError, UnicodeEncodeError) as error:
        raise CanonicalJsonError("must be valid Unicode JSON") from error
    try:
        payload.encode("utf-8")
    except UnicodeEncodeError as error:
        raise CanonicalJsonError("must contain valid Unicode scalar values") from error
    return _freeze(decoded)


def canonical_json_bytes(value: CanonicalJsonValue) -> bytes:
    _validate_value(value)
    try:
        text = json.dumps(
            _thaw(value),
            ensure_ascii=True,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as error:
        raise CanonicalJsonError("must be canonical JSON") from error
    return text.encode("ascii")


__all__ = (
    "CanonicalJsonError",
    "CanonicalJsonInput",
    "CanonicalJsonObject",
    "CanonicalJsonScalar",
    "CanonicalJsonValue",
    "JsonOutput",
    "canonical_json_bytes",
    "parse_canonical_json",
)
