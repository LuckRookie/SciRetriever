"""Planner-driven automatic PDF acquisition over one bounded cohort."""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from threading import Lock
from typing import TYPE_CHECKING, Literal
from weakref import WeakKeyDictionary

from sciretriever.acquisition.cohort import (
    AcquisitionWorkItem,
    TieredCohortExecutor,
    WorkItemDisposition,
)
from sciretriever.acquisition.outcomes import RouteExecutionResult, RouteOutcome
from sciretriever.acquisition.planning import (
    AccessRouteHint,
    AcquisitionPlan,
    DoiResolutionState,
    ProgressiveAcquisitionPlanner,
    RouteSpec,
)
from sciretriever.acquisition.ports import (
    AcquisitionExhaustionClearPort,
    AcquisitionExhaustionPublicationCommand,
    AcquisitionExhaustionPublicationPort,
    AcquisitionExpectedFacts,
    AcquisitionFailure,
    AcquisitionRequest,
    AcquisitionSourceFailure,
    CancellationEvent,
    PrimaryPdfPreparation,
    PrimaryPdfPreparationPort,
    TemporaryPdf,
)
from sciretriever.acquisition.routes import (
    AcquisitionRouteRegistry,
    RouteExecutionContext,
)
from sciretriever.acquisition.routing import build_acquisition_evidence
from sciretriever.logging.api import get_logger
from sciretriever.model.acquisition import (
    AcquiredPrimaryPdf,
    AcquisitionResult,
    AssetRole,
    AutomaticPdfAcquisitionExhaustion,
    NoPrimaryPdf,
)
from sciretriever.model.primitives import LiteratureId
from sciretriever.model.report import StableFailure

_LOGGER = get_logger(__name__)

if TYPE_CHECKING:
    from sciretriever.acquisition.api import PreparedAcquisition


@dataclass(slots=True)
class _CandidatePreparation:
    prepared_pdf: PrimaryPdfPreparation
    candidate_key: str
    literature_id: LiteratureId


@dataclass(slots=True)
class _ExhaustionPreparation:
    command: AcquisitionExhaustionPublicationCommand
    literature_id: LiteratureId


@dataclass(slots=True)
class _ReceiptState:
    status: Literal["pending", "committed", "discarded"]
    payload: _CandidatePreparation | _ExhaustionPreparation | None


@dataclass(frozen=True, slots=True)
class CohortPreparationItem:
    """One work item's receipt or stable non-exhaustion failure."""

    literature_id: LiteratureId
    disposition: WorkItemDisposition
    prepared: PreparedAcquisition | None = field(default=None, repr=False)
    failure: StableFailure | None = None
    attempted_route_keys: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        from sciretriever.acquisition.api import PreparedAcquisition

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

    def __post_init__(self) -> None:
        if not isinstance(self.items, tuple) or any(
            not isinstance(item, CohortPreparationItem) for item in self.items
        ):
            raise TypeError("items must contain CohortPreparationItem values")
        identities = tuple(item.literature_id for item in self.items)
        if len(identities) != len(set(identities)):
            raise ValueError("cohort Literature identities must be unique")

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("PreparedAcquisitionCohort cannot be serialized")


