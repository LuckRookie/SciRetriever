from __future__ import annotations

import os

from sciretriever.kernel import (
    BoundaryError,
    CanonicalJsonValue,
    ExtensionRecordId,
    OpaqueExtensionRecord,
    Sha256,
    canonical_json_bytes,
    parse_canonical_json,
    validate_page_request,
)
from sciretriever.literature_store.sqlite.engine import create_or_open_catalog


class OpaqueExtensionConflictError(Exception):
    __slots__ = ("namespace", "record_id")

    def __init__(self, namespace: str, record_id: ExtensionRecordId) -> None:
        self.namespace = namespace
        self.record_id = record_id
        super().__init__(namespace, record_id)

    def __str__(self) -> str:
        return f"opaque extension record revision conflict: {self.namespace}/{self.record_id}"


def _record(row: tuple[str, str, int, str, str]) -> OpaqueExtensionRecord:
    namespace, record_id, revision, digest, payload_json = row
    payload = parse_canonical_json(payload_json)
    if canonical_json_bytes(payload).decode("ascii") != payload_json:
        raise BoundaryError.for_field("payload", "must contain canonical JSON bytes")
    return OpaqueExtensionRecord(
        namespace,
        ExtensionRecordId(record_id),
        revision,
        Sha256(digest),
        payload,
    )


class OpaqueExtensionRecordStore:
    def __init__(self, catalog_path: str | os.PathLike[str]) -> None:
        self._catalog_path = catalog_path

    def get(
        self, namespace: str, record_id: ExtensionRecordId
    ) -> OpaqueExtensionRecord | None:
        with create_or_open_catalog(self._catalog_path) as connection:
            row = connection.execute(
                "SELECT namespace,record_id,revision,payload_sha256,payload_json "
                "FROM opaque_extension_records WHERE namespace=? AND record_id=?",
                (namespace, str(record_id)),
            ).fetchone()
        return None if row is None else _record(row)

    def list_namespace(
        self,
        namespace: str,
        after_record_id: ExtensionRecordId | None,
        limit: int,
    ) -> tuple[OpaqueExtensionRecord, ...]:
        after, bounded_limit = validate_page_request(
            after_record_id=after_record_id, limit=limit
        )
        with create_or_open_catalog(self._catalog_path) as connection:
            rows = connection.execute(
                "SELECT namespace,record_id,revision,payload_sha256,payload_json "
                "FROM opaque_extension_records WHERE namespace=? AND record_id>? "
                "ORDER BY record_id LIMIT ?",
                (namespace, "" if after is None else str(after), bounded_limit),
            ).fetchall()
        return tuple(_record(row) for row in rows)

    def compare_and_set(
        self,
        namespace: str,
        record_id: ExtensionRecordId,
        expected_revision: int | None,
        payload: CanonicalJsonValue,
    ) -> OpaqueExtensionRecord:
        payload_bytes = canonical_json_bytes(payload)
        normalized = parse_canonical_json(payload_bytes.decode("ascii"))
        digest = Sha256.from_bytes(payload_bytes)
        revision = 1 if expected_revision is None else expected_revision + 1
        candidate = OpaqueExtensionRecord(
            namespace, record_id, revision, digest, normalized
        )
        with create_or_open_catalog(self._catalog_path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if expected_revision is None:
                cursor = connection.execute(
                    "INSERT OR IGNORE INTO opaque_extension_records "
                    "(namespace,record_id,revision,payload_sha256,payload_json) VALUES (?,?,?,?,?)",
                    (namespace, str(record_id), revision, str(digest), payload_bytes.decode("ascii")),
                )
            else:
                cursor = connection.execute(
                    "UPDATE opaque_extension_records SET revision=?,payload_sha256=?,payload_json=? "
                    "WHERE namespace=? AND record_id=? AND revision=?",
                    (
                        revision,
                        str(digest),
                        payload_bytes.decode("ascii"),
                        namespace,
                        str(record_id),
                        expected_revision,
                    ),
                )
            if cursor.rowcount != 1:
                connection.rollback()
                raise OpaqueExtensionConflictError(namespace, record_id)
            connection.commit()
        return candidate

    def delete(
        self, namespace: str, record_id: ExtensionRecordId, expected_revision: int
    ) -> None:
        with create_or_open_catalog(self._catalog_path) as connection:
            cursor = connection.execute(
                "DELETE FROM opaque_extension_records "
                "WHERE namespace=? AND record_id=? AND revision=?",
                (namespace, str(record_id), expected_revision),
            )
            if cursor.rowcount != 1:
                connection.rollback()
                raise OpaqueExtensionConflictError(namespace, record_id)
            connection.commit()
