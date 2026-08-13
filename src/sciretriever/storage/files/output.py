"""Atomic, user-facing file publication outside the ArtifactStore.

This module owns only the final copy made for a user-selected output file.  It
never registers the output in the catalog, creates an artifact object, or
retains the target path in a returned value.  A target-directory descriptor is
held for the whole operation so that staging, validation, publication and
cleanup all use the same directory-relative boundary.
"""

from __future__ import annotations

import ctypes
import errno
import hashlib
import os
import secrets
import stat
import sys
from collections.abc import Callable, Iterable
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from pathlib import Path
from tempfile import SpooledTemporaryFile
from typing import Any, BinaryIO, Final, Iterator, TypeAlias, cast

from sciretriever.entry.ports import UserOutputConflictError
from sciretriever.model.primitives import Sha256

_DEFAULT_CHUNK_BYTES: Final[int] = 1024 * 1024
_DEFAULT_MAX_OUTPUT_BYTES: Final[int] = 512 * 1024 * 1024
_DEFAULT_SPOOL_MEMORY_BYTES: Final[int] = 8 * 1024 * 1024
_MAX_STAGE_ATTEMPTS: Final[int] = 32
_STAGE_PREFIX: Final[str] = ".sciretriever-output-"
_STAGE_SUFFIX: Final[str] = ".staging"
_BACKUP_SUFFIX: Final[str] = ".backup"
_QUARANTINE_SUFFIX: Final[str] = ".quarantine"
_RENAME_EXCHANGE: Final[int] = 0x2

