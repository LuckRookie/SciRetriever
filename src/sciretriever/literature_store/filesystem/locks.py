from __future__ import annotations

import fcntl
import hashlib
import os
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Final

_DIRECTORY_FLAGS: Final = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
_FILE_FLAGS: Final = os.O_RDWR | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)


class FilesystemSafetyError(Exception):
    __slots__ = ("reason",)

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)

    def __str__(self) -> str:
        return self.reason


@dataclass(frozen=True, slots=True)
class CanonicalCatalogPath:
    parent: Path
    basename: str
    identity: str
    parent_device: int
    parent_inode: int
    final_device: int | None
    final_inode: int | None
    final_links: int | None

    @property
    def path(self) -> Path:
        return self.parent / self.basename


def _reject_symlink_components(path: Path) -> None:
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        try:
            metadata = os.lstat(current)
        except FileNotFoundError:
            return
        if stat.S_ISLNK(metadata.st_mode):
            raise FilesystemSafetyError("catalog path must not contain symlink aliases")


def _validate_owner_mode(metadata: os.stat_result, mode: int, subject: str) -> None:
    if metadata.st_uid != os.geteuid():
        raise FilesystemSafetyError(f"{subject} must be owned by the current user")
    if stat.S_IMODE(metadata.st_mode) != mode:
        raise FilesystemSafetyError(f"{subject} must have mode {mode:o}")


def canonical_catalog_path(
    path: str | os.PathLike[str], *, require_unique: bool = True
) -> CanonicalCatalogPath:
    candidate = Path(path).expanduser().absolute()
    if not candidate.name or candidate.name in (".", ".."):
        raise FilesystemSafetyError("catalog path must have a final filename")
    _reject_symlink_components(candidate.parent)
    try:
        parent_descriptor = os.open(candidate.parent, _DIRECTORY_FLAGS)
    except OSError as error:
        raise FilesystemSafetyError("catalog parent is missing or unsafe") from error
    try:
        parent_metadata = os.fstat(parent_descriptor)
        _validate_owner_mode(parent_metadata, 0o700, "catalog parent")
        parent = Path(os.path.realpath(candidate.parent))
    finally:
        os.close(parent_descriptor)
    canonical = parent / candidate.name
    try:
        final = os.lstat(canonical)
    except FileNotFoundError:
        final_device = None
        final_inode = None
        final_links = None
    else:
        if not stat.S_ISREG(final.st_mode) or (require_unique and final.st_nlink != 1):
            raise FilesystemSafetyError("catalog must be a unique regular file")
        _validate_owner_mode(final, 0o600, "catalog")
        final_device = final.st_dev
        final_inode = final.st_ino
        final_links = final.st_nlink
    identity = hashlib.sha256(os.fsencode(canonical)).hexdigest()
    return CanonicalCatalogPath(
        parent,
        candidate.name,
        identity,
        parent_metadata.st_dev,
        parent_metadata.st_ino,
        final_device,
        final_inode,
        final_links,
    )


def verify_catalog_entry(scope: CanonicalCatalogPath) -> None:
    if scope.final_device is None or scope.final_inode is None or scope.final_links is None:
        raise FilesystemSafetyError("catalog final entry is absent")
    parent = os.open(scope.parent, _DIRECTORY_FLAGS)
    descriptor = -1
    try:
        descriptor = os.open(
            scope.basename,
            os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=parent,
        )
        metadata = os.fstat(descriptor)
        if (metadata.st_dev, metadata.st_ino) != (scope.final_device, scope.final_inode):
            raise FilesystemSafetyError("catalog final entry identity changed")
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != scope.final_links:
            raise FilesystemSafetyError("catalog final entry link identity changed")
        _validate_owner_mode(metadata, 0o600, "catalog")
    except OSError as error:
        raise FilesystemSafetyError("catalog final entry is missing or unsafe") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        os.close(parent)


def verify_absent_entry(scope: CanonicalCatalogPath) -> None:
    parent = os.open(scope.parent, _DIRECTORY_FLAGS)
    try:
        metadata = os.fstat(parent)
        if (metadata.st_dev, metadata.st_ino) != (scope.parent_device, scope.parent_inode):
            raise FilesystemSafetyError("output parent identity changed")
        try:
            os.stat(scope.basename, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return
        raise FilesystemSafetyError("output entry appeared after binding")
    finally:
        os.close(parent)


@dataclass(frozen=True, slots=True)
class AdvisoryLock:
    scope: CanonicalCatalogPath
    name: str

    @contextmanager
    def acquire(self, *, blocking: bool = True, serialize_root: bool = True) -> Iterator[None]:
        parent_descriptor = os.open(self.scope.parent, _DIRECTORY_FLAGS)
        lock_directory = -1
        lock_descriptor = -1
        try:
            metadata = os.fstat(parent_descriptor)
            if (metadata.st_dev, metadata.st_ino) != (
                self.scope.parent_device,
                self.scope.parent_inode,
            ):
                raise FilesystemSafetyError("catalog parent identity changed")
            try:
                os.mkdir(".sciretriever-locks", 0o700, dir_fd=parent_descriptor)
                os.fsync(parent_descriptor)
            except FileExistsError:
                os.stat(".sciretriever-locks", dir_fd=parent_descriptor, follow_symlinks=False)
            lock_directory = os.open(
                ".sciretriever-locks", _DIRECTORY_FLAGS, dir_fd=parent_descriptor
            )
            _validate_owner_mode(os.fstat(lock_directory), 0o700, "lock root")
            root_operation = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
            fcntl.flock(lock_directory, root_operation)
            lock_name = (
                hashlib.sha256(f"{self.scope.identity}\0{self.name}".encode("ascii")).hexdigest()
                + ".lock"
            )
            lock_descriptor = os.open(
                lock_name, _FILE_FLAGS | os.O_CREAT, 0o600, dir_fd=lock_directory
            )
            lock_metadata = os.fstat(lock_descriptor)
            if not stat.S_ISREG(lock_metadata.st_mode) or lock_metadata.st_nlink != 1:
                raise FilesystemSafetyError("lock must be a unique regular file")
            _validate_owner_mode(lock_metadata, 0o600, "lock file")
            if not serialize_root:
                fcntl.flock(lock_directory, fcntl.LOCK_UN)
            operation = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
            fcntl.flock(lock_descriptor, operation)
            entry = os.stat(lock_name, dir_fd=lock_directory, follow_symlinks=False)
            if (entry.st_dev, entry.st_ino) != (lock_metadata.st_dev, lock_metadata.st_ino):
                raise FilesystemSafetyError("lock entry identity changed during acquisition")
            yield
        finally:
            if lock_descriptor >= 0:
                os.close(lock_descriptor)
            if lock_directory >= 0:
                os.close(lock_directory)
            os.close(parent_descriptor)
