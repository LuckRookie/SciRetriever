"""Operator-managed persistent Chrome profile storage and lifecycle safety.

This module owns profile identities, owner-only filesystem validation, the
cross-process profile lease, and explicit removal. It never reads profile file
contents; the package public surface re-exports only its stable boundary.
"""

from __future__ import annotations

import os
import secrets
import stat
from pathlib import Path
from typing import Final, Protocol, runtime_checkable

from sciretriever.model.configuration import (
    BrowserProfilePresence,
    BrowserProfileStatus,
    normalize_browser_profile_identity,
)

from .errors import ConfigurationError
from .errors import fail as _fail
from .filesystem import (
    current_uid as _current_uid,
)
from .filesystem import (
    mode as _mode,
)
from .filesystem import (
    safe_path as _safe_path,
)
from .filesystem import (
    same_identity as _same_identity,
)
from .filesystem import (
    same_metadata as _same_metadata,
)

_CREDENTIALS_DIRECTORY_NAME: Final[str] = ".sciretriever"
_BROWSER_PROFILE_DIRECTORY_NAME: Final[str] = "browser-profiles"
_DIRECTORY_MODE: Final[int] = 0o700
_FILE_MODE: Final[int] = 0o600
_BROWSER_PROFILE_HANDLE_TOKEN: Final[object] = object()


@runtime_checkable
class BrowserProfileCancellation(Protocol):
    """Minimal cancellation seam for local Browser profile initialization."""

    def is_set(self) -> bool: ...


def _browser_profile_identity(value: object) -> str:
    try:
        return normalize_browser_profile_identity(value)
    except (TypeError, ValueError):
        _fail("browser profile identity is invalid")


def _browser_profile_home(home: str | Path | None) -> Path:
    return Path.home() if home is None else _safe_path(home)


def browser_profile_path(
    profile_identity: str,
    *,
    home: str | Path | None = None,
) -> Path:
    """Return one fixed-suffix Browser profile path from an opaque identity."""

    identity = _browser_profile_identity(profile_identity)
    return (
        _browser_profile_home(home)
        / _CREDENTIALS_DIRECTORY_NAME
        / _BROWSER_PROFILE_DIRECTORY_NAME
        / identity
    )


def _profile_lstat(path: Path, *, missing_ok: bool) -> os.stat_result | None:
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        if missing_ok:
            return None
        _fail("browser profile is unavailable")
    except OSError:
        _fail("browser profile storage is unavailable")
    if stat.S_ISLNK(metadata.st_mode):
        _fail("browser profile contains an unsafe filesystem entry")
    return metadata


def _validate_profile_directory_metadata(metadata: os.stat_result) -> None:
    if not stat.S_ISDIR(metadata.st_mode):
        _fail("browser profile contains an unsafe filesystem entry")
    if metadata.st_uid != _current_uid() or _mode(metadata) != _DIRECTORY_MODE:
        _fail("browser profile has unsafe ownership or permissions")


def _validate_profile_file_metadata(metadata: os.stat_result) -> None:
    if not stat.S_ISREG(metadata.st_mode):
        _fail("browser profile contains an unsafe filesystem entry")
    if metadata.st_uid != _current_uid() or _mode(metadata) != _FILE_MODE or metadata.st_nlink != 1:
        _fail("browser profile has unsafe ownership or permissions")


def _profile_directory_flags() -> int:
    flags = os.O_RDONLY
    for name in ("O_CLOEXEC", "O_DIRECTORY", "O_NOFOLLOW", "O_BINARY"):
        value = getattr(os, name, 0)
        if isinstance(value, int):
            flags |= value
    return flags


def _profile_file_flags() -> int:
    flags = os.O_RDONLY
    for name in ("O_CLOEXEC", "O_NOFOLLOW", "O_BINARY"):
        value = getattr(os, name, 0)
        if isinstance(value, int):
            flags |= value
    return flags


