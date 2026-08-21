"""Small no-follow filesystem primitives shared inside configuration."""

from __future__ import annotations

import os
import stat
from pathlib import Path

from .errors import fail


def safe_path(value: str | Path) -> Path:
    if isinstance(value, Path):
        return value
    if type(value) is str:
        return Path(value).expanduser()
    fail("configuration value is invalid")


def current_uid() -> int:
    getter = getattr(os, "geteuid", None) or getattr(os, "getuid", None)
    return 0 if getter is None else getter()


def mode(metadata: os.stat_result) -> int:
    return stat.S_IMODE(metadata.st_mode)


def same_identity(first: os.stat_result, second: os.stat_result) -> bool:
    return os.path.samestat(first, second)


def same_metadata(first: os.stat_result, second: os.stat_result) -> bool:
    return (
        first.st_dev == second.st_dev
        and first.st_ino == second.st_ino
        and stat.S_IFMT(first.st_mode) == stat.S_IFMT(second.st_mode)
        and first.st_size == second.st_size
        and first.st_mtime_ns == second.st_mtime_ns
        and first.st_ctime_ns == second.st_ctime_ns
        and first.st_nlink == second.st_nlink
    )


__all__ = ("current_uid", "mode", "safe_path", "same_identity", "same_metadata")
