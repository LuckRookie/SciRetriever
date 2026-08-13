"""Entry orchestration for bibliography import and atomic export.

Codecs convert only external bytes and format-neutral ``BibliographicRecord``
values.  Import delegates every identity, precedence, deduplication, and
CONTENT_READY decision to Literature.  Export reads one current snapshot,
delegates representative selection to Literature, and reports publication
only after the atomic output context has completed successfully.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import BinaryIO, Protocol, TypeAlias, cast
from uuid import uuid4

from sciretriever.entry.codecs._common import DEFAULT_MAX_INPUT_BYTES
from sciretriever.entry.codecs.bibtex import decode_bibtex, encode_bibtex
from sciretriever.entry.codecs.csl_json import decode_csl_json, encode_csl_json
from sciretriever.entry.codecs.ris import decode_ris, encode_ris
from sciretriever.entry.execution import execute_database_write
from sciretriever.entry.ports import (
    AtomicUserOutputPort,
    BibliographyCodecPort,
    BibliographyDecodeResult,
    BibliographyEncodeResult,
    BibliographyRecordFailure,
    ClockPort,
    DecodedBibliographyItem,
    DiscoveryRunRecoveryPort,
    ExecutionCurrentFacts,
    LiteratureSelectorSnapshot,
    MetaSelectorSnapshot,
    SelectorSnapshot,
    SelectorSnapshotReadPort,
    UserOutputTarget,
    WriteAdmissionFailure,
    WriteAdmissionPort,
)
from sciretriever.literature.api import LiteratureApi, ObservationAcceptanceResult
from sciretriever.model.execution import (
    DiscoveryRunSelector,
    LiteratureSelector,
    MetaLiteratureSelector,
    QuerySelector,
)
from sciretriever.model.library import LibraryQuery
from sciretriever.model.literature import Literature, MetaLiterature
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.record import BibliographicRecord
from sciretriever.model.report import (
    AcceptedImportRecord,
    BibliographyFormat,
    ExportFieldOmission,
    ExportReport,
    FailedReportEnd,
    FinishedReportEnd,
    ImportRecordReport,
    ImportReport,
    InterruptedReportEnd,
    RejectedImportRecord,
    SkippedExportRecord,
    StableFailure,
)

BibliographyExportScope: TypeAlias = (
    DiscoveryRunSelector | QuerySelector | MetaLiteratureSelector | LiteratureSelector | None
)
ObservationIdFactory: TypeAlias = Callable[[], ObservationId]
ProvenanceIdFactory: TypeAlias = Callable[[], ProvenanceId]


class _CancellationEvent(Protocol):
    def is_set(self) -> bool: ...


class _ControlledInterruption(BaseException):
    """Internal control transfer after a caller-visible cancellation request."""


class _ImportContractError(RuntimeError):
    pass


class _ExportContractError(RuntimeError):
    pass


class _CountingDestination:
    """Count exact staged bytes without owning or closing the Port stream."""

    __slots__ = ("_destination", "byte_count")

    def __init__(self, destination: BinaryIO) -> None:
        self._destination = destination
        self.byte_count = 0

    def write(self, data: bytes | bytearray | memoryview) -> int:
        written = self._destination.write(data)
        if type(written) is not int or written <= 0 or written > len(data):
            raise RuntimeError("atomic bibliography output rejected staged bytes")
        self.byte_count += written
        return written


class BibliographyCodecs:
    """The closed three-format implementation of ``BibliographyCodecPort``."""

    __slots__ = ("_max_input_bytes",)

    def __init__(self, *, max_input_bytes: int = DEFAULT_MAX_INPUT_BYTES) -> None:
        if type(max_input_bytes) is not int or max_input_bytes <= 0:
            raise ValueError("max_input_bytes must be a positive integer")
        self._max_input_bytes = max_input_bytes

    def decode(
        self,
        format: BibliographyFormat,
        source: BinaryIO,
    ) -> BibliographyDecodeResult:
        _require_format(format)
        if not callable(getattr(source, "read", None)):
            raise TypeError("source must be a readable binary stream")
        if format is BibliographyFormat.BIBTEX:
            return decode_bibtex(source, max_input_bytes=self._max_input_bytes)
        if format is BibliographyFormat.RIS:
            return decode_ris(source, max_input_bytes=self._max_input_bytes)
        if format is BibliographyFormat.CSL_JSON:
            return decode_csl_json(source, max_input_bytes=self._max_input_bytes)
        raise TypeError("format must be a supported bibliography format")

    def encode(
        self,
        format: BibliographyFormat,
        records: tuple[BibliographicRecord, ...],
        destination: BinaryIO,
    ) -> BibliographyEncodeResult:
        _require_format(format)
        if not isinstance(records, tuple) or any(
            not isinstance(record, BibliographicRecord) for record in records
        ):
            raise TypeError("records must be a tuple of BibliographicRecord values")
        if not callable(getattr(destination, "write", None)):
            raise TypeError("destination must be a writable binary stream")
        if format is BibliographyFormat.BIBTEX:
            return encode_bibtex(records, destination)
        if format is BibliographyFormat.RIS:
            return encode_ris(records, destination)
        if format is BibliographyFormat.CSL_JSON:
            return encode_csl_json(records, destination)
        raise TypeError("format must be a supported bibliography format")


class BibliographyOperations:
    """Import observations through Literature and atomically export snapshots."""

    __slots__ = (
        "_literature",
        "_codec",
        "_output",
        "_selector_reader",
        "_clock",
        "_write_admission",
        "_recovery",
        "_observation_id_factory",
        "_provenance_id_factory",
        "_provider_precedence",
        "_cancel_event",
    )

    def __init__(
        self,
        *,
        literature: LiteratureApi,
        codec: BibliographyCodecPort,
        output: AtomicUserOutputPort,
        selector_reader: SelectorSnapshotReadPort,
        clock: ClockPort,
        write_admission: WriteAdmissionPort,
        recovery: DiscoveryRunRecoveryPort,
        observation_id_factory: ObservationIdFactory = lambda: ObservationId(str(uuid4())),
        provenance_id_factory: ProvenanceIdFactory = lambda: ProvenanceId(str(uuid4())),
        provider_precedence: Iterable[str] = (),
        cancel_event: _CancellationEvent | None = None,
    ) -> None:
        if not isinstance(literature, LiteratureApi):
            raise TypeError("literature must be a LiteratureApi")
        if not isinstance(codec, BibliographyCodecPort):
            raise TypeError("codec must implement BibliographyCodecPort")
        if not isinstance(output, AtomicUserOutputPort):
            raise TypeError("output must implement AtomicUserOutputPort")
        if not isinstance(selector_reader, SelectorSnapshotReadPort):
            raise TypeError("selector_reader must implement SelectorSnapshotReadPort")
        if not isinstance(clock, ClockPort):
            raise TypeError("clock must implement ClockPort")
        if not isinstance(write_admission, WriteAdmissionPort):
            raise TypeError("write_admission must implement WriteAdmissionPort")
        if not isinstance(recovery, DiscoveryRunRecoveryPort):
            raise TypeError("recovery must implement DiscoveryRunRecoveryPort")
        if not callable(observation_id_factory) or not callable(provenance_id_factory):
            raise TypeError("bibliography identity factories must be callable")
        if cancel_event is not None and not callable(getattr(cancel_event, "is_set", None)):
            raise TypeError("cancel_event must expose is_set")
        self._literature = literature
        self._codec = codec
        self._output = output
        self._selector_reader = selector_reader
        self._clock = clock
        self._write_admission = write_admission
        self._recovery = recovery
        self._observation_id_factory = observation_id_factory
        self._provenance_id_factory = provenance_id_factory
        self._provider_precedence = _precedence(provider_precedence)
        self._cancel_event = cancel_event

    def import_bibliography(
        self,
        format: BibliographyFormat,
        source: BinaryIO,
    ) -> ImportReport:
        """Decode completely, then admit each valid record through Literature."""

        _require_format(format)
        if not callable(getattr(source, "read", None)):
            raise TypeError("source must be a readable binary stream")
        try:
            decoded = self._codec.decode(format, source)
        except KeyboardInterrupt:
            return _import_report(format, 0, (), InterruptedReportEnd(kind="interrupted"))
        except Exception:
            return _import_report(
                format,
                0,
                (),
                FailedReportEnd(kind="failed", failure=_import_operation_failure()),
            )
        if not isinstance(decoded, BibliographyDecodeResult):
            return _import_report(
                format,
                0,
                (),
                FailedReportEnd(kind="failed", failure=_import_contract_failure()),
            )

        reports: list[ImportRecordReport] = []
        input_count = len(decoded.items)
        try:
            if any(isinstance(item, BibliographicRecord) for item in decoded.items):
                execute_database_write(
                    admission=self._write_admission,
                    recovery=self._recovery,
                    prepare=lambda: decoded.items,
                    execute=lambda items: self._accept_import_items(items, reports),
                )
            else:
                self._accept_import_items(decoded.items, reports)
        except (_ControlledInterruption, KeyboardInterrupt):
            return _import_report(
                format,
                input_count,
                tuple(reports),
                InterruptedReportEnd(kind="interrupted"),
            )
        except _ImportContractError:
            return _import_report(
                format,
                input_count,
                tuple(reports),
                FailedReportEnd(kind="failed", failure=_import_contract_failure()),
            )
        except WriteAdmissionFailure as error:
            return _import_report(
                format,
                input_count,
                tuple(reports),
                FailedReportEnd(kind="failed", failure=error.failure),
            )
        except Exception:
            return _import_report(
                format,
                input_count,
                tuple(reports),
                FailedReportEnd(kind="failed", failure=_import_operation_failure()),
            )
        return _import_report(
            format,
            input_count,
            tuple(reports),
            FinishedReportEnd(kind="finished"),
        )

    def export_bibliography(
        self,
        format: BibliographyFormat,
        selector: BibliographyExportScope,
        target: UserOutputTarget,
        overwrite: bool = False,
    ) -> ExportReport:
        """Encode one frozen current snapshot and publish it as a single file."""

        _require_format(format)
        if type(overwrite) is not bool:
            raise TypeError("overwrite must be a bool")
        normalized_selector = _export_selector(selector)
        try:
            snapshot = self._selector_reader.read_selector(normalized_selector)
            selected = self._select_export_literatures(normalized_selector, snapshot)
        except KeyboardInterrupt:
            return _export_report(
                format=format,
                selected=(),
                encoded=None,
                end=InterruptedReportEnd(kind="interrupted"),
            )
        except _ExportContractError:
            return _export_report(
                format=format,
                selected=(),
                encoded=None,
                end=FailedReportEnd(kind="failed", failure=_export_contract_failure()),
            )
        except Exception:
            return _export_report(
                format=format,
                selected=(),
                encoded=None,
                end=FailedReportEnd(kind="failed", failure=_export_operation_failure()),
            )

        records = tuple(
            BibliographicRecord(record_index=index, metadata=literature.metadata)
            for index, literature in enumerate(selected)
        )
        encoded: BibliographyEncodeResult | None = None
        finished_report: ExportReport | None = None
        try:
            self._raise_if_cancelled()
            with self._output.open_atomic(target, overwrite=overwrite) as destination:
                counting = _CountingDestination(destination)
                candidate = self._codec.encode(format, records, cast(BinaryIO, counting))
                _validate_encoded_result(records, candidate)
                finished_report = _validated_finished_export_report(
                    format=format,
                    selected=selected,
                    encoded=candidate,
                    bytes_written=counting.byte_count,
                )
                encoded = candidate
                self._raise_if_cancelled()
        except (_ControlledInterruption, KeyboardInterrupt):
            return _export_report(
                format=format,
                selected=selected,
                encoded=encoded,
                end=InterruptedReportEnd(kind="interrupted"),
            )
        except _ExportContractError:
            return _export_report(
                format=format,
                selected=selected,
                encoded=encoded,
                end=FailedReportEnd(kind="failed", failure=_export_contract_failure()),
            )
        except Exception:
            return _export_report(
                format=format,
                selected=selected,
                encoded=encoded,
                end=FailedReportEnd(kind="failed", failure=_export_operation_failure()),
            )
        if finished_report is None or encoded is None:
            return _export_report(
                format=format,
                selected=selected,
                encoded=encoded,
                end=FailedReportEnd(kind="failed", failure=_export_contract_failure()),
            )
        return finished_report

    def _accept_import_items(
        self,
        items: tuple[DecodedBibliographyItem, ...],
        reports: list[ImportRecordReport],
    ) -> None:
        for item in items:
            self._raise_if_cancelled()
            if isinstance(item, BibliographyRecordFailure):
                reports.append(
                    RejectedImportRecord(
                        kind="rejected",
                        record_index=item.record_index,
                        failure=item.failure,
                    )
                )
                continue
            if not isinstance(item, BibliographicRecord):
                raise _ImportContractError()
            observation_id = self._observation_id_factory()
            provenance_id = self._provenance_id_factory()
            observed_at = self._clock.now()
            if not isinstance(observation_id, ObservationId):
                raise _ImportContractError()
            if not isinstance(provenance_id, ProvenanceId):
                raise _ImportContractError()
            if not isinstance(observed_at, UtcTimestamp):
                raise _ImportContractError()
            provenance = Provenance(
                provenance_id=provenance_id,
                source_kind=SourceKind.USER,
                source_name="bibliographic-import",
                source_record_id=None,
                observed_at=observed_at,
                input_sha256=None,
                parameters_sha256=None,
            )
            result = self._literature.accept_bibliographic_record(
                item,
                observation_id=observation_id,
                provenance=provenance,
                provider_precedence=self._provider_precedence,
            )
            reports.append(_import_record_report(item.record_index, result))

    def _select_export_literatures(
        self,
        selector: DiscoveryRunSelector
        | QuerySelector
        | MetaLiteratureSelector
        | LiteratureSelector,
        snapshot: SelectorSnapshot,
    ) -> tuple[Literature, ...]:
        if isinstance(selector, LiteratureSelector):
            if not isinstance(snapshot, LiteratureSelectorSnapshot):
                raise _ExportContractError()
            return _explicit_literatures(selector, snapshot)
        if not isinstance(snapshot, MetaSelectorSnapshot):
            raise _ExportContractError()
        return _representative_literatures(self._literature, selector, snapshot)

    def _raise_if_cancelled(self) -> None:
        if self._cancel_event is not None and self._cancel_event.is_set():
            raise _ControlledInterruption()


def _import_record_report(
    record_index: int,
    result: ObservationAcceptanceResult,
) -> ImportRecordReport:
    if not isinstance(result, ObservationAcceptanceResult):
        raise _ImportContractError()
    if result.decision == "rejected":
        return RejectedImportRecord(
            kind="rejected",
            record_index=record_index,
            failure=_admission_failure(result.reason),
        )
    if result.decision not in {"created", "enriched", "matched"}:
        raise _ImportContractError()
    literature = result.literature
    meta_literature = result.meta_literature
    if literature is None or meta_literature is None:
        raise _ImportContractError()
    if literature.meta_literature_id != meta_literature.meta_literature_id:
        raise _ImportContractError()
    return AcceptedImportRecord(
        kind="accepted",
        record_index=record_index,
        outcome=result.decision,
        meta_literature_id=meta_literature.meta_literature_id,
        literature_id=literature.literature_id,
    )


def _import_report(
    format: BibliographyFormat,
    input_count: int,
    records: tuple[ImportRecordReport, ...],
    end: FinishedReportEnd | InterruptedReportEnd | FailedReportEnd,
) -> ImportReport:
    processed = {record.record_index for record in records}
    accepted_ids: list[MetaLiteratureId] = []
    for record in records:
        if (
            isinstance(record, AcceptedImportRecord)
            and record.meta_literature_id not in accepted_ids
        ):
            accepted_ids.append(record.meta_literature_id)
    return ImportReport(
        kind="import",
        end=end,
        format=format,
        input_record_count=input_count,
        records=records,
        not_processed_record_indexes=tuple(
            index for index in range(input_count) if index not in processed
        ),
        accepted_meta_literature_ids=tuple(accepted_ids),
    )


def _explicit_literatures(
    selector: LiteratureSelector,
    snapshot: LiteratureSelectorSnapshot,
) -> tuple[Literature, ...]:
    if snapshot.literature_ids != selector.literature_ids:
        raise _ExportContractError()
    facts = _current_facts_by_literature(snapshot.current_facts)
    if set(facts) != set(selector.literature_ids):
        raise _ExportContractError()
    return tuple(
        facts[literature_id].current.literature for literature_id in selector.literature_ids
    )


def _representative_literatures(
    literature_api: LiteratureApi,
    selector: DiscoveryRunSelector | QuerySelector | MetaLiteratureSelector,
    snapshot: MetaSelectorSnapshot,
) -> tuple[Literature, ...]:
    meta_ids = snapshot.meta_literature_ids
    if len(meta_ids) != len(set(meta_ids)):
        raise _ExportContractError()
    if isinstance(selector, MetaLiteratureSelector) and meta_ids != selector.meta_literature_ids:
        raise _ExportContractError()
    metas = _meta_literatures_by_id(snapshot.meta_literatures)
    if set(metas) != set(meta_ids):
        raise _ExportContractError()
    facts = _current_facts_by_literature(snapshot.current_facts)
    if any(item.current.literature.meta_literature_id not in metas for item in facts.values()):
        raise _ExportContractError()
    selected: list[Literature] = []
    for meta_id in meta_ids:
        members = tuple(
            item.current.literature
            for item in facts.values()
            if item.current.literature.meta_literature_id == meta_id
        )
        if not members:
            raise _ExportContractError()
        for item in _selected_export_members(literature_api, metas[meta_id], members):
            if item not in selected:
                selected.append(item)
    return tuple(selected)


def _selected_export_members(
    literature_api: LiteratureApi,
    meta_literature: MetaLiterature,
    members: tuple[Literature, ...],
) -> tuple[Literature, ...]:
    values = literature_api.select_export_literatures(meta_literature, members)
    if not isinstance(values, tuple) or any(not isinstance(item, Literature) for item in values):
        raise _ExportContractError()
    if not values or len(values) != len({item.literature_id for item in values}):
        raise _ExportContractError()
    if any(item not in members for item in values):
        raise _ExportContractError()
    return values


def _current_facts_by_literature(
    values: tuple[ExecutionCurrentFacts, ...],
) -> dict[LiteratureId, ExecutionCurrentFacts]:
    result: dict[LiteratureId, ExecutionCurrentFacts] = {}
    for value in values:
        if not isinstance(value, ExecutionCurrentFacts):
            raise _ExportContractError()
        literature_id = value.current.literature.literature_id
        if literature_id in result:
            raise _ExportContractError()
        result[literature_id] = value
    return result


def _meta_literatures_by_id(
    values: tuple[MetaLiterature, ...],
) -> dict[MetaLiteratureId, MetaLiterature]:
    result: dict[MetaLiteratureId, MetaLiterature] = {}
    for value in values:
        if not isinstance(value, MetaLiterature):
            raise _ExportContractError()
        if value.meta_literature_id in result:
            raise _ExportContractError()
        result[value.meta_literature_id] = value
    return result


def _validate_encoded_result(
    records: tuple[BibliographicRecord, ...],
    result: BibliographyEncodeResult,
) -> None:
    if not isinstance(result, BibliographyEncodeResult):
        raise _ExportContractError()
    expected = tuple(record.record_index for record in records)
    encoded = result.encoded_record_indexes
    failed = tuple(item.record_index for item in result.failures)
    if len(failed) != len(set(failed)):
        raise _ExportContractError()
    if set(encoded).intersection(failed) or set(encoded) | set(failed) != set(expected):
        raise _ExportContractError()
    if tuple(index for index in expected if index in set(encoded)) != encoded:
        raise _ExportContractError()
    if tuple(index for index in expected if index in set(failed)) != failed:
        raise _ExportContractError()
    if any(item.record_index not in encoded for item in result.omissions):
        raise _ExportContractError()
    omission_keys = tuple((item.record_index, item.field) for item in result.omissions)
    if len(omission_keys) != len(set(omission_keys)):
        raise _ExportContractError()


def _validated_finished_export_report(
    *,
    format: BibliographyFormat,
    selected: tuple[Literature, ...],
    encoded: BibliographyEncodeResult,
    bytes_written: int,
) -> ExportReport:
    try:
        return _export_report(
            format=format,
            selected=selected,
            encoded=encoded,
            end=FinishedReportEnd(kind="finished"),
            bytes_written=bytes_written,
        )
    except Exception:
        raise _ExportContractError() from None


def _export_report(
    *,
    format: BibliographyFormat,
    selected: tuple[Literature, ...],
    encoded: BibliographyEncodeResult | None,
    end: FinishedReportEnd | InterruptedReportEnd | FailedReportEnd,
    bytes_written: int | None = None,
) -> ExportReport:
    selected_ids = tuple(item.literature_id for item in selected)
    by_index = {index: item for index, item in enumerate(selected)}
    if encoded is None:
        skipped: tuple[SkippedExportRecord, ...] = ()
        omissions: tuple[ExportFieldOmission, ...] = ()
        encoded_ids = selected_ids
    else:
        skipped = tuple(
            SkippedExportRecord(
                literature_id=by_index[item.record_index].literature_id,
                failure=item.failure,
            )
            for item in encoded.failures
        )
        omissions = tuple(
            ExportFieldOmission(
                literature_id=by_index[item.record_index].literature_id,
                field=item.field,
                reason=item.reason,
            )
            for item in encoded.omissions
        )
        encoded_ids = tuple(
            by_index[index].literature_id for index in encoded.encoded_record_indexes
        )
    finished = isinstance(end, FinishedReportEnd)
    return ExportReport(
        kind="export",
        end=end,
        format=format,
        selected_literature_ids=selected_ids,
        published_literature_ids=encoded_ids if finished else (),
        skipped=skipped,
        not_published_literature_ids=() if finished else encoded_ids,
        omissions=omissions,
        bytes_written=bytes_written if finished else None,
    )


def _export_selector(
    selector: BibliographyExportScope,
) -> DiscoveryRunSelector | QuerySelector | MetaLiteratureSelector | LiteratureSelector:
    if selector is None:
        return QuerySelector(kind="query", query=LibraryQuery())
    if not isinstance(
        selector,
        (DiscoveryRunSelector, QuerySelector, MetaLiteratureSelector, LiteratureSelector),
    ):
        raise TypeError("selector must be a supported bibliography export scope")
    return selector


def _precedence(values: Iterable[str]) -> tuple[str, ...]:
    if isinstance(values, (str, bytes)):
        raise TypeError("provider_precedence must be an iterable of provider names")
    try:
        result = tuple(values)
    except Exception:
        raise TypeError("provider_precedence must be an iterable of provider names") from None
    if any(not isinstance(item, str) or not item.strip() for item in result):
        raise ValueError("provider_precedence must contain nonblank provider names")
    if len(result) != len(set(result)):
        raise ValueError("provider_precedence must not contain duplicates")
    return result


def _require_format(format: BibliographyFormat) -> None:
    if not isinstance(format, BibliographyFormat):
        raise TypeError("format must be a BibliographyFormat")


def _admission_failure(reason: str | None) -> StableFailure:
    if reason == "missing-title-or-doi":
        return StableFailure(
            code="bibliography-record-missing-identity",
            reason="The record has neither a title nor a DOI.",
            action="Add a title or DOI, then retry the import.",
            retryable=False,
        )
    if reason == "stable-identifier-conflict":
        return StableFailure(
            code="bibliography-record-identity-conflict",
            reason="The record contains stable identifiers that conflict with one Literature.",
            action="Correct the conflicting identifiers and retry the import.",
            retryable=False,
        )
    return StableFailure(
        code="bibliography-record-rejected",
        reason="The record could not be accepted safely by the literature database.",
        action="Review its title and stable identifiers, then retry the import.",
        retryable=False,
    )


def _import_contract_failure() -> StableFailure:
    return StableFailure(
        code="bibliography-import-contract-failed",
        reason="A local bibliography component returned an inconsistent import result.",
        action="Check the local installation and catalog, then retry the operation.",
        retryable=True,
    )


def _import_operation_failure() -> StableFailure:
    return StableFailure(
        code="bibliography-import-failed",
        reason="The bibliography import could not reach its normal boundary.",
        action="Check the local catalog and retry the operation.",
        retryable=True,
    )


def _export_contract_failure() -> StableFailure:
    return StableFailure(
        code="bibliography-export-contract-failed",
        reason="A local bibliography component returned an inconsistent export result.",
        action="Check the local installation and catalog, then retry the operation.",
        retryable=True,
    )


def _export_operation_failure() -> StableFailure:
    return StableFailure(
        code="bibliography-export-failed",
        reason="The bibliography output could not be published atomically.",
        action="Check the target and local catalog, then retry the operation.",
        retryable=True,
    )


__all__ = (
    "BibliographyCodecs",
    "BibliographyExportScope",
    "BibliographyOperations",
    "ObservationIdFactory",
    "ProvenanceIdFactory",
)
