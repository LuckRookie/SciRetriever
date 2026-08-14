"""Raw ``sqlite3`` catalog bootstrap, validation, and short transactions.

The catalog is an intentionally small technical boundary.  It is created
only when the requested final path is absent, validated without mutation when
it already exists, and never migrated or silently replaced.  The public
construction helpers expose a context-managed connection for the SQLite
adapter layer; domain code receives only higher-level ports from bootstrap.
"""

from __future__ import annotations

import os
import sqlite3
import stat
import uuid
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from types import TracebackType
from typing import Final, TypeAlias

from .schema import (
    SCHEMA_FINGERPRINT,
    SCHEMA_MANIFEST,
    SCHEMA_PRODUCT,
    SCHEMA_VERSION,
)

DEFAULT_BUSY_TIMEOUT_MS: Final[int] = 5_000
MAX_BUSY_TIMEOUT_MS: Final[int] = 30_000

_PATH_ERROR = "catalog path is unsafe"
_CONNECTION_ERROR = "catalog connection failed"
_MARKER_ERROR = "catalog schema marker or fingerprint is unsupported"
_MANIFEST_ERROR = "catalog objects do not match the target schema manifest"
_INTEGRITY_ERROR = "catalog integrity validation failed"
_BOOTSTRAP_ERROR = "catalog bootstrap failed"


class CatalogError(RuntimeError):
    """Base class for path-free catalog boundary failures."""

    _DEFAULT_MESSAGE = "catalog operation failed"

    def __init__(self, _message: object | None = None) -> None:
        super().__init__(self._DEFAULT_MESSAGE)


class CatalogPathError(CatalogError):
    """The requested catalog path is not a safe canonical binding."""

    _DEFAULT_MESSAGE = _PATH_ERROR


class UnsupportedCatalogError(CatalogError):
    """An existing file is not exactly the supported catalog schema."""

    _DEFAULT_MESSAGE = _MARKER_ERROR


class CatalogBootstrapError(CatalogError):
    """A fresh catalog could not be durably initialized."""

    _DEFAULT_MESSAGE = _BOOTSTRAP_ERROR


class CatalogConnectionError(CatalogError):
    """Opening or configuring a catalog connection failed."""

    _DEFAULT_MESSAGE = _CONNECTION_ERROR


Checkpoint: TypeAlias = Callable[[str], None]


def _validate_busy_timeout(value: int) -> int:
    if type(value) is not int or not 1 <= value <= MAX_BUSY_TIMEOUT_MS:
        raise ValueError("busy_timeout_ms must be a bounded positive integer")
    return value


def _path_from_input(value: str | os.PathLike[str]) -> Path:
    try:
        raw = os.fspath(value)
    except TypeError as error:
        raise CatalogPathError() from error
    if not isinstance(raw, str) or not raw or "\x00" in raw:
        raise CatalogPathError()
    try:
        path = Path(os.path.abspath(raw))
    except (OSError, ValueError) as error:
        raise CatalogPathError() from error
    if path.name in {"", os.sep, ".", ".."}:
        raise CatalogPathError()
    return path


def _validate_directory_chain(path: Path) -> None:
    """Reject symlink and non-directory path components before binding."""

    parts = path.parts
    if not parts or parts[0] != os.sep:
        raise CatalogPathError()
    current = Path(parts[0])
    for component in parts[1:]:
        current /= component
        try:
            metadata = os.lstat(current)
        except OSError as error:
            raise CatalogPathError() from error
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise CatalogPathError()


def _validate_existing_entry(path: Path) -> None:
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        return
    except OSError as error:
        raise CatalogPathError() from error
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
    ):
        raise CatalogPathError()


def canonical_catalog_path(path: str | os.PathLike[str]) -> Path:
    """Return the safe lexical canonical catalog path.

    The final file is not followed when checking safety.  Existing symlinks,
    hardlinks and non-regular files fail before SQLite is opened. Parent
    components are likewise required to be real directories.
    """

    candidate = _path_from_input(path)
    _validate_directory_chain(candidate.parent)
    _validate_existing_entry(candidate)
    return candidate


