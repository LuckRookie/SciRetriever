from __future__ import annotations

import dataclasses
import io
import threading
import unittest
from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor
from contextlib import AbstractContextManager, contextmanager
from dataclasses import replace
from types import TracebackType
from unittest.mock import patch

from sciretriever.acquisition.api import (
    CohortPreparationItem,
    PreparedAcquisition,
    PreparedAcquisitionCohort,
)
from sciretriever.acquisition.browser_admission import BrowserEscalationSummary
from sciretriever.acquisition.cohort import WorkItemDisposition
from sciretriever.acquisition.ports import AcquisitionExpectedFacts, AcquisitionFailure
from sciretriever.acquisition.routing import AcquisitionRequest
from sciretriever.analysis.content import ContentAnalysisFailure, ContentAnalysisInput
from sciretriever.entry.completion import (
    AssetDatabaseCompletionOperation,
    DatabaseCompletionOperation,
    _CompletionScheduler,  # pyright: ignore[reportPrivateUsage]
)
from sciretriever.entry.orchestration import CompletionStageFailure, TargetOrchestrationResult
from sciretriever.entry.ports import (
    CurrentFactsSnapshot,
    ExecutionCurrentFacts,
    LiteratureSelectorSnapshot,
    MetaSelectorSnapshot,
    NoUsableContentCleanupCommand,
    NoUsableContentCleanupFailure,
    NoUsableContentCleanupResult,
    WriteAdmissionFailure,
)
from sciretriever.literature.content import (
    ContentAcceptanceDecision,
    ContentAcceptanceReplacement,
    metadata_sha256,
)
from sciretriever.literature.ports import StalePreconditionError
from sciretriever.literature.state import (
    CurrentContentLineage,
    CurrentLiteratureFacts,
    CurrentPrimaryPdf,
)
from sciretriever.model.acquisition import (
    AcquiredPrimaryPdf,
    Asset,
    AssetRole,
    AutomaticPdfAcquisitionExhaustion,
    LiteratureAsset,
    NoPrimaryPdf,
)
from sciretriever.model.analysis import (
    ArtifactRef,
    LiteratureContent,
    LiteratureContentProposal,
    LiteratureSection,
    LiteratureSectionRole,
    NoUsableContent,
    analysis_input_sha256,
    content_sha256,
)
from sciretriever.model.execution import (
    AllPendingSelector,
    BatchGoal,
    BatchRequest,
    DiscoveryRunSelector,
    ImportReportSelector,
    LiteratureSelector,
    MetaLiteratureSelector,
    QuerySelector,
)
from sciretriever.model.library import LibraryQuery
from sciretriever.model.literature import Literature, LiteratureStatus, MetaLiterature, VersionRole
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.parsing import (
    ParserArtifactRef,
    ParserProvenance,
    ParserRequest,
    ParserResult,
    parser_result_sha256,
)
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
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import (
    DatabaseCompletionReport,
    FailedReportEnd,
    NotStartedCompletionTarget,
    StableFailure,
)
from sciretriever.parsing.api import PreparedParsing
from sciretriever.parsing.ports import ParsingFailure

_TIME = UtcTimestamp("2026-08-12T13:00:00Z")
_PARAMETERS_HASH = Sha256("f" * 64)
_EVENT_TIMEOUT = 5.0


def _uuid(prefix: int, index: int) -> str:
    return f"{prefix:08x}-0000-4000-8000-{index:012x}"


def _literature_id(index: int) -> LiteratureId:
    return LiteratureId(_uuid(1, index))


def _meta_id(index: int) -> MetaLiteratureId:
    return MetaLiteratureId(_uuid(2, index))


def _asset_id(index: int, generation: int = 1) -> AssetId:
    return AssetId(_uuid(3 + generation, index))


def _failure(code: str, *, retryable: bool = True) -> StableFailure:
    return StableFailure(
        code=code,
        reason="The offline completion fixture stopped this stage.",
        action="Refresh the fixture facts and retry this target.",
        retryable=retryable,
    )


def _provenance(
    index: int,
    *,
    source_kind: SourceKind,
    source_name: str,
    input_sha256: Sha256,
    parameters_sha256: Sha256 | None = None,
) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(_uuid(20 + index, index)),
        source_kind=source_kind,
        source_name=source_name,
        source_record_id=(f"record-{index}" if source_kind is SourceKind.ASSET_PROVIDER else None),
        observed_at=_TIME,
        input_sha256=input_sha256,
        parameters_sha256=parameters_sha256,
    )


def _metadata(index: int) -> LiteratureMetadata:
    return LiteratureMetadata(
        title=f"Completion fixture {index}",
        publication_year=2020 + index % 5,
        keywords=("completion",),
    )


def _asset(index: int, generation: int = 1) -> Asset:
    digest = sha256_digest(f"pdf-{index}-{generation}".encode())
    return Asset(
        asset_id=_asset_id(index, generation),
        sha256=digest,
        size_bytes=100 + generation,
        media_type="application/pdf",
        path=RelativeArtifactPath(f"objects/pdf-{index}-{generation}.pdf"),
    )


def _primary(
    index: int,
    *,
    generation: int = 1,
    source_kind: SourceKind = SourceKind.ASSET_PROVIDER,
) -> CurrentPrimaryPdf:
    asset = _asset(index, generation)
    source_name = "manual-pdf" if source_kind is SourceKind.USER else "offline-source"
    relation = LiteratureAsset(
        literature_asset_id=LiteratureAssetId(_uuid(8 + generation, index)),
        literature_id=_literature_id(index),
        asset_id=asset.asset_id,
        role=AssetRole.PRIMARY_PDF,
        provenance=_provenance(
            100 + index + generation,
            source_kind=source_kind,
            source_name=source_name,
            input_sha256=asset.sha256,
        ),
        source_url=(None if source_kind is SourceKind.USER else "https://offline.test/pdf"),
    )
    return CurrentPrimaryPdf(asset=asset, relation=relation)


def _parser_result(primary: CurrentPrimaryPdf, index: int) -> ParserResult:
    markdown = ParserArtifactRef(
        sha256=sha256_digest(f"parser-markdown-{index}".encode()),
        media_type="text/markdown",
        byte_size=32,
    )
    provenance = ParserProvenance(
        provenance=_provenance(
            200 + index,
            source_kind=SourceKind.PARSER,
            source_name="offline-parser",
            input_sha256=primary.asset.sha256,
            parameters_sha256=_PARAMETERS_HASH,
        ),
        parser_version="1",
    )
    result_hash = parser_result_sha256(
        source_asset_id=primary.asset.asset_id,
        source_sha256=primary.asset.sha256,
        page_count=1,
        markdown=markdown,
        resources=(),
        provenance=provenance,
    )
    return ParserResult(
        source_asset_id=primary.asset.asset_id,
        source_sha256=primary.asset.sha256,
        page_count=1,
        markdown=markdown,
        result_sha256=result_hash,
        provenance=provenance,
    )


def _sections() -> tuple[LiteratureSection, ...]:
    return tuple(
        LiteratureSection(role=role, markdown="fixture", subsections=())
        for role in (
            LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
            LiteratureSectionRole.METHODS,
            LiteratureSectionRole.DATA,
            LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
        )
    )


def _proposal(current: ExecutionCurrentFacts) -> LiteratureContentProposal:
    facts = current.current
    primary = facts.current_primary_pdfs[0]
    parser = facts.current_parser_result
    assert parser is not None
    final_metadata = facts.literature.metadata
    final_hash = metadata_sha256(final_metadata)
    sections = _sections()
    content_hash = content_sha256(
        metadata_sha256=final_hash,
        sections=sections,
        references=(),
    )
    return LiteratureContentProposal(
        literature_id=facts.literature.literature_id,
        primary_asset_id=primary.asset.asset_id,
        primary_pdf_sha256=primary.asset.sha256,
        parser_result_sha256=parser.result_sha256,
        input_metadata_revision=facts.metadata_revision,
        input_metadata_sha256=facts.metadata_sha256,
        final_metadata=final_metadata,
        metadata_sha256=final_hash,
        sections=sections,
        references=(),
        literature_content_sha256=content_hash,
        markdown=ArtifactRef(
            sha256=sha256_digest(f"final-{facts.literature.literature_id}".encode()),
            media_type="text/markdown",
            byte_size=64,
        ),
        provenance=_provenance(
            400 + int(facts.literature.literature_id.root[-2:], 16),
            source_kind=SourceKind.ANALYSIS,
            source_name="offline-analysis",
            input_sha256=analysis_input_sha256(
                primary.asset.sha256,
                parser.result_sha256,
                final_hash,
            ),
            parameters_sha256=_PARAMETERS_HASH,
        ),
    )


def _accepted_content(
    current: ExecutionCurrentFacts,
    proposal: LiteratureContentProposal,
) -> tuple[ContentAcceptanceDecision, ExecutionCurrentFacts]:
    facts = current.current
    revision = facts.metadata_revision + 1
    content = LiteratureContent(
        literature_content_sha256=proposal.literature_content_sha256,
        metadata_revision=revision,
        metadata_sha256=proposal.metadata_sha256,
        sections=proposal.sections,
        references=proposal.references,
        markdown=proposal.markdown,
        provenance=proposal.provenance,
    )
    replacement = ContentAcceptanceReplacement(
        literature_id=proposal.literature_id,
        metadata=proposal.final_metadata,
        metadata_revision=revision,
        metadata_sha256=proposal.metadata_sha256,
        content=content,
    )
    primary = facts.current_primary_pdfs[0]
    parser = facts.current_parser_result
    assert parser is not None
    committed_literature = facts.literature.model_copy(
        update={
            "metadata": proposal.final_metadata,
            "status": LiteratureStatus.CONTENT_READY,
        }
    )
    committed = ExecutionCurrentFacts(
        current=CurrentLiteratureFacts(
            literature=committed_literature,
            metadata_revision=revision,
            metadata_sha256=proposal.metadata_sha256,
            current_primary_pdfs=(primary,),
            current_parser_result=parser,
            current_content=content,
            current_content_lineage=CurrentContentLineage(
                primary_asset_id=primary.asset.asset_id,
                primary_pdf_sha256=primary.asset.sha256,
                parser_result_sha256=parser.result_sha256,
            ),
        )
    )
    decision = ContentAcceptanceDecision(
        decision="accepted",
        literature_id=proposal.literature_id,
        status=LiteratureStatus.CONTENT_READY,
        replacement=replacement,
    )
    return decision, committed


