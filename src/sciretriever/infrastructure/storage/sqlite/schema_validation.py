from __future__ import annotations

import sqlite3
from typing import Final

from sciretriever.infrastructure.storage.sqlite.schema import SCHEMA_MANIFEST

SchemaObject = tuple[str, str, str, str]


def _normalize(sql: str) -> str:
    return " ".join(sql.split())


def schema_objects(connection: sqlite3.Connection) -> tuple[SchemaObject, ...]:
    rows = connection.execute(
        "SELECT type,name,tbl_name,sql FROM sqlite_master "
        "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' "
        "ORDER BY type,name,tbl_name"
    ).fetchall()
    return tuple((kind, name, table, _normalize(sql)) for kind, name, table, sql in rows)


def _expected_objects() -> tuple[SchemaObject, ...]:
    connection = sqlite3.connect(":memory:")
    try:
        connection.create_function(
            "sciretriever_canonical_json", 1, lambda payload: payload, deterministic=True
        )
        connection.create_function(
            "sciretriever_sha256", 1, lambda payload: payload, deterministic=True
        )
        connection.create_function(
            "sciretriever_metadata_sha256",
            3,
            lambda revision, values, provenance: values,
            deterministic=True,
        )
        connection.execute("PRAGMA foreign_keys=ON")
        for statement in SCHEMA_MANIFEST:
            connection.execute(statement)
        return schema_objects(connection)
    finally:
        connection.close()


EXPECTED_SCHEMA_OBJECTS: Final = _expected_objects()
