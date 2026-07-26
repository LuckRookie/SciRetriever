from __future__ import annotations

import json

from sqlalchemy.engine import Connection

from sciretriever.catalog.curation_contracts import CurationCapture
from sciretriever.core.snapshots import SafeSnapshot


def author_topology_bytes(connection: Connection, source_id: str, target_id: str) -> bytes:
    authors = connection.exec_driver_sql(
        "SELECT * FROM authors WHERE id IN (?,?) ORDER BY id", (source_id, target_id)
    ).all()
    authorships = connection.exec_driver_sql(
        "SELECT * FROM authorships WHERE author_id IN (?,?) ORDER BY work_version_id,position,id",
        (source_id, target_id),
    ).all()
    values = (
        ("authors", tuple(tuple(value for value in row) for row in authors)),
        ("authorships", tuple(tuple(value for value in row) for row in authorships)),
    )
    return json.dumps(values, ensure_ascii=True, separators=(",", ":")).encode("ascii")


def author_capture(
    connection: Connection,
    source_id: str,
    target_id: str,
    snapshot: SafeSnapshot,
) -> CurationCapture:
    return CurationCapture(snapshot, author_topology_bytes(connection, source_id, target_id))


__all__ = ("author_capture", "author_topology_bytes")