def _current(
    index: int,
    meta_index: int,
    *,
    role: VersionRole = VersionRole.PUBLISHED,
    primary: bool = False,
    parsed: bool = False,
    exhausted: bool = False,
    manual: bool = False,
) -> ExecutionCurrentFacts:
    primary_value = (
        _primary(index, source_kind=SourceKind.USER if manual else SourceKind.ASSET_PROVIDER)
        if primary
        else None
    )
    parser = _parser_result(primary_value, index) if parsed and primary_value is not None else None
    status = (
        LiteratureStatus.ASSET_READY if primary_value is not None else LiteratureStatus.UNREVIEWED
    )
    metadata = _metadata(index)
    literature = Literature(
        literature_id=_literature_id(index),
        meta_literature_id=_meta_id(meta_index),
        version_role=role,
        metadata=metadata,
        status=status,
    )
    return ExecutionCurrentFacts(
        current=CurrentLiteratureFacts(
            literature=literature,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(metadata),
            current_primary_pdfs=(() if primary_value is None else (primary_value,)),
            current_parser_result=parser,
        ),
        automatic_pdf_exhaustion=(
            AutomaticPdfAcquisitionExhaustion(literature_id=literature.literature_id)
            if exhausted
            else None
        ),
    )


def _snapshot(values: tuple[ExecutionCurrentFacts, ...]) -> MetaSelectorSnapshot:
    meta_ids: list[MetaLiteratureId] = []
    for value in values:
        identity = value.current.literature.meta_literature_id
        if identity not in meta_ids:
            meta_ids.append(identity)
    metas = tuple(
        MetaLiterature(
            meta_literature_id=meta_id,
            representative_literature_id=next(
                value.current.literature.literature_id
                for value in values
                if value.current.literature.meta_literature_id == meta_id
            ),
        )
        for meta_id in meta_ids
    )
    return MetaSelectorSnapshot(
        meta_literature_ids=tuple(meta_ids),
        meta_literatures=metas,
        current_facts=values,
    )


class _Lease(AbstractContextManager[None]):
    def __init__(
        self,
        events: list[str],
        failure: BaseException | None = None,
    ) -> None:
        self.events = events
        self.failure = failure

    def __enter__(self) -> None:
        self.events.append("admission")
        if self.failure is not None:
            raise self.failure

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool:
        del exc_type, exc_value, traceback
        self.events.append("release")
        return False


class _Admission:
    def __init__(
        self,
        events: list[str],
        failure: BaseException | None = None,
    ) -> None:
        self.events = events
        self.failure = failure

    def acquire_nowait(self) -> AbstractContextManager[None]:
        return _Lease(self.events, self.failure)


class _Recovery:
    def __init__(self, events: list[str]) -> None:
        self.events = events

    def interrupt_visible_running(self) -> tuple[DiscoveryRunId, ...]:
        self.events.append("recovery")
        return ()


class _ContentRef:
    @contextmanager
    def open(self) -> Generator[io.BytesIO, None, None]:
        yield io.BytesIO(b"%PDF fixture")