def _open_profile_directory(path: Path) -> tuple[int, os.stat_result]:
    named = _profile_lstat(path, missing_ok=False)
    if named is None:  # pragma: no cover - guarded by ``missing_ok``.
        _fail("browser profile is unavailable")
    _validate_profile_directory_metadata(named)
    try:
        descriptor = os.open(path, _profile_directory_flags())
    except OSError:
        _fail("browser profile storage is unavailable")
    try:
        opened = os.fstat(descriptor)
        _validate_profile_directory_metadata(opened)
        named_after = _profile_lstat(path, missing_ok=False)
        if named_after is None or not _same_identity(named_after, opened):
            _fail("browser profile changed during validation")
        return descriptor, opened
    except BaseException:
        os.close(descriptor)
        raise


def _open_profile_child(
    parent_descriptor: int,
    name: str,
    expected: os.stat_result,
    *,
    directory: bool,
) -> tuple[int, os.stat_result]:
    flags = _profile_directory_flags() if directory else _profile_file_flags()
    try:
        descriptor = os.open(name, flags, dir_fd=parent_descriptor)
    except OSError:
        _fail("browser profile changed during validation")
    try:
        opened = os.fstat(descriptor)
        if directory:
            _validate_profile_directory_metadata(opened)
        else:
            _validate_profile_file_metadata(opened)
        if not _same_identity(expected, opened):
            _fail("browser profile changed during validation")
        return descriptor, opened
    except BaseException:
        os.close(descriptor)
        raise


def _validate_profile_directory_tree(
    descriptor: int,
    expected: os.stat_result,
) -> None:
    try:
        with os.scandir(descriptor) as entries:
            for entry in entries:
                try:
                    metadata = entry.stat(follow_symlinks=False)
                except OSError:
                    _fail("browser profile changed during validation")
                if stat.S_ISLNK(metadata.st_mode):
                    _fail("browser profile contains an unsafe filesystem entry")
                if stat.S_ISDIR(metadata.st_mode):
                    child, child_metadata = _open_profile_child(
                        descriptor,
                        entry.name,
                        metadata,
                        directory=True,
                    )
                    try:
                        _validate_profile_directory_tree(child, child_metadata)
                    finally:
                        os.close(child)
                    continue
                if stat.S_ISREG(metadata.st_mode):
                    child, child_metadata = _open_profile_child(
                        descriptor,
                        entry.name,
                        metadata,
                        directory=False,
                    )
                    try:
                        after = os.fstat(child)
                        _validate_profile_file_metadata(after)
                        if not _same_metadata(child_metadata, after):
                            _fail("browser profile changed during validation")
                    finally:
                        os.close(child)
                    continue
                _fail("browser profile contains an unsafe filesystem entry")
        after = os.fstat(descriptor)
    except ConfigurationError:
        raise
    except (OSError, RecursionError):
        _fail("browser profile changed during validation")
    _validate_profile_directory_metadata(after)
    if not _same_metadata(expected, after):
        _fail("browser profile changed during validation")


def _validate_profile_tree(path: Path) -> os.stat_result:
    descriptor, metadata = _open_profile_directory(path)
    try:
        _validate_profile_directory_tree(descriptor, metadata)
        final = os.fstat(descriptor)
        named = _profile_lstat(path, missing_ok=False)
        if named is None or not _same_identity(named, final):
            _fail("browser profile changed during validation")
        return final
    finally:
        os.close(descriptor)


def _validate_or_create_profile_directory(path: Path, *, create: bool) -> bool:
    metadata = _profile_lstat(path, missing_ok=True)
    created = False
    if metadata is None:
        if not create:
            return False
        try:
            path.mkdir(mode=_DIRECTORY_MODE, parents=False, exist_ok=False)
            created = True
        except FileExistsError:
            pass
        except OSError:
            _fail("browser profile storage is unavailable")
    descriptor, _metadata = _open_profile_directory(path)
    try:
        if created:
            try:
                os.fchmod(descriptor, _DIRECTORY_MODE)
            except OSError:
                _fail("browser profile storage is unavailable")
        current = os.fstat(descriptor)
        _validate_profile_directory_metadata(current)
    finally:
        os.close(descriptor)
    return True


def _browser_profile_storage(
    home: Path,
    *,
    create: bool,
) -> Path | None:
    private_directory = home / _CREDENTIALS_DIRECTORY_NAME
    if not _validate_or_create_profile_directory(private_directory, create=create):
        return None
    profile_storage = private_directory / _BROWSER_PROFILE_DIRECTORY_NAME
    if not _validate_or_create_profile_directory(profile_storage, create=create):
        return None
    return profile_storage