_DIRECTORY_FLAGS: Final[int] = (
    os.O_RDONLY
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
_STAGE_FLAGS: Final[int] = (
    os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
)

OutputSource: TypeAlias = object
Checkpoint: TypeAlias = Callable[[str], None]


class AtomicOutputError(RuntimeError):
    """Stable, path-free failure at the user-output boundary."""

    _MESSAGE = "atomic output publication failed"

    def __init__(self, _message: object | None = None) -> None:
        del _message
        super().__init__(self._MESSAGE)


class OutputConflictError(AtomicOutputError, UserOutputConflictError):
    """The target is present, unsafe, or changed during publication."""

    _MESSAGE = "atomic output target conflicts with the requested publication"


class OutputIntegrityError(AtomicOutputError):
    """The staged bytes do not satisfy the requested integrity contract."""

    _MESSAGE = "atomic output bytes failed integrity validation"


class OutputSecurityError(AtomicOutputError):
    """The target or its directory is not a safe publication boundary."""

    _MESSAGE = "atomic output target is not a safe publication boundary"


@dataclass(frozen=True, slots=True)
class OutputResult:
    """Non-sensitive technical facts for one completed publication."""

    byte_size: int
    sha256: Sha256

    def __post_init__(self) -> None:
        if type(self.byte_size) is not int or self.byte_size < 0:
            raise OutputIntegrityError()
        if not isinstance(self.sha256, Sha256):
            raise OutputIntegrityError()

    @property
    def size(self) -> int:
        return self.byte_size

    @property
    def digest(self) -> str:
        return self.sha256.root


@dataclass(frozen=True, slots=True)
class _FileIdentity:
    device: int
    inode: int
    mode: int
    owner: int
    links: int


@dataclass(frozen=True, slots=True)
class _StageIdentity:
    device: int
    inode: int


@dataclass(slots=True)
class _OverwritePublication:
    """State for an identity-bound, reversible overwrite publication."""

    parent: int
    target_name: str
    stage_name: str
    original: _FileIdentity
    stage: _StageIdentity
    backup_name: str | None = None
    exchanged: bool = False


class _InjectedFailure(BaseException):
    """Carry a failpoint exception through cleanup without masking it."""

    def __init__(self, cause: BaseException) -> None:
        self.cause = cause


class _PropagatedFailure(BaseException):
    """Carry a selected failpoint exception across the public error boundary."""

    def __init__(self, cause: BaseException) -> None:
        self.cause = cause


class _BoundedSpool:
    """Binary staging stream that cannot outgrow its publication bound."""

    __slots__ = ("_failed", "_max_bytes", "_stream")

    def __init__(self, stream: BinaryIO, *, max_bytes: int) -> None:
        self._stream = stream
        self._max_bytes = max_bytes
        self._failed = False

    @property
    def closed(self) -> bool:
        return self._stream.closed

    def close(self) -> None:
        self._stream.close()

    def flush(self) -> None:
        self._stream.flush()

    def fileno(self) -> int:
        raise OSError("staged output does not expose its descriptor")

    def isatty(self) -> bool:
        return False

    def readable(self) -> bool:
        return True

    def read(self, size: int = -1) -> bytes:
        return self._stream.read(size)

    def read1(self, size: int = -1) -> bytes:
        reader = getattr(self._stream, "read1", None)
        if callable(reader):
            return cast(bytes, reader(size))
        return self._stream.read(size)

    def readline(self, size: int = -1) -> bytes:
        return self._stream.readline(size)

    def readlines(self, hint: int = -1) -> list[bytes]:
        return self._stream.readlines(hint)

    def seek(self, offset: int, whence: int = os.SEEK_SET) -> int:
        return self._stream.seek(offset, whence)

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._stream.tell()

    def truncate(self, size: int | None = None) -> int:
        requested = self.tell() if size is None else size
        if type(requested) is not int or requested < 0 or requested > self._max_bytes:
            self._failed = True
            raise _failure(OutputIntegrityError)
        try:
            result = self._stream.truncate(requested)
        except BaseException:
            self._failed = True
            raise
        return requested if result is None else result

    def writable(self) -> bool:
        return True

    def write(self, data: Any) -> int:
        try:
            view = memoryview(data)
        except TypeError:
            self._failed = True
            raise
        try:
            byte_count = view.nbytes
        finally:
            view.release()
        try:
            position = self._stream.tell()
            current_size = self._stream.seek(0, os.SEEK_END)
            self._stream.seek(position, os.SEEK_SET)
        except BaseException:
            self._failed = True
            raise
        if max(current_size, position + byte_count) > self._max_bytes:
            self._failed = True
            raise _failure(OutputIntegrityError)
        try:
            return self._stream.write(data)
        except BaseException:
            self._failed = True
            raise

    def writelines(self, lines: Iterable[Any]) -> None:
        for line in lines:
            self.write(line)

    def prepare_for_publication(self) -> BinaryIO:
        if self.closed or self._failed:
            raise _failure(OutputIntegrityError)
        try:
            self._stream.flush()
            byte_size = self._stream.seek(0, os.SEEK_END)
            if byte_size > self._max_bytes:
                raise _failure(OutputIntegrityError)
            self._stream.seek(0, os.SEEK_SET)
        except AtomicOutputError:
            self._failed = True
            raise
        except BaseException as error:
            self._failed = True
            raise _failure() from error
        return self._stream


def _failure(error_type: type[AtomicOutputError] = AtomicOutputError) -> AtomicOutputError:
    return error_type()


def _owner() -> int:
    try:
        return os.geteuid()
    except AttributeError:  # pragma: no cover - Windows has no geteuid.
        return os.getuid()


def _checkpoint(callback: Checkpoint | None, name: str) -> None:
    if callback is None:
        return
    try:
        callback(name)
    except BaseException as error:
        raise _InjectedFailure(error) from error


def _normalise_failure(error: BaseException) -> tuple[BaseException, bool]:
    if isinstance(error, _InjectedFailure):
        return error.cause, True
    if isinstance(error, AtomicOutputError):
        return error, False
    if isinstance(error, (KeyboardInterrupt, SystemExit, GeneratorExit)):
        return error, False
    return _failure(), False


def _checkpoint_failure(
    callback: Checkpoint | None,
    name: str,
) -> tuple[BaseException | None, bool]:
    try:
        _checkpoint(callback, name)
    except BaseException as error:
        return _normalise_failure(error)
    return None, False


def _normalise_target(value: str | os.PathLike[str]) -> Path:
    try:
        raw = os.fspath(value)
    except TypeError as error:
        raise _failure(OutputSecurityError) from error
    if not isinstance(raw, str) or not raw or "\x00" in raw:
        raise _failure(OutputSecurityError)
    if any(ord(character) < 32 or ord(character) == 127 for character in raw):
        raise _failure(OutputSecurityError)
    try:
        target = Path(os.path.abspath(raw))
    except (OSError, ValueError) as error:
        raise _failure(OutputSecurityError) from error
    if not target.name or target.name in {os.curdir, os.pardir}:
        raise _failure(OutputSecurityError)
    return target


def _validate_directory(metadata: os.stat_result) -> None:
    owner = _owner()
    if not stat.S_ISDIR(metadata.st_mode):
        raise _failure(OutputSecurityError)
    mode = stat.S_IMODE(metadata.st_mode)
    if mode & 0o022 and not (mode & stat.S_ISVTX and metadata.st_uid in {0, owner}):
        raise _failure(OutputSecurityError)


def _open_parent_directory(target: Path) -> tuple[int, tuple[int, int]]:
    parent = target.parent
    descriptors: list[int] = []
    keep_last = False
    try:
        try:
            current = os.open(os.sep, _DIRECTORY_FLAGS)
        except OSError as error:
            raise _failure(OutputSecurityError) from error
        descriptors.append(current)
        _validate_directory(os.fstat(current))
        for component in parent.parts:
            if component == os.sep:
                continue
            try:
                child = os.open(component, _DIRECTORY_FLAGS, dir_fd=current)
            except OSError as error:
                raise _failure(OutputSecurityError) from error
            descriptors.append(child)
            _validate_directory(os.fstat(child))
            current = child
        metadata = os.fstat(current)
        _validate_directory(metadata)
        keep_last = True
        return current, (metadata.st_dev, metadata.st_ino)
    except AtomicOutputError:
        raise
    except OSError as error:
        raise _failure(OutputSecurityError) from error
    finally:
        for descriptor in descriptors[:-1] if keep_last else descriptors:
            try:
                os.close(descriptor)
            except OSError:
                pass


def _close_descriptor(descriptor: int) -> None:
    if descriptor >= 0:
        try:
            os.close(descriptor)
        except OSError:
            pass


def _file_identity(metadata: os.stat_result) -> _FileIdentity:
    return _FileIdentity(
        device=metadata.st_dev,
        inode=metadata.st_ino,
        mode=metadata.st_mode,
        owner=metadata.st_uid,
        links=metadata.st_nlink,
    )


def _validate_existing_metadata(metadata: os.stat_result) -> _FileIdentity:
    identity = _file_identity(metadata)
    if not stat.S_ISREG(metadata.st_mode):
        raise _failure(OutputConflictError)
    if metadata.st_uid != _owner() or metadata.st_nlink != 1:
        raise _failure(OutputConflictError)
    if stat.S_IMODE(metadata.st_mode) & 0o022:
        raise _failure(OutputConflictError)
    return identity


def _read_target(parent: int, name: str) -> _FileIdentity | None:
    try:
        metadata = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise _failure(OutputConflictError) from error
    return _validate_existing_metadata(metadata)


def _same_identity(actual: _FileIdentity | None, expected: _FileIdentity | None) -> bool:
    return actual == expected


def _same_inode(actual: _FileIdentity | None, expected: _FileIdentity | None) -> bool:
    if actual is None or expected is None:
        return False
    return (
        actual.device,
        actual.inode,
        actual.mode,
        actual.owner,
    ) == (
        expected.device,
        expected.inode,
        expected.mode,
        expected.owner,
    )


def _same_stage_identity(actual: _FileIdentity | None, expected: _StageIdentity) -> bool:
    return actual is not None and (actual.device, actual.inode) == (
        expected.device,
        expected.inode,
    )


def _read_name_identity(parent: int, name: str) -> _FileIdentity | None:
    """Read a directory-relative lstat identity without classifying it."""

    try:
        metadata = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise _failure(OutputConflictError) from error
    return _file_identity(metadata)


def _read_owned_identity(parent: int, name: str) -> _FileIdentity | None:
    """Read a safe regular-file identity without requiring nlink == 1.

    Internal overwrite backup links temporarily have more than one link.  A
    separate helper is therefore needed instead of ``_read_target``; it still
    rejects symlinks, non-regular files, foreign owners and writable modes.
    """

    identity = _read_name_identity(parent, name)
    if identity is None:
        return None
    if (
        not stat.S_ISREG(identity.mode)
        or identity.owner != _owner()
        or stat.S_IMODE(identity.mode) & 0o022
    ):
        raise _failure(OutputConflictError)
    return identity


def _renameat2_exchange(parent: int, left: str, right: str) -> None:
    """Atomically exchange two names, or fail closed when unsupported."""

    if not sys.platform.startswith("linux"):
        raise OSError(errno.ENOTSUP, "renameat2 exchange unavailable")
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        function = libc.renameat2
    except (AttributeError, OSError) as error:
        raise OSError(errno.ENOTSUP, "renameat2 exchange unavailable") from error
    function.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    function.restype = ctypes.c_int
    result = function(
        parent,
        os.fsencode(left),
        parent,
        os.fsencode(right),
        _RENAME_EXCHANGE,
    )
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(
            error_number or errno.EIO,
            os.strerror(error_number or errno.EIO),
        )


def _unlink_owned_name(parent: int, name: str | None, expected: _FileIdentity | None) -> None:
    if name is None or expected is None:
        return
    actual = _read_owned_identity(parent, name)
    if actual is None:
        return
    if not _same_inode(actual, expected):
        raise _failure(OutputConflictError)
    try:
        os.unlink(name, dir_fd=parent)
    except FileNotFoundError:
        return
    except OSError as error:
        raise _failure() from error


def _safe_auxiliary_name(suffix: str) -> str:
    return f"{_STAGE_PREFIX}{secrets.token_hex(16)}{suffix}"


def _prepare_overwrite(publication: _OverwritePublication) -> None:
    """Bind a private hardlink to the originally authorized target inode."""

    for _ in range(_MAX_STAGE_ATTEMPTS):
        name = _safe_auxiliary_name(_BACKUP_SUFFIX)
        try:
            os.link(
                publication.target_name,
                name,
                src_dir_fd=publication.parent,
                dst_dir_fd=publication.parent,
                follow_symlinks=False,
            )
        except FileExistsError:
            continue
        except OSError as error:
            raise _failure(OutputConflictError) from error
        publication.backup_name = name
        try:
            current = _read_owned_identity(publication.parent, publication.target_name)
            backup = _read_owned_identity(publication.parent, name)
            if (
                not _same_inode(current, publication.original)
                or not _same_inode(backup, publication.original)
                or current is None
                or backup is None
                or current.links != publication.original.links + 1
                or backup.links != publication.original.links + 1
            ):
                raise _failure(OutputConflictError)
            return
        except BaseException:
            # Only unlink a backup whose identity is still the original one
            # and whose target name still points to that same inode.  If a
            # race removed or replaced the target, retain the backup so the
            # outer rollback can restore the originally authorized object.
            try:
                current = _read_owned_identity(publication.parent, publication.target_name)
                backup = _read_owned_identity(publication.parent, name)
                if _same_inode(current, publication.original) and _same_inode(
                    backup,
                    publication.original,
                ):
                    _unlink_owned_name(publication.parent, name, publication.original)
                    publication.backup_name = None
            except BaseException:
                pass
            raise
    raise _failure(OutputConflictError)


def _rollback_overwrite(publication: _OverwritePublication) -> None:  # noqa: C901
    """Restore the original target or raise a stable recovery failure."""

    if not publication.exchanged:
        if publication.backup_name is None:
            return
        target = _read_owned_identity(publication.parent, publication.target_name)
        backup = _read_name_identity(publication.parent, publication.backup_name)
        if backup is None:
            if _same_inode(target, publication.original):
                return
            raise _failure(OutputConflictError)
        if not _same_inode(backup, publication.original):
            if _same_inode(target, publication.original):
                return
            raise _failure(OutputConflictError)
        if _same_inode(target, publication.original):
            _unlink_owned_name(
                publication.parent,
                publication.backup_name,
                publication.original,
            )
            publication.backup_name = None
            os.fsync(publication.parent)
            return
        if target is None:
            os.link(
                publication.backup_name,
                publication.target_name,
                src_dir_fd=publication.parent,
                dst_dir_fd=publication.parent,
                follow_symlinks=False,
            )
            _unlink_owned_name(
                publication.parent,
                publication.backup_name,
                publication.original,
            )
            publication.backup_name = None
            os.fsync(publication.parent)
            return
        if not _same_inode(target, publication.original):
            _renameat2_exchange(
                publication.parent,
                publication.backup_name,
                publication.target_name,
            )
            os.fsync(publication.parent)
        return

    target = _read_owned_identity(publication.parent, publication.target_name)
    stage = _read_name_identity(publication.parent, publication.stage_name)
    backup = (
        None
        if publication.backup_name is None
        else _read_name_identity(publication.parent, publication.backup_name)
    )
    if not _same_stage_identity(target, publication.stage):
        raise _failure(OutputConflictError)
    if _same_inode(stage, publication.original):
        # Normal failure after exchange: stage is the old target.  A backup
        # that was concurrently replaced is evidence, not a reason to lose a
        # recoverable old target; only unlink the identity we own.
        new_target = target
        _renameat2_exchange(
            publication.parent,
            publication.stage_name,
            publication.target_name,
        )
        publication.exchanged = False
        if publication.backup_name is not None and _same_inode(
            backup,
            publication.original,
        ):
            _unlink_owned_name(
                publication.parent,
                publication.backup_name,
                publication.original,
            )
            publication.backup_name = None
        _unlink_owned_name(publication.parent, publication.stage_name, new_target)
        os.fsync(publication.parent)
        return

    # A replacement won the name race after the last check.  The backup still
    # binds the original inode, so exchange it with the new target to restore
    # the authorized object.  The replacement remains under the stage name as
    # evidence; it is never unlinked as if it were our temporary file.
    if backup is None or not _same_inode(backup, publication.original):
        raise _failure(OutputConflictError)
    new_target = target
    _renameat2_exchange(
        publication.parent,
        publication.backup_name or "",
        publication.target_name,
    )
    publication.exchanged = False
    if publication.backup_name is not None:
        _unlink_owned_name(publication.parent, publication.backup_name, new_target)
        publication.backup_name = None
    os.fsync(publication.parent)


def _commit_overwrite(publication: _OverwritePublication) -> None:
    """Discard old links only after all publication checkpoints succeed."""

    if not publication.exchanged:
        return
    target = _read_owned_identity(publication.parent, publication.target_name)
    stage = _read_owned_identity(publication.parent, publication.stage_name)
    if publication.backup_name is None:
        raise _failure(OutputConflictError)
    backup = _read_owned_identity(publication.parent, publication.backup_name)
    if (
        not _same_stage_identity(target, publication.stage)
        or not _same_inode(stage, publication.original)
        or not _same_inode(backup, publication.original)
        or target is None
        or stage is None
        or backup is None
        or target.links != 1
        or stage.links != publication.original.links + 1
        or backup.links != publication.original.links + 1
    ):
        raise _failure(OutputConflictError)
    # Keep the old target at ``stage_name`` until the backup unlink has been
    # durably observed.  If this fsync fails, rollback still has an old link.
    _unlink_owned_name(publication.parent, publication.backup_name, publication.original)
    publication.backup_name = None
    os.fsync(publication.parent)
    _unlink_owned_name(publication.parent, publication.stage_name, publication.original)
    publication.exchanged = False


def _create_stage(parent: int) -> tuple[int, str, _StageIdentity]:
    for _ in range(_MAX_STAGE_ATTEMPTS):
        name = f"{_STAGE_PREFIX}{secrets.token_hex(16)}{_STAGE_SUFFIX}"
        try:
            descriptor = os.open(name, _STAGE_FLAGS, 0o600, dir_fd=parent)
        except FileExistsError:
            continue
        except OSError as error:
            raise _failure() from error
        try:
            os.fchmod(descriptor, 0o600)
            metadata = os.fstat(descriptor)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != _owner()
                or stat.S_IMODE(metadata.st_mode) != 0o600
                or metadata.st_nlink != 1
            ):
                raise _failure(OutputSecurityError)
            return descriptor, name, _StageIdentity(metadata.st_dev, metadata.st_ino)
        except BaseException:
            _close_descriptor(descriptor)
            try:
                os.unlink(name, dir_fd=parent)
            except OSError:
                pass
            raise
    raise _failure()