def _file_identity(path: Path) -> tuple[int, int]:
    try:
        metadata = os.lstat(path)
    except OSError as error:
        raise CatalogPathError() from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise CatalogPathError()
    return metadata.st_dev, metadata.st_ino


def _assert_file_identity(path: Path, identity: tuple[int, int]) -> None:
    if _file_identity(path) != identity:
        raise CatalogPathError()


def _assert_wal_header(path: Path) -> None:
    """Verify WAL mode from the SQLite file header without opening it."""

    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise UnsupportedCatalogError() from error
    try:
        header = os.read(descriptor, 20)
    except OSError as error:
        raise UnsupportedCatalogError() from error
    finally:
        os.close(descriptor)
    if header[:16] != b"SQLite format 3\x00" or header[18:20] != b"\x02\x02":
        raise UnsupportedCatalogError()


def _sidecars_present(path: Path) -> bool:
    present = False
    for suffix in ("-wal", "-shm", "-journal"):
        sidecar = Path(f"{path}{suffix}")
        try:
            metadata = os.lstat(sidecar)
        except FileNotFoundError:
            continue
        except OSError as error:
            raise CatalogPathError() from error
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise CatalogPathError()
        if metadata.st_nlink != 1:
            raise CatalogPathError()
        present = True
    return present


def _configure_common(connection: sqlite3.Connection, timeout_ms: int) -> None:
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute(f"PRAGMA busy_timeout={timeout_ms}")
    if connection.execute("PRAGMA foreign_keys").fetchone() != (1,):
        raise CatalogConnectionError()
    if connection.execute("PRAGMA busy_timeout").fetchone() != (timeout_ms,):
        raise CatalogConnectionError()


def _journal_mode(connection: sqlite3.Connection) -> str:
    row = connection.execute("PRAGMA journal_mode").fetchone()
    return str(row[0]).casefold() if row else ""


def _integrity_rows(connection: sqlite3.Connection) -> tuple[object, ...]:
    integrity = connection.execute("PRAGMA integrity_check").fetchone()
    foreign_keys = tuple(connection.execute("PRAGMA foreign_key_check").fetchall())
    return (integrity[0] if integrity else None, *foreign_keys)


def _schema_objects(connection: sqlite3.Connection) -> tuple[tuple[str, str, str], ...]:
    rows = connection.execute(
        "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
    ).fetchall()
    return tuple(
        (str(row[0]), str(row[1]), str(row[2]) if row[2] is not None else "") for row in rows
    )


@lru_cache(maxsize=4)
def _schema_objects_from_manifest(
    manifest: tuple[str, ...],
) -> tuple[tuple[str, str, str], ...]:
    """Materialize the exact SQLite objects created by one DDL manifest.

    SQLite itself creates FTS5 shadow tables and may normalize stored DDL.
    Executing the same closed manifest in memory gives validation the exact
    target object set without ignoring indexes, virtual tables, shadow tables,
    triggers, or any other unexpected persistent object in the real catalog.
    """

    if type(manifest) is not tuple or not all(type(statement) is str for statement in manifest):
        raise TypeError("manifest must be a tuple of strings")
    connection = sqlite3.connect(":memory:", isolation_level=None)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        for statement in manifest:
            connection.execute(statement)
        return _schema_objects(connection)
    finally:
        connection.close()


def _expected_objects() -> tuple[tuple[str, str, str], ...]:
    return _schema_objects_from_manifest(SCHEMA_MANIFEST)


