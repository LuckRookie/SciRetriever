from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import NAMESPACE_URL, uuid5

from sciretriever.content.light_models import LightDocumentV1
from sciretriever.content.model import ArtifactKind, PublishedArtifact, StagedArtifact
from sciretriever.content.publisher_contracts import LightDocumentAcceptance
from sciretriever.kernel import (
    CanonicalJsonObject,
    parse_canonical_json,
)
from sciretriever.model.primitives import (
    AssetId,
    LightDocumentId,
    RelativeArtifactPath,
    Sha256,
    WorkVersionAssetId,
    WorkVersionId,
    sha256_digest,
)


class LightArtifactStore(Protocol):
    def publish(self, artifact: StagedArtifact) -> PublishedArtifact: ...


class LightAcceptanceSink(Protocol):
    def publish(self, acceptance: LightDocumentAcceptance) -> None: ...


@dataclass(frozen=True, slots=True)
class LightPublicationTarget:
    work_version_id: WorkVersionId
    primary_relation_id: WorkVersionAssetId
    primary_asset_id: AssetId
    primary_sha256: Sha256


@dataclass(frozen=True, slots=True)
class ParserIdentity:
    name: str
    version: str
    backend: str
    model: str
    parameters_sha256: Sha256


@dataclass(frozen=True, slots=True)
class LightDocumentPublication:
    document_id: LightDocumentId
    artifact_id: AssetId
    artifact: PublishedArtifact


@dataclass(frozen=True, slots=True)
class LightDocumentService:
    store: LightArtifactStore
    publisher: LightAcceptanceSink

    def publish(
        self, target: LightPublicationTarget, document: LightDocumentV1, parser: ParserIdentity
    ) -> LightDocumentPublication:
        content = document.canonical_bytes()
        digest = sha256_digest(content)
        document_id = LightDocumentId(
            str(uuid5(NAMESPACE_URL, f"light-document:{target.work_version_id}:{digest}"))
        )
        artifact_id = AssetId(str(uuid5(NAMESPACE_URL, f"light-artifact:{digest}")))
        staged = StagedArtifact(
            ArtifactKind.LIGHT_DOCUMENT, RelativeArtifactPath("ignored"), digest, content
        )
        published = self.store.publish(staged)
        document_value = parse_canonical_json(content.decode("ascii"))
        if not isinstance(document_value, CanonicalJsonObject):
            raise AssertionError("canonical light document must be an object")
        provenance = CanonicalJsonObject(
            (
                ("backend", parser.backend),
                ("model", parser.model),
                ("parameters_sha256", str(parser.parameters_sha256)),
                ("parser_name", parser.name),
                ("parser_version", parser.version),
                ("primary_asset_id", str(target.primary_asset_id)),
                ("primary_sha256", str(target.primary_sha256)),
            )
        )
        self.publisher.publish(
            LightDocumentAcceptance(
                target.work_version_id,
                target.primary_relation_id,
                target.primary_sha256,
                document_id,
                artifact_id,
                published,
                document_value,
                provenance,
            )
        )
        return LightDocumentPublication(document_id, artifact_id, published)


__all__ = (
    "LightDocumentPublication",
    "LightDocumentService",
    "LightPublicationTarget",
    "ParserIdentity",
)