def _stage_identity(descriptor: int, expected: _StageIdentity) -> None:
    try:
        metadata = os.fstat(descriptor)
    except OSError as error:
        raise _failure(OutputIntegrityError) from error
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != _owner()
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink != 1
        or (metadata.st_dev, metadata.st_ino) != (expected.device, expected.inode)
    ):
        raise _failure(OutputIntegrityError)


def _write_all(descriptor: int, chunk: bytes) -> int:
    view = memoryview(chunk)
    total = 0
    while view:
        try:
            written = os.write(descriptor, view)
        except OSError as error:
            raise _failure() from error
        if written <= 0:
            raise _failure()
        total += written
        view = view[written:]
    return total


def _coerce_chunk(chunk: object) -> bytes:
    if type(chunk) is bytes:
        return cast(bytes, chunk)
    if isinstance(chunk, (bytearray, memoryview)):
        return bytes(chunk)
    raise _failure(OutputIntegrityError)


def _copy_chunks(
    descriptor: int,
    chunks: Iterable[object],
    *,
    max_bytes: int,
    chunk_size: int,
    total: int = 0,
) -> int:
    del chunk_size
    for raw_chunk in chunks:
        chunk = _coerce_chunk(raw_chunk)
        total += len(chunk)
        if total > max_bytes:
            raise _failure(OutputIntegrityError)
        _write_all(descriptor, chunk)
    return total