class TieredAcquisitionService:
    """Execute selected routes by tier and preserve the existing commit boundary."""

    def __init__(
        self,
        *,
        route_registry: AcquisitionRouteRegistry,
        planner: ProgressiveAcquisitionPlanner,
        publication_port: PrimaryPdfPreparationPort,
        exhaustion_port: AcquisitionExhaustionPublicationPort,
        exhaustion_clear_port: AcquisitionExhaustionClearPort,
        cohort_executor: TieredCohortExecutor | None = None,
    ) -> None:
        if not isinstance(route_registry, AcquisitionRouteRegistry):
            raise TypeError("route_registry must be AcquisitionRouteRegistry")
        if not isinstance(planner, ProgressiveAcquisitionPlanner):
            raise TypeError("planner must be ProgressiveAcquisitionPlanner")
        if not isinstance(publication_port, PrimaryPdfPreparationPort):
            raise TypeError("publication_port must implement PrimaryPdfPreparationPort")
        if not isinstance(exhaustion_port, AcquisitionExhaustionPublicationPort):
            raise TypeError("exhaustion_port must implement AcquisitionExhaustionPublicationPort")
        if not isinstance(exhaustion_clear_port, AcquisitionExhaustionClearPort):
            raise TypeError("exhaustion_clear_port must implement AcquisitionExhaustionClearPort")
        if cohort_executor is not None and not isinstance(cohort_executor, TieredCohortExecutor):
            raise TypeError("cohort_executor must be TieredCohortExecutor or None")
        self._route_registry = route_registry
        self._planner = planner
        self._publication_port = publication_port
        self._exhaustion_port = exhaustion_port
        self._exhaustion_clear_port = exhaustion_clear_port
        self._cohort_executor = cohort_executor or TieredCohortExecutor()
        self._receipt_lock = Lock()
        self._receipts: WeakKeyDictionary[PreparedAcquisition, _ReceiptState] = WeakKeyDictionary()

    def clear_exhaustion_for_explicit_retry(
        self,
        expected_facts: AcquisitionExpectedFacts,
    ) -> None:
        if not isinstance(expected_facts, AcquisitionExpectedFacts):
            raise TypeError("expected_facts must be AcquisitionExpectedFacts")
        try:
            self._exhaustion_clear_port.clear_exhaustion(expected_facts)
        except AcquisitionFailure:
            raise
        except Exception:
            raise AcquisitionFailure(_publication_failure()) from None

    def prepare_primary_pdf(
        self,
        request: AcquisitionRequest,
        *,
        cancel_event: CancellationEvent | None = None,
    ) -> PreparedAcquisition:
        if not isinstance(request, AcquisitionRequest):
            raise TypeError("request must be AcquisitionRequest")
        prepared = self.prepare_primary_pdf_cohort((request,), cancel_event=cancel_event)
        item = prepared.items[0]
        if item.prepared is None:
            if item.failure is None:
                raise AcquisitionFailure(_contract_failure())
            raise AcquisitionFailure(item.failure)
        return item.prepared

    def prepare_primary_pdf_cohort(
        self,
        requests: tuple[AcquisitionRequest, ...],
        *,
        cancel_event: CancellationEvent | None = None,
    ) -> PreparedAcquisitionCohort:
        self._validate_requests(requests)
        self._check_cancel(cancel_event)
        work_items = tuple(self._new_work_item(request) for request in requests)
        try:
            result = self._cohort_executor.execute(
                work_items,
                lambda item, route: self._execute_route(
                    item,
                    route,
                    cancel_event=cancel_event,
                ),
                refresh_plan=lambda item: self._refresh_plan(
                    item,
                    cancel_event=cancel_event,
                ),
            )
            prepared_items = tuple(
                self._prepare_cohort_item(item, frozen)
                for item, frozen in zip(work_items, result.items, strict=True)
            )
            return PreparedAcquisitionCohort(prepared_items)
        except BaseException:
            self._discard_work_preparations(work_items)
            raise

    def _validate_requests(self, requests: tuple[AcquisitionRequest, ...]) -> None:
        if not isinstance(requests, tuple) or any(
            not isinstance(request, AcquisitionRequest) for request in requests
        ):
            raise TypeError("requests must contain AcquisitionRequest values")
        identities = tuple(request.literature.literature_id for request in requests)
        if len(identities) != len(set(identities)):
            raise ValueError("cohort requests must identify unique Literature values")
        for request in requests:
            if any(asset.role is AssetRole.PRIMARY_PDF for asset in request.current_assets):
                raise AcquisitionFailure(
                    StableFailure(
                        code="acquisition-target-has-primary-pdf",
                        reason="The Literature already has a primary PDF.",
                        action="Refresh the Literature before requesting acquisition.",
                        retryable=False,
                    )
                )

    def _new_work_item(self, request: AcquisitionRequest) -> AcquisitionWorkItem:
        session = self._planner.start(request)
        return AcquisitionWorkItem(
            work_key=str(request.literature.literature_id),
            plan=session.plan,
            request=session.request,
            planning_session=session,
        )

    def _execute_route(
        self,
        item: AcquisitionWorkItem,
        route: RouteSpec,
        *,
        cancel_event: CancellationEvent | None,
    ) -> RouteExecutionResult:
        self._check_cancel(cancel_event)
        binding = self._route_registry.binding_for(route.route_key)
        adapter = binding.adapter
        if binding.spec != route or adapter is None:
            return RouteExecutionResult.failed(_contract_failure())
        request = item.request
        if request is None:
            return RouteExecutionResult.failed(_contract_failure())
        context = RouteExecutionContext(
            request=request,
            evidence=build_acquisition_evidence(request),
            route_hints=tuple(item.route_hints),
            candidate_keys=item.candidate_keys,
            cancel_event=cancel_event,
        )
        try:
            return self._consume_route_results(
                item,
                route,
                adapter.execute(context),
                source_name=adapter.source_name,
                cancel_event=cancel_event,
            )
        except AcquisitionSourceFailure as error:
            return _source_failure_outcome(error.failure)
        except AcquisitionFailure as error:
            return RouteExecutionResult.failed(error.failure)
        except Exception:
            return RouteExecutionResult.failed(_source_contract_failure())

    def _consume_route_results(
        self,
        item: AcquisitionWorkItem,
        route: RouteSpec,
        results: Iterable[RouteExecutionResult],
        *,
        source_name: str,
        cancel_event: CancellationEvent | None,
    ) -> RouteExecutionResult:
        iterator = iter(results)
        hints = []
        receipt_before_execution = item.publication_receipt
        try:
            for result in iterator:
                if not isinstance(result, RouteExecutionResult):
                    raise AcquisitionFailure(_contract_failure())
                for hint in result.hints:
                    if hint not in hints:
                        hints.append(hint)
                terminal = self._consume_one_route_result(
                    item,
                    route,
                    result,
                    hints=hints,
                    source_name=source_name,
                    cancel_event=cancel_event,
                )
                if terminal is not None:
                    return terminal
        finally:
            try:
                _close_iterator(iterator)
            except BaseException:
                if item.publication_receipt is not receipt_before_execution:
                    self._discard_item_preparation(item)
                raise
        return (
            RouteExecutionResult.hints_only(*hints) if hints else RouteExecutionResult.normal_miss()
        )

    def _consume_one_route_result(
        self,
        item: AcquisitionWorkItem,
        route: RouteSpec,
        result: RouteExecutionResult,
        *,
        hints: list[AccessRouteHint],
        source_name: str,
        cancel_event: CancellationEvent | None,
    ) -> RouteExecutionResult | None:
        if result.outcome in {RouteOutcome.NORMAL_MISS, RouteOutcome.HINTS}:
            return None
        if result.outcome is not RouteOutcome.PDF_DELIVERED:
            _remember_safe_hints(item, hints)
            return result
        temporary_pdf = result.temporary_pdf
        if temporary_pdf is None:
            raise AcquisitionFailure(_contract_failure())
        prepared = self._prepare_candidate(
            item,
            route,
            temporary_pdf,
            source_name=source_name,
            cancel_event=cancel_event,
        )
        if prepared is None:
            return None
        item.publication_receipt = prepared
        return result

    def _prepare_candidate(
        self,
        item: AcquisitionWorkItem,
        route: RouteSpec,
        temporary_pdf: TemporaryPdf,
        *,
        source_name: str,
        cancel_event: CancellationEvent | None,
    ) -> _CandidatePreparation | None:
        request = self._validate_candidate(item, route, temporary_pdf, source_name)
        if request is None:
            return None
        self._check_cancel(cancel_event)
        prepared = self._prepare_pdf_bytes(
            request,
            temporary_pdf,
            cancel_event=cancel_event,
        )
        if prepared is None:
            self._check_cancel(cancel_event)
            return None
        try:
            self._check_cancel(cancel_event)
        except BaseException:
            _best_effort_discard(prepared)
            raise
        return _CandidatePreparation(
            prepared_pdf=prepared,
            candidate_key=temporary_pdf.candidate.candidate_key,
            literature_id=request.literature.literature_id,
        )

    def _validate_candidate(
        self,
        item: AcquisitionWorkItem,
        route: RouteSpec,
        temporary_pdf: TemporaryPdf,
        source_name: str,
    ) -> AcquisitionRequest | None:
        request = item.request
        candidate = temporary_pdf.candidate
        if request is None or (
            candidate.source_name != source_name or candidate.acquisition_path is not route.tier
        ):
            _discard_temporary(temporary_pdf)
            raise AcquisitionFailure(_contract_failure())
        if candidate.candidate_key in item.delivered_candidate_keys:
            _discard_temporary(temporary_pdf)
            return None
        if not item.candidate_keys.contains(candidate.candidate_key):
            _discard_temporary(temporary_pdf)
            raise AcquisitionFailure(_candidate_not_claimed_failure())
        item.delivered_candidate_keys.add(candidate.candidate_key)
        return request

    def _prepare_pdf_bytes(
        self,
        request: AcquisitionRequest,
        temporary_pdf: TemporaryPdf,
        *,
        cancel_event: CancellationEvent | None,
    ) -> PrimaryPdfPreparation | None:
        prepared: PrimaryPdfPreparation | None = None
        try:
            prepared = self._publication_port.prepare_primary_pdf(
                request,
                temporary_pdf,
                cancel_event=cancel_event,
            )
        except AcquisitionFailure:
            raise
        except Exception:
            raise AcquisitionFailure(_publication_failure()) from None
        finally:
            try:
                _discard_temporary(temporary_pdf)
            except BaseException:
                if prepared is not None:
                    _best_effort_discard(prepared)
                raise
        if prepared is not None and not isinstance(prepared, PrimaryPdfPreparation):
            raise AcquisitionFailure(_contract_failure())
        return prepared

    def _refresh_plan(
        self,
        item: AcquisitionWorkItem,
        *,
        cancel_event: CancellationEvent | None,
    ) -> AcquisitionPlan:
        session = item.planning_session
        if session is None:
            item.disposition = WorkItemDisposition.FAILED
            item.failure = _contract_failure()
            return item.plan
        try:
            self._check_cancel(cancel_event)
            if (
                item.current_tier is not None
                and item.current_tier.value == "public"
                and session.doi_resolution_state is DoiResolutionState.ELIGIBLE
            ):
                session = self._planner.resolve_doi_landing(session)
            new_hints = tuple(hint for hint in item.route_hints if hint not in session.route_hints)
            if new_hints:
                session = self._planner.refresh_with_hints(session, new_hints)
        except AcquisitionSourceFailure as error:
            outcome = _source_failure_outcome(error.failure)
            _apply_planning_failure(item, outcome)
            return item.plan
        except AcquisitionFailure as error:
            item.disposition = WorkItemDisposition.FAILED
            item.failure = error.failure
            return item.plan
        except Exception:
            item.disposition = WorkItemDisposition.FAILED
            item.failure = _source_contract_failure()
            return item.plan
        item.planning_session = session
        item.request = session.request
        item.plan = session.plan
        return session.plan

    def _prepare_cohort_item(
        self,
        item: AcquisitionWorkItem,
        frozen: object,
    ) -> CohortPreparationItem:
        from sciretriever.acquisition.cohort import AcquisitionWorkItemResult

        if not isinstance(frozen, AcquisitionWorkItemResult):
            raise AcquisitionFailure(_contract_failure())
        request = item.request
        if request is None:
            raise AcquisitionFailure(_contract_failure())
        if frozen.disposition is WorkItemDisposition.DELIVERED:
            payload = item.publication_receipt
            if not isinstance(payload, _CandidatePreparation):
                raise AcquisitionFailure(_contract_failure())
            receipt = self._issue_receipt(payload)
        elif frozen.disposition is WorkItemDisposition.EXHAUSTED:
            receipt = self._issue_receipt(
                _ExhaustionPreparation(
                    command=AcquisitionExhaustionPublicationCommand(
                        expected_facts=request.expected_facts,
                        observation_ids=request.observation_closure,
                    ),
                    literature_id=request.literature.literature_id,
                )
            )
        else:
            receipt = None
        return CohortPreparationItem(
            literature_id=request.literature.literature_id,
            disposition=frozen.disposition,
            prepared=receipt,
            failure=frozen.failure,
            attempted_route_keys=frozen.attempted_route_keys,
        )

    def commit_primary_pdf(self, prepared: PreparedAcquisition) -> AcquisitionResult:
        payload = self._consume_receipt(prepared)
        if isinstance(payload, _CandidatePreparation):
            return self._commit_candidate(payload)
        return self._commit_exhaustion(payload)

    def _commit_candidate(self, payload: _CandidatePreparation) -> AcquiredPrimaryPdf:
        try:
            result = self._publication_port.commit_primary_pdf(payload.prepared_pdf)
        except AcquisitionFailure:
            raise
        except Exception:
            raise AcquisitionFailure(_publication_failure()) from None
        finally:
            try:
                payload.prepared_pdf.discard()
            except AcquisitionFailure:
                raise
            except Exception:
                raise AcquisitionFailure(_cleanup_failure()) from None
        if (
            not isinstance(result, AcquiredPrimaryPdf)
            or result.candidate_key != payload.candidate_key
            or result.relation.literature_id != payload.literature_id
        ):
            raise AcquisitionFailure(_contract_failure())
        return result

    def _commit_exhaustion(self, payload: _ExhaustionPreparation) -> NoPrimaryPdf:
        try:
            exhaustion = self._exhaustion_port.publish_exhaustion(payload.command)
        except AcquisitionFailure:
            raise
        except Exception:
            raise AcquisitionFailure(_publication_failure()) from None
        if (
            not isinstance(exhaustion, AutomaticPdfAcquisitionExhaustion)
            or exhaustion.literature_id != payload.literature_id
        ):
            raise AcquisitionFailure(_contract_failure())
        return NoPrimaryPdf()

    def discard_prepared(self, prepared: PreparedAcquisition) -> None:
        from sciretriever.acquisition.api import PreparedAcquisition

        if not isinstance(prepared, PreparedAcquisition):
            raise AcquisitionFailure(_contract_failure())
        with self._receipt_lock:
            state = self._receipts.get(prepared)
            if state is None:
                raise AcquisitionFailure(_contract_failure())
            if state.status != "pending":
                return
            state.status = "discarded"
            payload = state.payload
            state.payload = None
        if isinstance(payload, _CandidatePreparation):
            try:
                payload.prepared_pdf.discard()
            except AcquisitionFailure:
                raise
            except Exception:
                raise AcquisitionFailure(_cleanup_failure()) from None

    def _issue_receipt(
        self,
        payload: _CandidatePreparation | _ExhaustionPreparation,
    ) -> PreparedAcquisition:
        from sciretriever.acquisition.api import PreparedAcquisition

        receipt = PreparedAcquisition()
        with self._receipt_lock:
            self._receipts[receipt] = _ReceiptState(status="pending", payload=payload)
        return receipt

    def _consume_receipt(
        self,
        prepared: PreparedAcquisition,
    ) -> _CandidatePreparation | _ExhaustionPreparation:
        from sciretriever.acquisition.api import PreparedAcquisition

        if not isinstance(prepared, PreparedAcquisition):
            raise AcquisitionFailure(_contract_failure())
        with self._receipt_lock:
            state = self._receipts.get(prepared)
            if state is None or state.status != "pending" or state.payload is None:
                raise AcquisitionFailure(_contract_failure())
            state.status = "committed"
            payload = state.payload
            state.payload = None
        return payload

    def _discard_work_preparations(self, items: tuple[AcquisitionWorkItem, ...]) -> None:
        for item in items:
            try:
                self._discard_item_preparation(item)
            except AcquisitionFailure:
                # Another failure is already escaping the cohort boundary.
                # Cleanup remains best effort here, just as it was for the
                # former direct discard loop.
                pass

    @staticmethod
    def _discard_item_preparation(item: AcquisitionWorkItem) -> None:
        payload = item.publication_receipt
        item.publication_receipt = None
        if not isinstance(payload, _CandidatePreparation):
            return
        try:
            payload.prepared_pdf.discard()
        except AcquisitionFailure:
            raise
        except Exception:
            raise AcquisitionFailure(_cleanup_failure()) from None

    @staticmethod
    def _check_cancel(cancel_event: CancellationEvent | None) -> None:
        if cancel_event is None:
            return
        try:
            cancelled = cancel_event.is_set()
        except Exception:
            raise AcquisitionFailure(_interruption_failure()) from None
        if type(cancelled) is not bool or cancelled:
            raise AcquisitionFailure(_interruption_failure())


