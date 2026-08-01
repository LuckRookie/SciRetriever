from __future__ import annotations

import os
import sqlite3
from collections.abc import Callable

from sciretriever.bibliography.api import (
    CurationCommit,
    CurationStaleError,
    MembershipMove,
    ReferenceRetarget,
    ValidatedCurationPlan,
)
from sciretriever.literature_store.sqlite.curation_authorization import authorize_plan_sources
from sciretriever.literature_store.sqlite.curation_snapshot import snapshot_token
from sciretriever.literature_store.sqlite.engine import create_or_open_catalog


def _one(cursor: sqlite3.Cursor, subject: str) -> None:
    if cursor.rowcount != 1:
        raise sqlite3.IntegrityError(f"curation source is missing or ambiguous: {subject}")


def _retarget_reference(connection: sqlite3.Connection, item: ReferenceRetarget) -> None:
    if item.downgrade_raw_text is None:
        cursor = connection.execute(
            "UPDATE reference_members SET target_work_id=?,target_work_version_id=? WHERE id=?",
            (
                None if item.target_work_id is None else str(item.target_work_id),
                None if item.target_version_id is None else str(item.target_version_id),
                str(item.reference_id),
            ),
        )
        _one(cursor, str(item.reference_id))
        return
    if item.downgrade_reference_json is None:
        raise sqlite3.IntegrityError("reference downgrade requires canonical payload")
    row = connection.execute(
        "SELECT reference_set_id,ordinal FROM reference_members WHERE id=?",
        (str(item.reference_id),),
    ).fetchone()
    if row is None:
        raise sqlite3.IntegrityError("reference downgrade source is missing")
    connection.execute(
        "INSERT INTO unresolved_references(id,reference_set_id,ordinal,raw_text,reference_json) "
        "VALUES(?,?,?,?,?)",
        (
            str(item.reference_id),
            row[0],
            row[1],
            item.downgrade_raw_text,
            item.downgrade_reference_json,
        ),
    )
    connection.execute("DELETE FROM reference_members WHERE id=?", (str(item.reference_id),))


def _validate_membership_move(connection: sqlite3.Connection, item: MembershipMove) -> None:
    source = connection.execute(
        "SELECT collection_id,work_id FROM collection_memberships WHERE id=?",
        (str(item.membership_id),),
    ).fetchone()
    if source is None:
        raise sqlite3.IntegrityError("membership move source is missing")
    if item.coalesce_membership_id is None:
        if source[1] == str(item.target_work_id):
            raise sqlite3.IntegrityError("membership move must change Work")
        return
    target = connection.execute(
        "SELECT collection_id,work_id FROM collection_memberships WHERE id=?",
        (str(item.coalesce_membership_id),),
    ).fetchone()
    if target is None or target[0] != source[0] or target[1] != str(item.target_work_id):
        raise sqlite3.IntegrityError(
            "membership coalesce target must share Collection and destination Work"
        )
    invalid = connection.execute(
        "SELECT 1 FROM (SELECT collection_run_id FROM collection_causes WHERE membership_id=? "
        "UNION ALL SELECT collection_run_id FROM collection_paths WHERE membership_id=?) x "
        "LEFT JOIN collection_runs r ON r.id=x.collection_run_id "
        "WHERE r.collection_id IS NULL OR r.collection_id<>? LIMIT 1",
        (str(item.membership_id), str(item.membership_id), source[0]),
    ).fetchone()
    if invalid is not None:
        raise sqlite3.IntegrityError("membership provenance run must belong to its Collection")


