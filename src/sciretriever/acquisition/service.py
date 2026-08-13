"""Strictly serial orchestration for one Literature's automatic PDF acquisition."""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from threading import Lock
from typing import TYPE_CHECKING, Literal
from weakref import WeakKeyDictionary

from sciretriever.acquisition.ports import (
    AcquisitionExhaustionClearPort,
    AcquisitionExhaustionPublicationCommand,
    AcquisitionExhaustionPublicationPort,
    AcquisitionExpectedFacts,
    AcquisitionFailure,
    CancellationEvent,
    CandidateKeyTracker,
    PdfSource,
    PdfSourceBinding,
    PrimaryPdfPreparation,
    PrimaryPdfPreparationPort,
    TemporaryPdf,
)
from sciretriever.acquisition.routing import (
    AcquisitionEvidence,
    AcquisitionRequest,
    build_acquisition_evidence,
)
from sciretriever.model.acquisition import (
    AcquiredPrimaryPdf,
    AcquisitionPath,
    AcquisitionResult,
    AssetRole,
    AutomaticPdfAcquisitionExhaustion,
    NoPrimaryPdf,
)
from sciretriever.model.primitives import LiteratureId
from sciretriever.model.report import StableFailure

if TYPE_CHECKING:
    from sciretriever.acquisition.api import PreparedAcquisition

_STAGE_ORDER = (
    AcquisitionPath.PUBLIC,
    AcquisitionPath.AUTHORIZED_PROVIDER_API,
    AcquisitionPath.CONTROLLED_BROWSER,
)


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


