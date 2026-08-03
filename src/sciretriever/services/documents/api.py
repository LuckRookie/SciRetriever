from __future__ import annotations

from dataclasses import dataclass
from uuid import NAMESPACE_URL, uuid5

from sciretriever.core.documents import (
    document_bytes,
    validate_light_document,
    validate_light_document_acceptance,
)
from sciretriever.core.documents.validation import LightDocumentError
from sciretriever.core.execution import (
    build_target_result_envelope,
    validate_content_acceptance_command,
)
from sciretriever.model import assets as asset_models
from sciretriever.model import documents as document_models
from sciretriever.model.canonical_json import CanonicalJsonObject, parse_canonical_json
from sciretriever.model.execution import (
    ContentAcceptanceCommand,
    TargetProjection,
    ValidatedDocumentAcceptance,
)
from sciretriever.model.parsing import ParserRequest, ParserResult
from sciretriever.model.primitives import (
    AssetId,
    LightDocumentId,
    RelativeArtifactPath,
    sha256_digest,
)

from .ports import DocumentAcceptancePort, DocumentArtifactStorePort, ParserPort


@dataclass(frozen=True, slots=True)
class DocumentServiceDependencies:
    parser: ParserPort
    store: DocumentArtifactStorePort
    publisher: DocumentAcceptancePort
    bounds: document_models.LightDocumentBounds = document_models.LightDocumentBounds()


def accept_document(
    publisher: DocumentAcceptancePort,
    acceptance: document_models.LightDocumentAcceptance,
    projection: TargetProjection,
) -> None:
    command = ContentAcceptanceCommand(acceptance=acceptance, target=projection)
    validate_light_document_acceptance(acceptance)
    validate_content_acceptance_command(command)
    publisher.publish(
        ValidatedDocumentAcceptance(
            acceptance=acceptance,
            target=projection,
            target_result=build_target_result_envelope(projection),
        )
    )


class LightDocumentService:
    def __init__(self, dependencies: DocumentServiceDependencies) -> None:
        self._dependencies = dependencies

    def accept(
        self,
        target: document_models.LightPublicationTarget,
        request: ParserRequest,
        projection: TargetProjection,
    ) -> document_models.LightDocumentPublication:
        if (
            request.asset_id != target.primary_asset_id
            or request.asset_sha256 != target.primary_sha256
            or sha256_digest(request.pdf) != request.asset_sha256
        ):
            raise LightDocumentError("primary-target-mismatch")
        result = self._dependencies.parser.parse(request)
        self._validate_result(result, request, target)
        content = document_bytes(result.document)
        digest = sha256_digest(content)
        published = self._dependencies.store.publish(
            asset_models.StagedArtifact(
                kind=asset_models.ArtifactKind.LIGHT_DOCUMENT,
                path=RelativeArtifactPath("staged"),
                sha256=digest,
                content=content,
            )
        )
        value = parse_canonical_json(content.decode("ascii"))
        if not isinstance(value, CanonicalJsonObject):
            raise LightDocumentError("document-canonical-object")
        acceptance = document_models.LightDocumentAcceptance(
            work_version_id=target.work_version_id,
            expected_primary_relation_id=target.primary_relation_id,
            expected_primary_sha256=target.primary_sha256,
            document_id=LightDocumentId(
                str(uuid5(NAMESPACE_URL, f"light-document:{target.work_version_id}:{digest}"))
            ),
            artifact_id=AssetId(str(uuid5(NAMESPACE_URL, f"light-artifact:{digest}"))),
            artifact=published,
            document=value,
            provenance=self._provenance(result, target),
        )
        accept_document(self._dependencies.publisher, acceptance, projection)
        return document_models.LightDocumentPublication(
            document_id=acceptance.document_id,
            artifact_id=acceptance.artifact_id,
            artifact=published,
            document=result.document,
        )

    def _validate_result(
        self,
        result: ParserResult,
        request: ParserRequest,
        target: document_models.LightPublicationTarget,
    ) -> None:
        if result.provenance.input_sha256 != request.asset_sha256:
            raise LightDocumentError("parser-input-mismatch")
        if target.primary_asset_id != request.asset_id:
            raise LightDocumentError("primary-target-mismatch")
        validate_light_document(
            result.document,
            target.primary_asset_id,
            result.pdf_pages,
            result.block_manifest,
            self._dependencies.bounds,
        )

    @staticmethod
    def _provenance(
        result: ParserResult,
        target: document_models.LightPublicationTarget,
    ) -> CanonicalJsonObject:
        parser = result.provenance
        return CanonicalJsonObject(
            (
                ("backend", parser.backend),
                ("input_sha256", str(parser.input_sha256)),
                ("model", parser.model),
                ("parameters_sha256", str(parser.parameters_sha256)),
                ("parser_name", parser.parser_name),
                ("parser_version", parser.parser_version),
                ("primary_asset_id", str(target.primary_asset_id)),
                ("primary_sha256", str(target.primary_sha256)),
                ("task_id", parser.task_id),
            )
        )


__all__ = ("DocumentServiceDependencies", "LightDocumentService", "accept_document")
