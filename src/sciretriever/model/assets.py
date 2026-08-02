from __future__ import annotations

from enum import Enum, unique
from typing import TypeAlias

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SkipValidation,
    field_validator,
    model_validator,
)

from sciretriever.model.access import BoundedByteStream, Header
from sciretriever.model.canonical_json import CanonicalJsonObject
from sciretriever.model.literature import UnifiedMetadataSnapshot
from sciretriever.model.primitives import (
    AssetId,
    AssetRole,
    LightDocumentId,
    MetadataSnapshotId,
    RelativeArtifactPath,
    Sha256,
    WorkVersionAssetId,
    WorkVersionId,
)


class _AssetsModel(BaseModel):
    model_config = ConfigDict(
        arbitrary_types_allowed=True,
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


def _nonblank(value: str) -> str:
    if not value.strip():
        raise ValueError("must be a nonblank string")
    return value


class AssetCandidate(_AssetsModel):
    provider: str
    role: AssetRole
    locator: str
    headers: tuple[Header, ...]

    @field_validator("provider", "locator")
    @classmethod
    def validate_text(cls, value: str) -> str:
        return _nonblank(value)


class AcceptedContentReference(_AssetsModel):
    content_id: AssetId | LightDocumentId
    sha256: Sha256
    revision: int = Field(strict=True, ge=1)


class ContentTarget(_AssetsModel):
    work_version_id: WorkVersionId
    current_metadata: UnifiedMetadataSnapshot
    accepted_content: tuple[AcceptedContentReference, ...]
    current_accepted_content: AcceptedContentReference | None
    expected_metadata_revision: int = Field(strict=True, ge=1)
    expected_accepted_content_sha256: Sha256 | None
    expected_accepted_content_revision: int | None

    @model_validator(mode="after")
    def validate_alignment(self) -> ContentTarget:
        if (
            self.current_accepted_content is not None
            and self.current_accepted_content not in self.accepted_content
        ):
            raise ValueError("current accepted content must be present in accepted content")
        if self.expected_metadata_revision != self.current_metadata.revision:
            raise ValueError("expected metadata revision must match current metadata")
        current = self.current_accepted_content
        current_hash = None if current is None else current.sha256
        current_revision = None if current is None else current.revision
        if self.expected_accepted_content_sha256 != current_hash:
            raise ValueError("expected accepted content hash must match current content")
        if self.expected_accepted_content_revision != current_revision:
            raise ValueError("expected accepted content revision must match current content")
        return self


class AcceptedPrimaryPdf(_AssetsModel):
    asset_id: AssetId
    work_version_id: WorkVersionId
    sha256: Sha256
    media_type: str

    @field_validator("media_type")
    @classmethod
    def validate_media_type(cls, value: str) -> str:
        return _nonblank(value)


class CandidateEvidence(_AssetsModel):
    provider: str
    outcome: str

    @field_validator("provider", "outcome")
    @classmethod
    def validate_text(cls, value: str) -> str:
        return _nonblank(value)


class ContentAssetFailure(_AssetsModel):
    code: str
    evidence: tuple[CandidateEvidence, ...]

    @field_validator("code")
    @classmethod
    def validate_code(cls, value: str) -> str:
        return _nonblank(value)


class ContentAssetReplay(_AssetsModel):
    asset_id: AssetId
    sha256: Sha256


class ContentAssetSuccess(_AssetsModel):
    asset_id: AssetId
    relation_id: WorkVersionAssetId
    sha256: Sha256
    provider: str
    role: AssetRole

    @field_validator("provider")
    @classmethod
    def validate_provider(cls, value: str) -> str:
        return _nonblank(value)


class AcceptedCandidate(_AssetsModel):
    candidate: AssetCandidate
    content: BoundedByteStream = Field(repr=False)


ContentAssetResult: TypeAlias = ContentAssetFailure | ContentAssetReplay | ContentAssetSuccess


@unique
class ArtifactKind(str, Enum):
    PRIMARY_PDF = "primary-pdf"
    SUPPLEMENTARY = "supplementary"
    LIGHT_DOCUMENT = "light-document"
    ANALYSIS = "analysis"


class StagedArtifact(_AssetsModel):
    kind: ArtifactKind
    path: RelativeArtifactPath
    sha256: Sha256
    content: bytes = Field(repr=False, strict=True)


class PublishedArtifact(_AssetsModel):
    kind: ArtifactKind
    path: RelativeArtifactPath
    sha256: Sha256
    size: int = Field(strict=True, ge=0)


class PrimaryPdfAcceptance(_AssetsModel):
    work_version_id: WorkVersionId
    expected_metadata_id: MetadataSnapshotId
    expected_metadata_revision: int
    expected_metadata_sha256: Sha256
    artifact_id: AssetId
    relation_id: WorkVersionAssetId
    artifact: PublishedArtifact
    source: SkipValidation[CanonicalJsonObject]


class SupplementaryAssetAcceptance(_AssetsModel):
    work_version_id: WorkVersionId
    expected_metadata_id: MetadataSnapshotId
    expected_metadata_revision: int
    expected_metadata_sha256: Sha256
    expected_primary_sha256: Sha256 | None
    artifact_id: AssetId
    relation_id: WorkVersionAssetId
    role: AssetRole
    media_type: str
    artifact: PublishedArtifact
    source: SkipValidation[CanonicalJsonObject]


__all__ = (
    "AcceptedCandidate",
    "AcceptedContentReference",
    "AcceptedPrimaryPdf",
    "ArtifactKind",
    "AssetCandidate",
    "CandidateEvidence",
    "ContentAssetFailure",
    "ContentAssetReplay",
    "ContentAssetResult",
    "ContentAssetSuccess",
    "ContentTarget",
    "PublishedArtifact",
    "PrimaryPdfAcceptance",
    "StagedArtifact",
    "SupplementaryAssetAcceptance",
)
