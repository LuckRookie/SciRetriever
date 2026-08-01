from __future__ import annotations

import os
import stat
import sys
from io import BytesIO
from pathlib import Path
from typing import Literal

from pydantic import ValidationError
from pydantic_core import PydanticCustomError
from typing_extensions import LiteralString

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - exercised on Python 3.10
    import tomli as tomllib

from .config_models import TargetConfig

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def load_target_config(path: str | Path) -> TargetConfig:
    """Parse one target TOML file without reading secrets or constructing runtime clients."""
    config_path = Path(path).expanduser().resolve(strict=True)
    payload = config_path.read_bytes()
    root = tomllib.load(BytesIO(payload))
    paths = root.get("paths")
    if isinstance(paths, dict):
        for key in ("catalog", "storage_root"):
            raw = paths.get(key)
            if isinstance(raw, str):
                paths[key] = _resolve_path(raw, config_path.parent, key)
    return TargetConfig.model_validate(root)


def _resolve_path(raw: str, base: Path, field: Literal["catalog", "storage_root"]) -> Path:
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute() and ".." in candidate.parts:
        _raise_unsafe_path(field, "relative paths must not contain parent traversal")
    original = candidate if candidate.is_absolute() else base / candidate
    _validate_original_path(candidate, base, field)
    resolved = original.resolve(strict=False)
    _validate_original_path(candidate, base, field)
    if resolved == REPOSITORY_ROOT or REPOSITORY_ROOT in resolved.parents:
        _raise_unsafe_path(field, "runtime paths must be outside the repository")
    return resolved


def _validate_original_path(
    candidate: Path,
    base: Path,
    field: Literal["catalog", "storage_root"],
) -> None:
    original = candidate if candidate.is_absolute() else base / candidate
    components = _existing_components(candidate, base, field)
    checked = components[-1:] if candidate.is_absolute() else components
    for component, metadata in checked:
        if metadata.st_uid != os.getuid():
            _raise_unsafe_path(field, "path owner must match the current user")
        if metadata.st_mode & 0o022:
            _raise_unsafe_path(field, "path must not be group or world writable")
    final_metadata = components[-1][1] if components and components[-1][0] == original else None
    if final_metadata is None:
        return
    if field == "catalog":
        if not stat.S_ISREG(final_metadata.st_mode):
            _raise_unsafe_path(field, "existing catalog must be a regular file")
        if final_metadata.st_nlink != 1:
            _raise_unsafe_path(field, "existing catalog must not have hardlink aliases")
    elif not stat.S_ISDIR(final_metadata.st_mode):
        _raise_unsafe_path(field, "existing storage_root must be a directory")


def _existing_components(
    candidate: Path,
    base: Path,
    field: Literal["catalog", "storage_root"],
) -> list[tuple[Path, os.stat_result]]:
    if candidate.is_absolute():
        current = Path(candidate.anchor)
        parts = candidate.parts[1:]
    else:
        current = base
        parts = candidate.parts
    components: list[tuple[Path, os.stat_result]] = []
    for part in ("", *parts):
        current = current if not part else current / part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            break
        if stat.S_ISLNK(metadata.st_mode):
            _raise_unsafe_path(field, "path must not contain symbolic links")
        components.append((current, metadata))
    return components


def _raise_unsafe_path(field: str, message: LiteralString) -> None:
    error = PydanticCustomError("unsafe_path", message)
    raise ValidationError.from_exception_data(
        "TargetConfig", [{"type": error, "loc": ("paths", field), "input": None}]
    )


__all__ = ("load_target_config",)
