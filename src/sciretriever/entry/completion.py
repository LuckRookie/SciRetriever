"""Database-completion operation over one frozen, process-local target tuple."""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from contextlib import contextmanager
from dataclasses import dataclass
from types import TracebackType
from typing import Protocol, TypeVar

from sciretriever.acquisition.api import (
    AcquisitionExpectedFacts,
    AcquisitionFailure,
    AcquisitionProgressObserver,
    AcquisitionProgressSnapshot,
    AcquisitionRequest,
    BrowserEscalationObserver,
    BrowserEscalationSummary,
    CohortPreparationItem,
    CohortPreparationObserver,
    PreparedAcquisition,
    PreparedAcquisitionCohort,
)
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
from sciretriever.logging.api import get_logger
from sciretriever.model.acquisition import AcquisitionResult
from sciretriever.model.execution import BatchGoal, BatchRequest
from sciretriever.model.primitives import LiteratureId
from sciretriever.model.report import (
    DatabaseCompletionReport,
    FailedCompletionTarget,
    FailedReportEnd,
    FinishedReportEnd,
    GoalReachedTarget,
    InterruptedCompletionTarget,
    InterruptedReportEnd,
    LiteratureCompletionTarget,
    MetaLiteratureCompletionTarget,
    NeedsManualPdfTarget,
    NotStartedCompletionTarget,
    StableFailure,
)

_T = TypeVar("_T")
_LOGGER = get_logger(__name__)


class _TargetOrchestrator(Protocol):
    def run(
        self,
        execution: TransientExecution,
        goal: BatchGoal,
    ) -> TargetOrchestrationResult: ...


_ParticipantKey = tuple[str, str]
_CohortOutcome = PreparedAcquisition | BaseException


@dataclass(frozen=True, slots=True)
class _CohortCleanupFailure:
    participant_key: _ParticipantKey
    literature_id: LiteratureId
    error: BaseException


