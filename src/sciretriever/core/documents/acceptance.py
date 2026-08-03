from __future__ import annotations

from sciretriever.model import documents
from sciretriever.model.assets import ArtifactKind, PublishedArtifact
from sciretriever.model.canonical_json import CanonicalJsonObject, canonical_json_bytes
from sciretriever.model.primitives import sha256_digest

from .validation import LightDocumentError


def validate_light_document_acceptance(value: documents.LightDocumentAcceptance) -> None:
    _verify_structured_artifact(value.artifact, ArtifactKind.LIGHT_DOCUMENT, value.document)


def _verify_published_artifact(artifact: PublishedArtifact) -> None:
    expected = f"light-document/{str(artifact.sha256)[:2]}/{artifact.sha256}"
    if str(artifact.path) != expected or artifact.size <= 0:
        raise LightDocumentError("published-artifact-identity")


def _verify_structured_artifact(
    artifact: PublishedArtifact,
    kind: ArtifactKind,
    payload: CanonicalJsonObject,
) -> None:
    _verify_published_artifact(artifact)
    if artifact.kind is not kind:
        raise LightDocumentError("published-artifact-kind")
    canonical = canonical_json_bytes(payload)
    if artifact.sha256 != sha256_digest(canonical):
        raise LightDocumentError("published-artifact-sha256")
    if artifact.size != len(canonical):
        raise LightDocumentError("published-artifact-size")


__all__ = ("validate_light_document_acceptance",)
