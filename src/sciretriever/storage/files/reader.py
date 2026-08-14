"""Verified, context-managed reads from the private artifact store.

The reader is deliberately a small filesystem helper.  It accepts a relative
reference and the identity expected by its caller, verifies the regular file
before handing out a descriptor, and verifies the named object
again when the read context closes.  It does not infer a media type from the
bytes and it never exposes the configured absolute root.
"""

from __future__ import annotations

import hashlib
import os
import stat
from contextlib import AbstractContextManager
from dataclasses import dataclass
from types import TracebackType
from typing import BinaryIO, Final, cast

from sciretriever.model.primitives import RelativeArtifactPath, Sha256

from .paths import StoragePathError, StorageRoot, content_addressed_reference
from .store import ArtifactReference, ArtifactStoreError, _ArtifactPublication

_DEFAULT_MAX_ARTIFACT_BYTES: Final[int] = 512 * 1024 * 1024
_CHUNK_BYTES: Final[int] = 1024 * 1024


class VerifiedReaderError(ArtifactStoreError):
    """Stable, path-free failure at the verified reader boundary."""

    _DEFAULT_MESSAGE = "verified artifact read failed"


@dataclass(frozen=True, slots=True)
class _ReaderIdentity:
    device: int
    inode: int
    links: int
    size: int
    digest: str
    mtime_ns: int
    ctime_ns: int


def _failure() -> VerifiedReaderError:
    return VerifiedReaderError()


def _normalize_path(value: RelativeArtifactPath | str) -> RelativeArtifactPath:
    if isinstance(value, RelativeArtifactPath):
        return value
    if type(value) is not str:
        raise _failure()
    try:
        return RelativeArtifactPath(value)
    except (TypeError, ValueError) as error:
        raise _failure() from error


def _normalize_sha256(value: Sha256 | str) -> Sha256:
    try:
        return value if isinstance(value, Sha256) else Sha256(value)
    except (TypeError, ValueError) as error:
        raise _failure() from error


def _normalize_byte_size(value: object, max_artifact_bytes: int) -> int:
    if type(value) is not int or value <= 0 or value > max_artifact_bytes:
        raise _failure()
    return value


def _normalize_media_type(value: object) -> str:
    if type(value) is not str:
        raise _failure()
    normalized = value.strip()
    if not normalized or any(
        ord(character) < 32 or ord(character) == 127 for character in normalized
    ):
        raise _failure()
    return normalized