def _copy_readable(
    descriptor: int,
    reader: Any,
    *,
    max_bytes: int,
    chunk_size: int,
) -> int:
    total = 0
    while True:
        try:
            raw_chunk = reader.read(chunk_size)
        except OSError as error:
            raise _failure() from error
        chunk = _coerce_chunk(raw_chunk)
        if not chunk:
            return total
        total += len(chunk)
        if total > max_bytes:
            raise _failure(OutputIntegrityError)
        _write_all(descriptor, chunk)


def _copy_source(
    descriptor: int,
    source: OutputSource,
    *,
    max_bytes: int,
    chunk_size: int,
) -> int:
    if isinstance(source, (bytes, bytearray, memoryview)):
        return _copy_chunks(
            descriptor,
            (source,),
            max_bytes=max_bytes,
            chunk_size=chunk_size,
        )
    reader = getattr(source, "read", None)
    if callable(reader):
        return _copy_readable(
            descriptor,
            source,
            max_bytes=max_bytes,
            chunk_size=chunk_size,
        )
    if isinstance(source, Iterable):
        return _copy_chunks(
            descriptor,
            source,
            max_bytes=max_bytes,
            chunk_size=chunk_size,
        )
    raise _failure(OutputIntegrityError)


@contextmanager
def _source_stream(source: OutputSource) -> Iterator[object]:
    enter = getattr(source, "__enter__", None)
    exit_method = getattr(source, "__exit__", None)
    if callable(enter) and callable(exit_method):
        manager = cast(AbstractContextManager[Any], source)
        with manager as stream:
            yield stream
        return
    yield source


