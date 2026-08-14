"""Fail-closed filesystem boundaries for the private storage root.

The public values returned by this module are relative references or integer
file descriptors.  A configured absolute path is kept only by the storage
boundary itself; it is never included in a normal result or an error message.
All filesystem traversal after root binding is descriptor-relative and uses
``O_NOFOLLOW`` where the platform provides it.
"""

from __future__ import annotations

import ctypes
import errno
import os
import re
import secrets
import stat
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable, Final, Literal, NoReturn, TypeAlias

from sciretriever.model.primitives import RelativeArtifactPath, Sha256

_DEFAULT_ERROR = "storage path rejected"
_MISSING_ERROR = "storage path is missing or unsafe"
_REFERENCE_ERROR = "storage reference is invalid or unsafe"
_DIRECTORY_ERROR = "storage object is not a directory"
_FILE_ERROR = "storage object is not a regular file"
_IDENTITY_ERROR = "storage object identity changed"
_QUARANTINE_PREFIX = ".sciretriever-quarantine-"
_MAX_QUARANTINE_ATTEMPTS: Final[int] = 32
_HEX_DIGEST = re.compile(r"^[0-9a-f]{64}$", re.ASCII)
_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:")

_RENAME_NOREPLACE: Final[int] = 1

_DIRECTORY_FLAGS: Final[int] = (
    os.O_RDONLY
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
_READ_FLAGS: Final[int] = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)

ReferenceKind: TypeAlias = Literal["file", "directory", "any"]


class StoragePathError(ValueError):
    """Stable, path-free error raised at the private storage boundary."""

    _MESSAGES = frozenset(
        {
            _DEFAULT_ERROR,
            _MISSING_ERROR,
            _REFERENCE_ERROR,
            _DIRECTORY_ERROR,
            _FILE_ERROR,
            _IDENTITY_ERROR,
        }
    )

    def __init__(self, message: str = _DEFAULT_ERROR) -> None:
        super().__init__(message if message in self._MESSAGES else _DEFAULT_ERROR)


@dataclass(frozen=True, slots=True)
class _NodeIdentity:
    device: int
    inode: int


def _fail(message: str = _DEFAULT_ERROR) -> NoReturn:
    raise StoragePathError(message)


def _coerce_configured_path(value: str | os.PathLike[str]) -> Path:
    try:
        raw = os.fspath(value)
    except TypeError:
        _fail()
    if not isinstance(raw, str) or not raw or "\x00" in raw:
        _fail()
    # ``abspath`` performs lexical normalisation only.  ``Path.resolve`` is
    # deliberately avoided because silently following a symlink would turn a
    # path binding into an implicit trust decision.
    try:
        return Path(os.path.abspath(raw))
    except (OSError, ValueError):
        _fail()


def _identity(metadata: os.stat_result) -> _NodeIdentity:
    return _NodeIdentity(metadata.st_dev, metadata.st_ino)


def _rename_noreplace(parent: int, source: str, destination: str) -> None:
    """Move one directory entry without replacing a concurrent destination."""

    if not sys.platform.startswith("linux"):
        raise OSError(errno.ENOTSUP, "atomic quarantine move unavailable")
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        function = libc.renameat2
    except (AttributeError, OSError) as error:
        raise OSError(errno.ENOTSUP, "atomic quarantine move unavailable") from error
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
        os.fsencode(source),
        parent,
        os.fsencode(destination),
        _RENAME_NOREPLACE,
    )
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(
            error_number or errno.EIO,
            os.strerror(error_number or errno.EIO),
        )


def _quarantine_unlink(
    parent: int,
    name: str,
    descriptor: int,
    validate: Callable[[os.stat_result], None],
) -> None:
    """Move a name aside, verify the moved object, then remove only that object.

    The caller keeps ``descriptor`` open from its last identity check through
    this operation.  A replacement that wins before the atomic move is moved
    into quarantine and fails validation, so it remains as evidence rather
    than being removed through the original name.  A replacement that wins
    after the move occupies the original name and is likewise not touched.
    """

    expected = _identity(os.fstat(descriptor))
    quarantine_name: str | None = None
    for _ in range(_MAX_QUARANTINE_ATTEMPTS):
        candidate = f"{_QUARANTINE_PREFIX}{secrets.token_hex(16)}"
        try:
            _rename_noreplace(parent, name, candidate)
        except FileExistsError:
            continue
        quarantine_name = candidate
        break
    if quarantine_name is None:
        raise OSError(errno.EEXIST, "quarantine name allocation failed")

    quarantine_descriptor = -1
    moved_name = True
    try:
        quarantine_descriptor = os.open(quarantine_name, _READ_FLAGS, dir_fd=parent)
        moved = os.fstat(quarantine_descriptor)
        if _identity(moved) != expected:
            _fail(_IDENTITY_ERROR)
        validate(moved)
        os.unlink(quarantine_name, dir_fd=parent)
        moved_name = False
        os.fsync(parent)
    except BaseException:
        if moved_name:
            try:
                os.fsync(parent)
            except OSError:
                pass
        raise
    finally:
        if quarantine_descriptor >= 0:
            try:
                os.close(quarantine_descriptor)
            except OSError:
                pass