def _check_browser_profile_cancel(
    cancel_event: BrowserProfileCancellation | None,
) -> None:
    if cancel_event is None:
        return
    try:
        cancelled = cancel_event.is_set()
    except Exception:
        _fail("browser profile operation was cancelled")
    if type(cancelled) is not bool or cancelled:
        _fail("browser profile operation was cancelled")


def check_browser_profile_cancel(
    cancel_event: BrowserProfileCancellation | None,
) -> None:
    """Validate the cancellation seam without disclosing profile details."""

    _check_browser_profile_cancel(cancel_event)


def _profile_child_metadata(
    storage_descriptor: int,
    identity: str,
) -> os.stat_result | None:
    try:
        return os.stat(identity, dir_fd=storage_descriptor, follow_symlinks=False)
    except FileNotFoundError:
        return None
    except OSError:
        _fail("browser profile storage is unavailable")


def _remove_created_profile_directory(
    storage_descriptor: int,
    identity: str,
    expected: os.stat_result,
) -> None:
    try:
        current = os.stat(identity, dir_fd=storage_descriptor, follow_symlinks=False)
        if not _same_identity(expected, current):
            _fail("browser profile cleanup failed")
        os.rmdir(identity, dir_fd=storage_descriptor)
    except ConfigurationError:
        raise
    except OSError:
        _fail("browser profile cleanup failed")


def _create_profile_child(
    storage_descriptor: int,
    identity: str,
) -> tuple[int, os.stat_result] | None:
    created_metadata: os.stat_result | None = None
    descriptor: int | None = None
    try:
        try:
            os.mkdir(identity, _DIRECTORY_MODE, dir_fd=storage_descriptor)
            created_metadata = os.stat(
                identity,
                dir_fd=storage_descriptor,
                follow_symlinks=False,
            )
        except FileExistsError:
            return None
        except OSError:
            _fail("browser profile storage is unavailable")
        try:
            descriptor = os.open(
                identity,
                _profile_directory_flags(),
                dir_fd=storage_descriptor,
            )
            os.fchmod(descriptor, _DIRECTORY_MODE)
            opened = os.fstat(descriptor)
            _validate_profile_directory_metadata(opened)
            if created_metadata is None or not _same_identity(created_metadata, opened):
                _fail("browser profile changed during validation")
            return descriptor, opened
        except OSError:
            _fail("browser profile storage is unavailable")
    except BaseException:
        if descriptor is not None:
            os.close(descriptor)
        if created_metadata is not None:
            _remove_created_profile_directory(
                storage_descriptor,
                identity,
                created_metadata,
            )
        raise


def _create_browser_profile_directory(
    storage: Path,
    identity: str,
    cancel_event: BrowserProfileCancellation | None,
) -> None:
    storage_descriptor, _storage_metadata = _open_profile_directory(storage)
    profile_descriptor: int | None = None
    created_metadata: os.stat_result | None = None
    try:
        if _profile_child_metadata(storage_descriptor, identity) is not None:
            _check_browser_profile_cancel(cancel_event)
            return
        _check_browser_profile_cancel(cancel_event)
        created = _create_profile_child(storage_descriptor, identity)
        if created is None:
            _check_browser_profile_cancel(cancel_event)
            return
        profile_descriptor, created_metadata = created
        try:
            _check_browser_profile_cancel(cancel_event)
        except BaseException:
            os.close(profile_descriptor)
            profile_descriptor = None
            _remove_created_profile_directory(
                storage_descriptor,
                identity,
                created_metadata,
            )
            raise
    finally:
        if profile_descriptor is not None:
            os.close(profile_descriptor)
        os.close(storage_descriptor)


