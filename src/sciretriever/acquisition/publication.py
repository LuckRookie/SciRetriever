"""Validated primary-PDF publication for automatic and manual acquisition.

The automatic wrapper in this module is the only place that turns a
``TemporaryPdf`` into A2's owner-only ``ValidatedPdf``.  The candidate-neutral
publisher below it is deliberately reusable by manual acceptance: it knows
nothing about ``PdfCandidate`` or ``AcquisitionPath`` and returns only the
database facts that were actually committed.
"""

from __future__ import annotations

from collections.abc import Callable
from uuid import uuid4

import sciretriever.acquisition.ports as acquisition_ports
from sciretriever.acquisition.pdf_identity import browser_pdf_belongs_to_literature
from sciretriever.acquisition.ports import (
    AcquisitionExpectedFacts,
    AcquisitionFailure,
    PdfValidationStagingPort,
    TemporaryPdf,
)
from sciretriever.acquisition.routing import AcquisitionRequest
from sciretriever.acquisition.rules import (
    DEFAULT_MAX_PDF_BYTES,
    CancellationEvent,
    PdfValidationCancelled,
    PdfValidationError,
    PdfValidationStagingError,
    ValidatedPdf,
    validate_pdf,
)
from sciretriever.model.acquisition import AcquiredPrimaryPdf, AcquisitionPath
from sciretriever.model.primitives import (
    AssetId,
    LiteratureAssetId,
    SourceKind,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure

ArtifactIdFactory = Callable[[], str]
AssetIdFactory = Callable[[], AssetId]
LiteratureAssetIdFactory = Callable[[], LiteratureAssetId]


def _new_artifact_id() -> str:
    return str(uuid4())


def _new_asset_id() -> AssetId:
    return AssetId(str(uuid4()))


def _new_literature_asset_id() -> LiteratureAssetId:
    return LiteratureAssetId(str(uuid4()))


class ValidatedPrimaryPdfPublisher:
    """Candidate-neutral primary publication primitive shared with manual input."""

    __slots__ = (
        "_commit_port",
        "_artifact_id_factory",
        "_asset_id_factory",
        "_literature_asset_id_factory",
    )

    def __init__(
        self,
        commit_port: acquisition_ports.ValidatedPrimaryPdfCommitPort,
        *,
        artifact_id_factory: ArtifactIdFactory = _new_artifact_id,
        asset_id_factory: AssetIdFactory = _new_asset_id,
        literature_asset_id_factory: LiteratureAssetIdFactory = _new_literature_asset_id,
    ) -> None:
        if not isinstance(commit_port, acquisition_ports.ValidatedPrimaryPdfCommitPort):
            raise TypeError("commit_port must implement ValidatedPrimaryPdfCommitPort")
        if not callable(artifact_id_factory):
            raise TypeError("artifact_id_factory must be callable")
        if not callable(asset_id_factory):
            raise TypeError("asset_id_factory must be callable")
        if not callable(literature_asset_id_factory):
            raise TypeError("literature_asset_id_factory must be callable")
        self._commit_port = commit_port
        self._artifact_id_factory = artifact_id_factory
        self._asset_id_factory = asset_id_factory
        self._literature_asset_id_factory = literature_asset_id_factory

    def publish_validated_primary_pdf(
        self,
        *,
        expected_facts: AcquisitionExpectedFacts,
        validated_pdf: ValidatedPdf,
        provenance: Provenance,
        source_url: str | None,
        proposed_artifact_id: str | None = None,
        proposed_asset_id: AssetId | None = None,
        proposed_literature_asset_id: LiteratureAssetId | None = None,
    ) -> acquisition_ports.PrimaryPdfPublicationResult:
        """Commit a validated automatic or manual PDF and consume its staging lifetime."""

        if not isinstance(expected_facts, AcquisitionExpectedFacts):
            raise TypeError("expected_facts must be AcquisitionExpectedFacts")
        if not isinstance(validated_pdf, ValidatedPdf):
            raise TypeError("validated_pdf must be a ValidatedPdf")
        if not isinstance(provenance, Provenance):
            raise TypeError("provenance must be a Provenance")

        try:
            final_provenance = provenance.model_copy(update={"input_sha256": validated_pdf.sha256})
            artifact_id = (
                proposed_artifact_id
                if proposed_artifact_id is not None
                else self._artifact_id_factory()
            )
            asset_id = proposed_asset_id or self._asset_id_factory()
            relation_id = proposed_literature_asset_id or self._literature_asset_id_factory()
            if not isinstance(asset_id, AssetId):
                raise TypeError("asset_id_factory must return an AssetId")
            if not isinstance(relation_id, LiteratureAssetId):
                raise TypeError("literature_asset_id_factory must return a LiteratureAssetId")
            command = acquisition_ports.ValidatedPrimaryPdfPublicationCommand(
                expected_facts=expected_facts,
                proposed_artifact_id=artifact_id,
                proposed_asset_id=asset_id,
                proposed_literature_asset_id=relation_id,
                provenance=final_provenance,
                source_url=source_url,
            )
            result = self._commit_port.commit_validated_primary_pdf(command, validated_pdf)
            self._verify_result(command, validated_pdf, result)
        except AcquisitionFailure:
            self._close_after_failure(validated_pdf)
            raise
        except Exception:
            self._close_after_failure(validated_pdf)
            raise AcquisitionFailure(_publication_failure()) from None

        try:
            validated_pdf.close()
        except Exception:
            raise AcquisitionFailure(_publication_failure()) from None
        return result

    @staticmethod
    def _close_after_failure(validated_pdf: ValidatedPdf) -> None:
        try:
            validated_pdf.close()
        except Exception:
            pass

    @staticmethod
    def _verify_result(
        command: acquisition_ports.ValidatedPrimaryPdfPublicationCommand,
        validated_pdf: ValidatedPdf,
        result: object,
    ) -> None:
        if not isinstance(result, acquisition_ports.PrimaryPdfPublicationResult):
            raise AcquisitionFailure(_contract_failure())
        if (
            result.asset.sha256 != validated_pdf.sha256
            or result.asset.size_bytes != validated_pdf.byte_size
            or result.asset.media_type != validated_pdf.media_type
            or result.relation.literature_id != command.expected_facts.literature_id
            or result.relation.provenance != command.provenance
            or result.relation.source_url != command.source_url
        ):
            raise AcquisitionFailure(_contract_failure())


class _PreparedPrimaryPdf:
    """Private validated candidate retained only behind Acquisition's public receipt."""

    __slots__ = (
        "_candidate_key",
        "_expected_facts",
        "_issuer",
        "_provenance",
        "_source_url",
        "_validated_pdf",
    )

    def __init__(
        self,
        *,
        issuer: object,
        expected_facts: AcquisitionExpectedFacts,
        validated_pdf: ValidatedPdf,
        provenance: Provenance,
        source_url: str | None,
        candidate_key: str,
    ) -> None:
        self._issuer = issuer
        self._expected_facts = expected_facts
        self._validated_pdf: ValidatedPdf | None = validated_pdf
        self._provenance = provenance
        self._source_url = source_url
        self._candidate_key = candidate_key

    def consume(
        self,
        issuer: object,
    ) -> tuple[AcquisitionExpectedFacts, ValidatedPdf, Provenance, str | None, str]:
        validated_pdf = self._validated_pdf
        if self._issuer is not issuer or validated_pdf is None:
            raise AcquisitionFailure(_contract_failure())
        self._validated_pdf = None
        return (
            self._expected_facts,
            validated_pdf,
            self._provenance,
            self._source_url,
            self._candidate_key,
        )

    def discard(self) -> None:
        validated_pdf = self._validated_pdf
        if validated_pdf is None:
            return
        self._validated_pdf = None
        try:
            validated_pdf.close()
        except Exception:
            raise AcquisitionFailure(_cleanup_failure()) from None

    def __repr__(self) -> str:
        return "<prepared primary PDF>"


class PrimaryPdfPublisher:
    """Validate automatic candidates now and perform file-first publication later."""

    __slots__ = (
        "_validated_publisher",
        "_staging",
        "_max_pdf_bytes",
        "_cancel_event",
    )

    def __init__(
        self,
        validated_publisher: ValidatedPrimaryPdfPublisher,
        *,
        staging: PdfValidationStagingPort,
        max_pdf_bytes: int = DEFAULT_MAX_PDF_BYTES,
        cancel_event: CancellationEvent | None = None,
    ) -> None:
        if not isinstance(validated_publisher, ValidatedPrimaryPdfPublisher):
            raise TypeError("validated_publisher must be a ValidatedPrimaryPdfPublisher")
        if not isinstance(staging, PdfValidationStagingPort):
            raise TypeError("staging must implement PdfValidationStagingPort")
        if type(max_pdf_bytes) is not int or max_pdf_bytes <= 0:
            raise ValueError("max_pdf_bytes must be a positive integer")
        self._validated_publisher = validated_publisher
        self._staging = staging
        self._max_pdf_bytes = max_pdf_bytes
        self._cancel_event = cancel_event

    def prepare_primary_pdf(
        self,
        request: AcquisitionRequest,
        temporary_pdf: TemporaryPdf,
        *,
        cancel_event: CancellationEvent | None = None,
    ) -> acquisition_ports.PrimaryPdfPreparation | None:
        if not isinstance(request, AcquisitionRequest):
            raise TypeError("request must be an AcquisitionRequest")
        if not isinstance(temporary_pdf, TemporaryPdf):
            raise TypeError("temporary_pdf must be a TemporaryPdf")

        return self._prepare(request, temporary_pdf, cancel_event=cancel_event)

    def commit_primary_pdf(
        self,
        prepared: acquisition_ports.PrimaryPdfPreparation,
    ) -> AcquiredPrimaryPdf:
        if not isinstance(prepared, _PreparedPrimaryPdf):
            raise AcquisitionFailure(_contract_failure())
        expected_facts, validated, provenance, source_url, candidate_key = prepared.consume(self)
        published = self._validated_publisher.publish_validated_primary_pdf(
            expected_facts=expected_facts,
            validated_pdf=validated,
            provenance=provenance,
            source_url=source_url,
        )
        try:
            return AcquiredPrimaryPdf(
                asset=published.asset,
                relation=published.relation,
                candidate_key=candidate_key,
            )
        except Exception:
            raise AcquisitionFailure(_contract_failure()) from None

    def _prepare(
        self,
        request: AcquisitionRequest,
        temporary_pdf: TemporaryPdf,
        *,
        cancel_event: CancellationEvent | None,
    ) -> _PreparedPrimaryPdf | None:
        if (
            request.expected_facts.literature_id != request.literature.literature_id
            or request.expected_facts.meta_literature_id != request.literature.meta_literature_id
            or temporary_pdf.provenance.source_kind is not SourceKind.ASSET_PROVIDER
            or temporary_pdf.provenance.source_name != temporary_pdf.candidate.source_name
        ):
            raise AcquisitionFailure(_contract_failure())

        try:
            # ``open`` is intentionally invoked exactly once.  A2 copies this
            # one view to its private stage; publication never returns to it.
            source_context = temporary_pdf.content.open()
            with source_context as source:
                validated = self._validate_candidate(
                    source,
                    request,
                    temporary_pdf,
                    cancel_event=(cancel_event if cancel_event is not None else self._cancel_event),
                )
        except AcquisitionFailure:
            raise
        except Exception:
            raise AcquisitionFailure(_validation_failure()) from None
        if validated is None:
            return None
        return _PreparedPrimaryPdf(
            issuer=self,
            expected_facts=request.expected_facts,
            validated_pdf=validated,
            provenance=temporary_pdf.provenance,
            source_url=temporary_pdf.safe_source_url,
            candidate_key=temporary_pdf.candidate.candidate_key,
        )

    def _validate_candidate(
        self,
        source: object,
        request: AcquisitionRequest,
        temporary_pdf: TemporaryPdf,
        *,
        cancel_event: CancellationEvent | None,
    ) -> ValidatedPdf | None:
        """Interpret rejection only when it comes from the A2 validator call."""

        try:
            validated = validate_pdf(
                source,
                staging=self._staging,
                max_bytes=self._max_pdf_bytes,
                declared_media_type=temporary_pdf.candidate.declared_media_type,
                cancel_event=cancel_event,
            )
            if temporary_pdf.candidate.acquisition_path is not AcquisitionPath.CONTROLLED_BROWSER:
                return validated
            association = temporary_pdf.browser_association
            if association is None or not browser_pdf_belongs_to_literature(
                request,
                association,
                validated,
                cancel_event=cancel_event,
            ):
                validated.close()
                return None
            return validated
        except PdfValidationError as error:
            if error.is_candidate_rejection:
                return None
            raise AcquisitionFailure(_validation_failure()) from None
        except PdfValidationCancelled:
            raise AcquisitionFailure(_interruption_failure()) from None
        except PdfValidationStagingError:
            raise AcquisitionFailure(_validation_failure()) from None


def _failure(
    *,
    code: str,
    reason: str,
    action: str,
    retryable: bool,
) -> StableFailure:
    return StableFailure(
        code=code,
        reason=reason,
        action=action,
        retryable=retryable,
    )


def _validation_failure() -> StableFailure:
    return _failure(
        code="acquisition-pdf-validation-failed",
        reason="PDF validation did not complete as a normal candidate rejection.",
        action="Check the source or local staging boundary and retry.",
        retryable=True,
    )


def _publication_failure() -> StableFailure:
    return _failure(
        code="acquisition-publication-failed",
        reason="The validated primary PDF could not be committed safely.",
        action="Check storage and retry with refreshed Literature facts.",
        retryable=True,
    )


def _interruption_failure() -> StableFailure:
    return _failure(
        code="acquisition-interrupted",
        reason="Automatic PDF acquisition was interrupted before commit.",
        action="Retry the operation when ready.",
        retryable=True,
    )


def _cleanup_failure() -> StableFailure:
    return _failure(
        code="acquisition-temporary-cleanup-failed",
        reason="Temporary PDF cleanup did not complete.",
        action="Check local temporary storage before retrying.",
        retryable=True,
    )


def _contract_failure() -> StableFailure:
    return _failure(
        code="acquisition-publication-contract",
        reason="A primary PDF publication component violated its neutral contract.",
        action="Correct the publication component assembly.",
        retryable=False,
    )


__all__ = (
    "ArtifactIdFactory",
    "AssetIdFactory",
    "LiteratureAssetIdFactory",
    "PrimaryPdfPublisher",
    "ValidatedPrimaryPdfPublisher",
)
