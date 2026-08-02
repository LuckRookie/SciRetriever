from __future__ import annotations

import unicodedata

from pydantic import BaseModel, ConfigDict, field_validator

from sciretriever.model.primitives import (
    AnalysisArtifactId,
    LightDocumentId,
    MetadataSnapshotId,
    ObservationId,
    Sha256,
    StableIdentifierId,
    UtcTimestamp,
    VersionRelationId,
    WorkId,
    WorkVersionAssetId,
    WorkVersionId,
)


class _LiteratureModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class Identifier(_LiteratureModel):
    namespace: str
    value: str

    def __hash__(self) -> int:
        return hash((self.namespace, self.value))

    @field_validator("namespace", "value")
    @classmethod
    def validate_nonblank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must be a nonblank string")
        return unicodedata.normalize("NFC", value)


class InitialMetadata(_LiteratureModel):
    title: str | None = None
    authors: tuple[str, ...] = ()
    year: int | None = None
    item_type: str | None = None
    abstract: str | None = None
    venue: str | None = None
    language: str | None = None
    keywords: tuple[str, ...] = ()


class VersionRelationEvidence(_LiteratureModel):
    target_identifier: Identifier
    relation: str


class BibliographicObservation(_LiteratureModel):
    provider: str
    provider_record_id: str
    source_priority: int
    observed_at: UtcTimestamp
    identifiers: tuple[Identifier, ...]
    metadata: InitialMetadata
    version_role: str
    version_relation: VersionRelationEvidence | None = None


class StoredObservation(_LiteratureModel):
    observation_id: ObservationId
    provider: str
    provider_record_id: str
    payload_sha256: Sha256
    payload_json: str
    observed_at: UtcTimestamp


class IdentityRecord(_LiteratureModel):
    work_id: WorkId
    work_version_id: WorkVersionId
    representative_version_id: WorkVersionId | None
    version_role: str
    identifiers: tuple[Identifier, ...]
    current_metadata: InitialMetadata | None
    metadata_revision: int | None
    completed: bool
    identity_revision: Sha256


class PreparedIdentifier(_LiteratureModel):
    identifier_id: StableIdentifierId
    value: Identifier


class PreparedMetadataSnapshot(_LiteratureModel):
    snapshot_id: MetadataSnapshotId
    revision: int
    sha256: Sha256
    values_json: str
    provenance_json: str


class PreparedVersionRelation(_LiteratureModel):
    relation_id: VersionRelationId
    left_version_id: WorkVersionId
    right_version_id: WorkVersionId
    relation: str


class IdentityReviewRelation(_LiteratureModel):
    left_version_id: WorkVersionId
    right_version_id: WorkVersionId
    relation: str
    evidence: str


class ExpectedIdentityRevision(_LiteratureModel):
    work_version_id: WorkVersionId
    revision: Sha256


class SupersededIdentity(_LiteratureModel):
    work_id: WorkId
    work_version_id: WorkVersionId


class PreparedRoleUpdate(_LiteratureModel):
    work_version_id: WorkVersionId
    expected_role: str
    role: str


class PreparedBibliographyAcceptance(_LiteratureModel):
    work_id: WorkId
    work_version_id: WorkVersionId
    version_role: str
    representative_version_id: WorkVersionId
    identifiers: tuple[PreparedIdentifier, ...]
    observations: tuple[StoredObservation, ...]
    metadata_snapshot: PreparedMetadataSnapshot | None
    version_relations: tuple[PreparedVersionRelation, ...]
    review_relations: tuple[IdentityReviewRelation, ...]
    expected_revisions: tuple[ExpectedIdentityRevision, ...]
    superseded_identities: tuple[SupersededIdentity, ...]
    role_update: PreparedRoleUpdate | None


class VersionFacts(_LiteratureModel):
    work_id: WorkId
    work_version_id: WorkVersionId
    version_role: str
    metadata_snapshot_id: MetadataSnapshotId | None
    metadata_revision: int | None
    metadata_sha256: Sha256 | None
    accepted_primary_id: WorkVersionAssetId | None
    current_light_document_id: LightDocumentId | None
    current_light_sha256: Sha256 | None
    current_light_primary_id: WorkVersionAssetId | None
    current_light_complete: bool
    completion_light_document_id: LightDocumentId | None
    completion_analysis_artifact_id: AnalysisArtifactId | None
    analysis_light_document_id: LightDocumentId | None
    analysis_input_sha256: Sha256 | None
    analysis_nine_categories_complete: bool
    completion_metadata_snapshot_id: MetadataSnapshotId | None
    completion_reference_set_id: str | None
    completion_reference_set_complete: bool
    completion_tag_set_id: str | None
    completion_tag_set_complete: bool
