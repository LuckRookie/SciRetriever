from __future__ import annotations

from dataclasses import dataclass

from sciretriever.content.model import ArtifactKind, PublishedArtifact
from sciretriever.kernel import (
    BoundaryError,
    CanonicalJsonObject,
    canonical_json_bytes,
)
from sciretriever.model.primitives import (
    AssetId,
    AssetRole,
    LightDocumentId,
    MetadataSnapshotId,
    Sha256,
    WorkVersionAssetId,
    WorkVersionId,
    sha256_digest,
)


@dataclass(frozen=True, slots=True)
class PrimaryPdfAcceptance:
    work_version_id: WorkVersionId
    expected_metadata_id: MetadataSnapshotId
    expected_metadata_revision: int
    expected_metadata_sha256: Sha256
    artifact_id: AssetId
    relation_id: WorkVersionAssetId
    artifact: PublishedArtifact
    source: CanonicalJsonObject


@dataclass(frozen=True, slots=True)
class SupplementaryAssetAcceptance:
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
    source: CanonicalJsonObject

    def __post_init__(self) -> None:
        if self.role is AssetRole.PRIMARY_PDF:
            raise BoundaryError.for_field("role", "must be a supplementary role")
        if self.artifact.kind is not ArtifactKind.SUPPLEMENTARY:
            raise BoundaryError.for_field("artifact", "must be supplementary")


@dataclass(frozen=True, slots=True)
class LightDocumentAcceptance:
    work_version_id: WorkVersionId
    expected_primary_relation_id: WorkVersionAssetId
    expected_primary_sha256: Sha256
    document_id: LightDocumentId
    artifact_id: AssetId
    artifact: PublishedArtifact
    document: CanonicalJsonObject
    provenance: CanonicalJsonObject

    def __post_init__(self) -> None:
        _verify_structured_artifact(self.artifact, ArtifactKind.LIGHT_DOCUMENT, self.document)


def _verify_structured_artifact(
    artifact: PublishedArtifact,
    kind: ArtifactKind,
    payload: CanonicalJsonObject,
) -> None:
    canonical = canonical_json_bytes(payload)
    if artifact.kind is not kind:
        raise BoundaryError.for_field("artifact", f"must be a {kind.value} artifact")
    if artifact.sha256 != sha256_digest(canonical):
        raise BoundaryError.for_field("artifact", "sha256 must identify canonical payload bytes")
    if artifact.size != len(canonical):
        raise BoundaryError.for_field("artifact", "size must equal canonical payload byte length")


ContentAcceptance = PrimaryPdfAcceptance | SupplementaryAssetAcceptance | LightDocumentAcceptance


__all__ = (
    "ContentAcceptance",
    "LightDocumentAcceptance",
    "PrimaryPdfAcceptance",
    "SupplementaryAssetAcceptance",
)
