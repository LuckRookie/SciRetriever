from __future__ import annotations

from typing import TypeVar
from uuid import UUID, uuid5

from sciretriever.model.library import CurationTopology
from sciretriever.model.primitives import (
    AssetId,
    CurationPlanId,
    VersionRelationId,
    WorkId,
    WorkVersionId,
)

from .model import (
    CurationPlanError,
    IdentifierMove,
    MembershipMove,
    ObservationMove,
    ReferenceRetarget,
    RelationDelete,
    RelationRetarget,
    RepresentativeUpdate,
    ValidatedCurationPlan,
    ValidatedVersionRelation,
    VersionMove,
)

_NAMESPACE = UUID("1f9b9ae3-57f3-4b2f-ae24-219be3d74cf0")
_ROLE_PRIORITY = {"formal": 0, "accepted-manuscript": 1, "preprint": 2, "other": 3}
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
        _relation_id(left, right, relation), ordered[0], ordered[1], relation
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


def _version(topology: CurationTopology, identifier: WorkVersionId):
    value = next(
        (item for item in topology.snapshot.versions if item.work_version_id == identifier), None
    )
    if value is None:
        raise CurationPlanError(f"unknown WorkVersion: {identifier}")
    return value


def _work(topology: CurationTopology, identifier: WorkId):
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
        moves.append(IdentifierMove(item.identifier_id, survivor))
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
            MembershipMove(item.membership_id, survivor, destinations.get(item.collection_id))
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
                ReferenceRetarget(item.reference_id, None, None, item.raw_text, item.reference_json)
            )
        else:
            target_version = survivor_version if targets_version else item.target_version_id
            operations.append(
                ReferenceRetarget(item.reference_id, survivor_work, target_version, None, None)
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
            deletes.append(RelationDelete(item.relation_id))
        elif left != item.left_version_id or right != item.right_version_id:
            updates.append(RelationRetarget(item.relation_id, left, right))
            resulting.add((left, right, item.relation))
        else:
            resulting.add((left, right, item.relation))
    return _ordered(tuple(updates)), _ordered(tuple(deletes))


def same_version_plan(
    topology: CurationTopology, left: WorkVersionId, right: WorkVersionId, survivor: WorkVersionId
) -> ValidatedCurationPlan:
    if survivor not in (left, right) or left == right:
        raise CurationPlanError("survivor must be one of two distinct selected versions")
    losing = right if survivor == left else left
    survivor_fact, losing_fact = _version(topology, survivor), _version(topology, losing)
    survivor_work, losing_work = survivor_fact.work_id, losing_fact.work_id
    version_moves: tuple[VersionMove, ...] = ()
    membership_moves: tuple[MembershipMove, ...] = ()
    delete_works: tuple[WorkId, ...] = ()
    if survivor_work != losing_work:
        version_moves = _ordered(
            tuple(
                VersionMove(value, survivor_work)
                for value in _work(topology, losing_work).version_ids
                if value != losing
            )
        )
        membership_moves = _membership_moves(topology, losing_work, survivor_work)
        delete_works = (losing_work,)
    relation_updates, relation_deletes = _relations(topology, losing, survivor)
    return ValidatedCurationPlan(
        _plan_id("same-version", (str(left), str(right), str(survivor)), topology),
        topology.snapshot.scope,
        topology.snapshot.token,
        version_moves=version_moves,
        observation_moves=_ordered(
            tuple(
                ObservationMove(item.observation_id, survivor)
                for item in topology.observations
                if item.version_id == losing
            )
        ),
        identifier_moves=_identifier_moves(topology, losing, survivor),
        membership_moves=membership_moves,
        reference_retargets=_references(
            topology, losing_work, survivor_work, frozenset((losing,)), survivor
        ),
        relation_retargets=relation_updates,
        relation_deletes=relation_deletes,
        representative_updates=_ordered(
            (
                RepresentativeUpdate(survivor_work, survivor),
                *(
                    (RepresentativeUpdate(losing_work, None),)
                    if survivor_work != losing_work
                    else ()
                ),
            )
        ),
        delete_version_ids=(losing,),
        delete_work_ids=delete_works,
        fts_rebuild_version_ids=(survivor,),
        orphan_artifact_candidates=_artifact_candidates(topology, frozenset((losing,))),
    )


def related_versions_plan(
    topology: CurationTopology, left: WorkVersionId, right: WorkVersionId, survivor_work: WorkId
) -> ValidatedCurationPlan:
    left_fact, right_fact = _version(topology, left), _version(topology, right)
    if left == right or survivor_work not in (left_fact.work_id, right_fact.work_id):
        raise CurationPlanError("survivor Work must be an existing selected parent")
    losing_work = right_fact.work_id if survivor_work == left_fact.work_id else left_fact.work_id
    moves: tuple[VersionMove, ...] = ()
    memberships: tuple[MembershipMove, ...] = ()
    deleted: tuple[WorkId, ...] = ()
    if losing_work != survivor_work:
        moves = _ordered(
            tuple(
                VersionMove(value, survivor_work)
                for value in _work(topology, losing_work).version_ids
            )
        )
        memberships, deleted = (
            _membership_moves(topology, losing_work, survivor_work),
            (losing_work,),
        )
    survivor_versions = tuple(
        item.work_version_id
        for item in topology.snapshot.versions
        if item.work_id in (survivor_work, losing_work)
    )
    relation = _unordered_relation(left, right, "related-versions")
    inserts = (
        ()
        if any(item.relation_id == relation.relation_id for item in topology.relations)
        else (relation,)
    )
    return ValidatedCurationPlan(
        _plan_id("related-versions", (str(left), str(right), str(survivor_work)), topology),
        topology.snapshot.scope,
        topology.snapshot.token,
        version_moves=moves,
        membership_moves=memberships,
        reference_retargets=_references(topology, losing_work, survivor_work, frozenset(), None),
        relation_inserts=inserts,
        representative_updates=_ordered(
            (
                RepresentativeUpdate(survivor_work, _representative(topology, survivor_versions)),
                *(
                    (RepresentativeUpdate(losing_work, None),)
                    if losing_work != survivor_work
                    else ()
                ),
            )
        ),
        delete_work_ids=deleted,
    )


def distinct_plan(topology: CurationTopology, left: WorkId, right: WorkId) -> ValidatedCurationPlan:
    left_work, right_work = _work(topology, left), _work(topology, right)
    if (
        left == right
        or left_work.representative_version_id is None
        or right_work.representative_version_id is None
    ):
        raise CurationPlanError("distinct requires two represented Works")
    left_version, right_version = (
        left_work.representative_version_id,
        right_work.representative_version_id,
    )
    relation = _unordered_relation(left_version, right_version, "distinct")
    inserts = (
        ()
        if any(item.relation_id == relation.relation_id for item in topology.relations)
        else (relation,)
    )
    return ValidatedCurationPlan(
        _plan_id("distinct", (str(left), str(right)), topology),
        topology.snapshot.scope,
        topology.snapshot.token,
        relation_inserts=inserts,
    )


def delete_version_plan(
    topology: CurationTopology, identifier: WorkVersionId
) -> ValidatedCurationPlan:
    version = _version(topology, identifier)
    work = _work(topology, version.work_id)
    remaining = tuple(value for value in work.version_ids if value != identifier)
    if not remaining:
        raise CurationPlanError("last WorkVersion requires explicit Work deletion")
    relations = _ordered(
        tuple(
            RelationDelete(item.relation_id)
            for item in topology.relations
            if identifier in (item.left_version_id, item.right_version_id)
        )
    )
    return ValidatedCurationPlan(
        _plan_id("delete-version", (str(identifier),), topology),
        topology.snapshot.scope,
        topology.snapshot.token,
        reference_retargets=_references(topology, None, None, frozenset((identifier,)), None),
        relation_deletes=relations,
        representative_updates=(
            RepresentativeUpdate(version.work_id, _representative(topology, remaining)),
        ),
        delete_version_ids=(identifier,),
        orphan_artifact_candidates=_artifact_candidates(topology, frozenset((identifier,))),
    )


def delete_work_plan(topology: CurationTopology, identifier: WorkId) -> ValidatedCurationPlan:
    work = _work(topology, identifier)
    deleted_versions = frozenset(work.version_ids)
    relations = _ordered(
        tuple(
            RelationDelete(item.relation_id)
            for item in topology.relations
            if item.left_version_id in deleted_versions or item.right_version_id in deleted_versions
        )
    )
    return ValidatedCurationPlan(
        _plan_id("delete-work", (str(identifier),), topology),
        topology.snapshot.scope,
        topology.snapshot.token,
        reference_retargets=_references(topology, identifier, None, deleted_versions, None),
        relation_deletes=relations,
        delete_work_ids=(identifier,),
        orphan_artifact_candidates=_artifact_candidates(topology, deleted_versions),
    )
