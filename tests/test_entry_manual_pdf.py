from __future__ import annotations

import ast
import inspect
import io
import unittest
from contextlib import AbstractContextManager
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType
from typing import cast

import sciretriever.entry.manual as manual_entry_module
from sciretriever.acquisition.manual import ManualPdfInputError
from sciretriever.acquisition.ports import AcquisitionExpectedFacts, AcquisitionFailure
from sciretriever.acquisition.rules import (
    CancellationEvent,
    PdfValidationCancelled,
    ReadablePdfSource,
)
from sciretriever.entry.manual import ManualPdfOperation
from sciretriever.entry.ports import CurrentFactsSnapshot, ExecutionCurrentFacts
from sciretriever.literature.content import metadata_sha256
from sciretriever.literature.ports import StalePreconditionError
from sciretriever.literature.state import CurrentLiteratureFacts, CurrentPrimaryPdf
from sciretriever.model.acquisition import (
    AcceptedManualPdf,
    Asset,
    AssetRole,
    AutomaticPdfAcquisitionExhaustion,
    LiteratureAsset,
)
from sciretriever.model.literature import Literature, LiteratureStatus, VersionRole
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.primitives import (
    AssetId,
    DiscoveryRunId,
    LiteratureAssetId,
    LiteratureId,
    MetaLiteratureId,
    ProvenanceId,
    RelativeArtifactPath,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import (
    AcceptedManualPdfReportResult,
    FailedReportEnd,
    FinishedReportEnd,
    InterruptedReportEnd,
    ManualPdfReport,
    RejectedManualPdfReportResult,
    StableFailure,
)

ROOT = Path(__file__).resolve().parents[1]
_TIME = UtcTimestamp("2026-08-12T12:00:00Z")
_METADATA_HASH = Sha256("a" * 64)
_PDF_HASH = Sha256("b" * 64)
_PRIVATE_PATH = "/private/alice/manual-secret.pdf"
_PRIVATE_BYTES = b"PRIVATE-MANUAL-PDF-BYTES"


def _uuid(index: int) -> str:
    return f"{index:08x}-0000-4000-8000-{index:012x}"


_LITERATURE_ID = LiteratureId(_uuid(1))
_OTHER_LITERATURE_ID = LiteratureId(_uuid(2))
_META_LITERATURE_ID = MetaLiteratureId(_uuid(3))


def _failure(
    code: str,
    *,
    reason: str = "The offline fixture rejected the operation.",
    action: str = "Retry with refreshed fixture facts.",
    retryable: bool = False,
) -> StableFailure:
    return StableFailure(
        code=code,
        reason=reason,
        action=action,
        retryable=retryable,
    )


def _provenance(
    index: int,
    *,
    source_kind: SourceKind,
    source_name: str,
    digest: Sha256,
) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(_uuid(100 + index)),
        source_kind=source_kind,
        source_name=source_name,
        source_record_id=("fixture-record" if source_kind is SourceKind.ASSET_PROVIDER else None),
        observed_at=_TIME,
        input_sha256=digest,
        parameters_sha256=None,
    )


def _accepted() -> AcceptedManualPdf:
    asset = Asset(
        asset_id=AssetId(_uuid(200)),
        sha256=_PDF_HASH,
        size_bytes=321,
        media_type="application/pdf",
        path=RelativeArtifactPath("objects/manual-fixture.pdf"),
    )
    relation = LiteratureAsset(
        literature_asset_id=LiteratureAssetId(_uuid(201)),
        literature_id=_LITERATURE_ID,
        asset_id=asset.asset_id,
        role=AssetRole.PRIMARY_PDF,
        provenance=_provenance(
            1,
            source_kind=SourceKind.USER,
            source_name="manual-pdf",
            digest=asset.sha256,
        ),
        source_url=None,
    )
    return AcceptedManualPdf(asset=asset, relation=relation)


