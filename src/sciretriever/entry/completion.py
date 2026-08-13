"""Database-completion operation over one frozen, process-local target tuple."""

from __future__ import annotations

import threading
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from types import TracebackType
from typing import TypeVar

from sciretriever.entry.execution import (
    ExecutionSnapshotError,
    TransientExecution,
    TransientLiteratureExecution,
    TransientMetaExecution,
    execute_database_write,
    freeze_execution,
)
from sciretriever.entry.orchestration import (
    AcquisitionRequestFactory,
    AssetCompletionTargetOrchestrator,
    AutomaticAcquisitionPort,
    CommitNotStarted,
    CompletionTargetOrchestrator,
    ContentAcceptancePort,
    ContentAnalysisInputFactory,
    ContentAnalysisPort,
    ParserRequestFactory,
    ParsingOperationPort,
    TargetOrchestrationResult,
)
from sciretriever.entry.ports import (
    CurrentFactsSnapshotReadPort,
    DiscoveryRunRecoveryPort,
    NoUsableContentCleanupPort,
    SelectorSnapshotReadPort,
    WriteAdmissionFailure,
    WriteAdmissionPort,
)
from sciretriever.model.execution import BatchRequest
from sciretriever.model.report import (
    DatabaseCompletionReport,
    FailedCompletionTarget,
    FailedReportEnd,
    FinishedReportEnd,
    GoalReachedTarget,
    InterruptedCompletionTarget,
    InterruptedReportEnd,
    NeedsManualPdfTarget,
    NotStartedCompletionTarget,
    StableFailure,
)

_T = TypeVar("_T")
_TargetOrchestrator = CompletionTargetOrchestrator | AssetCompletionTargetOrchestrator


class _SerialCommitExecutor:
    """One operation-scoped queue whose worker is the sole commit entrant."""

    def __init__(self) -> None:
        self._state_lock = threading.Lock()
        self._executor: ThreadPoolExecutor | None = None
        self._worker_ident: int | None = None

    def __enter__(self) -> _SerialCommitExecutor:
        with self._state_lock:
            if self._executor is not None:
                raise RuntimeError("commit executor is already running")
            self._worker_ident = None
            self._executor = ThreadPoolExecutor(
                max_workers=1,
                thread_name_prefix="sciretriever-commit",
            )
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool:
        del exc_type, exc_value, traceback
        with self._state_lock:
            executor = self._executor
            self._executor = None
        if executor is not None:
            executor.shutdown(wait=True, cancel_futures=False)
        self._worker_ident = None
        return False

    def execute(
        self,
        operation: Callable[[], _T],
        *,
        cancel_event: threading.Event | None = None,
    ) -> _T:
        if not callable(operation):
            raise TypeError("operation must be callable")
        if cancel_event is not None and not isinstance(cancel_event, threading.Event):
            raise TypeError("cancel_event must be a threading.Event or None")
        if threading.get_ident() == self._worker_ident:
            raise RuntimeError("recursive commit execution is not allowed")
        if cancel_event is not None and cancel_event.is_set():
            raise CommitNotStarted("commit was cancelled before enqueue")
        with self._state_lock:
            executor = self._executor
            if executor is None:
                raise RuntimeError("commit executor is not running")
            future = executor.submit(self._run, operation, cancel_event)
        return future.result()

    def _run(
        self,
        operation: Callable[[], _T],
        cancel_event: threading.Event | None,
    ) -> _T:
        self._worker_ident = threading.get_ident()
        if cancel_event is not None and cancel_event.is_set():
            raise CommitNotStarted("commit was cancelled before start")
        return operation()


@dataclass(frozen=True, slots=True)
class _RunResult:
    results: tuple[TargetOrchestrationResult | NotStartedCompletionTarget, ...]
    interrupted: bool


