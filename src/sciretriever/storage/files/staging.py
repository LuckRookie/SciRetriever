"""Owner-only, descriptor-relative staging files.

Staging objects are deliberately anonymous with respect to the domain.  Their
names contain only a random token, and their lifetime is independent of any
Catalog fact.  A caller must explicitly hand a relative reference to a later
publication step; an ordinary context exit always removes the temporary file.
"""

from __future__ import annotations

import atexit
import os
import secrets
import stat
import weakref
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Final

from sciretriever.model.primitives import RelativeArtifactPath

from .paths import StoragePathError, StorageRoot, _quarantine_unlink

_STAGING_DIRECTORY = ".staging"
_STAGING_PREFIX = "stage-"
_MAX_CREATE_ATTEMPTS: Final[int] = 32
_STAGING_FLAGS: Final[int] = (
    os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
)
_READ_FLAGS: Final[int] = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)


class StagingError(StoragePathError):
    """Stable error for a staging object whose safety contract failed."""


@dataclass(frozen=True, slots=True)
class StagingIdentity:
    """The non-secret identity and current byte size of a stage descriptor."""

    device: int
    inode: int
    size: int
    links: int


_ACTIVE: dict[int, weakref.ReferenceType[StagingFile]] = {}


def _staging_failure() -> StagingError:
    return StagingError()


def _identity(descriptor: int) -> StagingIdentity:
    metadata = os.fstat(descriptor)
    return StagingIdentity(
        device=metadata.st_dev,
        inode=metadata.st_ino,
        size=metadata.st_size,
        links=metadata.st_nlink,
    )


def _validate_stage_metadata(
    metadata: os.stat_result, owner: int, expected: StagingIdentity | None = None
) -> None:
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != owner
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink != 1
    ):
        raise _staging_failure()
    if expected is not None and (
        metadata.st_dev != expected.device or metadata.st_ino != expected.inode
    ):
        raise _staging_failure()


