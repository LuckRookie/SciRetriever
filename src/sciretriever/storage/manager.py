"""Secure durable POSIX primitives for immutable raw assets."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
import errno
import fcntl
import hashlib
import os
from pathlib import Path
import re
import stat
from typing import Any, BinaryIO

from sciretriever.config import STORAGE_ROOT_ENV, resolve_storage_root
from sciretriever.core.hashing import DEFAULT_CHUNK_SIZE
from sciretriever.core.ids import new_uuid4, validate_uuid
from sciretriever.core.validation import validate_sha256, validate_storage_path
from sciretriever.errors import (
    CrossDeviceStorageError,
    DurabilityError,
    StorageConflictError,
    StorageCorruptionError,
    StorageError,
    StoragePathError,
)
from .records import PublicationResult, StagedAsset


_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
_FILE_FLAGS = os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
_INSPECTION_FILE_FLAGS = os.O_RDONLY | os.O_NONBLOCK | _FILE_FLAGS
_UUID_PART = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$"
)


class RawAssetStore:
    """Content-addressed immutable storage rooted on one POSIX filesystem."""

    def __init__(
        self,
        root: str | os.PathLike[str] | None = None,
        *,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
    ) -> None:
        if not isinstance(chunk_size, int) or isinstance(chunk_size, bool):
            raise TypeError("chunk_size must be an integer")
        if chunk_size <= 0:
            raise ValueError("chunk_size must be greater than zero")

        configured = root if root is not None else os.environ.get(STORAGE_ROOT_ENV)
        if configured is not None:
            self._reject_symlink_root(Path(configured).expanduser())
        self.root = resolve_storage_root(root)
        self.chunk_size = chunk_size
        self._root_identity = self._validate_root()
        self._initialize_layout()

    @staticmethod
    def _reject_symlink_root(path: Path) -> None:
        candidate = path.absolute()
        current = Path(candidate.anchor)
        for component in candidate.parts[1:]:
            current /= component
            try:
                metadata = os.lstat(current)
            except FileNotFoundError:
                return
            except OSError as error:
                raise StoragePathError(f"cannot inspect storage root {current}") from error
            if stat.S_ISLNK(metadata.st_mode):
                raise StoragePathError("storage root must not contain symlink aliases")

    def _validate_root(self) -> tuple[int, int]:
        try:
            metadata = os.lstat(self.root)
        except FileNotFoundError as error:
            raise StoragePathError("storage root must already exist") from error
        except OSError as error:
            raise StoragePathError(f"cannot inspect storage root {self.root}") from error
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise StoragePathError("storage root must be a real directory")

        descriptor = self._open_path(self.root, _DIRECTORY_FLAGS | getattr(os, "O_NOFOLLOW", 0))
        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISDIR(opened.st_mode):
                raise StoragePathError("storage root must be a directory")
            return opened.st_dev, opened.st_ino
        finally:
            os.close(descriptor)

    @staticmethod
    def _open_path(path: Path, flags: int, mode: int = 0o600) -> int:
        try:
            return os.open(path, flags, mode)
        except OSError as error:
            raise StoragePathError(f"cannot securely open {path}") from error

    def _open_root(self) -> int:
        descriptor = self._open_path(
            self.root, _DIRECTORY_FLAGS | getattr(os, "O_NOFOLLOW", 0)
        )
        metadata = os.fstat(descriptor)
        if (metadata.st_dev, metadata.st_ino) != self._root_identity:
            os.close(descriptor)
            raise StoragePathError("storage root changed after initialization")
        return descriptor

    @staticmethod
    def _fsync(descriptor: int, subject: str) -> None:
        try:
            os.fsync(descriptor)
        except OSError as error:
            raise DurabilityError(f"could not fsync {subject}") from error

    @staticmethod
    def _open_directory_at(parent: int, name: str) -> int:
        try:
            descriptor = os.open(
                name,
                _DIRECTORY_FLAGS | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=parent,
            )
        except OSError as error:
            raise StoragePathError(f"managed directory is unsafe: {name}") from error
        metadata = os.fstat(descriptor)
        if not stat.S_ISDIR(metadata.st_mode):
            os.close(descriptor)
            raise StoragePathError(f"managed entry is not a directory: {name}")
        return descriptor

    def _ensure_directory(self, parent: int, name: str) -> int:
        created = False
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
            created = True
        except FileExistsError:
            pass
        except OSError as error:
            raise StorageError(f"could not create managed directory {name}") from error

        descriptor = self._open_directory_at(parent, name)
        try:
            os.fchmod(descriptor, 0o700)
            self._fsync(descriptor, name)
            if created:
                self._fsync(parent, f"parent of {name}")
        except OSError as error:
            os.close(descriptor)
            raise StorageError(f"could not secure managed directory {name}") from error
        return descriptor

    def _initialize_layout(self) -> None:
        root = self._open_root()
        try:
            staging = self._ensure_directory(root, "staging")
            raw = self._ensure_directory(root, "raw")
            try:
                self._ensure_lock_file(staging)
                self._fsync(staging, "staging directory")
                self._fsync(raw, "raw directory")
                self._fsync(root, "storage root")
            finally:
                os.close(staging)
                os.close(raw)
        finally:
            os.close(root)

    def _ensure_lock_file(self, staging: int) -> None:
        flags = os.O_RDWR | os.O_CREAT | _FILE_FLAGS
        try:
            descriptor = os.open(".lock", flags, 0o600, dir_fd=staging)
        except OSError as error:
            raise StoragePathError("could not securely open staging lock") from error
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                raise StoragePathError("staging lock must be a regular file")
            os.fchmod(descriptor, 0o600)
            self._fsync(descriptor, "staging lock")
        except OSError as error:
            raise StorageError("could not secure staging lock") from error
        finally:
            os.close(descriptor)

    @contextmanager
    def _managed_directories(self) -> Iterator[tuple[int, int, int]]:
        root = self._open_root()
        try:
            staging = self._open_directory_at(root, "staging")
            try:
                raw = self._open_directory_at(root, "raw")
                try:
                    yield root, staging, raw
                finally:
                    os.close(raw)
            finally:
                os.close(staging)
        finally:
            os.close(root)

    @contextmanager
    def lock(self, *, exclusive: bool = False) -> Iterator[None]:
        """Hold the coordinator shared lock or reconciliation exclusive lock."""

        with self._managed_directories() as (_, staging, _):
            try:
                descriptor = os.open(".lock", os.O_RDWR | _FILE_FLAGS, dir_fd=staging)
            except OSError as error:
                raise StoragePathError("staging lock is missing or unsafe") from error
            try:
                if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                    raise StoragePathError("staging lock must be a regular file")
                operation = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
                try:
                    fcntl.flock(descriptor, operation)
                except OSError as error:
                    raise StorageError("could not acquire storage lock") from error
                try:
                    yield
                finally:
                    try:
                        fcntl.flock(descriptor, fcntl.LOCK_UN)
                    except OSError as error:
                        raise StorageError("could not release storage lock") from error
            finally:
                os.close(descriptor)

    @staticmethod
    def _staged_name(asset: StagedAsset) -> str:
        if not isinstance(asset, StagedAsset):
            raise TypeError("asset must be a StagedAsset")
        validate_storage_path(asset.temporary_path)
        expected = f"staging/{asset.intent_id}.part"
        if asset.temporary_path != expected:
            raise StoragePathError("staged path does not match its intent")
        return f"{asset.intent_id}.part"

    @staticmethod
    def _write_all(descriptor: int, data: bytes) -> None:
        offset = 0
        while offset < len(data):
            try:
                written = os.write(descriptor, data[offset:])
            except OSError as error:
                raise StorageError("could not write staged asset") from error
            if written <= 0:
                raise StorageError("staged asset write made no progress")
            offset += written

    def _hash_descriptor(self, descriptor: int) -> str:
        digest = hashlib.sha256()
        try:
            os.lseek(descriptor, 0, os.SEEK_SET)
            while True:
                chunk = os.read(descriptor, self.chunk_size)
                if not chunk:
                    return digest.hexdigest()
                digest.update(chunk)
        except OSError as error:
            raise StorageError("could not read stored asset") from error

    def _cleanup_incomplete(self, staging: int, name: str) -> None:
        try:
            os.unlink(name, dir_fd=staging)
        except FileNotFoundError:
            return
        except OSError as error:
            raise StorageError("could not remove incomplete staged asset") from error
        self._fsync(staging, "staging directory after cleanup")

    def stage(
        self,
        stream: BinaryIO,
        *,
        intent_id: str | None = None,
    ) -> StagedAsset:
        """Read a binary stream once into a durable immutable staging file."""

        identifier = new_uuid4() if intent_id is None else validate_uuid(intent_id, "intent_id")
        name = f"{identifier}.part"
        temporary_path = f"staging/{name}"
        with self._managed_directories() as (_, staging, _):
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | _FILE_FLAGS
            try:
                descriptor = os.open(name, flags, 0o600, dir_fd=staging)
            except FileExistsError as error:
                raise StorageConflictError(f"staged intent already exists: {identifier}") from error
            except OSError as error:
                raise StorageError("could not create staged asset") from error

            complete = False
            try:
                digest = hashlib.sha256()
                byte_size = 0
                while True:
                    try:
                        chunk = stream.read(self.chunk_size)
                    except Exception as error:
                        raise StorageError("could not read injected asset stream") from error
                    if not isinstance(chunk, bytes):
                        raise StorageError("asset stream must return bytes")
                    if not chunk:
                        break
                    self._write_all(descriptor, chunk)
                    digest.update(chunk)
                    byte_size += len(chunk)
                if byte_size == 0:
                    raise StorageError("empty assets cannot be staged")

                self._fsync(descriptor, "staged asset contents")
                try:
                    os.fchmod(descriptor, 0o400)
                except OSError as error:
                    raise StorageError("could not make staged asset read-only") from error
                self._fsync(descriptor, "read-only staged asset")
                self._fsync(staging, "staging directory")
                complete = True
                return StagedAsset(identifier, temporary_path, digest.hexdigest(), byte_size)
            finally:
                os.close(descriptor)
                if not complete:
                    self._cleanup_incomplete(staging, name)

    @staticmethod
    def _open_regular_at(parent: int, name: str, subject: str) -> tuple[int, os.stat_result]:
        try:
            descriptor = os.open(name, os.O_RDONLY | _FILE_FLAGS, dir_fd=parent)
        except OSError as error:
            raise StorageCorruptionError(f"{subject} is missing or unsafe") from error
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            os.close(descriptor)
            raise StorageCorruptionError(f"{subject} is not a regular file")
        return descriptor, metadata

    def _verify_descriptor(
        self,
        descriptor: int,
        metadata: os.stat_result,
        expected_sha256: str,
        expected_size: int,
        subject: str,
    ) -> None:
        if not stat.S_ISREG(metadata.st_mode):
            raise StorageCorruptionError(f"{subject} is not a regular file")
        if stat.S_IMODE(metadata.st_mode) != 0o400:
            raise StorageCorruptionError(f"{subject} mode must be exactly 0400")
        if metadata.st_size != expected_size:
            raise StorageCorruptionError(f"{subject} size does not match its record")
        actual_sha256 = self._hash_descriptor(descriptor)
        if actual_sha256 != expected_sha256:
            raise StorageCorruptionError(f"{subject} hash does not match its record")
        after = os.fstat(descriptor)
        if not stat.S_ISREG(after.st_mode) or stat.S_IMODE(after.st_mode) != 0o400:
            raise StorageCorruptionError(f"{subject} mode changed during verification")
        if (
            after.st_mode != metadata.st_mode
            or after.st_size != metadata.st_size
            or after.st_mtime_ns != metadata.st_mtime_ns
            or after.st_ctime_ns != metadata.st_ctime_ns
        ):
            raise StorageCorruptionError(f"{subject} changed during verification")

    def verify_staged(self, asset: StagedAsset) -> StagedAsset:
        name = self._staged_name(asset)
        with self._managed_directories() as (_, staging, _):
            descriptor, metadata = self._open_regular_at(staging, name, "staged asset")
            try:
                self._verify_descriptor(
                    descriptor, metadata, asset.sha256, asset.byte_size, "staged asset"
                )
            finally:
                os.close(descriptor)
        return asset

    def staged_exists(self, asset: StagedAsset) -> bool:
        """Return false only when the exact staged path is absent.

        Existing unsafe, non-regular, or mismatched entries are corruption and
        deliberately raise instead of being treated as missing.
        """

        name = self._staged_name(asset)
        with self._managed_directories() as (_, staging, _):
            try:
                descriptor = os.open(name, _INSPECTION_FILE_FLAGS, dir_fd=staging)
            except FileNotFoundError:
                return False
            except OSError as error:
                raise StorageCorruptionError("staged asset is unsafe") from error
            try:
                metadata = os.fstat(descriptor)
                if not stat.S_ISREG(metadata.st_mode):
                    raise StorageCorruptionError("staged asset is not a regular file")
                self._verify_descriptor(
                    descriptor, metadata, asset.sha256, asset.byte_size, "staged asset"
                )
            finally:
                os.close(descriptor)
        return True

    @staticmethod
    def _publication_values(
        publication: PublicationResult | str,
        byte_size: int | None,
    ) -> tuple[str, int, bool]:
        if isinstance(publication, PublicationResult):
            if byte_size is not None:
                raise TypeError("byte_size must be omitted for PublicationResult")
            return publication.sha256, publication.byte_size, publication.created
        sha256 = validate_sha256(publication)
        if not isinstance(byte_size, int) or isinstance(byte_size, bool) or byte_size <= 0:
            raise ValueError("byte_size must be a positive integer")
        return sha256, byte_size, False

    def verify_published(
        self,
        publication: PublicationResult | str,
        byte_size: int | None = None,
    ) -> PublicationResult:
        sha256, size, created = self._publication_values(publication, byte_size)
        shard_name = sha256[:2]
        with self._managed_directories() as (_, _, raw):
            shard = self._open_directory_at(raw, shard_name)
            try:
                descriptor, metadata = self._open_regular_at(shard, sha256, "published asset")
                try:
                    self._verify_descriptor(
                        descriptor, metadata, sha256, size, "published asset"
                    )
                finally:
                    os.close(descriptor)
            finally:
                os.close(shard)
        return PublicationResult(f"raw/{shard_name}/{sha256}", sha256, size, created)

    def published_exists(
        self,
        publication: PublicationResult | str,
        byte_size: int | None = None,
    ) -> bool:
        """Return false only when the exact raw target or its shard is absent."""

        sha256, size, _ = self._publication_values(publication, byte_size)
        shard_name = sha256[:2]
        with self._managed_directories() as (_, _, raw):
            try:
                shard = os.open(
                    shard_name,
                    _DIRECTORY_FLAGS | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=raw,
                )
            except FileNotFoundError:
                return False
            except OSError as error:
                raise StorageCorruptionError("published asset shard is unsafe") from error
            try:
                shard_metadata = os.fstat(shard)
                if not stat.S_ISDIR(shard_metadata.st_mode):
                    raise StorageCorruptionError("published asset shard is not a directory")
                try:
                    descriptor = os.open(
                        sha256, _INSPECTION_FILE_FLAGS, dir_fd=shard
                    )
                except FileNotFoundError:
                    return False
                except OSError as error:
                    raise StorageCorruptionError("published asset is unsafe") from error
                try:
                    metadata = os.fstat(descriptor)
                    if not stat.S_ISREG(metadata.st_mode):
                        raise StorageCorruptionError(
                            "published asset is not a regular file"
                        )
                    self._verify_descriptor(
                        descriptor, metadata, sha256, size, "published asset"
                    )
                finally:
                    os.close(descriptor)
            finally:
                os.close(shard)
        return True

    def read_verified(
        self,
        storage_path: str,
        sha256: str,
        byte_size: int,
        max_bytes: int,
    ) -> bytes:
        """Read one bounded raw asset after verifying its immutable record."""

        storage_path = validate_storage_path(storage_path)
        sha256 = validate_sha256(sha256)
        if storage_path != f"raw/{sha256[:2]}/{sha256}":
            raise StoragePathError("raw storage path does not match its hash")
        for value, name in ((byte_size, "byte_size"), (max_bytes, "max_bytes")):
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                raise ValueError(f"{name} must be a positive integer")
        if byte_size > max_bytes:
            raise StorageError("raw asset exceeds the configured read bound")

        with self._managed_directories() as (_, _, raw):
            shard = self._open_directory_at(raw, sha256[:2])
            try:
                descriptor, metadata = self._open_regular_at(shard, sha256, "published asset")
                try:
                    self._verify_descriptor(
                        descriptor, metadata, sha256, byte_size, "published asset"
                    )
                    os.lseek(descriptor, 0, os.SEEK_SET)
                    chunks: list[bytes] = []
                    remaining = byte_size
                    while remaining:
                        chunk = os.read(descriptor, min(self.chunk_size, remaining))
                        if not chunk:
                            raise StorageCorruptionError("published asset ended during read")
                        chunks.append(chunk)
                        remaining -= len(chunk)
                    if os.read(descriptor, 1):
                        raise StorageCorruptionError("published asset grew during read")
                    after = os.fstat(descriptor)
                    if (
                        after.st_mode != metadata.st_mode
                        or after.st_size != metadata.st_size
                        or after.st_mtime_ns != metadata.st_mtime_ns
                        or after.st_ctime_ns != metadata.st_ctime_ns
                    ):
                        raise StorageCorruptionError("published asset changed during read")
                    return b"".join(chunks)
                except OSError as error:
                    raise StorageError("could not read published asset") from error
                finally:
                    os.close(descriptor)
            finally:
                os.close(shard)

    def _ensure_shard(self, raw: int, name: str) -> int:
        return self._ensure_directory(raw, name)

    def _verify_publish_target(
        self,
        shard: int,
        asset: StagedAsset,
        *,
        durable: bool,
    ) -> os.stat_result:
        descriptor, metadata = self._open_regular_at(shard, asset.sha256, "published asset")
        try:
            self._verify_descriptor(
                descriptor, metadata, asset.sha256, asset.byte_size, "published asset"
            )
            if durable:
                self._fsync(descriptor, "published asset")
        finally:
            os.close(descriptor)
        return metadata

    def publish_recovery_locked(self, asset: StagedAsset) -> PublicationResult:
        """Publish while the caller owns the store's shared or exclusive lock."""

        staged_name = self._staged_name(asset)
        with self._managed_directories() as (_, staging, raw):
            source, source_metadata = self._open_regular_at(
                staging, staged_name, "staged asset"
            )
            try:
                self._verify_descriptor(
                    source,
                    source_metadata,
                    asset.sha256,
                    asset.byte_size,
                    "staged asset",
                )
                shard = self._ensure_shard(raw, asset.sha256[:2])
                try:
                    if source_metadata.st_dev != os.fstat(shard).st_dev:
                        raise CrossDeviceStorageError(
                            "staging and raw shard are on different filesystems"
                        )
                    created = False
                    try:
                        os.link(
                            staged_name,
                            asset.sha256,
                            src_dir_fd=staging,
                            dst_dir_fd=shard,
                            follow_symlinks=False,
                        )
                        created = True
                    except FileExistsError:
                        pass
                    except OSError as error:
                        if error.errno == errno.EXDEV:
                            raise CrossDeviceStorageError(
                                "raw asset publication cannot cross filesystems"
                            ) from error
                        raise StorageError("could not hard-link raw asset") from error

                    target_metadata = self._verify_publish_target(
                        shard, asset, durable=True
                    )
                    if created and (
                        target_metadata.st_dev != source_metadata.st_dev
                        or target_metadata.st_ino != source_metadata.st_ino
                    ):
                        raise StorageCorruptionError(
                            "new raw target is not the staged hard link"
                        )
                    self._fsync(shard, "raw shard directory")
                    self._fsync(raw, "raw directory")
                finally:
                    os.close(shard)
            finally:
                os.close(source)
        return PublicationResult(
            f"raw/{asset.sha256[:2]}/{asset.sha256}",
            asset.sha256,
            asset.byte_size,
            created,
        )

    def publish(self, asset: StagedAsset) -> PublicationResult:
        """Create the immutable content address once and verify every collision."""

        with self.lock():
            return self.publish_recovery_locked(asset)

    def remove_staged(self, asset: StagedAsset) -> None:
        name = self._staged_name(asset)
        with self._managed_directories() as (_, staging, _):
            descriptor, metadata = self._open_regular_at(staging, name, "staged asset")
            try:
                self._verify_descriptor(
                    descriptor, metadata, asset.sha256, asset.byte_size, "staged asset"
                )
            finally:
                os.close(descriptor)
            try:
                os.unlink(name, dir_fd=staging)
            except OSError as error:
                raise StorageError("could not remove staged asset") from error
            self._fsync(staging, "staging directory after removal")

    def remove_staging_orphan_locked(self, temporary_path: str) -> bool:
        """Durably remove one regular recognized orphan under an exclusive lock."""

        validate_storage_path(temporary_path)
        if not temporary_path.startswith("staging/"):
            raise StoragePathError("orphan path must be in staging")
        name = temporary_path.removeprefix("staging/")
        if _UUID_PART.fullmatch(name) is None:
            raise StoragePathError("orphan path is not a recognized staging path")
        validate_uuid(name[:-5], "intent_id")
        with self._managed_directories() as (_, staging, _):
            try:
                descriptor = os.open(name, _INSPECTION_FILE_FLAGS, dir_fd=staging)
            except FileNotFoundError:
                return False
            except OSError as error:
                raise StorageCorruptionError("staging orphan is unsafe") from error
            try:
                opened = os.fstat(descriptor)
                if not stat.S_ISREG(opened.st_mode):
                    raise StorageCorruptionError("staging orphan is not a regular file")
                try:
                    current = os.stat(name, dir_fd=staging, follow_symlinks=False)
                except FileNotFoundError:
                    return False
                except OSError as error:
                    raise StorageCorruptionError(
                        "staging orphan could not be inspected"
                    ) from error
                if (
                    not stat.S_ISREG(current.st_mode)
                    or current.st_dev != opened.st_dev
                    or current.st_ino != opened.st_ino
                ):
                    raise StorageCorruptionError("staging orphan changed during inspection")
                try:
                    os.unlink(name, dir_fd=staging)
                except FileNotFoundError:
                    return False
                except OSError as error:
                    raise StorageError("could not remove staging orphan") from error
            finally:
                os.close(descriptor)
            self._fsync(staging, "staging directory after orphan removal")
        return True

    def enumerate_staging(self) -> tuple[tuple[str, ...], tuple[str, ...]]:
        """Return recognized staged paths separately from untouched unknown entries."""

        recognized: list[str] = []
        unknown: list[str] = []
        with self._managed_directories() as (_, staging, _):
            try:
                entries: Any = os.scandir(staging)
                with entries:
                    for entry in entries:
                        if entry.name == ".lock":
                            continue
                        relative = f"staging/{entry.name}"
                        if (
                            _UUID_PART.fullmatch(entry.name) is not None
                            and entry.is_file(follow_symlinks=False)
                        ):
                            identifier = entry.name[:-5]
                            try:
                                validate_uuid(identifier, "intent_id")
                            except ValueError:
                                unknown.append(relative)
                            else:
                                recognized.append(relative)
                        else:
                            unknown.append(relative)
            except OSError as error:
                raise StorageError("could not enumerate staging directory") from error
        return tuple(sorted(recognized)), tuple(sorted(unknown))
