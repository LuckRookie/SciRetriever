"""Crash-safe immutable publication for normalized and package artifacts."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
import errno
import fcntl
import hashlib
import os
import re
import stat

from sciretriever.core.ids import new_uuid4, validate_uuid
from sciretriever.core.validation import validate_sha256, validate_token
from sciretriever.errors import (
    CrossDeviceStorageError,
    StorageConflictError,
    StorageCorruptionError,
    StorageError,
    StoragePathError,
)

from .derived_records import DerivedPublication, DerivedReconciliationReport, DerivedStagedArtifact
from .manager import RawAssetStore, _FILE_FLAGS, _INSPECTION_FILE_FLAGS


_STAGED = re.compile(
    r"^(?P<kind>[a-z][a-z0-9_]*)\."
    r"(?P<owner>[0-9a-f-]{36})\."
    r"(?P<sha>[0-9a-f]{64})\."
    r"(?P<attempt>[0-9a-f-]{36})\.part$"
)
Checkpoint = Callable[[str], None]


class DerivedArtifactStore:
    """Owner-addressed immutable artifacts under the configured storage root."""

    def __init__(
        self,
        root: str | os.PathLike[str] | None = None,
        *,
        chunk_size: int = 1024 * 1024,
        max_bytes: int = 128 * 1024 * 1024,
    ) -> None:
        if not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or max_bytes <= 0:
            raise ValueError("max_bytes must be a positive integer")
        self.max_bytes = max_bytes
        self._raw_store = RawAssetStore(root, chunk_size=chunk_size)
        self.root = self._raw_store.root
        self.chunk_size = self._raw_store.chunk_size
        self._initialize_derived_layout()

    def _open_root(self) -> int:
        return self._raw_store._open_root()

    @staticmethod
    def _open_directory_at(parent: int, name: str) -> int:
        return RawAssetStore._open_directory_at(parent, name)

    def _ensure_directory(self, parent: int, name: str) -> int:
        return self._raw_store._ensure_directory(parent, name)

    def _ensure_lock_file(self, staging: int) -> None:
        self._raw_store._ensure_lock_file(staging)

    @staticmethod
    def _fsync(descriptor: int, subject: str) -> None:
        RawAssetStore._fsync(descriptor, subject)

    @staticmethod
    def _write_all(descriptor: int, data: bytes) -> None:
        RawAssetStore._write_all(descriptor, data)

    def _cleanup_incomplete(self, staging: int, name: str) -> None:
        self._raw_store._cleanup_incomplete(staging, name)

    @staticmethod
    def _open_regular_at(parent: int, name: str, subject: str) -> tuple[int, os.stat_result]:
        return RawAssetStore._open_regular_at(parent, name, subject)

    def _verify_descriptor(
        self,
        descriptor: int,
        metadata: os.stat_result,
        expected_sha256: str,
        expected_size: int,
        subject: str,
    ) -> None:
        self._raw_store._verify_descriptor(
            descriptor, metadata, expected_sha256, expected_size, subject
        )

    def _hash_descriptor(self, descriptor: int) -> str:
        return self._raw_store._hash_descriptor(descriptor)

    def _initialize_derived_layout(self) -> None:
        root = self._open_root()
        try:
            staging = self._ensure_directory(root, "derived_staging")
            derived = self._ensure_directory(root, "derived")
            locks = self._ensure_directory(root, "derived_locks")
            try:
                self._ensure_lock_file(staging)
                self._fsync(staging, "derived staging directory")
                self._fsync(derived, "derived directory")
                self._fsync(locks, "derived lock directory")
                self._fsync(root, "storage root")
            finally:
                os.close(staging)
                os.close(derived)
                os.close(locks)
        finally:
            os.close(root)

    @contextmanager
    def _derived_directories(self) -> Iterator[tuple[int, int, int]]:
        root = self._open_root()
        try:
            staging = self._open_directory_at(root, "derived_staging")
            try:
                derived = self._open_directory_at(root, "derived")
                try:
                    yield root, staging, derived
                finally:
                    os.close(derived)
            finally:
                os.close(staging)
        finally:
            os.close(root)

    @contextmanager
    def package_lock(self, *, exclusive: bool = True) -> Iterator[None]:
        with self._derived_directories() as (_, staging, _):
            descriptor = os.open(".lock", os.O_RDWR | _FILE_FLAGS, dir_fd=staging)
            try:
                if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                    raise StoragePathError("derived staging lock must be a regular file")
                fcntl.flock(descriptor, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
                try:
                    yield
                finally:
                    fcntl.flock(descriptor, fcntl.LOCK_UN)
            except OSError as error:
                raise StorageError("could not use derived storage lock") from error
            finally:
                os.close(descriptor)

    @contextmanager
    def run_lock(self, run_id: str) -> Iterator[None]:
        run_id = validate_uuid(run_id, "run_id")
        root = self._open_root()
        try:
            locks = self._open_directory_at(root, "derived_locks")
            try:
                try:
                    descriptor = os.open(
                        run_id,
                        os.O_RDWR | os.O_CREAT | _FILE_FLAGS,
                        0o600,
                        dir_fd=locks,
                    )
                except OSError as error:
                    raise StorageError("could not open derived run lock") from error
                try:
                    metadata = os.fstat(descriptor)
                    if not stat.S_ISREG(metadata.st_mode):
                        raise StoragePathError("derived run lock must be a regular file")
                    if stat.S_IMODE(metadata.st_mode) != 0o600:
                        raise StoragePathError("derived run lock mode must be exactly 0600")
                    self._fsync(locks, "derived lock directory")
                    fcntl.flock(descriptor, fcntl.LOCK_EX)
                    try:
                        yield
                    finally:
                        fcntl.flock(descriptor, fcntl.LOCK_UN)
                except OSError as error:
                    raise StorageError("could not use derived run lock") from error
                finally:
                    os.close(descriptor)
            finally:
                os.close(locks)
        finally:
            os.close(root)

    @staticmethod
    def _checkpoint(callback: Checkpoint | None, name: str) -> None:
        if callback is not None:
            callback(name)

    @staticmethod
    def _derived_staged_name(artifact: DerivedStagedArtifact) -> str:
        return artifact.temporary_path.removeprefix("derived_staging/")

    def _stage_bytes(self, kind: str, owner_id: str, payload: bytes) -> DerivedStagedArtifact:
        if not isinstance(payload, bytes):
            raise TypeError("payload must be bytes")
        if not payload:
            raise StorageError("empty derived artifacts cannot be published")
        if len(payload) > self.max_bytes:
            raise StorageError("derived artifact exceeds the configured byte bound")
        digest = hashlib.sha256(payload).hexdigest()
        attempt_id = new_uuid4()
        name = f"{kind}.{owner_id}.{digest}.{attempt_id}.part"
        with self._derived_directories() as (_, staging, _):
            try:
                descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _FILE_FLAGS, 0o600, dir_fd=staging)
            except OSError as error:
                raise StorageError("could not create derived staging file") from error
            complete = False
            try:
                self._write_all(descriptor, payload)
                self._fsync(descriptor, "derived staging contents")
                os.fchmod(descriptor, 0o400)
                self._fsync(descriptor, "read-only derived staging file")
                self._fsync(staging, "derived staging directory")
                complete = True
            finally:
                os.close(descriptor)
                if not complete:
                    self._cleanup_incomplete(staging, name)
        return DerivedStagedArtifact(
            kind, owner_id, attempt_id, f"derived_staging/{name}", digest, len(payload)
        )

    def _publish_staged(self, artifact: DerivedStagedArtifact) -> DerivedPublication:
        name = self._derived_staged_name(artifact)
        with self._derived_directories() as (_, staging, derived):
            source, source_metadata = self._open_regular_at(staging, name, "derived staging file")
            try:
                self._verify_descriptor(source, source_metadata, artifact.sha256, artifact.byte_size, "derived staging file")
                kind_dir = self._ensure_directory(derived, artifact.kind)
                try:
                    shard = self._ensure_directory(kind_dir, artifact.owner_id[:2])
                    try:
                        if source_metadata.st_dev != os.fstat(shard).st_dev:
                            raise CrossDeviceStorageError("derived publication cannot cross filesystems")
                        created = False
                        try:
                            os.link(name, artifact.owner_id, src_dir_fd=staging, dst_dir_fd=shard, follow_symlinks=False)
                            created = True
                        except FileExistsError:
                            pass
                        except OSError as error:
                            if error.errno == errno.EXDEV:
                                raise CrossDeviceStorageError("derived publication cannot cross filesystems") from error
                            raise StorageError("could not hard-link derived artifact") from error

                        target, target_metadata = self._open_regular_at(shard, artifact.owner_id, "derived artifact")
                        try:
                            if stat.S_IMODE(target_metadata.st_mode) != 0o400:
                                raise StorageCorruptionError("derived artifact mode must be exactly 0400")
                            if target_metadata.st_size != artifact.byte_size or self._hash_descriptor(target) != artifact.sha256:
                                raise StorageConflictError("derived owner slot contains different bytes")
                            after = os.fstat(target)
                            if after.st_mode != target_metadata.st_mode or after.st_size != target_metadata.st_size:
                                raise StorageCorruptionError("derived artifact changed during verification")
                            self._fsync(target, "derived artifact")
                        finally:
                            os.close(target)
                        if created and (target_metadata.st_dev, target_metadata.st_ino) != (source_metadata.st_dev, source_metadata.st_ino):
                            raise StorageCorruptionError("new derived target is not the staged hard link")
                        self._fsync(shard, "derived shard directory")
                        self._fsync(kind_dir, "derived kind directory")
                        self._fsync(derived, "derived directory")
                    finally:
                        os.close(shard)
                finally:
                    os.close(kind_dir)
            finally:
                os.close(source)
        return DerivedPublication(
            artifact.kind,
            artifact.owner_id,
            f"derived/{artifact.kind}/{artifact.owner_id[:2]}/{artifact.owner_id}",
            artifact.sha256,
            artifact.byte_size,
            created,
        )

    def publish_bytes(
        self,
        kind: str,
        owner_id: str,
        payload: bytes,
        checkpoint: Checkpoint | None = None,
    ) -> DerivedPublication:
        kind = validate_token(kind, "kind")
        owner_id = validate_uuid(owner_id, "owner_id")
        staged = self._stage_bytes(kind, owner_id, payload)
        self._checkpoint(checkpoint, "after_staged_fsync")
        with self.package_lock(exclusive=False):
            publication = self._publish_staged(staged)
        self._checkpoint(checkpoint, "after_target_fsync")
        with self._derived_directories() as (_, staging, _):
            os.unlink(self._derived_staged_name(staged), dir_fd=staging)
            self._fsync(staging, "derived staging directory after removal")
        self._checkpoint(checkpoint, "after_staging_removal")
        return publication

    def find_published(self, kind: str, owner_id: str) -> DerivedPublication | None:
        kind = validate_token(kind, "kind")
        owner_id = validate_uuid(owner_id, "owner_id")
        with self._derived_directories() as (_, _, derived):
            try:
                kind_dir = self._open_directory_at(derived, kind)
            except StoragePathError:
                return None
            try:
                try:
                    shard = self._open_directory_at(kind_dir, owner_id[:2])
                except StoragePathError:
                    return None
                try:
                    try:
                        descriptor = os.open(owner_id, _INSPECTION_FILE_FLAGS, dir_fd=shard)
                    except FileNotFoundError:
                        return None
                    except OSError as error:
                        raise StorageCorruptionError("derived artifact is unsafe") from error
                    try:
                        metadata = os.fstat(descriptor)
                        if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o400:
                            raise StorageCorruptionError("derived artifact is not immutable")
                        sha256 = self._hash_descriptor(descriptor)
                        return DerivedPublication(
                            kind, owner_id, f"derived/{kind}/{owner_id[:2]}/{owner_id}", sha256, metadata.st_size, False
                        )
                    finally:
                        os.close(descriptor)
                finally:
                    os.close(shard)
            finally:
                os.close(kind_dir)

    def read_verified(self, publication: DerivedPublication) -> bytes:
        if not isinstance(publication, DerivedPublication):
            raise TypeError("publication must be a DerivedPublication")
        if publication.byte_size > self.max_bytes:
            raise StorageError("derived artifact exceeds the configured byte bound")
        with self._derived_directories() as (_, _, derived):
            kind_dir = self._open_directory_at(derived, publication.kind)
            try:
                shard = self._open_directory_at(kind_dir, publication.owner_id[:2])
                try:
                    descriptor, metadata = self._open_regular_at(shard, publication.owner_id, "derived artifact")
                    try:
                        self._verify_descriptor(descriptor, metadata, publication.sha256, publication.byte_size, "derived artifact")
                        os.lseek(descriptor, 0, os.SEEK_SET)
                        chunks: list[bytes] = []
                        remaining = publication.byte_size
                        while remaining:
                            chunk = os.read(descriptor, min(self.chunk_size, remaining))
                            if not chunk:
                                raise StorageCorruptionError("derived artifact ended during read")
                            chunks.append(chunk)
                            remaining -= len(chunk)
                        if os.read(descriptor, 1):
                            raise StorageCorruptionError("derived artifact grew during read")
                        return b"".join(chunks)
                    finally:
                        os.close(descriptor)
                finally:
                    os.close(shard)
            finally:
                os.close(kind_dir)


class DerivedArtifactReconciler:
    def __init__(self, store: DerivedArtifactStore) -> None:
        if not isinstance(store, DerivedArtifactStore):
            raise TypeError("store must be a DerivedArtifactStore")
        self.store = store

    def reconcile_all(self) -> DerivedReconciliationReport:
        published: list[DerivedPublication] = []
        retained: list[str] = []
        unknown: list[str] = []
        with self.store.package_lock(exclusive=True):
            with self.store._derived_directories() as (_, staging, _):
                entries = sorted(entry.name for entry in os.scandir(staging) if entry.name != ".lock")
            for name in entries:
                path = f"derived_staging/{name}"
                match = _STAGED.fullmatch(name)
                if match is None:
                    unknown.append(path)
                    continue
                try:
                    artifact = DerivedStagedArtifact(
                        match["kind"], match["owner"], match["attempt"], path,
                        validate_sha256(match["sha"]), os.lstat(self.store.root / path).st_size,
                    )
                    result = self.store._publish_staged(artifact)
                    with self.store._derived_directories() as (_, staging, _):
                        os.unlink(name, dir_fd=staging)
                        self.store._fsync(staging, "derived staging directory after reconciliation")
                    published.append(result)
                except (StorageError, ValueError, OSError):
                    retained.append(path)
        return DerivedReconciliationReport(tuple(published), tuple(retained), tuple(unknown))


__all__ = ("DerivedArtifactReconciler", "DerivedArtifactStore")
