from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
import fcntl
import os
from pathlib import Path
import stat
from uuid import uuid4

from sciretriever.errors import StorageError

from .export_destination import ExportDestination
from .export_errors import ExportContractError


_FILE_FLAGS = getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
_DIRECTORY_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _FILE_FLAGS


class ExportCheckpoint(StrEnum):
    BEFORE_TARGET_REVALIDATION = "before_target_revalidation"
    BEFORE_RENAME = "before_rename"
    AFTER_RENAME = "after_rename"


@dataclass(frozen=True, slots=True)
class ExportPublication:
    destination: Path
    catalog_path: Path
    payload: bytes


ExportFailpoint = Callable[[ExportCheckpoint], None]


def _validate_target(parent: int, name: str) -> None:
    try:
        metadata = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    except OSError as error:
        raise StorageError("export destination could not be inspected safely") from error
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise StorageError("export destination is unsafe")


def _write_payload(parent: int, name: str, payload: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | _FILE_FLAGS
    try:
        descriptor = os.open(name, flags, 0o600, dir_fd=parent)
    except OSError as error:
        raise StorageError("export temporary file could not be created safely") from error
    try:
        offset = 0
        while offset < len(payload):
            written = os.write(descriptor, payload[offset:])
            if written <= 0:
                raise StorageError("export write made no progress")
            offset += written
        os.fsync(descriptor)
        os.fchmod(descriptor, 0o400)
        os.fsync(descriptor)
    except OSError as error:
        raise StorageError("export bytes could not be persisted") from error
    finally:
        os.close(descriptor)


def publish_export(
    publication: ExportPublication,
    *,
    checkpoint: ExportFailpoint | None = None,
) -> None:
    destination = ExportDestination.parse(
        publication.destination, publication.catalog_path
    ).path
    try:
        parent = os.open(destination.parent, _DIRECTORY_FLAGS)
    except OSError as error:
        raise StorageError("export parent is unsafe") from error
    temporary_name = f".{destination.name}.{uuid4()}.tmp"
    temporary_exists = False
    try:
        fcntl.flock(parent, fcntl.LOCK_EX)
        _validate_target(parent, destination.name)
        _write_payload(parent, temporary_name, publication.payload)
        temporary_exists = True
        if checkpoint is not None:
            checkpoint(ExportCheckpoint.BEFORE_TARGET_REVALIDATION)
        try:
            ExportDestination.parse(destination, publication.catalog_path)
        except ExportContractError as error:
            raise StorageError("export destination changed during publication") from error
        _validate_target(parent, destination.name)
        if checkpoint is not None:
            checkpoint(ExportCheckpoint.BEFORE_RENAME)
        os.replace(
            temporary_name,
            destination.name,
            src_dir_fd=parent,
            dst_dir_fd=parent,
        )
        temporary_exists = False
        os.fsync(parent)
        if checkpoint is not None:
            checkpoint(ExportCheckpoint.AFTER_RENAME)
    except OSError as error:
        raise StorageError("export could not be published safely") from error
    finally:
        if temporary_exists:
            try:
                os.unlink(temporary_name, dir_fd=parent)
                os.fsync(parent)
            except FileNotFoundError:
                temporary_exists = False
        fcntl.flock(parent, fcntl.LOCK_UN)
        os.close(parent)


__all__ = (
    "ExportCheckpoint",
    "ExportFailpoint",
    "ExportPublication",
    "publish_export",
)
