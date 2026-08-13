"""Fail-closed reconciliation of formal content-addressed objects.

The reconciler holds the same non-blocking catalog write lock used by every
publication operation.  It first validates the complete Catalog/``.objects``
view without mutation.  For a row-backed orphan it then removes the exact
unreferenced technical row in a short transaction *before* unlinking bytes.
Consequently, a crash at the cross-medium boundary can leave only a retryable
filesystem-only orphan; it can never create a committed row that points to a
missing file.
"""

from __future__ import annotations

import hashlib
import os
import re
import stat
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, TypeAlias

from sciretriever.model.primitives import RelativeArtifactPath, Sha256
from sciretriever.storage.locking import CatalogLockError, CatalogWriteLock
from sciretriever.storage.sqlite.artifact_references import (
    ArtifactReferenceStoreError,
    CatalogArtifactObject,
    SqliteArtifactReferenceStore,
)

from .paths import (
    StoragePathError,
    StorageRoot,
    _quarantine_unlink,
    content_addressed_reference,
)

_OBJECTS_DIRECTORY: Final[str] = ".objects"
_HEX_PREFIX = re.compile(r"^[0-9a-f]{2}$", re.ASCII)
_OBJECT_NAME = re.compile(r"^(?P<sha256>[0-9a-f]{64})-(?P<byte_size>[1-9][0-9]*)$", re.ASCII)
_CHUNK_BYTES: Final[int] = 1024 * 1024
_DEFAULT_MAX_ARTIFACT_BYTES: Final[int] = 512 * 1024 * 1024
_READ_FLAGS: Final[int] = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_NONBLOCK", 0)
)

Checkpoint: TypeAlias = Callable[[str], None]


class ArtifactReconciliationError(RuntimeError):
    """Stable, path-free failure that preserves reconciliation evidence."""

    _MESSAGE = "artifact store reconciliation failed"

    def __init__(self, _message: object | None = None) -> None:
        del _message
        super().__init__(self._MESSAGE)


class ArtifactReconciliationIntegrityError(ArtifactReconciliationError):
    """Catalog or formal object identity failed closed validation."""

    _MESSAGE = "artifact store reconciliation integrity check failed"


@dataclass(frozen=True, slots=True)
class ReconciliationResult:
    """Paths removed or intentionally retained in one completed pass."""

    deleted: tuple[RelativeArtifactPath, ...]
    preserved: tuple[RelativeArtifactPath, ...]


@dataclass(frozen=True, slots=True)
class _FileIdentity:
    device: int
    inode: int
    size: int
    mtime_ns: int
    ctime_ns: int


@dataclass(frozen=True, slots=True)
class _FormalObject:
    path: RelativeArtifactPath
    sha256: Sha256
    byte_size: int
    identity: _FileIdentity


def _failure() -> ArtifactReconciliationError:
    return ArtifactReconciliationError()


def _integrity_failure() -> ArtifactReconciliationIntegrityError:
    return ArtifactReconciliationIntegrityError()


def _checkpoint(callback: Checkpoint | None, name: str) -> None:
    if callback is None:
        return
    try:
        callback(name)
    except ArtifactReconciliationError:
        raise
    except Exception as error:
        raise _failure() from error


def _directory_metadata(metadata: os.stat_result, root: StorageRoot) -> None:
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != root.owner
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        raise _integrity_failure()


def _entry_metadata(metadata: os.stat_result, root: StorageRoot) -> None:
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != root.owner
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink != 1
    ):
        raise _integrity_failure()


def _identity(metadata: os.stat_result) -> _FileIdentity:
    return _FileIdentity(
        device=metadata.st_dev,
        inode=metadata.st_ino,
        size=metadata.st_size,
        mtime_ns=metadata.st_mtime_ns,
        ctime_ns=metadata.st_ctime_ns,
    )


def _same_identity(left: _FileIdentity, right: _FileIdentity) -> bool:
    return left == right