def _verify_stage(
    descriptor: int,
    expected: _StageIdentity,
    *,
    max_bytes: int,
) -> tuple[int, Sha256]:
    _stage_identity(descriptor, expected)
    try:
        os.lseek(descriptor, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(descriptor, _DEFAULT_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise _failure(OutputIntegrityError)
            digest.update(chunk)
        metadata = os.fstat(descriptor)
    except AtomicOutputError:
        raise
    except OSError as error:
        raise _failure(OutputIntegrityError) from error
    _stage_identity(descriptor, expected)
    if metadata.st_size != total:
        raise _failure(OutputIntegrityError)
    try:
        return total, Sha256(digest.hexdigest())
    except ValueError as error:  # pragma: no cover - hashlib always emits 64 hex.
        raise _failure(OutputIntegrityError) from error


def _verify_parent_path(target: Path, expected: tuple[int, int]) -> None:
    descriptor, identity = _open_parent_directory(target)
    try:
        if identity != expected:
            raise _failure(OutputConflictError)
    finally:
        _close_descriptor(descriptor)


def _verify_stage_name(parent: int, name: str, expected: _StageIdentity) -> None:
    try:
        metadata = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except OSError as error:
        raise _failure(OutputIntegrityError) from error
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != _owner()
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink != 1
        or (metadata.st_dev, metadata.st_ino) != (expected.device, expected.inode)
    ):
        raise _failure(OutputIntegrityError)


def _publish(
    parent: int,
    stage_name: str,
    target_name: str,
    *,
    overwrite: bool,
    publication: _OverwritePublication | None = None,
) -> None:
    try:
        if overwrite:
            if publication is None:
                raise _failure(OutputConflictError)
            _renameat2_exchange(parent, stage_name, target_name)
            publication.exchanged = True
        else:
            os.link(
                stage_name,
                target_name,
                src_dir_fd=parent,
                dst_dir_fd=parent,
                follow_symlinks=False,
            )
    except FileExistsError as error:
        raise _failure(OutputConflictError) from error
    except OSError as error:
        raise _failure() from error


def _cleanup_stage(parent: int, name: str | None, expected: _StageIdentity | None) -> None:
    if name is None or expected is None:
        return
    try:
        metadata = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    except OSError:
        return
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != _owner()
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or (metadata.st_dev, metadata.st_ino) != (expected.device, expected.inode)
    ):
        return
    try:
        os.unlink(name, dir_fd=parent)
        os.fsync(parent)
    except OSError:
        pass


