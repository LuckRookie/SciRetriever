from __future__ import annotations

import json
from typing import NoReturn, TypeAlias

from sciretriever.model.library import ValidatedCurationPlan
from sciretriever.model.primitives import WorkId, WorkVersionId

from .curation_errors import CurationPlanError

JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]


def _reject_constant(value: str) -> NoReturn:
    raise ValueError(f"non-finite JSON number: {value}")


def _unique_object(pairs: list[tuple[str, JsonValue]]) -> dict[str, JsonValue]:
    keys = tuple(key for key, _value in pairs)
    if len(keys) != len(set(keys)):
        raise ValueError("JSON object keys must be unique")
    return dict(pairs)


def _canonical_json(payload: str) -> str:
    try:
        decoded = json.loads(
            payload,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
        )
        payload.encode("utf-8")
        return json.dumps(
            decoded,
            ensure_ascii=True,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, UnicodeError, ValueError) as error:
        raise CurationPlanError("reference downgrade payload must be canonical JSON") from error


def _validate_order_and_scope(
    plan: ValidatedCurationPlan,
) -> tuple[set[WorkId], set[WorkVersionId]]:
    groups = (
        plan.version_moves,
        plan.observation_moves,
        plan.identifier_moves,
        plan.membership_moves,
        plan.reference_retargets,
        plan.relation_retargets,
        plan.relation_inserts,
        plan.relation_deletes,
        plan.representative_updates,
        plan.delete_version_ids,
        plan.delete_work_ids,
        plan.fts_rebuild_version_ids,
        plan.orphan_artifact_candidates,
    )
    for values in groups:
        keys = tuple(str(value) for value in values)
        if keys != tuple(sorted(keys)) or len(keys) != len(set(keys)):
            raise CurationPlanError("curation plan mutations must be stably ordered and unique")
    moved = {item.version_id for item in plan.version_moves}
    if moved.intersection(plan.delete_version_ids):
        raise CurationPlanError("curation plan cannot move and delete the same version")
    work_scope = set(plan.scope.work_ids)
    version_scope = set(plan.scope.work_version_ids)
    if len(work_scope) != len(plan.scope.work_ids) or len(version_scope) != len(
        plan.scope.work_version_ids
    ):
        raise CurationPlanError("curation scope identifiers must be unique")
    operation_sources = (
        tuple(item.version_id for item in plan.version_moves),
        tuple(item.observation_id for item in plan.observation_moves),
        tuple(item.identifier_id for item in plan.identifier_moves),
        tuple(item.membership_id for item in plan.membership_moves),
        tuple(item.reference_id for item in plan.reference_retargets),
        tuple(item.relation_id for item in plan.relation_retargets),
        tuple(item.relation_id for item in plan.relation_inserts),
        tuple(item.relation_id for item in plan.relation_deletes),
        tuple(item.work_id for item in plan.representative_updates),
    )
    if any(len(values) != len(set(values)) for values in operation_sources):
        raise CurationPlanError("each curation operation source must be unique")
    return work_scope, version_scope


def _validate_move_targets(
    plan: ValidatedCurationPlan,
    work_scope: set[WorkId],
    version_scope: set[WorkVersionId],
) -> None:
    if any(
        item.version_id not in version_scope or item.target_work_id not in work_scope
        for item in plan.version_moves
    ):
        raise CurationPlanError("version moves must remain inside curation scope")
    if any(
        item.target_version_id not in version_scope
        for item in plan.observation_moves + plan.identifier_moves
    ):
        raise CurationPlanError("fact moves must target a scoped version")
    if any(item.target_work_id not in work_scope for item in plan.membership_moves):
        raise CurationPlanError("membership moves must target a scoped work")
    if any(item.coalesce_membership_id == item.membership_id for item in plan.membership_moves):
        raise CurationPlanError("membership cannot coalesce with itself")


def _validate_reference_targets(
    plan: ValidatedCurationPlan,
    work_scope: set[WorkId],
    version_scope: set[WorkVersionId],
) -> None:
    for item in plan.reference_retargets:
        targets = item.target_work_id is not None or item.target_version_id is not None
        downgrade = item.downgrade_raw_text is not None or item.downgrade_reference_json is not None
        if targets == downgrade:
            raise CurationPlanError(
                "reference operation must be exactly one of retarget or downgrade"
            )
        if item.target_work_id is not None and item.target_work_id not in work_scope:
            raise CurationPlanError("reference Work target must be scoped")
        if item.target_version_id is not None and item.target_version_id not in version_scope:
            raise CurationPlanError("reference version target must be scoped")
        if downgrade:
            if (
                item.downgrade_raw_text is None
                or not item.downgrade_raw_text.strip()
                or item.downgrade_reference_json is None
            ):
                raise CurationPlanError("reference downgrade payload must be complete")
            canonical = _canonical_json(item.downgrade_reference_json)
            if canonical != item.downgrade_reference_json:
                raise CurationPlanError("reference downgrade payload must be canonical JSON")


def _validate_endpoints(
    plan: ValidatedCurationPlan,
    work_scope: set[WorkId],
    version_scope: set[WorkVersionId],
) -> None:
    if any(
        item.left_version_id not in version_scope
        or item.right_version_id not in version_scope
        or item.left_version_id == item.right_version_id
        for item in plan.relation_retargets
    ):
        raise CurationPlanError("relation endpoints must be distinct scoped versions")
    if any(
        item.left_version_id not in version_scope
        or item.right_version_id not in version_scope
        or item.left_version_id == item.right_version_id
        for item in plan.relation_inserts
    ):
        raise CurationPlanError("inserted relation endpoints must be distinct scoped versions")
    if any(
        item.work_id not in work_scope
        or (item.version_id is not None and item.version_id not in version_scope)
        for item in plan.representative_updates
    ):
        raise CurationPlanError("representative updates must remain inside curation scope")
    if not set(plan.delete_work_ids).issubset(work_scope) or not set(
        plan.delete_version_ids
    ).issubset(version_scope):
        raise CurationPlanError("deletions must remain inside curation scope")
    if not set(plan.fts_rebuild_version_ids).issubset(version_scope):
        raise CurationPlanError("FTS rebuild identifiers must be scoped")
    deleted_works = set(plan.delete_work_ids)
    deleted_versions = set(plan.delete_version_ids)
    if any(
        item.target_work_id in deleted_works for item in plan.version_moves + plan.membership_moves
    ):
        raise CurationPlanError("a deleted Work cannot receive moved facts")
    endpoint_versions = {
        value
        for item in plan.relation_retargets
        for value in (item.left_version_id, item.right_version_id)
    }
    endpoint_versions.update(
        item.target_version_id
        for item in plan.reference_retargets
        if item.target_version_id is not None
    )
    endpoint_versions.update(
        item.version_id for item in plan.representative_updates if item.version_id is not None
    )
    if endpoint_versions.intersection(deleted_versions) or deleted_versions.intersection(
        plan.fts_rebuild_version_ids
    ):
        raise CurationPlanError("deleted versions cannot remain mutation targets")


def validate_curation_plan(plan: ValidatedCurationPlan) -> ValidatedCurationPlan:
    work_scope, version_scope = _validate_order_and_scope(plan)
    _validate_move_targets(plan, work_scope, version_scope)
    _validate_reference_targets(plan, work_scope, version_scope)
    _validate_endpoints(plan, work_scope, version_scope)
    return plan
