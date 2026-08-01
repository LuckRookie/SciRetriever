from __future__ import annotations

import os
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Final

_DIRECTORY_FLAGS: Final = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
_READ_FLAGS: Final = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)


class ArtifactFilesystemError(Exception):
    __slots__ = ("reason",)

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)

    def __str__(self) -> str:
        return self.reason


def _validate_directory(descriptor: int, subject: str) -> None:
    metadata = os.fstat(descriptor)
    if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise ArtifactFilesystemError(f"{subject} must be owner-only")


def _open_directory(parent: int, name: str, subject: str) -> int:
    try:
        descriptor = os.open(name, _DIRECTORY_FLAGS, dir_fd=parent)
    except OSError as error:
        raise ArtifactFilesystemError(f"{subject} is missing or unsafe") from error
    try:
        _validate_directory(descriptor, subject)
    except ArtifactFilesystemError:
        os.close(descriptor)
        raise
    return descriptor


def _ensure_directory(parent: int, name: str, subject: str) -> int:
    try:
        os.mkdir(name, 0o700, dir_fd=parent)
        os.fsync(parent)
    except FileExistsError:
        metadata = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISDIR(metadata.st_mode):
            raise ArtifactFilesystemError(f"{subject} is not a directory")
    return _open_directory(parent, name, subject)


@dataclass(frozen=True, slots=True)
class CoreStorage:
    root: Path

    @contextmanager
    def open_core(self) -> Iterator[int]:
        parent = self.root.parent
        try:
            parent_descriptor = os.open(parent, _DIRECTORY_FLAGS)
        except OSError as error:
            raise ArtifactFilesystemError("storage parent is missing or unsafe") from error
        root_descriptor = -1
        core_descriptor = -1
        try:
            _validate_directory(parent_descriptor, "storage parent")
            root_descriptor = _ensure_directory(parent_descriptor, self.root.name, "storage root")
            core_descriptor = _ensure_directory(root_descriptor, "core", "core root")
            yield core_descriptor
        finally:
            if core_descriptor >= 0:
                os.close(core_descriptor)
            if root_descriptor >= 0:
                os.close(root_descriptor)
            os.close(parent_descriptor)


def ensure_child(parent: int, name: str, subject: str) -> int:
    return _ensure_directory(parent, name, subject)


def open_child(parent: int, name: str, subject: str) -> int:
    return _open_directory(parent, name, subject)


def open_regular(parent: int, name: str) -> int:
    descriptor = os.open(name, _READ_FLAGS, dir_fd=parent)
    metadata = os.fstat(descriptor)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink < 1
    ):
        os.close(descriptor)
        raise ArtifactFilesystemError("artifact must be an owner-only regular file")
    return descriptor
