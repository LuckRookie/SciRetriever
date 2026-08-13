"""Thin Entry orchestration for one caller-owned manual PDF stream."""

from __future__ import annotations

from typing import BinaryIO, Protocol, runtime_checkable

from sciretriever.acquisition.api import (
    AcquisitionExpectedFacts,
    AcquisitionFailure,
    CancellationEvent,
    ManualPdfInputError,
    PdfValidationCancelled,
    ReadablePdfSource,
)
from sciretriever.entry.execution import execute_database_write
from sciretriever.entry.ports import (
    CurrentFactsSnapshot,
    CurrentFactsSnapshotReadPort,
    DiscoveryRunRecoveryPort,
    ExecutionCurrentFacts,
    WriteAdmissionFailure,
    WriteAdmissionPort,
)
from sciretriever.model.acquisition import AcceptedManualPdf, LiteratureAsset
from sciretriever.model.primitives import LiteratureId
from sciretriever.model.report import (
    AcceptedManualPdfReportResult,
    FailedReportEnd,
    FinishedReportEnd,
    InterruptedReportEnd,
    ManualPdfReport,
    RejectedManualPdfReportResult,
    StableFailure,
)


@runtime_checkable
class _ManualPdfAdmissionPort(Protocol):
    """The frozen Acquisition manual-admission boundary consumed by Entry."""

    def accept_manual_pdf(
        self,
        *,
        expected_facts: AcquisitionExpectedFacts,
        current_assets: tuple[LiteratureAsset, ...],
        source: ReadablePdfSource,
        cancel_event: CancellationEvent | None = None,
    ) -> AcceptedManualPdf: ...


class _CurrentFactsContractError(RuntimeError):
    """The exact current-facts reader returned an inconsistent snapshot."""


class _ManualAdmissionContractError(RuntimeError):
    """The manual-admission component returned an invalid success value."""


class ManualPdfOperation:
    """Accept one PDF for one explicit Literature without owning its stream."""

    __slots__ = (
        "_current_facts_reader",
        "_manual_admission",
        "_write_admission",
        "_recovery",
        "_cancel_event",
    )

    def __init__(
        self,
        *,
        current_facts_reader: CurrentFactsSnapshotReadPort,
        manual_admission: _ManualPdfAdmissionPort,
        write_admission: WriteAdmissionPort,
        recovery: DiscoveryRunRecoveryPort,
        cancel_event: CancellationEvent | None = None,
    ) -> None:
        if not isinstance(current_facts_reader, CurrentFactsSnapshotReadPort):
            raise TypeError("current_facts_reader must implement current-facts snapshot reads")
        if not isinstance(manual_admission, _ManualPdfAdmissionPort):
            raise TypeError("manual_admission must implement manual PDF admission")
        if not isinstance(write_admission, WriteAdmissionPort):
            raise TypeError("write_admission must implement write admission")
        if not isinstance(recovery, DiscoveryRunRecoveryPort):
            raise TypeError("recovery must implement discovery recovery")
        if cancel_event is not None and not callable(getattr(cancel_event, "is_set", None)):
            raise TypeError("cancel_event must expose is_set")
        self._current_facts_reader = current_facts_reader
        self._manual_admission = manual_admission
        self._write_admission = write_admission
        self._recovery = recovery
        self._cancel_event = cancel_event

    def __call__(
        self,
        literature_id: LiteratureId,
        source: BinaryIO,
    ) -> ManualPdfReport:
        if not isinstance(literature_id, LiteratureId):
            raise TypeError("literature_id must be LiteratureId")

        try:
            accepted = execute_database_write(
                admission=self._write_admission,
                recovery=self._recovery,
                prepare=lambda: self._read_current(literature_id),
                execute=lambda current: self._accept(
                    literature_id=literature_id,
                    current=current,
                    source=source,
                ),
            )
        except ManualPdfInputError as error:
            return _rejected_report(literature_id, error.failure)
        except AcquisitionFailure as error:
            return _failed_report(literature_id, error.failure)
        except PdfValidationCancelled:
            return _interrupted_report(literature_id)
        except _CurrentFactsContractError:
            return _failed_report(literature_id, _current_facts_contract_failure())
        except WriteAdmissionFailure as error:
            return _failed_report(literature_id, error.failure)
        except RuntimeError:
            return _failed_report(literature_id, _operation_failure())
        return _accepted_report(literature_id, accepted)

    def _read_current(self, literature_id: LiteratureId) -> ExecutionCurrentFacts | None:
        snapshot = self._current_facts_reader.read_current(literature_id)
        if not isinstance(snapshot, CurrentFactsSnapshot):
            raise _CurrentFactsContractError()
        if snapshot.literature_id != literature_id:
            raise _CurrentFactsContractError()
        if not snapshot.current_facts:
            return None
        if len(snapshot.current_facts) != 1:
            raise _CurrentFactsContractError()
        current = snapshot.current_facts[0]
        if current.current.literature.literature_id != literature_id:
            raise _CurrentFactsContractError()
        return current

    def _accept(
        self,
        *,
        literature_id: LiteratureId,
        current: ExecutionCurrentFacts | None,
        source: ReadablePdfSource,
    ) -> AcceptedManualPdf:
        if current is None:
            raise ManualPdfInputError(_literature_not_found_failure())
        facts = current.current
        accepted = self._manual_admission.accept_manual_pdf(
            expected_facts=AcquisitionExpectedFacts(
                literature_id=literature_id,
                meta_literature_id=facts.literature.meta_literature_id,
                metadata_revision=facts.metadata_revision,
                metadata_sha256=facts.metadata_sha256,
                expected_no_primary_pdf=True,
            ),
            current_assets=tuple(item.relation for item in facts.current_primary_pdfs),
            source=source,
            cancel_event=self._cancel_event,
        )
        if not isinstance(accepted, AcceptedManualPdf):
            raise _ManualAdmissionContractError()
        return accepted