class _World:
    def __init__(self, values: tuple[ExecutionCurrentFacts, ...]) -> None:
        self.lock = threading.Lock()
        self.values = {value.current.literature.literature_id: value for value in values}
        self.snapshot_values = values
        self.events: list[str] = []
        self.reads: list[LiteratureId] = []
        self.acquisition_calls: list[AcquisitionRequest] = []
        self.acquisition_cohort_calls: list[tuple[LiteratureId, ...]] = []
        self.parser_calls: list[ParserRequest] = []
        self.analysis_calls: list[LiteratureId] = []
        self.acceptance_calls: list[LiteratureId] = []
        self.cleanup_calls: list[NoUsableContentCleanupCommand] = []
        self.clear_calls: list[AcquisitionExpectedFacts] = []
        self.acquisition_commit_calls: list[PreparedAcquisition] = []
        self.acquisition_discard_calls: list[PreparedAcquisition] = []
        self.parser_commit_calls: list[PreparedParsing] = []
        self.parser_discard_calls: list[PreparedParsing] = []
        self.acquisition_plans: dict[LiteratureId, list[object]] = {}
        self.parser_plans: dict[LiteratureId, list[object]] = {}
        self.analysis_plans: dict[LiteratureId, list[object]] = {}
        self._prepared_acquisitions: dict[
            PreparedAcquisition,
            tuple[LiteratureId, NoPrimaryPdf | AcquiredPrimaryPdf],
        ] = {}
        self._prepared_parsing: dict[
            PreparedParsing,
            tuple[LiteratureId, ParserResult],
        ] = {}
        self.cleanup_failure: StableFailure | None = None
        self.active_writes = 0
        self.max_active_writes = 0
        self.active_external = 0
        self.max_active_external = 0
        self.prepare_barrier: threading.Barrier | None = None
        self.prepare_barrier_keys: set[tuple[str, LiteratureId]] = set()
        self.prepare_barriers: dict[tuple[str, LiteratureId], threading.Barrier] = {}
        self.prepare_wait_events: dict[tuple[str, LiteratureId], threading.Event] = {}
        self.analysis_barrier: threading.Barrier | None = None
        self.analysis_barrier_ids: set[LiteratureId] = set()
        self.analysis_barriers: dict[LiteratureId, threading.Barrier] = {}
        self.prepared_events: dict[tuple[str, LiteratureId], threading.Event] = {}
        self.prepare_return_events: dict[tuple[str, LiteratureId], threading.Event] = {}
        self.first_commit_entered: threading.Event | None = None
        self.release_first_commit: threading.Event | None = None
        self.block_first_commit = False
        self.commit_order: list[tuple[str, LiteratureId]] = []
        self.commit_thread_ids: set[int] = set()
        self.stage_events: list[tuple[str, LiteratureId]] = []
        self.parser_stale_on_prepare: set[LiteratureId] = set()
        self.stale_parser_results: dict[LiteratureId, ParserResult] = {}
        self.cancel_after_prepare: LiteratureId | None = None
        self.cancel_on_acquire: LiteratureId | None = None
        self.cancel_on_acquisition_failure: LiteratureId | None = None
        self.cancel_on_commit: tuple[str, LiteratureId] | None = None
        self.cancel_event: threading.Event | None = None
        self.acquisition_discard_failures: dict[LiteratureId, BaseException] = {}
        self.acquisition_cohort_identity_overrides: dict[LiteratureId, LiteratureId] = {}
        self.parser_discard_failures: dict[LiteratureId, BaseException] = {}
        self.current_read_failures: dict[LiteratureId, BaseException] = {}

    def read_selector(self, selector: object):  # noqa: ANN201
        self.events.append(f"selector:{getattr(selector, 'kind', '?')}")
        if isinstance(selector, LiteratureSelector):
            selected = tuple(self.values[item] for item in selector.literature_ids)
            return LiteratureSelectorSnapshot(
                literature_ids=selector.literature_ids,
                current_facts=selected,
            )
        current_values = tuple(
            self.values[value.current.literature.literature_id] for value in self.snapshot_values
        )
        return _snapshot(current_values)

    def read_current(self, literature_id: LiteratureId) -> CurrentFactsSnapshot:
        failure = self.current_read_failures.get(literature_id)
        if failure is not None:
            raise failure
        with self.lock:
            self.reads.append(literature_id)
            value = self.values[literature_id]
        return CurrentFactsSnapshot(literature_id=literature_id, current_facts=(value,))

    def build_acquisition_request(
        self,
        current: ExecutionCurrentFacts,
        *,
        excluded_candidate_keys: frozenset[str],
    ) -> AcquisitionRequest:
        facts = current.current
        return AcquisitionRequest(
            literature=facts.literature,
            expected_facts=AcquisitionExpectedFacts(
                literature_id=facts.literature.literature_id,
                meta_literature_id=facts.literature.meta_literature_id,
                metadata_revision=facts.metadata_revision,
                metadata_sha256=facts.metadata_sha256,
                expected_no_primary_pdf=True,
            ),
            excluded_candidate_keys=excluded_candidate_keys,
        )

    def prepare_primary_pdf(
        self,
        request: AcquisitionRequest,
        *,
        cancel_event: threading.Event | None = None,
    ) -> PreparedAcquisition:
        self._enter_external()
        try:
            with self.lock:
                self.acquisition_calls.append(request)
            literature_id = request.literature.literature_id
            self._wait_prepare_barrier("acquisition", literature_id)
            if literature_id == self.cancel_on_acquire and cancel_event is not None:
                cancel_event.set()
                raise KeyboardInterrupt()
            plan = self.acquisition_plans.get(literature_id, [])
            result = plan.pop(0) if plan else "acquire"
            if isinstance(result, BaseException):
                if literature_id == self.cancel_on_acquisition_failure and cancel_event is not None:
                    cancel_event.set()
                raise result
            if result == "exhaust":
                prepared_result: NoPrimaryPdf | AcquiredPrimaryPdf = NoPrimaryPdf()
            elif isinstance(result, str):
                generation = len(self.acquisition_calls) + 1
                primary = _primary(
                    int(literature_id.root[-2:], 16),
                    generation=generation,
                )
                prepared_result = AcquiredPrimaryPdf(
                    asset=primary.asset,
                    relation=primary.relation,
                    candidate_key=result,
                )
            else:
                raise AssertionError("invalid acquisition plan")
            with self.lock:
                prepared = PreparedAcquisition()
                self._prepared_acquisitions[prepared] = (literature_id, prepared_result)
                self.stage_events.append(("acquisition-prepared", literature_id))
            prepared_event = self.prepared_events.get(("acquisition", literature_id))
            if prepared_event is not None:
                prepared_event.set()
            if literature_id == self.cancel_after_prepare and cancel_event is not None:
                cancel_event.set()
            return_event = self.prepare_return_events.get(("acquisition", literature_id))
            if return_event is not None and not return_event.wait(_EVENT_TIMEOUT):
                raise AssertionError("prepare return event was not released")
            return prepared
        finally:
            self._leave_external()

    def prepare_primary_pdf_cohort(
        self,
        requests: tuple[AcquisitionRequest, ...],
        *,
        cancel_event: threading.Event | None = None,
    ) -> PreparedAcquisitionCohort:
        self.acquisition_cohort_calls.append(
            tuple(request.literature.literature_id for request in requests)
        )
        if not requests:
            return PreparedAcquisitionCohort(
                items=(),
                browser_escalation=BrowserEscalationSummary(),
            )
        with ThreadPoolExecutor(max_workers=len(requests)) as executor:
            futures = tuple(
                executor.submit(
                    self.prepare_primary_pdf,
                    request,
                    cancel_event=cancel_event,
                )
                for request in requests
            )
            prepared_or_errors: list[PreparedAcquisition | AcquisitionFailure] = []
            fatal: BaseException | None = None
            for future in futures:
                try:
                    prepared_or_errors.append(future.result())
                except AcquisitionFailure as error:
                    prepared_or_errors.append(error)
                except BaseException as error:
                    fatal = fatal or error
            if fatal is not None:
                for value in prepared_or_errors:
                    if isinstance(value, PreparedAcquisition):
                        self.discard_prepared(value)
                raise fatal
        items = []
        for request, value in zip(requests, prepared_or_errors, strict=True):
            literature_id = request.literature.literature_id
            reported_literature_id = self.acquisition_cohort_identity_overrides.get(
                literature_id,
                literature_id,
            )
            if isinstance(value, AcquisitionFailure):
                items.append(
                    CohortPreparationItem(
                        literature_id=reported_literature_id,
                        disposition=WorkItemDisposition.FAILED,
                        failure=value.failure,
                    )
                )
                continue
            with self.lock:
                _identity, result = self._prepared_acquisitions[value]
            items.append(
                CohortPreparationItem(
                    literature_id=reported_literature_id,
                    disposition=(
                        WorkItemDisposition.EXHAUSTED
                        if isinstance(result, NoPrimaryPdf)
                        else WorkItemDisposition.DELIVERED
                    ),
                    prepared=value,
                )
            )
        return PreparedAcquisitionCohort(
            items=tuple(items),
            browser_escalation=BrowserEscalationSummary(),
        )

    def commit_primary_pdf(self, prepared: PreparedAcquisition):  # noqa: ANN201
        self._enter_write()
        try:
            with self.lock:
                self.acquisition_commit_calls.append(prepared)
                literature_id, result = self._prepared_acquisitions.pop(prepared)
            self._on_commit("acquisition", literature_id)
            with self.lock:
                current = self.values[literature_id]
                if isinstance(result, NoPrimaryPdf):
                    self.values[literature_id] = replace(
                        current,
                        automatic_pdf_exhaustion=AutomaticPdfAcquisitionExhaustion(
                            literature_id=literature_id
                        ),
                    )
                else:
                    literature = current.current.literature.model_copy(
                        update={"status": LiteratureStatus.ASSET_READY}
                    )
                    primary = CurrentPrimaryPdf(asset=result.asset, relation=result.relation)
                    self.values[literature_id] = ExecutionCurrentFacts(
                        current=current.current.model_copy(
                            update={
                                "literature": literature,
                                "current_primary_pdfs": (primary,),
                            }
                        )
                    )
            return result
        finally:
            self._leave_write()

    def discard_prepared(
        self,
        prepared: PreparedAcquisition | PreparedParsing,
    ) -> None:
        with self.lock:
            if isinstance(prepared, PreparedAcquisition):
                self.acquisition_discard_calls.append(prepared)
                literature_id, _ = self._prepared_acquisitions[prepared]
                failure = self.acquisition_discard_failures.get(literature_id)
                if failure is not None:
                    raise failure
                self._prepared_acquisitions.pop(prepared, None)
            else:
                self.parser_discard_calls.append(prepared)
                literature_id, _ = self._prepared_parsing[prepared]
                failure = self.parser_discard_failures.get(literature_id)
                if failure is not None:
                    raise failure
                self._prepared_parsing.pop(prepared, None)

    def clear_exhaustion_for_explicit_retry(
        self,
        expected_facts: AcquisitionExpectedFacts,
    ) -> None:
        self._enter_write()
        try:
            self._on_commit("clear", expected_facts.literature_id)
            with self.lock:
                self.clear_calls.append(expected_facts)
                current = self.values[expected_facts.literature_id]
                self.values[expected_facts.literature_id] = replace(
                    current,
                    automatic_pdf_exhaustion=None,
                )
        finally:
            self._leave_write()

    def build_parser_request(self, current: ExecutionCurrentFacts) -> ParserRequest:
        primary = current.current.current_primary_pdfs[0]
        request = ParserRequest(
            source_asset_id=primary.asset.asset_id,
            source_sha256=primary.asset.sha256,
            media_type="application/pdf",
            content_ref=_ContentRef(),
        )
        return request

    def prepare_current_primary(
        self,
        request: ParserRequest,
        *,
        cancel_event: threading.Event | None = None,
    ) -> PreparedParsing:
        del cancel_event
        self._enter_external()
        try:
            with self.lock:
                self.parser_calls.append(request)
                literature_id = next(
                    identity
                    for identity, current in self.values.items()
                    if current.current.current_primary_pdfs
                    and current.current.current_primary_pdfs[0].asset.asset_id
                    == request.source_asset_id
                )
            self._wait_prepare_barrier("parsing", literature_id)
            plan = self.parser_plans.get(literature_id, [])
            result_or_error = plan.pop(0) if plan else None
            if isinstance(result_or_error, BaseException):
                raise result_or_error
            primary = self.values[literature_id].current.current_primary_pdfs[0]
            result = _parser_result(primary, int(literature_id.root[-2:], 16))
            with self.lock:
                prepared = PreparedParsing()
                self._prepared_parsing[prepared] = (literature_id, result)
                self.stage_events.append(("parsing-prepared", literature_id))
                if literature_id in self.parser_stale_on_prepare:
                    stale = _parser_result(
                        primary,
                        900 + int(literature_id.root[-2:], 16),
                    )
                    live = self.values[literature_id]
                    self.values[literature_id] = replace(
                        live,
                        current=live.current.model_copy(update={"current_parser_result": stale}),
                    )
                    self.stale_parser_results[literature_id] = stale
            prepared_event = self.prepared_events.get(("parsing", literature_id))
            if prepared_event is not None:
                prepared_event.set()
            return prepared
        finally:
            self._leave_external()

    def commit_current_primary(self, prepared: PreparedParsing) -> ParserResult:
        self._enter_write()
        try:
            with self.lock:
                self.parser_commit_calls.append(prepared)
                literature_id, result = self._prepared_parsing.pop(prepared)
            self._on_commit("parsing", literature_id)
            with self.lock:
                current = self.values[literature_id]
                if current.current.current_parser_result is not None:
                    raise StalePreconditionError()
                self.values[literature_id] = replace(
                    current,
                    current=current.current.model_copy(update={"current_parser_result": result}),
                )
            return result
        finally:
            self._leave_write()

    def build_content_analysis_input(
        self,
        current: ExecutionCurrentFacts,
    ) -> ContentAnalysisInput:
        facts = current.current
        primary = facts.current_primary_pdfs[0]
        parser = facts.current_parser_result
        assert parser is not None
        return ContentAnalysisInput(
            literature_id=facts.literature.literature_id,
            primary_asset_id=primary.asset.asset_id,
            primary_pdf_sha256=primary.asset.sha256,
            parser_result=parser,
            initial_metadata=facts.literature.metadata,
            input_metadata_revision=facts.metadata_revision,
            input_metadata_sha256=facts.metadata_sha256,
        )

    def analyze_content(
        self,
        analysis_input: ContentAnalysisInput,
        *,
        cancel_event: threading.Event | None = None,
    ) -> NoUsableContent | LiteratureContentProposal:
        del cancel_event
        self._enter_external()
        try:
            literature_id = analysis_input.literature_id
            with self.lock:
                self.analysis_calls.append(literature_id)
                self.stage_events.append(("analysis-metadata", literature_id))
            barrier = self.analysis_barriers.get(literature_id)
            if barrier is None and literature_id in self.analysis_barrier_ids:
                barrier = self.analysis_barrier
            if barrier is not None:
                barrier.wait(_EVENT_TIMEOUT)
            plan = self.analysis_plans.get(literature_id, [])
            result = plan.pop(0) if plan else "usable"
            if isinstance(result, BaseException):
                raise result
            if result == "no-content":
                return NoUsableContent(outcome="no_usable_content")
            proposal = _proposal(self.values[literature_id])
            with self.lock:
                self.stage_events.extend(
                    (
                        ("analysis-content", literature_id),
                        ("analysis-markdown", literature_id),
                    )
                )
            return proposal
        finally:
            self._leave_external()

    def accept_content(
        self,
        proposal: LiteratureContentProposal,
    ) -> ContentAcceptanceDecision:
        self._enter_write()
        try:
            literature_id = proposal.literature_id
            self._on_commit("acceptance", literature_id)
            decision, committed = _accepted_content(self.values[literature_id], proposal)
            with self.lock:
                self.acceptance_calls.append(literature_id)
                self.stage_events.append(("acceptance", literature_id))
                self.values[literature_id] = committed
            return decision
        finally:
            self._leave_write()

    def prepare_no_usable_content_cleanup(
        self,
        literature_id: LiteratureId,
        old_content_sha256: Sha256,
    ):  # noqa: ANN201
        del literature_id, old_content_sha256
        raise AssertionError("completion must not analyze an already content-ready Literature")

    def cleanup_no_usable_content(
        self,
        command: NoUsableContentCleanupCommand,
    ) -> NoUsableContentCleanupResult:
        self._enter_write()
        try:
            self._on_commit("cleanup", command.literature_id)
            with self.lock:
                self.cleanup_calls.append(command)
            if self.cleanup_failure is not None:
                raise NoUsableContentCleanupFailure(self.cleanup_failure)
            with self.lock:
                current = self.values[command.literature_id]
                facts = current.current
                primary = facts.current_primary_pdfs[0]
                parser = facts.current_parser_result
                if (
                    primary.asset != command.primary_asset
                    or primary.relation != command.primary_relation
                    or parser is None
                    or parser != command.parser_result
                ):
                    raise NoUsableContentCleanupFailure(_failure("cleanup-stale"))
                literature = facts.literature.model_copy(
                    update={"status": LiteratureStatus.UNREVIEWED}
                )
                self.values[command.literature_id] = ExecutionCurrentFacts(
                    current=CurrentLiteratureFacts(
                        literature=literature,
                        metadata_revision=facts.metadata_revision,
                        metadata_sha256=facts.metadata_sha256,
                    )
                )
            return NoUsableContentCleanupResult(
                literature_id=command.literature_id,
                primary_asset_id=command.primary_asset.asset_id,
            )
        finally:
            self._leave_write()

    def _enter_write(self) -> None:
        with self.lock:
            self.active_writes += 1
            self.max_active_writes = max(self.max_active_writes, self.active_writes)

    def _leave_write(self) -> None:
        with self.lock:
            self.active_writes -= 1

    def _enter_external(self) -> None:
        with self.lock:
            self.active_external += 1
            self.max_active_external = max(
                self.max_active_external,
                self.active_external,
            )

    def _leave_external(self) -> None:
        with self.lock:
            self.active_external -= 1

    def _on_commit(self, kind: str, literature_id: LiteratureId) -> None:
        with self.lock:
            first = not self.commit_order
            self.commit_order.append((kind, literature_id))
            self.commit_thread_ids.add(threading.get_ident())
            self.stage_events.append((f"{kind}-commit-entered", literature_id))
            if self.cancel_on_commit == (kind, literature_id) and self.cancel_event is not None:
                self.cancel_event.set()
        if first and self.block_first_commit:
            if self.first_commit_entered is not None:
                self.first_commit_entered.set()
            if self.release_first_commit is not None:
                self.release_first_commit.wait()

    def _wait_prepare_barrier(self, kind: str, literature_id: LiteratureId) -> None:
        key = (kind, literature_id)
        with self.lock:
            wait_event = self.prepare_wait_events.get(key)
            barrier = self.prepare_barriers.get(key)
            if barrier is None and key in self.prepare_barrier_keys:
                barrier = self.prepare_barrier
            self.prepare_barrier_keys.discard(key)
        if wait_event is not None:
            if not wait_event.wait(_EVENT_TIMEOUT):
                raise AssertionError("prepare wait event was not released")
        if barrier is not None:
            barrier.wait(_EVENT_TIMEOUT)


