"""Bounded, read-only streaming of legacy Paper-shaped SQLite rows."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
import sqlite3
import stat
from urllib.parse import quote

from SciRetriever.database.retired_paths import reject_retired_database_creation


REQUIRED_COLUMNS = frozenset(
    {"id", "title", "authors", "abstract", "doi", "url", "pub_year", "journal", "keywords", "pdf_path"}
)


class LegacySQLiteReader:
    def __init__(self, path: str | Path, *, batch_size: int = 256) -> None:
        if not isinstance(batch_size, int) or isinstance(batch_size, bool) or batch_size <= 0:
            raise ValueError("batch_size must be a positive integer")
        candidate = Path(path).expanduser()
        reject_retired_database_creation(candidate.resolve())
        metadata = candidate.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise ValueError("legacy database must be an existing regular file, not a symlink")
        self.path = candidate.resolve(strict=True)
        self.batch_size = batch_size

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        uri = f"file:{quote(self.path.as_posix(), safe='/:')}?mode=ro"
        connection = sqlite3.connect(uri, uri=True)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
        finally:
            connection.close()

    def rows(self) -> Iterator[dict[str, object]]:
        with self._connection() as connection:
            table = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='papers'"
            ).fetchone()
            if table is None:
                raise ValueError("legacy database has no papers table")
            columns = {row[1] for row in connection.execute("PRAGMA table_info(papers)")}
            missing = REQUIRED_COLUMNS - columns
            if missing:
                raise ValueError(f"legacy papers table is missing columns: {', '.join(sorted(missing))}")
            selected = ", ".join(sorted(REQUIRED_COLUMNS))
            cursor = connection.execute(f"SELECT {selected} FROM papers ORDER BY id")
            while batch := cursor.fetchmany(self.batch_size):
                for row in batch:
                    yield dict(row)


__all__ = ("LegacySQLiteReader", "REQUIRED_COLUMNS")