class _CompletionScheduler:
    """Bound target work and preserve one exhaustive frozen-order partition."""

    def __init__(
        self,
        *,
        targets: tuple[TransientExecution, ...],
        request: BatchRequest,
        orchestrator: _TargetOrchestrator,
        max_concurrency: int,
        cancel_event: threading.Event,
    ) -> None:
        self._targets = targets
        self._request = request
        self._orchestrator = orchestrator
        self._max_concurrency = max_concurrency
        self._cancel_event = cancel_event
        self._results: list[TargetOrchestrationResult | NotStartedCompletionTarget | None] = [
            None
        ] * len(targets)
        self._next_index = 0
        self._interrupted = False

    def run(self) -> _RunResult:
        if not self._targets:
            return _RunResult(results=(), interrupted=self._interrupted)
        if self._cancel_event.is_set():
            self._interrupted = True
        with ThreadPoolExecutor(
            max_workers=self._max_concurrency,
            thread_name_prefix="sciretriever-completion",
        ) as executor:
            futures: dict[Future[TargetOrchestrationResult | NotStartedCompletionTarget], int] = {}
            self._submit_available(executor, futures)
            while futures:
                done = self._wait_for_done(futures)
                self._cancel_queued(futures)
                self._collect_done(futures, done)
                self._submit_available(executor, futures)
        return self._finalize()

    def _submit_available(
        self,
        executor: ThreadPoolExecutor,
        futures: dict[Future[TargetOrchestrationResult | NotStartedCompletionTarget], int],
    ) -> None:
        while (
            not self._cancel_event.is_set()
            and len(futures) < self._max_concurrency
            and self._next_index < len(self._targets)
        ):
            index = self._next_index
            self._next_index += 1
            future = executor.submit(self._run_target, index)
            futures[future] = index

    def _run_target(
        self,
        index: int,
    ) -> TargetOrchestrationResult | NotStartedCompletionTarget:
        """Linearize true target start before any current-facts or external work."""

        execution = self._targets[index]
        if self._cancel_event.is_set():
            return NotStartedCompletionTarget(target=execution.target)
        return self._orchestrator.run(execution, self._request.goal)

    def _wait_for_done(
        self,
        futures: dict[Future[TargetOrchestrationResult | NotStartedCompletionTarget], int],
    ) -> set[Future[TargetOrchestrationResult | NotStartedCompletionTarget]]:
        try:
            done, _ = wait(
                tuple(futures),
                timeout=0.05,
                return_when=FIRST_COMPLETED,
            )
        except KeyboardInterrupt:
            self._interrupt_operation()
            return set()
        return done

    def _cancel_queued(
        self,
        futures: dict[Future[TargetOrchestrationResult | NotStartedCompletionTarget], int],
    ) -> None:
        if not self._cancel_event.is_set():
            return
        cancelled_any = False
        for future, index in tuple(futures.items()):
            if future.cancel():
                cancelled_any = True
                self._results[index] = NotStartedCompletionTarget(
                    target=self._targets[index].target
                )
                futures.pop(future)
        if cancelled_any:
            self._interrupted = True

    def _collect_done(
        self,
        futures: dict[Future[TargetOrchestrationResult | NotStartedCompletionTarget], int],
        done: set[Future[TargetOrchestrationResult | NotStartedCompletionTarget]],
    ) -> None:
        for future in done:
            index = futures.pop(future, None)
            if index is not None:
                result = self._future_result(future, index)
                self._results[index] = result
                if isinstance(result, NotStartedCompletionTarget) or isinstance(
                    result.outcome, InterruptedCompletionTarget
                ):
                    self._interrupted = True

    def _future_result(
        self,
        future: Future[TargetOrchestrationResult | NotStartedCompletionTarget],
        index: int,
    ) -> TargetOrchestrationResult | NotStartedCompletionTarget:
        try:
            return future.result()
        except KeyboardInterrupt:
            self._interrupt_operation()
            return _interrupted_target(self._targets[index])

    def _interrupt_operation(self) -> None:
        self._interrupted = True
        self._cancel_event.set()

    def _finalize(self) -> _RunResult:
        for index in range(self._next_index, len(self._targets)):
            self._results[index] = NotStartedCompletionTarget(target=self._targets[index].target)
        if any(result is None for result in self._results):
            raise RuntimeError("completion target partition is incomplete")
        return _RunResult(
            results=tuple(result for result in self._results if result is not None),
            interrupted=self._interrupted,
        )