def _operation(
    world: _World,
    *,
    max_concurrency: int = 1,
    cancel_event: threading.Event | None = None,
    admission_failure: BaseException | None = None,
) -> DatabaseCompletionOperation:
    events = world.events
    world.cancel_event = cancel_event
    return DatabaseCompletionOperation(
        selector_reader=world,
        current_facts_reader=world,
        write_admission=_Admission(events, admission_failure),
        recovery=_Recovery(events),
        acquisition=world,
        acquisition_requests=world,
        parsing=world,
        parser_requests=world,
        analysis=world,
        analysis_inputs=world,
        literature=world,
        cleanup=world,
        max_concurrency=max_concurrency,
        cancel_event=cancel_event,
    )


def _asset_operation(
    world: _World,
    *,
    max_concurrency: int = 1,
    cancel_event: threading.Event | None = None,
) -> AssetDatabaseCompletionOperation:
    events = world.events
    world.cancel_event = cancel_event
    return AssetDatabaseCompletionOperation(
        selector_reader=world,
        current_facts_reader=world,
        write_admission=_Admission(events),
        recovery=_Recovery(events),
        acquisition=world,
        acquisition_requests=world,
        max_concurrency=max_concurrency,
        cancel_event=cancel_event,
    )


def _request(
    literature_ids: tuple[LiteratureId, ...],
    *,
    goal: BatchGoal = "ASSET_READY",
) -> BatchRequest:
    return BatchRequest(
        selector=LiteratureSelector(
            kind="literatures",
            literature_ids=literature_ids,
        ),
        goal=goal,
    )


def _run_in_thread(
    operation: DatabaseCompletionOperation,
    request: BatchRequest,
) -> tuple[threading.Thread, list[DatabaseCompletionReport | BaseException]]:
    results: list[DatabaseCompletionReport | BaseException] = []

    def run() -> None:
        try:
            results.append(operation(request))
        except BaseException as error:
            results.append(error)

    thread = threading.Thread(target=run, name="entry-completion-test")
    thread.start()
    return thread, results


def _join(
    thread: threading.Thread,
    results: list[DatabaseCompletionReport | BaseException],
) -> DatabaseCompletionReport:
    thread.join()
    if thread.is_alive():
        raise AssertionError("deterministic completion thread did not finish")
    if len(results) != 1:
        raise AssertionError("deterministic completion result was not singular")
    result = results[0]
    if isinstance(result, BaseException):
        raise result
    return result


