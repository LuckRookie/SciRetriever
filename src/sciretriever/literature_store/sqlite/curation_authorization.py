from __future__ import annotations

import sqlite3

from sciretriever.bibliography.api import ValidatedCurationPlan
from sciretriever.kernel import WorkId


def _require_owner(
    connection: sqlite3.Connection,
    query: str,
    source_id: str,
    allowed: frozenset[str],
    subject: str,
) -> None:
    row = connection.execute(query, (source_id,)).fetchone()
    if row is None or row[0] not in allowed:
        raise sqlite3.IntegrityError(f"curation {subject} source is outside declared scope")


def authorize_plan_sources(
    connection: sqlite3.Connection, plan: ValidatedCurationPlan
) -> None:
    work_scope = frozenset(str(value) for value in plan.scope.work_ids)
    version_scope = frozenset(str(value) for value in plan.scope.work_version_ids)
    for item in plan.observation_moves:
        _require_owner(
            connection, "SELECT work_version_id FROM metadata_observations WHERE id=?",
            str(item.observation_id), version_scope, "observation",
        )
    for item in plan.identifier_moves:
        _require_owner(
            connection, "SELECT work_version_id FROM stable_identifiers WHERE id=?",
            str(item.identifier_id), version_scope, "identifier",
        )
    for item in plan.membership_moves:
        _require_owner(
            connection, "SELECT work_id FROM collection_memberships WHERE id=?",
            str(item.membership_id), work_scope, "membership",
        )
        if item.coalesce_membership_id is not None:
            _require_owner(
                connection, "SELECT work_id FROM collection_memberships WHERE id=?",
                str(item.coalesce_membership_id), work_scope, "coalesce membership",
            )
    for item in plan.reference_retargets:
        _require_owner(
            connection,
            "SELECT s.work_version_id FROM reference_members m "
            "JOIN reference_sets s ON s.id=m.reference_set_id WHERE m.id=?",
            str(item.reference_id), version_scope, "reference",
        )
        if item.target_version_id is not None:
            row = connection.execute(
                "SELECT work_id FROM work_versions WHERE id=?", (str(item.target_version_id),)
            ).fetchone()
            planned_target = next(
                (move.target_work_id for move in plan.version_moves if move.version_id == item.target_version_id),
                None,
            )
            actual_target = None if row is None else WorkId(row[0])
            if item.target_work_id is None or item.target_work_id not in (actual_target, planned_target):
                raise sqlite3.IntegrityError("reference target WorkVersion does not belong to target Work")
    for item in plan.relation_retargets:
        row = connection.execute(
            "SELECT left_version_id,right_version_id FROM work_version_relations WHERE id=?",
            (str(item.relation_id),),
        ).fetchone()
        if row is None or row[0] not in version_scope or row[1] not in version_scope:
            raise sqlite3.IntegrityError("curation relation source is outside declared scope")
    for item in plan.relation_deletes:
        row = connection.execute(
            "SELECT left_version_id,right_version_id FROM work_version_relations WHERE id=?",
            (str(item.relation_id),),
        ).fetchone()
        if row is None or row[0] not in version_scope or row[1] not in version_scope:
            raise sqlite3.IntegrityError("curation relation deletion is outside declared scope")
