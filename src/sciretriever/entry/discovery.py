"""Bounded Entry orchestration for one topic DiscoveryRun.

The operation consumes one requested provider at a time.  Provider adapters
remain responsible for raw-item limits and vendor conversion; Entry admits the
returned neutral observations through Literature and publishes every accepted
topic cause.  Volatile counts and cancellation partitions exist only in the
returned :class:`DiscoveryReport`.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterable
from typing import Literal, TypeAlias
from uuid import uuid4

from sciretriever.entry.ports import (
    ClockPort,
    DiscoveryPublicationPort,
    DiscoveryRunRecoveryPort,
    DiscoveryRunRepositoryPort,
    WriteAdmissionFailure,
    WriteAdmissionPort,
)
from sciretriever.literature.api import ObservationAcceptanceResult
from sciretriever.logging.api import get_logger
from sciretriever.metadata.api import (
    MAX_PROVIDER_RELATION_PUBLICATION_BATCH,
    CancellationEvent,
    MetadataApi,
    MetadataProviderInvocation,
    MetadataPublication,
)
from sciretriever.model.discovery import (
    DiscoveryResult,
    DiscoveryRun,
    DiscoverySourceResult,
    ProviderDiscoveryLimit,
    TopicDiscoveryCause,
    TopicDiscoveryInput,
)
from sciretriever.model.metadata import MetadataObservation, ProviderRelationObservation
from sciretriever.model.primitives import DiscoveryRunId, MetaLiteratureId, UtcTimestamp
from sciretriever.model.report import (
    DiscoveryProviderReport,
    DiscoveryProviderReportOutcome,
    DiscoveryReport,
    FailedReportEnd,
    FinishedReportEnd,
    InterruptedReportEnd,
    StableFailure,
)

DiscoveryRunIdFactory: TypeAlias = Callable[[], DiscoveryRunId]
_LOGGER = get_logger(__name__)


class _ControlledInterruption(BaseException):
    pass


class _TopicDiscoveryContractError(RuntimeError):
    pass


class TopicDiscoveryOperation:
    """Execute one independent, bounded, multi-provider topic discovery."""

    __slots__ = (
        "_metadata",
        "_metadata_publication",
        "_repository",
        "_publication",
        "_clock",
        "_write_admission",
        "_recovery",
        "_run_id_factory",
        "_provider_precedence",
        "_cancel_event",
    )

    def __init__(
        self,
        *,
        metadata: MetadataApi,
        metadata_publication: MetadataPublication,
        repository: DiscoveryRunRepositoryPort,
        publication: DiscoveryPublicationPort,
        clock: ClockPort,
        write_admission: WriteAdmissionPort,
        recovery: DiscoveryRunRecoveryPort,
        run_id_factory: DiscoveryRunIdFactory = lambda: DiscoveryRunId(str(uuid4())),
        provider_precedence: Iterable[str] = (),
        cancel_event: CancellationEvent | None = None,
    ) -> None:
        if not isinstance(metadata, MetadataApi):
            raise TypeError("metadata must be a MetadataApi")
        if not isinstance(metadata_publication, MetadataPublication):
            raise TypeError("metadata_publication must be a MetadataPublication")
        if not isinstance(repository, DiscoveryRunRepositoryPort):
            raise TypeError("repository must implement DiscoveryRunRepositoryPort")
        if not isinstance(publication, DiscoveryPublicationPort):
            raise TypeError("publication must implement DiscoveryPublicationPort")
        if not isinstance(clock, ClockPort):
            raise TypeError("clock must implement ClockPort")
        if not isinstance(write_admission, WriteAdmissionPort):
            raise TypeError("write_admission must implement WriteAdmissionPort")
        if not isinstance(recovery, DiscoveryRunRecoveryPort):
            raise TypeError("recovery must implement DiscoveryRunRecoveryPort")
        if not callable(run_id_factory):
            raise TypeError("run_id_factory must be callable")
        if cancel_event is not None and not callable(getattr(cancel_event, "is_set", None)):
            raise TypeError("cancel_event must expose is_set")
        self._metadata = metadata
        self._metadata_publication = metadata_publication
        self._repository = repository
        self._publication = publication
        self._clock = clock
        self._write_admission = write_admission
        self._recovery = recovery
        self._run_id_factory = run_id_factory
        self._provider_precedence = _precedence(provider_precedence)
        self._cancel_event = cancel_event

    def __call__(self, request: TopicDiscoveryInput) -> DiscoveryReport:  # noqa: C901
        if not isinstance(request, TopicDiscoveryInput):
            raise TypeError("request must be a TopicDiscoveryInput")
        started_ns = time.monotonic_ns()
        state: _RunState | None = None
        try:
            with self._write_admission.acquire_nowait():
                interrupted = self._recovery.interrupt_visible_running()
                if not isinstance(interrupted, tuple) or any(
                    not isinstance(item, DiscoveryRunId) for item in interrupted
                ):
                    raise _TopicDiscoveryContractError()
                state = self._create_state(request, diagnostic_started_ns=started_ns)
                state = self._execute(state)
                return self._report(state)
        except (_ControlledInterruption, KeyboardInterrupt):
            if state is None:
                raise
            self._interrupt(state)
            return self._report(state)
        except WriteAdmissionFailure as error:
            if state is None:
                return _logged_discovery_report(
                    _admission_failed_report(request, self._run_id_factory(), error.failure),
                    started_ns=started_ns,
                )
            return _logged_discovery_report(
                _failed_after_admission_exit(state, error.failure),
                started_ns=state.diagnostic_started_ns,
            )
        except _TopicDiscoveryContractError:
            if state is None:
                raise
            return self._finish_failed(state, _contract_failure())
        except Exception:
            if state is None:
                raise
            return self._finish_failed(state, _operation_failure())
        raise _TopicDiscoveryContractError()

    def _create_state(
        self,
        request: TopicDiscoveryInput,
        *,
        diagnostic_started_ns: int,
    ) -> "_RunState":
        run_id = self._run_id_factory()
        started_at = self._clock.now()
        if not isinstance(run_id, DiscoveryRunId) or not isinstance(started_at, UtcTimestamp):
            raise _TopicDiscoveryContractError()
        run = DiscoveryRun(
            discovery_run_id=run_id,
            input=request,
            status="RUNNING",
            started_at=started_at,
        )
        self._repository.create(run)
        _LOGGER.info(
            "event=discovery-started discovery_run_id=%s provider_count=%d",
            run_id,
            len(request.providers),
        )
        return _RunState(run, diagnostic_started_ns=diagnostic_started_ns)

    def _execute(self, state: "_RunState") -> "_RunState":
        request = state.run.input
        if not isinstance(request, TopicDiscoveryInput):
            raise _TopicDiscoveryContractError()
        try:
            for provider_limit in request.providers:
                self._raise_if_cancelled()
                state.started_provider_name = provider_limit.provider_name
                invocation = self._metadata.search_topic_provider(
                    _single_provider_request(request, provider_limit),
                    cancel_event=self._cancel_event,
                )
                if not isinstance(invocation, MetadataProviderInvocation):
                    raise _TopicDiscoveryContractError()
                if invocation.provider_name != provider_limit.provider_name:
                    raise _TopicDiscoveryContractError()
                outcome = invocation.outcome
                state.raw_item_count = invocation.raw_item_count
                self._publish_provider_facts(
                    state,
                    observations=invocation.observations,
                    relations=invocation.relations,
                    observe_cancellation=outcome != "INTERRUPTED",
                )
                if outcome == "INTERRUPTED":
                    raise _ControlledInterruption()
                self._raise_if_cancelled()
                source = DiscoverySourceResult(
                    discovery_run_id=state.run.discovery_run_id,
                    provider_name=invocation.provider_name,
                    outcome=outcome,
                    failure=invocation.failure,
                )
                self._publication.publish_source_result(source)
                state.providers.append(_provider_report(invocation, state.accepted_in_provider))
                state.reset_provider()
        except (_ControlledInterruption, KeyboardInterrupt):
            self._interrupt(state)
            return state

        status = _normal_terminal_status(state.providers)
        finalized = self._repository.finalize(state.run.discovery_run_id, status)
        _validate_finalized(finalized, state.run.discovery_run_id, status)
        state.run_status = status
        state.end = FinishedReportEnd(kind="finished")
        return state

    def _publish_provider_facts(
        self,
        state: "_RunState",
        *,
        observations: tuple[MetadataObservation, ...],
        relations: tuple[ProviderRelationObservation, ...],
        observe_cancellation: bool,
    ) -> None:
        for observation in observations:
            if observe_cancellation:
                self._raise_if_cancelled()
            self._accept_observation(state, observation)
        published_total = 0
        for batch_index, offset in enumerate(
            range(0, len(relations), MAX_PROVIDER_RELATION_PUBLICATION_BATCH),
            start=1,
        ):
            if observe_cancellation:
                self._raise_if_cancelled()
            batch = relations[offset : offset + MAX_PROVIDER_RELATION_PUBLICATION_BATCH]
            started_ns = time.monotonic_ns()
            self._metadata_publication.publish_relation_observations(batch)
            published_total += len(batch)
            _LOGGER.debug(
                "event=discovery-relation-batch-published provider=%s batch=%d "
                "relation_count=%d published_total=%d elapsed_ms=%d",
                state.started_provider_name or "-",
                batch_index,
                len(batch),
                published_total,
                _elapsed_ms(started_ns),
            )

    def _accept_observation(
        self,
        state: "_RunState",
        observation: MetadataObservation,
    ) -> None:
        accepted = self._metadata_publication.publish_observation(
            observation,
            provider_precedence=self._provider_precedence,
        )
        if not isinstance(accepted, ObservationAcceptanceResult):
            raise _TopicDiscoveryContractError()
        if accepted.decision == "rejected":
            decision_reason = accepted.reason
            if decision_reason is None:
                raise _TopicDiscoveryContractError()
            _LOGGER.debug(
                "event=discovery-observation-rejected discovery_run_id=%s provider=%s "
                "observation_id=%s decision_reason=%s",
                state.run.discovery_run_id,
                state.started_provider_name or "-",
                observation.observation_id,
                decision_reason,
            )
            return
        literature = accepted.literature
        meta = accepted.meta_literature
        accepted_observation = accepted.observation
        if literature is None or meta is None or accepted_observation is None:
            raise _TopicDiscoveryContractError()
        if (
            literature.meta_literature_id != meta.meta_literature_id
            or accepted_observation.observation_id != observation.observation_id
        ):
            raise _TopicDiscoveryContractError()

        result = DiscoveryResult(
            discovery_run_id=state.run.discovery_run_id,
            meta_literature_id=meta.meta_literature_id,
        )
        cause = TopicDiscoveryCause(
            kind="topic",
            discovery_run_id=state.run.discovery_run_id,
            meta_literature_id=meta.meta_literature_id,
            metadata_observation_id=accepted_observation.observation_id,
        )
        self._publication.publish_result_and_cause(result, cause)
        state.result_ids.add(meta.meta_literature_id)
        state.accepted_in_provider += 1
        if not accepted.deduplicated:
            state.new_observation_count += 1
        if accepted.decision == "created":
            state.new_literature_count += 1
        if _accepted_meta_was_created(accepted):
            state.new_meta_count += 1
        _LOGGER.debug(
            "event=discovery-observation-accepted discovery_run_id=%s provider=%s "
            "observation_id=%s literature_id=%s meta_literature_id=%s decision=%s "
            "deduplicated=%s",
            state.run.discovery_run_id,
            state.started_provider_name or "-",
            accepted_observation.observation_id,
            literature.literature_id,
            meta.meta_literature_id,
            accepted.decision,
            str(accepted.deduplicated).lower(),
        )

    def _interrupt(self, state: "_RunState") -> None:
        _append_unfinished_provider_reports(state)
        finalized = self._repository.finalize(state.run.discovery_run_id, "INTERRUPTED")
        _validate_finalized(finalized, state.run.discovery_run_id, "INTERRUPTED")
        state.run_status = "INTERRUPTED"
        state.end = InterruptedReportEnd(kind="interrupted")

    def _finish_failed(self, state: "_RunState", failure: StableFailure) -> DiscoveryReport:
        _append_unfinished_provider_reports(state)
        finalized = self._repository.finalize(state.run.discovery_run_id, "FAILED")
        _validate_finalized(finalized, state.run.discovery_run_id, "FAILED")
        state.run_status = "FAILED"
        state.end = FailedReportEnd(kind="failed", failure=failure)
        return self._report(state)

    def _report(self, state: "_RunState") -> DiscoveryReport:
        if state.end is None:
            raise _TopicDiscoveryContractError()
        return _logged_discovery_report(
            DiscoveryReport(
                kind="discovery",
                end=state.end,
                discovery_run_id=state.run.discovery_run_id,
                run_status=state.run_status,
                providers=tuple(state.providers),
                discovery_result_count=len(state.result_ids),
                new_meta_literature_count=state.new_meta_count,
                new_literature_count=state.new_literature_count,
                new_metadata_observation_count=state.new_observation_count,
            ),
            started_ns=state.diagnostic_started_ns,
        )

    def _raise_if_cancelled(self) -> None:
        if self._cancel_event is not None and self._cancel_event.is_set():
            raise _ControlledInterruption()


class _RunState:
    __slots__ = (
        "run",
        "diagnostic_started_ns",
        "run_status",
        "providers",
        "result_ids",
        "new_meta_count",
        "new_literature_count",
        "new_observation_count",
        "started_provider_name",
        "raw_item_count",
        "accepted_in_provider",
        "end",
    )

    def __init__(self, run: DiscoveryRun, *, diagnostic_started_ns: int) -> None:
        self.run = run
        self.diagnostic_started_ns = diagnostic_started_ns
        self.run_status: Literal["RUNNING", "COMPLETED", "PARTIAL", "FAILED", "INTERRUPTED"] = (
            "RUNNING"
        )
        self.providers: list[DiscoveryProviderReport] = []
        self.result_ids: set[MetaLiteratureId] = set()
        self.new_meta_count = 0
        self.new_literature_count = 0
        self.new_observation_count = 0
        self.started_provider_name: str | None = None
        self.raw_item_count = 0
        self.accepted_in_provider = 0
        self.end: FinishedReportEnd | InterruptedReportEnd | FailedReportEnd | None = None

    def reset_provider(self) -> None:
        self.started_provider_name = None
        self.raw_item_count = 0
        self.accepted_in_provider = 0


def _single_provider_request(
    request: TopicDiscoveryInput,
    provider: ProviderDiscoveryLimit,
) -> TopicDiscoveryInput:
    return request.model_copy(update={"providers": (provider,)})


def _provider_report(
    provider: MetadataProviderInvocation,
    accepted_count: int,
) -> DiscoveryProviderReport:
    outcome = provider.outcome
    if outcome == "INTERRUPTED":
        raise _TopicDiscoveryContractError()
    report_outcome: DiscoveryProviderReportOutcome = outcome
    return DiscoveryProviderReport(
        provider_name=provider.provider_name,
        raw_item_count=provider.raw_item_count,
        accepted_observation_count=accepted_count,
        outcome=report_outcome,
        failure=provider.failure,
    )


def _normal_terminal_status(
    providers: list[DiscoveryProviderReport],
) -> Literal["COMPLETED", "PARTIAL", "FAILED"]:
    failed = sum(item.outcome == "FAILED" for item in providers)
    if failed == 0:
        return "COMPLETED"
    if failed == len(providers):
        return "FAILED"
    return "PARTIAL"


def _append_unfinished_provider_reports(state: _RunState) -> None:
    completed_names = {item.provider_name for item in state.providers}
    if (
        state.started_provider_name is not None
        and state.started_provider_name not in completed_names
    ):
        state.providers.append(
            DiscoveryProviderReport(
                provider_name=state.started_provider_name,
                raw_item_count=state.raw_item_count,
                accepted_observation_count=state.accepted_in_provider,
                outcome="INTERRUPTED",
            )
        )
        completed_names.add(state.started_provider_name)
    for provider in state.run.input.providers:
        if provider.provider_name not in completed_names:
            state.providers.append(
                DiscoveryProviderReport(
                    provider_name=provider.provider_name,
                    raw_item_count=0,
                    accepted_observation_count=0,
                    outcome="NOT_STARTED",
                )
            )


def _validate_finalized(
    run: object,
    run_id: DiscoveryRunId,
    status: str,
) -> None:
    if not isinstance(run, DiscoveryRun) or run.discovery_run_id != run_id or run.status != status:
        raise _TopicDiscoveryContractError()


def _accepted_meta_was_created(result: ObservationAcceptanceResult) -> bool:
    """Consume the exact creation fact required from Literature admission."""

    value = getattr(result, "meta_literature_created", None)
    if type(value) is not bool:
        raise _TopicDiscoveryContractError()
    return value


def _precedence(values: Iterable[str]) -> tuple[str, ...]:
    result: list[str] = []
    for value in values:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("provider_precedence must contain nonblank strings")
        normalized = value.strip()
        if normalized not in result:
            result.append(normalized)
    return tuple(result)


def _contract_failure() -> StableFailure:
    return StableFailure(
        code="topic-discovery-contract",
        reason="A required discovery component returned an inconsistent result.",
        action="Check the local application assembly before retrying discovery.",
        retryable=False,
    )


def _operation_failure() -> StableFailure:
    return StableFailure(
        code="topic-discovery-operation-failed",
        reason="A required local component could not complete topic discovery.",
        action="Check the local catalog and retry the discovery operation.",
        retryable=True,
    )


def _admission_failed_report(
    request: TopicDiscoveryInput,
    run_id: DiscoveryRunId,
    failure: StableFailure,
) -> DiscoveryReport:
    if not isinstance(run_id, DiscoveryRunId):
        raise _TopicDiscoveryContractError()
    return DiscoveryReport(
        kind="discovery",
        end=FailedReportEnd(kind="failed", failure=failure),
        discovery_run_id=run_id,
        run_status="FAILED",
        providers=tuple(
            DiscoveryProviderReport(
                provider_name=item.provider_name,
                raw_item_count=0,
                accepted_observation_count=0,
                outcome="NOT_STARTED",
            )
            for item in request.providers
        ),
        discovery_result_count=0,
        new_meta_literature_count=0,
        new_literature_count=0,
        new_metadata_observation_count=0,
    )


def _failed_after_admission_exit(state: _RunState, failure: StableFailure) -> DiscoveryReport:
    if state.end is None:
        raise _TopicDiscoveryContractError()
    return DiscoveryReport(
        kind="discovery",
        end=FailedReportEnd(kind="failed", failure=failure),
        discovery_run_id=state.run.discovery_run_id,
        run_status=state.run_status,
        providers=tuple(state.providers),
        discovery_result_count=len(state.result_ids),
        new_meta_literature_count=state.new_meta_count,
        new_literature_count=state.new_literature_count,
        new_metadata_observation_count=state.new_observation_count,
    )


def _logged_discovery_report(
    report: DiscoveryReport,
    *,
    started_ns: int,
) -> DiscoveryReport:
    elapsed_ms = _elapsed_ms(started_ns)
    if isinstance(report.end, FailedReportEnd):
        failure = report.end.failure
        _LOGGER.error(
            "event=discovery-failed discovery_run_id=%s status=%s code=%s "
            "elapsed_ms=%d retryable=%s reason=%s action=%s",
            report.discovery_run_id,
            report.run_status,
            failure.code,
            elapsed_ms,
            str(failure.retryable).lower(),
            failure.reason,
            failure.action,
        )
    elif isinstance(report.end, InterruptedReportEnd):
        _LOGGER.warning(
            "event=discovery-interrupted discovery_run_id=%s result_count=%d elapsed_ms=%d",
            report.discovery_run_id,
            report.discovery_result_count,
            elapsed_ms,
        )
    else:
        _LOGGER.info(
            "event=discovery-finished discovery_run_id=%s status=%s provider_count=%d "
            "result_count=%d new_literature_count=%d new_observation_count=%d elapsed_ms=%d",
            report.discovery_run_id,
            report.run_status,
            len(report.providers),
            report.discovery_result_count,
            report.new_literature_count,
            report.new_metadata_observation_count,
            elapsed_ms,
        )
    return report


def _elapsed_ms(started_ns: int) -> int:
    return max(0, (time.monotonic_ns() - started_ns) // 1_000_000)


__all__ = ("TopicDiscoveryOperation",)