def _current(
    *,
    literature_id: LiteratureId = _LITERATURE_ID,
    primary: bool = False,
    exhausted: bool = False,
) -> ExecutionCurrentFacts:
    metadata = LiteratureMetadata(title="Offline manual PDF target")
    literature = Literature(
        literature_id=literature_id,
        meta_literature_id=_META_LITERATURE_ID,
        version_role=VersionRole.PUBLISHED,
        metadata=metadata,
        status=(LiteratureStatus.ASSET_READY if primary else LiteratureStatus.UNREVIEWED),
    )
    current_primary_pdfs: tuple[CurrentPrimaryPdf, ...] = ()
    if primary:
        asset = Asset(
            asset_id=AssetId(_uuid(300)),
            sha256=_PDF_HASH,
            size_bytes=123,
            media_type="application/pdf",
            path=RelativeArtifactPath("objects/current-primary.pdf"),
        )
        relation = LiteratureAsset(
            literature_asset_id=LiteratureAssetId(_uuid(301)),
            literature_id=literature_id,
            asset_id=asset.asset_id,
            role=AssetRole.PRIMARY_PDF,
            provenance=_provenance(
                2,
                source_kind=SourceKind.ASSET_PROVIDER,
                source_name="offline-provider",
                digest=asset.sha256,
            ),
            source_url="https://provider.test/current.pdf",
        )
        current_primary_pdfs = (CurrentPrimaryPdf(asset=asset, relation=relation),)
    return ExecutionCurrentFacts(
        current=CurrentLiteratureFacts(
            literature=literature,
            metadata_revision=7,
            metadata_sha256=metadata_sha256(metadata),
            current_primary_pdfs=current_primary_pdfs,
        ),
        automatic_pdf_exhaustion=(
            AutomaticPdfAcquisitionExhaustion(literature_id=literature_id) if exhausted else None
        ),
    )


def _snapshot(*values: ExecutionCurrentFacts) -> CurrentFactsSnapshot:
    return CurrentFactsSnapshot(
        literature_id=_LITERATURE_ID,
        current_facts=tuple(values),
    )


class _CallerOwnedStream(io.BytesIO):
    def __init__(self, payload: bytes = _PRIVATE_BYTES) -> None:
        super().__init__(payload)
        self.close_calls = 0

    def close(self) -> None:
        self.close_calls += 1
        super().close()

    def __repr__(self) -> str:
        return f"<_CallerOwnedStream path={_PRIVATE_PATH!r} bytes={_PRIVATE_BYTES!r}>"


class _Lease(AbstractContextManager[None]):
    def __init__(self, events: list[str]) -> None:
        self._events = events

    def __enter__(self) -> None:
        self._events.append("admission")

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool:
        del exc_type, exc_value, traceback
        self._events.append("release")
        return False


class _Admission:
    def __init__(self, events: list[str]) -> None:
        self._events = events

    def acquire_nowait(self) -> AbstractContextManager[None]:
        return _Lease(self._events)


class _Recovery:
    def __init__(self, events: list[str]) -> None:
        self._events = events

    def interrupt_visible_running(self) -> tuple[DiscoveryRunId, ...]:
        self._events.append("recovery")
        return ()


class _FactsReader:
    def __init__(
        self,
        events: list[str],
        result: CurrentFactsSnapshot | BaseException,
    ) -> None:
        self._events = events
        self._result = result
        self.calls: list[LiteratureId] = []

    def read_current(self, literature_id: LiteratureId) -> CurrentFactsSnapshot:
        self._events.append("read")
        self.calls.append(literature_id)
        if isinstance(self._result, BaseException):
            raise self._result
        return self._result


@dataclass(frozen=True, slots=True)
class _ManualCall:
    expected_facts: AcquisitionExpectedFacts
    current_assets: tuple[LiteratureAsset, ...]
    source: ReadablePdfSource
    cancel_event: CancellationEvent | None


class _ManualService:
    def __init__(
        self,
        events: list[str],
        result: object,
    ) -> None:
        self._events = events
        self._result = result
        self.calls: list[_ManualCall] = []

    def accept_manual_pdf(
        self,
        *,
        expected_facts: AcquisitionExpectedFacts,
        current_assets: tuple[LiteratureAsset, ...],
        source: ReadablePdfSource,
        cancel_event: CancellationEvent | None = None,
    ) -> AcceptedManualPdf:
        self._events.append("manual")
        self.calls.append(
            _ManualCall(
                expected_facts=expected_facts,
                current_assets=current_assets,
                source=source,
                cancel_event=cancel_event,
            )
        )
        if isinstance(self._result, BaseException):
            raise self._result
        return cast(AcceptedManualPdf, self._result)