class AcquisitionService:
    """Coordinate ready/applicable Sources and the two atomic publication Ports."""

    def __init__(
        self,
        *,
        source_bindings: Iterable[PdfSourceBinding],
        publication_port: PrimaryPdfPreparationPort,
        exhaustion_port: AcquisitionExhaustionPublicationPort,
        exhaustion_clear_port: AcquisitionExhaustionClearPort,
    ) -> None:
        try:
            bindings = tuple(source_bindings)
        except TypeError:
            raise TypeError("source_bindings must be iterable") from None
        if any(not isinstance(binding, PdfSourceBinding) for binding in bindings):
            raise TypeError("source_bindings must contain PdfSourceBinding values")
        if not isinstance(publication_port, PrimaryPdfPreparationPort):
            raise TypeError("publication_port must implement PrimaryPdfPreparationPort")
        if not isinstance(exhaustion_port, AcquisitionExhaustionPublicationPort):
            raise TypeError("exhaustion_port must implement AcquisitionExhaustionPublicationPort")
        if not isinstance(exhaustion_clear_port, AcquisitionExhaustionClearPort):
            raise TypeError("exhaustion_clear_port must implement AcquisitionExhaustionClearPort")
        self._source_bindings = bindings
        self._publication_port = publication_port
        self._exhaustion_port = exhaustion_port
        self._exhaustion_clear_port = exhaustion_clear_port
        self._receipt_lock = Lock()
        self._receipts: WeakKeyDictionary[PreparedAcquisition, _ReceiptState] = WeakKeyDictionary()

    def clear_exhaustion_for_explicit_retry(
        self,
        expected_facts: AcquisitionExpectedFacts,
    ) -> None:
        """Clear exhaustion under CAS without starting Source or Network work."""

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
        """Complete serial Source work and return one opaque uncommitted receipt."""

        if not isinstance(request, AcquisitionRequest):
            raise TypeError("request must be an AcquisitionRequest")
        if any(asset.role is AssetRole.PRIMARY_PDF for asset in request.current_assets):
            raise AcquisitionFailure(
                _failure(
                    code="acquisition-target-has-primary-pdf",
                    reason="The Literature already has a primary PDF.",
                    action="Refresh the Literature before requesting acquisition.",
                    retryable=False,
                )
            )

        self._check_cancel(cancel_event)
        # All enabled capabilities are checked before Source applicability or
        # I/O.  A broken enabled capability is a configuration/system failure,
        # even when an earlier stage might otherwise have found a candidate.
        sources = self._preflight_enabled_sources(cancel_event=cancel_event)
        self._check_cancel(cancel_event)
        evidence = build_acquisition_evidence(request)
        candidate_keys = CandidateKeyTracker(request.excluded_candidate_keys)
        delivered_candidate_keys = set(request.excluded_candidate_keys)

        for stage in _STAGE_ORDER:
            self._check_cancel(cancel_event)
            for binding, source in sources:
                if binding.acquisition_path is not stage:
                    continue
                self._check_cancel(cancel_event)
                if not self._is_applicable(source, evidence, cancel_event=cancel_event):
                    continue
                prepared_candidate = self._run_source(
                    binding=binding,
                    source=source,
                    request=request,
                    evidence=evidence,
                    candidate_keys=candidate_keys,
                    delivered_candidate_keys=delivered_candidate_keys,
                    cancel_event=cancel_event,
                )
                if prepared_candidate is not None:
                    return self._issue_receipt(prepared_candidate)

        self._check_cancel(cancel_event)
        return self._issue_receipt(
            _ExhaustionPreparation(
                command=AcquisitionExhaustionPublicationCommand(
                    expected_facts=request.expected_facts,
                    observation_ids=request.observation_closure,
                ),
                literature_id=request.literature.literature_id,
            )
        )

    def commit_primary_pdf(self, prepared: PreparedAcquisition) -> AcquisitionResult:
        """Consume one service-issued receipt; every attempted commit is terminal."""

        payload = self._consume_receipt(prepared)
        if isinstance(payload, _CandidatePreparation):
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
        """Release a pending receipt; repeated discard of this receipt is a no-op."""

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

    def _preflight_enabled_sources(
        self,
        *,
        cancel_event: CancellationEvent | None,
    ) -> tuple[tuple[PdfSourceBinding, PdfSource], ...]:
        prepared: list[tuple[PdfSourceBinding, PdfSource]] = []
        for binding in self._source_bindings:
            self._check_cancel(cancel_event)
            if not binding.enabled:
                continue
            if not binding.production:
                raise AcquisitionFailure(
                    _failure(
                        code="acquisition-source-not-production",
                        reason="An enabled acquisition Source has no production implementation.",
                        action="Disable the Source or install its production implementation.",
                        retryable=False,
                    )
                )
            source = binding.source
            if source is None:
                raise AcquisitionFailure(
                    _failure(
                        code="acquisition-source-not-implemented",
                        reason="An enabled acquisition Source is not assembled.",
                        action="Assemble the Source or disable it.",
                        retryable=False,
                    )
                )
            readiness = binding.readiness
            if readiness is None:
                raise AcquisitionFailure(
                    _failure(
                        code="acquisition-source-readiness-missing",
                        reason="An enabled acquisition Source has no readiness decision.",
                        action="Check its local policy and credential readiness.",
                        retryable=False,
                    )
                )
            if not readiness.is_ready:
                if readiness.failure is not None:
                    raise AcquisitionFailure(readiness.failure)
                raise AcquisitionFailure(
                    _failure(
                        code="acquisition-source-not-ready",
                        reason="An enabled acquisition Source is not ready.",
                        action="Check its local policy and credential readiness.",
                        retryable=False,
                    )
                )
            try:
                source_name = source.source_name
                acquisition_path = source.acquisition_path
            except Exception:
                raise AcquisitionFailure(_contract_failure()) from None
            if (
                source_name != binding.source_name
                or acquisition_path is not binding.acquisition_path
            ):
                raise AcquisitionFailure(_contract_failure())
            prepared.append((binding, source))
        return tuple(prepared)

    def _is_applicable(
        self,
        source: PdfSource,
        evidence: AcquisitionEvidence,
        *,
        cancel_event: CancellationEvent | None,
    ) -> bool:
        self._check_cancel(cancel_event)
        try:
            applicable = source.is_applicable(evidence)
        except AcquisitionFailure:
            raise
        except Exception:
            raise AcquisitionFailure(_source_failure()) from None
        if type(applicable) is not bool:
            raise AcquisitionFailure(_contract_failure())
        self._check_cancel(cancel_event)
        return applicable

    def _run_source(  # noqa: C901 - cleanup/iterator ownership is one atomic boundary.
        self,
        *,
        binding: PdfSourceBinding,
        source: PdfSource,
        request: AcquisitionRequest,
        evidence: AcquisitionEvidence,
        candidate_keys: CandidateKeyTracker,
        delivered_candidate_keys: set[str],
        cancel_event: CancellationEvent | None,
    ) -> _CandidatePreparation | None:
        iterator: Iterator[TemporaryPdf] | None = None
        selected: _CandidatePreparation | None = None
        try:
            self._check_cancel(cancel_event)
            deliveries = source.acquire(request, evidence, candidate_keys)
            iterator = iter(deliveries)
            while True:
                self._check_cancel(cancel_event)
                try:
                    temporary_pdf = next(iterator)
                except StopIteration:
                    return None
                if not isinstance(temporary_pdf, TemporaryPdf):
                    raise AcquisitionFailure(_contract_failure())
                try:
                    self._check_cancel(cancel_event)
                except BaseException:
                    self._discard(temporary_pdf)
                    raise
                result = self._process_temporary_pdf(
                    binding=binding,
                    request=request,
                    temporary_pdf=temporary_pdf,
                    candidate_keys=candidate_keys,
                    delivered_candidate_keys=delivered_candidate_keys,
                    cancel_event=cancel_event,
                )
                if result is not None:
                    selected = _CandidatePreparation(
                        prepared_pdf=result,
                        candidate_key=temporary_pdf.candidate.candidate_key,
                        literature_id=request.literature.literature_id,
                    )
                    break
        except AcquisitionFailure:
            raise
        except Exception:
            raise AcquisitionFailure(_source_failure()) from None
        finally:
            if iterator is not None:
                try:
                    self._close_source_iterator(iterator)
                except BaseException:
                    if selected is not None:
                        try:
                            selected.prepared_pdf.discard()
                        except Exception:
                            pass
                    raise
        return selected

    def _process_temporary_pdf(  # noqa: C901 - validation and cleanup fail closed together.
        self,
        *,
        binding: PdfSourceBinding,
        request: AcquisitionRequest,
        temporary_pdf: TemporaryPdf,
        candidate_keys: CandidateKeyTracker,
        delivered_candidate_keys: set[str],
        cancel_event: CancellationEvent | None,
    ) -> PrimaryPdfPreparation | None:
        candidate = temporary_pdf.candidate
        if (
            candidate.source_name != binding.source_name
            or candidate.acquisition_path is not binding.acquisition_path
        ):
            self._discard(temporary_pdf)
            raise AcquisitionFailure(_contract_failure())

        candidate_key = candidate.candidate_key
        if candidate_key in delivered_candidate_keys:
            self._discard(temporary_pdf)
            return None
        if not candidate_keys.contains(candidate_key):
            self._discard(temporary_pdf)
            raise AcquisitionFailure(
                _failure(
                    code="acquisition-candidate-not-claimed",
                    reason="An acquisition Source did not claim its candidate before access.",
                    action="Correct the acquisition Source implementation.",
                    retryable=False,
                )
            )
        delivered_candidate_keys.add(candidate_key)

        self._check_cancel(cancel_event)
        result: PrimaryPdfPreparation | None = None
        try:
            result = self._publication_port.prepare_primary_pdf(
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
                self._discard(temporary_pdf)
            except BaseException:
                if result is not None:
                    try:
                        result.discard()
                    except Exception:
                        pass
                raise
        if result is None:
            self._check_cancel(cancel_event)
            return None
        if not isinstance(result, PrimaryPdfPreparation):
            raise AcquisitionFailure(_contract_failure())
        self._check_cancel_after_preparation(cancel_event, result)
        return result

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

    def _check_cancel_after_preparation(
        self,
        cancel_event: CancellationEvent | None,
        prepared: PrimaryPdfPreparation | None,
    ) -> None:
        try:
            self._check_cancel(cancel_event)
        except BaseException:
            if prepared is not None:
                try:
                    prepared.discard()
                except Exception:
                    pass
            raise

    def _discard(self, temporary_pdf: TemporaryPdf) -> None:
        try:
            temporary_pdf.content.discard()
        except AcquisitionFailure:
            raise
        except Exception:
            raise AcquisitionFailure(
                _failure(
                    code="acquisition-temporary-cleanup-failed",
                    reason="Temporary PDF cleanup did not complete.",
                    action="Retry after checking local temporary storage.",
                    retryable=True,
                )
            ) from None

    def _close_source_iterator(self, iterator: Iterator[TemporaryPdf]) -> None:
        try:
            close = getattr(iterator, "close", None)
            if close is None:
                return
            if not callable(close):
                raise AcquisitionFailure(_contract_failure())
            close()
        except AcquisitionFailure:
            raise
        except Exception:
            raise AcquisitionFailure(
                _failure(
                    code="acquisition-source-cleanup-failed",
                    reason="Acquisition Source cleanup did not complete.",
                    action="Retry after checking the Source runtime.",
                    retryable=True,
                )
            ) from None


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


def _contract_failure() -> StableFailure:
    return _failure(
        code="acquisition-port-contract",
        reason="An acquisition component violated its neutral Port contract.",
        action="Correct the acquisition component assembly.",
        retryable=False,
    )


def _source_failure() -> StableFailure:
    return _failure(
        code="acquisition-source-failed",
        reason="An acquisition Source failed before normal exhaustion.",
        action="Check the Source and retry the operation.",
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
        reason="Prepared PDF cleanup did not complete.",
        action="Retry after checking local temporary storage.",
        retryable=True,
    )


def _publication_failure() -> StableFailure:
    return _failure(
        code="acquisition-publication-failed",
        reason="Acquisition facts could not be committed safely.",
        action="Check storage and retry the operation.",
        retryable=True,
    )


__all__ = ("AcquisitionService",)