def _close_iterator(iterator: Iterator[RouteExecutionResult]) -> None:
    close = getattr(iterator, "close", None)
    if close is None:
        return
    if not callable(close):
        raise AcquisitionFailure(_cleanup_failure())
    try:
        close()
    except AcquisitionFailure:
        raise
    except Exception:
        raise AcquisitionFailure(_cleanup_failure()) from None


def _discard_temporary(temporary_pdf: TemporaryPdf) -> None:
    try:
        temporary_pdf.content.discard()
    except AcquisitionFailure:
        raise
    except Exception:
        raise AcquisitionFailure(_cleanup_failure()) from None


def _best_effort_discard(prepared: PrimaryPdfPreparation) -> None:
    try:
        prepared.discard()
    except Exception:
        pass


def _remember_safe_hints(
    item: AcquisitionWorkItem,
    hints: list[AccessRouteHint],
) -> None:
    for hint in hints:
        if hint not in item.route_hints:
            item.route_hints.append(hint)


def _source_failure_outcome(failure: StableFailure) -> RouteExecutionResult:
    if failure.code == "acquisition-authorized-entitlement":
        return RouteExecutionResult.normal_miss()
    if any(marker in failure.code for marker in ("credential", "authentication", "login", "mfa")):
        return RouteExecutionResult.action_required(failure)
    if failure.retryable and not any(
        marker in failure.code for marker in ("cleanup", "contract", "publication", "storage")
    ):
        return RouteExecutionResult.deferred(failure)
    return RouteExecutionResult.failed(failure)


