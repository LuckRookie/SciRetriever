"""Exercise installed-wheel database-completion control semantics offline.

The driver is copied outside the repository and executed by the Python from a
freshly installed wheel.  Completion, selector freezing, Models, and all Port
contracts therefore come from site-packages.  The small in-memory world below
owns selector/current-facts reads, deterministic external effects, and fact
publication.  This is installed-product control-flow evidence through explicit
Port injection, not production Bootstrap, SQLite, Provider, Parser, or LLM
wiring.
"""

from __future__ import annotations

import io
import json
import threading
from collections.abc import Generator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import replace
from types import TracebackType
from typing import Literal, TypeAlias

import sciretriever.entry.completion as completion_module
import sciretriever.entry.execution as execution_module
import sciretriever.entry.orchestration as orchestration_module
import sciretriever.model.execution as execution_model_module
from sciretriever.acquisition.api import (
    AcquisitionProgressObserver,
    BrowserEscalationObserver,
    CohortPreparationItem,
    CohortPreparationObserver,
    PreparedAcquisition,
    PreparedAcquisitionCohort,
)
from sciretriever.acquisition.browser_admission import BrowserEscalationSummary
from sciretriever.acquisition.cohort import WorkItemDisposition
from sciretriever.acquisition.ports import AcquisitionExpectedFacts, AcquisitionFailure
from sciretriever.acquisition.routing import AcquisitionRequest
from sciretriever.analysis.content import ContentAnalysisFailure, ContentAnalysisInput
from sciretriever.entry.completion import DatabaseCompletionOperation
from sciretriever.entry.execution import TransientMetaExecution, freeze_execution
from sciretriever.entry.orchestration import CompletionStageFailure
from sciretriever.entry.ports import (
    CurrentFactsSnapshot,
    ExecutionCurrentFacts,
    LiteratureSelectorSnapshot,
    MetaSelectorSnapshot,
    NoUsableContentCleanupCommand,
    NoUsableContentCleanupResult,
)
from sciretriever.literature.content import (
    ContentAcceptanceDecision,
    ContentAcceptanceReplacement,
    metadata_sha256,
)
from sciretriever.literature.service import NoUsableContentCleanupPreparation
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
    BatchRequest,
    DiscoveryRunSelector,
    ImportReportSelector,
    LiteratureSelector,
    MetaLiteratureSelector,
    QuerySelector,
)
from sciretriever.model.library import LibraryQuery
from sciretriever.model.literature import (
    Literature,
    LiteratureStatus,
    MetaLiterature,
    VersionRole,
)
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
from sciretriever.model.report import DatabaseCompletionReport, StableFailure
from sciretriever.parsing.api import PreparedParsing
from sciretriever.parsing.ports import ParsingFailure

_TIME = UtcTimestamp("2026-08-12T15:00:00Z")
_PARAMETERS_HASH = Sha256("f" * 64)


def _uuid(prefix: int, index: int) -> str:
    return f"{prefix:08x}-0000-4000-8000-{index:012x}"


def _literature_id(index: int) -> LiteratureId:
    return LiteratureId(_uuid(1, index))


def _meta_id(index: int) -> MetaLiteratureId:
    return MetaLiteratureId(_uuid(2, index))


def _numeric_id(literature_id: LiteratureId) -> int:
    return int(literature_id.root[-12:], 16)


def _failure(code: str) -> StableFailure:
    return StableFailure(
        code=code,
        reason="The installed-wheel control fixture stopped this stage.",
        action="Retry the deterministic fixture target.",
        retryable=True,
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
        title=f"Installed completion control {index}",
        publication_year=2020 + index % 5,
        keywords=("completion", "control"),
    )


def _asset(index: int, generation: int = 1) -> Asset:
    digest = sha256_digest(f"control-pdf-{index}-{generation}".encode())
    return Asset(
        asset_id=AssetId(_uuid(3 + generation, index)),
        sha256=digest,
        size_bytes=100 + generation,
        media_type="application/pdf",
        path=RelativeArtifactPath(f"objects/control-{index}-{generation}.pdf"),
    )


def _primary(index: int, generation: int = 1) -> CurrentPrimaryPdf:
    asset = _asset(index, generation)
    relation = LiteratureAsset(
        literature_asset_id=LiteratureAssetId(_uuid(8 + generation, index)),
        literature_id=_literature_id(index),
        asset_id=asset.asset_id,
        role=AssetRole.PRIMARY_PDF,
        provenance=_provenance(
            100 + index + generation,
            source_kind=SourceKind.ASSET_PROVIDER,
            source_name="installed-control-source",
            input_sha256=asset.sha256,
        ),
        source_url="https://offline.invalid/control.pdf",
    )
    return CurrentPrimaryPdf(asset=asset, relation=relation)


