from __future__ import annotations

from dataclasses import dataclass
import json
import re
from typing import Final, TypeAlias


SnapshotValue: TypeAlias = str | int | bool | None
_ALLOWED_FIELDS: Final = frozenset(
    {
        "author_id", "decision", "field_name", "manual_value", "preferred_work_version_id",
        "review_id", "source_author_id", "source_work_id", "tag_id", "target_author_id",
        "target_work_id", "value", "work_id", "work_version_id",
    }
)
_SENSITIVE: Final = re.compile(
    r"(?:authorization|cookie|credential|password|path|secret|signature|token|url)", re.IGNORECASE
)
_URL_OR_PATH: Final = re.compile(r"(?:[a-z][a-z0-9+.-]*://|(?:^|[\s])(?:/|~[/\\]|[A-Za-z]:[/\\]))", re.IGNORECASE)
_MAX_FIELDS: Final = 16
_MAX_STRING: Final = 512
_MAX_INTEGER: Final = 2_147_483_647


@dataclass(frozen=True, slots=True)
class SnapshotBoundaryError(ValueError):
    code: str

    def __str__(self) -> str:
        return f"invalid safe snapshot: {self.code}"


@dataclass(frozen=True, slots=True)
class SafeSnapshot:
    values: tuple[tuple[str, SnapshotValue], ...]

    def __post_init__(self) -> None:
        if not isinstance(self.values, tuple) or len(self.values) > _MAX_FIELDS:
            raise SnapshotBoundaryError("field_count")
        names: list[str] = []
        for pair in self.values:
            if not isinstance(pair, tuple) or len(pair) != 2:
                raise SnapshotBoundaryError("shape")
            name, value = pair
            if not isinstance(name, str) or name not in _ALLOWED_FIELDS or _SENSITIVE.search(name):
                raise SnapshotBoundaryError("field")
            self._check_value(value)
            names.append(name)
        if len(names) != len(set(names)) or self.values != tuple(sorted(self.values)):
            raise SnapshotBoundaryError("field_order")

    @classmethod
    def from_pairs(cls, pairs: tuple[tuple[str, SnapshotValue], ...]) -> SafeSnapshot:
        if not isinstance(pairs, tuple) or len(pairs) > _MAX_FIELDS:
            raise SnapshotBoundaryError("field_count")
        normalized: list[tuple[str, SnapshotValue]] = []
        seen: set[str] = set()
        for pair in pairs:
            if not isinstance(pair, tuple) or len(pair) != 2:
                raise SnapshotBoundaryError("shape")
            name, value = pair
            if not isinstance(name, str) or name not in _ALLOWED_FIELDS or name in seen or _SENSITIVE.search(name):
                raise SnapshotBoundaryError("field")
            cls._check_value(value)
            seen.add(name)
            normalized.append((name, value))
        return cls(tuple(sorted(normalized)))

    @staticmethod
    def _check_value(value: SnapshotValue) -> None:
        match value:
            case None | bool():
                return
            case int():
                if abs(value) > _MAX_INTEGER:
                    raise SnapshotBoundaryError("integer_bound")
            case str():
                if not value or len(value) > _MAX_STRING or _SENSITIVE.search(value) or _URL_OR_PATH.search(value):
                    raise SnapshotBoundaryError("string")
            case _:
                raise SnapshotBoundaryError("value_type")

    def to_dict(self) -> dict[str, SnapshotValue]:
        return dict(self.values)

    @classmethod
    def from_dict(cls, value: dict[str, SnapshotValue]) -> SafeSnapshot:
        return cls.from_pairs(tuple(value.items()))


def canonical_json_bytes(value: dict[str, SnapshotValue] | dict[str, dict[str, SnapshotValue] | SnapshotValue]) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":"), sort_keys=True).encode("ascii")
    except (TypeError, ValueError) as error:
        raise SnapshotBoundaryError("json_value") from error


def strict_json_object(payload: bytes) -> dict[str, SnapshotValue | dict[str, SnapshotValue]]:
    if not isinstance(payload, bytes) or len(payload) > 16_384:
        raise SnapshotBoundaryError("payload_bound")

    def pairs_hook(pairs: list[tuple[str, SnapshotValue | dict[str, SnapshotValue]]]) -> dict[str, SnapshotValue | dict[str, SnapshotValue]]:
        result: dict[str, SnapshotValue | dict[str, SnapshotValue]] = {}
        for key, value in pairs:
            if key in result:
                raise SnapshotBoundaryError("duplicate_key")
            result[key] = value
        return result

    try:
        decoded = json.loads(payload.decode("ascii"), object_pairs_hook=pairs_hook)
    except (UnicodeDecodeError, json.JSONDecodeError, SnapshotBoundaryError):
        raise SnapshotBoundaryError("json_shape") from None
    if not isinstance(decoded, dict):
        raise SnapshotBoundaryError("json_object")
    canonical = json.dumps(decoded, ensure_ascii=True, allow_nan=False, separators=(",", ":"), sort_keys=True).encode("ascii")
    if canonical != payload:
        raise SnapshotBoundaryError("canonical_json")
    return decoded


__all__ = ("SafeSnapshot", "SnapshotBoundaryError", "SnapshotValue", "canonical_json_bytes", "strict_json_object")