def _validate_schema(
    connection: sqlite3.Connection,
    *,
    require_wal: bool = True,
    require_full_sync: bool = False,
    journal_mode_verified: bool = False,
) -> None:
    try:
        marker_rows = connection.execute(
            "SELECT singleton,product,schema_version,schema_fingerprint,created_at "
            "FROM schema_identity"
        ).fetchall()
    except sqlite3.DatabaseError as error:
        raise UnsupportedCatalogError() from error
    if len(marker_rows) != 1:
        raise UnsupportedCatalogError()
    marker = marker_rows[0]
    if marker[:4] != (1, SCHEMA_PRODUCT, SCHEMA_VERSION, SCHEMA_FINGERPRINT):
        raise UnsupportedCatalogError()
    if _schema_objects(connection) != _expected_objects():
        raise UnsupportedCatalogError(_MANIFEST_ERROR)
    if _integrity_rows(connection) != ("ok",):
        raise UnsupportedCatalogError(_INTEGRITY_ERROR)
    if require_wal and not journal_mode_verified and _journal_mode(connection) != "wal":
        raise UnsupportedCatalogError(_INTEGRITY_ERROR)
    if require_full_sync:
        synchronous = connection.execute("PRAGMA synchronous").fetchone()
        if synchronous != (2,):
            raise UnsupportedCatalogError(_INTEGRITY_ERROR)


def _open_read_only(path: Path, timeout_ms: int, *, immutable: bool = False) -> sqlite3.Connection:
    identity = _file_identity(path)
    uri = f"{path.as_uri()}?mode=ro"
    if immutable:
        uri += "&immutable=1"
    try:
        connection = sqlite3.connect(
            uri,
            uri=True,
            timeout=timeout_ms / 1000,
            isolation_level=None,
        )
    except (OSError, sqlite3.Error) as error:
        raise UnsupportedCatalogError() from error
    try:
        _assert_file_identity(path, identity)
        _configure_common(connection, timeout_ms)
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA query_only=ON")
        if connection.execute("PRAGMA query_only").fetchone() != (1,):
            raise CatalogConnectionError()
    except (CatalogError, OSError, sqlite3.Error) as error:
        connection.close()
        if isinstance(error, CatalogError):
            raise
        raise UnsupportedCatalogError() from error
    return connection


def _open_writable(path: Path, timeout_ms: int) -> sqlite3.Connection:
    identity = _file_identity(path)
    try:
        connection = sqlite3.connect(
            str(path),
            timeout=timeout_ms / 1000,
            isolation_level=None,
        )
    except (OSError, sqlite3.Error) as error:
        raise CatalogConnectionError() from error
    try:
        _assert_file_identity(path, identity)
        _configure_common(connection, timeout_ms)
        mode = connection.execute("PRAGMA journal_mode=WAL").fetchone()
        if not mode or str(mode[0]).casefold() != "wal":
            raise CatalogConnectionError()
        connection.execute("PRAGMA synchronous=FULL")
        if connection.execute("PRAGMA synchronous").fetchone() != (2,):
            raise CatalogConnectionError()
        _assert_file_identity(path, identity)
    except (CatalogError, OSError, sqlite3.Error) as error:
        connection.close()
        if isinstance(error, CatalogError):
            raise
        raise CatalogConnectionError() from error
    return connection


