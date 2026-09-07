"""Independent, path-free admission of one caller-owned manual PDF input.

Entry resolves a concrete Literature and owns the input reader lifetime.  This
module performs the initial no-primary preflight, delegates the only user-byte
copy and PDF checks to :mod:`sciretriever.acquisition.rules`, then hands the
validated private stage to Acquisition's candidate-neutral publisher.  It
never receives or records the user's filesystem path.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Protocol, runtime_checkable

from sciretriever.acquisition.ports import (
    AcquisitionExpectedFacts,
    AcquisitionFailure,
    PdfValidationStagingPort,
    PrimaryPdfPublicationResult,
)
from sciretriever.acquisition.rules import (
    DEFAULT_MAX_PDF_BYTES,
    CancellationEvent,
    PdfValidationCancelled,
    PdfValidationCode,
    PdfValidationError,
    PdfValidationStagingError,
    ReadablePdfSource,
    ValidatedPdf,
    validate_pdf,
)
from sciretriever.model.acquisition import (
    AcceptedManualPdf,
    AssetRole,
    LiteratureAsset,
)
from sciretriever.model.primitives import ProvenanceId, SourceKind, UtcTimestamp
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure


@runtime_checkable
class _ValidatedPrimaryPdfPublicationPort(Protocol):
    """The candidate-neutral portion of A3 consumed by manual admission."""

    def publish_validated_primary_pdf(
        self,
        *,
        expected_facts: AcquisitionExpectedFacts,
        validated_pdf: ValidatedPdf,
        provenance: Provenance,
        source_url: str | None,
    ) -> PrimaryPdfPublicationResult: ...


class ManualPdfInputError(ValueError):
    """A stable normal rejection of the selected Literature or supplied bytes."""

    __slots__ = ("failure",)

    _MESSAGE = "manual PDF input rejected"

    def __init__(self, failure: StableFailure) -> None:
        if not isinstance(failure, StableFailure):
            raise TypeError("failure must be a StableFailure")
        super().__init__(self._MESSAGE)
        self.failure = failure


class ManualPdfAdmissionService:
    """Validate and fully publish one manual PDF for one concrete Literature."""

    __slots__ = (
        "_publication_port",
        "_staging",
        "_provenance_id_factory",
        "_clock",
        "_max_pdf_bytes",
    )

    def __init__(
        self,
        *,
        publication_port: _ValidatedPrimaryPdfPublicationPort,
        staging: PdfValidationStagingPort,
        provenance_id_factory: Callable[[], ProvenanceId],
        clock: Callable[[], UtcTimestamp],
        max_pdf_bytes: int = DEFAULT_MAX_PDF_BYTES,
    ) -> None:
        if not isinstance(publication_port, _ValidatedPrimaryPdfPublicationPort):
            raise TypeError("publication_port must implement validated primary PDF publication")
        if not isinstance(staging, PdfValidationStagingPort):
            raise TypeError("staging must implement PdfValidationStagingPort")
        if not callable(provenance_id_factory):
            raise TypeError("provenance_id_factory must be callable")
        if not callable(clock):
            raise TypeError("clock must be callable")
        if type(max_pdf_bytes) is not int:
            raise TypeError("max_pdf_bytes must be an integer")
        if max_pdf_bytes <= 0:
            raise ValueError("max_pdf_bytes must be positive")
        self._publication_port = publication_port
        self._staging = staging
        self._provenance_id_factory = provenance_id_factory
        self._clock = clock
        self._max_pdf_bytes = max_pdf_bytes

    def accept_manual_pdf(
        self,
        *,
        expected_facts: AcquisitionExpectedFacts,
        current_assets: tuple[LiteratureAsset, ...],
        source: ReadablePdfSource,
        cancel_event: CancellationEvent | None = None,
    ) -> AcceptedManualPdf:
        """Accept one reader without inspecting its path or owning its lifetime."""

        self._validate_request(expected_facts, current_assets)
        if any(item.role is AssetRole.PRIMARY_PDF for item in current_assets):
            raise ManualPdfInputError(_existing_primary_failure())

        validated_pdf = self._validate_source(source, cancel_event=cancel_event)
        try:
            with validated_pdf:
                provenance = self._manual_provenance(validated_pdf)
                published = self._publish(
                    expected_facts=expected_facts,
                    validated_pdf=validated_pdf,
                    provenance=provenance,
                )
                return self._accepted_result(
                    expected_facts=expected_facts,
                    validated_pdf=validated_pdf,
                    provenance=provenance,
                    published=published,
                )
        except AcquisitionFailure:
            raise
        except PdfValidationStagingError:
            raise AcquisitionFailure(_staging_failure()) from None
        except PdfValidationError:
            raise AcquisitionFailure(_validation_contract_failure()) from None
        except Exception:
            raise AcquisitionFailure(_contract_failure()) from None
        raise AcquisitionFailure(_contract_failure())

    @staticmethod
    def _validate_request(
        expected_facts: AcquisitionExpectedFacts,
        current_assets: tuple[LiteratureAsset, ...],
    ) -> None:
        if not isinstance(expected_facts, AcquisitionExpectedFacts):
            raise TypeError("expected_facts must be AcquisitionExpectedFacts")
        if not isinstance(current_assets, tuple):
            raise TypeError("current_assets must be a tuple")
        if any(not isinstance(item, LiteratureAsset) for item in current_assets):
            raise TypeError("current_assets must contain LiteratureAsset values")
        if any(item.literature_id != expected_facts.literature_id for item in current_assets):
            raise ValueError("current assets must belong to the requested Literature")

    def _validate_source(
        self,
        source: ReadablePdfSource,
        *,
        cancel_event: CancellationEvent | None,
    ) -> ValidatedPdf:
        try:
            result = validate_pdf(
                source,
                staging=self._staging,
                max_bytes=self._max_pdf_bytes,
                declared_media_type=None,
                cancel_event=cancel_event,
            )
        except PdfValidationCancelled:
            raise
        except PdfValidationError as error:
            if error.is_candidate_rejection or error.code is PdfValidationCode.SOURCE_ERROR:
                raise ManualPdfInputError(_invalid_input_failure()) from None
            raise AcquisitionFailure(_validation_contract_failure()) from None
        except PdfValidationStagingError:
            raise AcquisitionFailure(_staging_failure()) from None
        except Exception:
            raise AcquisitionFailure(_validation_failure()) from None
        if not isinstance(result, ValidatedPdf):
            raise AcquisitionFailure(_validation_contract_failure())
        return result

    def _manual_provenance(self, validated_pdf: ValidatedPdf) -> Provenance:
        try:
            provenance_id = self._provenance_id_factory()
            observed_at = self._clock()
            if not isinstance(provenance_id, ProvenanceId):
                raise TypeError("provenance_id_factory must return ProvenanceId")
            if not isinstance(observed_at, UtcTimestamp):
                raise TypeError("clock must return UtcTimestamp")
            return Provenance(
                provenance_id=provenance_id,
                source_kind=SourceKind.USER,
                source_name="manual-pdf",
                source_record_id=None,
                observed_at=observed_at,
                input_sha256=validated_pdf.sha256,
                parameters_sha256=None,
            )
        except Exception:
            raise AcquisitionFailure(_contract_failure()) from None

    def _publish(
        self,
        *,
        expected_facts: AcquisitionExpectedFacts,
        validated_pdf: ValidatedPdf,
        provenance: Provenance,
    ) -> PrimaryPdfPublicationResult:
        try:
            return self._publication_port.publish_validated_primary_pdf(
                expected_facts=expected_facts,
                validated_pdf=validated_pdf,
                provenance=provenance,
                source_url=None,
            )
        except AcquisitionFailure:
            raise
        except Exception:
            raise AcquisitionFailure(_publication_failure()) from None

    @staticmethod
    def _accepted_result(
        *,
        expected_facts: AcquisitionExpectedFacts,
        validated_pdf: ValidatedPdf,
        provenance: Provenance,
        published: object,
    ) -> AcceptedManualPdf:
        if not isinstance(published, PrimaryPdfPublicationResult):
            raise AcquisitionFailure(_publication_contract_failure())
        asset = published.asset
        relation = published.relation
        if (
            asset.sha256 != validated_pdf.sha256
            or asset.size_bytes != validated_pdf.byte_size
            or asset.media_type != validated_pdf.media_type
            or relation.literature_id != expected_facts.literature_id
            or relation.role is not AssetRole.PRIMARY_PDF
            or relation.asset_id != asset.asset_id
            or relation.provenance != provenance
            or relation.source_url is not None
        ):
            raise AcquisitionFailure(_publication_contract_failure())
        try:
            return AcceptedManualPdf(asset=asset, relation=relation)
        except Exception:
            raise AcquisitionFailure(_publication_contract_failure()) from None


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


def _existing_primary_failure() -> StableFailure:
    return _failure(
        code="manual-pdf-target-has-primary",
        reason="The Literature already has a primary PDF.",
        action="Select a Literature without a primary PDF.",
        retryable=False,
    )


def _invalid_input_failure() -> StableFailure:
    return _failure(
        code="manual-pdf-invalid",
        reason="The supplied input is not a readable supported PDF.",
        action="Provide a readable PDF with at least one accessible page.",
        retryable=False,
    )


def _staging_failure() -> StableFailure:
    return _failure(
        code="manual-pdf-staging-failed",
        reason="The manual PDF could not be copied to private staging.",
        action="Check local temporary storage and retry.",
        retryable=True,
    )


def _validation_failure() -> StableFailure:
    return _failure(
        code="manual-pdf-validation-failed",
        reason="Manual PDF validation could not complete safely.",
        action="Check local resources and retry.",
        retryable=True,
    )


def _validation_contract_failure() -> StableFailure:
    return _failure(
        code="manual-pdf-validation-contract",
        reason="The manual PDF validator violated its input contract.",
        action="Correct the Acquisition component assembly.",
        retryable=False,
    )


def _publication_failure() -> StableFailure:
    return _failure(
        code="manual-pdf-publication-failed",
        reason="The validated manual PDF could not be committed safely.",
        action="Check storage and retry with refreshed Literature facts.",
        retryable=True,
    )


def _publication_contract_failure() -> StableFailure:
    return _failure(
        code="manual-pdf-publication-contract",
        reason="The primary PDF publisher returned inconsistent committed facts.",
        action="Correct the Acquisition publication component assembly.",
        retryable=False,
    )


def _contract_failure() -> StableFailure:
    return _failure(
        code="manual-pdf-contract",
        reason="A manual PDF admission component violated its contract.",
        action="Correct the manual PDF component assembly.",
        retryable=False,
    )


__all__ = (
    "ManualPdfAdmissionService",
    "ManualPdfInputError",
)
