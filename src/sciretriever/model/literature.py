from __future__ import annotations

import unicodedata
from enum import Enum, unique

from pydantic import BaseModel, ConfigDict, Field, SkipValidation, field_validator

from sciretriever.model.canonical_json import CanonicalJsonObject
from sciretriever.model.primitives import (
    AnalysisArtifactId,
    AssetId,
    LightDocumentId,
    MetadataSnapshotId,
    ObservationId,
    ReferenceMemberId,
    ReferenceSetId,
    RelativeArtifactPath,
    Sha256,
    StableIdentifierId,
    TagMemberId,
    TagSetId,
    UtcTimestamp,
    VersionRelationId,
    WorkId,
    WorkVersionAssetId,
    WorkVersionId,
)


class _LiteratureModel(BaseModel):
    model_config = ConfigDict(
        arbitrary_types_allowed=True,
        extra="forbid",
        frozen=True,
        strict=True,
    )


class Identifier(_LiteratureModel):
    namespace: str
    value: str

    @field_validator("namespace", "value")
    @classmethod
    def validate_nonblank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must be a nonblank string")
        return unicodedata.normalize("NFC", value)


class Author(_LiteratureModel):
    display_name: str
    family_name: str | None
    given_name: str | None
    orcid: str | None
    affiliations: tuple[str, ...]

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must be a nonblank string")
        return unicodedata.normalize("NFC", value)

    @field_validator("family_name", "given_name", "orcid")
    @classmethod
    def validate_optional_names(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not value.strip():
            raise ValueError("must be a nonblank string")
        return unicodedata.normalize("NFC", value)

    @field_validator("affiliations")
    @classmethod
    def validate_affiliations(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        normalized = tuple(unicodedata.normalize("NFC", item) for item in value)
        if any(not item.strip() for item in normalized):
            raise ValueError("must be a nonblank string")
        if len(normalized) != len(set(normalized)):
            raise ValueError("duplicate affiliations")
        return normalized


class InitialMetadata(_LiteratureModel):
    title: str | None = None
    authors: tuple[str, ...] = ()
    year: int | None = None
    item_type: str | None = None
    abstract: str | None = None
    venue: str | None = None
    language: str | None = None
    keywords: tuple[str, ...] = ()


class UnifiedMetadataSnapshot(_LiteratureModel):
    snapshot_id: MetadataSnapshotId
    revision: int = Field(strict=True, ge=1)
    title: str
    authors: tuple[str, ...]
    identifiers: tuple[Identifier, ...]
    abstract: str | None = None
    publication_date: str | None = None
    publication_year: int | None = Field(default=None, strict=True)
    publisher: str | None = None
    venue: str | None = None
    volume: str | None = None
    issue: str | None = None
    pages: str | None = None
    article_number: str | None = None
    work_type: str | None = None
    language: str | None = None
    keywords: tuple[str, ...] = ()
    sha256: Sha256 | None = None

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("title must be nonblank")
        return value


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


class IdentityResolution(_LiteratureModel):
    observations: tuple[BibliographicObservation, ...]
    metadata: InitialMetadata
    provenance_json: str
    identifiers: tuple[Identifier, ...]
    records: tuple[IdentityRecord, ...]
    related_records: tuple[IdentityRecord, ...]
    candidate_records: tuple[IdentityRecord, ...]
    compatible_records: tuple[IdentityRecord, ...]
    selected_record: IdentityRecord | None
    work_id: WorkId
    work_version_id: WorkVersionId
    version_role: str
    anchor: str


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


class ReferenceMemberFact(_LiteratureModel):
    member_id: ReferenceMemberId
    raw_text: str
    reference: SkipValidation[CanonicalJsonObject]
    target_work_id: WorkId | None = None
    target_work_version_id: WorkVersionId | None = None


class TagMemberFact(_LiteratureModel):
    member_id: TagMemberId
    name: str
    evidence: SkipValidation[CanonicalJsonObject]


class ReferenceSetFact(_LiteratureModel):
    set_id: ReferenceSetId
    work_version_id: WorkVersionId
    revision: int = Field(ge=1)
    members: tuple[ReferenceMemberFact, ...]


class TagSetFact(_LiteratureModel):
    set_id: TagSetId
    work_version_id: WorkVersionId
    revision: int = Field(ge=1)
    members: tuple[TagMemberFact, ...]


class FinalMetadataFact(_LiteratureModel):
    work_version_id: WorkVersionId
    expected_snapshot_id: MetadataSnapshotId
    expected_revision: int = Field(ge=1)
    expected_sha256: Sha256
    snapshot_id: MetadataSnapshotId
    revision: int = Field(ge=1)
    sha256: Sha256
    values: SkipValidation[CanonicalJsonObject]
    provenance: SkipValidation[CanonicalJsonObject]


class CompletionAnalysisFact(_LiteratureModel):
    work_version_id: WorkVersionId
    light_document_id: LightDocumentId
    input_sha256: Sha256
    analysis_id: AnalysisArtifactId
    artifact_id: AssetId
    artifact_path: RelativeArtifactPath
    artifact_sha256: Sha256
    artifact_size: int = Field(ge=0)
    proposal: SkipValidation[CanonicalJsonObject]


class CompletionProvenance(_LiteratureModel):
    parser_identity: str = Field(min_length=1)
    model_provider: str = Field(min_length=1)
    model_identity: str = Field(min_length=1)
    input_sha256: Sha256
    parameters_sha256: Sha256
    evidence: SkipValidation[CanonicalJsonObject]


class CompletionSubmission(_LiteratureModel):
    work_version_id: WorkVersionId
    light_document_id: LightDocumentId
    light_document_sha256: Sha256
    analysis: CompletionAnalysisFact
    metadata: FinalMetadataFact
    references: ReferenceSetFact
    tags: TagSetFact
    provenance: CompletionProvenance


@unique
class CompletionOutcome(str, Enum):
    PUBLISHED = "published"
    REPLAYED = "replayed"


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


class IdentityCandidateQuery(_LiteratureModel):
    identifiers: tuple[Identifier, ...]


class IdentityCandidate(_LiteratureModel):
    work_id: WorkId
    work_version_id: WorkVersionId
    matched_identifiers: tuple[Identifier, ...]


class IdentityCandidateSet(_LiteratureModel):
    candidates: tuple[IdentityCandidate, ...]


class WorkFacts(_LiteratureModel):
    work_id: WorkId
    representative_version_id: WorkVersionId | None
    version_ids: tuple[WorkVersionId, ...]
