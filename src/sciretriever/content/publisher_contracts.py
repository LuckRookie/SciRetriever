from __future__ import annotations

import sciretriever.model.documents as document_models
from sciretriever.kernel.errors import BoundaryError
from sciretriever.model.assets import ArtifactKind, PublishedArtifact
from sciretriever.model.canonical_json import CanonicalJsonObject, canonical_json_bytes
from sciretriever.model.primitives import sha256_digest


def validate_light_document_acceptance(value: document_models.LightDocumentAcceptance) -> None:
    _verify_structured_artifact(value.artifact, ArtifactKind.LIGHT_DOCUMENT, value.document)


def _verify_published_artifact(artifact: PublishedArtifact) -> None:
    directories = {
        ArtifactKind.PRIMARY_PDF: "primary",
        ArtifactKind.SUPPLEMENTARY: "supplementary",
        ArtifactKind.LIGHT_DOCUMENT: "light-document",
        ArtifactKind.ANALYSIS: "analysis",
    }
    digest = str(artifact.sha256)
    expected = f"{directories[artifact.kind]}/{digest[:2]}/{digest}"
    if str(artifact.path) != expected or artifact.size <= 0:
        raise BoundaryError.for_field("artifact", "published artifact identity is inconsistent")


def _verify_artifact_kind(
    artifact: PublishedArtifact,
    expected: ArtifactKind,
) -> None:
    if artifact.kind is not expected:
        raise BoundaryError.for_field("artifact", f"must be a {expected.value} artifact")


def _verify_structured_artifact(
    artifact: PublishedArtifact,
    kind: ArtifactKind,
    payload: CanonicalJsonObject,
) -> None:
    _verify_published_artifact(artifact)
    canonical = canonical_json_bytes(payload)
    _verify_artifact_kind(artifact, kind)
    if artifact.sha256 != sha256_digest(canonical):
        raise BoundaryError.for_field("artifact", "sha256 must identify canonical payload bytes")
    if artifact.size != len(canonical):
        raise BoundaryError.for_field("artifact", "size must equal canonical payload byte length")


__all__ = ("validate_light_document_acceptance",)
