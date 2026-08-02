from __future__ import annotations

from typing import assert_never

import sciretriever.model.assets as asset_models
import sciretriever.model.documents as document_models
from sciretriever.kernel.errors import BoundaryError
from sciretriever.model.canonical_json import CanonicalJsonObject, canonical_json_bytes
from sciretriever.model.primitives import sha256_digest


def validate_content_acceptance(
    value: (
        asset_models.PrimaryPdfAcceptance
        | asset_models.SupplementaryAssetAcceptance
        | document_models.LightDocumentAcceptance
    ),
) -> None:
    match value:
        case asset_models.PrimaryPdfAcceptance():
            _verify_published_artifact(value.artifact)
            _verify_artifact_kind(value.artifact, asset_models.ArtifactKind.PRIMARY_PDF)
        case asset_models.SupplementaryAssetAcceptance():
            _verify_published_artifact(value.artifact)
            if value.role is asset_models.AssetRole.PRIMARY_PDF:
                raise BoundaryError.for_field("role", "must be a supplementary role")
            _verify_artifact_kind(value.artifact, asset_models.ArtifactKind.SUPPLEMENTARY)
        case document_models.LightDocumentAcceptance():
            _verify_structured_artifact(
                value.artifact,
                asset_models.ArtifactKind.LIGHT_DOCUMENT,
                value.document,
            )
        case unreachable:
            assert_never(unreachable)


def _verify_published_artifact(artifact: asset_models.PublishedArtifact) -> None:
    directories = {
        asset_models.ArtifactKind.PRIMARY_PDF: "primary",
        asset_models.ArtifactKind.SUPPLEMENTARY: "supplementary",
        asset_models.ArtifactKind.LIGHT_DOCUMENT: "light-document",
        asset_models.ArtifactKind.ANALYSIS: "analysis",
    }
    digest = str(artifact.sha256)
    expected = f"{directories[artifact.kind]}/{digest[:2]}/{digest}"
    if str(artifact.path) != expected or artifact.size <= 0:
        raise BoundaryError.for_field("artifact", "published artifact identity is inconsistent")


def _verify_artifact_kind(
    artifact: asset_models.PublishedArtifact,
    expected: asset_models.ArtifactKind,
) -> None:
    if artifact.kind is not expected:
        raise BoundaryError.for_field("artifact", f"must be a {expected.value} artifact")


def _verify_structured_artifact(
    artifact: asset_models.PublishedArtifact,
    kind: asset_models.ArtifactKind,
    payload: CanonicalJsonObject,
) -> None:
    _verify_published_artifact(artifact)
    canonical = canonical_json_bytes(payload)
    _verify_artifact_kind(artifact, kind)
    if artifact.sha256 != sha256_digest(canonical):
        raise BoundaryError.for_field("artifact", "sha256 must identify canonical payload bytes")
    if artifact.size != len(canonical):
        raise BoundaryError.for_field("artifact", "size must equal canonical payload byte length")


__all__ = ("validate_content_acceptance",)