class DatabaseCompletionOperation:
    """Freeze a selector once and return five exhaustive target partitions.

    Up to ``max_concurrency`` target workers may overlap external work.  Every
    persistent commit enters the one operation-scoped serial executor.
    """

    __slots__ = (
        "_selector_reader",
        "_current_facts_reader",
        "_write_admission",
        "_recovery",
        "_acquisition",
        "_acquisition_requests",
        "_parsing",
        "_parser_requests",
        "_analysis",
        "_analysis_inputs",
        "_literature",
        "_cleanup",
        "_max_concurrency",
        "_cancel_event",
    )

    def __init__(
        self,
        *,
        selector_reader: SelectorSnapshotReadPort,
        current_facts_reader: CurrentFactsSnapshotReadPort,
        write_admission: WriteAdmissionPort,
        recovery: DiscoveryRunRecoveryPort,
        acquisition: AutomaticAcquisitionPort,
        acquisition_requests: AcquisitionRequestFactory,
        parsing: ParsingOperationPort,
        parser_requests: ParserRequestFactory,
        analysis: ContentAnalysisPort,
        analysis_inputs: ContentAnalysisInputFactory,
        literature: ContentAcceptancePort,
        cleanup: NoUsableContentCleanupPort,
        max_concurrency: int = 1,
        cancel_event: threading.Event | None = None,
    ) -> None:
        checks = (
            (
                isinstance(selector_reader, SelectorSnapshotReadPort),
                "selector_reader must implement selector snapshot reads",
            ),
            (
                isinstance(current_facts_reader, CurrentFactsSnapshotReadPort),
                "current_facts_reader must implement current-facts reads",
            ),
            (
                isinstance(write_admission, WriteAdmissionPort),
                "write_admission must implement write admission",
            ),
            (
                isinstance(recovery, DiscoveryRunRecoveryPort),
                "recovery must implement discovery recovery",
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
                isinstance(parsing, ParsingOperationPort),
                "parsing must implement current-primary parsing",
            ),
            (
                isinstance(parser_requests, ParserRequestFactory),
                "parser_requests must implement request construction",
            ),
            (
                isinstance(analysis, ContentAnalysisPort),
                "analysis must implement content analysis",
            ),
            (
                isinstance(analysis_inputs, ContentAnalysisInputFactory),
                "analysis_inputs must implement input construction",
            ),
            (
                isinstance(literature, ContentAcceptancePort),
                "literature must implement content acceptance",
            ),
            (
                isinstance(cleanup, NoUsableContentCleanupPort),
                "cleanup must implement no-content cleanup",
            ),
        )
        for valid, message in checks:
            if not valid:
                raise TypeError(message)
        if type(max_concurrency) is not int or max_concurrency < 1:
            raise ValueError("max_concurrency must be a positive integer")
        if cancel_event is not None and not isinstance(cancel_event, threading.Event):
            raise TypeError("cancel_event must be a threading.Event or None")
        self._selector_reader = selector_reader
        self._current_facts_reader = current_facts_reader
        self._write_admission = write_admission
        self._recovery = recovery
        self._acquisition = acquisition
        self._acquisition_requests = acquisition_requests
        self._parsing = parsing
        self._parser_requests = parser_requests
        self._analysis = analysis
        self._analysis_inputs = analysis_inputs
        self._literature = literature
        self._cleanup = cleanup
        self._max_concurrency = max_concurrency
        # ``None`` means an invocation-local event.  Keep a caller-supplied
        # event by identity because its lifecycle is owned by the caller.
        self._cancel_event = cancel_event

    def __call__(self, request: BatchRequest) -> DatabaseCompletionReport:
        if not isinstance(request, BatchRequest):
            raise TypeError("request must be BatchRequest")
        operation_cancel_event = self._cancel_event or threading.Event()
        frozen: tuple[TransientExecution, ...] = ()
        run: _RunResult | None = None

        def prepare() -> tuple[TransientExecution, ...]:
            nonlocal frozen
            snapshot = self._selector_reader.read_selector(request.selector)
            frozen = freeze_execution(request, snapshot)
            return frozen

        def execute(targets: tuple[TransientExecution, ...]) -> _RunResult:
            nonlocal run
            run = self._run_frozen(
                targets,
                request,
                cancel_event=operation_cancel_event,
            )
            return run

        try:
            execute_database_write(
                admission=self._write_admission,
                recovery=self._recovery,
                prepare=prepare,
                execute=execute,
            )
        except KeyboardInterrupt:
            operation_cancel_event.set()
            return _report(
                request,
                tuple(NotStartedCompletionTarget(target=execution.target) for execution in frozen),
                interrupted=True,
            )
        except ExecutionSnapshotError:
            return _operation_failed_report(request, frozen)
        except WriteAdmissionFailure as error:
            if run is None:
                return _write_admission_failed_report(request, frozen, error.failure)
            return _report(
                request,
                run.results,
                interrupted=run.interrupted,
                failure=error.failure,
            )
        if run is None:
            raise AssertionError("completion execution returned no run result")
        return _report(request, run.results, interrupted=run.interrupted)

    def _run_frozen(
        self,
        targets: tuple[TransientExecution, ...],
        request: BatchRequest,
        *,
        cancel_event: threading.Event,
    ) -> _RunResult:
        with _SerialCommitExecutor() as commit_executor:
            orchestrator = CompletionTargetOrchestrator(
                current_facts_reader=self._current_facts_reader,
                acquisition=self._acquisition,
                acquisition_requests=self._acquisition_requests,
                parsing=self._parsing,
                parser_requests=self._parser_requests,
                analysis=self._analysis,
                analysis_inputs=self._analysis_inputs,
                literature=self._literature,
                cleanup=self._cleanup,
                commit_executor=commit_executor,
                cancel_event=cancel_event,
            )
            return _CompletionScheduler(
                targets=targets,
                request=request,
                orchestrator=orchestrator,
                max_concurrency=self._max_concurrency,
                cancel_event=cancel_event,
            ).run()
        raise AssertionError("commit executor scope completed without a run result")