class BrowserProfileHandle:
    """Opaque, revalidated selection for one sensitive Browser profile."""

    __slots__ = ("_device", "_home", "_identity", "_inode")

    def __init__(
        self,
        identity: str,
        home: Path,
        metadata: os.stat_result,
        *,
        _token: object,
    ) -> None:
        if _token is not _BROWSER_PROFILE_HANDLE_TOKEN:
            raise TypeError("BrowserProfileHandle must be created by configuration")
        self._identity = identity
        self._home = home
        self._device = metadata.st_dev
        self._inode = metadata.st_ino

    @property
    def profile_identity(self) -> str:
        return self._identity

    def runtime_directory(self) -> Path:
        """Revalidate the selected profile immediately before runtime launch."""

        path, metadata = _resolve_browser_profile_metadata(self._identity, self._home)
        if metadata.st_dev != self._device or metadata.st_ino != self._inode:
            _fail("browser profile changed during validation")
        return path

    def acquire_runtime(self) -> BrowserProfileRuntimeLease:
        """Lock and revalidate this profile for exactly one Chrome process."""

        directory = self.runtime_directory()
        lease = _acquire_browser_profile_runtime_lock(
            self._identity,
            self._home,
            directory,
        )
        try:
            if self.runtime_directory() != directory:
                _fail("browser profile changed during validation")
        except BaseException:
            lease.close()
            raise
        return lease

    def __repr__(self) -> str:
        return f"BrowserProfileHandle(presence={BrowserProfilePresence.CONFIGURED.value!r})"

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("Browser profile handle is not serializable")


class BrowserProfileRuntimeLease:
    """Opaque exclusive lease proving one profile is owned by one process."""

    __slots__ = ("_closed", "_descriptor", "_directory")

    def __init__(self, descriptor: int, directory: Path) -> None:
        self._descriptor = descriptor
        self._directory = directory
        self._closed = False

    @property
    def directory(self) -> Path:
        if self._closed:
            _fail("browser profile is unavailable")
        return self._directory

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        descriptor = self._descriptor
        self._descriptor = -1
        try:
            _release_profile_descriptor_lock(descriptor)
        finally:
            os.close(descriptor)

    def __enter__(self) -> BrowserProfileRuntimeLease:
        return self

    def __exit__(self, *unused: object) -> None:
        self.close()

    def __repr__(self) -> str:
        return "BrowserProfileRuntimeLease(locked=True)"

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("Browser profile runtime lease is not serializable")


def _lock_profile_descriptor(descriptor: int) -> None:
    try:
        if os.name == "nt":  # pragma: no cover - exercised on Windows CI only.
            import msvcrt

            if os.fstat(descriptor).st_size == 0:
                os.write(descriptor, b"0")
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, ValueError):
        _fail("browser profile is already in use")


def _release_profile_descriptor_lock(descriptor: int) -> None:
    try:
        if os.name == "nt":  # pragma: no cover - exercised on Windows CI only.
            import msvcrt

            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_UN)
    except (OSError, ValueError):
        return


def _profile_lock_directory(home: Path) -> Path:
    storage = _browser_profile_storage(home, create=True)
    if storage is None:  # pragma: no cover - create=True either returns or raises.
        _fail("browser profile storage is unavailable")
    directory = storage / ".locks"
    _validate_or_create_profile_directory(directory, create=True)
    return directory


def _acquire_browser_profile_runtime_lock(
    identity: str,
    home: Path,
    directory: Path,
) -> BrowserProfileRuntimeLease:
    lock_directory = _profile_lock_directory(home)
    flags = os.O_RDWR | os.O_CREAT
    for name in ("O_CLOEXEC", "O_NOFOLLOW", "O_BINARY"):
        value = getattr(os, name, 0)
        if isinstance(value, int):
            flags |= value
    try:
        descriptor = os.open(lock_directory / f"{identity}.lock", flags, _FILE_MODE)
    except OSError:
        _fail("browser profile storage is unavailable")
    try:
        os.fchmod(descriptor, _FILE_MODE)
        metadata = os.fstat(descriptor)
        _validate_profile_file_metadata(metadata)
        _lock_profile_descriptor(descriptor)
        return BrowserProfileRuntimeLease(descriptor, directory)
    except BaseException:
        os.close(descriptor)
        raise


def _resolve_browser_profile_metadata(
    identity: str,
    home: Path,
) -> tuple[Path, os.stat_result]:
    storage = _browser_profile_storage(home, create=False)
    if storage is None:
        _fail("browser profile is unavailable")
    path = storage / identity
    if _profile_lstat(path, missing_ok=True) is None:
        _fail("browser profile is unavailable")
    return path, _validate_profile_tree(path)


