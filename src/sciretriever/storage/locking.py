"""Non-blocking core write admission for one local catalog.

The lock is a technical process boundary, not a persisted business fact.  Its
sidecar name is derived only from the safe canonical catalog path returned by
the SQLite engine.  The descriptor remains open for the whole admission, so
the operating system releases the advisory lock when a process exits or is
forcibly terminated.
"""

from __future__ import annotations

import errno
import fcntl
import hashlib
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from sciretriever.storage.sqlite.engine import canonical_catalog_path

_LOCK_DIRECTORY_NAME: Final[str] = ".sciretriever-locks"
_LOCK_FILE_PREFIX: Final[str] = "catalog-"
_LOCK_FILE_SUFFIX: Final[str] = ".lock"
_LOCK_DIRECTORY_MODE: Final[int] = 0o700
_LOCK_FILE_MODE: Final[int] = 0o600
_LOCK_MARKER_PREFIX: Final[bytes] = b"sciretriever-catalog-lock-v1\n"

_DIRECTORY_FLAGS: Final[int] = (
    os.O_RDONLY
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
_LOCK_FILE_FLAGS: Final[int] = (
    os.O_RDWR | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
)
_LOCK_FILE_CREATE_FLAGS: Final[int] = _LOCK_FILE_FLAGS | os.O_CREAT | os.O_EXCL


class CatalogLockError(RuntimeError):
    """Path-free failure at the local catalog write-admission boundary."""

    _MESSAGE = "catalog write lock operation failed"

    def __init__(self, _message: object | None = None) -> None:
        del _message
        super().__init__(self._MESSAGE)


class CatalogLockConflictError(CatalogLockError):
    """Another process or lock object already owns the catalog lock."""

    _MESSAGE = "catalog write lock is already held"


class CatalogLockSecurityError(CatalogLockError):
    """The catalog or lock sidecar no longer satisfies its safety contract."""

    _MESSAGE = "catalog write lock boundary is not safe"


class CatalogLockStateError(CatalogLockError):
    """The lock object was used in an invalid local state."""

    _MESSAGE = "catalog write lock is in an invalid state"


@dataclass(frozen=True, slots=True)
class _Identity:
    device: int
    inode: int
    mode: int
    owner: int
    links: int


def _failure(error_type: type[CatalogLockError] = CatalogLockError) -> CatalogLockError:
    return error_type()


def _owner() -> int:
    try:
        return os.geteuid()
    except AttributeError:  # pragma: no cover - Windows has no geteuid.
        return os.getuid()


def _identity(metadata: os.stat_result) -> _Identity:
    return _Identity(
        device=metadata.st_dev,
        inode=metadata.st_ino,
        mode=metadata.st_mode,
        owner=metadata.st_uid,
        links=metadata.st_nlink,
    )


def _canonical(value: str | os.PathLike[str]) -> Path:
    try:
        path = canonical_catalog_path(value)
    except CatalogLockError:
        raise
    except Exception as error:
        raise _failure(CatalogLockSecurityError) from error
    if not isinstance(path, Path):
        raise _failure(CatalogLockSecurityError)
    return path


def _validate_directory(metadata: os.stat_result) -> None:
    owner = _owner()
    if not stat.S_ISDIR(metadata.st_mode):
        raise _failure(CatalogLockSecurityError)
    mode = stat.S_IMODE(metadata.st_mode)
    if mode & 0o022 and not (mode & stat.S_ISVTX and metadata.st_uid in {0, owner}):
        raise _failure(CatalogLockSecurityError)


def _validate_lock_directory(metadata: os.stat_result) -> _Identity:
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != _owner()
        or stat.S_IMODE(metadata.st_mode) != _LOCK_DIRECTORY_MODE
    ):
        raise _failure(CatalogLockSecurityError)
    return _identity(metadata)


def _validate_lock_file(metadata: os.stat_result) -> _Identity:
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != _owner()
        or stat.S_IMODE(metadata.st_mode) != _LOCK_FILE_MODE
        or metadata.st_nlink != 1
    ):
        raise _failure(CatalogLockSecurityError)
    return _identity(metadata)


def _open_parent_directory(path: Path) -> tuple[int, _Identity]:
    descriptors: list[int] = []
    keep_last = False
    try:
        try:
            current = os.open(os.sep, _DIRECTORY_FLAGS)
        except OSError as error:
            raise _failure(CatalogLockSecurityError) from error
        descriptors.append(current)
        _validate_directory(os.fstat(current))
        for component in path.parts:
            if component == os.sep:
                continue
            try:
                child = os.open(component, _DIRECTORY_FLAGS, dir_fd=current)
            except OSError as error:
                raise _failure(CatalogLockSecurityError) from error
            descriptors.append(child)
            _validate_directory(os.fstat(child))
            current = child
        metadata = os.fstat(current)
        _validate_directory(metadata)
        keep_last = True
        return current, _identity(metadata)
    except CatalogLockError:
        raise
    except OSError as error:
        raise _failure(CatalogLockSecurityError) from error
    finally:
        for descriptor in descriptors[:-1] if keep_last else descriptors:
            try:
                os.close(descriptor)
            except OSError:
                pass


