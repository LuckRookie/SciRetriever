"""Guarded SQLite engine construction for catalog files."""

from __future__ import annotations

from contextlib import contextmanager
import os
from pathlib import Path
import sqlite3
from typing import Iterator
from urllib.parse import quote

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Connection, Engine

from sciretriever.errors import CatalogError
from sciretriever.workspace import require_staged_write_override


DEFAULT_BUSY_TIMEOUT_MS = 5_000
_RESERVATION_STATE_FIELDS = (
    "st_dev",
    "st_ino",
    "st_mode",
    "st_nlink",
    "st_uid",
    "st_gid",
    "st_size",
    "st_mtime_ns",
    "st_ctime_ns",
)


class CatalogEngine:
    """Catalog-owned wrapper around a configured SQLAlchemy engine."""

    def __init__(self, engine: Engine, path: Path, *, read_only: bool) -> None:
        self.__engine = engine
        self.path = path
        self.read_only = read_only

    @contextmanager
    def connect(self) -> Iterator[Connection]:
        with self.__engine.connect() as connection:
            yield connection

    @contextmanager
    def transaction(self) -> Iterator[Connection]:
        with self.__engine.begin() as connection:
            yield connection

    @contextmanager
    def critical_transaction(self) -> Iterator[Connection]:
        """Acquire SQLite's reserved write lock for a critical admission path."""
        if self.read_only:
            raise CatalogError("A read-only catalog cannot start a critical transaction")
        with self.__engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            try:
                yield connection
            except BaseException:
                connection.rollback()
                raise
            else:
                connection.commit()

    def dispose(self) -> None:
        self.__engine.dispose()


def _validate_timeout(busy_timeout_ms: int) -> int:
    if not isinstance(busy_timeout_ms, int) or isinstance(busy_timeout_ms, bool):
        raise TypeError("busy_timeout_ms must be an integer")
    if busy_timeout_ms < 0:
        raise ValueError("busy_timeout_ms must be nonnegative")
    return busy_timeout_ms


def _sqlite_uri(path: Path, mode: str) -> str:
    encoded_path = quote(path.as_posix(), safe="/:")
    return f"sqlite+pysqlite:///file:{encoded_path}?mode={mode}&uri=true"


def _build_engine(
    path: Path,
    *,
    mode: str,
    read_only: bool,
    busy_timeout_ms: int,
) -> CatalogEngine:
    timeout = _validate_timeout(busy_timeout_ms)
    engine = create_engine(_sqlite_uri(path, mode))

    @event.listens_for(engine, "connect")
    def configure_sqlite(dbapi_connection: sqlite3.Connection, _connection_record: object) -> None:
        dbapi_connection.execute("PRAGMA foreign_keys=ON")
        dbapi_connection.execute(f"PRAGMA busy_timeout={timeout}")

    catalog = CatalogEngine(engine, path, read_only=read_only)
    try:
        with catalog.connect() as connection:
            if not read_only:
                connection.exec_driver_sql("PRAGMA journal_mode=WAL").scalar_one()
    except BaseException:
        catalog.dispose()
        raise
    return catalog


def _resolved_file(path: str | Path) -> Path:
    if not isinstance(path, (str, Path)):
        raise TypeError("catalog path must be a string or Path")
    return Path(path).expanduser().resolve()


def _reserve_catalog_file(path: Path) -> os.stat_result:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    descriptor = os.open(path, flags, 0o600)
    try:
        return os.fstat(descriptor)
    finally:
        os.close(descriptor)


def _remove_unchanged_reservation(path: Path, reserved: os.stat_result) -> None:
    try:
        current = path.lstat()
        unchanged = all(
            getattr(current, field) == getattr(reserved, field)
            for field in _RESERVATION_STATE_FIELDS
        )
        if unchanged:
            path.unlink()
    except OSError:
        pass


def create_catalog_engine(
    path: str | Path,
    *,
    allow_repository_write: bool = False,
    busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS,
) -> CatalogEngine:
    """Create a new writable catalog file after repository-write safety checks."""
    resolved = _resolved_file(path)
    require_staged_write_override(
        resolved,
        allow_staged_write=allow_repository_write,
        start=Path(__file__),
    )
    if not resolved.parent.is_dir():
        raise FileNotFoundError(f"Catalog parent directory does not exist: {resolved.parent}")

    reserved = _reserve_catalog_file(resolved)
    try:
        return _build_engine(
            resolved,
            mode="rw",
            read_only=False,
            busy_timeout_ms=busy_timeout_ms,
        )
    except BaseException:
        _remove_unchanged_reservation(resolved, reserved)
        raise


def open_catalog_engine(
    path: str | Path,
    *,
    allow_repository_write: bool = False,
    busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS,
) -> CatalogEngine:
    """Open an existing catalog for reads and writes without creating it."""
    resolved = _resolved_file(path)
    if not resolved.is_file():
        raise FileNotFoundError(f"Catalog does not exist: {resolved}")
    require_staged_write_override(
        resolved,
        allow_staged_write=allow_repository_write,
        start=Path(__file__),
    )
    return _build_engine(
        resolved,
        mode="rw",
        read_only=False,
        busy_timeout_ms=busy_timeout_ms,
    )


def open_read_only_catalog_engine(
    path: str | Path,
    *,
    busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS,
) -> CatalogEngine:
    """Open an existing catalog through SQLite's fail-closed read-only URI mode."""
    resolved = _resolved_file(path)
    if not resolved.is_file():
        raise FileNotFoundError(f"Catalog does not exist: {resolved}")
    return _build_engine(
        resolved,
        mode="ro",
        read_only=True,
        busy_timeout_ms=busy_timeout_ms,
    )