def _accepted_report(
    literature_id: LiteratureId,
    accepted: AcceptedManualPdf,
) -> ManualPdfReport:
    return ManualPdfReport(
        kind="manual-pdf",
        end=FinishedReportEnd(kind="finished"),
        literature_id=literature_id,
        result=AcceptedManualPdfReportResult(kind="accepted", accepted=accepted),
    )


def _rejected_report(
    literature_id: LiteratureId,
    failure: StableFailure,
) -> ManualPdfReport:
    return ManualPdfReport(
        kind="manual-pdf",
        end=FinishedReportEnd(kind="finished"),
        literature_id=literature_id,
        result=RejectedManualPdfReportResult(kind="rejected", failure=failure),
    )


def _failed_report(
    literature_id: LiteratureId,
    failure: StableFailure,
) -> ManualPdfReport:
    return ManualPdfReport(
        kind="manual-pdf",
        end=FailedReportEnd(kind="failed", failure=failure),
        literature_id=literature_id,
        result=None,
    )


def _interrupted_report(literature_id: LiteratureId) -> ManualPdfReport:
    return ManualPdfReport(
        kind="manual-pdf",
        end=InterruptedReportEnd(kind="interrupted"),
        literature_id=literature_id,
        result=None,
    )


def _literature_not_found_failure() -> StableFailure:
    return StableFailure(
        code="manual-pdf-literature-not-found",
        reason="The selected Literature does not exist.",
        action="Refresh the local catalog and select an existing Literature.",
        retryable=False,
    )


def _current_facts_contract_failure() -> StableFailure:
    return StableFailure(
        code="manual-pdf-current-facts-contract",
        reason="The selected Literature facts could not be read safely.",
        action="Check the local catalog and retry the operation.",
        retryable=True,
    )


def _operation_failure() -> StableFailure:
    return StableFailure(
        code="manual-pdf-operation-failed",
        reason="A required local component could not accept the manual PDF.",
        action="Check the local catalog and artifact store, then retry.",
        retryable=True,
    )


__all__ = ("ManualPdfOperation",)