def _close(descriptor: int) -> None:
    if descriptor >= 0:
        try:
            os.close(descriptor)
        except OSError:
            pass


def _assert_parent_binding(path: Path, expected: _Identity) -> None:
    descriptor, actual = _open_parent_directory(path)
    try:
        if (
            actual.device,
            actual.inode,
            actual.mode,
            actual.owner,
        ) != (
            expected.device,
            expected.inode,
            expected.mode,
            expected.owner,
        ):
            raise _failure(CatalogLockSecurityError)
    finally:
        _close(descriptor)


def _catalog_identity(path: Path) -> _Identity | None:
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise _failure(CatalogLockSecurityError) from error
    return _validate_catalog_metadata(metadata)


def _validate_catalog_metadata(metadata: os.stat_result) -> _Identity:
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != _owner()
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink != 1
    ):
        raise _failure(CatalogLockSecurityError)
    return _identity(metadata)


def _assert_catalog_entry(
    parent: int,
    name: str,
    expected: _Identity | None,
) -> _Identity | None:
    try:
        metadata = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        if expected is not None:
            raise _failure(CatalogLockSecurityError)
        return None
    except OSError as error:
        raise _failure(CatalogLockSecurityError) from error
    actual = _validate_catalog_metadata(metadata)
    if expected is not None and actual != expected:
        raise _failure(CatalogLockSecurityError)
    return actual


def _assert_directory_entry(parent: int, name: str, expected: _Identity) -> None:
    try:
        metadata = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except OSError as error:
        raise _failure(CatalogLockSecurityError) from error
    actual = _validate_lock_directory(metadata)
    if actual != expected:
        raise _failure(CatalogLockSecurityError)


def _open_lock_directory(parent: int) -> tuple[int, _Identity]:
    created = False
    try:
        try:
            os.mkdir(_LOCK_DIRECTORY_NAME, _LOCK_DIRECTORY_MODE, dir_fd=parent)
            created = True
        except FileExistsError:
            pass
        except OSError as error:
            raise _failure(CatalogLockSecurityError) from error
        try:
            descriptor = os.open(_LOCK_DIRECTORY_NAME, _DIRECTORY_FLAGS, dir_fd=parent)
        except OSError as error:
            raise _failure(CatalogLockSecurityError) from error
        try:
            if created:
                try:
                    os.fchmod(descriptor, _LOCK_DIRECTORY_MODE)
                except OSError as error:
                    raise _failure(CatalogLockSecurityError) from error
            metadata = os.fstat(descriptor)
            expected = _validate_lock_directory(metadata)
            _assert_directory_entry(parent, _LOCK_DIRECTORY_NAME, expected)
            return descriptor, expected
        except BaseException:
            _close(descriptor)
            raise
    except CatalogLockError:
        raise
    except OSError as error:
        raise _failure(CatalogLockSecurityError) from error


def _marker(fingerprint: str) -> bytes:
    return _LOCK_MARKER_PREFIX + fingerprint.encode("ascii") + b"\n"


def _write_marker(descriptor: int, marker: bytes) -> None:
    try:
        view = memoryview(marker)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise _failure(CatalogLockError)
            view = view[written:]
        os.fsync(descriptor)
    except CatalogLockError:
        raise
    except OSError as error:
        raise _failure(CatalogLockError) from error


def _read_marker(descriptor: int, marker: bytes) -> None:
    try:
        os.lseek(descriptor, 0, os.SEEK_SET)
        value = os.read(descriptor, len(marker) + 1)
    except OSError as error:
        raise _failure(CatalogLockSecurityError) from error
    if value != marker:
        raise _failure(CatalogLockSecurityError)


def _assert_file_entry(parent: int, name: str, descriptor: int, expected: _Identity) -> None:
    try:
        entry = os.stat(name, dir_fd=parent, follow_symlinks=False)
        current = os.fstat(descriptor)
    except OSError as error:
        raise _failure(CatalogLockSecurityError) from error
    actual_entry = _validate_lock_file(entry)
    actual_descriptor = _validate_lock_file(current)
    if actual_entry != expected or actual_descriptor != expected:
        raise _failure(CatalogLockSecurityError)


def _create_or_open_lock_file(directory: int, name: str) -> tuple[int, bool]:
    created = False
    try:
        try:
            descriptor = os.open(
                name,
                _LOCK_FILE_CREATE_FLAGS,
                _LOCK_FILE_MODE,
                dir_fd=directory,
            )
            created = True
        except FileExistsError:
            try:
                descriptor = os.open(name, _LOCK_FILE_FLAGS, dir_fd=directory)
            except OSError as error:
                raise _failure(CatalogLockSecurityError) from error
        except OSError as error:
            raise _failure(CatalogLockSecurityError) from error
        return descriptor, created
    except CatalogLockError:
        raise
    except OSError as error:
        raise _failure(CatalogLockSecurityError) from error