def _parse_object_path(prefix: str, name: str) -> tuple[RelativeArtifactPath, Sha256, int]:
    if _HEX_PREFIX.fullmatch(prefix) is None:
        raise _integrity_failure()
    match = _OBJECT_NAME.fullmatch(name)
    if match is None:
        raise _integrity_failure()
    try:
        digest = Sha256(match.group("sha256"))
        byte_size = int(match.group("byte_size"))
        path = RelativeArtifactPath(f"{_OBJECTS_DIRECTORY}/{prefix}/{name}")
        canonical = content_addressed_reference(digest, byte_size)
    except (StoragePathError, TypeError, ValueError) as error:
        raise _integrity_failure() from error
    if path != canonical or digest.root[:2] != prefix:
        raise _integrity_failure()
    return path, digest, byte_size


def _scan_descriptor(
    descriptor: int,
    *,
    root: StorageRoot,
    expected_sha256: Sha256,
    expected_size: int,
    max_artifact_bytes: int,
) -> _FileIdentity:
    try:
        initial = os.fstat(descriptor)
        _entry_metadata(initial, root)
        if initial.st_size != expected_size or initial.st_size > max_artifact_bytes:
            raise _integrity_failure()
        os.lseek(descriptor, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(descriptor, _CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > max_artifact_bytes:
                raise _integrity_failure()
            digest.update(chunk)
        final = os.fstat(descriptor)
        _entry_metadata(final, root)
        if (
            _identity(initial) != _identity(final)
            or total != expected_size
            or final.st_size != expected_size
            or digest.hexdigest() != expected_sha256.root
        ):
            raise _integrity_failure()
        return _identity(final)
    except ArtifactReconciliationError:
        raise
    except OSError as error:
        raise _failure() from error


def _objects_directory_exists(root: StorageRoot) -> bool:
    try:
        with root.open_root() as root_descriptor:
            try:
                metadata = os.stat(
                    _OBJECTS_DIRECTORY,
                    dir_fd=root_descriptor,
                    follow_symlinks=False,
                )
            except FileNotFoundError:
                return False
            _directory_metadata(metadata, root)
            return True
    except ArtifactReconciliationError:
        raise
    except (OSError, StoragePathError) as error:
        raise _failure() from error


def _directory_names(descriptor: int) -> tuple[str, ...]:
    try:
        values = os.listdir(descriptor)
    except OSError as error:
        raise _failure() from error
    if not all(type(item) is str for item in values):
        raise _integrity_failure()
    return tuple(sorted(values))


def _scan_formal_entry(
    root: StorageRoot,
    prefix: str,
    prefix_directory: int,
    name: str,
    *,
    max_artifact_bytes: int,
) -> _FormalObject:
    path, digest, byte_size = _parse_object_path(prefix, name)
    descriptor = -1
    try:
        entry = os.stat(name, dir_fd=prefix_directory, follow_symlinks=False)
        _entry_metadata(entry, root)
        descriptor = os.open(name, _READ_FLAGS, dir_fd=prefix_directory)
        identity = _scan_descriptor(
            descriptor,
            root=root,
            expected_sha256=digest,
            expected_size=byte_size,
            max_artifact_bytes=max_artifact_bytes,
        )
        if identity != _identity(entry):
            raise _integrity_failure()
        return _FormalObject(
            path=path,
            sha256=digest,
            byte_size=byte_size,
            identity=identity,
        )
    except ArtifactReconciliationError:
        raise
    except OSError as error:
        raise _failure() from error
    finally:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass


def _scan_formal_prefix(
    root: StorageRoot,
    objects_directory: int,
    prefix: str,
    *,
    max_artifact_bytes: int,
) -> tuple[_FormalObject, ...]:
    if _HEX_PREFIX.fullmatch(prefix) is None:
        raise _integrity_failure()
    try:
        prefix_metadata = os.stat(
            prefix,
            dir_fd=objects_directory,
            follow_symlinks=False,
        )
        _directory_metadata(prefix_metadata, root)
        prefix_path = RelativeArtifactPath(f"{_OBJECTS_DIRECTORY}/{prefix}")
        with root.open_directory(prefix_path) as prefix_directory:
            if _identity(os.fstat(prefix_directory)) != _identity(prefix_metadata):
                raise _integrity_failure()
            return tuple(
                _scan_formal_entry(
                    root,
                    prefix,
                    prefix_directory,
                    name,
                    max_artifact_bytes=max_artifact_bytes,
                )
                for name in _directory_names(prefix_directory)
            )
    except ArtifactReconciliationError:
        raise
    except (OSError, StoragePathError, TypeError, ValueError) as error:
        raise _failure() from error


def _scan_formal_objects(
    root: StorageRoot,
    *,
    max_artifact_bytes: int,
) -> tuple[_FormalObject, ...]:
    if not _objects_directory_exists(root):
        return ()
    found: list[_FormalObject] = []
    try:
        with root.open_directory(_OBJECTS_DIRECTORY) as objects_directory:
            for prefix in _directory_names(objects_directory):
                found.extend(
                    _scan_formal_prefix(
                        root,
                        objects_directory,
                        prefix,
                        max_artifact_bytes=max_artifact_bytes,
                    )
                )
    except ArtifactReconciliationError:
        raise
    except (OSError, StoragePathError, TypeError, ValueError) as error:
        raise _failure() from error
    return tuple(found)


def _validate_complete_view(
    filesystem: tuple[_FormalObject, ...],
    catalog: tuple[CatalogArtifactObject, ...],
) -> tuple[
    dict[RelativeArtifactPath, _FormalObject],
    dict[RelativeArtifactPath, CatalogArtifactObject],
]:
    files_by_path = {item.path: item for item in filesystem}
    rows_by_path = {item.path: item for item in catalog}
    if len(files_by_path) != len(filesystem) or len(rows_by_path) != len(catalog):
        raise _integrity_failure()
    for path, row in rows_by_path.items():
        candidate = files_by_path.get(path)
        if candidate is None or (candidate.sha256, candidate.byte_size) != (
            row.sha256,
            row.byte_size,
        ):
            raise _integrity_failure()
    return files_by_path, rows_by_path


def _verify_candidate(
    root: StorageRoot,
    candidate: _FormalObject,
    *,
    max_artifact_bytes: int,
) -> None:
    """Recheck one candidate before changing its Catalog row."""

    components = candidate.path.root.split("/")
    if len(components) != 3 or components[0] != _OBJECTS_DIRECTORY:
        raise _integrity_failure()
    parent_path = RelativeArtifactPath("/".join(components[:2]))
    name = components[2]
    try:
        with root.open_directory(parent_path) as parent:
            entry = os.stat(name, dir_fd=parent, follow_symlinks=False)
            _entry_metadata(entry, root)
            descriptor = os.open(name, _READ_FLAGS, dir_fd=parent)
            try:
                current = _scan_descriptor(
                    descriptor,
                    root=root,
                    expected_sha256=candidate.sha256,
                    expected_size=candidate.byte_size,
                    max_artifact_bytes=max_artifact_bytes,
                )
                if current != _identity(entry) or not _same_identity(current, candidate.identity):
                    raise _integrity_failure()
            finally:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
    except ArtifactReconciliationError:
        raise
    except (OSError, StoragePathError, TypeError, ValueError) as error:
        raise _failure() from error


def _verify_and_unlink(
    root: StorageRoot,
    candidate: _FormalObject,
    *,
    max_artifact_bytes: int,
) -> None:
    components = candidate.path.root.split("/")
    if len(components) != 3 or components[0] != _OBJECTS_DIRECTORY:
        raise _integrity_failure()
    parent_path = RelativeArtifactPath("/".join(components[:2]))
    name = components[2]
    try:
        with root.open_directory(parent_path) as parent:
            try:
                entry = os.stat(name, dir_fd=parent, follow_symlinks=False)
                _entry_metadata(entry, root)
                descriptor = os.open(name, _READ_FLAGS, dir_fd=parent)
            except OSError as error:
                raise _failure() from error
            try:
                current = _scan_descriptor(
                    descriptor,
                    root=root,
                    expected_sha256=candidate.sha256,
                    expected_size=candidate.byte_size,
                    max_artifact_bytes=max_artifact_bytes,
                )
                if current != _identity(entry) or not _same_identity(current, candidate.identity):
                    raise _integrity_failure()

                def validate_moved(metadata: os.stat_result) -> None:
                    _entry_metadata(metadata, root)
                    moved = _scan_descriptor(
                        descriptor,
                        root=root,
                        expected_sha256=candidate.sha256,
                        expected_size=candidate.byte_size,
                        max_artifact_bytes=max_artifact_bytes,
                    )
                    if moved != _identity(metadata):
                        raise _integrity_failure()

                _quarantine_unlink(parent, name, descriptor, validate_moved)
            finally:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
    except ArtifactReconciliationError:
        raise
    except (OSError, StoragePathError, TypeError, ValueError) as error:
        raise _failure() from error


class ArtifactStoreReconciler:
    """Safely remove only verified formal objects with no formal reference."""

    __slots__ = ("_root", "_references", "_max_artifact_bytes")

    def __init__(
        self,
        root: StorageRoot,
        references: SqliteArtifactReferenceStore,
        *,
        max_artifact_bytes: int = _DEFAULT_MAX_ARTIFACT_BYTES,
    ) -> None:
        if not isinstance(root, StorageRoot):
            raise TypeError("root must be a StorageRoot")
        if not isinstance(references, SqliteArtifactReferenceStore):
            raise TypeError("references must be a SqliteArtifactReferenceStore")
        if type(max_artifact_bytes) is not int or max_artifact_bytes <= 0:
            raise ValueError("max_artifact_bytes must be a positive integer")
        self._root = root
        self._references = references
        self._max_artifact_bytes = max_artifact_bytes

    def reconcile(self, *, checkpoint: Checkpoint | None = None) -> ReconciliationResult:
        """Run one locked, prevalidated, row-first reconciliation pass."""

        try:
            with CatalogWriteLock(self._references.catalog_path):
                return self.reconcile_admitted(checkpoint=checkpoint)
        except CatalogLockError:
            raise
        raise AssertionError("unreachable")

    def reconcile_admitted(
        self,
        *,
        checkpoint: Checkpoint | None = None,
    ) -> ReconciliationResult:
        """Reconcile while the caller holds this Catalog's core write admission."""

        try:
            return self._reconcile(checkpoint)
        except ArtifactReconciliationError:
            raise
        except (ArtifactReferenceStoreError, OSError, StoragePathError) as error:
            raise _failure() from error
        raise AssertionError("unreachable")

    def _reconcile(self, checkpoint: Checkpoint | None) -> ReconciliationResult:
        try:
            snapshot = self._references.snapshot()
            filesystem = _scan_formal_objects(
                self._root,
                max_artifact_bytes=self._max_artifact_bytes,
            )
            files_by_path, rows_by_path = _validate_complete_view(
                filesystem,
                snapshot.objects,
            )
            referenced = snapshot.referenced_paths
            if not referenced.issubset(files_by_path):
                raise _integrity_failure()
            _checkpoint(checkpoint, "after-prevalidation")

            deleted: list[RelativeArtifactPath] = []
            preserved: list[RelativeArtifactPath] = []
            for path in sorted(files_by_path, key=lambda value: value.root):
                candidate = files_by_path[path]
                if path in referenced:
                    preserved.append(path)
                    continue
                _checkpoint(checkpoint, "before-candidate-recheck")
                _verify_candidate(
                    self._root,
                    candidate,
                    max_artifact_bytes=self._max_artifact_bytes,
                )
                row = rows_by_path.get(path)
                if row is not None:
                    if not self._references.retire_if_unreferenced(row):
                        preserved.append(path)
                        continue
                    _checkpoint(checkpoint, "after-catalog-delete")
                else:
                    _checkpoint(checkpoint, "before-filesystem-only-confirm")
                    if not self._references.confirm_filesystem_only(
                        candidate.path,
                        candidate.sha256,
                        candidate.byte_size,
                    ):
                        preserved.append(path)
                        continue
                _checkpoint(checkpoint, "before-unlink")
                _verify_and_unlink(
                    self._root,
                    candidate,
                    max_artifact_bytes=self._max_artifact_bytes,
                )
                deleted.append(path)
                _checkpoint(checkpoint, "after-unlink")
            return ReconciliationResult(tuple(deleted), tuple(preserved))
        except ArtifactReconciliationError:
            raise
        except (ArtifactReferenceStoreError, OSError, StoragePathError) as error:
            raise _failure() from error


__all__ = (
    "ArtifactReconciliationError",
    "ArtifactReconciliationIntegrityError",
    "ArtifactStoreReconciler",
    "Checkpoint",
    "ReconciliationResult",
)
