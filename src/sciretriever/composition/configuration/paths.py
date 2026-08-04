from __future__ import annotations

import os
import stat
from datetime import date, datetime, time
from pathlib import Path
from typing import Literal, NoReturn, TypeAlias

from typing_extensions import LiteralString

from sciretriever.model.configuration import TargetConfig

from .errors import raise_configuration_error

TomlValue: TypeAlias = (
    bool
    | int
    | float
    | str
    | date
    | datetime
    | time
    | Path
    | list["TomlValue"]
    | dict[str, "TomlValue"]
)
TomlTable: TypeAlias = dict[str, TomlValue]

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]


def prepare_paths(payload: TomlTable, base: Path) -> None:
    paths = payload.get("paths")
    if not isinstance(paths, dict):
        return
    for field in ("catalog", "storage_root"):
        raw = paths.get(field)
        if isinstance(raw, str):
            paths[field] = _resolve_path(raw, base, field)


def validate_paths(config: TargetConfig) -> None:
    catalog = config.paths.catalog
    storage_root = config.paths.storage_root
    _validate_runtime_path(catalog, "catalog")
    _validate_runtime_path(storage_root, "storage_root")
    if (
        catalog == storage_root
        or catalog in storage_root.parents
        or storage_root in catalog.parents
    ):
        raise_configuration_error(
            ("paths",), "catalog and storage_root must not overlap", code="unsafe_path"
        )


def _resolve_path(raw: str, base: Path, field: Literal["catalog", "storage_root"]) -> Path:
    candidate = Path(raw).expanduser()
    if ".." in candidate.parts:
        _raise_unsafe_path(field, "relative paths must not contain parent traversal")
    original = candidate if candidate.is_absolute() else base / candidate
    _validate_path(original, field)
    try:
        resolved = original.resolve(strict=False)
    except (OSError, RuntimeError):
        _raise_unsafe_path(field, "path could not be canonicalized")
    _validate_path(resolved, field)
    if resolved == REPOSITORY_ROOT or REPOSITORY_ROOT in resolved.parents:
        _raise_unsafe_path(field, "runtime paths must be outside the repository")
    return resolved


def _validate_runtime_path(path: Path, field: Literal["catalog", "storage_root"]) -> None:
    if not path.is_absolute() or ".." in path.parts:
        _raise_unsafe_path(field, "runtime paths must be canonical absolute paths")
    try:
        canonical = path.resolve(strict=False)
    except (OSError, RuntimeError):
        _raise_unsafe_path(field, "path could not be canonicalized")
    if canonical != path:
        _raise_unsafe_path(field, "runtime paths must be canonical absolute paths")
    if canonical == REPOSITORY_ROOT or REPOSITORY_ROOT in canonical.parents:
        _raise_unsafe_path(field, "runtime paths must be outside the repository")
    _validate_path(path, field)


def _validate_path(path: Path, field: Literal["catalog", "storage_root"]) -> None:
    if not path.is_absolute():
        _raise_unsafe_path(field, "runtime paths must be canonical absolute paths")
    components = _existing_components(path, field)
    if not components:
        return
    current_uid = os.getuid()
    deepest_path, deepest_metadata = components[-1]
    _validate_component_permissions(components, current_uid, field)
    _validate_existing_target(deepest_path, deepest_metadata, path, field)


def _validate_component_permissions(
    components: list[tuple[Path, os.stat_result]],
    current_uid: int,
    field: Literal["catalog", "storage_root"],
) -> None:
    _component, deepest_metadata = components[-1]
    if deepest_metadata.st_uid != current_uid:
        _raise_unsafe_path(field, "path owner must match the current user")
    if deepest_metadata.st_mode & 0o022:
        _raise_unsafe_path(field, "path must not be group or world writable")
    for index, (_component, metadata) in enumerate(components[:-1]):
        if metadata.st_mode & 0o022 and not _allowed_writable_ancestor(
            index, components, current_uid
        ):
            _raise_unsafe_path(field, "path ancestor must not be group or world writable")


def _validate_existing_target(
    deepest_path: Path,
    deepest_metadata: os.stat_result,
    path: Path,
    field: Literal["catalog", "storage_root"],
) -> None:
    if deepest_path != path:
        return
    if field == "catalog":
        if not stat.S_ISREG(deepest_metadata.st_mode):
            _raise_unsafe_path(field, "existing catalog must be a regular file")
        if deepest_metadata.st_nlink != 1:
            _raise_unsafe_path(field, "existing catalog must not have hardlink aliases")
    elif not stat.S_ISDIR(deepest_metadata.st_mode):
        _raise_unsafe_path(field, "existing storage_root must be a directory")


def _allowed_writable_ancestor(
    index: int,
    components: list[tuple[Path, os.stat_result]],
    current_uid: int,
) -> bool:
    metadata = components[index][1]
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or not metadata.st_mode & stat.S_IWOTH
        or not metadata.st_mode & stat.S_ISVTX
        or metadata.st_uid not in {0, current_uid}
    ):
        return False
    return any(
        stat.S_ISDIR(anchor_metadata.st_mode)
        and anchor_metadata.st_uid == current_uid
        and anchor_metadata.st_mode & 0o077 == 0
        for _anchor, anchor_metadata in components[index + 1 :]
    )


def _existing_components(
    path: Path,
    field: Literal["catalog", "storage_root"],
) -> list[tuple[Path, os.stat_result]]:
    current = Path(path.anchor)
    try:
        root_metadata = current.lstat()
    except OSError:
        _raise_unsafe_path(field, "path root is unavailable")
    components: list[tuple[Path, os.stat_result]] = [(current, root_metadata)]
    parts = path.parts[1:]
    for index, part in enumerate(parts, start=1):
        current = current / part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            break
        except NotADirectoryError:
            _raise_unsafe_path(field, "path contains a nondirectory ancestor")
        if stat.S_ISLNK(metadata.st_mode):
            _raise_unsafe_path(field, "path must not contain symbolic links")
        if index < len(path.parts) - 1 and not stat.S_ISDIR(metadata.st_mode):
            _raise_unsafe_path(field, "path contains a nondirectory ancestor")
        components.append((current, metadata))
    return components


def _raise_unsafe_path(field: str, message: LiteralString) -> NoReturn:
    raise_configuration_error(("paths", field), message, code="unsafe_path")


__all__ = ("TomlTable", "TomlValue", "prepare_paths", "validate_paths")