def _scan_descriptor(
    descriptor: int,
    *,
    max_artifact_bytes: int,
) -> _ReaderIdentity:
    """Hash a descriptor while checking that its inode remains stable."""

    try:
        initial = os.fstat(descriptor)
        if not stat.S_ISREG(initial.st_mode) or initial.st_nlink != 1:
            raise _failure()
        os.lseek(descriptor, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = os.read(descriptor, _CHUNK_BYTES)
            if not chunk:
                break
            size += len(chunk)
            if size > max_artifact_bytes:
                raise _failure()
            digest.update(chunk)
        final = os.fstat(descriptor)
        if (
            (initial.st_dev, initial.st_ino, initial.st_nlink, initial.st_size)
            != (final.st_dev, final.st_ino, final.st_nlink, final.st_size)
            or final.st_nlink != 1
            or size != final.st_size
        ):
            raise _failure()
        return _ReaderIdentity(
            device=final.st_dev,
            inode=final.st_ino,
            links=final.st_nlink,
            size=size,
            digest=digest.hexdigest(),
            mtime_ns=final.st_mtime_ns,
            ctime_ns=final.st_ctime_ns,
        )
    except VerifiedReaderError:
        raise
    except OSError as error:
        raise _failure() from error


def _matches(
    identity: _ReaderIdentity,
    expected_sha256: Sha256,
    expected_size: int,
) -> bool:
    return identity.size == expected_size and identity.digest == expected_sha256.root


def _same_named_object(left: _ReaderIdentity, right: _ReaderIdentity) -> bool:
    """Compare the metadata that can change without changing a file path."""

    return (
        left.device,
        left.inode,
        left.links,
        left.size,
        left.mtime_ns,
        left.ctime_ns,
    ) == (
        right.device,
        right.inode,
        right.links,
        right.size,
        right.mtime_ns,
        right.ctime_ns,
    )


def _scan_metadata(
    descriptor: int,
) -> _ReaderIdentity:
    """Read only file metadata for a short commit-time identity check.

    The complete SHA-256 scan is intentionally separate in
    :func:`_scan_descriptor`.  Registration can therefore recheck the
    descriptor and its named object while SQLite is open without putting a
    large-file read in the SQLite transaction.
    """

    try:
        initial = os.fstat(descriptor)
        if not stat.S_ISREG(initial.st_mode) or initial.st_nlink != 1:
            raise _failure()
        final = os.fstat(descriptor)
        if (initial.st_dev, initial.st_ino, initial.st_nlink, initial.st_size) != (
            final.st_dev,
            final.st_ino,
            final.st_nlink,
            final.st_size,
        ) or final.st_nlink != 1:
            raise _failure()
        return _ReaderIdentity(
            device=final.st_dev,
            inode=final.st_ino,
            links=final.st_nlink,
            size=final.st_size,
            digest="",
            mtime_ns=final.st_mtime_ns,
            ctime_ns=final.st_ctime_ns,
        )
    except VerifiedReaderError:
        raise
    except OSError as error:
        raise _failure() from error


def _publication(
    reference: ArtifactReference,
    root: StorageRoot,
) -> _ArtifactPublication:
    """Return the store-issued binding or reject a hand-built reference."""

    binding = getattr(reference, "_publication", None)
    if not isinstance(binding, _ArtifactPublication) or binding.root_identity != id(root):
        raise _failure()
    if (
        binding.path != reference.path
        or binding.sha256 != reference.sha256
        or binding.byte_size != reference.byte_size
        or binding.media_type != reference.media_type
    ):
        raise _failure()
    try:
        canonical = content_addressed_reference(reference.sha256, reference.byte_size)
    except (StoragePathError, TypeError, ValueError) as error:
        raise _failure() from error
    if reference.path != canonical or binding.path != canonical:
        raise _failure()
    return binding


_LEASE_CREATION_TOKEN: Final[object] = object()


class VerifiedArtifactLease(AbstractContextManager["VerifiedArtifactLease"]):
    """A short-lived capability for registering one verified artifact.

    A lease can only be made by :meth:`VerifiedReader.acquire`.  In
    particular, a caller cannot obtain one from a hand-built
    :class:`ArtifactReference`, from a relative path, or from independently
    supplied hash/size/media scalars.  The initial scan happens before any
    SQLite transaction.  Registration then uses :meth:`verify_registration`
    for a metadata-only check of both the named object and the descriptor
    retained by this lease.
    """

    __slots__ = (
        "_reader",
        "_path",
        "_expected_sha256",
        "_expected_size",
        "_media_type",
        "_initial",
        "_descriptor",
        "_publication",
        "_entered",
        "_closed",
    )

    def __init__(
        self,
        token: object,
        reader: VerifiedReader,
        reference: ArtifactReference,
        initial: _ReaderIdentity,
        descriptor: int,
        publication: _ArtifactPublication,
    ) -> None:
        if token is not _LEASE_CREATION_TOKEN:
            raise _failure()
        self._reader = reader
        self._path = reference.path
        self._expected_sha256 = reference.sha256
        self._expected_size = reference.byte_size
        self._media_type = reference.media_type
        self._initial = initial
        self._descriptor = descriptor
        self._publication = publication
        self._entered = False
        self._closed = False

    @property
    def path(self) -> RelativeArtifactPath:
        self._ensure_open()
        return self._path

    @property
    def sha256(self) -> Sha256:
        self._ensure_open()
        return self._expected_sha256

    @property
    def byte_size(self) -> int:
        self._ensure_open()
        return self._expected_size

    @property
    def media_type(self) -> str:
        self._ensure_open()
        return self._media_type

    @property
    def initial_identity(self) -> tuple[int, int, int, int]:
        """Expose only non-sensitive technical identity for diagnostics."""

        self._ensure_open()
        return (
            self._initial.device,
            self._initial.inode,
            self._initial.links,
            self._initial.size,
        )

    def _ensure_open(self) -> None:
        if self._closed or self._descriptor < 0:
            raise _failure()

    def prepare_registration(self) -> None:
        """Rehash the named object immediately before SQLite registration.

        This is deliberately called by the SQLite helper before ``BEGIN``.
        It closes the gap between lease acquisition and registration while
        keeping the potentially large hash scan outside the database
        transaction.
        """

        self._ensure_open()
        try:
            with self._reader._root.open_relative(self._path, kind="file") as descriptor:
                current = _scan_descriptor(
                    descriptor,
                    max_artifact_bytes=self._reader.max_artifact_bytes,
                )
        except VerifiedReaderError:
            raise
        except (OSError, StoragePathError, TypeError, ValueError) as error:
            raise _failure() from error
        if not _same_named_object(current, self._initial) or not _matches(
            current,
            self._expected_sha256,
            self._expected_size,
        ):
            raise _failure()

    def verify_registration(self) -> None:
        """Recheck the named object and held descriptor before commit.

        This check intentionally performs no byte scan.  The complete hash
        was calculated by :meth:`prepare_registration` before SQLite began;
        object identity, size and timestamps are checked against that
        verified digest while the transaction is still short.
        """

        self._ensure_open()
        try:
            with self._reader._root.open_relative(self._path, kind="file") as descriptor:
                current = _scan_metadata(descriptor)
            held_metadata = _scan_metadata(self._descriptor)
        except VerifiedReaderError:
            raise
        except (OSError, StoragePathError, TypeError, ValueError) as error:
            raise _failure() from error
        if (
            not _same_named_object(current, self._initial)
            or not _same_named_object(held_metadata, self._initial)
            or current.size != self._expected_size
            or self._initial.digest != self._expected_sha256.root
        ):
            raise _failure()

    def __enter__(self) -> VerifiedArtifactLease:
        self._ensure_open()
        if self._entered:
            raise _failure()
        self._entered = True
        return self

    def close(self) -> None:
        if self._closed:
            return
        descriptor = self._descriptor
        self._descriptor = -1
        self._closed = True
        try:
            os.close(descriptor)
        except OSError as error:
            raise _failure() from error

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool:
        self.close()
        return False

    def __del__(self) -> None:  # pragma: no cover - interpreter/GC fallback.
        try:
            if not self._closed and self._descriptor >= 0:
                os.close(self._descriptor)
                self._descriptor = -1
                self._closed = True
        except Exception:
            pass


class _VerifiedReadContext(AbstractContextManager[BinaryIO]):
    """Own the duplicate descriptor returned by :class:`VerifiedReader`."""

    __slots__ = (
        "_reader",
        "_path",
        "_expected_sha256",
        "_expected_size",
        "_initial",
        "_stream",
        "_entered",
        "_closed",
    )

    def __init__(
        self,
        reader: VerifiedReader,
        path: RelativeArtifactPath,
        expected_sha256: Sha256,
        expected_size: int,
        initial: _ReaderIdentity,
        stream: BinaryIO,
    ) -> None:
        self._reader = reader
        self._path = path
        self._expected_sha256 = expected_sha256
        self._expected_size = expected_size
        self._initial = initial
        self._stream = stream
        self._entered = False
        self._closed = False

    def __enter__(self) -> BinaryIO:
        if self._closed or self._entered:
            raise _failure()
        self._entered = True
        return self._stream

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool:
        if self._closed:
            return False
        try:
            self._stream.close()
        except Exception as error:
            self._closed = True
            raise _failure() from error
        self._closed = True
        self._reader._verify_after_read(
            self._path,
            self._expected_sha256,
            self._expected_size,
            self._initial,
        )
        return False

    def __del__(self) -> None:  # pragma: no cover - interpreter/GC fallback.
        try:
            if not self._closed:
                self._stream.close()
                self._closed = True
        except Exception:
            pass


class VerifiedReader:
    """Read one immutable artifact through a verified binary stream."""

    __slots__ = ("_root", "_max_artifact_bytes")

    def __init__(
        self,
        root: StorageRoot,
        *,
        max_artifact_bytes: int = _DEFAULT_MAX_ARTIFACT_BYTES,
    ) -> None:
        if not isinstance(root, StorageRoot):
            raise _failure()
        if type(max_artifact_bytes) is not int or max_artifact_bytes <= 0:
            raise _failure()
        self._root = root
        self._max_artifact_bytes = max_artifact_bytes

    @property
    def max_artifact_bytes(self) -> int:
        return self._max_artifact_bytes

    def _prepare(
        self,
        reference: ArtifactReference | RelativeArtifactPath | str,
        *,
        sha256: Sha256 | str | None,
        byte_size: int | None,
        media_type: str | None,
    ) -> tuple[RelativeArtifactPath, Sha256, int, str]:
        if isinstance(reference, ArtifactReference):
            path = reference.path
            expected_sha256 = _normalize_sha256(reference.sha256)
            expected_size = _normalize_byte_size(
                reference.byte_size,
                self._max_artifact_bytes,
            )
            expected_media_type = _normalize_media_type(reference.media_type)
            if sha256 is not None and _normalize_sha256(sha256) != expected_sha256:
                raise _failure()
            if (
                byte_size is not None
                and _normalize_byte_size(
                    byte_size,
                    self._max_artifact_bytes,
                )
                != expected_size
            ):
                raise _failure()
            if media_type is not None and _normalize_media_type(media_type) != expected_media_type:
                raise _failure()
            return path, expected_sha256, expected_size, expected_media_type

        path = _normalize_path(reference)
        if sha256 is None or byte_size is None or media_type is None:
            raise _failure()
        expected_sha256 = _normalize_sha256(sha256)
        expected_size = _normalize_byte_size(byte_size, self._max_artifact_bytes)
        expected_media_type = _normalize_media_type(media_type)
        return path, expected_sha256, expected_size, expected_media_type

    def open(
        self,
        reference: ArtifactReference | RelativeArtifactPath | str,
        *,
        sha256: Sha256 | str | None = None,
        byte_size: int | None = None,
        media_type: str | None = None,
    ) -> AbstractContextManager[BinaryIO]:
        """Return a context-managed stream after eager identity verification.

        Argument and target validation intentionally happen when ``open`` is
        called.  This keeps malformed or unsafe references from being hidden
        until a caller happens to enter the returned context manager.
        """

        path, expected_sha256, expected_size, _ = self._prepare(
            reference,
            sha256=sha256,
            byte_size=byte_size,
            media_type=media_type,
        )
        duplicate = -1
        try:
            with self._root.open_relative(path, kind="file") as descriptor:
                initial = _scan_descriptor(
                    descriptor,
                    max_artifact_bytes=self._max_artifact_bytes,
                )
                if not _matches(initial, expected_sha256, expected_size):
                    raise _failure()
                os.lseek(descriptor, 0, os.SEEK_SET)
                duplicate = os.dup(descriptor)
            try:
                stream = cast(BinaryIO, os.fdopen(duplicate, "rb"))
            except (OSError, ValueError) as error:
                os.close(duplicate)
                duplicate = -1
                raise _failure() from error
        except VerifiedReaderError:
            if duplicate >= 0:
                try:
                    os.close(duplicate)
                except OSError:
                    pass
            raise
        except (OSError, StoragePathError, TypeError, ValueError) as error:
            if duplicate >= 0:
                try:
                    os.close(duplicate)
                except OSError:
                    pass
            raise _failure() from error
        return _VerifiedReadContext(
            self,
            path,
            expected_sha256,
            expected_size,
            initial,
            stream,
        )

    def acquire(self, reference: ArtifactReference) -> VerifiedArtifactLease:
        """Acquire a verified registration lease for a published object.

        Unlike :meth:`open`, this method does not accept raw paths or scalar
        expectations.  The reference must carry the private publication
        binding produced by :class:`ArtifactStore`, and the reader must be
        attached to the same bound :class:`StorageRoot` instance.  The
        complete descriptor hash is performed before the lease is returned.
        """

        if not isinstance(reference, ArtifactReference):
            raise _failure()
        binding = _publication(reference, self._root)
        duplicate = -1
        try:
            with self._root.open_relative(reference.path, kind="file") as descriptor:
                initial = _scan_descriptor(
                    descriptor,
                    max_artifact_bytes=self._max_artifact_bytes,
                )
                if not _matches(initial, reference.sha256, reference.byte_size):
                    raise _failure()
                os.lseek(descriptor, 0, os.SEEK_SET)
                duplicate = os.dup(descriptor)
        except VerifiedReaderError:
            if duplicate >= 0:
                try:
                    os.close(duplicate)
                except OSError:
                    pass
            raise
        except (OSError, StoragePathError, TypeError, ValueError) as error:
            if duplicate >= 0:
                try:
                    os.close(duplicate)
                except OSError:
                    pass
            raise _failure() from error
        return VerifiedArtifactLease(
            _LEASE_CREATION_TOKEN,
            self,
            reference,
            initial,
            duplicate,
            binding,
        )

    def lease(self, reference: ArtifactReference) -> VerifiedArtifactLease:
        """Alias for :meth:`acquire` used by registration call sites."""

        return self.acquire(reference)

    def _verify_after_read(
        self,
        path: RelativeArtifactPath,
        expected_sha256: Sha256,
        expected_size: int,
        initial: _ReaderIdentity,
    ) -> None:
        try:
            with self._root.open_relative(path, kind="file") as descriptor:
                current = _scan_descriptor(
                    descriptor,
                    max_artifact_bytes=self._max_artifact_bytes,
                )
        except VerifiedReaderError:
            raise
        except (OSError, StoragePathError, TypeError, ValueError) as error:
            raise _failure() from error
        if (current.device, current.inode, current.links) != (
            initial.device,
            initial.inode,
            initial.links,
        ) or not _matches(current, expected_sha256, expected_size):
            raise _failure()


__all__ = ["VerifiedArtifactLease", "VerifiedReader", "VerifiedReaderError"]