def _normalise_expected(
    expected_sha256: Sha256 | str | None,
    expected_size: int | None,
    *,
    max_bytes: int,
) -> tuple[Sha256 | None, int | None]:
    if expected_sha256 is None:
        normalized_sha256 = None
    else:
        try:
            normalized_sha256 = (
                expected_sha256 if isinstance(expected_sha256, Sha256) else Sha256(expected_sha256)
            )
        except (TypeError, ValueError) as error:
            raise _failure(OutputIntegrityError) from error
    if expected_size is not None and (
        type(expected_size) is not int or expected_size < 0 or expected_size > max_bytes
    ):
        raise _failure(OutputIntegrityError)
    return normalized_sha256, expected_size


def _stage_payload(
    descriptor: int,
    source: OutputSource,
    expected_sha256: Sha256 | None,
    expected_size: int | None,
    *,
    max_bytes: int,
    chunk_size: int,
    failpoint: Checkpoint | None,
    stage_expected: _StageIdentity,
) -> tuple[int, Sha256]:
    with _source_stream(source) as stream:
        _copy_source(
            descriptor,
            stream,
            max_bytes=max_bytes,
            chunk_size=chunk_size,
        )
    _checkpoint(failpoint, "staging-written")
    try:
        os.fsync(descriptor)
    except OSError as error:
        raise _failure() from error
    _checkpoint(failpoint, "staging-fsynced")
    byte_size, digest = _verify_stage(
        descriptor,
        stage_expected,
        max_bytes=max_bytes,
    )
    if expected_sha256 is not None and digest != expected_sha256:
        raise _failure(OutputIntegrityError)
    if expected_size is not None and byte_size != expected_size:
        raise _failure(OutputIntegrityError)
    _checkpoint(failpoint, "staging-verified")
    return byte_size, digest