def _validate_directory(metadata: os.stat_result) -> None:
    if not stat.S_ISDIR(metadata.st_mode):
        _fail(_DIRECTORY_ERROR)


def _close_all(descriptors: list[int]) -> None:
    for descriptor in reversed(descriptors):
        try:
            os.close(descriptor)
        except OSError:
            pass


def _open_directory(parent: int, name: str) -> int:
    try:
        return os.open(name, _DIRECTORY_FLAGS, dir_fd=parent)
    except OSError as error:
        raise StoragePathError(_MISSING_ERROR) from error


def _parts(path: Path) -> tuple[str, ...]:
    # ``Path.parts`` for an absolute POSIX path starts with ``/``.  The root
    # descriptor is opened separately, so only named components are returned.
    return tuple(part for part in path.parts if part != os.sep)


def _relative_text(value: str | os.PathLike[str] | RelativeArtifactPath) -> str:
    if isinstance(value, RelativeArtifactPath):
        text = value.root
    else:
        try:
            raw = os.fspath(value)
        except TypeError:
            _fail(_REFERENCE_ERROR)
        if not isinstance(raw, str):
            _fail(_REFERENCE_ERROR)
        text = raw
    if (
        not text
        or any(ord(character) < 32 or ord(character) == 127 for character in text)
        or "\\" in text
        or text.startswith("/")
        or _WINDOWS_DRIVE.match(text) is not None
    ):
        _fail(_REFERENCE_ERROR)
    components = text.split("/")
    if any(component in {"", ".", ".."} for component in components):
        _fail(_REFERENCE_ERROR)
    try:
        parsed = PurePosixPath(text)
        if parsed.is_absolute() or parsed.as_posix() != text:
            _fail(_REFERENCE_ERROR)
        return RelativeArtifactPath(text).root
    except (TypeError, ValueError):
        _fail(_REFERENCE_ERROR)


def _relative_reference(
    value: str | os.PathLike[str] | RelativeArtifactPath,
) -> RelativeArtifactPath:
    return RelativeArtifactPath(_relative_text(value))


def _kind(value: str) -> ReferenceKind:
    if value not in {"file", "directory", "any"}:
        _fail(_REFERENCE_ERROR)
    return value  # type: ignore[return-value]


def _validate_object(metadata: os.stat_result, expected: ReferenceKind) -> None:
    is_directory = stat.S_ISDIR(metadata.st_mode)
    is_regular = stat.S_ISREG(metadata.st_mode)
    if expected == "directory":
        if not is_directory:
            _fail(_DIRECTORY_ERROR)
        return
    if expected == "file":
        if not is_regular:
            _fail(_FILE_ERROR)
        if metadata.st_nlink != 1:
            _fail(_IDENTITY_ERROR)
        return
    if not (is_directory or is_regular):
        _fail(_REFERENCE_ERROR)
    if is_regular and metadata.st_nlink != 1:
        _fail(_IDENTITY_ERROR)


