from __future__ import annotations

import math
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sciretriever.errors import ConfigError


def config_error(field_name: str, requirement: str) -> ConfigError:
    return ConfigError(f"config field {field_name} {requirement}")


def table(root: Mapping[str, Any], name: str, allowed: set[str]) -> Mapping[str, Any]:
    value = root.get(name, {})
    if not isinstance(value, dict):
        raise config_error(name, "must be a table")
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ConfigError(f"unknown config field: {name}.{unknown[0]}")
    return value


def nonblank(value: Any, name: str, *, credential: bool = False) -> str:
    if not isinstance(value, str) or not value.strip():
        raise config_error(name, "must be a nonblank string")
    return value.strip() if credential else value


def optional_string(table_value: Mapping[str, Any], name: str, prefix: str) -> str | None:
    return None if name not in table_value else nonblank(table_value[name], f"{prefix}.{name}")


def positive_int(value: Any, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise config_error(name, "must be a positive integer")
    return value


def nonnegative_int(value: Any, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise config_error(name, "must be a nonnegative integer")
    return value


def optional_limit(value: Any, name: str) -> int | None:
    if value is False:
        return None
    return positive_int(value, name)


def positive_number(value: Any, name: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise config_error(name, "must be a positive finite number")
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise config_error(name, "must be a positive finite number")
    return parsed


def nonnegative_number(value: Any, name: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise config_error(name, "must be a nonnegative finite number")
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < 0:
        raise config_error(name, "must be a nonnegative finite number")
    return parsed


def string_list(value: Any, name: str, *, nonempty: bool = False) -> tuple[str, ...]:
    if not isinstance(value, list) or (nonempty and not value):
        qualifier = "nonempty " if nonempty else ""
        raise config_error(name, f"must be a {qualifier}string list")
    result = tuple(nonblank(item, name) for item in value)
    if len(set(result)) != len(result):
        raise config_error(name, "must not contain duplicate values")
    return result


def choice(value: Any, name: str, choices: set[str]) -> str:
    parsed = nonblank(value, name)
    if parsed not in choices:
        raise config_error(name, "has an unsupported value")
    return parsed


def boolean(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise config_error(name, "must be a boolean")
    return value


def config_path(value: Any, name: str, parent: Path) -> Path:
    raw = nonblank(value, name)
    expanded = Path(raw).expanduser()
    if not expanded.is_absolute():
        expanded = parent / expanded
    return expanded.resolve(strict=False)


def env_name(value: Any, name: str) -> str:
    parsed = nonblank(value, name)
    if re.fullmatch(r"[A-Z_][A-Z0-9_]{0,127}", parsed) is None:
        raise config_error(name, "must be an environment variable name")
    return parsed


def bounded_positive(
    table_value: Mapping[str, Any],
    name: str,
    prefix: str,
    default: int,
    maximum: int,
) -> int:
    value = default if name not in table_value else positive_int(
        table_value[name], f"{prefix}.{name}"
    )
    if value > maximum:
        raise config_error(f"{prefix}.{name}", "exceeds the supported bound")
    return value


__all__ = (
    "boolean",
    "bounded_positive",
    "choice",
    "config_error",
    "config_path",
    "env_name",
    "nonblank",
    "nonnegative_int",
    "nonnegative_number",
    "optional_limit",
    "optional_string",
    "positive_int",
    "positive_number",
    "string_list",
    "table",
)