def _parser_result(primary: CurrentPrimaryPdf, index: int) -> ParserResult:
    markdown = ParserArtifactRef(
        sha256=sha256_digest(f"control-parser-{index}".encode()),
        media_type="text/markdown",
        byte_size=32,
    )
    provenance = ParserProvenance(
        provenance=_provenance(
            200 + index,
            source_kind=SourceKind.PARSER,
            source_name="installed-control-parser",
            input_sha256=primary.asset.sha256,
            parameters_sha256=_PARAMETERS_HASH,
        ),
        parser_version="1",
    )
    return ParserResult(
        source_asset_id=primary.asset.asset_id,
        source_sha256=primary.asset.sha256,
        page_count=1,
        markdown=markdown,
        result_sha256=parser_result_sha256(
            source_asset_id=primary.asset.asset_id,
            source_sha256=primary.asset.sha256,
            page_count=1,
            markdown=markdown,
            resources=(),
            provenance=provenance,
        ),
        provenance=provenance,
    )


def _current(
    index: int,
    meta_index: int,
    *,
    role: VersionRole = VersionRole.PUBLISHED,
    primary: bool = False,
    parsed: bool = False,
    exhausted: bool = False,
) -> ExecutionCurrentFacts:
    primary_value = _primary(index) if primary else None
    parser = _parser_result(primary_value, index) if parsed and primary_value else None
    metadata = _metadata(index)
    literature = Literature(
        literature_id=_literature_id(index),
        meta_literature_id=_meta_id(meta_index),
        version_role=role,
        metadata=metadata,
        status=(
            LiteratureStatus.ASSET_READY
            if primary_value is not None
            else LiteratureStatus.UNREVIEWED
        ),
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


def _sections() -> tuple[LiteratureSection, ...]:
    return tuple(
        LiteratureSection(role=role, markdown="controlled", subsections=())
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
    if parser is None:
        raise AssertionError("a control proposal requires a ParserResult")
    final_metadata = facts.literature.metadata
    final_metadata_hash = metadata_sha256(final_metadata)
    sections = _sections()
    proposal_hash = content_sha256(
        metadata_sha256=final_metadata_hash,
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
        metadata_sha256=final_metadata_hash,
        sections=sections,
        references=(),
        literature_content_sha256=proposal_hash,
        markdown=ArtifactRef(
            sha256=sha256_digest(f"control-content-{facts.literature.literature_id}".encode()),
            media_type="text/markdown",
            byte_size=64,
        ),
        provenance=_provenance(
            400 + _numeric_id(facts.literature.literature_id),
            source_kind=SourceKind.ANALYSIS,
            source_name="installed-control-analysis",
            input_sha256=analysis_input_sha256(
                primary.asset.sha256,
                parser.result_sha256,
                final_metadata_hash,
            ),
            parameters_sha256=_PARAMETERS_HASH,
        ),
    )


def _accepted(
    current: ExecutionCurrentFacts,
    proposal: LiteratureContentProposal,
) -> tuple[ContentAcceptanceDecision, ExecutionCurrentFacts]:
    facts = current.current
    primary = facts.current_primary_pdfs[0]
    parser = facts.current_parser_result
    if parser is None:
        raise AssertionError("accepted control content requires a ParserResult")
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
    literature = facts.literature.model_copy(
        update={
            "metadata": proposal.final_metadata,
            "status": LiteratureStatus.CONTENT_READY,
        }
    )
    committed = ExecutionCurrentFacts(
        current=CurrentLiteratureFacts(
            literature=literature,
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
    return (
        ContentAcceptanceDecision(
            decision="accepted",
            literature_id=proposal.literature_id,
            status=LiteratureStatus.CONTENT_READY,
            replacement=replacement,
        ),
        committed,
    )


def _meta_snapshot(values: tuple[ExecutionCurrentFacts, ...]) -> MetaSelectorSnapshot:
    meta_ids: list[MetaLiteratureId] = []
    for value in values:
        meta_id = value.current.literature.meta_literature_id
        if meta_id not in meta_ids:
            meta_ids.append(meta_id)
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
    def __enter__(self) -> None:
        return None

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool:
        del exc_type, exc_value, traceback
        return False


class _Admission:
    def acquire_nowait(self) -> AbstractContextManager[None]:
        return _Lease()


class _Recovery:
    def interrupt_visible_running(self) -> tuple[DiscoveryRunId, ...]:
        return ()


class _ContentRef:
    @contextmanager
    def open(self) -> Generator[io.BytesIO, None, None]:
        yield io.BytesIO(b"%PDF-1.7 installed control")


AcquisitionPlan: TypeAlias = Literal["acquired", "exhaust"] | AcquisitionFailure
AnalysisPlan: TypeAlias = Literal["usable", "no-content"] | ContentAnalysisFailure


class _World:
    def __init__(self, values: tuple[ExecutionCurrentFacts, ...]) -> None:
        self.values = {value.current.literature.literature_id: value for value in values}
        self.selector_ids = [value.current.literature.literature_id for value in values]
        self.inject_after_selector: tuple[ExecutionCurrentFacts, ...] = ()
        self.selector_kinds: list[str] = []
        self.current_reads: list[LiteratureId] = []
        self.acquisition_calls: list[LiteratureId] = []
        self.acquisition_events: list[threading.Event | None] = []
        self.parser_calls: list[LiteratureId] = []
        self.parser_events: list[threading.Event | None] = []
        self.analysis_calls: list[LiteratureId] = []
        self.analysis_events: list[threading.Event | None] = []
        self.acceptance_calls: list[LiteratureId] = []
        self.clear_calls: list[LiteratureId] = []
        self.cleanup_calls: list[LiteratureId] = []
        self.acquisition_plans: dict[LiteratureId, list[AcquisitionPlan]] = {}
        self.parser_failures: dict[LiteratureId, ParsingFailure] = {}
        self.analysis_plans: dict[LiteratureId, list[AnalysisPlan]] = {}
        self.literature_failures: dict[LiteratureId, StableFailure] = {}
        self._prepared_acquisitions: dict[
            PreparedAcquisition,
            tuple[LiteratureId, NoPrimaryPdf | AcquiredPrimaryPdf],
        ] = {}
        self.caller_event: threading.Event | None = None
        self.cancel_after_acquisition_commit: LiteratureId | None = None

    def read_selector(
        self,
        selector: object,
    ) -> MetaSelectorSnapshot | LiteratureSelectorSnapshot:
        kind = getattr(selector, "kind", None)
        if not isinstance(kind, str):
            raise AssertionError("selector must expose a string kind")
        self.selector_kinds.append(kind)
        if isinstance(selector, LiteratureSelector):
            snapshot: MetaSelectorSnapshot | LiteratureSelectorSnapshot = (
                LiteratureSelectorSnapshot(
                    literature_ids=selector.literature_ids,
                    current_facts=tuple(
                        self.values[literature_id] for literature_id in selector.literature_ids
                    ),
                )
            )
        else:
            snapshot = _meta_snapshot(
                tuple(self.values[literature_id] for literature_id in self.selector_ids)
            )
        for injected in self.inject_after_selector:
            literature_id = injected.current.literature.literature_id
            self.values[literature_id] = injected
            self.selector_ids.append(literature_id)
        self.inject_after_selector = ()
        return snapshot

    def read_current(self, literature_id: LiteratureId) -> CurrentFactsSnapshot:
        self.current_reads.append(literature_id)
        return CurrentFactsSnapshot(
            literature_id=literature_id,
            current_facts=(self.values[literature_id],),
        )

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
        literature_id = request.literature.literature_id
        self.acquisition_calls.append(literature_id)
        self.acquisition_events.append(cancel_event)
        plan = self.acquisition_plans.get(literature_id, ["acquired"]).pop(0)
        if isinstance(plan, AcquisitionFailure):
            raise plan
        if plan == "exhaust":
            result: NoPrimaryPdf | AcquiredPrimaryPdf = NoPrimaryPdf()
        else:
            primary = _primary(
                _numeric_id(literature_id),
                generation=len(self.acquisition_calls) + 1,
            )
            result = AcquiredPrimaryPdf(
                asset=primary.asset,
                relation=primary.relation,
                candidate_key=f"control-{len(self.acquisition_calls)}",
            )
        prepared = PreparedAcquisition()
        self._prepared_acquisitions[prepared] = (literature_id, result)
        return prepared

    def prepare_primary_pdf_cohort(
        self,
        requests: tuple[AcquisitionRequest, ...],
        *,
        cancel_event: threading.Event | None = None,
        on_prepared: CohortPreparationObserver | None = None,
        on_progress: AcquisitionProgressObserver | None = None,
        on_browser_escalation: BrowserEscalationObserver | None = None,
    ) -> PreparedAcquisitionCohort:
        del on_progress
        items = []
        for request in requests:
            literature_id = request.literature.literature_id
            try:
                prepared = self.prepare_primary_pdf(
                    request,
                    cancel_event=cancel_event,
                )
            except AcquisitionFailure as error:
                items.append(
                    CohortPreparationItem(
                        literature_id=literature_id,
                        disposition=WorkItemDisposition.FAILED,
                        failure=error.failure,
                    )
                )
                continue
            _identity, result = self._prepared_acquisitions[prepared]
            items.append(
                CohortPreparationItem(
                    literature_id=literature_id,
                    disposition=(
                        WorkItemDisposition.EXHAUSTED
                        if isinstance(result, NoPrimaryPdf)
                        else WorkItemDisposition.DELIVERED
                    ),
                    prepared=prepared,
                )
            )
        prepared_items = tuple(items)
        browser_escalation = BrowserEscalationSummary()
        if on_browser_escalation is not None:
            on_browser_escalation(browser_escalation)
        if on_prepared is not None:
            on_prepared(prepared_items)
        return PreparedAcquisitionCohort(
            items=prepared_items,
            browser_escalation=browser_escalation,
        )

    def commit_primary_pdf(
        self,
        prepared: PreparedAcquisition,
    ) -> NoPrimaryPdf | AcquiredPrimaryPdf:
        literature_id, result = self._prepared_acquisitions.pop(prepared)
        current = self.values[literature_id]
        if isinstance(result, NoPrimaryPdf):
            self.values[literature_id] = replace(
                current,
                automatic_pdf_exhaustion=AutomaticPdfAcquisitionExhaustion(
                    literature_id=literature_id
                ),
            )
        else:
            primary = CurrentPrimaryPdf(asset=result.asset, relation=result.relation)
            literature = current.current.literature.model_copy(
                update={"status": LiteratureStatus.ASSET_READY}
            )
            self.values[literature_id] = ExecutionCurrentFacts(
                current=current.current.model_copy(
                    update={
                        "literature": literature,
                        "current_primary_pdfs": (primary,),
                    }
                )
            )
        if literature_id == self.cancel_after_acquisition_commit:
            if self.caller_event is None:
                raise AssertionError("the caller-owned Event must be installed")
            self.caller_event.set()
        return result

    def discard_prepared(
        self,
        prepared: PreparedAcquisition | PreparedParsing,
    ) -> None:
        if isinstance(prepared, PreparedAcquisition):
            self._prepared_acquisitions.pop(prepared, None)

    def clear_exhaustion_for_explicit_retry(
        self,
        expected_facts: AcquisitionExpectedFacts,
    ) -> None:
        self.clear_calls.append(expected_facts.literature_id)
        current = self.values[expected_facts.literature_id]
        self.values[expected_facts.literature_id] = replace(
            current,
            automatic_pdf_exhaustion=None,
        )

    def build_parser_request(self, current: ExecutionCurrentFacts) -> ParserRequest:
        primary = current.current.current_primary_pdfs[0]
        return ParserRequest(
            source_asset_id=primary.asset.asset_id,
            source_sha256=primary.asset.sha256,
            media_type="application/pdf",
            content_ref=_ContentRef(),
        )

    def prepare_current_primary(
        self,
        request: ParserRequest,
        *,
        cancel_event: threading.Event | None = None,
    ) -> PreparedParsing:
        literature_id = next(
            identity
            for identity, current in self.values.items()
            if current.current.current_primary_pdfs
            and current.current.current_primary_pdfs[0].asset.asset_id == request.source_asset_id
        )
        self.parser_calls.append(literature_id)
        self.parser_events.append(cancel_event)
        failure = self.parser_failures.get(literature_id)
        if failure is not None:
            raise failure
        raise AssertionError("the control world did not plan successful parsing")

    def commit_current_primary(self, prepared: PreparedParsing) -> ParserResult:
        del prepared
        raise AssertionError("the control world did not prepare a ParserResult")

    def build_content_analysis_input(
        self,
        current: ExecutionCurrentFacts,
    ) -> ContentAnalysisInput:
        facts = current.current
        primary = facts.current_primary_pdfs[0]
        parser = facts.current_parser_result
        if parser is None:
            raise AssertionError("Analysis requires a current ParserResult")
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
        literature_id = analysis_input.literature_id
        self.analysis_calls.append(literature_id)
        self.analysis_events.append(cancel_event)
        plan = self.analysis_plans.get(literature_id, ["usable"]).pop(0)
        if isinstance(plan, ContentAnalysisFailure):
            raise plan
        if plan == "no-content":
            return NoUsableContent(outcome="no_usable_content")
        return _proposal(self.values[literature_id])

    def accept_content(
        self,
        proposal: LiteratureContentProposal,
    ) -> ContentAcceptanceDecision:
        literature_id = proposal.literature_id
        self.acceptance_calls.append(literature_id)
        failure = self.literature_failures.get(literature_id)
        if failure is not None:
            raise CompletionStageFailure("literature", failure)
        decision, committed = _accepted(self.values[literature_id], proposal)
        self.values[literature_id] = committed
        return decision

    def prepare_no_usable_content_cleanup(
        self,
        literature_id: LiteratureId,
        old_content_sha256: Sha256,
    ) -> NoUsableContentCleanupPreparation:
        del literature_id, old_content_sha256
        raise AssertionError("the fixture never cleans an accepted old content fact")

    def cleanup_no_usable_content(
        self,
        command: NoUsableContentCleanupCommand,
    ) -> NoUsableContentCleanupResult:
        literature_id = command.literature_id
        current = self.values[literature_id]
        self.cleanup_calls.append(literature_id)
        self.values[literature_id] = ExecutionCurrentFacts(
            current=CurrentLiteratureFacts(
                literature=current.current.literature.model_copy(
                    update={"status": LiteratureStatus.UNREVIEWED}
                ),
                metadata_revision=current.current.metadata_revision,
                metadata_sha256=current.current.metadata_sha256,
            )
        )
        return NoUsableContentCleanupResult(
            literature_id=literature_id,
            primary_asset_id=command.primary_asset.asset_id,
        )


def _operation(
    world: _World,
    *,
    cancel_event: threading.Event | None = None,
) -> DatabaseCompletionOperation:
    world.caller_event = cancel_event
    return DatabaseCompletionOperation(
        selector_reader=world,
        current_facts_reader=world,
        write_admission=_Admission(),
        recovery=_Recovery(),
        acquisition=world,
        acquisition_requests=world,
        parsing=world,
        parser_requests=world,
        analysis=world,
        analysis_inputs=world,
        literature=world,
        cleanup=world,
        max_concurrency=1,
        cancel_event=cancel_event,
    )


def _selector_requests() -> tuple[BatchRequest, ...]:
    return (
        BatchRequest(
            selector=AllPendingSelector(kind="all-pending"),
            goal="ASSET_READY",
        ),
        BatchRequest(
            selector=DiscoveryRunSelector(
                kind="discovery-run",
                discovery_run_id=DiscoveryRunId(_uuid(50, 1)),
            ),
            goal="ASSET_READY",
        ),
        BatchRequest(
            selector=ImportReportSelector(
                kind="import-report",
                meta_literature_ids=(_meta_id(1),),
            ),
            goal="ASSET_READY",
        ),
        BatchRequest(
            selector=QuerySelector(
                kind="query",
                query=LibraryQuery(text="installed completion control"),
            ),
            goal="ASSET_READY",
        ),
        BatchRequest(
            selector=MetaLiteratureSelector(
                kind="meta-literatures",
                meta_literature_ids=(_meta_id(1),),
            ),
            goal="ASSET_READY",
        ),
        BatchRequest(
            selector=LiteratureSelector(
                kind="literatures",
                literature_ids=(_literature_id(1),),
            ),
            goal="ASSET_READY",
        ),
    )


def _report_ids(report: DatabaseCompletionReport) -> dict[str, list[str]]:
    return {
        "goal_reached": [item.literature_id.root for item in report.goal_reached],
        "needs_manual_pdf": [
            literature_id.root
            for item in report.needs_manual_pdf
            for literature_id in item.literature_ids
        ],
        "failed": [item.literature_id.root for item in report.failed],
        "interrupted": [item.literature_id.root for item in report.interrupted],
        "not_started": [
            (
                item.target.literature_id.root
                if item.target.kind == "literature"
                else item.target.meta_literature_id.root
            )
            for item in report.not_started
        ],
    }


def _six_selectors() -> dict[str, object]:
    results: dict[str, object] = {}
    for request in _selector_requests():
        world = _World((_current(1, 1),))
        report = _operation(world)(request)
        if report.end.kind != "finished" or len(report.goal_reached) != 1:
            raise AssertionError("a selector did not complete its frozen target")
        if len(world.selector_kinds) != 1:
            raise AssertionError("a selector must be expanded exactly once")
        if world.parser_calls or world.analysis_calls:
            raise AssertionError("ASSET_READY must not enter Parsing or Analysis")
        results[request.selector.kind] = {
            "selector_reads": len(world.selector_kinds),
            "partitions": _report_ids(report),
            "parser_calls": len(world.parser_calls),
            "analysis_calls": len(world.analysis_calls),
        }
    return results


def _snapshot_freeze() -> dict[str, object]:
    world = _World((_current(10, 10),))
    world.inject_after_selector = (_current(11, 11),)
    request = BatchRequest(
        selector=AllPendingSelector(kind="all-pending"),
        goal="ASSET_READY",
    )
    first = _operation(world)(request)
    first_calls = tuple(world.acquisition_calls)
    second = _operation(world)(request)
    second_calls = tuple(world.acquisition_calls[len(first_calls) :])
    if first_calls != (_literature_id(10),):
        raise AssertionError("the first frozen run absorbed a later Literature")
    if second_calls != (_literature_id(11),):
        raise AssertionError("the next selector read did not see the later Literature")
    return {
        "first": _report_ids(first),
        "second": _report_ids(second),
        "first_acquisition_ids": [item.root for item in first_calls],
        "second_acquisition_ids": [item.root for item in second_calls],
        "selector_reads": len(world.selector_kinds),
    }


def _typed_fallbacks() -> dict[str, object]:
    exhausted = _World((_current(20, 20), _current(21, 20, role=VersionRole.PREPRINT)))
    exhausted.acquisition_plans[_literature_id(20)] = ["exhaust"]
    exhausted.acquisition_plans[_literature_id(21)] = ["acquired"]
    exhausted_report = _operation(exhausted)(
        BatchRequest(
            selector=MetaLiteratureSelector(
                kind="meta-literatures",
                meta_literature_ids=(_meta_id(20),),
            ),
            goal="ASSET_READY",
        )
    )
    if tuple(exhausted.acquisition_calls) != (
        _literature_id(20),
        _literature_id(21),
    ):
        raise AssertionError("typed NoPrimaryPdf did not advance to the next version")

    no_content = _World(
        (
            _current(30, 30, primary=True, parsed=True),
            _current(
                31,
                30,
                role=VersionRole.OTHER,
                primary=True,
                parsed=True,
            ),
        )
    )
    no_content.analysis_plans[_literature_id(30)] = ["no-content"]
    no_content.acquisition_plans[_literature_id(30)] = ["exhaust"]
    no_content_report = _operation(no_content)(
        BatchRequest(
            selector=MetaLiteratureSelector(
                kind="meta-literatures",
                meta_literature_ids=(_meta_id(30),),
            ),
            goal="CONTENT_READY",
        )
    )
    if tuple(no_content.analysis_calls) != (
        _literature_id(30),
        _literature_id(31),
    ):
        raise AssertionError("NoUsableContent plus exhaustion did not cross versions")
    if no_content.cleanup_calls != [_literature_id(30)]:
        raise AssertionError("NoUsableContent cleanup was not exact")

    return {
        "no_primary_pdf": {
            "report": exhausted_report.model_dump(mode="json"),
            "acquisition_order": [item.root for item in exhausted.acquisition_calls],
        },
        "no_usable_content_then_exhaustion": {
            "report": no_content_report.model_dump(mode="json"),
            "analysis_order": [item.root for item in no_content.analysis_calls],
            "cleanup_ids": [item.root for item in no_content.cleanup_calls],
            "acquisition_order": [item.root for item in no_content.acquisition_calls],
        },
    }


def _candidate_ordering() -> dict[str, object]:
    values = (
        _current(84, 80, role=VersionRole.PREPRINT),
        _current(83, 80, role=VersionRole.PUBLISHED),
        _current(82, 80, role=VersionRole.PUBLISHED),
        _current(81, 80, role=VersionRole.OTHER, primary=True),
    )
    world = _World(values)
    request = BatchRequest(
        selector=MetaLiteratureSelector(
            kind="meta-literatures",
            meta_literature_ids=(_meta_id(80),),
        ),
        goal="CONTENT_READY",
    )
    snapshot = world.read_selector(request.selector)
    frozen = freeze_execution(request, snapshot)
    if len(frozen) != 1 or not isinstance(frozen[0], TransientMetaExecution):
        raise AssertionError("the ordering fixture did not freeze one MetaLiterature target")
    order = tuple(candidate.literature_id for candidate in frozen[0].candidates)
    expected = tuple(_literature_id(index) for index in (81, 82, 83, 84))
    if order != expected:
        raise AssertionError("candidate order did not use progress, role, and stable ID")
    return {
        "input_order": [value.current.literature.literature_id.root for value in values],
        "frozen_order": [item.root for item in order],
        "expected_order": [item.root for item in expected],
    }


def _exhaustion_control() -> dict[str, object]:
    explicit = _World((_current(90, 90, exhausted=True),))
    explicit_report = _operation(explicit)(
        BatchRequest(
            selector=LiteratureSelector(
                kind="literatures",
                literature_ids=(_literature_id(90),),
            ),
            goal="ASSET_READY",
        )
    )
    if explicit.clear_calls != [_literature_id(90)]:
        raise AssertionError("an explicit Literature retry did not clear exhaustion once")
    if explicit.acquisition_calls != [_literature_id(90)]:
        raise AssertionError("an explicit Literature retry did not reacquire")

    wide = _World((_current(91, 91, exhausted=True),))
    wide_report = _operation(wide)(
        BatchRequest(
            selector=MetaLiteratureSelector(
                kind="meta-literatures",
                meta_literature_ids=(_meta_id(91),),
            ),
            goal="ASSET_READY",
        )
    )
    if wide.clear_calls or wide.acquisition_calls:
        raise AssertionError("a wide selector cleared or retried exhaustion")

    partial = _World(
        (
            _current(92, 92, exhausted=True),
            _current(93, 92, role=VersionRole.PREPRINT),
        )
    )
    partial_report = _operation(partial)(
        BatchRequest(
            selector=AllPendingSelector(kind="all-pending"),
            goal="ASSET_READY",
        )
    )
    if partial.acquisition_calls != [_literature_id(93)]:
        raise AssertionError("AllPending did not retain only the unexhausted sibling")

    omitted = _World(
        (
            _current(94, 94, exhausted=True),
            _current(95, 94, role=VersionRole.PREPRINT, exhausted=True),
        )
    )
    omitted_report = _operation(omitted)(
        BatchRequest(
            selector=AllPendingSelector(kind="all-pending"),
            goal="ASSET_READY",
        )
    )
    if omitted.acquisition_calls:
        raise AssertionError("AllPending retained a fully exhausted MetaLiterature")
    if any(
        (
            omitted_report.goal_reached,
            omitted_report.needs_manual_pdf,
            omitted_report.failed,
            omitted_report.interrupted,
            omitted_report.not_started,
        )
    ):
        raise AssertionError("a fully exhausted AllPending scope produced a target partition")

    return {
        "explicit": {
            "clear_calls": [item.root for item in explicit.clear_calls],
            "acquisition_calls": [item.root for item in explicit.acquisition_calls],
            "report": explicit_report.model_dump(mode="json"),
        },
        "wide": {
            "clear_calls": [item.root for item in wide.clear_calls],
            "acquisition_calls": [item.root for item in wide.acquisition_calls],
            "report": wide_report.model_dump(mode="json"),
        },
        "all_pending_partial": {
            "acquisition_calls": [item.root for item in partial.acquisition_calls],
            "report": partial_report.model_dump(mode="json"),
        },
        "all_pending_omitted": {
            "acquisition_calls": [item.root for item in omitted.acquisition_calls],
            "report": omitted_report.model_dump(mode="json"),
        },
    }


def _failures_do_not_fallback() -> dict[str, object]:
    acquisition = _World((_current(40, 40), _current(41, 40, role=VersionRole.PREPRINT)))
    acquisition.acquisition_plans[_literature_id(40)] = [
        AcquisitionFailure(_failure("control-network-failed"))
    ]
    acquisition_report = _operation(acquisition)(
        BatchRequest(
            selector=MetaLiteratureSelector(
                kind="meta-literatures",
                meta_literature_ids=(_meta_id(40),),
            ),
            goal="ASSET_READY",
        )
    )

    parsing = _World(
        (
            _current(50, 50, primary=True),
            _current(51, 50, role=VersionRole.PREPRINT),
        )
    )
    parsing.parser_failures[_literature_id(50)] = ParsingFailure(_failure("control-parser-failed"))
    parsing_report = _operation(parsing)(
        BatchRequest(
            selector=MetaLiteratureSelector(
                kind="meta-literatures",
                meta_literature_ids=(_meta_id(50),),
            ),
            goal="CONTENT_READY",
        )
    )

    analysis = _World(
        (
            _current(
                60,
                60,
                role=VersionRole.OTHER,
                primary=True,
                parsed=True,
            ),
            _current(61, 60, role=VersionRole.PUBLISHED),
        )
    )
    analysis.analysis_plans[_literature_id(60)] = [
        ContentAnalysisFailure(_failure("control-llm-failed"))
    ]
    analysis_report = _operation(analysis)(
        BatchRequest(
            selector=MetaLiteratureSelector(
                kind="meta-literatures",
                meta_literature_ids=(_meta_id(60),),
            ),
            goal="CONTENT_READY",
        )
    )

    storage = _World(
        (
            _current(62, 62, role=VersionRole.OTHER, primary=True, parsed=True),
            _current(63, 62, role=VersionRole.PUBLISHED),
        )
    )
    storage.literature_failures[_literature_id(62)] = _failure("control-literature-storage-failed")
    storage_report = _operation(storage)(
        BatchRequest(
            selector=MetaLiteratureSelector(
                kind="meta-literatures",
                meta_literature_ids=(_meta_id(62),),
            ),
            goal="CONTENT_READY",
        )
    )

    if acquisition.acquisition_calls != [_literature_id(40)]:
        raise AssertionError("an Acquisition failure crossed versions")
    if parsing.parser_calls != [_literature_id(50)] or parsing.acquisition_calls:
        raise AssertionError("a Parser failure crossed versions")
    if analysis.analysis_calls != [_literature_id(60)] or analysis.acquisition_calls:
        raise AssertionError("an Analysis failure crossed versions")
    if storage.acceptance_calls != [_literature_id(62)] or storage.acquisition_calls:
        raise AssertionError("a Storage publication failure crossed versions")
    return {
        "acquisition": {
            "report": acquisition_report.model_dump(mode="json"),
            "calls": [item.root for item in acquisition.acquisition_calls],
        },
        "parsing": {
            "report": parsing_report.model_dump(mode="json"),
            "calls": [item.root for item in parsing.parser_calls],
        },
        "analysis": {
            "report": analysis_report.model_dump(mode="json"),
            "calls": [item.root for item in analysis.analysis_calls],
        },
        "literature": {
            "report": storage_report.model_dump(mode="json"),
            "calls": [item.root for item in storage.acceptance_calls],
        },
    }


def _controlled_interruption() -> dict[str, object]:
    world = _World(tuple(_current(index, index) for index in range(70, 73)))
    event = threading.Event()
    world.cancel_after_acquisition_commit = _literature_id(70)
    report = _operation(world, cancel_event=event)(
        BatchRequest(
            selector=AllPendingSelector(kind="all-pending"),
            goal="CONTENT_READY",
        )
    )
    partitions = _report_ids(report)
    if report.end.kind != "interrupted":
        raise AssertionError("caller cancellation did not interrupt the report")
    if partitions["interrupted"] != [_literature_id(70).root]:
        raise AssertionError("the started target was not interrupted")
    if len(partitions["not_started"]) != 2:
        raise AssertionError("later frozen targets were not marked not-started")
    if not all(item is event for item in world.acquisition_events):
        raise AssertionError("the external Port did not receive the caller Event by identity")
    committed = world.values[_literature_id(70)].current
    if committed.literature.status is not LiteratureStatus.ASSET_READY:
        raise AssertionError("a committed primary PDF was lost during cancellation")
    if not committed.current_primary_pdfs:
        raise AssertionError("the committed primary PDF fact is missing")
    if world.parser_calls or world.analysis_calls:
        raise AssertionError("cancellation did not stop the next external stage")
    return {
        "end": report.end.model_dump(mode="json"),
        "partitions": partitions,
        "caller_event_set": event.is_set(),
        "same_event_identity": all(item is event for item in world.acquisition_events),
        "committed_status": committed.literature.status.value,
        "committed_primary_count": len(committed.current_primary_pdfs),
        "parser_calls": len(world.parser_calls),
        "analysis_calls": len(world.analysis_calls),
    }


def main() -> None:
    payload = {
        "evidence_kind": "installed-port-injection",
        "product_module_files": {
            "completion": completion_module.__file__,
            "execution": execution_module.__file__,
            "orchestration": orchestration_module.__file__,
            "execution_models": execution_model_module.__file__,
        },
        "six_selectors": _six_selectors(),
        "snapshot_freeze": _snapshot_freeze(),
        "typed_fallbacks": _typed_fallbacks(),
        "candidate_ordering": _candidate_ordering(),
        "exhaustion_control": _exhaustion_control(),
        "failures_do_not_fallback": _failures_do_not_fallback(),
        "controlled_interruption": _controlled_interruption(),
    }
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