def _prepare_lock_file(descriptor: int, created: bool, marker: bytes) -> _Identity:
    if created:
        try:
            os.fchmod(descriptor, _LOCK_FILE_MODE)
        except OSError as error:
            raise _failure(CatalogLockSecurityError) from error
    expected = _validate_lock_file(os.fstat(descriptor))
    if created:
        _write_marker(descriptor, marker)
    return expected


def _unlink_created_lock_file(directory: int, name: str) -> None:
    try:
        os.unlink(name, dir_fd=directory)
    except OSError:
        pass


def _open_lock_file(
    directory: int,
    name: str,
    marker: bytes,
) -> tuple[int, _Identity]:
    descriptor, created = _create_or_open_lock_file(directory, name)
    try:
        expected = _prepare_lock_file(descriptor, created, marker)
        _assert_file_entry(directory, name, descriptor, expected)
        return descriptor, expected
    except BaseException:
        _close(descriptor)
        if created:
            _unlink_created_lock_file(directory, name)
        raise


def _acquire_advisory(descriptor: int) -> None:
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        raise _failure(CatalogLockConflictError) from error
    except OSError as error:
        if error.errno in {errno.EACCES, errno.EAGAIN}:
            raise _failure(CatalogLockConflictError) from error
        raise _failure(CatalogLockError) from error


class CatalogWriteLock:
    """A non-reentrant, non-blocking exclusive lock for one catalog path."""

    __slots__ = (
        "_catalog_path",
        "_catalog_identity",
        "_fingerprint",
        "_parent",
        "_lock_directory",
        "_lock_file",
        "_acquired",
    )

    def __init__(self, catalog_path: str | os.PathLike[str]) -> None:
        self._catalog_path = _canonical(catalog_path)
        self._catalog_identity = _catalog_identity(self._catalog_path)
        self._fingerprint = hashlib.sha256(
            self._catalog_path.as_posix().encode("utf-8", "surrogatepass")
        ).hexdigest()
        self._parent = -1
        self._lock_directory = -1
        self._lock_file = -1
        self._acquired = False

    @property
    def locked(self) -> bool:
        return self._acquired

    def __repr__(self) -> str:
        return f"<CatalogWriteLock locked={self._acquired}>"

    def acquire(self) -> CatalogWriteLock:
        if self._acquired:
            raise _failure(CatalogLockStateError)
        current = _canonical(self._catalog_path)
        if current != self._catalog_path:
            raise _failure(CatalogLockSecurityError)
        parent, parent_identity = _open_parent_directory(current.parent)
        lock_directory = -1
        lock_file = -1
        try:
            _assert_parent_binding(current.parent, parent_identity)
            _assert_catalog_entry(parent, current.name, self._catalog_identity)
            lock_directory, directory_identity = _open_lock_directory(parent)
            lock_name = f"{_LOCK_FILE_PREFIX}{self._fingerprint}{_LOCK_FILE_SUFFIX}"
            lock_file, file_identity = _open_lock_file(
                lock_directory,
                lock_name,
                _marker(self._fingerprint),
            )
            _assert_directory_entry(parent, _LOCK_DIRECTORY_NAME, directory_identity)
            _assert_file_entry(lock_directory, lock_name, lock_file, file_identity)
            _acquire_advisory(lock_file)
            try:
                _read_marker(lock_file, _marker(self._fingerprint))
                _assert_parent_binding(current.parent, parent_identity)
                _assert_catalog_entry(parent, current.name, self._catalog_identity)
                _assert_directory_entry(parent, _LOCK_DIRECTORY_NAME, directory_identity)
                _assert_file_entry(lock_directory, lock_name, lock_file, file_identity)
            except BaseException:
                try:
                    fcntl.flock(lock_file, fcntl.LOCK_UN)
                except OSError:
                    pass
                raise
            self._parent = parent
            self._lock_directory = lock_directory
            self._lock_file = lock_file
            self._acquired = True
            return self
        except BaseException:
            _close(lock_file)
            _close(lock_directory)
            _close(parent)
            raise

    def release(self) -> None:
        if not self._acquired:
            raise _failure(CatalogLockStateError)
        parent = self._parent
        lock_directory = self._lock_directory
        lock_file = self._lock_file
        self._parent = -1
        self._lock_directory = -1
        self._lock_file = -1
        self._acquired = False
        failure: CatalogLockError | None = None
        try:
            try:
                fcntl.flock(lock_file, fcntl.LOCK_UN)
            except OSError as error:
                failure = _failure(CatalogLockError)
                failure.__cause__ = error
        finally:
            _close(lock_file)
            _close(lock_directory)
            _close(parent)
        if failure is not None:
            raise failure

    def __enter__(self) -> CatalogWriteLock:
        return self.acquire()

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        try:
            self.release()
        except CatalogLockError:
            if exc_type is None:
                raise
        return False


__all__ = (
    "CatalogLockConflictError",
    "CatalogLockError",
    "CatalogLockSecurityError",
    "CatalogLockStateError",
    "CatalogWriteLock",
)