class _CohortAcquisitionPort:
    """Batch target-local prepare calls without moving the serial commit boundary."""

    def __init__(
        self,
        *,
        acquisition: AutomaticAcquisitionPort,
        participant_keys: tuple[_ParticipantKey, ...],
        cancel_event: threading.Event,
    ) -> None:
        if not isinstance(acquisition, AutomaticAcquisitionPort):
            raise TypeError("acquisition must implement automatic acquisition")
        if not isinstance(participant_keys, tuple) or any(
            not _valid_participant_key(key) for key in participant_keys
        ):
            raise TypeError("participant_keys must contain stable target identities")
        if len(participant_keys) != len(set(participant_keys)):
            raise ValueError("cohort participant keys must be unique")
        if not isinstance(cancel_event, threading.Event):
            raise TypeError("cancel_event must be a threading.Event")
        self._acquisition = acquisition
        self._cancel_event = cancel_event
        self._condition = threading.Condition()
        self._local = threading.local()
        self._order = {key: index for index, key in enumerate(participant_keys)}
        self._active = set(participant_keys)
        self._generation = 0
        self._requests: dict[_ParticipantKey, AcquisitionRequest] = {}
        self._outcomes: dict[tuple[int, _ParticipantKey], _CohortOutcome] = {}
        self._abandoned: set[tuple[int, _ParticipantKey]] = set()
        self._delivery_order: dict[int, tuple[_ParticipantKey, ...]] = {}
        self._delivery_index: dict[int, int] = {}
        self._receipt_tokens: dict[PreparedAcquisition, tuple[int, _ParticipantKey]] = {}
        self._cleanup_failures: dict[tuple[int, _ParticipantKey], _CohortCleanupFailure] = {}
        self._batch_executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="sciretriever-entry-acquisition-cohort",
        )
        self._batch_futures: list[Future[None]] = []
        self._closed = False
        self._running = False

    @contextmanager
    def participant(self, key: _ParticipantKey) -> Iterator[None]:
        if not _valid_participant_key(key):
            raise TypeError("participant key must be a stable target identity")
        if getattr(self._local, "participant_key", None) is not None:
            raise RuntimeError("completion cohort participant is already bound")
        with self._condition:
            if key not in self._active:
                raise RuntimeError("completion cohort participant is not active")
        self._local.participant_key = key
        try:
            yield
        finally:
            del self._local.participant_key
            self.abandon(key)

    def abandon(self, key: _ParticipantKey) -> None:
        """Remove a completed or never-started target from future cohort rounds."""

        batch: tuple[int, tuple[tuple[_ParticipantKey, AcquisitionRequest], ...]] | None
        with self._condition:
            if key not in self._active:
                return
            self._active.remove(key)
            if self._running and key in self._requests:
                self._abandoned.add((self._generation, key))
            else:
                self._requests.pop(key, None)
            batch = self._start_ready_batch_locked()
            self._condition.notify_all()
        if batch is not None:
            self._launch_batch(batch)

    def prepare_primary_pdf(
        self,
        request: AcquisitionRequest,
        *,
        cancel_event: threading.Event | None = None,
    ) -> PreparedAcquisition:
        if not isinstance(request, AcquisitionRequest):
            raise TypeError("request must be AcquisitionRequest")
        if cancel_event is not None and cancel_event is not self._cancel_event:
            raise ValueError("cohort preparation must use the operation cancellation event")
        key = self._current_participant()
        batch: tuple[int, tuple[tuple[_ParticipantKey, AcquisitionRequest], ...]] | None
        with self._condition:
            while self._running or key in self._requests:
                self._condition.wait()
            if key not in self._active:
                raise RuntimeError("completion cohort participant is no longer active")
            generation = self._generation
            self._requests[key] = request
            batch = self._start_ready_batch_locked()
        if batch is not None:
            self._launch_batch(batch)
        token = (generation, key)
        try:
            outcome = self._await_outcome(token)
        except BaseException:
            self._abandon_waiting_request(generation, key)
            raise
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    def _await_outcome(
        self,
        token: tuple[int, _ParticipantKey],
    ) -> _CohortOutcome:
        with self._condition:
            while token not in self._cleanup_failures and (
                token not in self._outcomes or not self._delivery_ready_locked(token)
            ):
                self._condition.wait()
            cleanup_failure = self._cleanup_failures.pop(token, None)
            if cleanup_failure is not None:
                return cleanup_failure.error
            outcome = self._outcomes.pop(token)
            if isinstance(outcome, PreparedAcquisition):
                self._receipt_tokens[outcome] = token
            else:
                self._complete_delivery_locked(token)
            return outcome

    def take_cleanup_failures(self) -> tuple[_CohortCleanupFailure, ...]:
        """Return unconsumed cleanup failures in deterministic participant order."""

        with self._condition:
            failures = tuple(
                failure
                for _token, failure in sorted(
                    self._cleanup_failures.items(),
                    key=lambda item: (item[0][0], self._order[item[0][1]]),
                )
            )
            self._cleanup_failures.clear()
        return failures

    def close(self) -> None:
        """Join the operation-local coordinator before inspecting cleanup state."""

        with self._condition:
            if self._closed:
                return
            self._closed = True
            futures = tuple(self._batch_futures)
        self._batch_executor.shutdown(wait=True)
        for future in futures:
            future.result()

    def prepare_primary_pdf_cohort(
        self,
        requests: tuple[AcquisitionRequest, ...],
        *,
        cancel_event: threading.Event | None = None,
        on_prepared: CohortPreparationObserver | None = None,
        on_progress: AcquisitionProgressObserver | None = None,
        on_browser_escalation: BrowserEscalationObserver | None = None,
    ) -> PreparedAcquisitionCohort:
        return self._acquisition.prepare_primary_pdf_cohort(
            requests,
            cancel_event=cancel_event,
            on_prepared=on_prepared,
            on_progress=on_progress,
            on_browser_escalation=on_browser_escalation,
        )

    def commit_primary_pdf(self, prepared: PreparedAcquisition) -> AcquisitionResult:
        try:
            return self._acquisition.commit_primary_pdf(prepared)
        finally:
            self._complete_receipt_delivery(prepared)

    def discard_prepared(self, prepared: PreparedAcquisition) -> None:
        try:
            self._acquisition.discard_prepared(prepared)
        finally:
            self._complete_receipt_delivery(prepared)

    def clear_exhaustion_for_explicit_retry(
        self,
        expected_facts: AcquisitionExpectedFacts,
    ) -> None:
        self._acquisition.clear_exhaustion_for_explicit_retry(expected_facts)

    def _current_participant(self) -> _ParticipantKey:
        key = getattr(self._local, "participant_key", None)
        if not _valid_participant_key(key):
            raise RuntimeError("cohort preparation must run inside a target participant")
        if not isinstance(key, tuple) or len(key) != 2:
            raise RuntimeError("cohort participant identity is invalid")
        kind, identity = key
        if type(kind) is not str or type(identity) is not str:
            raise RuntimeError("cohort participant identity is invalid")
        return kind, identity

    def _start_ready_batch_locked(
        self,
    ) -> tuple[int, tuple[tuple[_ParticipantKey, AcquisitionRequest], ...]] | None:
        if self._running or not self._requests or set(self._requests) != self._active:
            return None
        self._running = True
        return (
            self._generation,
            tuple(
                sorted(
                    self._requests.items(),
                    key=lambda item: self._order[item[0]],
                )
            ),
        )

    def _launch_batch(
        self,
        batch: tuple[int, tuple[tuple[_ParticipantKey, AcquisitionRequest], ...]],
    ) -> None:
        with self._condition:
            if self._closed:
                raise RuntimeError("completion cohort coordinator is closed")
            future = self._batch_executor.submit(self._run_batch, *batch)
            self._batch_futures.append(future)

    def _run_batch(
        self,
        generation: int,
        indexed_requests: tuple[tuple[_ParticipantKey, AcquisitionRequest], ...],
    ) -> None:
        requests = tuple(request for _key, request in indexed_requests)
        emitted: dict[_ParticipantKey, CohortPreparationItem] = {}
        literature_ids = {
            key: request.literature.literature_id for key, request in indexed_requests
        }

        def publish_prepared(items: tuple[CohortPreparationItem, ...]) -> None:
            observed = self._map_observed_items(
                indexed_requests,
                items,
                emitted,
            )
            self._publish_batch_outcomes(
                generation,
                tuple((key, outcome) for key, _item, outcome in observed),
                literature_ids=literature_ids,
                final=False,
                emitted_keys=(),
            )
            for key, item, _outcome in observed:
                emitted[key] = item

        outcomes: tuple[tuple[_ParticipantKey, _CohortOutcome], ...] = ()
        try:
            try:
                prepared = self._acquisition.prepare_primary_pdf_cohort(
                    requests,
                    cancel_event=self._cancel_event,
                    on_prepared=publish_prepared,
                    on_progress=_log_acquisition_progress,
                    on_browser_escalation=_log_browser_escalation,
                )
                outcomes = self._map_batch_outcomes(
                    indexed_requests,
                    prepared,
                    emitted,
                )
            except BaseException as error:
                outcomes = tuple(
                    (key, _clone_cohort_error(error))
                    for key, _request in indexed_requests
                    if key not in emitted
                )
            self._publish_batch_outcomes(
                generation,
                outcomes,
                literature_ids=literature_ids,
                final=True,
                emitted_keys=tuple(emitted),
            )
        except BaseException as error:
            cleanup_error = self._discard_outcome_receipts(outcomes)
            terminal_error = error if cleanup_error is None else cleanup_error
            self._abort_batch_after_coordinator_error(
                generation,
                indexed_requests,
                emitted,
                terminal_error,
            )
            raise terminal_error

    def _discard_outcome_receipts(
        self,
        outcomes: tuple[tuple[_ParticipantKey, _CohortOutcome], ...],
    ) -> BaseException | None:
        first_failure: BaseException | None = None
        for _key, outcome in outcomes:
            if not isinstance(outcome, PreparedAcquisition):
                continue
            try:
                self._acquisition.discard_prepared(outcome)
            except BaseException as error:
                first_failure = first_failure or error
        return first_failure

    def _abort_batch_after_coordinator_error(
        self,
        generation: int,
        indexed_requests: tuple[tuple[_ParticipantKey, AcquisitionRequest], ...],
        emitted: dict[_ParticipantKey, CohortPreparationItem],
        error: BaseException,
    ) -> None:
        delivery_keys: list[_ParticipantKey] = []
        with self._condition:
            if generation != self._generation or not self._running:
                self._condition.notify_all()
                return
            for key, _request in indexed_requests:
                token = (generation, key)
                if key in emitted:
                    self._abandoned.discard(token)
                    continue
                if token in self._abandoned:
                    self._abandoned.remove(token)
                    continue
                if token in self._outcomes or token in self._cleanup_failures:
                    continue
                self._outcomes[token] = _clone_cohort_error(error)
                delivery_keys.append(key)
            if delivery_keys:
                existing_order = self._delivery_order.get(generation)
                if existing_order is None:
                    self._delivery_order[generation] = tuple(delivery_keys)
                    self._delivery_index[generation] = 0
                else:
                    self._delivery_order[generation] = existing_order + tuple(delivery_keys)
            self._requests.clear()
            self._running = False
            self._generation += 1
            self._condition.notify_all()

    def _publish_batch_outcomes(
        self,
        generation: int,
        outcomes: tuple[tuple[_ParticipantKey, _CohortOutcome], ...],
        *,
        literature_ids: dict[_ParticipantKey, LiteratureId],
        final: bool,
        emitted_keys: tuple[_ParticipantKey, ...],
    ) -> None:
        discarded: list[
            tuple[
                tuple[int, _ParticipantKey],
                LiteratureId,
                PreparedAcquisition,
            ]
        ] = []
        delivery_keys: list[_ParticipantKey] = []
        with self._condition:
            for key, outcome in outcomes:
                token = (generation, key)
                if token in self._abandoned:
                    self._abandoned.remove(token)
                    if isinstance(outcome, PreparedAcquisition):
                        discarded.append((token, literature_ids[key], outcome))
                else:
                    self._outcomes[token] = outcome
                    delivery_keys.append(key)
            if delivery_keys:
                existing_order = self._delivery_order.get(generation)
                if existing_order is None:
                    self._delivery_order[generation] = tuple(delivery_keys)
                    self._delivery_index[generation] = 0
                else:
                    self._delivery_order[generation] = existing_order + tuple(delivery_keys)
            if final:
                for key in emitted_keys:
                    self._abandoned.discard((generation, key))
                self._requests.clear()
                self._running = False
                self._generation += 1
            self._condition.notify_all()
        for token, literature_id, receipt in discarded:
            try:
                self._acquisition.discard_prepared(receipt)
            except BaseException as error:
                with self._condition:
                    self._cleanup_failures[token] = _CohortCleanupFailure(
                        participant_key=token[1],
                        literature_id=literature_id,
                        error=error,
                    )
                    self._condition.notify_all()
                _LOGGER.error(
                    "event=completion-cohort-cleanup-failed code=acquisition-port-contract"
                )

    def _map_observed_items(
        self,
        indexed_requests: tuple[tuple[_ParticipantKey, AcquisitionRequest], ...],
        items: tuple[CohortPreparationItem, ...],
        emitted: dict[_ParticipantKey, CohortPreparationItem],
    ) -> tuple[
        tuple[_ParticipantKey, CohortPreparationItem, _CohortOutcome],
        ...,
    ]:
        if not isinstance(items, tuple) or any(
            not isinstance(item, CohortPreparationItem) for item in items
        ):
            raise AcquisitionFailure(_cohort_contract_failure())
        by_literature = {
            request.literature.literature_id: (position, key, request)
            for position, (key, request) in enumerate(indexed_requests)
        }
        previous_position = -1
        observed: list[tuple[_ParticipantKey, CohortPreparationItem, _CohortOutcome]] = []
        for item in items:
            match = by_literature.get(item.literature_id)
            if match is None:
                raise AcquisitionFailure(_cohort_contract_failure())
            position, key, request = match
            if position <= previous_position or key in emitted:
                raise AcquisitionFailure(_cohort_contract_failure())
            previous_position = position
            observed.append((key, item, self._cohort_item_outcome(request, item)))
        return tuple(observed)

    def _map_batch_outcomes(
        self,
        indexed_requests: tuple[tuple[_ParticipantKey, AcquisitionRequest], ...],
        prepared: PreparedAcquisitionCohort,
        emitted: dict[_ParticipantKey, CohortPreparationItem],
    ) -> tuple[tuple[_ParticipantKey, _CohortOutcome], ...]:
        if not isinstance(prepared, PreparedAcquisitionCohort) or len(prepared.items) != len(
            indexed_requests
        ):
            return self._reject_final_cohort(indexed_requests, prepared, emitted)
        outcomes: list[tuple[_ParticipantKey, _CohortOutcome]] = []
        for (key, request), item in zip(indexed_requests, prepared.items, strict=True):
            if item.literature_id != request.literature.literature_id:
                return self._reject_final_cohort(indexed_requests, prepared, emitted)
            observed = emitted.get(key)
            if observed is not None:
                if item != observed:
                    return self._reject_final_cohort(indexed_requests, prepared, emitted)
                continue
            try:
                outcome = self._cohort_item_outcome(request, item)
            except AcquisitionFailure:
                return self._reject_final_cohort(indexed_requests, prepared, emitted)
            outcomes.append((key, outcome))
        return tuple(outcomes)

    @staticmethod
    def _cohort_item_outcome(
        request: AcquisitionRequest,
        item: CohortPreparationItem,
    ) -> _CohortOutcome:
        if item.literature_id != request.literature.literature_id:
            raise AcquisitionFailure(_cohort_contract_failure())
        if item.prepared is not None:
            return item.prepared
        if item.failure is not None:
            return AcquisitionFailure(item.failure)
        raise AcquisitionFailure(_cohort_contract_failure())

    def _reject_final_cohort(
        self,
        indexed_requests: tuple[tuple[_ParticipantKey, AcquisitionRequest], ...],
        prepared: object,
        emitted: dict[_ParticipantKey, CohortPreparationItem],
    ) -> tuple[tuple[_ParticipantKey, _CohortOutcome], ...]:
        issued = frozenset(item.prepared for item in emitted.values() if item.prepared is not None)
        self._discard_cohort_receipts(prepared, excluded=issued)
        return tuple(
            (key, AcquisitionFailure(_cohort_contract_failure()))
            for key, _request in indexed_requests
            if key not in emitted
        )

    def _discard_cohort_receipts(
        self,
        prepared: object,
        *,
        excluded: frozenset[PreparedAcquisition],
    ) -> None:
        if not isinstance(prepared, PreparedAcquisitionCohort):
            return
        first_failure: BaseException | None = None
        for item in prepared.items:
            if item.prepared is None or item.prepared in excluded:
                continue
            try:
                self._acquisition.discard_prepared(item.prepared)
            except BaseException as error:
                first_failure = first_failure or error
        if first_failure is not None:
            raise first_failure

    def _abandon_waiting_request(
        self,
        generation: int,
        key: _ParticipantKey,
    ) -> None:
        batch: tuple[int, tuple[tuple[_ParticipantKey, AcquisitionRequest], ...]] | None = None
        discarded: PreparedAcquisition | None = None
        token = (generation, key)
        with self._condition:
            outcome = self._outcomes.pop(token, None)
            if isinstance(outcome, PreparedAcquisition):
                discarded = outcome
                self._remove_delivery_locked(token)
            elif outcome is not None:
                self._remove_delivery_locked(token)
            elif generation == self._generation and self._running:
                self._abandoned.add(token)
            elif generation == self._generation:
                self._requests.pop(key, None)
                batch = self._start_ready_batch_locked()
            self._condition.notify_all()
        if discarded is not None:
            self._acquisition.discard_prepared(discarded)
        if batch is not None:
            self._launch_batch(batch)

    def _delivery_ready_locked(
        self,
        token: tuple[int, _ParticipantKey],
    ) -> bool:
        generation, key = token
        order = self._delivery_order.get(generation)
        index = self._delivery_index.get(generation)
        return order is not None and index is not None and order[index] == key

    def _complete_delivery_locked(
        self,
        token: tuple[int, _ParticipantKey],
    ) -> None:
        generation, key = token
        order = self._delivery_order.get(generation)
        index = self._delivery_index.get(generation)
        if order is None or index is None or order[index] != key:
            return
        next_index = index + 1
        if next_index == len(order):
            self._delivery_order.pop(generation, None)
            self._delivery_index.pop(generation, None)
        else:
            self._delivery_index[generation] = next_index
        self._condition.notify_all()

    def _remove_delivery_locked(
        self,
        token: tuple[int, _ParticipantKey],
    ) -> None:
        generation, key = token
        order = self._delivery_order.get(generation)
        index = self._delivery_index.get(generation)
        if order is None or index is None or key not in order[index:]:
            return
        position = order.index(key, index)
        shortened = order[:position] + order[position + 1 :]
        if not shortened or index == len(shortened):
            self._delivery_order.pop(generation, None)
            self._delivery_index.pop(generation, None)
        else:
            self._delivery_order[generation] = shortened
        self._condition.notify_all()

    def _complete_receipt_delivery(self, prepared: PreparedAcquisition) -> None:
        with self._condition:
            token = self._receipt_tokens.pop(prepared, None)
            if token is not None:
                self._complete_delivery_locked(token)


