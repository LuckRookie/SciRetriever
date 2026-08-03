from __future__ import annotations

from pydantic import BaseModel, ConfigDict, model_validator

from sciretriever.model.library_details import WorkVersionDetail
from sciretriever.model.library_query import QueryFilterV1
from sciretriever.model.literature import Identifier, VersionFacts, WorkFacts
from sciretriever.model.primitives import (
    AssetId,
    CollectionId,
    CurationPlanId,
    MembershipId,
    ObservationId,
    ReferenceFactId,
    Sha256,
    StableIdentifierId,
    VersionRelationId,
    VersionRole,
    WorkId,
    WorkVersionId,
)
from sciretriever.model.record import ExportOmission, ImportedBibliographicRecord


class _LibraryModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class _LibraryStructureError(ValueError):
    pass


class CurationScope(_LibraryModel):
    work_ids: tuple[WorkId, ...]
    work_version_ids: tuple[WorkVersionId, ...]


class SnapshotToken(_LibraryModel):
    sha256: Sha256


class CurationSnapshot(_LibraryModel):
    scope: CurationScope
    token: SnapshotToken
    works: tuple[WorkFacts, ...]
    versions: tuple[VersionFacts, ...]


class CurationCommit(_LibraryModel):
    plan_id: CurationPlanId
    resulting_snapshot: SnapshotToken


class IdentifierFact(_LibraryModel):
    identifier_id: StableIdentifierId
    version_id: WorkVersionId
    value: Identifier


class ObservationFact(_LibraryModel):
    observation_id: ObservationId
    version_id: WorkVersionId


class MembershipFact(_LibraryModel):
    membership_id: MembershipId
    collection_id: CollectionId
    work_id: WorkId


class ReferenceFact(_LibraryModel):
    reference_id: ReferenceFactId
    source_version_id: WorkVersionId
    target_work_id: WorkId | None
    target_version_id: WorkVersionId | None
    raw_text: str
    reference_json: str


class RelationFact(_LibraryModel):
    relation_id: VersionRelationId
    left_version_id: WorkVersionId
    right_version_id: WorkVersionId
    relation: str


class ArtifactRegistrationFact(_LibraryModel):
    artifact_id: AssetId
    version_id: WorkVersionId


class CurationTopology(_LibraryModel):
    snapshot: CurationSnapshot
    identifiers: tuple[IdentifierFact, ...]
    observations: tuple[ObservationFact, ...]
    memberships: tuple[MembershipFact, ...]
    references: tuple[ReferenceFact, ...]
    relations: tuple[RelationFact, ...]
    artifact_registrations: tuple[ArtifactRegistrationFact, ...]


class VersionMove(_LibraryModel):
    version_id: WorkVersionId
    target_work_id: WorkId


class ObservationMove(_LibraryModel):
    observation_id: ObservationId
    target_version_id: WorkVersionId


class IdentifierMove(_LibraryModel):
    identifier_id: StableIdentifierId
    target_version_id: WorkVersionId


class MembershipMove(_LibraryModel):
    membership_id: MembershipId
    target_work_id: WorkId
    coalesce_membership_id: MembershipId | None


class ReferenceRetarget(_LibraryModel):
    reference_id: ReferenceFactId
    target_work_id: WorkId | None
    target_version_id: WorkVersionId | None
    downgrade_raw_text: str | None
    downgrade_reference_json: str | None


class RelationRetarget(_LibraryModel):
    relation_id: VersionRelationId
    left_version_id: WorkVersionId
    right_version_id: WorkVersionId


class RelationDelete(_LibraryModel):
    relation_id: VersionRelationId


class RepresentativeUpdate(_LibraryModel):
    work_id: WorkId
    version_id: WorkVersionId | None


class ValidatedVersionRelation(_LibraryModel):
    relation_id: VersionRelationId
    left_version_id: WorkVersionId
    right_version_id: WorkVersionId
    relation: str


class ValidatedCurationPlan(_LibraryModel):
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


class ExportSelectionRequest(_LibraryModel):
    filters: QueryFilterV1
    all_versions: bool = False


class ExportCandidate(_LibraryModel):
    work_id: WorkId
    work_version_id: WorkVersionId
    version_role: VersionRole
    detail: WorkVersionDetail

    @model_validator(mode="after")
    def matches_detail_identity(self) -> ExportCandidate:
        if (
            self.detail.work_id != self.work_id
            or self.detail.work_version_id != self.work_version_id
        ):
            raise _LibraryStructureError("export candidate identity must match its detail")
        return self


class ExportPreparedRecord(_LibraryModel):
    work_id: WorkId
    work_version_id: WorkVersionId
    record: ImportedBibliographicRecord
    omissions: tuple[ExportOmission, ...]


__all__ = (
    "ArtifactRegistrationFact",
    "CurationCommit",
    "CurationScope",
    "CurationSnapshot",
    "CurationTopology",
    "ExportCandidate",
    "ExportPreparedRecord",
    "ExportSelectionRequest",
    "IdentifierFact",
    "MembershipFact",
    "ObservationFact",
    "ReferenceFact",
    "ReferenceRetarget",
    "RelationDelete",
    "RelationFact",
    "RelationRetarget",
    "RepresentativeUpdate",
    "SnapshotToken",
    "ValidatedCurationPlan",
    "ValidatedVersionRelation",
    "VersionMove",
    "ObservationMove",
    "IdentifierMove",
    "MembershipMove",
)