def resolve_browser_profile(
    profile_identity: str,
    *,
    home: str | Path | None = None,
) -> BrowserProfileHandle:
    """Resolve one fixed local profile without reading any of its file bytes."""

    identity = _browser_profile_identity(profile_identity)
    selected_home = _browser_profile_home(home)
    _path, metadata = _resolve_browser_profile_metadata(identity, selected_home)
    return BrowserProfileHandle(
        identity,
        selected_home,
        metadata,
        _token=_BROWSER_PROFILE_HANDLE_TOKEN,
    )


def initialize_browser_profile(
    profile_identity: str,
    *,
    home: str | Path | None = None,
    cancel_event: BrowserProfileCancellation | None = None,
) -> BrowserProfileHandle:
    """Create or select an empty owner-only profile through the fixed boundary."""

    identity = _browser_profile_identity(profile_identity)
    if cancel_event is not None and not isinstance(cancel_event, BrowserProfileCancellation):
        _fail("configuration value is invalid")
    _check_browser_profile_cancel(cancel_event)
    selected_home = _browser_profile_home(home)
    storage = _browser_profile_storage(selected_home, create=True)
    if storage is None:  # pragma: no cover - ``create=True`` either returns or raises.
        _fail("browser profile storage is unavailable")
    _check_browser_profile_cancel(cancel_event)
    _create_browser_profile_directory(storage, identity, cancel_event)
    return resolve_browser_profile(identity, home=selected_home)


def browser_profile_status(
    profile_identity: str | None,
    *,
    home: str | Path | None = None,
) -> BrowserProfileStatus:
    """Return only configured/missing/attention for one local profile selection."""

    if profile_identity is None:
        return BrowserProfileStatus(presence=BrowserProfilePresence.MISSING)
    try:
        identity = _browser_profile_identity(profile_identity)
        selected_home = _browser_profile_home(home)
        storage = _browser_profile_storage(selected_home, create=False)
        if storage is None:
            return BrowserProfileStatus(presence=BrowserProfilePresence.MISSING)
        path = storage / identity
        if _profile_lstat(path, missing_ok=True) is None:
            return BrowserProfileStatus(presence=BrowserProfilePresence.MISSING)
        _validate_profile_tree(path)
    except (ConfigurationError, OSError, RecursionError):
        return BrowserProfileStatus(presence=BrowserProfilePresence.ATTENTION)
    return BrowserProfileStatus(presence=BrowserProfilePresence.CONFIGURED)


def _profile_removal_name(storage_descriptor: int) -> str:
    for _attempt in range(8):
        candidate = f".removing-{secrets.token_hex(12)}"
        if _profile_child_metadata(storage_descriptor, candidate) is None:
            return candidate
    _fail("browser profile removal failed")


def _profile_entry_metadata(entry: os.DirEntry[str]) -> os.stat_result:
    try:
        return entry.stat(follow_symlinks=False)
    except OSError:
        _fail("browser profile removal failed")


def _named_profile_identity(
    descriptor: int,
    name: str,
    *expected: os.stat_result,
) -> os.stat_result:
    try:
        named = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
    except OSError:
        _fail("browser profile removal failed")
    if any(not _same_identity(item, named) for item in expected):
        _fail("browser profile changed during removal")
    return named


def _remove_profile_file(
    descriptor: int,
    name: str,
    metadata: os.stat_result,
) -> None:
    child, opened = _open_profile_child(
        descriptor,
        name,
        metadata,
        directory=False,
    )
    try:
        final = os.fstat(child)
        _validate_profile_file_metadata(final)
    except OSError:
        _fail("browser profile removal failed")
    finally:
        os.close(child)
    _named_profile_identity(descriptor, name, opened, final)
    try:
        os.unlink(name, dir_fd=descriptor)
    except OSError:
        _fail("browser profile removal failed")


def _remove_profile_child_directory(
    descriptor: int,
    name: str,
    metadata: os.stat_result,
) -> None:
    child, opened = _open_profile_child(
        descriptor,
        name,
        metadata,
        directory=True,
    )
    try:
        _remove_profile_directory_contents(child)
        final = os.fstat(child)
        _validate_profile_directory_metadata(final)
    except OSError:
        _fail("browser profile removal failed")
    finally:
        os.close(child)
    _named_profile_identity(descriptor, name, opened, final)
    try:
        os.rmdir(name, dir_fd=descriptor)
    except OSError:
        _fail("browser profile removal failed")


