from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import NAMESPACE_URL, uuid5

import sciretriever.model.assets as asset_models
import sciretriever.model.documents as document_models
from sciretriever.content.light_serialization import document_bytes
from sciretriever.kernel import (
    CanonicalJsonObject,
    parse_canonical_json,
)
from sciretriever.model.documents import LightDocumentAcceptance
from sciretriever.model.primitives import (
    AssetId,
    LightDocumentId,
    RelativeArtifactPath,
    Sha256,
    sha256_digest,
)


class LightArtifactStore(Protocol):
    def publish(self, artifact: asset_models.StagedArtifact) -> asset_models.PublishedArtifact: ...


class LightAcceptanceSink(Protocol):
    def publish(self, acceptance: LightDocumentAcceptance) -> None: ...


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
    artifact: asset_models.PublishedArtifact


@dataclass(frozen=True, slots=True)
class LightDocumentService:
    store: LightArtifactStore
    publisher: LightAcceptanceSink

    def publish(
        self,
        target: document_models.LightPublicationTarget,
        document: document_models.LightDocumentV1,
        parser: ParserIdentity,
    ) -> LightDocumentPublication:
        content = document_bytes(document)
        digest = sha256_digest(content)
        document_id = LightDocumentId(
            str(uuid5(NAMESPACE_URL, f"light-document:{target.work_version_id}:{digest}"))
        )
        artifact_id = AssetId(str(uuid5(NAMESPACE_URL, f"light-artifact:{digest}")))
        staged = asset_models.StagedArtifact(
            kind=asset_models.ArtifactKind.LIGHT_DOCUMENT,
            path=RelativeArtifactPath("ignored"),
            sha256=digest,
            content=content,
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
                work_version_id=target.work_version_id,
                expected_primary_relation_id=target.primary_relation_id,
                expected_primary_sha256=target.primary_sha256,
                document_id=document_id,
                artifact_id=artifact_id,
                artifact=published,
                document=document_value,
                provenance=provenance,
            )
        )
        return LightDocumentPublication(document_id, artifact_id, published)


__all__ = (
    "LightDocumentPublication",
    "LightDocumentService",
    "ParserIdentity",
)
