from __future__ import annotations

from typing import Final, TypeVar
from uuid import UUID, uuid5

from sciretriever.model.library import (
    CurationTopology,
    IdentifierMove,
    MembershipMove,
    ReferenceRetarget,
    RelationDelete,
    RelationRetarget,
    ValidatedVersionRelation,
)
from sciretriever.model.literature import VersionFacts, WorkFacts
from sciretriever.model.primitives import (
    AssetId,
    CurationPlanId,
    VersionRelationId,
    WorkId,
    WorkVersionId,
)

from .curation_errors import CurationPlanError

_NAMESPACE: Final = UUID("1f9b9ae3-57f3-4b2f-ae24-219be3d74cf0")
_ROLE_PRIORITY: Final = {"formal": 0, "accepted-manuscript": 1, "preprint": 2, "other": 3}
_Value = TypeVar("_Value")


def _ordered(values: tuple[_Value, ...]) -> tuple[_Value, ...]:
    return tuple(sorted(values, key=str))


def _plan_id(
    operation: str, identifiers: tuple[str, ...], topology: CurationTopology
) -> CurationPlanId:
    payload = "\0".join((operation, *identifiers, str(topology.snapshot.token.sha256)))
    return CurationPlanId(str(uuid5(_NAMESPACE, payload)))


def _relation_id(left: WorkVersionId, right: WorkVersionId, relation: str) -> VersionRelationId:
    payload = "\0".join((*sorted((str(left), str(right))), relation))
    return VersionRelationId(str(uuid5(_NAMESPACE, payload)))


def _unordered_relation(
    left: WorkVersionId, right: WorkVersionId, relation: str
) -> ValidatedVersionRelation:
    ordered = tuple(sorted((left, right), key=str))
    return ValidatedVersionRelation(
        relation_id=_relation_id(left, right, relation),
        left_version_id=ordered[0],
        right_version_id=ordered[1],
        relation=relation,
    )


def _artifact_candidates(
    topology: CurationTopology,
    versions: frozenset[WorkVersionId],
) -> tuple[AssetId, ...]:
    return _ordered(
        tuple(
            {
                item.artifact_id
                for item in topology.artifact_registrations
                if item.version_id in versions
            }
        )
    )


def _version(topology: CurationTopology, identifier: WorkVersionId) -> VersionFacts:
    value = next(
        (item for item in topology.snapshot.versions if item.work_version_id == identifier), None
    )
    if value is None:
        raise CurationPlanError(f"unknown WorkVersion: {identifier}")
    return value


def _work(topology: CurationTopology, identifier: WorkId) -> WorkFacts:
    value = next((item for item in topology.snapshot.works if item.work_id == identifier), None)
    if value is None:
        raise CurationPlanError(f"unknown Work: {identifier}")
    return value


def _representative(
    topology: CurationTopology, versions: tuple[WorkVersionId, ...]
) -> WorkVersionId:
    facts = tuple(_version(topology, identifier) for identifier in versions)
    return min(
        facts, key=lambda item: (_ROLE_PRIORITY[item.version_role], str(item.work_version_id))
    ).work_version_id


def _identifier_moves(
    topology: CurationTopology, losing: WorkVersionId, survivor: WorkVersionId
) -> tuple[IdentifierMove, ...]:
    survivor_values = {
        item.value.namespace: item.value.value
        for item in topology.identifiers
        if item.version_id == survivor
    }
    moves: list[IdentifierMove] = []
    for item in topology.identifiers:
        if item.version_id != losing:
            continue
        existing = survivor_values.get(item.value.namespace)
        if existing is not None and existing != item.value.value:
            raise CurationPlanError(f"stable identifier conflict: {item.value.namespace}")
        moves.append(IdentifierMove(identifier_id=item.identifier_id, target_version_id=survivor))
    return _ordered(tuple(moves))


def _membership_moves(
    topology: CurationTopology, losing: WorkId, survivor: WorkId
) -> tuple[MembershipMove, ...]:
    destinations = {
        item.collection_id: item.membership_id
        for item in topology.memberships
        if item.work_id == survivor
    }
    return _ordered(
        tuple(
            MembershipMove(
                membership_id=item.membership_id,
                target_work_id=survivor,
                coalesce_membership_id=destinations.get(item.collection_id),
            )
            for item in topology.memberships
            if item.work_id == losing
        )
    )


def _references(
    topology: CurationTopology,
    losing_work: WorkId | None,
    survivor_work: WorkId | None,
    losing_versions: frozenset[WorkVersionId],
    survivor_version: WorkVersionId | None,
) -> tuple[ReferenceRetarget, ...]:
    operations: list[ReferenceRetarget] = []
    for item in topology.references:
        targets_version = item.target_version_id in losing_versions
        targets_work = losing_work is not None and item.target_work_id == losing_work
        if not targets_work and not targets_version:
            continue
        if survivor_work is None:
            operations.append(
                ReferenceRetarget(
                    reference_id=item.reference_id,
                    target_work_id=None,
                    target_version_id=None,
                    downgrade_raw_text=item.raw_text,
                    downgrade_reference_json=item.reference_json,
                )
            )
        else:
            target_version = survivor_version if targets_version else item.target_version_id
            operations.append(
                ReferenceRetarget(
                    reference_id=item.reference_id,
                    target_work_id=survivor_work,
                    target_version_id=target_version,
                    downgrade_raw_text=None,
                    downgrade_reference_json=None,
                )
            )
    return _ordered(tuple(operations))


def _relations(
    topology: CurationTopology, losing: WorkVersionId, survivor: WorkVersionId
) -> tuple[tuple[RelationRetarget, ...], tuple[RelationDelete, ...]]:
    updates: list[RelationRetarget] = []
    deletes: list[RelationDelete] = []
    resulting: set[tuple[WorkVersionId, WorkVersionId, str]] = set()
    for item in topology.relations:
        left = survivor if item.left_version_id == losing else item.left_version_id
        right = survivor if item.right_version_id == losing else item.right_version_id
        if left == right or (left, right, item.relation) in resulting:
            deletes.append(RelationDelete(relation_id=item.relation_id))
        elif left != item.left_version_id or right != item.right_version_id:
            updates.append(
                RelationRetarget(
                    relation_id=item.relation_id,
                    left_version_id=left,
                    right_version_id=right,
                )
            )
            resulting.add((left, right, item.relation))
        else:
            resulting.add((left, right, item.relation))
    return _ordered(tuple(updates)), _ordered(tuple(deletes))