def _valid_participant_key(value: object) -> bool:
    return (
        isinstance(value, tuple)
        and len(value) == 2
        and all(type(part) is str and bool(part) for part in value)
    )


def _clone_cohort_error(error: BaseException) -> BaseException:
    if isinstance(error, AcquisitionFailure):
        return AcquisitionFailure(error.failure)
    return error


def _cohort_contract_failure() -> StableFailure:
    return StableFailure(
        code="acquisition-port-contract",
        reason="The acquisition cohort violated its neutral Port contract.",
        action="Correct the acquisition component assembly.",
        retryable=False,
    )


def _log_acquisition_progress(progress: AcquisitionProgressSnapshot) -> None:
    _LOGGER.info(
        "event=completion-acquisition-progress phase=%s tier=%s selected=%d "
        "resolved=%d pending=%d deferred=%d action_required=%d failed=%d "
        "exhausted=%d provider_group_count=%d",
        progress.phase.value,
        progress.tier.value,
        progress.selected,
        progress.resolved,
        progress.pending,
        progress.deferred,
        progress.action_required,
        progress.failed,
        progress.exhausted,
        len(progress.groups),
    )
    for group in progress.groups:
        _LOGGER.info(
            "event=completion-acquisition-group-progress phase=%s tier=%s "
            "provider_group=%s selected=%d resolved=%d pending=%d deferred=%d "
            "action_required=%d failed=%d exhausted=%d",
            progress.phase.value,
            progress.tier.value,
            group.provider_group,
            group.selected,
            group.resolved,
            group.pending,
            group.deferred,
            group.action_required,
            group.failed,
            group.exhausted,
        )


