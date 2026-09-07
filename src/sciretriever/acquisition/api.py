"""Public neutral API for one concrete Literature's automatic PDF acquisition."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Final, Protocol, TypeAlias, runtime_checkable

from sciretriever.acquisition.authorized import (
    PRODUCTION_AUTHORIZED_PROVIDER_CATALOG,
    UNSUPPORTED_AUTHORIZED_API_PROVIDER_KEYS,
)
from sciretriever.acquisition.browser_admission import BrowserEscalationSummary
from sciretriever.acquisition.cohort import (
    AcquisitionGroupProgress,
    AcquisitionProgressObserver,
    AcquisitionProgressPhase,
    AcquisitionProgressSnapshot,
    BrowserEscalationObserver,
    WorkItemDisposition,
)
from sciretriever.acquisition.manual import ManualPdfInputError
from sciretriever.acquisition.planning import RouteReadiness
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
from sciretriever.acquisition.sources import (
    BUILTIN_SCI_HUB_MIRROR_URLS,
    CONTROLLED_BROWSER_PRODUCTION_STATUS,
)
from sciretriever.model.acquisition import AcquisitionResult
from sciretriever.model.primitives import LiteratureId
from sciretriever.model.report import StableFailure

AUTHORIZED_PDF_API_PROVIDER_KEYS: Final[frozenset[str]] = frozenset(
    PRODUCTION_AUTHORIZED_PROVIDER_CATALOG
)
UNSUPPORTED_AUTHORIZED_PDF_API_PROVIDER_KEYS: Final[frozenset[str]] = (
    UNSUPPORTED_AUTHORIZED_API_PROVIDER_KEYS
)
CONTROLLED_BROWSER_PRODUCTION_AVAILABLE: Final[bool] = (
    CONTROLLED_BROWSER_PRODUCTION_STATUS.readiness is RouteReadiness.READY
)
CONTROLLED_BROWSER_PRODUCTION_ROUTE_COUNT: Final[int] = 1


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


@dataclass(frozen=True, slots=True)
class CohortPreparationItem:
    """One operation-local preparation receipt or stable non-exhaustion failure."""

    literature_id: LiteratureId
    disposition: WorkItemDisposition
    prepared: PreparedAcquisition | None = field(default=None, repr=False)
    failure: StableFailure | None = None
    attempted_route_keys: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.literature_id, LiteratureId):
            raise TypeError("literature_id must be LiteratureId")
        if not isinstance(self.disposition, WorkItemDisposition):
            raise TypeError("disposition must be WorkItemDisposition")
        if self.prepared is not None and not isinstance(self.prepared, PreparedAcquisition):
            raise TypeError("prepared must be PreparedAcquisition or None")
        if self.failure is not None and not isinstance(self.failure, StableFailure):
            raise TypeError("failure must be StableFailure or None")
        has_receipt = self.disposition in {
            WorkItemDisposition.DELIVERED,
            WorkItemDisposition.EXHAUSTED,
        }
        if has_receipt != (self.prepared is not None):
            raise ValueError("only delivered or exhausted items carry a receipt")
        if (not has_receipt) != (self.failure is not None):
            raise ValueError("every non-receipt item requires a stable failure")


@dataclass(frozen=True, slots=True)
class PreparedAcquisitionCohort:
    """Opaque process-local preparation result in frozen request order."""

    items: tuple[CohortPreparationItem, ...]
    browser_escalation: BrowserEscalationSummary

    def __post_init__(self) -> None:
        if not isinstance(self.items, tuple) or any(
            not isinstance(item, CohortPreparationItem) for item in self.items
        ):
            raise TypeError("items must contain CohortPreparationItem values")
        identities = tuple(item.literature_id for item in self.items)
        if len(identities) != len(set(identities)):
            raise ValueError("cohort Literature identities must be unique")
        if not isinstance(self.browser_escalation, BrowserEscalationSummary):
            raise TypeError("browser_escalation must be BrowserEscalationSummary")

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("PreparedAcquisitionCohort cannot be serialized")

    def __copy__(self) -> object:
        raise TypeError("PreparedAcquisitionCohort cannot be copied")

    def __deepcopy__(self, memo: object) -> object:
        del memo
        raise TypeError("PreparedAcquisitionCohort cannot be copied")


CohortPreparationObserver: TypeAlias = Callable[
    [tuple[CohortPreparationItem, ...]],
    None,
]


@runtime_checkable
class AutomaticAcquisitionService(Protocol):
    """Internal service surface behind the stable Acquisition API."""

    def prepare_primary_pdf(
        self,
        request: AcquisitionRequest,
        *,
        cancel_event: CancellationEvent | None = None,
    ) -> PreparedAcquisition: ...

    def prepare_primary_pdf_cohort(
        self,
        requests: tuple[AcquisitionRequest, ...],
        *,
        cancel_event: CancellationEvent | None = None,
        on_prepared: CohortPreparationObserver | None = None,
        on_progress: AcquisitionProgressObserver | None = None,
        on_browser_escalation: BrowserEscalationObserver | None = None,
    ) -> PreparedAcquisitionCohort: ...

    def commit_primary_pdf(self, prepared: PreparedAcquisition) -> AcquisitionResult: ...

    def discard_prepared(self, prepared: PreparedAcquisition) -> None: ...

    def clear_exhaustion_for_explicit_retry(
        self,
        expected_facts: AcquisitionExpectedFacts,
    ) -> None: ...


class AcquisitionApi:
    """Thin boundary over one injected automatic Acquisition service."""

    def __init__(self, service: AutomaticAcquisitionService) -> None:
        if not isinstance(service, AutomaticAcquisitionService):
            raise TypeError("service must implement AutomaticAcquisitionService")
        self._service = service

    def prepare_primary_pdf(
        self,
        request: AcquisitionRequest,
        *,
        cancel_event: CancellationEvent | None = None,
    ) -> PreparedAcquisition:
        """Validate Sources without performing either persistent commit."""

        return self._service.prepare_primary_pdf(request, cancel_event=cancel_event)

    def prepare_primary_pdf_cohort(
        self,
        requests: tuple[AcquisitionRequest, ...],
        *,
        cancel_event: CancellationEvent | None = None,
        on_prepared: CohortPreparationObserver | None = None,
        on_progress: AcquisitionProgressObserver | None = None,
        on_browser_escalation: BrowserEscalationObserver | None = None,
    ) -> PreparedAcquisitionCohort:
        """Prepare one cohort and optionally publish tier-terminal receipts early."""

        return self._service.prepare_primary_pdf_cohort(
            requests,
            cancel_event=cancel_event,
            on_prepared=on_prepared,
            on_progress=on_progress,
            on_browser_escalation=on_browser_escalation,
        )

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
    "AUTHORIZED_PDF_API_PROVIDER_KEYS",
    "BUILTIN_SCI_HUB_MIRROR_URLS",
    "CONTROLLED_BROWSER_PRODUCTION_AVAILABLE",
    "CONTROLLED_BROWSER_PRODUCTION_ROUTE_COUNT",
    "AcquisitionApi",
    "AcquisitionExpectedFacts",
    "AcquisitionFailure",
    "AcquisitionGroupProgress",
    "AcquisitionProgressObserver",
    "AcquisitionProgressPhase",
    "AcquisitionProgressSnapshot",
    "AcquisitionRequest",
    "BrowserEscalationObserver",
    "BrowserEscalationSummary",
    "CancellationEvent",
    "CohortPreparationObserver",
    "CohortPreparationItem",
    "ManualPdfInputError",
    "PdfValidationCancelled",
    "PreparedAcquisition",
    "PreparedAcquisitionCohort",
    "ReadablePdfSource",
    "UNSUPPORTED_AUTHORIZED_PDF_API_PROVIDER_KEYS",
)