def _apply_planning_failure(
    item: AcquisitionWorkItem,
    result: RouteExecutionResult,
) -> None:
    item.failure = result.failure
    item.disposition = {
        RouteOutcome.DEFERRED: WorkItemDisposition.DEFERRED,
        RouteOutcome.ACTION_REQUIRED: WorkItemDisposition.ACTION_REQUIRED,
        RouteOutcome.FAILURE: WorkItemDisposition.FAILED,
        RouteOutcome.NORMAL_MISS: WorkItemDisposition.PENDING,
    }.get(result.outcome, WorkItemDisposition.FAILED)


def _failure(code: str, reason: str, action: str, *, retryable: bool) -> StableFailure:
    return StableFailure(code=code, reason=reason, action=action, retryable=retryable)


def _contract_failure() -> StableFailure:
    return _failure(
        "acquisition-port-contract",
        "An acquisition component violated its neutral Port contract.",
        "Correct the acquisition component assembly.",
        retryable=False,
    )


def _source_contract_failure() -> StableFailure:
    return _failure(
        "acquisition-route-contract",
        "An acquisition route violated its runtime contract.",
        "Correct the route adapter before retrying.",
        retryable=False,
    )


def _candidate_not_claimed_failure() -> StableFailure:
    return _failure(
        "acquisition-candidate-not-claimed",
        "An acquisition route did not claim its candidate before access.",
        "Correct the route adapter before retrying.",
        retryable=False,
    )


def _publication_failure() -> StableFailure:
    return _failure(
        "acquisition-publication-failed",
        "The acquisition result could not be published atomically.",
        "Check the catalog and artifact store before retrying.",
        retryable=True,
    )


def _cleanup_failure() -> StableFailure:
    return _failure(
        "acquisition-temporary-cleanup-failed",
        "Temporary acquisition resources could not be cleaned up.",
        "Check local temporary storage before retrying.",
        retryable=True,
    )


def _interruption_failure() -> StableFailure:
    return _failure(
        "acquisition-interrupted",
        "Automatic PDF acquisition was interrupted before commit.",
        "Retry the operation when ready.",
        retryable=True,
    )


__all__ = (
    "CohortPreparationItem",
    "PreparedAcquisitionCohort",
    "TieredAcquisitionService",
)
