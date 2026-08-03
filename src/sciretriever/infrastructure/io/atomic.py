from __future__ import annotations

import os
import stat
from pathlib import Path
from types import TracebackType
from typing import BinaryIO, Final
from uuid import uuid4

from sciretriever.services.library.ports import AtomicOutputContext, AtomicOutputPort, BinaryOutput

_DIRECTORY_FLAGS: Final = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
_STAGE_FLAGS: Final = (
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
)


class AtomicOutputSecurityError(Exception):
    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)

    def __str__(self) -> str:
        return self.reason


class _OutputStream:
    def __init__(self, stream: BinaryIO) -> None:
        self._stream = stream

    def write(self, value: bytes) -> int:
        return self._stream.write(value)

    def flush(self) -> None:
        self._stream.flush()

    def fileno(self) -> int:
        return self._stream.fileno()

    def close(self) -> None:
        self._stream.close()


def _absolute_target(path: str | os.PathLike[str]) -> Path:
    target = Path(os.path.abspath(os.fspath(path)))
    if not target.name or target.name in (".", ".."):
        raise AtomicOutputSecurityError("output path must have a final filename")
    return target


def _reject_symlink_components(path: Path) -> None:
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        try:
            metadata = os.lstat(current)
        except FileNotFoundError as error:
            raise AtomicOutputSecurityError("output parent must already exist") from error
        if stat.S_ISLNK(metadata.st_mode):
            raise AtomicOutputSecurityError("output path must not contain symlink components")


def _validate_parent(parent: int, expected: tuple[int, int] | None = None) -> None:
    metadata = os.fstat(parent)
    if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o022:
        raise AtomicOutputSecurityError("output parent must be owner-controlled")
    if expected is not None and (metadata.st_dev, metadata.st_ino) != expected:
        raise AtomicOutputSecurityError("output parent identity changed")


def _validate_entry(
    parent: int, name: str, *, required: bool, subject: str
) -> tuple[int, int, int] | None:
    try:
        metadata = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError as error:
        if required:
            raise AtomicOutputSecurityError(f"{subject} is missing") from error
        return None
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != os.geteuid()
        or stat.S_IMODE(metadata.st_mode) != 0o600
    ):
        raise AtomicOutputSecurityError(f"{subject} must be an owner-only unique regular file")
    return metadata.st_dev, metadata.st_ino, metadata.st_nlink


class _AtomicOutputContext:
    def __init__(
        self,
        target: Path,
        parent_identity: tuple[int, int],
        target_identity: tuple[int, int, int] | None,
    ) -> None:
        self._target = target
        self._parent_identity = parent_identity
        self._target_identity = target_identity
        self._parent = -1
        self._stream: _OutputStream | None = None
        self._stage_name: str | None = None
        self._published = False

    def __enter__(self) -> BinaryOutput:
        if self._parent >= 0:
            raise AtomicOutputSecurityError("atomic output context was entered twice")
        try:
            self._parent = os.open(self._target.parent, _DIRECTORY_FLAGS)
            _validate_parent(self._parent, self._parent_identity)
            target_identity = _validate_entry(
                self._parent, self._target.name, required=False, subject="output"
            )
            if target_identity != self._target_identity:
                raise AtomicOutputSecurityError("output identity changed")
            stage_name = f".{self._target.name}.{uuid4().hex}.stage"
            descriptor = os.open(stage_name, _STAGE_FLAGS, 0o600, dir_fd=self._parent)
            self._stage_name = stage_name
            self._stream = _OutputStream(os.fdopen(descriptor, "wb", closefd=True))
        except OSError as error:
            self._cleanup()
            raise AtomicOutputSecurityError("could not create safe staging file") from error
        except AtomicOutputSecurityError:
            self._cleanup()
            raise
        return self._stream

    def publish(self) -> None:
        if self._parent < 0 or self._stage_name is None or self._stream is None:
            raise AtomicOutputSecurityError("atomic output context is not active")
        try:
            self._stream.flush()
            os.fsync(self._stream.fileno())
            self._stream.close()
            self._stream = None
            _validate_parent(self._parent, self._parent_identity)
            _validate_entry(self._parent, self._stage_name, required=True, subject="staging file")
            target_identity = _validate_entry(
                self._parent, self._target.name, required=False, subject="output"
            )
            if target_identity != self._target_identity:
                raise AtomicOutputSecurityError("output identity changed")
            os.replace(
                self._stage_name,
                self._target.name,
                src_dir_fd=self._parent,
                dst_dir_fd=self._parent,
            )
            os.fsync(self._parent)
            self._stage_name = None
            self._published = True
        except OSError as error:
            raise AtomicOutputSecurityError("atomic output publication failed") from error
        finally:
            if self._stage_name is not None:
                self._unlink_stage()

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self._cleanup()

    def _unlink_stage(self) -> None:
        if self._parent < 0 or self._stage_name is None:
            return
        try:
            os.unlink(self._stage_name, dir_fd=self._parent)
        except FileNotFoundError:
            return

    def _cleanup(self) -> None:
        if self._stream is not None:
            self._stream.close()
            self._stream = None
        if self._stage_name is not None and not self._published:
            self._unlink_stage()
        if self._parent >= 0:
            os.close(self._parent)
            self._parent = -1


class AtomicFileOutputPort(AtomicOutputPort):
    def __init__(self, target: str | os.PathLike[str]) -> None:
        self._target = _absolute_target(target)
        _reject_symlink_components(self._target.parent)
        try:
            parent = os.open(self._target.parent, _DIRECTORY_FLAGS)
        except OSError as error:
            raise AtomicOutputSecurityError("output parent is missing or unsafe") from error
        try:
            _validate_parent(parent)
            self._target_identity = _validate_entry(
                parent, self._target.name, required=False, subject="output"
            )
            metadata = os.fstat(parent)
            self._parent_identity = (metadata.st_dev, metadata.st_ino)
        finally:
            os.close(parent)

    def acquire_output(self) -> AtomicOutputContext:
        return _AtomicOutputContext(self._target, self._parent_identity, self._target_identity)


__all__ = (
    "AtomicFileOutputPort",
    "AtomicOutputSecurityError",
)