def _fsync_file(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise CatalogBootstrapError() from error
    try:
        os.fsync(descriptor)
    except OSError as error:
        raise CatalogBootstrapError() from error
    finally:
        os.close(descriptor)


def _fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise CatalogBootstrapError() from error
    try:
        os.fsync(descriptor)
    except OSError as error:
        raise CatalogBootstrapError() from error
    finally:
        os.close(descriptor)


def _close_sidecars(path: Path) -> None:
    for suffix in ("-wal", "-shm", "-journal"):
        try:
            (Path(f"{path}{suffix}")).unlink()
        except FileNotFoundError:
            pass
        except OSError as error:
            raise CatalogBootstrapError() from error


def _create_temporary_file(path: Path) -> None:
    flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as error:
        raise CatalogBootstrapError() from error
    os.close(descriptor)


def _publish_temporary(path: Path, temporary: Path, checkpoint: Checkpoint | None) -> None:
    try:
        os.link(temporary, path, follow_symlinks=False)
    except FileExistsError:
        # Another creator won the create-if-absent race.  The caller validates
        # that winner before returning a connection.
        return
    except OSError as error:
        raise CatalogBootstrapError() from error

    # Drop the temporary hardlink immediately.  This leaves the published
    # catalog with one link before another creator can validate it, while the
    # same-directory link still provides create-if-absent semantics.
    try:
        temporary.unlink()
    except OSError as error:
        raise CatalogBootstrapError() from error
    if checkpoint is not None:
        checkpoint("after-publication")
    _fsync_directory(path.parent)


def _initialize_temporary(path: Path, timeout_ms: int) -> None:
    try:
        connection = sqlite3.connect(str(path), timeout=timeout_ms / 1000, isolation_level=None)
    except (OSError, sqlite3.Error) as error:
        raise CatalogBootstrapError() from error
    try:
        _configure_common(connection, timeout_ms)
        mode = connection.execute("PRAGMA journal_mode=WAL").fetchone()
        if not mode or str(mode[0]).casefold() != "wal":
            raise CatalogBootstrapError()
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("BEGIN IMMEDIATE")
        try:
            for statement in SCHEMA_MANIFEST:
                connection.execute(statement)
            connection.execute(
                "INSERT INTO schema_identity(singleton,product,schema_version,"
                "schema_fingerprint,created_at) VALUES (1,?,?,?,?)",
                (
                    SCHEMA_PRODUCT,
                    SCHEMA_VERSION,
                    SCHEMA_FINGERPRINT,
                    _utc_now(),
                ),
            )
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        _validate_schema(connection, require_wal=True, require_full_sync=True)
        checkpoint = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        if checkpoint is None or len(checkpoint) != 3 or checkpoint[2] != 0:
            raise CatalogBootstrapError()
    except CatalogError:
        raise
    except (OSError, sqlite3.Error, TypeError, ValueError) as error:
        raise CatalogBootstrapError() from error
    finally:
        try:
            connection.close()
        except sqlite3.Error as error:
            raise CatalogBootstrapError() from error
    _close_sidecars(path)


def _utc_now() -> str:
    import datetime

    return (
        datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )


def _bootstrap(path: Path, timeout_ms: int, checkpoint: Checkpoint | None) -> None:
    temporary = path.parent / f".{path.name}.bootstrap-{uuid.uuid4().hex}.tmp"
    try:
        _create_temporary_file(temporary)
        _initialize_temporary(temporary, timeout_ms)
        _fsync_file(temporary)
        if checkpoint is not None:
            checkpoint("after-temporary-fsync")
        _publish_temporary(path, temporary, checkpoint)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        except OSError as error:
            raise CatalogBootstrapError() from error
        _close_sidecars(temporary)


class CatalogConnection(AbstractContextManager[sqlite3.Connection]):
    """A close-owning connection handle used only inside Storage adapters."""

    __slots__ = ("_connection", "_catalog_path", "_read_only", "_closed")

    def __init__(
        self,
        connection: sqlite3.Connection,
        catalog_path: Path,
        *,
        read_only: bool,
    ) -> None:
        self._connection = connection
        self._catalog_path = catalog_path
        self._read_only = read_only
        self._closed = False

    @property
    def catalog_path(self) -> Path:
        return self._catalog_path

    @property
    def read_only(self) -> bool:
        return self._read_only

    def __enter__(self) -> sqlite3.Connection:
        if self._closed:
            raise CatalogConnectionError()
        return self._connection

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exc_type, exc_value, traceback
        self.close()

    def close(self) -> None:
        if self._closed:
            return
        try:
            if self._connection.in_transaction:
                self._connection.rollback()
            self._connection.close()
        except sqlite3.Error as error:
            raise CatalogConnectionError() from error
        finally:
            self._closed = True


def validate_catalog(
    path: str | os.PathLike[str], *, busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS
) -> None:
    """Validate an existing catalog without creating sidecars or mutating it.

    A clean WAL catalog is opened through SQLite's immutable read-only URI;
    this avoids SQLite creating its shared-memory sidecars merely to inspect
    the main file.  If a caller already has WAL sidecars, normal read-only
    validation is used so pending committed frames remain visible.
    """

    timeout_ms = _validate_busy_timeout(busy_timeout_ms)
    catalog_path = canonical_catalog_path(path)
    if not catalog_path.exists():
        raise CatalogPathError()
    has_sidecars = _sidecars_present(catalog_path)
    if not has_sidecars:
        _assert_wal_header(catalog_path)
    connection = _open_read_only(catalog_path, timeout_ms, immutable=not has_sidecars)
    try:
        _validate_schema(
            connection,
            require_wal=True,
            journal_mode_verified=not has_sidecars,
        )
    except UnsupportedCatalogError:
        raise
    except (CatalogError, sqlite3.Error) as error:
        raise UnsupportedCatalogError() from error
    finally:
        connection.close()


def open_read_only_snapshot(
    path: str | os.PathLike[str], *, busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS
) -> CatalogConnection:
    """Open one validated, query-only, read-only SQLite snapshot."""

    timeout_ms = _validate_busy_timeout(busy_timeout_ms)
    catalog_path = canonical_catalog_path(path)
    if not catalog_path.exists():
        raise CatalogPathError()
    connection = _open_read_only(catalog_path, timeout_ms)
    try:
        _validate_schema(connection, require_wal=True)
        connection.execute("BEGIN")
    except BaseException:
        connection.close()
        raise
    return CatalogConnection(connection, catalog_path, read_only=True)


def create_or_open_catalog(
    path: str | os.PathLike[str],
    *,
    busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS,
    checkpoint: Checkpoint | None = None,
) -> CatalogConnection:
    """Create one fresh catalog atomically or open an existing valid one."""

    timeout_ms = _validate_busy_timeout(busy_timeout_ms)
    catalog_path = canonical_catalog_path(path)
    if not catalog_path.exists():
        _bootstrap(catalog_path, timeout_ms, checkpoint)
    # Whether we won or lost an absent-path race, only the exact schema wins.
    validate_catalog(catalog_path, busy_timeout_ms=timeout_ms)
    connection = _open_writable(catalog_path, timeout_ms)
    try:
        _validate_schema(connection, require_wal=True, require_full_sync=True)
    except BaseException:
        connection.close()
        raise
    return CatalogConnection(connection, catalog_path, read_only=False)


@dataclass(frozen=True, slots=True)
class CatalogEngine:
    """Path-bound factory for short read/write catalog transactions."""

    catalog_path: Path
    busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS

    def __init__(
        self,
        catalog_path: str | os.PathLike[str],
        *,
        busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS,
        create: bool = True,
    ) -> None:
        timeout_ms = _validate_busy_timeout(busy_timeout_ms)
        canonical = canonical_catalog_path(catalog_path)
        if create:
            with create_or_open_catalog(canonical, busy_timeout_ms=timeout_ms):
                pass
        else:
            validate_catalog(canonical, busy_timeout_ms=timeout_ms)
        object.__setattr__(self, "catalog_path", canonical)
        object.__setattr__(self, "busy_timeout_ms", timeout_ms)

    @classmethod
    def open(
        cls,
        catalog_path: str | os.PathLike[str],
        *,
        busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS,
    ) -> CatalogEngine:
        return cls(catalog_path, busy_timeout_ms=busy_timeout_ms, create=False)

    def validate(self) -> None:
        validate_catalog(self.catalog_path, busy_timeout_ms=self.busy_timeout_ms)

    @contextmanager
    def write_transaction(self) -> Iterator[sqlite3.Connection]:
        with create_or_open_catalog(
            self.catalog_path, busy_timeout_ms=self.busy_timeout_ms
        ) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                yield connection
            except BaseException:
                connection.rollback()
                raise
            else:
                connection.commit()

    @contextmanager
    def read_snapshot(self) -> Iterator[sqlite3.Connection]:
        with open_read_only_snapshot(
            self.catalog_path, busy_timeout_ms=self.busy_timeout_ms
        ) as connection:
            yield connection


__all__ = (
    "CatalogBootstrapError",
    "CatalogConnection",
    "CatalogConnectionError",
    "CatalogEngine",
    "CatalogError",
    "CatalogPathError",
    "DEFAULT_BUSY_TIMEOUT_MS",
    "MAX_BUSY_TIMEOUT_MS",
    "UnsupportedCatalogError",
    "canonical_catalog_path",
    "create_or_open_catalog",
    "open_read_only_snapshot",
    "validate_catalog",
)