def _log_browser_escalation(summary: BrowserEscalationSummary) -> None:
    groups = summary.groups
    durations = tuple(
        group.conservative_minimum_duration_seconds
        for group in groups
        if group.conservative_minimum_duration_seconds is not None
    )
    _LOGGER.info(
        "event=completion-browser-escalation-ready selected=%d parallel_group_count=%d "
        "allowed=%d deferred=%d action_required=%d rejected=%d "
        "minimum_duration_seconds=%s",
        sum(group.paper_count for group in groups),
        sum(int(group.allowed_count > 0) for group in groups),
        sum(group.allowed_count for group in groups),
        sum(group.deferred_count for group in groups),
        sum(group.action_required_count for group in groups),
        sum(group.rejected_count for group in groups),
        "-" if not durations else f"{max(durations):g}",
    )
    for group in groups:
        _LOGGER.info(
            "event=completion-browser-escalation-group provider_group=%s papers=%d eligible=%d "
            "allowed=%d deferred=%d action_required=%d rejected=%d readiness=%s "
            "minimum_start_interval=%s next_allowed_in_seconds=%s "
            "minimum_duration_seconds=%s required_action_count=%d",
            group.rate_limit_group,
            group.paper_count,
            group.eligible_count,
            group.allowed_count,
            group.deferred_count,
            group.action_required_count,
            group.rejected_count,
            group.readiness,
            group.minimum_start_interval,
            group.earliest_start_in_seconds,
            (
                "-"
                if group.conservative_minimum_duration_seconds is None
                else f"{group.conservative_minimum_duration_seconds:g}"
            ),
            len(group.required_actions),
        )
        for action in group.required_actions:
            _LOGGER.info(
                "event=completion-browser-escalation-action provider_group=%s action=%s",
                group.rate_limit_group,
                action,
            )


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
        acquisition_cohort: _CohortAcquisitionPort | None = None,
        index_offset: int = 0,
        total_target_count: int | None = None,
    ) -> None:
        self._targets = targets
        self._request = request
        self._orchestrator = orchestrator
        self._max_concurrency = max_concurrency
        self._cancel_event = cancel_event
        self._acquisition_cohort = acquisition_cohort
        self._index_offset = index_offset
        self._total_target_count = total_target_count or len(targets)
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
            (not self._cancel_event.is_set() or self._acquisition_cohort is not None)
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
        cohort = self._acquisition_cohort
        if cohort is None:
            return self._run_bound_target(index, execution)
        key = _completion_target_identity(execution.target)
        with cohort.participant(key):
            return self._run_bound_target(index, execution)

    def _run_bound_target(
        self,
        index: int,
        execution: TransientExecution,
    ) -> TargetOrchestrationResult | NotStartedCompletionTarget:
        if self._cancel_event.is_set():
            return NotStartedCompletionTarget(target=execution.target)
        target_kind, target_id = _completion_target_identity(execution.target)
        _LOGGER.debug(
            "event=completion-target-started progress=%d/%d target_kind=%s target_id=%s",
            self._index_offset + index + 1,
            self._total_target_count,
            target_kind,
            target_id,
        )
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
                if self._acquisition_cohort is not None:
                    self._acquisition_cohort.abandon(
                        _completion_target_identity(self._targets[index].target)
                    )
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
                _log_completion_target_result(
                    self._index_offset + index,
                    self._total_target_count,
                    result,
                )
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
        except Exception:
            _LOGGER.error(
                "event=completion-target-crashed progress=%d/%d code=completion-target-unexpected",
                self._index_offset + index + 1,
                self._total_target_count,
            )
            raise

    def _interrupt_operation(self) -> None:
        self._interrupted = True
        self._cancel_event.set()

    def _finalize(self) -> _RunResult:
        for index in range(self._next_index, len(self._targets)):
            self._results[index] = NotStartedCompletionTarget(target=self._targets[index].target)
            if self._acquisition_cohort is not None:
                self._acquisition_cohort.abandon(
                    _completion_target_identity(self._targets[index].target)
                )
        if any(result is None for result in self._results):
            raise RuntimeError("completion target partition is incomplete")
        return _RunResult(
            results=tuple(result for result in self._results if result is not None),
            interrupted=self._interrupted,
        )