class DatabaseCompletionTests(unittest.TestCase):
    def test_write_admission_failure_is_stable_and_prevents_selector_read(self) -> None:
        literature_id = _literature_id(1)
        world = _World((_current(1, 1),))
        failure = StableFailure(
            code="write-admission-failed",
            reason="The local write boundary was unavailable.",
            action="Retry the operation.",
            retryable=True,
        )

        report = _operation(
            world,
            admission_failure=WriteAdmissionFailure(failure),
        )(_request((literature_id,), goal="ASSET_READY"))

        end = report.end
        self.assertEqual(end.kind, "failed")
        if not isinstance(end, FailedReportEnd):
            self.fail("expected a failed Report end")
        self.assertEqual(end.failure, failure)
        self.assertEqual(report.not_started, ())
        self.assertEqual(world.reads, [])
        self.assertEqual(world.events, ["admission"])

    def test_asset_only_operation_needs_no_parser_analysis_or_content_dependencies(self) -> None:
        literature_id = _literature_id(1)
        world = _World((_current(1, 1),))
        world.acquisition_plans[literature_id] = ["asset-only"]

        report = _asset_operation(world)(_request((literature_id,), goal="ASSET_READY"))

        self.assertEqual(
            tuple(item.literature_id for item in report.goal_reached), (literature_id,)
        )
        self.assertEqual(world.parser_calls, [])
        self.assertEqual(world.analysis_calls, [])
        self.assertEqual(world.acceptance_calls, [])

    def test_asset_only_operation_rejects_content_goal_before_any_work(self) -> None:
        literature_id = _literature_id(1)
        world = _World((_current(1, 1),))
        operation = _asset_operation(world)

        with self.assertRaises(ValueError):
            operation(_request((literature_id,), goal="CONTENT_READY"))

        self.assertEqual(world.events, [])
        self.assertEqual(world.acquisition_calls, [])

    def test_cancel_between_submit_and_worker_start_is_not_started(self) -> None:
        literature_id = _literature_id(1)
        world = _World((_current(1, 1),))
        cancel_event = threading.Event()
        operation = _operation(world, cancel_event=cancel_event)
        worker_entered = threading.Event()
        release_worker = threading.Event()
        original = _CompletionScheduler._run_target

        def gated_run_target(
            scheduler: _CompletionScheduler,
            index: int,
        ) -> TargetOrchestrationResult | NotStartedCompletionTarget:
            worker_entered.set()
            if not release_worker.wait(_EVENT_TIMEOUT):
                raise AssertionError("worker-start gate was not released")
            return original(scheduler, index)

        with patch.object(_CompletionScheduler, "_run_target", gated_run_target):
            thread, results = _run_in_thread(
                operation,
                _request((literature_id,), goal="ASSET_READY"),
            )
            self.assertTrue(worker_entered.wait(_EVENT_TIMEOUT))
            cancel_event.set()
            release_worker.set()
            report = _join(thread, results)

        self.assertEqual(report.end.kind, "interrupted")
        self.assertEqual(report.interrupted, ())
        self.assertEqual(report.not_started[0].target.kind, "literature")
        self.assertEqual(getattr(report.not_started[0].target, "literature_id"), literature_id)
        self.assertEqual(world.reads, [])
        self.assertEqual(world.acquisition_calls, [])

    def test_internal_programming_errors_propagate_unchanged(self) -> None:
        for error_type in (RuntimeError, ValueError, AssertionError):
            with self.subTest(error_type=error_type.__name__):
                literature_id = _literature_id(1)
                world = _World((_current(1, 1),))
                bug = error_type("programming bug")
                world.acquisition_plans[literature_id] = [bug]

                with self.assertRaises(error_type) as raised:
                    _operation(world)(_request((literature_id,)))

                self.assertIs(raised.exception, bug)

    def test_current_facts_read_programming_errors_propagate_unchanged(self) -> None:
        for error_type in (RuntimeError, AssertionError):
            with self.subTest(error_type=error_type.__name__):
                literature_id = _literature_id(1)
                world = _World((_current(1, 1),))
                bug = error_type("current-facts programming bug")
                world.current_read_failures[literature_id] = bug

                with self.assertRaises(error_type) as raised:
                    _operation(world)(_request((literature_id,)))

                self.assertIs(raised.exception, bug)

    def test_cancel_after_prepare_reports_typed_discard_failure(self) -> None:
        literature_id = _literature_id(1)
        world = _World((_current(1, 1),))
        cancel_event = threading.Event()
        failure = AcquisitionFailure(_failure("acquisition-staging-cleanup-failed"))
        world.cancel_after_prepare = literature_id
        world.acquisition_discard_failures[literature_id] = failure

        report = _operation(world, cancel_event=cancel_event)(
            _request((literature_id,), goal="ASSET_READY")
        )

        self.assertEqual(report.end.kind, "finished")
        self.assertEqual(report.interrupted, ())
        self.assertEqual(report.failed[0].failure, failure.failure)
        self.assertEqual(world.acquisition_commit_calls, [])
        self.assertEqual(len(world.acquisition_discard_calls), 1)

    def test_typed_discard_cancellation_code_remains_a_cleanup_failure(self) -> None:
        literature_id = _literature_id(1)
        world = _World((_current(1, 1),))
        cancel_event = threading.Event()
        failure = AcquisitionFailure(_failure("acquisition-interrupted"))
        world.cancel_after_prepare = literature_id
        world.acquisition_discard_failures[literature_id] = failure

        report = _operation(world, cancel_event=cancel_event)(
            _request((literature_id,), goal="ASSET_READY")
        )

        self.assertEqual(report.interrupted, ())
        self.assertEqual(report.failed[0].failure, failure.failure)
        self.assertEqual(world.acquisition_commit_calls, [])

    def test_cancel_after_prepare_propagates_unknown_discard_error(self) -> None:
        literature_id = _literature_id(1)
        world = _World((_current(1, 1),))
        cancel_event = threading.Event()
        bug = AssertionError("discard programming bug")
        world.cancel_after_prepare = literature_id
        world.acquisition_discard_failures[literature_id] = bug

        with self.assertRaises(AssertionError) as raised:
            _operation(world, cancel_event=cancel_event)(
                _request((literature_id,), goal="ASSET_READY")
            )

        self.assertIs(raised.exception, bug)
        self.assertEqual(world.acquisition_commit_calls, [])
        self.assertEqual(len(world.acquisition_discard_calls), 1)

    def test_invalid_cohort_contract_surfaces_typed_receipt_cleanup_failure(self) -> None:
        literature_id = _literature_id(1)
        world = _World((_current(1, 1),))
        cleanup_failure = AcquisitionFailure(_failure("acquisition-staging-cleanup-failed"))
        world.acquisition_cohort_identity_overrides[literature_id] = _literature_id(2)
        world.acquisition_discard_failures[literature_id] = cleanup_failure

        report = _operation(world)(_request((literature_id,), goal="ASSET_READY"))

        self.assertEqual(report.end.kind, "finished")
        self.assertEqual(report.interrupted, ())
        self.assertEqual(report.failed[0].stage, "acquisition")
        self.assertEqual(report.failed[0].failure, cleanup_failure.failure)
        self.assertEqual(world.acquisition_commit_calls, [])
        self.assertEqual(len(world.acquisition_discard_calls), 1)

    def test_invalid_cohort_contract_propagates_unknown_receipt_cleanup_error(self) -> None:
        literature_id = _literature_id(1)
        world = _World((_current(1, 1),))
        bug = AssertionError("cohort receipt cleanup programming bug")
        world.acquisition_cohort_identity_overrides[literature_id] = _literature_id(2)
        world.acquisition_discard_failures[literature_id] = bug

        with self.assertRaises(AssertionError) as raised:
            _operation(world)(_request((literature_id,), goal="ASSET_READY"))

        self.assertIs(raised.exception, bug)
        self.assertEqual(world.acquisition_commit_calls, [])
        self.assertEqual(len(world.acquisition_discard_calls), 1)

    def test_queued_commit_not_started_reports_typed_parsing_discard_failure(self) -> None:
        first_id = _literature_id(1)
        second_id = _literature_id(2)
        world = _World(
            (
                _current(1, 1, primary=True),
                _current(2, 2, primary=True),
            )
        )
        cancel_event = threading.Event()
        cleanup_failure = _failure("parsing-staging-cleanup-failed")
        for literature_id in (first_id, second_id):
            world.parser_discard_failures[literature_id] = ParsingFailure(cleanup_failure)
            world.prepared_events[("parsing", literature_id)] = threading.Event()
        world.block_first_commit = True
        world.first_commit_entered = threading.Event()
        world.release_first_commit = threading.Event()

        thread, results = _run_in_thread(
            _operation(world, max_concurrency=2, cancel_event=cancel_event),
            _request((first_id, second_id), goal="CONTENT_READY"),
        )
        for literature_id in (first_id, second_id):
            self.assertTrue(world.prepared_events[("parsing", literature_id)].wait(_EVENT_TIMEOUT))
        self.assertTrue(world.first_commit_entered.wait(_EVENT_TIMEOUT))
        cancel_event.set()
        world.release_first_commit.set()
        report = _join(thread, results)

        self.assertEqual(report.end.kind, "interrupted")
        self.assertEqual(len(report.interrupted), 1)
        self.assertEqual(len(report.failed), 1)
        self.assertEqual(report.failed[0].stage, "parsing")
        self.assertEqual(report.failed[0].failure, cleanup_failure)
        self.assertEqual(len(world.parser_commit_calls), 1)
        self.assertEqual(len(world.parser_discard_calls), 1)

    def test_acquisition_prepare_overlaps_while_all_commits_are_serial(self) -> None:
        first_id = _literature_id(1)
        second_id = _literature_id(2)
        world = _World((_current(1, 1), _current(2, 2)))
        world.acquisition_plans[first_id] = ["first"]
        world.acquisition_plans[second_id] = ["second"]
        barrier_observations: list[tuple[int, int]] = []

        def observe_prepare_overlap() -> None:
            with world.lock:
                barrier_observations.append(
                    (len(world.acquisition_commit_calls), world.max_active_external)
                )

        world.prepare_barrier = threading.Barrier(2, action=observe_prepare_overlap)
        world.prepare_barrier_keys = {
            ("acquisition", first_id),
            ("acquisition", second_id),
        }
        world.block_first_commit = True
        world.first_commit_entered = threading.Event()
        world.release_first_commit = threading.Event()

        thread, results = _run_in_thread(
            _operation(world, max_concurrency=2),
            _request((first_id, second_id)),
        )
        self.assertTrue(world.first_commit_entered.wait(_EVENT_TIMEOUT))
        with world.lock:
            self.assertEqual(len(world.acquisition_commit_calls), 1)
            self.assertEqual(world.max_active_writes, 1)
        world.release_first_commit.set()
        report = _join(thread, results)

        self.assertEqual(barrier_observations, [(0, 2)])
        self.assertEqual(len(report.goal_reached), 2)
        self.assertEqual(len(world.acquisition_commit_calls), 2)
        self.assertEqual(world.max_active_external, 2)
        self.assertEqual(world.max_active_writes, 1)
        self.assertEqual(len(world.commit_thread_ids), 1)
        self.assertEqual(world.acquisition_cohort_calls, [(first_id, second_id)])

    def test_completion_chunks_and_fallbacks_form_deterministic_cohort_rounds(self) -> None:
        world = _World(
            (
                _current(1, 1),
                _current(2, 1),
                _current(3, 2),
                _current(4, 2),
            )
        )
        world.acquisition_plans[_literature_id(1)] = ["exhaust"]
        world.acquisition_plans[_literature_id(2)] = ["meta-one-fallback"]
        world.acquisition_plans[_literature_id(3)] = ["exhaust"]
        world.acquisition_plans[_literature_id(4)] = ["meta-two-fallback"]

        report = _operation(world, max_concurrency=2)(
            BatchRequest(
                selector=MetaLiteratureSelector(
                    kind="meta-literatures",
                    meta_literature_ids=(_meta_id(1), _meta_id(2)),
                ),
                goal="ASSET_READY",
            )
        )

        self.assertEqual(
            tuple(item.literature_id for item in report.goal_reached),
            (_literature_id(2), _literature_id(4)),
        )
        self.assertEqual(
            world.acquisition_cohort_calls,
            [
                (_literature_id(1), _literature_id(3)),
                (_literature_id(2), _literature_id(4)),
            ],
        )

        chunked = _World(tuple(_current(index, index) for index in range(1, 4)))
        chunked_report = _operation(chunked, max_concurrency=2)(
            _request(tuple(_literature_id(index) for index in range(1, 4)))
        )
        self.assertEqual(len(chunked_report.goal_reached), 3)
        self.assertEqual(
            chunked.acquisition_cohort_calls,
            [
                (_literature_id(1), _literature_id(2)),
                (_literature_id(3),),
            ],
        )

    def test_existing_pdf_target_finishes_content_while_peer_waits_for_cohort(self) -> None:
        missing_id = _literature_id(1)
        ready_id = _literature_id(2)
        world = _World(
            (
                _current(1, 1),
                _current(2, 2, primary=True, parsed=True),
            )
        )

        report = _operation(world, max_concurrency=2)(
            _request((missing_id, ready_id), goal="CONTENT_READY")
        )

        self.assertEqual(len(report.goal_reached), 2)
        self.assertEqual(world.acquisition_cohort_calls, [(missing_id,)])
        ready_acceptance = world.stage_events.index(("acceptance", ready_id))
        missing_prepare = world.stage_events.index(("acquisition-prepared", missing_id))
        self.assertLess(ready_acceptance, missing_prepare)

    def test_no_usable_content_retries_rejoin_one_operation_cohort(self) -> None:
        first_id = _literature_id(1)
        second_id = _literature_id(2)
        world = _World(
            (
                _current(1, 1, primary=True, parsed=True),
                _current(2, 2, primary=True, parsed=True),
            )
        )
        world.analysis_plans[first_id] = ["no-content"]
        world.analysis_plans[second_id] = ["no-content"]

        report = _operation(world, max_concurrency=2)(
            _request((first_id, second_id), goal="CONTENT_READY")
        )

        self.assertEqual(len(report.goal_reached), 2)
        self.assertEqual(
            report.no_usable_content_literature_ids,
            (first_id, second_id),
        )
        self.assertEqual(world.acquisition_cohort_calls, [(first_id, second_id)])
        for request in world.acquisition_calls:
            self.assertEqual(request.excluded_candidate_keys, frozenset())

    def test_parsing_prepare_overlaps_and_one_final_cas_stale_isolated(self) -> None:
        stale_id = _literature_id(1)
        successful_id = _literature_id(2)
        stale_initial = _current(1, 1, primary=True)
        successful_initial = _current(2, 2, primary=True)
        world = _World((stale_initial, successful_initial))
        barrier_observations: list[tuple[int, int]] = []

        def observe_prepare_overlap() -> None:
            with world.lock:
                barrier_observations.append(
                    (len(world.parser_commit_calls), world.max_active_external)
                )

        world.prepare_barrier = threading.Barrier(2, action=observe_prepare_overlap)
        world.prepare_barrier_keys = {
            ("parsing", stale_id),
            ("parsing", successful_id),
        }
        world.parser_stale_on_prepare.add(stale_id)
        world.block_first_commit = True
        world.first_commit_entered = threading.Event()
        world.release_first_commit = threading.Event()

        thread, results = _run_in_thread(
            _operation(world, max_concurrency=2),
            _request((stale_id, successful_id), goal="CONTENT_READY"),
        )
        self.assertTrue(world.first_commit_entered.wait(_EVENT_TIMEOUT))
        with world.lock:
            self.assertEqual(len(world.parser_commit_calls), 1)
            self.assertEqual(world.max_active_writes, 1)
        world.release_first_commit.set()
        report = _join(thread, results)

        self.assertEqual(barrier_observations, [(0, 2)])
        self.assertEqual(report.failed[0].literature_id, stale_id)
        self.assertEqual(report.failed[0].stage, "parsing")
        self.assertEqual(report.failed[0].failure.code, "completion-current-facts-stale")
        self.assertEqual(report.goal_reached[0].literature_id, successful_id)
        self.assertEqual(len(world.parser_commit_calls), 2)
        stale_facts = world.values[stale_id].current
        self.assertEqual(
            stale_facts.current_primary_pdfs,
            stale_initial.current.current_primary_pdfs,
        )
        self.assertEqual(
            stale_facts.current_parser_result,
            world.stale_parser_results[stale_id],
        )
        self.assertEqual(world.max_active_external, 2)
        self.assertEqual(world.max_active_writes, 1)
        self.assertEqual(len(world.commit_thread_ids), 1)

    def test_analysis_overlaps_but_each_analysis_precedes_serial_acceptance(self) -> None:
        first_id = _literature_id(1)
        second_id = _literature_id(2)
        world = _World(
            (
                _current(1, 1, primary=True, parsed=True),
                _current(2, 2, primary=True, parsed=True),
            )
        )
        analysis_observations: list[tuple[int, int]] = []

        def observe_analysis_overlap() -> None:
            with world.lock:
                analysis_observations.append(
                    (len(world.acceptance_calls), world.max_active_external)
                )

        world.analysis_barrier = threading.Barrier(2, action=observe_analysis_overlap)
        world.analysis_barrier_ids = {first_id, second_id}
        world.block_first_commit = True
        world.first_commit_entered = threading.Event()
        world.release_first_commit = threading.Event()

        thread, results = _run_in_thread(
            _operation(world, max_concurrency=2),
            _request((first_id, second_id), goal="CONTENT_READY"),
        )
        self.assertTrue(world.first_commit_entered.wait(_EVENT_TIMEOUT))
        with world.lock:
            self.assertEqual(len(world.acceptance_calls), 0)
            self.assertEqual(len(world.commit_order), 1)
            self.assertEqual(world.max_active_writes, 1)
        world.release_first_commit.set()
        report = _join(thread, results)

        self.assertEqual(analysis_observations, [(0, 2)])
        self.assertEqual(len(report.goal_reached), 2)
        self.assertEqual(world.max_active_external, 2)
        self.assertEqual(world.max_active_writes, 1)
        self.assertEqual(len(world.commit_thread_ids), 1)
        for literature_id in (first_id, second_id):
            metadata_index = world.stage_events.index(("analysis-metadata", literature_id))
            content_index = world.stage_events.index(("analysis-content", literature_id))
            markdown_index = world.stage_events.index(("analysis-markdown", literature_id))
            acceptance_index = world.stage_events.index(("acceptance", literature_id))
            self.assertLess(metadata_index, content_index)
            self.assertLess(content_index, markdown_index)
            self.assertLess(markdown_index, acceptance_index)

    def test_mixed_commit_types_share_one_operation_queue(self) -> None:
        acquisition_id = _literature_id(1)
        parsing_id = _literature_id(2)
        cleanup_id = _literature_id(3)
        acceptance_id = _literature_id(4)
        world = _World(
            (
                _current(1, 1),
                _current(2, 2, primary=True),
                _current(3, 3, primary=True, parsed=True),
                _current(4, 4, primary=True, parsed=True),
            )
        )
        world.acquisition_plans[acquisition_id] = ["acquired"]
        world.analysis_plans[acquisition_id] = [ContentAnalysisFailure(_failure("stop-after-pdf"))]
        world.analysis_plans[parsing_id] = [ContentAnalysisFailure(_failure("stop-after-parser"))]
        world.analysis_plans[cleanup_id] = ["no-content"]
        world.acquisition_plans[cleanup_id] = [AcquisitionFailure(_failure("stop-after-cleanup"))]
        report = _operation(world, max_concurrency=4)(
            _request(
                (acquisition_id, parsing_id, cleanup_id, acceptance_id),
                goal="CONTENT_READY",
            )
        )

        self.assertEqual(report.goal_reached[0].literature_id, acceptance_id)
        self.assertEqual(
            {kind for kind, _ in world.commit_order},
            {"acquisition", "parsing", "cleanup", "acceptance"},
        )
        self.assertEqual(world.max_active_writes, 1)
        self.assertEqual(len(world.commit_thread_ids), 1)
        self.assertEqual(report.no_usable_content_literature_ids, (cleanup_id,))

    def test_all_six_selectors_expand_once_and_freeze_new_members_out(self) -> None:
        for selector in (
            AllPendingSelector(kind="all-pending"),
            DiscoveryRunSelector(
                kind="discovery-run",
                discovery_run_id=DiscoveryRunId(_uuid(50, 1)),
            ),
            ImportReportSelector(kind="import-report", meta_literature_ids=(_meta_id(1),)),
            QuerySelector(kind="query", query=LibraryQuery(text="fixture")),
            MetaLiteratureSelector(kind="meta-literatures", meta_literature_ids=(_meta_id(1),)),
            LiteratureSelector(kind="literatures", literature_ids=(_literature_id(1),)),
        ):
            with self.subTest(selector=selector.kind):
                world = _World((_current(1, 1),))
                world.acquisition_plans[_literature_id(1)] = ["candidate-1"]
                report = _operation(world)(BatchRequest(selector=selector, goal="ASSET_READY"))
                self.assertEqual(report.end.kind, "finished")
                self.assertEqual(len(report.goal_reached), 1)
                self.assertEqual(
                    sum(
                        len(partition)
                        for partition in (
                            report.goal_reached,
                            report.needs_manual_pdf,
                            report.failed,
                            report.interrupted,
                            report.not_started,
                        )
                    ),
                    1,
                )
                self.assertEqual(
                    sum(event.startswith("selector:") for event in world.events),
                    1,
                )

    def test_first_missing_step_reuses_pdf_and_parser_and_asset_goal_stops_early(self) -> None:
        asset_world = _World((_current(1, 1),))
        asset_world.acquisition_plans[_literature_id(1)] = ["asset-only"]
        asset_report = _operation(asset_world)(
            BatchRequest(
                selector=LiteratureSelector(
                    kind="literatures",
                    literature_ids=(_literature_id(1),),
                ),
                goal="ASSET_READY",
            )
        )
        self.assertEqual(asset_report.goal_reached[0].literature_id, _literature_id(1))
        self.assertEqual(len(asset_world.acquisition_calls), 1)
        self.assertEqual(asset_world.parser_calls, [])
        self.assertEqual(asset_world.analysis_calls, [])

        pdf_world = _World((_current(3, 3, primary=True),))
        pdf_report = _operation(pdf_world)(
            BatchRequest(
                selector=LiteratureSelector(
                    kind="literatures",
                    literature_ids=(_literature_id(3),),
                ),
                goal="CONTENT_READY",
            )
        )
        self.assertEqual(pdf_report.goal_reached[0].literature_id, _literature_id(3))
        self.assertEqual(pdf_world.acquisition_calls, [])
        self.assertEqual(len(pdf_world.parser_calls), 1)

        parsed_world = _World((_current(2, 2, primary=True, parsed=True),))
        parsed_report = _operation(parsed_world)(
            BatchRequest(
                selector=LiteratureSelector(
                    kind="literatures",
                    literature_ids=(_literature_id(2),),
                ),
                goal="CONTENT_READY",
            )
        )
        self.assertEqual(parsed_report.goal_reached[0].literature_id, _literature_id(2))
        self.assertEqual(parsed_world.acquisition_calls, [])
        self.assertEqual(parsed_world.parser_calls, [])
        self.assertEqual(parsed_world.analysis_calls, [_literature_id(2)])

    def test_meta_orders_progress_and_falls_back_only_after_typed_exhaustion(self) -> None:
        first = _current(1, 1, role=VersionRole.OTHER, primary=True)
        published = _current(2, 1, role=VersionRole.PUBLISHED)
        world = _World((published, first))
        world.analysis_plans[_literature_id(1)] = [ContentAnalysisFailure(_failure("llm-timeout"))]
        report = _operation(world)(
            BatchRequest(
                selector=MetaLiteratureSelector(
                    kind="meta-literatures",
                    meta_literature_ids=(_meta_id(1),),
                ),
                goal="CONTENT_READY",
            )
        )
        self.assertEqual(report.failed[0].literature_id, _literature_id(1))
        self.assertEqual(world.acquisition_calls, [])

        world = _World((_current(1, 1), _current(2, 1)))
        world.acquisition_plans[_literature_id(1)] = ["exhaust"]
        world.acquisition_plans[_literature_id(2)] = ["fallback-candidate"]
        report = _operation(world)(
            BatchRequest(
                selector=MetaLiteratureSelector(
                    kind="meta-literatures",
                    meta_literature_ids=(_meta_id(1),),
                ),
                goal="ASSET_READY",
            )
        )
        self.assertEqual(report.goal_reached[0].literature_id, _literature_id(2))
        self.assertEqual(
            tuple(request.literature.literature_id for request in world.acquisition_calls),
            (_literature_id(1), _literature_id(2)),
        )

    def test_explicit_retry_clears_exhaustion_but_wide_scope_does_not(self) -> None:
        explicit = _World((_current(1, 1, exhausted=True),))
        explicit.acquisition_plans[_literature_id(1)] = ["retried"]
        report = _operation(explicit)(
            BatchRequest(
                selector=LiteratureSelector(
                    kind="literatures",
                    literature_ids=(_literature_id(1),),
                ),
                goal="ASSET_READY",
            )
        )
        self.assertEqual(len(explicit.clear_calls), 1)
        self.assertEqual(len(report.goal_reached), 1)

        wide = _World((_current(1, 1, exhausted=True),))
        report = _operation(wide)(
            BatchRequest(
                selector=MetaLiteratureSelector(
                    kind="meta-literatures",
                    meta_literature_ids=(_meta_id(1),),
                ),
                goal="ASSET_READY",
            )
        )
        self.assertEqual(wide.clear_calls, [])
        self.assertEqual(report.needs_manual_pdf[0].literature_ids, (_literature_id(1),))

    def test_no_usable_content_cleanup_continues_candidates_and_records_once(self) -> None:
        world = _World((_current(1, 1),))
        world.acquisition_plans[_literature_id(1)] = ["candidate-a", "candidate-b"]
        world.analysis_plans[_literature_id(1)] = ["no-content", "usable"]
        report = _operation(world)(
            BatchRequest(
                selector=LiteratureSelector(
                    kind="literatures",
                    literature_ids=(_literature_id(1),),
                ),
                goal="CONTENT_READY",
            )
        )
        self.assertEqual(report.goal_reached[0].literature_id, _literature_id(1))
        self.assertEqual(
            report.no_usable_content_literature_ids,
            (_literature_id(1),),
        )
        self.assertEqual(len(world.cleanup_calls), 1)
        self.assertEqual(
            world.acquisition_calls[1].excluded_candidate_keys,
            frozenset({"candidate-a"}),
        )
        self.assertNotIn(
            "known_candidate_key",
            {field.name for field in dataclasses.fields(NoUsableContentCleanupCommand)},
        )
        self.assertNotIn(
            "excluded_candidate_key",
            {field.name for field in dataclasses.fields(NoUsableContentCleanupResult)},
        )

    def test_cleanup_failure_preserves_facts_and_manual_cleanup_continues_automatic_candidates(
        self,
    ) -> None:
        initial = _current(1, 1, primary=True, parsed=True)
        world = _World((initial,))
        world.analysis_plans[_literature_id(1)] = ["no-content"]
        world.cleanup_failure = _failure("cleanup-transaction")
        report = _operation(world)(
            BatchRequest(
                selector=LiteratureSelector(
                    kind="literatures",
                    literature_ids=(_literature_id(1),),
                ),
                goal="CONTENT_READY",
            )
        )
        self.assertEqual(report.failed[0].stage, "analysis")
        self.assertEqual(world.values[_literature_id(1)], initial)
        self.assertEqual(report.no_usable_content_literature_ids, ())

        manual = _World((_current(2, 2, primary=True, parsed=True, manual=True),))
        manual.analysis_plans[_literature_id(2)] = ["no-content", "usable"]
        manual.acquisition_plans[_literature_id(2)] = ["automatic-after-manual"]
        report = _operation(manual)(
            BatchRequest(
                selector=LiteratureSelector(
                    kind="literatures",
                    literature_ids=(_literature_id(2),),
                ),
                goal="CONTENT_READY",
            )
        )
        self.assertEqual(report.goal_reached[0].literature_id, _literature_id(2))
        self.assertEqual(len(manual.acquisition_calls), 1)
        self.assertEqual(
            manual.acquisition_calls[0].excluded_candidate_keys,
            frozenset(),
        )
        self.assertEqual(report.no_usable_content_literature_ids, (_literature_id(2),))

    def test_existing_automatic_pdf_without_operation_key_cleans_and_continues(self) -> None:
        initial = _current(1, 1, primary=True, parsed=True)
        world = _World((initial,))
        world.analysis_plans[_literature_id(1)] = ["no-content", "usable"]
        world.acquisition_plans[_literature_id(1)] = ["fresh-candidate"]
        report = _operation(world)(
            BatchRequest(
                selector=LiteratureSelector(
                    kind="literatures",
                    literature_ids=(_literature_id(1),),
                ),
                goal="CONTENT_READY",
            )
        )
        self.assertEqual(report.goal_reached[0].literature_id, _literature_id(1))
        self.assertEqual(len(world.cleanup_calls), 1)
        self.assertEqual(len(world.acquisition_calls), 1)
        self.assertEqual(world.acquisition_calls[0].excluded_candidate_keys, frozenset())
        self.assertEqual(report.no_usable_content_literature_ids, (_literature_id(1),))

    def test_parser_failure_preserves_current_pdf_and_does_not_cross_version(self) -> None:
        first = _current(1, 1, primary=True)
        world = _World((first, _current(2, 1)))
        world.parser_plans[_literature_id(1)] = [ParsingFailure(_failure("parser-failed"))]
        report = _operation(world)(
            BatchRequest(
                selector=MetaLiteratureSelector(
                    kind="meta-literatures",
                    meta_literature_ids=(_meta_id(1),),
                ),
                goal="CONTENT_READY",
            )
        )
        self.assertEqual(report.failed[0].literature_id, _literature_id(1))
        self.assertEqual(report.failed[0].stage, "parsing")
        self.assertEqual(world.values[_literature_id(1)], first)
        self.assertEqual(world.acquisition_calls, [])
        self.assertEqual(world.analysis_calls, [])

    def test_partial_failure_bounded_commit_sequence_and_rerun_current_facts(self) -> None:
        world = _World((_current(1, 1), _current(2, 2), _current(3, 3)))
        world.acquisition_plans[_literature_id(1)] = ["one"]
        world.acquisition_plans[_literature_id(2)] = [
            AcquisitionFailure(_failure("network-timeout"))
        ]
        world.acquisition_plans[_literature_id(3)] = ["three"]
        request = BatchRequest(
            selector=AllPendingSelector(kind="all-pending"),
            goal="ASSET_READY",
        )
        report = _operation(world, max_concurrency=2)(request)
        self.assertEqual(len(report.goal_reached), 2)
        self.assertEqual(len(report.failed), 1)
        self.assertEqual(report.failed[0].stage, "acquisition")
        self.assertEqual(world.max_active_writes, 1)

        previous_calls = len(world.acquisition_calls)
        rerun = _operation(world, max_concurrency=2)(request)
        self.assertEqual(len(rerun.goal_reached), 1)
        self.assertEqual(len(rerun.failed), 0)
        self.assertEqual(len(world.acquisition_calls), previous_calls + 1)

    def test_parser_and_llm_partial_failures_are_isolated_and_rerun_from_current_facts(
        self,
    ) -> None:
        parser_failed_id = _literature_id(1)
        llm_failed_id = _literature_id(2)
        successful_id = _literature_id(3)
        world = _World(
            (
                _current(1, 1, primary=True),
                _current(2, 2, primary=True),
                _current(3, 3, primary=True),
            )
        )
        world.parser_plans[parser_failed_id] = [ParsingFailure(_failure("parser-once"))]
        world.analysis_plans[llm_failed_id] = [ContentAnalysisFailure(_failure("llm-once"))]
        request = _request(
            (parser_failed_id, llm_failed_id, successful_id),
            goal="CONTENT_READY",
        )

        first = _operation(world, max_concurrency=3)(request)
        self.assertEqual(first.end.kind, "finished")
        self.assertEqual(
            {item.literature_id for item in first.failed},
            {parser_failed_id, llm_failed_id},
        )
        self.assertEqual(
            tuple(item.literature_id for item in first.goal_reached),
            (successful_id,),
        )
        self.assertEqual(world.max_active_writes, 1)
        self.assertIsNone(world.values[parser_failed_id].current.current_parser_result)
        self.assertIsNotNone(world.values[llm_failed_id].current.current_parser_result)
        self.assertIsNotNone(world.values[successful_id].current.current_content)

        parser_calls_before = len(world.parser_calls)
        analysis_calls_before = len(world.analysis_calls)
        acceptance_calls_before = len(world.acceptance_calls)
        second = _operation(world, max_concurrency=3)(request)

        self.assertEqual(second.end.kind, "finished")
        self.assertEqual(second.failed, ())
        self.assertEqual(
            tuple(item.literature_id for item in second.goal_reached),
            (parser_failed_id, llm_failed_id),
        )
        self.assertEqual(len(world.parser_calls), parser_calls_before + 1)
        self.assertEqual(len(world.analysis_calls), analysis_calls_before + 2)
        self.assertEqual(len(world.acceptance_calls), acceptance_calls_before + 2)
        self.assertEqual(world.max_active_writes, 1)

        for literature_id in (parser_failed_id, llm_failed_id, successful_id):
            events = [
                (index, kind)
                for index, (kind, identity) in enumerate(world.stage_events)
                if identity == literature_id
            ]
            positions = {kind: index for index, kind in events}
            if literature_id == parser_failed_id:
                self.assertLess(
                    positions["parsing-commit-entered"],
                    positions["analysis-metadata"],
                )
            self.assertLess(positions["analysis-metadata"], positions["analysis-content"])
            self.assertLess(positions["analysis-content"], positions["analysis-markdown"])
            self.assertLess(positions["analysis-markdown"], positions["acceptance"])

    def test_controlled_interruption_partitions_started_and_not_started(self) -> None:
        values = tuple(_current(index, index) for index in range(1, 4))
        world = _World(values)
        cancel_event = threading.Event()
        world.cancel_on_acquire = _literature_id(1)
        report = _operation(
            world,
            max_concurrency=1,
            cancel_event=cancel_event,
        )(
            BatchRequest(
                selector=AllPendingSelector(kind="all-pending"),
                goal="ASSET_READY",
            )
        )
        self.assertEqual(report.end.kind, "interrupted")
        self.assertEqual(report.interrupted[0].literature_id, _literature_id(1))
        self.assertEqual(len(report.not_started), 2)
        self.assertEqual(
            len(report.interrupted) + len(report.not_started),
            3,
        )

    def test_cancelled_queued_receipt_is_discarded_before_worker_start(self) -> None:
        first_id = _literature_id(1)
        second_id = _literature_id(2)
        world = _World((_current(1, 1), _current(2, 2)))
        cancel_event = threading.Event()
        world.block_first_commit = True
        world.first_commit_entered = threading.Event()
        world.release_first_commit = threading.Event()
        world.prepared_events[("acquisition", first_id)] = threading.Event()
        world.prepared_events[("acquisition", second_id)] = threading.Event()

        thread, results = _run_in_thread(
            _operation(world, max_concurrency=2, cancel_event=cancel_event),
            _request((first_id, second_id), goal="ASSET_READY"),
        )
        for identity in (first_id, second_id):
            self.assertTrue(world.prepared_events[("acquisition", identity)].wait(_EVENT_TIMEOUT))
        self.assertTrue(world.first_commit_entered.wait(_EVENT_TIMEOUT))
        cancel_event.set()
        world.release_first_commit.set()
        report = _join(thread, results)

        self.assertEqual(report.end.kind, "interrupted")
        self.assertEqual(len(report.interrupted), 2)
        self.assertEqual(report.not_started, ())
        self.assertEqual(len(world.acquisition_commit_calls), 1)
        self.assertEqual(len(world.acquisition_discard_calls), 1)
        with world.lock:
            committed_ids = tuple(identity for _, identity in world.commit_order)
        self.assertEqual(len(committed_ids), 1)
        self.assertEqual(
            len(world.values[committed_ids[0]].current.current_primary_pdfs),
            1,
        )
        self.assertEqual(world.values[second_id].current.current_primary_pdfs, ())

    def test_cancel_after_commit_entered_finishes_receipt_and_stops_next_stage(self) -> None:
        literature_id = _literature_id(1)
        initial = _current(1, 1)
        world = _World((initial,))
        cancel_event = threading.Event()
        world.cancel_on_commit = ("acquisition", literature_id)
        report = _operation(world, cancel_event=cancel_event)(
            _request((literature_id,), goal="CONTENT_READY")
        )

        self.assertEqual(report.end.kind, "interrupted")
        self.assertEqual(report.interrupted[0].literature_id, literature_id)
        self.assertEqual(world.parser_calls, [])
        self.assertEqual(world.analysis_calls, [])
        self.assertEqual(len(world.acquisition_commit_calls), 1)
        self.assertEqual(world.acquisition_discard_calls, [])
        current = world.values[literature_id].current
        self.assertEqual(len(current.current_primary_pdfs), 1)
        self.assertIsNone(current.current_parser_result)

    def test_reused_operation_does_not_inherit_internal_cancel_state(self) -> None:
        literature_id = _literature_id(1)
        world = _World((_current(1, 1),))
        world.cancel_on_acquire = literature_id
        operation = _operation(world)
        first = operation(_request((literature_id,), goal="ASSET_READY"))
        self.assertEqual(first.end.kind, "interrupted")

        world.cancel_on_acquire = None
        world.acquisition_plans[literature_id] = ["retry"]
        second = operation(_request((literature_id,), goal="ASSET_READY"))
        self.assertEqual(second.end.kind, "finished")
        self.assertEqual(len(second.goal_reached), 1)

    def test_generic_acceptance_failure_remains_failed_when_cancel_is_set(self) -> None:
        literature_id = _literature_id(1)
        world = _World((_current(1, 1, primary=True, parsed=True),))
        cancel_event = threading.Event()

        original_accept = world.accept_content

        stable_failure = _failure("completion-literature-storage-failed")

        def fail_and_cancel(proposal: LiteratureContentProposal) -> ContentAcceptanceDecision:
            cancel_event.set()
            raise CompletionStageFailure("literature", stable_failure)

        world.accept_content = fail_and_cancel  # type: ignore[method-assign]
        report = _operation(world, cancel_event=cancel_event)(
            _request((literature_id,), goal="CONTENT_READY")
        )

        self.assertEqual(report.end.kind, "finished")
        self.assertEqual(report.interrupted, ())
        self.assertEqual(len(report.failed), 1)
        self.assertEqual(report.failed[0].stage, "literature")
        self.assertEqual(report.failed[0].failure, stable_failure)
        world.accept_content = original_accept  # type: ignore[method-assign]

    def test_browser_cancellation_failure_is_reported_as_interrupted(self) -> None:
        literature_id = _literature_id(1)
        world = _World((_current(1, 1),))
        world.acquisition_plans[literature_id] = [
            AcquisitionFailure(_failure("acquisition-browser-cancelled-failed"))
        ]
        report = _operation(world)(_request((literature_id,), goal="ASSET_READY"))

        self.assertEqual(report.end.kind, "interrupted")
        self.assertEqual(report.failed, ())
        self.assertEqual(report.interrupted[0].literature_id, literature_id)

    def test_acquisition_interruption_is_typed_but_racing_source_failure_is_preserved(
        self,
    ) -> None:
        interrupted_id = _literature_id(1)
        interrupted_world = _World((_current(1, 1),))
        interrupted_world.acquisition_plans[interrupted_id] = [
            AcquisitionFailure(_failure("acquisition-interrupted"))
        ]

        interrupted_report = _operation(interrupted_world)(
            _request((interrupted_id,), goal="ASSET_READY")
        )

        self.assertEqual(interrupted_report.end.kind, "interrupted")
        self.assertEqual(interrupted_report.failed, ())
        self.assertEqual(interrupted_report.interrupted[0].literature_id, interrupted_id)

        failed_id = _literature_id(2)
        failed_world = _World((_current(2, 1),))
        cancel_event = threading.Event()
        failed_world.cancel_on_acquisition_failure = failed_id
        failed_world.acquisition_plans[failed_id] = [
            AcquisitionFailure(_failure("acquisition-arxiv-access"))
        ]

        failed_report = _operation(failed_world, cancel_event=cancel_event)(
            _request((failed_id,), goal="ASSET_READY")
        )

        self.assertTrue(cancel_event.is_set())
        self.assertEqual(failed_report.end.kind, "finished")
        self.assertEqual(failed_report.interrupted, ())
        self.assertEqual(len(failed_report.failed), 1)
        self.assertEqual(failed_report.failed[0].stage, "acquisition")
        self.assertEqual(
            failed_report.failed[0].failure.code,
            "acquisition-arxiv-access",
        )

    def test_pre_cancelled_cohort_marks_every_target_not_started_without_acquisition(
        self,
    ) -> None:
        first_id = _literature_id(1)
        second_id = _literature_id(2)
        world = _World((_current(1, 1), _current(2, 2)))
        cancel_event = threading.Event()
        cancel_event.set()
        report = _operation(world, max_concurrency=2, cancel_event=cancel_event)(
            _request((first_id, second_id), goal="ASSET_READY")
        )

        self.assertEqual(report.end.kind, "interrupted")
        self.assertEqual(report.interrupted, ())
        self.assertEqual(
            tuple(getattr(item.target, "literature_id") for item in report.not_started),
            (first_id, second_id),
        )
        self.assertEqual(world.acquisition_calls, [])
        self.assertEqual(world.acquisition_cohort_calls, [])
        self.assertEqual(world.acquisition_commit_calls, [])

    def test_cancel_after_prepare_discards_receipt_without_commit(self) -> None:
        literature_id = _literature_id(1)
        world = _World((_current(1, 1),))
        cancel_event = threading.Event()
        world.cancel_after_prepare = literature_id
        report = _operation(world, cancel_event=cancel_event)(
            _request((literature_id,), goal="ASSET_READY")
        )

        self.assertEqual(report.end.kind, "interrupted")
        self.assertEqual(len(report.interrupted), 1)
        self.assertEqual(world.acquisition_commit_calls, [])
        self.assertEqual(len(world.acquisition_discard_calls), 1)
        self.assertEqual(world.values[literature_id], _current(1, 1))


if __name__ == "__main__":
    unittest.main()