class StagingFile:
    """A single owner-only temporary file inside the private staging area."""

    __slots__ = (
        "_root",
        "_directory_fd",
        "_descriptor",
        "_name",
        "_reference",
        "_initial",
        "_handoff",
        "_closed",
        "__weakref__",
    )

    def __init__(self, root: StorageRoot) -> None:
        self._root = root
        self._directory_fd = -1
        self._descriptor = -1
        self._name = ""
        self._reference = RelativeArtifactPath(f"{_STAGING_DIRECTORY}/placeholder")
        self._initial = StagingIdentity(0, 0, 0, 0)
        self._handoff = False
        self._closed = False

        root.ensure_directory(_STAGING_DIRECTORY)
        try:
            with root.open_directory(_STAGING_DIRECTORY) as directory:
                self._directory_fd = os.dup(directory)
                for _ in range(_MAX_CREATE_ATTEMPTS):
                    name = f"{_STAGING_PREFIX}{secrets.token_hex(16)}.tmp"
                    try:
                        descriptor = os.open(
                            name,
                            _STAGING_FLAGS,
                            0o600,
                            dir_fd=self._directory_fd,
                        )
                    except FileExistsError:
                        continue
                    except OSError as error:
                        raise _staging_failure() from error
                    metadata = os.fstat(descriptor)
                    try:
                        _validate_stage_metadata(metadata, root.owner)
                    except StagingError:
                        os.close(descriptor)
                        try:
                            os.unlink(name, dir_fd=self._directory_fd)
                        except OSError:
                            pass
                        raise
                    self._descriptor = descriptor
                    self._name = name
                    self._reference = RelativeArtifactPath(f"{_STAGING_DIRECTORY}/{name}")
                    self._initial = _identity(descriptor)
                    break
                else:
                    raise _staging_failure()
        except StagingError:
            self._close_descriptors()
            raise
        except OSError as error:
            self._close_descriptors()
            raise _staging_failure() from error
        _ACTIVE[id(self)] = weakref.ref(self)

    @property
    def reference(self) -> RelativeArtifactPath:
        """The only path value exposed by a stage: a safe relative reference."""

        return self._reference

    def _ensure_open(self) -> None:
        if self._closed or self._descriptor < 0 or self._directory_fd < 0:
            raise _staging_failure()

    def _check_identity(self) -> StagingIdentity:
        self._ensure_open()
        try:
            metadata = os.fstat(self._descriptor)
        except OSError as error:
            raise _staging_failure() from error
        _validate_stage_metadata(metadata, self._root.owner, self._initial)
        return StagingIdentity(
            device=metadata.st_dev,
            inode=metadata.st_ino,
            size=metadata.st_size,
            links=metadata.st_nlink,
        )

    def identity(self) -> StagingIdentity:
        """Recheck descriptor identity and return only non-path metadata."""

        return self._check_identity()

    def write(self, data: bytes | bytearray | memoryview) -> int:
        """Write all supplied bytes to the stage and return the byte count."""

        self._check_identity()
        try:
            view = memoryview(data)
        except TypeError as error:
            raise _staging_failure() from error
        total = 0
        try:
            while view:
                written = os.write(self._descriptor, view)
                if written <= 0:
                    raise _staging_failure()
                total += written
                view = view[written:]
        except StagingError:
            raise
        except (OSError, TypeError) as error:
            raise _staging_failure() from error
        self._check_identity()
        return total

    def flush(self) -> None:
        """Durably flush stage bytes and recheck the descriptor identity."""

        self._check_identity()
        try:
            os.fsync(self._descriptor)
        except OSError as error:
            raise _staging_failure() from error
        self._check_identity()

    @contextmanager
    def open(self) -> Iterator[int]:
        """Yield a duplicate descriptor for a short, caller-owned read/write use."""

        self._check_identity()
        try:
            descriptor = os.dup(self._descriptor)
        except OSError as error:
            raise _staging_failure() from error
        try:
            yield descriptor
        finally:
            try:
                os.close(descriptor)
            except OSError:
                pass
        self._check_identity()

    def handoff(self) -> RelativeArtifactPath:
        """Flush and transfer cleanup responsibility to a publication step."""

        self.flush()
        self._handoff = True
        return self._reference

    def _close_descriptors(self) -> None:
        if self._descriptor >= 0:
            try:
                os.close(self._descriptor)
            except OSError:
                pass
            self._descriptor = -1
        if self._directory_fd >= 0:
            try:
                os.close(self._directory_fd)
            except OSError:
                pass
            self._directory_fd = -1

    def _unlink_owned_name(self) -> None:
        if self._directory_fd < 0 or not self._name:
            return
        try:
            descriptor = os.open(self._name, _READ_FLAGS, dir_fd=self._directory_fd)
        except FileNotFoundError:
            return
        except OSError as error:
            raise _staging_failure() from error
        try:
            metadata = os.fstat(descriptor)
            _validate_stage_metadata(metadata, self._root.owner, self._initial)
            _quarantine_unlink(
                self._directory_fd,
                self._name,
                descriptor,
                lambda moved: _validate_stage_metadata(moved, self._root.owner, self._initial),
            )
        except StagingError:
            raise
        except StoragePathError as error:
            raise _staging_failure() from error
        except OSError as error:
            raise _staging_failure() from error
        finally:
            try:
                os.close(descriptor)
            except OSError:
                pass

    def _cleanup(self, *, report_errors: bool) -> None:
        if self._closed:
            return
        error: StagingError | None = None
        if not self._handoff:
            try:
                self._check_identity()
                self._unlink_owned_name()
            except StagingError as raised:
                error = raised
        self._close_descriptors()
        self._closed = True
        _ACTIVE.pop(id(self), None)
        if report_errors and error is not None:
            raise error

    def discard(self) -> None:
        """Discard a handed-off stage after re-opening and checking its name."""

        if not self._handoff:
            self._cleanup(report_errors=True)
            return
        if not self._closed:
            self._cleanup(report_errors=True)
        try:
            with self._root.open_directory(_STAGING_DIRECTORY) as directory:
                descriptor = os.open(self._name, _READ_FLAGS, dir_fd=directory)
                try:
                    metadata = os.fstat(descriptor)
                    _validate_stage_metadata(metadata, self._root.owner, self._initial)
                    _quarantine_unlink(
                        directory,
                        self._name,
                        descriptor,
                        lambda moved: _validate_stage_metadata(
                            moved,
                            self._root.owner,
                            self._initial,
                        ),
                    )
                finally:
                    try:
                        os.close(descriptor)
                    except OSError:
                        pass
        except FileNotFoundError:
            return
        except StagingError:
            raise
        except StoragePathError as error:
            raise _staging_failure() from error
        except OSError as error:
            raise _staging_failure() from error

    def close(self) -> None:
        """Close the stage, removing it unless it was explicitly handed off."""

        self._cleanup(report_errors=True)

    def __enter__(self) -> StagingFile:
        self._ensure_open()
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        # Preserve a body exception if cleanup itself detects an unsafe
        # replacement.  In the normal path, cleanup errors are surfaced.
        self._cleanup(report_errors=exc_type is None)
        return False

    def __del__(self) -> None:  # pragma: no cover - interpreter shutdown fallback.
        try:
            self._cleanup(report_errors=False)
        except Exception:
            pass


def _cleanup_at_exit() -> None:
    for reference in tuple(_ACTIVE.values()):
        stage = reference()
        if stage is not None:
            try:
                stage._cleanup(report_errors=False)
            except Exception:
                pass


atexit.register(_cleanup_at_exit)


def create_staging(root: StorageRoot | str | os.PathLike[str]) -> StagingFile:
    """Create one random owner-only stage below a bound storage root."""

    bound = root if isinstance(root, StorageRoot) else StorageRoot(root)
    return StagingFile(bound)


__all__ = [
    "StagingError",
    "StagingFile",
    "StagingIdentity",
    "create_staging",
]
