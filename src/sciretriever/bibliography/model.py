from __future__ import annotations

from dataclasses import dataclass

from sciretriever.kernel.json import canonical_json_bytes, parse_canonical_json
from sciretriever.model.literature import Identifier, VersionFacts
from sciretriever.model.primitives import (
    AssetId,
    CurationPlanId,
    MembershipId,
    ObservationId,
    ReferenceFactId,
    Sha256,
    StableIdentifierId,
    VersionRelationId,
    WorkId,
    WorkVersionId,
)


class CurationPlanError(Exception):
    __slots__ = ("reason",)

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)

    def __str__(self) -> str:
        return self.reason


@dataclass(frozen=True, slots=True)
class IdentityCandidateQuery:
    identifiers: tuple[Identifier, ...]


@dataclass(frozen=True, slots=True)
class IdentityCandidate:
    work_id: WorkId
    work_version_id: WorkVersionId
    matched_identifiers: tuple[Identifier, ...]


@dataclass(frozen=True, slots=True)
class IdentityCandidateSet:
    candidates: tuple[IdentityCandidate, ...]


@dataclass(frozen=True, slots=True)
class WorkFacts:
    work_id: WorkId
    representative_version_id: WorkVersionId | None
    version_ids: tuple[WorkVersionId, ...]


@dataclass(frozen=True, slots=True)
class CurationScope:
    work_ids: tuple[WorkId, ...]
    work_version_ids: tuple[WorkVersionId, ...]


@dataclass(frozen=True, slots=True)
class SnapshotToken:
    sha256: Sha256


@dataclass(frozen=True, slots=True)
class CurationSnapshot:
    scope: CurationScope
    token: SnapshotToken
    works: tuple[WorkFacts, ...]
    versions: tuple[VersionFacts, ...]


@dataclass(frozen=True, slots=True)
class VersionMove:
    version_id: WorkVersionId
    target_work_id: WorkId


@dataclass(frozen=True, slots=True)
class ObservationMove:
    observation_id: ObservationId
    target_version_id: WorkVersionId


@dataclass(frozen=True, slots=True)
class IdentifierMove:
    identifier_id: StableIdentifierId
    target_version_id: WorkVersionId


@dataclass(frozen=True, slots=True)
class MembershipMove:
    membership_id: MembershipId
    target_work_id: WorkId
    coalesce_membership_id: MembershipId | None


@dataclass(frozen=True, slots=True)
class ReferenceRetarget:
    reference_id: ReferenceFactId
    target_work_id: WorkId | None
    target_version_id: WorkVersionId | None
    downgrade_raw_text: str | None
    downgrade_reference_json: str | None


@dataclass(frozen=True, slots=True)
class RelationRetarget:
    relation_id: VersionRelationId
    left_version_id: WorkVersionId
    right_version_id: WorkVersionId


@dataclass(frozen=True, slots=True)
class RelationDelete:
    relation_id: VersionRelationId


@dataclass(frozen=True, slots=True)
class RepresentativeUpdate:
    work_id: WorkId
    version_id: WorkVersionId | None


@dataclass(frozen=True, slots=True)
class ValidatedVersionRelation:
    relation_id: VersionRelationId
    left_version_id: WorkVersionId
    right_version_id: WorkVersionId
    relation: str


