"""Host-local admission for expensive catalog stages."""

from __future__ import annotations

from contextlib import ExitStack, closing, contextmanager
from enum import Enum
import hashlib
import os
from pathlib import Path
import sqlite3
import stat
from typing import Final, Iterable, Iterator

from sciretriever.errors import StageAdmissionConflict


class StageKind(str, Enum):
    ACQUISITION = "acquisition"
    ANALYSIS = "analysis"


_STAGE_ORDER: Final = (StageKind.ACQUISITION, StageKind.ANALYSIS)
_DIRECTORY_MODE: Final = 0o700
_LOCK_MODE: Final = 0o600
_HOST_TEMP_ROOT: Final = Path("/tmp")


def _admission_directory() -> Path:
    directory = _HOST_TEMP_ROOT / f"sciretriever-stage-admission-{os.getuid()}"
    try:
        directory.mkdir(mode=_DIRECTORY_MODE)
    except FileExistsError:
        pass
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(directory, flags)
    try:
        metadata = os.fstat(descriptor)
        if metadata.st_uid != os.getuid():
            raise PermissionError("Stage admission directory is not owner-only")
        if stat.S_IMODE(metadata.st_mode) != _DIRECTORY_MODE:
            raise PermissionError("Stage admission directory is not owner-only")
    finally:
        os.close(descriptor)
    return directory


def _lock_path(catalog_path: str | Path, stage: StageKind) -> Path:
    resolved = Path(catalog_path).expanduser().resolve()
    identity = hashlib.sha256(
        f"{resolved}\0{stage.value}".encode("utf-8")
    ).hexdigest()
    return _admission_directory() / f"{identity}.sqlite"


def _prepare_lock_file(path: Path) -> None:
    flags = os.O_RDWR | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags | os.O_CREAT | os.O_EXCL, _LOCK_MODE)
        os.fchmod(descriptor, _LOCK_MODE)
    except FileExistsError:
        descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != _LOCK_MODE
        ):
            raise PermissionError("Stage admission lock file is not owner-only")
    finally:
        os.close(descriptor)


def _is_lock_conflict(error: sqlite3.OperationalError) -> bool:
    code = error.sqlite_errorcode
    return code is not None and code & 0xFF in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}


@contextmanager
def _admit_stage(catalog_path: str | Path, stage: StageKind) -> Iterator[None]:
    path = _lock_path(catalog_path, stage)
    _prepare_lock_file(path)
    with closing(sqlite3.connect(path, timeout=0, isolation_level=None)) as connection:
        try:
            connection.execute("BEGIN IMMEDIATE")
        except sqlite3.OperationalError as error:
            if _is_lock_conflict(error):
                raise StageAdmissionConflict(stage) from None
            raise
        try:
            yield
        finally:
            connection.rollback()


@contextmanager
def admit_catalog_stages(
    catalog_path: str | Path,
    stages: Iterable[StageKind],
) -> Iterator[None]:
    """Admit requested stages in the global acquisition-to-analysis order."""
    requested = frozenset(stages)
    with ExitStack() as stack:
        for stage in _STAGE_ORDER:
            if stage in requested:
                stack.enter_context(_admit_stage(catalog_path, stage))
        yield
