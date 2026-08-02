from __future__ import annotations

import hashlib
import os
import sqlite3
from collections.abc import Callable, Iterator
from contextlib import contextmanager

from sciretriever.collection.api import CollectionAcceptanceConflict
from sciretriever.literature_store.sqlite.engine import create_or_open_catalog
from sciretriever.model.literature import PreparedBibliographyAcceptance


class StalePublicationError(CollectionAcceptanceConflict):
    pass


class StatementFailpoint:
    def __init__(self, callback: Callable[[str], None] | None) -> None:
        self._callback = callback
        self.count = 0

    def wrote(self) -> None:
        self.count += 1
        if self._callback is not None:
            self._callback(f"after-write-{self.count}")

    def before_commit(self) -> None:
        if self._callback is not None:
            self._callback("before-commit")


@contextmanager
def immediate(path: str | os.PathLike[str]) -> Iterator[sqlite3.Connection]:
    with create_or_open_catalog(path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        with connection:
            yield connection


def execute(
    connection: sqlite3.Connection, point: StatementFailpoint, sql: str, values: tuple = ()
) -> sqlite3.Cursor:
    cursor = connection.execute(sql, values)
    point.wrote()
    return cursor


def _identity_revision(connection: sqlite3.Connection, version_id: str) -> str | None:
    row = connection.execute(
        "SELECT v.work_id,v.version_role,s.values_json FROM work_versions v LEFT JOIN "
        "work_version_current_metadata c ON c.work_version_id=v.id LEFT JOIN metadata_snapshots "
        "s ON s.id=c.metadata_snapshot_id WHERE v.id=?",
        (version_id,),
    ).fetchone()
    if row is None:
        return None
    identifiers = connection.execute(
        "SELECT namespace,value FROM stable_identifiers WHERE work_version_id=? ORDER BY "
        "namespace,value",
        (version_id,),
    ).fetchall()
    payload = "|".join(
        (
            row[0],
            version_id,
            row[1],
            *(f"{item[0]}:{item[1]}" for item in identifiers),
            row[2] or "",
        )
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def publish_bibliography(
    connection: sqlite3.Connection,
    point: StatementFailpoint,
    prepared: PreparedBibliographyAcceptance,
) -> None:
    for expected in prepared.expected_revisions:
        if _identity_revision(connection, str(expected.work_version_id)) != str(expected.revision):
            raise StalePublicationError("bibliography identity revision changed")
    execute(
        connection, point, "INSERT OR IGNORE INTO works(id) VALUES(?)", (str(prepared.work_id),)
    )
    execute(
        connection,
        point,
        "INSERT OR IGNORE INTO work_versions(id,work_id,version_role) VALUES(?,?,?)",
        (str(prepared.work_version_id), str(prepared.work_id), prepared.version_role),
    )
    if prepared.role_update is not None:
        update = prepared.role_update
        cursor = execute(
            connection,
            point,
            "UPDATE work_versions SET version_role=? WHERE id=? AND version_role=?",
            (update.role, str(update.work_version_id), update.expected_role),
        )
        if cursor.rowcount != 1:
            raise StalePublicationError("bibliography role changed")
    for identity in prepared.superseded_identities:
        execute(
            connection,
            point,
            "UPDATE stable_identifiers SET work_version_id=? WHERE work_version_id=?",
            (str(prepared.work_version_id), str(identity.work_version_id)),
        )
        execute(
            connection,
            point,
            "UPDATE metadata_observations SET work_version_id=? WHERE work_version_id=?",
            (str(prepared.work_version_id), str(identity.work_version_id)),
        )
        execute(
            connection,
            point,
            "DELETE FROM work_representative_versions WHERE work_id=?",
            (str(identity.work_id),),
        )
        execute(
            connection,
            point,
            "DELETE FROM work_versions WHERE id=?",
            (str(identity.work_version_id),),
        )
        execute(
            connection,
            point,
            "DELETE FROM works WHERE id=? AND NOT EXISTS(SELECT 1 FROM work_versions WHERE "
            "work_id=?)",
            (str(identity.work_id), str(identity.work_id)),
        )
    for identifier in prepared.identifiers:
        execute(
            connection,
            point,
            "INSERT OR IGNORE INTO stable_identifiers(id,work_version_id,namespace,value) "
            "VALUES(?,?,?,?)",
            (
                str(identifier.identifier_id),
                str(prepared.work_version_id),
                identifier.value.namespace,
                identifier.value.value,
            ),
        )
    for observation in prepared.observations:
        execute(
            connection,
            point,
            "INSERT OR IGNORE INTO metadata_observations(id,work_version_id,provider,"
            "provider_record_id,payload_sha256,payload_json,observed_at) VALUES(?,?,?,?,?,?,?)",
            (
                str(observation.observation_id),
                str(prepared.work_version_id),
                observation.provider,
                observation.provider_record_id,
                str(observation.payload_sha256),
                observation.payload_json,
                str(observation.observed_at),
            ),
        )
    if prepared.metadata_snapshot is not None:
        snapshot = prepared.metadata_snapshot
        execute(
            connection,
            point,
            "INSERT OR IGNORE INTO metadata_snapshots(id,work_version_id,revision,sha256,"
            "values_json,provenance_json) VALUES(?,?,?,?,?,?)",
            (
                str(snapshot.snapshot_id),
                str(prepared.work_version_id),
                snapshot.revision,
                str(snapshot.sha256),
                snapshot.values_json,
                snapshot.provenance_json,
            ),
        )
        execute(
            connection,
            point,
            "INSERT INTO work_version_current_metadata(work_version_id,metadata_snapshot_id) "
            "VALUES(?,?) ON CONFLICT(work_version_id) DO UPDATE SET "
            "metadata_snapshot_id=excluded.metadata_snapshot_id",
            (str(prepared.work_version_id), str(snapshot.snapshot_id)),
        )
        execute(
            connection,
            point,
            "DELETE FROM metadata_fts WHERE work_version_id=?",
            (str(prepared.work_version_id),),
        )
        execute(
            connection,
            point,
            "INSERT INTO metadata_fts(work_version_id,content) VALUES(?,?)",
            (str(prepared.work_version_id), snapshot.values_json),
        )
    execute(
        connection,
        point,
        "INSERT INTO work_representative_versions(work_id,work_version_id) VALUES(?,?) ON "
        "CONFLICT(work_id) DO UPDATE SET work_version_id=excluded.work_version_id",
        (str(prepared.work_id), str(prepared.representative_version_id)),
    )
    for relation in prepared.version_relations:
        execute(
            connection,
            point,
            "INSERT OR IGNORE INTO work_version_relations(id,left_version_id,right_version_id,"
            "relation) VALUES(?,?,?,?)",
            (
                str(relation.relation_id),
                str(relation.left_version_id),
                str(relation.right_version_id),
                relation.relation,
            ),
        )