def _remove_profile_directory_contents(descriptor: int) -> None:
    try:
        with os.scandir(descriptor) as entries:
            children = tuple(entries)
    except OSError:
        _fail("browser profile removal failed")
    for entry in children:
        metadata = _profile_entry_metadata(entry)
        if stat.S_ISDIR(metadata.st_mode):
            _remove_profile_child_directory(descriptor, entry.name, metadata)
        elif stat.S_ISREG(metadata.st_mode):
            _remove_profile_file(descriptor, entry.name, metadata)
        else:
            _fail("browser profile contains an unsafe filesystem entry")
    try:
        _validate_profile_directory_metadata(os.fstat(descriptor))
    except OSError:
        _fail("browser profile removal failed")


def _prepare_profile_removal(
    storage_descriptor: int,
    identity: str,
) -> tuple[int, os.stat_result, str] | None:
    metadata = _profile_child_metadata(storage_descriptor, identity)
    if metadata is None:
        return None
    profile_descriptor, opened = _open_profile_child(
        storage_descriptor,
        identity,
        metadata,
        directory=True,
    )
    try:
        _validate_profile_directory_tree(profile_descriptor, opened)
        final = os.fstat(profile_descriptor)
        removal_name = _profile_removal_name(storage_descriptor)
        try:
            os.rename(
                identity,
                removal_name,
                src_dir_fd=storage_descriptor,
                dst_dir_fd=storage_descriptor,
            )
        except OSError:
            _fail("browser profile removal failed")
        _named_profile_identity(storage_descriptor, removal_name, final)
        return profile_descriptor, final, removal_name
    except BaseException:
        os.close(profile_descriptor)
        raise


def _finish_profile_removal(
    storage_descriptor: int,
    removal_name: str,
    expected: os.stat_result,
) -> None:
    _named_profile_identity(storage_descriptor, removal_name, expected)
    try:
        os.rmdir(removal_name, dir_fd=storage_descriptor)
    except OSError:
        _fail("browser profile removal failed")
    try:
        os.fsync(storage_descriptor)
    except OSError:
        # The deletion is already visible.  A durability failure cannot
        # restore the removed sensitive session or be reported as if it were
        # still present.
        pass


def remove_browser_profile(
    profile_identity: str,
    *,
    home: str | Path | None = None,
) -> bool:
    """Remove one explicitly selected local Browser session without reading it.

    The selected tree is fully validated before it is renamed inside the fixed
    owner-only profile directory.  Recursive removal then operates only on
    no-follow descriptors, so a symlink or replacement cannot redirect the
    operation outside that private directory.  Missing profiles are a safe
    no-op; unsafe profiles fail closed and require operator inspection.
    """

    identity = _browser_profile_identity(profile_identity)
    selected_home = _browser_profile_home(home)
    storage = _browser_profile_storage(selected_home, create=False)
    if storage is None:
        return False
    if _profile_lstat(storage / identity, missing_ok=True) is None:
        return False
    runtime_lease = _acquire_browser_profile_runtime_lock(
        identity,
        selected_home,
        storage / identity,
    )
    try:
        storage_descriptor, _storage_metadata = _open_profile_directory(storage)
        try:
            prepared = _prepare_profile_removal(storage_descriptor, identity)
            if prepared is None:
                return False
            profile_descriptor, expected, removal_name = prepared
            try:
                _remove_profile_directory_contents(profile_descriptor)
                final = os.fstat(profile_descriptor)
                if not _same_identity(expected, final):
                    _fail("browser profile changed during removal")
            finally:
                os.close(profile_descriptor)
            _finish_profile_removal(storage_descriptor, removal_name, final)
            return True
        finally:
            os.close(storage_descriptor)
    finally:
        runtime_lease.close()


__all__ = (
    "BrowserProfileCancellation",
    "BrowserProfileHandle",
    "BrowserProfilePresence",
    "BrowserProfileRuntimeLease",
    "BrowserProfileStatus",
    "browser_profile_path",
    "browser_profile_status",
    "check_browser_profile_cancel",
    "initialize_browser_profile",
    "remove_browser_profile",
    "resolve_browser_profile",
)