def _run_cohort_chunks(
    *,
    targets: tuple[TransientExecution, ...],
    request: BatchRequest,
    acquisition: AutomaticAcquisitionPort,
    orchestrator_factory: Callable[[AutomaticAcquisitionPort], _TargetOrchestrator],
    max_concurrency: int,
    cancel_event: threading.Event,
) -> _RunResult:
    results: list[TargetOrchestrationResult | NotStartedCompletionTarget] = []
    interrupted = False
    for offset in range(0, len(targets), max_concurrency):
        chunk = targets[offset : offset + max_concurrency]
        participant_keys = tuple(
            _completion_target_identity(execution.target) for execution in chunk
        )
        cohort = _CohortAcquisitionPort(
            acquisition=acquisition,
            participant_keys=participant_keys,
            cancel_event=cancel_event,
        )
        try:
            run = _CompletionScheduler(
                targets=chunk,
                request=request,
                orchestrator=orchestrator_factory(cohort),
                max_concurrency=len(chunk),
                cancel_event=cancel_event,
                acquisition_cohort=cohort,
                index_offset=offset,
                total_target_count=len(targets),
            ).run()
        finally:
            cohort.close()
        run = _apply_cohort_cleanup_failures(
            chunk=chunk,
            run=run,
            failures=cohort.take_cleanup_failures(),
            index_offset=offset,
            total_target_count=len(targets),
        )
        results.extend(run.results)
        interrupted = interrupted or run.interrupted
        next_offset = offset + len(chunk)
        if cancel_event.is_set() and next_offset < len(targets):
            interrupted = True
            for index, execution in enumerate(targets[next_offset:], start=next_offset):
                result = NotStartedCompletionTarget(target=execution.target)
                results.append(result)
                _log_completion_target_result(index, len(targets), result)
            break
    return _RunResult(results=tuple(results), interrupted=interrupted)


