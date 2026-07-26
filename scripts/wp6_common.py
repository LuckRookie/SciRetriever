"""Shared read-only primitives for WP6 governance gates."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
from typing import TypeAlias


JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | list["JsonValue"] | dict[str, "JsonValue"]


@dataclass(frozen=True, slots=True)
class ChangedPath:
    path: str
    status: str


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def canonical_json(value: JsonValue) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def safe_relative_path(raw: str) -> str | None:
    path = PurePosixPath(raw)
    if not raw or path.is_absolute() or ".." in path.parts or path.as_posix() != raw:
        return None
    return raw


def read_regular_bytes(path: Path) -> tuple[bytes | None, str | None]:
    if path.is_symlink():
        return None, f"{path}: symlinks are forbidden"
    if not path.is_file():
        return None, f"{path}: regular file is required"
    try:
        return path.read_bytes(), None
    except OSError as error:
        return None, f"{path}: cannot read: {error}"


def load_json(path: Path) -> tuple[JsonValue | None, str | None]:
    payload, error = read_regular_bytes(path)
    if error is not None or payload is None:
        return None, error
    try:
        text = payload.decode("utf-8")
        return json.loads(text), None
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        return None, f"{path}: invalid UTF-8 JSON: {error}"


def git_bytes(root: Path, arguments: tuple[str, ...]) -> tuple[bytes | None, str | None]:
    try:
        completed = subprocess.run(
            ("git", *arguments),
            cwd=root,
            check=False,
            capture_output=True,
        )
    except OSError as error:
        return None, f"git {' '.join(arguments)}: cannot execute: {error}"
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        return None, f"git {' '.join(arguments)} failed: {detail}"
    return completed.stdout, None


def changed_paths(root: Path, baseline: str) -> tuple[tuple[ChangedPath, ...], tuple[str, ...]]:
    tracked, error = git_bytes(
        root,
        ("diff", "--no-renames", "--name-status", "-z", baseline, "--"),
    )
    if error is not None or tracked is None:
        return (), (error or "git diff failed",)
    untracked, error = git_bytes(
        root,
        ("ls-files", "--others", "--exclude-standard", "-z"),
    )
    if error is not None or untracked is None:
        return (), (error or "git ls-files failed",)
    fields = tracked.decode("utf-8", errors="strict").split("\0")
    entries: list[ChangedPath] = []
    for index in range(0, len(fields) - 1, 2):
        status = fields[index]
        path = fields[index + 1]
        if status not in {"A", "M", "D"}:
            return (), (f"{path}: unsupported Git status {status!r}",)
        entries.append(ChangedPath(path=path, status=status))
    entries.extend(
        ChangedPath(path=path, status="A")
        for path in untracked.decode("utf-8", errors="strict").split("\0")
        if path
    )
    by_path: dict[str, ChangedPath] = {}
    for entry in entries:
        if safe_relative_path(entry.path) is None:
            return (), (f"{entry.path!r}: unsafe changed path",)
        if entry.path in by_path:
            return (), (f"{entry.path}: conflicting Git statuses",)
        by_path[entry.path] = entry
    return tuple(sorted(by_path.values(), key=lambda item: item.path)), ()


__all__ = (
    "ChangedPath",
    "JsonValue",
    "canonical_json",
    "changed_paths",
    "git_bytes",
    "load_json",
    "read_regular_bytes",
    "safe_relative_path",
    "sha256_bytes",
)