class _CancelEvent:
    def is_set(self) -> bool:
        return True


class ManualPdfEntryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.events: list[str] = []
        self.admission = _Admission(self.events)
        self.recovery = _Recovery(self.events)

    def _operation(
        self,
        reader: _FactsReader,
        service: _ManualService,
        *,
        cancel_event: CancellationEvent | None = None,
    ) -> ManualPdfOperation:
        return ManualPdfOperation(
            current_facts_reader=reader,
            manual_admission=service,
            write_admission=self.admission,
            recovery=self.recovery,
            cancel_event=cancel_event,
        )

    def _source(self) -> _CallerOwnedStream:
        source = _CallerOwnedStream()
        self.addCleanup(io.BytesIO.close, source)
        return source

    def test_success_builds_exact_cas_and_returns_finished_accepted_report(self) -> None:
        current = _current(exhausted=True)
        reader = _FactsReader(self.events, _snapshot(current))
        accepted = _accepted()
        service = _ManualService(self.events, accepted)
        source = self._source()

        operation = self._operation(reader, service)
        report = operation(_LITERATURE_ID, source)

        self.assertEqual(
            self.events,
            ["admission", "recovery", "read", "manual", "release"],
        )
        self.assertEqual(reader.calls, [_LITERATURE_ID])
        self.assertEqual(len(service.calls), 1)
        call = service.calls[0]
        self.assertEqual(
            call.expected_facts,
            AcquisitionExpectedFacts(
                literature_id=_LITERATURE_ID,
                meta_literature_id=_META_LITERATURE_ID,
                metadata_revision=7,
                metadata_sha256=metadata_sha256(current.current.literature.metadata),
                expected_no_primary_pdf=True,
            ),
        )
        self.assertEqual(call.current_assets, ())
        self.assertIs(call.source, source)
        self.assertIsNone(call.cancel_event)
        self.assertFalse(source.closed)
        self.assertEqual(source.close_calls, 0)
        self.assertEqual(source.tell(), 0)
        self.assertEqual(
            report,
            ManualPdfReport(
                kind="manual-pdf",
                end=FinishedReportEnd(kind="finished"),
                literature_id=_LITERATURE_ID,
                result=AcceptedManualPdfReportResult(
                    kind="accepted",
                    accepted=accepted,
                ),
            ),
        )
        self.assertEqual(report.result.kind if report.result is not None else None, "accepted")
        rendered = f"{operation!r} {report!r} {report.model_dump_json()}"
        self.assertNotIn(_PRIVATE_PATH, rendered)
        self.assertNotIn(_PRIVATE_BYTES.decode(), rendered)

    def test_existing_primary_is_delegated_as_finished_normal_rejection(self) -> None:
        current = _current(primary=True)
        reader = _FactsReader(self.events, _snapshot(current))
        failure = _failure("manual-pdf-target-has-primary")
        service = _ManualService(self.events, ManualPdfInputError(failure))
        source = self._source()

        report = self._operation(reader, service)(_LITERATURE_ID, source)

        self.assertEqual(len(service.calls), 1)
        self.assertEqual(
            service.calls[0].current_assets,
            tuple(item.relation for item in current.current.current_primary_pdfs),
        )
        self.assertIsInstance(report.end, FinishedReportEnd)
        self.assertEqual(
            report.result,
            RejectedManualPdfReportResult(kind="rejected", failure=failure),
        )
        self.assertFalse(source.closed)
        self.assertEqual(source.tell(), 0)

    def test_invalid_pdf_bytes_are_a_finished_rejection_and_stream_remains_owned(self) -> None:
        current = _current()
        reader = _FactsReader(self.events, _snapshot(current))
        failure = _failure(
            "manual-pdf-invalid",
            reason="The supplied input is not a readable supported PDF.",
            action="Provide a readable PDF with at least one accessible page.",
        )
        service = _ManualService(self.events, ManualPdfInputError(failure))
        source = self._source()

        report = self._operation(reader, service)(_LITERATURE_ID, source)

        self.assertIsInstance(report.end, FinishedReportEnd)
        self.assertEqual(
            report.result,
            RejectedManualPdfReportResult(kind="rejected", failure=failure),
        )
        self.assertFalse(source.closed)
        self.assertEqual(source.close_calls, 0)
        self.assertEqual(source.tell(), 0)

    def test_unknown_literature_is_rejected_without_calling_acquisition(self) -> None:
        reader = _FactsReader(self.events, _snapshot())
        service = _ManualService(self.events, _accepted())
        source = self._source()

        report = self._operation(reader, service)(_LITERATURE_ID, source)

        self.assertEqual(self.events, ["admission", "recovery", "read", "release"])
        self.assertEqual(service.calls, [])
        self.assertIsInstance(report.end, FinishedReportEnd)
        self.assertIsInstance(report.result, RejectedManualPdfReportResult)
        rejected = cast(RejectedManualPdfReportResult, report.result)
        self.assertEqual(rejected.failure.code, "manual-pdf-literature-not-found")
        self.assertFalse(rejected.failure.retryable)
        self.assertFalse(source.closed)

    def test_stale_and_publication_failures_return_failed_redacted_reports(self) -> None:
        publication_failure = _failure(
            "fixture-publication-stale",
            reason="The Literature facts changed before publication.",
            action="Refresh the Literature and retry.",
            retryable=True,
        )
        cases: tuple[tuple[str, BaseException, str], ...] = (
            (
                "typed-publication",
                AcquisitionFailure(publication_failure),
                publication_failure.code,
            ),
            (
                "raw-stale-component",
                StalePreconditionError(
                    f"stale at {_PRIVATE_PATH} bytes={_PRIVATE_BYTES!r} token=runtime-secret"
                ),
                "manual-pdf-operation-failed",
            ),
        )
        for name, error, expected_code in cases:
            with self.subTest(name=name):
                events: list[str] = []
                reader = _FactsReader(events, _snapshot(_current()))
                service = _ManualService(events, error)
                operation = ManualPdfOperation(
                    current_facts_reader=reader,
                    manual_admission=service,
                    write_admission=_Admission(events),
                    recovery=_Recovery(events),
                )
                source = _CallerOwnedStream()
                self.addCleanup(io.BytesIO.close, source)

                report = operation(_LITERATURE_ID, source)

                self.assertIsInstance(report.end, FailedReportEnd)
                self.assertIsNone(report.result)
                failed_end = cast(FailedReportEnd, report.end)
                self.assertEqual(failed_end.failure.code, expected_code)
                rendered = report.model_dump_json() + repr(report)
                self.assertNotIn(_PRIVATE_PATH, rendered)
                self.assertNotIn(_PRIVATE_BYTES.decode(), rendered)
                self.assertNotIn("runtime-secret", rendered)
                self.assertFalse(source.closed)

    def test_reader_and_snapshot_component_failures_are_failed_not_rejected(self) -> None:
        cases: tuple[tuple[str, CurrentFactsSnapshot | BaseException, str], ...] = (
            (
                "reader",
                RuntimeError(
                    f"catalog failed at {_PRIVATE_PATH} bytes={_PRIVATE_BYTES!r} token=secret"
                ),
                "manual-pdf-operation-failed",
            ),
            (
                "mismatched-facts",
                _snapshot(_current(literature_id=_OTHER_LITERATURE_ID)),
                "manual-pdf-current-facts-contract",
            ),
        )
        for name, reader_result, expected_code in cases:
            with self.subTest(name=name):
                events: list[str] = []
                reader = _FactsReader(events, reader_result)
                service = _ManualService(events, _accepted())
                operation = ManualPdfOperation(
                    current_facts_reader=reader,
                    manual_admission=service,
                    write_admission=_Admission(events),
                    recovery=_Recovery(events),
                )
                source = _CallerOwnedStream()
                self.addCleanup(io.BytesIO.close, source)

                report = operation(_LITERATURE_ID, source)

                self.assertIsInstance(report.end, FailedReportEnd)
                self.assertIsNone(report.result)
                failed_end = cast(FailedReportEnd, report.end)
                self.assertEqual(failed_end.failure.code, expected_code)
                self.assertEqual(service.calls, [])
                rendered = report.model_dump_json() + repr(report)
                self.assertNotIn(_PRIVATE_PATH, rendered)
                self.assertNotIn(_PRIVATE_BYTES.decode(), rendered)
                self.assertNotIn("token=secret", rendered)
                self.assertFalse(source.closed)

    def test_controlled_pdf_cancellation_returns_interrupted_report(self) -> None:
        event = _CancelEvent()
        reader = _FactsReader(self.events, _snapshot(_current()))
        service = _ManualService(self.events, PdfValidationCancelled())
        source = self._source()

        report = self._operation(
            reader,
            service,
            cancel_event=event,
        )(_LITERATURE_ID, source)

        self.assertIsInstance(report.end, InterruptedReportEnd)
        self.assertIsNone(report.result)
        self.assertIs(service.calls[0].cancel_event, event)
        self.assertFalse(source.closed)

    def test_programming_and_process_control_exceptions_are_not_reported_as_rejections(
        self,
    ) -> None:
        cases: tuple[tuple[str, BaseException], ...] = (
            ("type", TypeError("fixture programming error")),
            ("assertion", AssertionError("fixture invariant error")),
            ("system-exit", SystemExit(7)),
            ("generator-exit", GeneratorExit()),
        )
        for name, error in cases:
            with self.subTest(name=name):
                events: list[str] = []
                operation = ManualPdfOperation(
                    current_facts_reader=_FactsReader(events, _snapshot(_current())),
                    manual_admission=_ManualService(events, error),
                    write_admission=_Admission(events),
                    recovery=_Recovery(events),
                )
                source = _CallerOwnedStream()
                self.addCleanup(io.BytesIO.close, source)

                with self.assertRaises(type(error)):
                    operation(_LITERATURE_ID, source)

                self.assertFalse(source.closed)
                self.assertEqual(events[-1], "release")

    def test_callable_and_source_have_no_path_or_downstream_processing_surface(self) -> None:
        operation = self._operation(
            _FactsReader(self.events, _snapshot(_current())),
            _ManualService(self.events, _accepted()),
        )
        signature = inspect.signature(operation)
        self.assertEqual(tuple(signature.parameters), ("literature_id", "source"))
        self.assertTrue(
            all(
                parameter.kind is inspect.Parameter.POSITIONAL_OR_KEYWORD
                for parameter in signature.parameters.values()
            )
        )
        self.assertEqual(manual_entry_module.__all__, ("ManualPdfOperation",))

        source_path = ROOT / "src/sciretriever/entry/manual.py"
        source = source_path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=source_path.as_posix())
        imported_modules = {
            node.module
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module is not None
        }
        self.assertFalse(
            any(
                module.startswith(
                    (
                        "sciretriever.parsing",
                        "sciretriever.analysis",
                        "sciretriever.storage",
                        "sciretriever.network",
                    )
                )
                for module in imported_modules
            )
        )
        self.assertNotIn("sciretriever.model.discovery", imported_modules)
        self.assertFalse(
            any(isinstance(node, ast.Name) and node.id == "DiscoveryRun" for node in ast.walk(tree))
        )
        for forbidden in (
            "PdfCandidate",
            "AcquisitionPath",
            "Parser",
            "Analysis",
            "sqlite3",
            "pathlib",
            "source_url",
        ):
            self.assertNotIn(forbidden, source)
        accessed_attributes = {
            node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)
        }
        self.assertTrue(
            {
                "name",
                "fileno",
                "close",
                "seek",
                "write",
                "unlink",
                "rename",
                "replace",
            }.isdisjoint(accessed_attributes)
        )


if __name__ == "__main__":
    unittest.main()
