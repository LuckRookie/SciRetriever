from __future__ import annotations

from sciretriever.model.library import (
    CurationTopology,
    ObservationMove,
    RelationDelete,
    RepresentativeUpdate,
    ValidatedCurationPlan,
    VersionMove,
)
from sciretriever.model.primitives import WorkId, WorkVersionId

from .curation_errors import CurationPlanError
from .curation_support import (
    _artifact_candidates,
    _identifier_moves,
    _membership_moves,
    _ordered,
    _plan_id,
    _references,
    _relations,
    _representative,
    _unordered_relation,
    _version,
    _work,
)
from .curation_validation import validate_curation_plan


def same_version_plan(
    topology: CurationTopology, left: WorkVersionId, right: WorkVersionId, survivor: WorkVersionId
) -> ValidatedCurationPlan:
    if survivor not in (left, right) or left == right:
        raise CurationPlanError("survivor must be one of two distinct selected versions")
    losing = right if survivor == left else left
    survivor_fact, losing_fact = _version(topology, survivor), _version(topology, losing)
    survivor_work, losing_work = survivor_fact.work_id, losing_fact.work_id
    version_moves: tuple[VersionMove, ...] = ()
    membership_moves = ()
    delete_works: tuple[WorkId, ...] = ()
    if survivor_work != losing_work:
        version_moves = _ordered(
            tuple(
                VersionMove(version_id=value, target_work_id=survivor_work)
                for value in _work(topology, losing_work).version_ids
                if value != losing
            )
        )
        membership_moves = _membership_moves(topology, losing_work, survivor_work)
        delete_works = (losing_work,)
    relation_updates, relation_deletes = _relations(topology, losing, survivor)
    return validate_curation_plan(
        ValidatedCurationPlan(
            plan_id=_plan_id("same-version", (str(left), str(right), str(survivor)), topology),
            scope=topology.snapshot.scope,
            expected_snapshot=topology.snapshot.token,
            version_moves=version_moves,
            observation_moves=_ordered(
                tuple(
                    ObservationMove(observation_id=item.observation_id, target_version_id=survivor)
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
                    RepresentativeUpdate(work_id=survivor_work, version_id=survivor),
                    *(
                        (RepresentativeUpdate(work_id=losing_work, version_id=None),)
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
    )


def related_versions_plan(
    topology: CurationTopology, left: WorkVersionId, right: WorkVersionId, survivor_work: WorkId
) -> ValidatedCurationPlan:
    left_fact, right_fact = _version(topology, left), _version(topology, right)
    if left == right or survivor_work not in (left_fact.work_id, right_fact.work_id):
        raise CurationPlanError("survivor Work must be an existing selected parent")
    losing_work = right_fact.work_id if survivor_work == left_fact.work_id else left_fact.work_id
    moves: tuple[VersionMove, ...] = ()
    memberships = ()
    deleted: tuple[WorkId, ...] = ()
    if losing_work != survivor_work:
        moves = _ordered(
            tuple(
                VersionMove(version_id=value, target_work_id=survivor_work)
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
    return validate_curation_plan(
        ValidatedCurationPlan(
            plan_id=_plan_id(
                "related-versions", (str(left), str(right), str(survivor_work)), topology
            ),
            scope=topology.snapshot.scope,
            expected_snapshot=topology.snapshot.token,
            version_moves=moves,
            membership_moves=memberships,
            reference_retargets=_references(
                topology, losing_work, survivor_work, frozenset(), None
            ),
            relation_inserts=inserts,
            representative_updates=_ordered(
                (
                    RepresentativeUpdate(
                        work_id=survivor_work,
                        version_id=_representative(topology, survivor_versions),
                    ),
                    *(
                        (RepresentativeUpdate(work_id=losing_work, version_id=None),)
                        if losing_work != survivor_work
                        else ()
                    ),
                )
            ),
            delete_work_ids=deleted,
        )
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
    return validate_curation_plan(
        ValidatedCurationPlan(
            plan_id=_plan_id("distinct", (str(left), str(right)), topology),
            scope=topology.snapshot.scope,
            expected_snapshot=topology.snapshot.token,
            relation_inserts=inserts,
        )
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
            RelationDelete(relation_id=item.relation_id)
            for item in topology.relations
            if identifier in (item.left_version_id, item.right_version_id)
        )
    )
    return validate_curation_plan(
        ValidatedCurationPlan(
            plan_id=_plan_id("delete-version", (str(identifier),), topology),
            scope=topology.snapshot.scope,
            expected_snapshot=topology.snapshot.token,
            reference_retargets=_references(topology, None, None, frozenset((identifier,)), None),
            relation_deletes=relations,
            representative_updates=(
                RepresentativeUpdate(
                    work_id=version.work_id,
                    version_id=_representative(topology, remaining),
                ),
            ),
            delete_version_ids=(identifier,),
            orphan_artifact_candidates=_artifact_candidates(topology, frozenset((identifier,))),
        )
    )


def delete_work_plan(topology: CurationTopology, identifier: WorkId) -> ValidatedCurationPlan:
    work = _work(topology, identifier)
    deleted_versions = frozenset(work.version_ids)
    relations = _ordered(
        tuple(
            RelationDelete(relation_id=item.relation_id)
            for item in topology.relations
            if item.left_version_id in deleted_versions or item.right_version_id in deleted_versions
        )
    )
    return validate_curation_plan(
        ValidatedCurationPlan(
            plan_id=_plan_id("delete-work", (str(identifier),), topology),
            scope=topology.snapshot.scope,
            expected_snapshot=topology.snapshot.token,
            reference_retargets=_references(topology, identifier, None, deleted_versions, None),
            relation_deletes=relations,
            delete_work_ids=(identifier,),
            orphan_artifact_candidates=_artifact_candidates(topology, deleted_versions),
        )
    )


__all__ = (
    "CurationPlanError",
    "delete_version_plan",
    "delete_work_plan",
    "distinct_plan",
    "related_versions_plan",
    "same_version_plan",
    "validate_curation_plan",
)
