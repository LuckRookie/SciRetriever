"""One frozen database-completion target's process-local orchestration.

Entry owns ordering and control flow, not feature validation.  The narrow
factories below are consumer-owned composition seams for information that the
current public feature facades cannot yet construct from ``ExecutionCurrentFacts``
alone.  They must return the public request Models; Acquisition, Parsing,
Analysis, Literature, and the atomic no-content cleanup boundary remain the
owners of their decisions and commits.

The cleanup Port is intentionally explicit.  ``NoUsableContent`` is carried in
its command as the sole deletion authorization, and every current input needed
for a compare-and-swap cleanup is frozen into that command.  An implementation
must either remove the whole managed current-primary/derived closure or leave
all facts unchanged.  Entry never substitutes private Storage access for that
missing public production boundary.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, NoReturn, Protocol, TypeAlias, TypeVar, runtime_checkable

from sciretriever.acquisition.api import (
    AcquisitionExpectedFacts,
    AcquisitionFailure,
    AcquisitionProgressObserver,
    AcquisitionRequest,
    BrowserEscalationObserver,
    CohortPreparationObserver,
    PreparedAcquisition,
    PreparedAcquisitionCohort,
)
from sciretriever.analysis.api import ContentAnalysisFailure, ContentAnalysisInput
from sciretriever.entry.execution import (
    FrozenLiteratureCandidate,
    TransientExecution,
    TransientLiteratureExecution,
    TransientMetaExecution,
)
from sciretriever.entry.ports import (
    CurrentFactsSnapshot,
    CurrentFactsSnapshotReadPort,
    ExecutionCurrentFacts,
    NoUsableContentCleanupCommand,
    NoUsableContentCleanupFailure,
    NoUsableContentCleanupPort,
    NoUsableContentCleanupResult,
)
from sciretriever.literature.api import (
    ContentAcceptanceDecision,
    NoUsableContentCleanupPreparation,
    StalePreconditionError,
    derive_status,
)
from sciretriever.logging.api import get_logger
from sciretriever.model.acquisition import (
    AcquiredPrimaryPdf,
    AcquisitionResult,
    AssetRole,
    NoPrimaryPdf,
)
from sciretriever.model.analysis import (
    LiteratureContentProposal,
    NoUsableContent,
)
from sciretriever.model.execution import BatchGoal
from sciretriever.model.literature import LiteratureStatus
from sciretriever.model.parsing import ParserRequest, ParserResult
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    Sha256,
)
from sciretriever.model.report import (
    FailedCompletionTarget,
    GoalReachedTarget,
    InterruptedCompletionTarget,
    NeedsManualPdfTarget,
    StableFailure,
)
from sciretriever.parsing.api import ParsingFailure, PreparedParsing

CompletionStage: TypeAlias = Literal["acquisition", "parsing", "analysis", "literature"]
_T = TypeVar("_T")
_PreparedT = TypeVar("_PreparedT")
_LOGGER = get_logger(__name__)


class CommitNotStarted(RuntimeError):
    """A queued commit was cancelled before its operation began."""


@runtime_checkable
class CommitExecutor(Protocol):
    """Consumer-owned boundary for the operation-wide serial commit queue."""

    def execute(
        self,
        operation: Callable[[], _T],
        *,
        cancel_event: threading.Event | None = None,
    ) -> _T: ...


@runtime_checkable
class AutomaticAcquisitionPort(Protocol):
    """The public automatic Acquisition surface consumed by Entry."""

    def prepare_primary_pdf(
        self,
        request: AcquisitionRequest,
        *,
        cancel_event: threading.Event | None = None,
    ) -> PreparedAcquisition: ...

    def prepare_primary_pdf_cohort(
        self,
        requests: tuple[AcquisitionRequest, ...],
        *,
        cancel_event: threading.Event | None = None,
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


@runtime_checkable
class AcquisitionRequestFactory(Protocol):
    """Complete a public Acquisition request from a freshly read current view.

    The implementation supplies the observation/AssetHint closure and any
    safely resolved landing origin.  Entry supplies only the current Literature
    and its operation-local tried keys.
    """

    def build_acquisition_request(
        self,
        current: ExecutionCurrentFacts,
        *,
        excluded_candidate_keys: frozenset[str],
    ) -> AcquisitionRequest: ...


@runtime_checkable
class ParsingOperationPort(Protocol):
    def prepare_current_primary(
        self,
        request: ParserRequest,
        *,
        cancel_event: threading.Event | None = None,
    ) -> PreparedParsing: ...

    def commit_current_primary(self, prepared: PreparedParsing) -> ParserResult: ...

    def discard_prepared(self, prepared: PreparedParsing) -> None: ...


@runtime_checkable
class ParserRequestFactory(Protocol):
    """Attach a verified, path-free current-primary reader to Parser input."""

    def build_parser_request(self, current: ExecutionCurrentFacts) -> ParserRequest: ...


@runtime_checkable
class ContentAnalysisPort(Protocol):
    def analyze_content(
        self,
        analysis_input: ContentAnalysisInput,
        *,
        cancel_event: threading.Event | None = None,
    ) -> NoUsableContent | LiteratureContentProposal: ...


@runtime_checkable
class ContentAnalysisInputFactory(Protocol):
    """Build the complete public Analysis input, including user observations."""

    def build_content_analysis_input(
        self,
        current: ExecutionCurrentFacts,
    ) -> ContentAnalysisInput: ...


@runtime_checkable
class ContentAcceptancePort(Protocol):
    def accept_content(
        self,
        proposal: LiteratureContentProposal,
    ) -> ContentAcceptanceDecision: ...

    def prepare_no_usable_content_cleanup(
        self,
        literature_id: LiteratureId,
        old_content_sha256: Sha256,
    ) -> NoUsableContentCleanupPreparation: ...


class CompletionStageFailure(RuntimeError):
    """A stable component/factory failure already safe for an Entry report."""

    _MESSAGE = "database completion stage failed"
    stage: CompletionStage
    failure: StableFailure

    def __init__(self, stage: CompletionStage, failure: StableFailure) -> None:
        if stage not in {"acquisition", "parsing", "analysis", "literature"}:
            raise ValueError("stage must be a completion stage")
        if not isinstance(failure, StableFailure):
            raise TypeError("failure must be StableFailure")
        super().__init__(self._MESSAGE)
        self.stage = stage
        self.failure = failure


@dataclass(frozen=True, slots=True)
class TargetOrchestrationResult:
    """One final Report partition item plus successful cleanup identities."""

    outcome: (
        GoalReachedTarget
        | NeedsManualPdfTarget
        | FailedCompletionTarget
        | InterruptedCompletionTarget
    )
    no_usable_content_literature_ids: tuple[LiteratureId, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(
            self.outcome,
            (
                GoalReachedTarget,
                NeedsManualPdfTarget,
                FailedCompletionTarget,
                InterruptedCompletionTarget,
            ),
        ):
            raise TypeError("outcome must be a terminal completion partition item")
        if not isinstance(self.no_usable_content_literature_ids, tuple) or any(
            not isinstance(item, LiteratureId) for item in self.no_usable_content_literature_ids
        ):
            raise TypeError("no-usable-content identities must be LiteratureId values")
        if len(self.no_usable_content_literature_ids) != len(
            set(self.no_usable_content_literature_ids)
        ):
            raise ValueError("no-usable-content identities must be unique")


@dataclass(frozen=True, slots=True)
class _CandidateGoal:
    literature_id: LiteratureId


@dataclass(frozen=True, slots=True)
class _CandidateMissing:
    literature_id: LiteratureId


_CandidateOutcome: TypeAlias = _CandidateGoal | _CandidateMissing


class _CandidateInterrupted(BaseException):
    def __init__(self, literature_id: LiteratureId) -> None:
        super().__init__()
        self.literature_id = literature_id


class _CandidateFailed(Exception):
    stage: CompletionStage
    failure: StableFailure

    def __init__(
        self,
        literature_id: LiteratureId,
        stage: CompletionStage,
        failure: StableFailure,
    ) -> None:
        super().__init__("candidate completion failed")
        self.literature_id = literature_id
        self.stage = stage
        self.failure = failure


@dataclass(slots=True)
class _CandidateRunState:
    tried_candidate_keys: set[str]
    explicit_exhaustion_cleared: bool = False


@dataclass(frozen=True, slots=True)
class _ContentCompletionDependencies:
    parsing: ParsingOperationPort
    parser_requests: ParserRequestFactory
    analysis: ContentAnalysisPort
    analysis_inputs: ContentAnalysisInputFactory
    literature: ContentAcceptancePort
    cleanup: NoUsableContentCleanupPort

    def __post_init__(self) -> None:
        checks = (
            (
                isinstance(self.parsing, ParsingOperationPort),
                "parsing must implement current-primary parsing",
            ),
            (
                isinstance(self.parser_requests, ParserRequestFactory),
                "parser_requests must implement request construction",
            ),
            (
                isinstance(self.analysis, ContentAnalysisPort),
                "analysis must implement content analysis",
            ),
            (
                isinstance(self.analysis_inputs, ContentAnalysisInputFactory),
                "analysis_inputs must implement input construction",
            ),
            (
                isinstance(self.literature, ContentAcceptancePort),
                "literature must implement content acceptance",
            ),
            (
                isinstance(self.cleanup, NoUsableContentCleanupPort),
                "cleanup must implement no-content cleanup",
            ),
        )
        for valid, message in checks:
            if not valid:
                raise TypeError(message)


class _CompletionTargetOrchestratorCore:
    """Advance one frozen target without changing its candidates or scope."""

    __slots__ = (
        "_current_facts_reader",
        "_acquisition",
        "_acquisition_requests",
        "_content_dependencies",
        "_commit_executor",
        "_cancel_event",
    )

    def __init__(
        self,
        *,
        current_facts_reader: CurrentFactsSnapshotReadPort,
        acquisition: AutomaticAcquisitionPort,
        acquisition_requests: AcquisitionRequestFactory,
        content_dependencies: _ContentCompletionDependencies | None,
        commit_executor: CommitExecutor,
        cancel_event: threading.Event | None = None,
    ) -> None:
        checks = (
            (
                isinstance(current_facts_reader, CurrentFactsSnapshotReadPort),
                "current_facts_reader must implement current-facts reads",
            ),
            (
                isinstance(acquisition, AutomaticAcquisitionPort),
                "acquisition must implement automatic acquisition",
            ),
            (
                isinstance(acquisition_requests, AcquisitionRequestFactory),
                "acquisition_requests must implement request construction",
            ),
            (
                isinstance(commit_executor, CommitExecutor),
                "commit_executor must implement serial commit execution",
            ),
        )
        for valid, message in checks:
            if not valid:
                raise TypeError(message)
        if cancel_event is not None and not callable(getattr(cancel_event, "is_set", None)):
            raise TypeError("cancel_event must expose is_set")
        self._current_facts_reader = current_facts_reader
        self._acquisition = acquisition
        self._acquisition_requests = acquisition_requests
        self._content_dependencies = content_dependencies
        self._commit_executor = commit_executor
        self._cancel_event = cancel_event

    def _content(self) -> _ContentCompletionDependencies:
        dependencies = self._content_dependencies
        if dependencies is None:
            raise RuntimeError("content completion dependencies are not assembled")
        return dependencies

    def run(
        self,
        execution: TransientExecution,
        goal: BatchGoal,
    ) -> TargetOrchestrationResult:
        if not isinstance(execution, (TransientMetaExecution, TransientLiteratureExecution)):
            raise TypeError("execution must be a transient completion execution")
        if goal not in {"ASSET_READY", "CONTENT_READY"}:
            raise ValueError("goal must be a supported BatchGoal")

        if isinstance(execution, TransientMetaExecution):
            candidates = execution.candidates
            expected_meta_id: MetaLiteratureId | None = execution.target.meta_literature_id
            explicit_retry = False
        else:
            candidates = (execution.candidate,)
            expected_meta_id = None
            explicit_retry = True

        no_usable: list[LiteratureId] = []
        stable_missing: list[LiteratureId] = []
        current_literature_id: LiteratureId | None = None
        _LOGGER.debug(
            "event=completion-orchestration-started goal=%s candidate_count=%d explicit_retry=%s",
            goal,
            len(candidates),
            str(explicit_retry).lower(),
        )
        try:
            for candidate in candidates:
                current_literature_id = candidate.literature_id
                outcome = self._run_candidate(
                    candidate,
                    goal=goal,
                    expected_meta_id=expected_meta_id,
                    explicit_retry=explicit_retry,
                    no_usable=no_usable,
                )
                if isinstance(outcome, _CandidateGoal):
                    return TargetOrchestrationResult(
                        outcome=GoalReachedTarget(
                            target=execution.target,
                            literature_id=outcome.literature_id,
                        ),
                        no_usable_content_literature_ids=tuple(no_usable),
                    )
                stable_missing.append(outcome.literature_id)
                if explicit_retry:
                    break
        except _CandidateInterrupted as interrupted:
            return TargetOrchestrationResult(
                outcome=InterruptedCompletionTarget(
                    target=execution.target,
                    literature_id=interrupted.literature_id,
                ),
                no_usable_content_literature_ids=tuple(no_usable),
            )
        except _CandidateFailed as failed:
            return TargetOrchestrationResult(
                outcome=FailedCompletionTarget(
                    target=execution.target,
                    literature_id=failed.literature_id,
                    stage=failed.stage,
                    failure=failed.failure,
                ),
                no_usable_content_literature_ids=tuple(no_usable),
            )

        if not stable_missing:
            # A frozen execution always has candidates.  Reaching here can
            # therefore only indicate an internal orchestration contract bug.
            literature_id = current_literature_id or candidates[0].literature_id
            return TargetOrchestrationResult(
                outcome=FailedCompletionTarget(
                    target=execution.target,
                    literature_id=literature_id,
                    stage="literature",
                    failure=_contract_failure("literature"),
                ),
                no_usable_content_literature_ids=tuple(no_usable),
            )
        return TargetOrchestrationResult(
            outcome=NeedsManualPdfTarget(
                target=execution.target,
                literature_ids=tuple(stable_missing),
            ),
            no_usable_content_literature_ids=tuple(no_usable),
        )

    def _run_candidate(
        self,
        candidate: FrozenLiteratureCandidate,
        *,
        goal: BatchGoal,
        expected_meta_id: MetaLiteratureId | None,
        explicit_retry: bool,
        no_usable: list[LiteratureId],
    ) -> _CandidateOutcome:
        literature_id = candidate.literature_id
        state = _CandidateRunState(set())
        _LOGGER.debug(
            "event=completion-candidate-started literature_id=%s goal=%s",
            literature_id,
            goal,
        )

        while True:
            self._check_cancel(literature_id)
            current = self._read_current(literature_id, expected_meta_id=expected_meta_id)
            if _reaches_goal(current, goal):
                _LOGGER.debug(
                    "event=completion-stage-skipped literature_id=%s stage=all "
                    "reason=goal-already-reached",
                    literature_id,
                )
                return _CandidateGoal(literature_id)
            primary_result = self._ensure_primary_pdf(
                literature_id,
                current,
                expected_meta_id=expected_meta_id,
                explicit_retry=explicit_retry,
                state=state,
            )
            if isinstance(primary_result, _CandidateMissing):
                _LOGGER.debug(
                    "event=completion-stage-finished literature_id=%s stage=acquisition "
                    "outcome=no-primary-pdf",
                    literature_id,
                )
                return primary_result
            current = primary_result

            if goal == "ASSET_READY":
                _LOGGER.debug(
                    "event=completion-candidate-finished literature_id=%s outcome=goal-reached",
                    literature_id,
                )
                return _CandidateGoal(literature_id)

            current = self._ensure_parser_result(
                literature_id,
                current,
                expected_meta_id=expected_meta_id,
            )
            analysis_result = self._analyze_current_content(literature_id, current)
            if isinstance(analysis_result, NoUsableContent):
                missing = self._handle_no_usable_content(
                    literature_id,
                    current,
                    analysis_result,
                    state=state,
                    no_usable=no_usable,
                    expected_meta_id=expected_meta_id,
                )
                if missing is not None:
                    return missing
                continue
            return self._accept_content(
                literature_id,
                analysis_result,
                expected_meta_id=expected_meta_id,
            )

    def _ensure_primary_pdf(
        self,
        literature_id: LiteratureId,
        current: ExecutionCurrentFacts,
        *,
        expected_meta_id: MetaLiteratureId | None,
        explicit_retry: bool,
        state: _CandidateRunState,
    ) -> ExecutionCurrentFacts | _CandidateMissing:
        if _current_primary(current) is not None:
            _LOGGER.debug(
                "event=completion-stage-skipped literature_id=%s stage=acquisition "
                "reason=primary-pdf-present",
                literature_id,
            )
            return current
        if current.automatic_pdf_exhaustion is not None:
            _LOGGER.debug(
                "event=completion-exhaustion-found literature_id=%s explicit_retry=%s",
                literature_id,
                str(explicit_retry).lower(),
            )
            exhaustion_result = self._handle_existing_exhaustion(
                literature_id,
                current,
                expected_meta_id=expected_meta_id,
                explicit_retry=explicit_retry,
                state=state,
            )
            if isinstance(exhaustion_result, _CandidateMissing):
                return exhaustion_result
            current = exhaustion_result
            if _current_primary(current) is not None:
                return current
        return self._acquire_missing_primary(
            literature_id,
            current,
            expected_meta_id=expected_meta_id,
            state=state,
        )

    def _handle_existing_exhaustion(
        self,
        literature_id: LiteratureId,
        current: ExecutionCurrentFacts,
        *,
        expected_meta_id: MetaLiteratureId | None,
        explicit_retry: bool,
        state: _CandidateRunState,
    ) -> ExecutionCurrentFacts | _CandidateMissing:
        if not explicit_retry:
            return _CandidateMissing(literature_id)
        if state.explicit_exhaustion_cleared:
            self._fail(literature_id, "acquisition", contract=True)
        expected = _acquisition_expected_facts(current)
        self._commit(
            literature_id,
            "acquisition",
            lambda: self._acquisition.clear_exhaustion_for_explicit_retry(expected),
        )
        _LOGGER.debug(
            "event=completion-exhaustion-cleared literature_id=%s",
            literature_id,
        )
        state.explicit_exhaustion_cleared = True
        refreshed = self._read_current(
            literature_id,
            expected_meta_id=expected_meta_id,
            allow_cancelled=True,
        )
        if refreshed.automatic_pdf_exhaustion is not None:
            self._fail(literature_id, "acquisition", contract=True)
        self._check_cancel(literature_id)
        return refreshed

    def _acquire_missing_primary(
        self,
        literature_id: LiteratureId,
        current: ExecutionCurrentFacts,
        *,
        expected_meta_id: MetaLiteratureId | None,
        state: _CandidateRunState,
    ) -> ExecutionCurrentFacts | _CandidateMissing:
        _LOGGER.debug(
            "event=completion-stage-started literature_id=%s stage=acquisition",
            literature_id,
        )
        request = self._build_acquisition_request(
            literature_id,
            current,
            state.tried_candidate_keys,
        )
        prepared = self._prepare_receipt(
            literature_id=literature_id,
            stage="acquisition",
            prepare=lambda: self._acquisition.prepare_primary_pdf(
                request,
                cancel_event=self._cancel_event,
            ),
            discard=self._acquisition.discard_prepared,
            receipt_type=PreparedAcquisition,
        )
        result = self._commit_receipt(
            literature_id=literature_id,
            stage="acquisition",
            prepared=prepared,
            commit=self._acquisition.commit_primary_pdf,
            discard=self._acquisition.discard_prepared,
        )
        if isinstance(result, NoPrimaryPdf):
            return self._confirm_no_primary_pdf(
                literature_id,
                expected_meta_id=expected_meta_id,
            )
        if not isinstance(result, AcquiredPrimaryPdf):
            self._fail(literature_id, "acquisition", contract=True)
        _LOGGER.debug(
            "event=completion-stage-finished literature_id=%s stage=acquisition "
            "outcome=primary-pdf-acquired",
            literature_id,
        )
        return self._record_acquired_primary(
            literature_id,
            result,
            expected_meta_id=expected_meta_id,
            state=state,
        )

    def _confirm_no_primary_pdf(
        self,
        literature_id: LiteratureId,
        *,
        expected_meta_id: MetaLiteratureId | None,
    ) -> _CandidateMissing:
        exhausted = self._read_current(
            literature_id,
            expected_meta_id=expected_meta_id,
            allow_cancelled=True,
        )
        if _current_primary(exhausted) is not None or exhausted.automatic_pdf_exhaustion is None:
            self._fail(literature_id, "acquisition", contract=True)
        self._check_cancel(literature_id)
        return _CandidateMissing(literature_id)

    def _record_acquired_primary(
        self,
        literature_id: LiteratureId,
        result: AcquiredPrimaryPdf,
        *,
        expected_meta_id: MetaLiteratureId | None,
        state: _CandidateRunState,
    ) -> ExecutionCurrentFacts:
        if result.relation.literature_id != literature_id:
            self._fail(literature_id, "acquisition", contract=True)
        state.tried_candidate_keys.add(result.candidate_key)
        refreshed = self._read_current(
            literature_id,
            expected_meta_id=expected_meta_id,
            allow_cancelled=True,
        )
        primary = _current_primary(refreshed)
        if (
            primary is None
            or primary.asset.asset_id != result.asset.asset_id
            or primary.asset.sha256 != result.asset.sha256
        ):
            self._fail(literature_id, "acquisition", contract=True)
        self._check_cancel(literature_id)
        return refreshed

    def _analyze_current_content(
        self,
        literature_id: LiteratureId,
        current: ExecutionCurrentFacts,
    ) -> NoUsableContent | LiteratureContentProposal:
        _LOGGER.debug(
            "event=completion-stage-started literature_id=%s stage=analysis",
            literature_id,
        )
        analysis_input = self._build_analysis_input(literature_id, current)
        result = self._external(
            literature_id,
            "analysis",
            lambda: self._content().analysis.analyze_content(
                analysis_input,
                cancel_event=self._cancel_event,
            ),
        )
        if not isinstance(result, (NoUsableContent, LiteratureContentProposal)):
            self._fail(literature_id, "analysis", contract=True)
        _LOGGER.debug(
            "event=completion-stage-finished literature_id=%s stage=analysis outcome=%s",
            literature_id,
            "no-usable-content" if isinstance(result, NoUsableContent) else "content-proposed",
        )
        return result

    def _handle_no_usable_content(
        self,
        literature_id: LiteratureId,
        current: ExecutionCurrentFacts,
        decision: NoUsableContent,
        *,
        state: _CandidateRunState,
        no_usable: list[LiteratureId],
        expected_meta_id: MetaLiteratureId | None,
    ) -> _CandidateMissing | None:
        primary = _current_primary(current)
        if primary is None:
            self._fail(literature_id, "analysis", contract=True)
        self._cleanup_no_usable_content(
            literature_id,
            current,
            decision,
            expected_meta_id=expected_meta_id,
        )
        if literature_id not in no_usable:
            no_usable.append(literature_id)
        _LOGGER.debug(
            "event=completion-content-cleaned literature_id=%s reason=no-usable-content",
            literature_id,
        )
        return None

    def _accept_content(
        self,
        literature_id: LiteratureId,
        proposal: LiteratureContentProposal,
        *,
        expected_meta_id: MetaLiteratureId | None,
    ) -> _CandidateGoal:
        _LOGGER.debug(
            "event=completion-stage-started literature_id=%s stage=literature",
            literature_id,
        )
        acceptance = self._commit(
            literature_id,
            "literature",
            lambda: self._content().literature.accept_content(proposal),
        )
        if not isinstance(acceptance, ContentAcceptanceDecision):
            self._fail(literature_id, "literature", contract=True)
        if acceptance.decision != "accepted":
            raise _CandidateFailed(
                literature_id,
                "literature",
                _content_rejected_failure(),
            )
        committed = self._read_current(
            literature_id,
            expected_meta_id=expected_meta_id,
            allow_cancelled=True,
        )
        if not _reaches_goal(committed, "CONTENT_READY"):
            self._fail(literature_id, "literature", contract=True)
        self._check_cancel(literature_id)
        _LOGGER.debug(
            "event=completion-stage-finished literature_id=%s stage=literature "
            "outcome=content-accepted",
            literature_id,
        )
        return _CandidateGoal(literature_id)

    def _ensure_parser_result(
        self,
        literature_id: LiteratureId,
        current: ExecutionCurrentFacts,
        *,
        expected_meta_id: MetaLiteratureId | None,
    ) -> ExecutionCurrentFacts:
        facts = current.current
        primary = _current_primary(current)
        if primary is None:
            self._fail(literature_id, "parsing", contract=True)
        parser_result = facts.current_parser_result
        if parser_result is not None:
            _LOGGER.debug(
                "event=completion-stage-skipped literature_id=%s stage=parsing "
                "reason=parser-result-present",
                literature_id,
            )
            return current

        _LOGGER.debug(
            "event=completion-stage-started literature_id=%s stage=parsing",
            literature_id,
        )
        request = self._build_parser_request(literature_id, current)
        prepared = self._prepare_receipt(
            literature_id=literature_id,
            stage="parsing",
            prepare=lambda: self._content().parsing.prepare_current_primary(
                request,
                cancel_event=self._cancel_event,
            ),
            discard=self._content().parsing.discard_prepared,
            receipt_type=PreparedParsing,
        )
        parsed = self._commit_receipt(
            literature_id=literature_id,
            stage="parsing",
            prepared=prepared,
            commit=self._content().parsing.commit_current_primary,
            discard=self._content().parsing.discard_prepared,
        )
        if not isinstance(parsed, ParserResult):
            self._fail(literature_id, "parsing", contract=True)
        if (
            parsed.source_asset_id != primary.asset.asset_id
            or parsed.source_sha256 != primary.asset.sha256
        ):
            self._fail(literature_id, "parsing", contract=True)
        refreshed = self._read_current(
            literature_id,
            expected_meta_id=expected_meta_id,
            allow_cancelled=True,
        )
        if refreshed.current.current_parser_result != parsed:
            self._fail(literature_id, "parsing", contract=True)
        self._check_cancel(literature_id)
        _LOGGER.debug(
            "event=completion-stage-finished literature_id=%s stage=parsing "
            "outcome=parser-result-committed",
            literature_id,
        )
        return refreshed

    def _cleanup_no_usable_content(
        self,
        literature_id: LiteratureId,
        current: ExecutionCurrentFacts,
        decision: NoUsableContent,
        *,
        expected_meta_id: MetaLiteratureId | None,
    ) -> None:
        facts = current.current
        primary = _current_primary(current)
        parser_result = facts.current_parser_result
        if primary is None or parser_result is None:
            self._fail(literature_id, "analysis", contract=True)
        content_sha256 = (
            None
            if facts.current_content is None
            else facts.current_content.literature_content_sha256
        )
        preparation = (
            None
            if content_sha256 is None
            else self._external(
                literature_id,
                "literature",
                lambda: self._content().literature.prepare_no_usable_content_cleanup(
                    literature_id,
                    content_sha256,
                ),
            )
        )
        if preparation is not None and not isinstance(
            preparation,
            NoUsableContentCleanupPreparation,
        ):
            self._fail(literature_id, "literature", contract=True)
        command = NoUsableContentCleanupCommand(
            decision=decision,
            literature_id=literature_id,
            meta_literature_id=facts.literature.meta_literature_id,
            metadata_revision=facts.metadata_revision,
            metadata_sha256=facts.metadata_sha256,
            primary_asset=primary.asset,
            primary_relation=primary.relation,
            parser_result=parser_result,
            current_content=facts.current_content,
            current_content_lineage=facts.current_content_lineage,
            reference_cleanup=(None if preparation is None else preparation.cleanup),
            reference_closure_token=(
                None if preparation is None else preparation.reference_closure_token
            ),
        )
        result = self._commit(
            literature_id,
            "analysis",
            lambda: self._content().cleanup.cleanup_no_usable_content(command),
        )
        if not isinstance(result, NoUsableContentCleanupResult):
            self._fail(literature_id, "analysis", contract=True)
        if (
            result.literature_id != literature_id
            or result.primary_asset_id != primary.asset.asset_id
        ):
            self._fail(literature_id, "analysis", contract=True)
        cleaned = self._read_current(
            literature_id,
            expected_meta_id=expected_meta_id,
            allow_cancelled=True,
        )
        cleaned_facts = cleaned.current
        if (
            cleaned_facts.metadata_revision != facts.metadata_revision
            or cleaned_facts.metadata_sha256 != facts.metadata_sha256
            or cleaned_facts.current_primary_pdfs
            or cleaned_facts.current_parser_result is not None
            or cleaned_facts.current_content is not None
            or cleaned_facts.current_content_lineage is not None
            or cleaned.automatic_pdf_exhaustion is not None
        ):
            self._fail(literature_id, "analysis", contract=True)
        self._check_cancel(literature_id)

    def _read_current(
        self,
        literature_id: LiteratureId,
        *,
        expected_meta_id: MetaLiteratureId | None,
        allow_cancelled: bool = False,
    ) -> ExecutionCurrentFacts:
        _LOGGER.debug(
            "event=completion-current-facts-read literature_id=%s",
            literature_id,
        )
        snapshot = self._read_exact_snapshot(literature_id, allow_cancelled=allow_cancelled)
        current = snapshot.current_facts[0]
        self._validate_current_alignment(
            literature_id,
            current,
            expected_meta_id=expected_meta_id,
        )
        return current

    def _read_exact_snapshot(
        self,
        literature_id: LiteratureId,
        *,
        allow_cancelled: bool,
    ) -> CurrentFactsSnapshot:
        if not allow_cancelled:
            self._check_cancel(literature_id)
        try:
            snapshot = self._current_facts_reader.read_current(literature_id)
        except KeyboardInterrupt:
            raise _CandidateInterrupted(literature_id) from None
        if (
            not isinstance(snapshot, CurrentFactsSnapshot)
            or snapshot.literature_id != literature_id
            or len(snapshot.current_facts) != 1
        ):
            raise _CandidateFailed(
                literature_id,
                "literature",
                _current_facts_failure(),
            )
        return snapshot

    def _validate_current_alignment(
        self,
        literature_id: LiteratureId,
        current: ExecutionCurrentFacts,
        *,
        expected_meta_id: MetaLiteratureId | None,
    ) -> None:
        facts = current.current
        if facts.literature.literature_id != literature_id:
            self._fail(literature_id, "literature", contract=True)
        if expected_meta_id is not None and facts.literature.meta_literature_id != expected_meta_id:
            raise _CandidateFailed(
                literature_id,
                "literature",
                _stale_current_facts_failure(),
            )
        try:
            status = derive_status(facts)
        except (TypeError, ValueError):
            self._fail(literature_id, "literature", contract=True)
        if status is not facts.literature.status or len(facts.current_primary_pdfs) > 1:
            self._fail(literature_id, "literature", contract=True)
        primary = _current_primary(current)
        if primary is not None and current.automatic_pdf_exhaustion is not None:
            self._fail(literature_id, "literature", contract=True)
        parser_result = facts.current_parser_result
        if parser_result is not None and (
            primary is None
            or parser_result.source_asset_id != primary.asset.asset_id
            or parser_result.source_sha256 != primary.asset.sha256
        ):
            self._fail(literature_id, "literature", contract=True)

    def _build_acquisition_request(
        self,
        literature_id: LiteratureId,
        current: ExecutionCurrentFacts,
        tried_candidate_keys: set[str],
    ) -> AcquisitionRequest:
        request = self._build(
            literature_id,
            "acquisition",
            lambda: self._acquisition_requests.build_acquisition_request(
                current,
                excluded_candidate_keys=frozenset(tried_candidate_keys),
            ),
        )
        if not isinstance(request, AcquisitionRequest):
            self._fail(literature_id, "acquisition", contract=True)
        expected = _acquisition_expected_facts(current)
        if (
            request.literature != current.current.literature
            or request.expected_facts != expected
            or request.excluded_candidate_keys != frozenset(tried_candidate_keys)
        ):
            self._fail(literature_id, "acquisition", contract=True)
        return request

    def _build_parser_request(
        self,
        literature_id: LiteratureId,
        current: ExecutionCurrentFacts,
    ) -> ParserRequest:
        request = self._build(
            literature_id,
            "parsing",
            lambda: self._content().parser_requests.build_parser_request(current),
        )
        primary = _current_primary(current)
        if not isinstance(request, ParserRequest) or primary is None:
            self._fail(literature_id, "parsing", contract=True)
        if (
            request.source_asset_id != primary.asset.asset_id
            or request.source_sha256 != primary.asset.sha256
            or request.media_type != "application/pdf"
        ):
            self._fail(literature_id, "parsing", contract=True)
        return request

    def _build_analysis_input(
        self,
        literature_id: LiteratureId,
        current: ExecutionCurrentFacts,
    ) -> ContentAnalysisInput:
        analysis_input = self._build(
            literature_id,
            "analysis",
            lambda: self._content().analysis_inputs.build_content_analysis_input(current),
        )
        facts = current.current
        primary = _current_primary(current)
        parser_result = facts.current_parser_result
        if (
            not isinstance(analysis_input, ContentAnalysisInput)
            or primary is None
            or parser_result is None
        ):
            self._fail(literature_id, "analysis", contract=True)
        if (
            analysis_input.literature_id != literature_id
            or analysis_input.primary_asset_id != primary.asset.asset_id
            or analysis_input.primary_pdf_sha256 != primary.asset.sha256
            or analysis_input.parser_result != parser_result
            or analysis_input.initial_metadata != facts.literature.metadata
            or analysis_input.input_metadata_revision != facts.metadata_revision
            or analysis_input.input_metadata_sha256 != facts.metadata_sha256
        ):
            self._fail(literature_id, "analysis", contract=True)
        return analysis_input

    def _build(
        self,
        literature_id: LiteratureId,
        stage: CompletionStage,
        operation: Callable[[], _T],
    ) -> _T:
        return self._external(literature_id, stage, operation)

    def _external(
        self,
        literature_id: LiteratureId,
        stage: CompletionStage,
        operation: Callable[[], _T],
    ) -> _T:
        self._check_cancel(literature_id)
        try:
            result = operation()
        except KeyboardInterrupt:
            raise _CandidateInterrupted(literature_id) from None
        except Exception as error:
            translated = self._translate_stage_exception(literature_id, stage, error)
            if translated is error:
                raise
            raise translated from None
        self._check_cancel(literature_id)
        return result

    def _commit(
        self,
        literature_id: LiteratureId,
        stage: CompletionStage,
        operation: Callable[[], _T],
    ) -> _T:
        self._check_cancel(literature_id)
        try:
            return self._commit_executor.execute(
                operation,
                cancel_event=self._cancel_event,
            )
        except CommitNotStarted:
            raise _CandidateInterrupted(literature_id) from None
        except KeyboardInterrupt:
            raise _CandidateInterrupted(literature_id) from None
        except Exception as error:
            translated = self._translate_stage_exception(literature_id, stage, error)
            if translated is error:
                raise
            raise translated from None

    def _prepare_receipt(
        self,
        *,
        literature_id: LiteratureId,
        stage: CompletionStage,
        prepare: Callable[[], _PreparedT],
        discard: Callable[[_PreparedT], None],
        receipt_type: type[_PreparedT],
    ) -> _PreparedT:
        self._check_cancel(literature_id)
        try:
            prepared = prepare()
        except KeyboardInterrupt:
            raise _CandidateInterrupted(literature_id) from None
        except Exception as error:
            translated = self._translate_stage_exception(literature_id, stage, error)
            if translated is error:
                raise
            raise translated from None
        if not isinstance(prepared, receipt_type):
            self._discard_receipt(literature_id, stage, prepared, discard)
            self._fail(literature_id, stage, contract=True)
        try:
            self._check_cancel(literature_id)
        except _CandidateInterrupted:
            self._discard_receipt(literature_id, stage, prepared, discard)
            raise
        return prepared

    def _commit_receipt(
        self,
        *,
        literature_id: LiteratureId,
        stage: CompletionStage,
        prepared: _PreparedT,
        commit: Callable[[_PreparedT], _T],
        discard: Callable[[_PreparedT], None],
    ) -> _T:
        entered = False

        def operation() -> _T:
            nonlocal entered
            entered = True
            return commit(prepared)

        try:
            return self._commit(literature_id, stage, operation)
        except BaseException:
            if not entered:
                self._discard_receipt(literature_id, stage, prepared, discard)
            raise

    def _discard_receipt(
        self,
        literature_id: LiteratureId,
        stage: CompletionStage,
        prepared: _PreparedT,
        discard: Callable[[_PreparedT], None],
    ) -> None:
        try:
            discard(prepared)
        except Exception as error:
            translated = self._translate_discard_exception(literature_id, stage, error)
            if translated is error:
                raise
            raise translated from None

    @staticmethod
    def _translate_discard_exception(
        literature_id: LiteratureId,
        stage: CompletionStage,
        error: Exception,
    ) -> BaseException:
        if isinstance(error, (AcquisitionFailure, ParsingFailure)):
            # Once a receipt exists, failure to release its private staging is
            # a safety failure even if cancellation caused the original exit.
            return _CandidateFailed(literature_id, stage, error.failure)
        if isinstance(error, CompletionStageFailure):
            return _CandidateFailed(literature_id, error.stage, error.failure)
        return error

    def _translate_stage_exception(
        self,
        literature_id: LiteratureId,
        stage: CompletionStage,
        error: Exception,
    ) -> BaseException:
        if isinstance(error, CompletionStageFailure):
            return _CandidateFailed(literature_id, error.stage, error.failure)
        if isinstance(error, NoUsableContentCleanupFailure):
            return _CandidateFailed(literature_id, "analysis", error.failure)
        if isinstance(error, AcquisitionFailure):
            if _is_cancellation_failure(error.failure):
                return _CandidateInterrupted(literature_id)
            return _CandidateFailed(literature_id, "acquisition", error.failure)
        if isinstance(error, ParsingFailure):
            if _is_cancellation_failure(error.failure):
                return _CandidateInterrupted(literature_id)
            return _CandidateFailed(literature_id, "parsing", error.failure)
        if isinstance(error, ContentAnalysisFailure):
            if _is_cancellation_failure(error.failure):
                return _CandidateInterrupted(literature_id)
            return _CandidateFailed(literature_id, "analysis", error.failure)
        if isinstance(error, StalePreconditionError):
            return _CandidateFailed(literature_id, stage, _stale_current_facts_failure())
        return error

    def _check_cancel(self, literature_id: LiteratureId) -> None:
        if self._cancelled():
            raise _CandidateInterrupted(literature_id)

    def _cancelled(self) -> bool:
        return self._cancel_event is not None and self._cancel_event.is_set()

    @staticmethod
    def _fail(
        literature_id: LiteratureId,
        stage: CompletionStage,
        *,
        contract: bool,
    ) -> NoReturn:
        failure = _contract_failure(stage) if contract else _operation_failure(stage)
        raise _CandidateFailed(literature_id, stage, failure)


class AssetCompletionTargetOrchestrator(_CompletionTargetOrchestratorCore):
    """Run the shared target algorithm with Acquisition as the terminal goal."""

    def __init__(
        self,
        *,
        current_facts_reader: CurrentFactsSnapshotReadPort,
        acquisition: AutomaticAcquisitionPort,
        acquisition_requests: AcquisitionRequestFactory,
        commit_executor: CommitExecutor,
        cancel_event: threading.Event | None = None,
    ) -> None:
        super().__init__(
            current_facts_reader=current_facts_reader,
            acquisition=acquisition,
            acquisition_requests=acquisition_requests,
            content_dependencies=None,
            commit_executor=commit_executor,
            cancel_event=cancel_event,
        )

    def run(
        self,
        execution: TransientExecution,
        goal: BatchGoal,
    ) -> TargetOrchestrationResult:
        if goal != "ASSET_READY":
            raise ValueError("asset completion requires ASSET_READY")
        return super().run(execution, goal)


class CompletionTargetOrchestrator(_CompletionTargetOrchestratorCore):
    """Run the shared target algorithm with the complete content extension."""

    def __init__(
        self,
        *,
        current_facts_reader: CurrentFactsSnapshotReadPort,
        acquisition: AutomaticAcquisitionPort,
        acquisition_requests: AcquisitionRequestFactory,
        parsing: ParsingOperationPort,
        parser_requests: ParserRequestFactory,
        analysis: ContentAnalysisPort,
        analysis_inputs: ContentAnalysisInputFactory,
        literature: ContentAcceptancePort,
        cleanup: NoUsableContentCleanupPort,
        commit_executor: CommitExecutor,
        cancel_event: threading.Event | None = None,
    ) -> None:
        super().__init__(
            current_facts_reader=current_facts_reader,
            acquisition=acquisition,
            acquisition_requests=acquisition_requests,
            content_dependencies=_ContentCompletionDependencies(
                parsing=parsing,
                parser_requests=parser_requests,
                analysis=analysis,
                analysis_inputs=analysis_inputs,
                literature=literature,
                cleanup=cleanup,
            ),
            commit_executor=commit_executor,
            cancel_event=cancel_event,
        )


def _current_primary(current: ExecutionCurrentFacts):  # noqa: ANN202
    values = current.current.current_primary_pdfs
    if len(values) != 1:
        return None
    primary = values[0]
    if (
        primary.relation.role is not AssetRole.PRIMARY_PDF
        or primary.relation.literature_id != current.current.literature.literature_id
        or primary.relation.asset_id != primary.asset.asset_id
        or primary.asset.media_type != "application/pdf"
    ):
        return None
    return primary


def _reaches_goal(current: ExecutionCurrentFacts, goal: BatchGoal) -> bool:
    status = derive_status(current.current)
    if goal == "ASSET_READY":
        return status in {LiteratureStatus.ASSET_READY, LiteratureStatus.CONTENT_READY}
    return status is LiteratureStatus.CONTENT_READY


def _acquisition_expected_facts(
    current: ExecutionCurrentFacts,
) -> AcquisitionExpectedFacts:
    facts = current.current
    return AcquisitionExpectedFacts(
        literature_id=facts.literature.literature_id,
        meta_literature_id=facts.literature.meta_literature_id,
        metadata_revision=facts.metadata_revision,
        metadata_sha256=facts.metadata_sha256,
        expected_no_primary_pdf=True,
    )


def _current_facts_failure() -> StableFailure:
    return StableFailure(
        code="completion-current-facts-read",
        reason="The current Literature facts could not be read unambiguously.",
        action="Refresh the local catalog and retry this Literature.",
        retryable=True,
    )


def _stale_current_facts_failure() -> StableFailure:
    return StableFailure(
        code="completion-current-facts-stale",
        reason="The Literature inputs changed before the current stage committed.",
        action="Retry from a fresh database completion snapshot.",
        retryable=False,
    )


def _contract_failure(stage: CompletionStage) -> StableFailure:
    return StableFailure(
        code=f"completion-{stage}-contract",
        reason="A completion component returned an inconsistent typed result.",
        action="Correct the application composition before retrying.",
        retryable=False,
    )


def _operation_failure(stage: CompletionStage) -> StableFailure:
    return StableFailure(
        code=f"completion-{stage}-failed",
        reason="The current completion stage did not finish safely.",
        action="Check the configured component and retry this Literature.",
        retryable=True,
    )


def _content_rejected_failure() -> StableFailure:
    return StableFailure(
        code="completion-literature-content-rejected",
        reason="Literature rejected the proposed content against current facts.",
        action="Refresh the Literature and run content completion again.",
        retryable=False,
    )


def _is_cancellation_failure(failure: StableFailure) -> bool:
    """Recognize only module-owned, stable cancellation codes.

    Entry must not infer cancellation from a concurrently-set Event: a real
    storage/network failure may race with user cancellation and must retain its
    typed failure in the report.
    """

    return failure.code in {
        "acquisition-interrupted",
        "acquisition-authorized-cancelled",
        "acquisition-configured-sci-hub-cancelled",
        "acquisition-browser-cancelled-failed",
        "parsing-cancelled",
        "analysis-content-cancelled",
    }


__all__ = (
    "AcquisitionRequestFactory",
    "AssetCompletionTargetOrchestrator",
    "AutomaticAcquisitionPort",
    "CommitExecutor",
    "CommitNotStarted",
    "CompletionStageFailure",
    "CompletionTargetOrchestrator",
    "ContentAcceptancePort",
    "ContentAnalysisInputFactory",
    "ContentAnalysisPort",
    "ParserRequestFactory",
    "ParsingOperationPort",
    "TargetOrchestrationResult",
)
