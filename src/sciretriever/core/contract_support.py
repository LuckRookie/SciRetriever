"""Validation and JSON support shared by neutral wire contracts."""

from __future__ import annotations

import json
from typing import Any


def normalized_text(value: str, field_name: str, *, allow_blank: bool = False) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    normalized = " ".join(value.split())
    if not normalized and not allow_blank:
        raise ValueError(f"{field_name} must not be blank")
    return normalized


def optional_text(value: str | None, field_name: str) -> str | None:
    return None if value is None else normalized_text(value, field_name)


def string_tuple(value: tuple[str, ...], field_name: str) -> tuple[str, ...]:
    if not isinstance(value, tuple):
        raise TypeError(f"{field_name} must be a tuple")
    return tuple(normalized_text(item, f"{field_name} item") for item in value)


def mapping(data: object, type_name: str) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise TypeError(f"{type_name} must be a dictionary")
    if not all(isinstance(key, str) for key in data):
        raise TypeError(f"{type_name} keys must be strings")
    return data


def fields(data: dict[str, Any], type_name: str, expected: frozenset[str]) -> None:
    unknown = data.keys() - expected
    missing = expected - data.keys()
    if unknown:
        raise ValueError(f"{type_name} has unknown fields: {', '.join(sorted(unknown))}")
    if missing:
        raise ValueError(f"{type_name} is missing fields: {', '.join(sorted(missing))}")


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key: {key!r}")
        result[key] = value
    return result


def json_object(line: str, type_name: str) -> dict[str, Any]:
    if not isinstance(line, str):
        raise TypeError("JSON line must be a string")
    if line.endswith("\r\n"):
        line = line[:-2]
    elif line.endswith("\n"):
        line = line[:-1]
    if not line.strip():
        raise ValueError("JSON input must not be blank")
    if "\n" in line or "\r" in line:
        raise ValueError("JSON input must contain exactly one line")
    try:
        value = json.loads(line, object_pairs_hook=_unique_json_object)
    except json.JSONDecodeError as error:
        raise ValueError(f"invalid JSON: {error.msg}") from error
    return mapping(value, type_name)


def compact_json(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
