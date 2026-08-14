"""Immutable, content-addressed artifact publication.

This module owns only byte transport and filesystem integrity.  It does not
inspect a media type, parse a document, or decide which business object owns
an artifact.  Callers provide the expected hash, size, and media descriptor.
"""

from __future__ import annotations

import hashlib
import os
import stat
import time
from collections.abc import Iterable
from contextlib import suppress
from dataclasses import dataclass, field
from typing import BinaryIO, Callable, Final, Protocol, TypeAlias

from sciretriever.model.primitives import RelativeArtifactPath, Sha256

from .paths import StoragePathError, StorageRoot, _quarantine_unlink, content_addressed_reference
from .staging import StagingFile, StagingIdentity, create_staging

_DEFAULT_MAX_ARTIFACT_BYTES: Final[int] = 512 * 1024 * 1024
_CHUNK_BYTES: Final[int] = 1024 * 1024
_EXISTING_RETRY_ATTEMPTS: Final[int] = 32
_EXISTING_RETRY_DELAY_SECONDS: Final[float] = 0.001
_READ_FLAGS: Final[int] = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)


class ReadableSource(Protocol):
    def read(self, size: int = -1, /) -> bytes: ...


ArtifactSource: TypeAlias = bytes | bytearray | memoryview | BinaryIO | StagingFile
Checkpoint: TypeAlias = Callable[[str], None]


class ArtifactStoreError(RuntimeError):
    """Stable, path-free failure at the artifact filesystem boundary."""

    _DEFAULT_MESSAGE = "artifact store operation failed"

    def __init__(self, _message: object | None = None) -> None:
        # The optional argument is intentionally ignored.  A caller or an
        # underlying exception must not be able to put paths, secrets, or
        # arbitrary diagnostics into this boundary exception's text.
        super().__init__(self._DEFAULT_MESSAGE)


class ArtifactIntegrityError(ArtifactStoreError):
    """The supplied bytes do not satisfy the caller's expected identity."""

    _DEFAULT_MESSAGE = "artifact bytes do not match expected identity"


class ArtifactConflictError(ArtifactStoreError):
    """An existing formal object is unsafe or differs at the target address."""

    _DEFAULT_MESSAGE = "artifact target conflicts with existing object"


@dataclass(frozen=True, slots=True)
class _ArtifactPublication:
    """Opaque proof that an artifact reference came from this store.

    ``ArtifactReference`` deliberately remains a useful neutral value for
    readers and query projections.  It is not, by itself, an authority to
    create a catalog row, though: a caller can construct one by hand.  The
    private publication binding is attached only after :meth:`publish`
    successfully creates or reuses the formal content-addressed object.  A
    verified-reader registration lease checks this binding before it exposes
    the technical identity to SQLite.

    The storage root is retained by object identity rather than as a path.
    Only that object's process-local identity is recorded here.  This keeps
    the capability tied to the root that performed publication and avoids
    putting an absolute path in any public value or error.
    """

    root_identity: int = field(compare=False)
    path: RelativeArtifactPath
    sha256: Sha256
    byte_size: int
    media_type: str


@dataclass(frozen=True, slots=True)
class ArtifactReference:
    """A neutral, immutable descriptor for one formally published object."""

    path: RelativeArtifactPath
    sha256: Sha256
    byte_size: int
    media_type: str
    _publication: _ArtifactPublication | None = field(
        default=None,
        repr=False,
        compare=False,
        init=False,
    )

    def __post_init__(self) -> None:
        if not isinstance(self.path, RelativeArtifactPath) or not isinstance(self.sha256, Sha256):
            raise ArtifactIntegrityError()
        if type(self.byte_size) is not int or self.byte_size <= 0:
            raise ArtifactIntegrityError()
        if type(self.media_type) is not str:
            raise ArtifactIntegrityError()
        media_type = self.media_type.strip()
        if not media_type or any(
            ord(character) < 32 or ord(character) == 127 for character in media_type
        ):
            raise ArtifactIntegrityError()
        object.__setattr__(self, "media_type", media_type)

    def __str__(self) -> str:
        return str(self.path)


@dataclass(frozen=True, slots=True)
class _VerifiedIdentity:
    device: int
    inode: int
    links: int
    size: int
    digest: str


def _integrity_failure() -> ArtifactIntegrityError:
    return ArtifactIntegrityError()


def _conflict_failure() -> ArtifactConflictError:
    return ArtifactConflictError()