def _publish_stage(
    parent: int,
    target: Path,
    parent_identity: tuple[int, int],
    target_name: str,
    original_target: _FileIdentity | None,
    stage_name: str,
    stage_descriptor: int,
    stage_expected: _StageIdentity,
    *,
    overwrite: bool,
    publication: _OverwritePublication | None,
    failpoint: Checkpoint | None,
) -> None:
    _checkpoint(failpoint, "before-publish")
    _verify_parent_path(target, parent_identity)
    current_target = _read_target(parent, target_name)
    if not _same_identity(current_target, original_target):
        raise _failure(OutputConflictError)
    if publication is not None:
        _prepare_overwrite(publication)
    _stage_identity(stage_descriptor, stage_expected)
    _verify_stage_name(parent, stage_name, stage_expected)
    _checkpoint(failpoint, "after-identity-check")
    _publish(
        parent,
        stage_name,
        target_name,
        overwrite=publication is not None,
        publication=publication,
    )
    _checkpoint(failpoint, "after-publish")
    _checkpoint(failpoint, "before-directory-fsync")
    try:
        os.fsync(parent)
    except OSError as error:
        raise _failure() from error
    _checkpoint(failpoint, "directory-fsynced")


def _run_publication(
    parent: int,
    target: Path,
    parent_identity: tuple[int, int],
    target_name: str,
    original_target: _FileIdentity | None,
    source: OutputSource,
    *,
    stage: int,
    stage_name: str,
    stage_expected: _StageIdentity,
    overwrite: bool,
    publication: _OverwritePublication | None,
    expected_sha256: Sha256 | None,
    expected_size: int | None,
    max_bytes: int,
    chunk_size: int,
    failpoint: Checkpoint | None,
) -> OutputResult:  # noqa: C901
    _checkpoint(failpoint, "staging-created")
    byte_size, digest = _stage_payload(
        stage,
        source,
        expected_sha256,
        expected_size,
        max_bytes=max_bytes,
        chunk_size=chunk_size,
        failpoint=failpoint,
        stage_expected=stage_expected,
    )
    _publish_stage(
        parent,
        target,
        parent_identity,
        target_name,
        original_target,
        stage_name,
        stage,
        stage_expected,
        overwrite=overwrite,
        publication=publication,
        failpoint=failpoint,
    )
    return OutputResult(byte_size=byte_size, sha256=digest)


def _cleanup_publication(
    parent: int,
    stage: int,
    stage_name: str | None,
    stage_expected: _StageIdentity | None,
    failpoint: Checkpoint | None,
) -> tuple[BaseException | None, bool]:
    failure, preserve = _checkpoint_failure(failpoint, "before-cleanup")
    try:
        _close_descriptor(stage)
        _cleanup_stage(parent, stage_name, stage_expected)
    except BaseException as error:
        if failure is None:
            failure, preserve = _normalise_failure(error)
    cleanup_failure, cleanup_preserve = _checkpoint_failure(failpoint, "after-cleanup")
    if failure is None:
        return cleanup_failure, cleanup_preserve
    return failure, preserve


def _execute_publication(  # noqa: C901
    parent: int,
    target: Path,
    parent_identity: tuple[int, int],
    target_name: str,
    original_target: _FileIdentity | None,
    source: OutputSource,
    *,
    overwrite: bool,
    expected_sha256: Sha256 | None,
    expected_size: int | None,
    max_bytes: int,
    chunk_size: int,
    failpoint: Checkpoint | None,
) -> OutputResult:
    stage = -1
    stage_name: str | None = None
    stage_expected: _StageIdentity | None = None
    publication: _OverwritePublication | None = None
    result: OutputResult | None = None
    failure: BaseException | None = None
    preserve_failure = False
    try:
        stage, stage_name, stage_expected = _create_stage(parent)
        if overwrite and original_target is not None:
            publication = _OverwritePublication(
                parent=parent,
                target_name=target_name,
                stage_name=stage_name,
                original=original_target,
                stage=stage_expected,
            )
        result = _run_publication(
            parent,
            target,
            parent_identity,
            target_name,
            original_target,
            source,
            stage=stage,
            stage_name=stage_name,
            stage_expected=stage_expected,
            overwrite=overwrite,
            publication=publication,
            expected_sha256=expected_sha256,
            expected_size=expected_size,
            max_bytes=max_bytes,
            chunk_size=chunk_size,
            failpoint=failpoint,
        )
    except BaseException as error:
        failure, preserve_failure = _normalise_failure(error)
    finally:
        cleanup_failure, cleanup_preserve = _cleanup_publication(
            parent,
            stage,
            stage_name,
            stage_expected,
            failpoint,
        )
        if failure is None:
            failure = cleanup_failure
            preserve_failure = cleanup_preserve
    if failure is not None:
        if publication is not None:
            try:
                _rollback_overwrite(publication)
            except BaseException:
                if not isinstance(failure, (KeyboardInterrupt, SystemExit, GeneratorExit)):
                    failure = _failure()
                    preserve_failure = False
        if preserve_failure:
            raise _PropagatedFailure(failure)
        raise failure
    if result is None:  # pragma: no cover - defensive invariant.
        raise _failure()
    if publication is not None:
        try:
            _commit_overwrite(publication)
        except BaseException as error:
            commit_failure, commit_preserve = _normalise_failure(error)
            try:
                _rollback_overwrite(publication)
            except BaseException:
                if not isinstance(commit_failure, (KeyboardInterrupt, SystemExit, GeneratorExit)):
                    commit_failure = _failure()
                    commit_preserve = False
            if commit_preserve:
                raise _PropagatedFailure(commit_failure)
            raise commit_failure
    return result


