"""Public neutral API for one concrete Literature's automatic PDF acquisition."""

from __future__ import annotations

from sciretriever.acquisition.manual import ManualPdfInputError
from sciretriever.acquisition.ports import (
    AcquisitionExpectedFacts,
    AcquisitionFailure,
    AcquisitionRequest,
    CancellationEvent,
)
from sciretriever.acquisition.rules import (
    PdfValidationCancelled,
    ReadablePdfSource,
)
from sciretriever.acquisition.service import AcquisitionService
from sciretriever.model.acquisition import AcquisitionResult


class PreparedAcquisition:
    """Nominal opaque receipt for one service-bound pending Acquisition commit."""

    __slots__ = ("__weakref__",)

    def __repr__(self) -> str:
        return "<PreparedAcquisition opaque>"

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("PreparedAcquisition cannot be serialized")

    def __copy__(self) -> object:
        raise TypeError("PreparedAcquisition cannot be copied")

    def __deepcopy__(self, memo: object) -> object:
        del memo
        raise TypeError("PreparedAcquisition cannot be copied")


class AcquisitionApi:
    """Thin boundary over an injected :class:`AcquisitionService`."""

    def __init__(self, service: AcquisitionService) -> None:
        if not isinstance(service, AcquisitionService):
            raise TypeError("service must be an AcquisitionService")
        self._service = service

    def prepare_primary_pdf(
        self,
        request: AcquisitionRequest,
        *,
        cancel_event: CancellationEvent | None = None,
    ) -> PreparedAcquisition:
        """Validate Sources without performing either persistent commit."""

        return self._service.prepare_primary_pdf(request, cancel_event=cancel_event)

    def commit_primary_pdf(self, prepared: PreparedAcquisition) -> AcquisitionResult:
        """Consume exactly one receipt in the caller's serialized commit boundary."""

        return self._service.commit_primary_pdf(prepared)

    def discard_prepared(self, prepared: PreparedAcquisition) -> None:
        """Idempotently release an uncommitted receipt's private staged bytes."""

        self._service.discard_prepared(prepared)

    def clear_exhaustion_for_explicit_retry(
        self,
        expected_facts: AcquisitionExpectedFacts,
    ) -> None:
        """Clear stale exhaustion before Entry explicitly starts a separate retry."""

        self._service.clear_exhaustion_for_explicit_retry(expected_facts)


__all__ = (
    "AcquisitionApi",
    "AcquisitionExpectedFacts",
    "AcquisitionFailure",
    "AcquisitionRequest",
    "CancellationEvent",
    "ManualPdfInputError",
    "PdfValidationCancelled",
    "PreparedAcquisition",
    "ReadablePdfSource",
)