class AssetDatabaseCompletionOperation(DatabaseCompletionOperation):
    """The same frozen scheduler and report closure with no content capability."""

    __slots__ = ()

    def __init__(
        self,
        *,
        selector_reader: SelectorSnapshotReadPort,
        current_facts_reader: CurrentFactsSnapshotReadPort,
        write_admission: WriteAdmissionPort,
        recovery: DiscoveryRunRecoveryPort,
        acquisition: AutomaticAcquisitionPort,
        acquisition_requests: AcquisitionRequestFactory,
        max_concurrency: int = 1,
        cancel_event: threading.Event | None = None,
    ) -> None:
        checks = (
            (
                isinstance(selector_reader, SelectorSnapshotReadPort),
                "selector_reader must implement selector snapshot reads",
            ),
            (
                isinstance(current_facts_reader, CurrentFactsSnapshotReadPort),
                "current_facts_reader must implement current-facts reads",
            ),
            (
                isinstance(write_admission, WriteAdmissionPort),
                "write_admission must implement write admission",
            ),
            (
                isinstance(recovery, DiscoveryRunRecoveryPort),
                "recovery must implement discovery recovery",
            ),
            (
                isinstance(acquisition, AutomaticAcquisitionPort),
                "acquisition must implement automatic acquisition",
            ),
            (
                isinstance(acquisition_requests, AcquisitionRequestFactory),
                "acquisition_requests must implement request construction",
            ),
        )
        for valid, message in checks:
            if not valid:
                raise TypeError(message)
        if type(max_concurrency) is not int or max_concurrency < 1:
            raise ValueError("max_concurrency must be a positive integer")
        if cancel_event is not None and not isinstance(cancel_event, threading.Event):
            raise TypeError("cancel_event must be a threading.Event or None")
        self._selector_reader = selector_reader
        self._current_facts_reader = current_facts_reader
        self._write_admission = write_admission
        self._recovery = recovery
        self._acquisition = acquisition
        self._acquisition_requests = acquisition_requests
        self._max_concurrency = max_concurrency
        self._cancel_event = cancel_event

    def __call__(self, request: BatchRequest) -> DatabaseCompletionReport:
        if not isinstance(request, BatchRequest):
            raise TypeError("request must be BatchRequest")
        if request.goal != "ASSET_READY":
            raise ValueError("asset completion requires ASSET_READY")
        return super().__call__(request)

    def _run_frozen(
        self,
        targets: tuple[TransientExecution, ...],
        request: BatchRequest,
        *,
        cancel_event: threading.Event,
    ) -> _RunResult:
        with _SerialCommitExecutor() as commit_executor:
            orchestrator = AssetCompletionTargetOrchestrator(
                current_facts_reader=self._current_facts_reader,
                acquisition=self._acquisition,
                acquisition_requests=self._acquisition_requests,
                commit_executor=commit_executor,
                cancel_event=cancel_event,
            )
            return _CompletionScheduler(
                targets=targets,
                request=request,
                orchestrator=orchestrator,
                max_concurrency=self._max_concurrency,
                cancel_event=cancel_event,
            ).run()
        raise AssertionError("commit executor scope completed without a run result")