def _normalise_expected(
    sha256: Sha256 | str,
    byte_size: int,
    media_type: str,
    max_artifact_bytes: int,
) -> tuple[Sha256, int, str, RelativeArtifactPath]:
    try:
        expected_sha256 = sha256 if isinstance(sha256, Sha256) else Sha256(sha256)
    except (TypeError, ValueError) as error:
        raise _integrity_failure() from error
    if type(byte_size) is not int or byte_size <= 0 or byte_size > max_artifact_bytes:
        raise _integrity_failure()
    if type(media_type) is not str:
        raise _integrity_failure()
    normalized_media_type = media_type.strip()
    if not normalized_media_type or any(
        ord(character) < 32 or ord(character) == 127 for character in normalized_media_type
    ):
        raise _integrity_failure()
    try:
        reference = content_addressed_reference(expected_sha256, byte_size)
    except (StoragePathError, TypeError, ValueError) as error:
        raise _integrity_failure() from error
    return expected_sha256, byte_size, normalized_media_type, reference


def _scan_descriptor(descriptor: int, max_artifact_bytes: int) -> _VerifiedIdentity:
    try:
        initial = os.fstat(descriptor)
        if not stat.S_ISREG(initial.st_mode) or initial.st_nlink != 1:
            raise _conflict_failure()
        os.lseek(descriptor, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = os.read(descriptor, _CHUNK_BYTES)
            if not chunk:
                break
            size += len(chunk)
            if size > max_artifact_bytes:
                raise _integrity_failure()
            digest.update(chunk)
        final = os.fstat(descriptor)
        if (
            (initial.st_dev, initial.st_ino, initial.st_nlink, initial.st_size)
            != (final.st_dev, final.st_ino, final.st_nlink, final.st_size)
            or final.st_nlink != 1
            or size != final.st_size
        ):
            raise _conflict_failure()
        return _VerifiedIdentity(
            device=final.st_dev,
            inode=final.st_ino,
            links=final.st_nlink,
            size=size,
            digest=digest.hexdigest(),
        )
    except (ArtifactStoreError, OSError) as error:
        if isinstance(error, ArtifactStoreError):
            raise
        raise ArtifactIntegrityError() from error


def _write_chunk(stage: StagingFile, chunk: object, total: int, limit: int) -> int:
    if not isinstance(chunk, (bytes, bytearray, memoryview)):
        raise _integrity_failure()
    try:
        payload = bytes(chunk)
    except (TypeError, ValueError) as error:
        raise _integrity_failure() from error
    next_total = total + len(payload)
    if next_total > limit:
        raise _integrity_failure()
    if payload:
        try:
            stage.write(payload)
        except Exception as error:
            if isinstance(error, ArtifactStoreError):
                raise
            raise _integrity_failure() from error
    return next_total


def _copy_staging_source(stage: StagingFile, source: StagingFile, limit: int) -> int:
    total = 0
    try:
        with source.open() as descriptor:
            os.lseek(descriptor, 0, os.SEEK_SET)
            while True:
                chunk = os.read(descriptor, _CHUNK_BYTES)
                if not chunk:
                    break
                total = _write_chunk(stage, chunk, total, limit)
        return total
    except (ArtifactStoreError, OSError) as error:
        if isinstance(error, ArtifactStoreError):
            raise
        raise _integrity_failure() from error


def _copy_readable_source(stage: StagingFile, reader: Callable[[int], object], limit: int) -> int:
    total = 0
    try:
        while True:
            chunk = reader(_CHUNK_BYTES)
            if chunk == b"":
                break
            total = _write_chunk(stage, chunk, total, limit)
        return total
    except (ArtifactStoreError, OSError, TypeError) as error:
        if isinstance(error, ArtifactStoreError):
            raise
        raise _integrity_failure() from error


def _copy_iterable_source(stage: StagingFile, source: Iterable[object], limit: int) -> int:
    total = 0
    try:
        for chunk in source:
            total = _write_chunk(stage, chunk, total, limit)
        return total
    except (ArtifactStoreError, OSError, TypeError) as error:
        if isinstance(error, ArtifactStoreError):
            raise
        raise _integrity_failure() from error


def _copy_source(stage: StagingFile, source: ArtifactSource, limit: int) -> int:
    if isinstance(source, (bytes, bytearray, memoryview)):
        return _write_chunk(stage, source, 0, limit)
    if isinstance(source, StagingFile):
        return _copy_staging_source(stage, source, limit)
    reader = getattr(source, "read", None)
    if callable(reader):
        return _copy_readable_source(stage, reader, limit)
    if isinstance(source, Iterable):
        return _copy_iterable_source(stage, source, limit)
    raise _integrity_failure()


def _checkpoint(callback: Checkpoint | None, name: str) -> None:
    if callback is None:
        return
    try:
        callback(name)
    except ArtifactStoreError:
        raise
    except Exception as error:
        raise ArtifactStoreError() from error


def _stage_name(reference: RelativeArtifactPath) -> str:
    components = reference.root.split("/")
    if len(components) != 2 or components[0] != ".staging":
        raise ArtifactStoreError()
    return components[1]


def _target_directory(reference: RelativeArtifactPath) -> RelativeArtifactPath:
    components = reference.root.split("/")
    if len(components) != 3 or components[0] != ".objects":
        raise ArtifactStoreError()
    return RelativeArtifactPath("/".join(components[:2]))


def _validate_linked_stage_metadata(
    metadata: os.stat_result,
    stage_identity: StagingIdentity,
) -> None:
    if (
        not stat.S_ISREG(metadata.st_mode)
        or (metadata.st_dev, metadata.st_ino) != (stage_identity.device, stage_identity.inode)
        or metadata.st_nlink != 2
    ):
        raise _conflict_failure()


class ArtifactStore:
    """Publish immutable bytes to a private content-addressed root."""

    __slots__ = ("_root", "_max_artifact_bytes")

    def __init__(
        self, root: StorageRoot, *, max_artifact_bytes: int = _DEFAULT_MAX_ARTIFACT_BYTES
    ) -> None:
        if not isinstance(root, StorageRoot):
            raise ArtifactStoreError()
        if type(max_artifact_bytes) is not int or max_artifact_bytes <= 0:
            raise ArtifactIntegrityError()
        self._root = root
        self._max_artifact_bytes = max_artifact_bytes

    @property
    def max_artifact_bytes(self) -> int:
        return self._max_artifact_bytes

    def _verify_staged(
        self,
        stage: StagingFile,
        expected_sha256: Sha256,
        expected_size: int,
    ) -> StagingIdentity:
        try:
            with stage.open() as descriptor:
                identity = _scan_descriptor(descriptor, self._max_artifact_bytes)
        except ArtifactStoreError:
            raise
        except OSError as error:
            raise _integrity_failure() from error
        if identity.size != expected_size or identity.digest != expected_sha256.root:
            raise _integrity_failure()
        return stage.identity()

    def _discard_handoff(self, stage: StagingFile) -> None:
        try:
            stage.discard()
        except Exception as error:
            if isinstance(error, ArtifactStoreError):
                raise
            raise ArtifactStoreError() from error

    def _unlink_linked_stage(
        self,
        stage_reference: RelativeArtifactPath,
        stage_identity: StagingIdentity,
    ) -> None:
        name = _stage_name(stage_reference)
        try:
            with self._root.open_directory(".staging") as directory:
                descriptor = os.open(name, _READ_FLAGS, dir_fd=directory)
                try:
                    metadata = os.fstat(descriptor)
                    _validate_linked_stage_metadata(metadata, stage_identity)
                    _quarantine_unlink(
                        directory,
                        name,
                        descriptor,
                        lambda moved: _validate_linked_stage_metadata(moved, stage_identity),
                    )
                finally:
                    try:
                        os.close(descriptor)
                    except OSError:
                        pass
        except ArtifactStoreError:
            raise
        except StoragePathError as error:
            raise _conflict_failure() from error
        except OSError as error:
            raise ArtifactStoreError() from error

    def _verify_existing(
        self,
        reference: RelativeArtifactPath,
        expected_sha256: Sha256,
        expected_size: int,
    ) -> None:
        try:
            with self._root.open_relative(reference, kind="file") as descriptor:
                identity = _scan_descriptor(descriptor, self._max_artifact_bytes)
        except (StoragePathError, ArtifactStoreError) as error:
            if isinstance(error, ArtifactStoreError):
                raise _conflict_failure() from error
            raise _conflict_failure() from error
        if identity.size != expected_size or identity.digest != expected_sha256.root:
            raise _conflict_failure()

    def _verify_existing_with_retry(
        self,
        reference: RelativeArtifactPath,
        expected_sha256: Sha256,
        expected_size: int,
    ) -> None:
        """Allow a concurrent publisher to finish unlinking its stage link."""

        for attempt in range(_EXISTING_RETRY_ATTEMPTS):
            try:
                self._verify_existing(reference, expected_sha256, expected_size)
                return
            except ArtifactConflictError:
                if attempt + 1 == _EXISTING_RETRY_ATTEMPTS:
                    raise
                time.sleep(_EXISTING_RETRY_DELAY_SECONDS)

    def _publish_handoff(
        self,
        stage_reference: RelativeArtifactPath,
        stage_identity: StagingIdentity,
        target_reference: RelativeArtifactPath,
        expected_sha256: Sha256,
        expected_size: int,
        checkpoint: Checkpoint | None,
    ) -> bool:
        """Publish a handed-off stage and report whether it created the target."""

        self._root.ensure_directory(".objects")
        target_directory = _target_directory(target_reference)
        self._root.ensure_directory(target_directory)
        stage_name = _stage_name(stage_reference)
        target_name = target_reference.root.rsplit("/", 1)[-1]
        target_linked = False
        try:
            with self._root.open_directory(".staging") as staging_directory:
                with self._root.open_directory(".objects") as objects_directory:
                    with self._root.open_directory(target_directory) as target_directory_fd:
                        try:
                            os.link(
                                stage_name,
                                target_name,
                                src_dir_fd=staging_directory,
                                dst_dir_fd=target_directory_fd,
                                follow_symlinks=False,
                            )
                            target_linked = True
                        except FileExistsError:
                            pass
                        except OSError as error:
                            raise ArtifactStoreError() from error
                        if target_linked:
                            self._unlink_linked_stage(stage_reference, stage_identity)
                            _checkpoint(checkpoint, "after-publish")
                            _checkpoint(checkpoint, "before-directory-fsync")
                            try:
                                os.fsync(target_directory_fd)
                                os.fsync(objects_directory)
                            except OSError as error:
                                raise ArtifactStoreError() from error
                            _checkpoint(checkpoint, "after-directory-fsync")
                            _checkpoint(checkpoint, "after-cleanup")
                            return True
            self._verify_existing_with_retry(
                target_reference,
                expected_sha256,
                expected_size,
            )
            return False
        except ArtifactConflictError:
            raise
        except ArtifactStoreError:
            raise
        except (StoragePathError, OSError) as error:
            raise ArtifactStoreError() from error

    def publish(
        self,
        source: ArtifactSource,
        *,
        sha256: Sha256 | str,
        byte_size: int,
        media_type: str,
        checkpoint: Checkpoint | None = None,
    ) -> ArtifactReference:
        """Copy, verify, and create-if-absent publish one immutable byte object."""

        expected_sha256, expected_size, normalized_media_type, target_reference = (
            _normalise_expected(
                sha256,
                byte_size,
                media_type,
                self._max_artifact_bytes,
            )
        )
        stage = create_staging(self._root)
        stage_reference: RelativeArtifactPath | None = None
        stage_identity: StagingIdentity | None = None
        handoff = False
        published = False
        try:
            total = _copy_source(stage, source, self._max_artifact_bytes)
            if total != expected_size:
                raise _integrity_failure()
            stage.flush()
            _checkpoint(checkpoint, "after-stage-fsync")
            stage_identity = self._verify_staged(stage, expected_sha256, expected_size)
            stage_reference = stage.handoff()
            handoff = True
            stage.close()
            published = self._publish_handoff(
                stage_reference,
                stage_identity,
                target_reference,
                expected_sha256,
                expected_size,
                checkpoint,
            )
            reference = ArtifactReference(
                path=target_reference,
                sha256=expected_sha256,
                byte_size=expected_size,
                media_type=normalized_media_type,
            )
            object.__setattr__(
                reference,
                "_publication",
                _ArtifactPublication(
                    root_identity=id(self._root),
                    path=target_reference,
                    sha256=expected_sha256,
                    byte_size=expected_size,
                    media_type=normalized_media_type,
                ),
            )
            return reference
        except (ArtifactIntegrityError, ArtifactConflictError):
            raise
        except ArtifactStoreError:
            raise
        except (OSError, StoragePathError, TypeError, ValueError) as error:
            raise ArtifactStoreError() from error
        finally:
            if not handoff:
                with suppress(Exception):
                    stage.close()
            elif not published:
                # The target was not linked, so the handed-off temporary can
                # still be safely discarded.  If a link was made but source
                # cleanup failed, preserve both pieces as conflict evidence.
                with suppress(Exception):
                    self._discard_handoff(stage)


__all__ = [
    "ArtifactConflictError",
    "ArtifactIntegrityError",
    "ArtifactReference",
    "ArtifactSource",
    "ArtifactStore",
    "ArtifactStoreError",
]