def _apply_cohort_cleanup_failures(
    *,
    chunk: tuple[TransientExecution, ...],
    run: _RunResult,
    failures: tuple[_CohortCleanupFailure, ...],
    index_offset: int,
    total_target_count: int,
) -> _RunResult:
    if not failures:
        return run
    indexes = {
        _completion_target_identity(execution.target): index
        for index, execution in enumerate(chunk)
    }
    results = list(run.results)
    for cleanup_failure in failures:
        error = cleanup_failure.error
        if not isinstance(error, AcquisitionFailure):
            raise error
        index = indexes.get(cleanup_failure.participant_key)
        if index is None:
            raise RuntimeError("cohort cleanup failure has no frozen participant")
        existing = results[index]
        no_usable_content = (
            ()
            if isinstance(existing, NotStartedCompletionTarget)
            else existing.no_usable_content_literature_ids
        )
        replacement = TargetOrchestrationResult(
            outcome=FailedCompletionTarget(
                target=chunk[index].target,
                literature_id=cleanup_failure.literature_id,
                stage="acquisition",
                failure=error.failure,
            ),
            no_usable_content_literature_ids=no_usable_content,
        )
        results[index] = replacement
        _log_completion_target_result(
            index_offset + index,
            total_target_count,
            replacement,
        )
    interrupted = any(
        isinstance(result, NotStartedCompletionTarget)
        or isinstance(result.outcome, InterruptedCompletionTarget)
        for result in results
    )
    return _RunResult(results=tuple(results), interrupted=interrupted)


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
            _LOGGER.info(
                "event=completion-started goal=%s target_count=%d max_concurrency=%d",
                request.goal,
                len(frozen),
                self._max_concurrency,
            )
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
            return _logged_completion_report(
                _report(
                    request,
                    tuple(
                        NotStartedCompletionTarget(target=execution.target) for execution in frozen
                    ),
                    interrupted=True,
                )
            )
        except ExecutionSnapshotError:
            return _logged_completion_report(_operation_failed_report(request, frozen))
        except WriteAdmissionFailure as error:
            if run is None:
                return _logged_completion_report(
                    _write_admission_failed_report(request, frozen, error.failure)
                )
            return _logged_completion_report(
                _report(
                    request,
                    run.results,
                    interrupted=run.interrupted,
                    failure=error.failure,
                )
            )
        if run is None:
            raise AssertionError("completion execution returned no run result")
        return _logged_completion_report(_report(request, run.results, interrupted=run.interrupted))

    def _run_frozen(
        self,
        targets: tuple[TransientExecution, ...],
        request: BatchRequest,
        *,
        cancel_event: threading.Event,
    ) -> _RunResult:
        with _SerialCommitExecutor() as commit_executor:

            def build_orchestrator(
                acquisition: AutomaticAcquisitionPort,
            ) -> CompletionTargetOrchestrator:
                return CompletionTargetOrchestrator(
                    current_facts_reader=self._current_facts_reader,
                    acquisition=acquisition,
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

            return _run_cohort_chunks(
                targets=targets,
                request=request,
                acquisition=self._acquisition,
                orchestrator_factory=build_orchestrator,
                max_concurrency=self._max_concurrency,
                cancel_event=cancel_event,
            )
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

            def build_orchestrator(
                acquisition: AutomaticAcquisitionPort,
            ) -> AssetCompletionTargetOrchestrator:
                return AssetCompletionTargetOrchestrator(
                    current_facts_reader=self._current_facts_reader,
                    acquisition=acquisition,
                    acquisition_requests=self._acquisition_requests,
                    commit_executor=commit_executor,
                    cancel_event=cancel_event,
                )

            return _run_cohort_chunks(
                targets=targets,
                request=request,
                acquisition=self._acquisition,
                orchestrator_factory=build_orchestrator,
                max_concurrency=self._max_concurrency,
                cancel_event=cancel_event,
            )
        raise AssertionError("commit executor scope completed without a run result")


def _interrupted_target(execution: TransientExecution) -> TargetOrchestrationResult:
    return TargetOrchestrationResult(
        outcome=InterruptedCompletionTarget(
            target=execution.target,
            literature_id=_first_literature_id(execution),
        )
    )


def _completion_target_identity(target: object) -> tuple[str, str]:
    if isinstance(target, LiteratureCompletionTarget):
        return target.kind, str(target.literature_id)
    if isinstance(target, MetaLiteratureCompletionTarget):
        return target.kind, str(target.meta_literature_id)
    return "invalid", "-"


def _log_completion_target_result(
    index: int,
    total: int,
    result: TargetOrchestrationResult | NotStartedCompletionTarget,
) -> None:
    if isinstance(result, NotStartedCompletionTarget):
        target_kind, target_id = _completion_target_identity(result.target)
        _LOGGER.warning(
            "event=completion-target-finished progress=%d/%d outcome=not-started "
            "target_kind=%s target_id=%s",
            index + 1,
            total,
            target_kind,
            target_id,
        )
        return

    outcome = result.outcome
    target_kind, target_id = _completion_target_identity(outcome.target)
    if isinstance(outcome, GoalReachedTarget):
        _LOGGER.info(
            "event=completion-target-finished progress=%d/%d outcome=goal-reached "
            "target_kind=%s target_id=%s literature_id=%s",
            index + 1,
            total,
            target_kind,
            target_id,
            outcome.literature_id,
        )
        return
    if isinstance(outcome, NeedsManualPdfTarget):
        _LOGGER.info(
            "event=completion-target-finished progress=%d/%d outcome=needs-manual-pdf "
            "target_kind=%s target_id=%s literature_ids=%s",
            index + 1,
            total,
            target_kind,
            target_id,
            ",".join(str(value) for value in outcome.literature_ids),
        )
        return
    if isinstance(outcome, FailedCompletionTarget):
        failure = outcome.failure
        _LOGGER.warning(
            "event=completion-target-failed progress=%d/%d target_kind=%s target_id=%s "
            "literature_id=%s stage=%s code=%s retryable=%s reason=%s action=%s",
            index + 1,
            total,
            target_kind,
            target_id,
            outcome.literature_id or "-",
            outcome.stage,
            failure.code,
            str(failure.retryable).lower(),
            failure.reason,
            failure.action,
        )
        return
    if isinstance(outcome, InterruptedCompletionTarget):
        _LOGGER.warning(
            "event=completion-target-finished progress=%d/%d outcome=interrupted "
            "target_kind=%s target_id=%s literature_id=%s",
            index + 1,
            total,
            target_kind,
            target_id,
            outcome.literature_id or "-",
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


def _logged_completion_report(report: DatabaseCompletionReport) -> DatabaseCompletionReport:
    if isinstance(report.end, FailedReportEnd):
        failure = report.end.failure
        _LOGGER.error(
            "event=completion-failed goal=%s code=%s retryable=%s reason=%s action=%s",
            report.goal,
            failure.code,
            str(failure.retryable).lower(),
            failure.reason,
            failure.action,
        )
        return report
    message = (
        "event=completion-interrupted"
        if isinstance(report.end, InterruptedReportEnd)
        else "event=completion-finished"
    )
    log = _LOGGER.warning if isinstance(report.end, InterruptedReportEnd) else _LOGGER.info
    log(
        "%s goal=%s goal_reached=%d needs_manual_pdf=%d failed=%d interrupted=%d "
        "not_started=%d no_usable_content=%d",
        message,
        report.goal,
        len(report.goal_reached),
        len(report.needs_manual_pdf),
        len(report.failed),
        len(report.interrupted),
        len(report.not_started),
        len(report.no_usable_content_literature_ids),
    )
    return report


__all__ = ("DatabaseCompletionOperation",)