def _interrupted_target(execution: TransientExecution) -> TargetOrchestrationResult:
    return TargetOrchestrationResult(
        outcome=InterruptedCompletionTarget(
            target=execution.target,
            literature_id=_first_literature_id(execution),
        )
    )


def _first_literature_id(execution: TransientExecution):  # noqa: ANN202
    if isinstance(execution, TransientLiteratureExecution):
        return execution.candidate.literature_id
    if isinstance(execution, TransientMetaExecution):
        return execution.candidates[0].literature_id
    raise TypeError("execution must be a transient completion execution")


def _operation_failed_report(
    request: BatchRequest,
    frozen: tuple[TransientExecution, ...],
) -> DatabaseCompletionReport:
    return DatabaseCompletionReport(
        kind="database-completion",
        end=FailedReportEnd(
            kind="failed",
            failure=StableFailure(
                code="completion-operation-failed",
                reason="The database completion operation could not freeze or run safely.",
                action="Check the local catalog and retry the operation.",
                retryable=True,
            ),
        ),
        goal=request.goal,
        goal_reached=(),
        needs_manual_pdf=(),
        failed=(),
        interrupted=(),
        not_started=tuple(
            NotStartedCompletionTarget(target=execution.target) for execution in frozen
        ),
        no_usable_content_literature_ids=(),
    )


def _report(
    request: BatchRequest,
    results: tuple[TargetOrchestrationResult | NotStartedCompletionTarget, ...],
    *,
    interrupted: bool,
    failure: StableFailure | None = None,
) -> DatabaseCompletionReport:
    goal_reached: list[GoalReachedTarget] = []
    needs_manual_pdf: list[NeedsManualPdfTarget] = []
    failed: list[FailedCompletionTarget] = []
    interrupted_targets: list[InterruptedCompletionTarget] = []
    not_started: list[NotStartedCompletionTarget] = []
    no_usable_content_ids = []
    for result in results:
        if isinstance(result, NotStartedCompletionTarget):
            not_started.append(result)
            continue
        outcome = result.outcome
        if isinstance(outcome, GoalReachedTarget):
            goal_reached.append(outcome)
        elif isinstance(outcome, NeedsManualPdfTarget):
            needs_manual_pdf.append(outcome)
        elif isinstance(outcome, FailedCompletionTarget):
            failed.append(outcome)
        elif isinstance(outcome, InterruptedCompletionTarget):
            interrupted_targets.append(outcome)
        else:
            raise TypeError("target orchestration result has an invalid outcome")
        for literature_id in result.no_usable_content_literature_ids:
            if literature_id not in no_usable_content_ids:
                no_usable_content_ids.append(literature_id)

    end = (
        FailedReportEnd(kind="failed", failure=failure)
        if failure is not None
        else InterruptedReportEnd(kind="interrupted")
        if interrupted
        else FinishedReportEnd(kind="finished")
    )
    return DatabaseCompletionReport(
        kind="database-completion",
        end=end,
        goal=request.goal,
        goal_reached=tuple(goal_reached),
        needs_manual_pdf=tuple(needs_manual_pdf),
        failed=tuple(failed),
        interrupted=tuple(interrupted_targets),
        not_started=tuple(not_started),
        no_usable_content_literature_ids=tuple(no_usable_content_ids),
    )


def _write_admission_failed_report(
    request: BatchRequest,
    frozen: tuple[TransientExecution, ...],
    failure: StableFailure,
) -> DatabaseCompletionReport:
    report = _operation_failed_report(request, frozen)
    return report.model_copy(update={"end": FailedReportEnd(kind="failed", failure=failure)})


__all__ = ("DatabaseCompletionOperation",)