class AtomicOutput:
    """Publish one controlled binary stream to a user-selected target."""

    __slots__ = ("_chunk_size", "_max_bytes", "_spool_memory_bytes")

    def __init__(
        self,
        *,
        chunk_size: int = _DEFAULT_CHUNK_BYTES,
        max_bytes: int = _DEFAULT_MAX_OUTPUT_BYTES,
        spool_memory_bytes: int = _DEFAULT_SPOOL_MEMORY_BYTES,
    ) -> None:
        if type(chunk_size) is not int or chunk_size <= 0:
            raise OutputIntegrityError()
        if type(max_bytes) is not int or max_bytes <= 0:
            raise OutputIntegrityError()
        if type(spool_memory_bytes) is not int or spool_memory_bytes <= 0:
            raise OutputIntegrityError()
        self._chunk_size = chunk_size
        self._max_bytes = max_bytes
        self._spool_memory_bytes = min(spool_memory_bytes, max_bytes)

    def __repr__(self) -> str:
        return "<AtomicOutput>"

    @contextmanager
    def open_atomic(
        self,
        target: str | os.PathLike[str],
        *,
        overwrite: bool = False,
    ) -> Iterator[BinaryIO]:
        """Yield bounded private staging and publish only after clean exit."""

        if type(overwrite) is not bool:
            raise OutputIntegrityError()
        stream = cast(
            BinaryIO,
            SpooledTemporaryFile(
                max_size=self._spool_memory_bytes,
                mode="w+b",
                prefix="sciretriever-user-output-",
            ),
        )
        staged = _BoundedSpool(stream, max_bytes=self._max_bytes)
        try:
            yield cast(BinaryIO, staged)
            source = staged.prepare_for_publication()
            self.write(target, source, overwrite=overwrite)
        finally:
            staged.close()

    def write(
        self,
        target: str | os.PathLike[str],
        source: OutputSource,
        *,
        overwrite: bool = False,
        expected_sha256: Sha256 | str | None = None,
        expected_size: int | None = None,
        failpoint: Checkpoint | None = None,
    ) -> OutputResult:
        """Copy, verify and atomically publish ``source`` to ``target``.

        A raw readable source remains caller-owned.  A context-managed source
        is entered and exited here so a verified reader can complete its own
        close-time identity check before the target is published.
        """

        if type(overwrite) is not bool:
            raise OutputIntegrityError()
        normalized_sha256, normalized_size = _normalise_expected(
            expected_sha256,
            expected_size,
            max_bytes=self._max_bytes,
        )
        normalized_target = _normalise_target(target)
        target_name = normalized_target.name
        parent = -1
        failure: BaseException | None = None
        result: OutputResult | None = None
        try:
            parent, parent_identity = _open_parent_directory(normalized_target)
            original_target = _read_target(parent, target_name)
            if original_target is not None and not overwrite:
                raise _failure(OutputConflictError)
            result = _execute_publication(
                parent,
                normalized_target,
                parent_identity,
                target_name,
                original_target,
                source,
                overwrite=overwrite,
                expected_sha256=normalized_sha256,
                expected_size=normalized_size,
                max_bytes=self._max_bytes,
                chunk_size=self._chunk_size,
                failpoint=failpoint,
            )
        except _PropagatedFailure as error:
            failure = error.cause
        except AtomicOutputError as error:
            failure = error
        except (KeyboardInterrupt, SystemExit, GeneratorExit) as error:
            failure = error
        except BaseException:
            failure = _failure()
        finally:
            _close_descriptor(parent)
        if failure is not None:
            raise failure
        if result is None:  # pragma: no cover - defensive invariant.
            raise _failure()
        return result


def write_atomic(
    target: str | os.PathLike[str],
    source: OutputSource,
    *,
    overwrite: bool = False,
    expected_sha256: Sha256 | str | None = None,
    expected_size: int | None = None,
    failpoint: Checkpoint | None = None,
) -> OutputResult:
    """Convenience wrapper for one default-bounded atomic output."""

    return AtomicOutput().write(
        target,
        source,
        overwrite=overwrite,
        expected_sha256=expected_sha256,
        expected_size=expected_size,
        failpoint=failpoint,
    )


__all__ = (
    "AtomicOutput",
    "AtomicOutputError",
    "OutputConflictError",
    "OutputIntegrityError",
    "OutputResult",
    "OutputSecurityError",
    "write_atomic",
)
