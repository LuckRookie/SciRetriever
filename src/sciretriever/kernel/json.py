from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import NoReturn, TypeAlias

from sciretriever.kernel.errors import BoundaryError

CanonicalJsonScalar: TypeAlias = None | bool | int | float | str


@dataclass(frozen=True, slots=True)
class CanonicalJsonObject:
    entries: tuple[tuple[str, "CanonicalJsonValue"], ...]

    def __post_init__(self) -> None:
        keys = tuple(key for key, _value in self.entries)
        if not all(isinstance(key, str) for key in keys):
            raise BoundaryError.for_field("payload", "object keys must be strings")
        if len(keys) != len(set(keys)):
            raise BoundaryError.for_field("payload", "object keys must be unique")
        for _key, value in self.entries:
            _validate_value(value)
        object.__setattr__(self, "entries", tuple(sorted(self.entries, key=lambda item: item[0])))


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
            raise BoundaryError.for_field("payload", "numbers must be finite")
        case tuple():
            for item in value:
                _validate_value(item)
        case CanonicalJsonObject():
            return
        case _:
            raise BoundaryError.for_field("payload", "must contain only canonical JSON values")
            assert_never(value)


def _freeze(value: CanonicalJsonInput) -> CanonicalJsonValue:
    match value:
        case None | bool() | int() | str():
            return value
        case float() if math.isfinite(value):
            return value
        case float():
            raise BoundaryError.for_field("payload", "numbers must be finite")
        case list():
            return tuple(_freeze(item) for item in value)
        case dict():
            return CanonicalJsonObject(tuple((key, _freeze(item)) for key, item in value.items()))
        case _:
            raise BoundaryError.for_field("payload", "must contain only canonical JSON values")
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
            raise BoundaryError.for_field("payload", "must contain only canonical JSON values")
            assert_never(value)


def _reject_constant(value: str) -> CanonicalJsonInput:
    raise BoundaryError.for_field("payload", f"contains non-finite number {value}")


def _object(entries: list[tuple[str, CanonicalJsonInput]]) -> CanonicalJsonInput:
    keys = tuple(key for key, _value in entries)
    if len(keys) != len(set(keys)):
        raise BoundaryError.for_field("payload", "object keys must be unique")
    return dict(entries)


def parse_canonical_json(payload: str) -> CanonicalJsonValue:
    if not isinstance(payload, str):
        raise BoundaryError.for_field("payload", "must be a JSON string")
    try:
        decoded: CanonicalJsonInput = json.loads(
            payload,
            parse_constant=_reject_constant,
            object_pairs_hook=_object,
        )
    except (json.JSONDecodeError, UnicodeEncodeError) as error:
        raise BoundaryError.for_field("payload", "must be valid Unicode JSON") from error
    try:
        payload.encode("utf-8")
    except UnicodeEncodeError as error:
        raise BoundaryError.for_field(
            "payload", "must contain valid Unicode scalar values"
        ) from error
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
        raise BoundaryError.for_field("payload", "must be canonical JSON") from error
    return text.encode("ascii")