class StorageRoot:
    """A bound storage root with descriptor-relative operations.

    Construction validates and, when necessary, securely creates the final
    path components.  The configured path is retained for the storage layer's
    own re-opening checks; callers should exchange only ``RelativeArtifactPath``
    values or descriptors with business code.
    """

    __slots__ = ("_canonical_path", "_chain")

    def __init__(self, configured_root: str | os.PathLike[str]) -> None:
        canonical_path = _coerce_configured_path(configured_root)
        chain = self._bind(canonical_path)
        self._canonical_path = canonical_path
        self._chain = chain

    @property
    def canonical_path(self) -> Path:
        """The canonical path for storage internals, never a relative result."""

        return self._canonical_path

    def __repr__(self) -> str:
        return "StorageRoot(<bound root>)"

    @staticmethod
    def _bind(path: Path) -> tuple[_NodeIdentity, ...]:  # noqa: C901
        components = _parts(path)
        if not components:
            _fail(_DIRECTORY_ERROR)
        descriptors: list[int] = []
        try:
            try:
                current = os.open(os.sep, _DIRECTORY_FLAGS)
            except OSError as error:
                raise StoragePathError(_MISSING_ERROR) from error
            descriptors.append(current)
            identities = [_identity(os.fstat(current))]
            for component in components:
                try:
                    child = os.open(component, _DIRECTORY_FLAGS, dir_fd=current)
                except FileNotFoundError:
                    try:
                        os.mkdir(component, 0o700, dir_fd=current)
                        os.fsync(current)
                    except FileExistsError:
                        pass
                    except OSError as error:
                        raise StoragePathError(_MISSING_ERROR) from error
                    child = _open_directory(current, component)
                except OSError as error:
                    raise StoragePathError(_MISSING_ERROR) from error
                descriptors.append(child)
                metadata = os.fstat(child)
                _validate_directory(metadata)
                identities.append(_identity(metadata))
                current = child
            return tuple(identities)
        except StoragePathError:
            raise
        except OSError as error:
            raise StoragePathError(_DEFAULT_ERROR) from error
        finally:
            _close_all(descriptors)

    def _open_bound_chain(self) -> list[int]:
        components = _parts(self._canonical_path)
        descriptors: list[int] = []
        try:
            try:
                current = os.open(os.sep, _DIRECTORY_FLAGS)
            except OSError as error:
                raise StoragePathError(_MISSING_ERROR) from error
            descriptors.append(current)
            if _identity(os.fstat(current)) != self._chain[0]:
                _fail(_IDENTITY_ERROR)
            for index, component in enumerate(components):
                try:
                    child = os.open(component, _DIRECTORY_FLAGS, dir_fd=current)
                except OSError as error:
                    raise StoragePathError(_MISSING_ERROR) from error
                descriptors.append(child)
                metadata = os.fstat(child)
                if _identity(metadata) != self._chain[index + 1]:
                    _fail(_IDENTITY_ERROR)
                _validate_directory(metadata)
                current = child
            return descriptors
        except StoragePathError:
            _close_all(descriptors)
            raise
        except OSError as error:
            _close_all(descriptors)
            raise StoragePathError(_DEFAULT_ERROR) from error

    def _open_root_fd(self) -> int:
        descriptors = self._open_bound_chain()
        for descriptor in descriptors[:-1]:
            try:
                os.close(descriptor)
            except OSError:
                pass
        return descriptors[-1]

    @contextmanager
    def open_root(self) -> Iterator[int]:
        """Yield a freshly bound root descriptor and close it afterwards."""

        descriptor = self._open_root_fd()
        try:
            yield descriptor
        finally:
            try:
                os.close(descriptor)
            except OSError:
                pass

    @contextmanager
    def _open_parent(self, reference: str, *, create: bool = False) -> Iterator[int]:
        components = reference.split("/")
        descriptors = self._open_bound_chain()
        try:
            current = descriptors[-1]
            for component in components[:-1]:
                if create:
                    try:
                        os.mkdir(component, 0o700, dir_fd=current)
                        os.fsync(current)
                    except FileExistsError:
                        pass
                    except OSError as error:
                        raise StoragePathError(_MISSING_ERROR) from error
                try:
                    child = os.open(component, _DIRECTORY_FLAGS, dir_fd=current)
                except OSError as error:
                    raise StoragePathError(_MISSING_ERROR) from error
                metadata = os.fstat(child)
                try:
                    _validate_directory(metadata)
                except StoragePathError:
                    os.close(child)
                    raise
                descriptors.append(child)
                current = child
            yield current
        finally:
            _close_all(descriptors)

    def ensure_directory(
        self, reference: str | os.PathLike[str] | RelativeArtifactPath
    ) -> RelativeArtifactPath:
        """Create and validate a directory below the root."""

        normalized = _relative_reference(reference)
        components = normalized.root.split("/")
        descriptors = self._open_bound_chain()
        try:
            current = descriptors[-1]
            for component in components:
                try:
                    os.mkdir(component, 0o700, dir_fd=current)
                    os.fsync(current)
                except FileExistsError:
                    pass
                except OSError as error:
                    raise StoragePathError(_MISSING_ERROR) from error
                try:
                    child = os.open(component, _DIRECTORY_FLAGS, dir_fd=current)
                except OSError as error:
                    raise StoragePathError(_MISSING_ERROR) from error
                metadata = os.fstat(child)
                try:
                    _validate_directory(metadata)
                except StoragePathError:
                    os.close(child)
                    raise
                descriptors.append(child)
                current = child
            return normalized
        finally:
            _close_all(descriptors)

    @contextmanager
    def open_relative(
        self,
        reference: str | os.PathLike[str] | RelativeArtifactPath,
        *,
        kind: str = "any",
    ) -> Iterator[int]:
        """Open an existing relative object without following symlinks."""

        normalized = _relative_reference(reference)
        expected = _kind(kind)
        with self._open_parent(normalized.root) as parent:
            flags = _READ_FLAGS
            if expected == "directory":
                flags |= getattr(os, "O_DIRECTORY", 0)
            try:
                descriptor = os.open(normalized.root.rsplit("/", 1)[-1], flags, dir_fd=parent)
            except OSError as error:
                raise StoragePathError(_MISSING_ERROR) from error
            try:
                initial = os.fstat(descriptor)
                _validate_object(initial, expected)
                final = os.fstat(descriptor)
                if _identity(initial) != _identity(final):
                    _fail(_IDENTITY_ERROR)
                _validate_object(final, expected)
                yield descriptor
            except StoragePathError:
                raise
            except OSError as error:
                raise StoragePathError(_DEFAULT_ERROR) from error
            finally:
                try:
                    os.close(descriptor)
                except OSError:
                    pass

    def resolve(
        self,
        reference: str | os.PathLike[str] | RelativeArtifactPath,
        *,
        kind: str = "any",
        allow_missing: bool = False,
    ) -> RelativeArtifactPath:
        """Validate a reference and return only its normalized relative form."""

        normalized = _relative_reference(reference)
        expected = _kind(kind)
        if allow_missing:
            with self._open_parent(normalized.root) as parent:
                name = normalized.root.rsplit("/", 1)[-1]
                try:
                    metadata = os.stat(name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    return normalized
                except OSError as error:
                    raise StoragePathError(_MISSING_ERROR) from error
                _validate_object(metadata, expected)
                return normalized
        with self.open_relative(normalized, kind=expected):
            pass
        return normalized

    @contextmanager
    def open_directory(
        self, reference: str | os.PathLike[str] | RelativeArtifactPath
    ) -> Iterator[int]:
        with self.open_relative(reference, kind="directory") as descriptor:
            yield descriptor

    def unlink_relative(self, reference: str | os.PathLike[str] | RelativeArtifactPath) -> None:
        """Unlink a regular file after descriptor-relative checks.

        This narrow helper is intended for a caller that owns a temporary
        reference.  Staging cleanup uses its own directory descriptor and does
        not use this method for formal artifacts.
        """

        normalized = _relative_reference(reference)
        with self._open_parent(normalized.root) as parent:
            name = normalized.root.rsplit("/", 1)[-1]
            try:
                descriptor = os.open(name, _READ_FLAGS, dir_fd=parent)
            except OSError as error:
                raise StoragePathError(_MISSING_ERROR) from error
            try:
                metadata = os.fstat(descriptor)
                _validate_object(metadata, "file")
                _quarantine_unlink(
                    parent,
                    name,
                    descriptor,
                    lambda moved: _validate_object(moved, "file"),
                )
            except StoragePathError:
                raise
            except OSError as error:
                raise StoragePathError(_DEFAULT_ERROR) from error
            finally:
                try:
                    os.close(descriptor)
                except OSError:
                    pass


def content_addressed_reference(
    sha256: Sha256 | str,
    byte_size: int,
) -> RelativeArtifactPath:
    """Return a deterministic private relative reference from byte identity."""

    if isinstance(sha256, Sha256):
        digest = sha256.root
    elif type(sha256) is str:
        digest = sha256
    else:
        _fail(_REFERENCE_ERROR)
    if type(digest) is not str or _HEX_DIGEST.fullmatch(digest) is None:
        _fail(_REFERENCE_ERROR)
    if type(byte_size) is not int or byte_size < 0:
        _fail(_REFERENCE_ERROR)
    return RelativeArtifactPath(f".objects/{digest[:2]}/{digest}-{byte_size}")


__all__ = [
    "ReferenceKind",
    "StoragePathError",
    "StorageRoot",
    "content_addressed_reference",
]