@dataclass(frozen=True, slots=True)
class ValidatedCurationPlan:
    plan_id: CurationPlanId
    scope: CurationScope
    expected_snapshot: SnapshotToken
    version_moves: tuple[VersionMove, ...] = ()
    observation_moves: tuple[ObservationMove, ...] = ()
    identifier_moves: tuple[IdentifierMove, ...] = ()
    membership_moves: tuple[MembershipMove, ...] = ()
    reference_retargets: tuple[ReferenceRetarget, ...] = ()
    relation_retargets: tuple[RelationRetarget, ...] = ()
    relation_inserts: tuple[ValidatedVersionRelation, ...] = ()
    relation_deletes: tuple[RelationDelete, ...] = ()
    representative_updates: tuple[RepresentativeUpdate, ...] = ()
    delete_version_ids: tuple[WorkVersionId, ...] = ()
    delete_work_ids: tuple[WorkId, ...] = ()
    fts_rebuild_version_ids: tuple[WorkVersionId, ...] = ()
    orphan_artifact_candidates: tuple[AssetId, ...] = ()

    def __post_init__(self) -> None:  # noqa: C901
        groups = (
            self.version_moves,
            self.observation_moves,
            self.identifier_moves,
            self.membership_moves,
            self.reference_retargets,
            self.relation_retargets,
            self.relation_inserts,
            self.relation_deletes,
            self.representative_updates,
            self.delete_version_ids,
            self.delete_work_ids,
            self.fts_rebuild_version_ids,
            self.orphan_artifact_candidates,
        )
        for values in groups:
            keys = tuple(str(value) for value in values)
            if keys != tuple(sorted(keys)) or len(keys) != len(set(keys)):
                raise CurationPlanError("curation plan mutations must be stably ordered and unique")
        moved = {item.version_id for item in self.version_moves}
        if moved.intersection(self.delete_version_ids):
            raise CurationPlanError("curation plan cannot move and delete the same version")
        work_scope = set(self.scope.work_ids)
        version_scope = set(self.scope.work_version_ids)
        if len(work_scope) != len(self.scope.work_ids) or len(version_scope) != len(
            self.scope.work_version_ids
        ):
            raise CurationPlanError("curation scope identifiers must be unique")
        operation_sources = (
            tuple(item.version_id for item in self.version_moves),
            tuple(item.observation_id for item in self.observation_moves),
            tuple(item.identifier_id for item in self.identifier_moves),
            tuple(item.membership_id for item in self.membership_moves),
            tuple(item.reference_id for item in self.reference_retargets),
            tuple(item.relation_id for item in self.relation_retargets),
            tuple(item.relation_id for item in self.relation_inserts),
            tuple(item.relation_id for item in self.relation_deletes),
            tuple(item.work_id for item in self.representative_updates),
        )
        if any(len(values) != len(set(values)) for values in operation_sources):
            raise CurationPlanError("each curation operation source must be unique")
        if any(
            item.version_id not in version_scope or item.target_work_id not in work_scope
            for item in self.version_moves
        ):
            raise CurationPlanError("version moves must remain inside curation scope")
        if any(
            item.target_version_id not in version_scope
            for item in self.observation_moves + self.identifier_moves
        ):
            raise CurationPlanError("fact moves must target a scoped version")
        if any(item.target_work_id not in work_scope for item in self.membership_moves):
            raise CurationPlanError("membership moves must target a scoped work")
        if any(item.coalesce_membership_id == item.membership_id for item in self.membership_moves):
            raise CurationPlanError("membership cannot coalesce with itself")
        for item in self.reference_retargets:
            targets = item.target_work_id is not None or item.target_version_id is not None
            downgrade = (
                item.downgrade_raw_text is not None or item.downgrade_reference_json is not None
            )
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
                canonical = canonical_json_bytes(
                    parse_canonical_json(item.downgrade_reference_json)
                ).decode("ascii")
                if canonical != item.downgrade_reference_json:
                    raise CurationPlanError("reference downgrade payload must be canonical JSON")
        if any(
            item.left_version_id not in version_scope
            or item.right_version_id not in version_scope
            or item.left_version_id == item.right_version_id
            for item in self.relation_retargets
        ):
            raise CurationPlanError("relation endpoints must be distinct scoped versions")
        if any(
            item.left_version_id not in version_scope
            or item.right_version_id not in version_scope
            or item.left_version_id == item.right_version_id
            for item in self.relation_inserts
        ):
            raise CurationPlanError("inserted relation endpoints must be distinct scoped versions")
        if any(
            item.work_id not in work_scope
            or (item.version_id is not None and item.version_id not in version_scope)
            for item in self.representative_updates
        ):
            raise CurationPlanError("representative updates must remain inside curation scope")
        if not set(self.delete_work_ids).issubset(work_scope) or not set(
            self.delete_version_ids
        ).issubset(version_scope):
            raise CurationPlanError("deletions must remain inside curation scope")
        if not set(self.fts_rebuild_version_ids).issubset(version_scope):
            raise CurationPlanError("FTS rebuild identifiers must be scoped")
        deleted_works = set(self.delete_work_ids)
        deleted_versions = set(self.delete_version_ids)
        if any(
            item.target_work_id in deleted_works
            for item in self.version_moves + self.membership_moves
        ):
            raise CurationPlanError("a deleted Work cannot receive moved facts")
        endpoint_versions = {
            value
            for item in self.relation_retargets
            for value in (item.left_version_id, item.right_version_id)
        }
        endpoint_versions.update(
            item.target_version_id
            for item in self.reference_retargets
            if item.target_version_id is not None
        )
        endpoint_versions.update(
            item.version_id for item in self.representative_updates if item.version_id is not None
        )
        if endpoint_versions.intersection(deleted_versions) or deleted_versions.intersection(
            self.fts_rebuild_version_ids
        ):
            raise CurationPlanError("deleted versions cannot remain mutation targets")


@dataclass(frozen=True, slots=True)
class CurationCommit:
    plan_id: CurationPlanId
    resulting_snapshot: SnapshotToken


class CurationStaleError(Exception):
    __slots__ = ("expected", "actual")

    def __init__(self, expected: SnapshotToken, actual: SnapshotToken) -> None:
        self.expected = expected
        self.actual = actual
        super().__init__(expected, actual)

    def __str__(self) -> str:
        return "curation snapshot is stale"
