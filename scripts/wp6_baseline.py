"""Strict loading of the immutable WP6 Todo 1 baseline identity."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
from typing import Final

from scripts.wp6_common import (
    canonical_json,
    load_json,
    read_regular_bytes,
    safe_relative_path,
    sha256_bytes,
)


_BASELINE_PATH: Final = Path(".omo/evidence/wp6/baseline-pure-loc.json")
_RECEIPT_PATH: Final = Path(".omo/evidence/wp6/task-1.txt")
_RECEIPT_KEYS: Final = frozenset(
    {"baseline_commit", "baseline_pure_loc_sha256"}
)
_COMMIT_PATTERN: Final = re.compile(r"[0-9a-f]{40}")
_SHA256_PATTERN: Final = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True, slots=True)
class Todo1Baseline:
    commit: str
    manifest_sha256: str


def _receipt_values(payload: bytes) -> tuple[dict[str, str], tuple[str, ...]]:
    try:
        lines = payload.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        return {}, ("Todo 1 receipt must be UTF-8",)
    values: dict[str, str] = {}
    for line in lines:
        key = line.partition("=")[0]
        if key not in _RECEIPT_KEYS:
            continue
        if line.count("=") != 1:
            return {}, (f"Todo 1 receipt field {key} is malformed",)
        value = line.partition("=")[2]
        if key in values:
            return {}, (f"Todo 1 receipt field {key} is duplicated",)
        values[key] = value
    missing = sorted(_RECEIPT_KEYS - values.keys())
    if missing:
        return {}, (f"Todo 1 receipt field {missing[0]} is missing",)
    if _COMMIT_PATTERN.fullmatch(values["baseline_commit"]) is None:
        return {}, ("Todo 1 receipt baseline_commit is malformed",)
    if _SHA256_PATTERN.fullmatch(values["baseline_pure_loc_sha256"]) is None:
        return {}, ("Todo 1 receipt baseline_pure_loc_sha256 is malformed",)
    return values, ()


def load_todo1_baseline(root: Path) -> tuple[Todo1Baseline | None, tuple[str, ...]]:
    receipt_payload, receipt_error = read_regular_bytes(root / _RECEIPT_PATH)
    if receipt_error is not None or receipt_payload is None:
        return None, (receipt_error or "Todo 1 receipt cannot be read",)
    receipt, errors = _receipt_values(receipt_payload)
    if errors:
        return None, errors

    manifest_path = root / _BASELINE_PATH
    manifest_payload, manifest_error = read_regular_bytes(manifest_path)
    if manifest_error is not None or manifest_payload is None:
        return None, (manifest_error or "Todo 1 baseline manifest cannot be read",)
    if sha256_bytes(manifest_payload) != receipt["baseline_pure_loc_sha256"]:
        return None, ("Todo 1 baseline manifest SHA256 does not match receipt",)
    value, json_error = load_json(manifest_path)
    if json_error is not None or not isinstance(value, dict):
        return None, (json_error or "Todo 1 baseline manifest must be an object",)
    if set(value) != {"version", "baseline_commit", "python", "algorithm", "files"}:
        return None, ("Todo 1 baseline manifest schema mismatch",)
    commit = value.get("baseline_commit")
    files = value.get("files")
    if (
        value.get("version") != 1
        or value.get("python") != "3.12"
        or value.get("algorithm") != "tokenize-physical-v1"
        or not isinstance(commit, str)
        or _COMMIT_PATTERN.fullmatch(commit) is None
        or not isinstance(files, list)
        or canonical_json(value) != manifest_payload
    ):
        return None, ("Todo 1 baseline manifest contract is invalid",)
    paths: list[str] = []
    for entry in files:
        match entry:
            case {"path": str(path), "pure_loc": int(pure_loc)} if (
                set(entry) == {"path", "pure_loc"}
                and safe_relative_path(path) is not None
                and pure_loc >= 0
                and path not in paths
            ):
                paths.append(path)
            case _:
                return None, ("Todo 1 baseline manifest file entry is invalid",)
    if paths != sorted(paths):
        return None, ("Todo 1 baseline manifest file entries are not sorted",)
    if commit != receipt["baseline_commit"]:
        return None, ("Todo 1 baseline commit does not match receipt",)
    return Todo1Baseline(commit=commit, manifest_sha256=sha256_bytes(manifest_payload)), ()


__all__ = ("Todo1Baseline", "load_todo1_baseline")