class SqliteCurationTransaction:
    def __init__(
        self,
        catalog_path: str | os.PathLike[str],
        checkpoint: Callable[[str], None] | None = None,
    ) -> None:
        self._catalog_path = catalog_path
        self._checkpoint = checkpoint

    def _step(self, name: str) -> None:
        if self._checkpoint is not None:
            self._checkpoint(name)

    def apply(self, validated_plan: ValidatedCurationPlan) -> CurationCommit:
        with create_or_open_catalog(self._catalog_path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            actual = snapshot_token(connection, validated_plan.scope)
            if actual != validated_plan.expected_snapshot:
                connection.rollback()
                raise CurationStaleError(validated_plan.expected_snapshot, actual)
            authorize_plan_sources(connection, validated_plan)
            for item in validated_plan.membership_moves:
                _validate_membership_move(connection, item)
            for item in validated_plan.version_moves:
                current = connection.execute(
                    "SELECT work_id FROM work_versions WHERE id=?", (str(item.version_id),)
                ).fetchone()
                if current is None or current[0] == str(item.target_work_id):
                    connection.rollback()
                    raise sqlite3.IntegrityError(
                        "version move source is missing or already at target Work"
                    )
            committed = False
            try:
                self._apply(connection, validated_plan)
                resulting = snapshot_token(connection, validated_plan.scope)
                connection.commit()
                committed = True
            finally:
                if not committed:
                    connection.rollback()
        return CurationCommit(validated_plan.plan_id, resulting)

    def _apply(  # noqa: C901
        self,
        connection: sqlite3.Connection,
        plan: ValidatedCurationPlan,
    ) -> None:
        for item in plan.observation_moves:
            cursor = connection.execute(
                "UPDATE metadata_observations SET work_version_id=? WHERE id=?",
                (str(item.target_version_id), str(item.observation_id)),
            )
            _one(cursor, str(item.observation_id))
        self._step("observations")
        for item in plan.identifier_moves:
            cursor = connection.execute(
                "UPDATE stable_identifiers SET work_version_id=? WHERE id=?",
                (str(item.target_version_id), str(item.identifier_id)),
            )
            _one(cursor, str(item.identifier_id))
        self._step("identifiers")
        for item in plan.membership_moves:
            if item.coalesce_membership_id is None:
                cursor = connection.execute(
                    "UPDATE collection_memberships SET work_id=? WHERE id=?",
                    (str(item.target_work_id), str(item.membership_id)),
                )
                _one(cursor, str(item.membership_id))
            else:
                connection.execute(
                    "UPDATE collection_causes SET membership_id=? WHERE membership_id=?",
                    (str(item.coalesce_membership_id), str(item.membership_id)),
                )
                connection.execute(
                    "UPDATE collection_paths SET membership_id=? WHERE membership_id=?",
                    (str(item.coalesce_membership_id), str(item.membership_id)),
                )
                cursor = connection.execute(
                    "DELETE FROM collection_memberships WHERE id=?", (str(item.membership_id),)
                )
                _one(cursor, str(item.membership_id))
        self._step("memberships")
        for item in plan.reference_retargets:
            _retarget_reference(connection, item)
        self._step("references")
        for item in plan.relation_retargets:
            cursor = connection.execute(
                "UPDATE work_version_relations SET left_version_id=?,right_version_id=? WHERE id=?",
                (str(item.left_version_id), str(item.right_version_id), str(item.relation_id)),
            )
            _one(cursor, str(item.relation_id))
        for item in plan.relation_deletes:
            _one(
                connection.execute(
                    "DELETE FROM work_version_relations WHERE id=?", (str(item.relation_id),)
                ),
                str(item.relation_id),
            )
        for item in plan.relation_inserts:
            connection.execute(
                "INSERT INTO work_version_relations(id,left_version_id,right_version_id,"
                "relation) VALUES(?,?,?,?)",
                (
                    str(item.relation_id),
                    str(item.left_version_id),
                    str(item.right_version_id),
                    item.relation,
                ),
            )
        self._step("relations")
        for item in plan.representative_updates:
            if item.version_id is None:
                connection.execute(
                    "DELETE FROM work_representative_versions WHERE work_id=?", (str(item.work_id),)
                )
        for item in plan.version_moves:
            cursor = connection.execute(
                "UPDATE work_versions SET work_id=? WHERE id=?",
                (str(item.target_work_id), str(item.version_id)),
            )
            _one(cursor, str(item.version_id))
        self._step("versions")
        for item in plan.representative_updates:
            if item.version_id is not None:
                connection.execute(
                    "INSERT INTO work_representative_versions(work_id,work_version_id) VALUES(?,"
                    "?) ON CONFLICT(work_id) DO UPDATE SET "
                    "work_version_id=excluded.work_version_id",
                    (str(item.work_id), str(item.version_id)),
                )
        self._step("representatives")
        for identifier in plan.delete_version_ids:
            _one(
                connection.execute("DELETE FROM work_versions WHERE id=?", (str(identifier),)),
                str(identifier),
            )
        for identifier in plan.delete_work_ids:
            _one(
                connection.execute("DELETE FROM works WHERE id=?", (str(identifier),)),
                str(identifier),
            )
        self._step("deletes")
        for identifier in plan.orphan_artifact_candidates:
            connection.execute(
                "DELETE FROM raw_assets WHERE artifact_id=? AND NOT EXISTS("
                "SELECT 1 FROM work_version_assets WHERE artifact_id=?)",
                (str(identifier), str(identifier)),
            )
            connection.execute(
                "DELETE FROM artifacts WHERE id=? "
                "AND NOT EXISTS(SELECT 1 FROM raw_assets WHERE artifact_id=?) "
                "AND NOT EXISTS(SELECT 1 FROM light_documents WHERE artifact_id=?) "
                "AND NOT EXISTS(SELECT 1 FROM analysis_artifacts WHERE artifact_id=?)",
                (str(identifier), str(identifier), str(identifier), str(identifier)),
            )
        self._step("artifact-registrations")
        for identifier in plan.fts_rebuild_version_ids:
            for table in ("metadata_fts", "light_text_fts", "analysis_fts"):
                connection.execute(
                    f"DELETE FROM {table} WHERE work_version_id=?", (str(identifier),)
                )
            connection.execute(
                "INSERT INTO metadata_fts(work_version_id,content) "
                "SELECT c.work_version_id,s.values_json FROM work_version_current_metadata c "
                "JOIN metadata_snapshots s ON s.id=c.metadata_snapshot_id AND "
                "s.work_version_id=c.work_version_id "
                "WHERE c.work_version_id=?",
                (str(identifier),),
            )
            connection.execute(
                "INSERT INTO light_text_fts(work_version_id,content) "
                "SELECT c.work_version_id,d.document_json FROM "
                "work_version_current_light_document c "
                "JOIN light_documents d ON d.id=c.light_document_id AND "
                "d.work_version_id=c.work_version_id "
                "WHERE c.work_version_id=?",
                (str(identifier),),
            )
            connection.execute(
                "INSERT INTO analysis_fts(work_version_id,content) "
                "SELECT b.work_version_id,a.proposal_json FROM completion_bundles b "
                "JOIN analysis_artifacts a ON a.id=b.analysis_artifact_id AND "
                "a.work_version_id=b.work_version_id "
                "WHERE b.work_version_id=?",
                (str(identifier),),
            )
        self._step("fts")
