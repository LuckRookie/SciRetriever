"""In-memory tier barriers for one bounded PDF-acquisition cohort."""

from __future__ import annotations

import re
import time
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from enum import Enum, unique
from typing import Final, TypeAlias

from sciretriever.acquisition.browser_admission import (
    BrowserAdmissionCandidate,
    BrowserAdmissionController,
    BrowserAdmissionDisposition,
    BrowserAdmissionResult,
    BrowserEscalationSummary,
)
from sciretriever.acquisition.outcomes import RouteExecutionResult, RouteOutcome
from sciretriever.acquisition.planning import (
    AccessRouteHint,
    AcquisitionPlan,
    AcquisitionPlanningSession,
    RouteReadiness,
    RouteSpec,
)
from sciretriever.acquisition.ports import (
    AcquisitionRequest,
    CandidateKeyTracker,
    TemporaryPdf,
)
from sciretriever.logging.api import get_logger
from sciretriever.model.acquisition import AcquisitionPath
from sciretriever.model.report import StableFailure
from sciretriever.network.browser_scheduler import (
    BrowserArticleAttempt,
    BrowserAttemptCompletion,
    BrowserAttemptDisposition,
    BrowserCircuitReason,
    BrowserGroupFeedback,
    BrowserGroupRuntimeSnapshot,
    BrowserGroupScheduler,
    BrowserScheduledAttemptResult,
    BrowserScheduledDisposition,
    BrowserSchedulerCancellation,
)

_WORK_KEY: Final[re.Pattern[str]] = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$",
    re.ASCII,
)
_TIER_ORDER: Final[tuple[AcquisitionPath, ...]] = (
    AcquisitionPath.PUBLIC,
    AcquisitionPath.AUTHORIZED_PROVIDER_API,
    AcquisitionPath.CONTROLLED_BROWSER,
)
_LOGGER = get_logger(__name__)


@unique
class WorkItemDisposition(str, Enum):
    PENDING = "pending"
    DELIVERED = "delivered"
    EXHAUSTED = "exhausted"
    DEFERRED = "deferred"
    ACTION_REQUIRED = "action-required"
    FAILED = "failed"


@unique
class AcquisitionProgressPhase(str, Enum):
    """One operation-local tier boundary exposed only to real-time UX."""

    STARTED = "started"
    FINISHED = "finished"


def _validate_progress_counts(
    *,
    selected: int,
    resolved: int,
    pending: int,
    deferred: int,
    action_required: int,
    failed: int,
    exhausted: int,
) -> None:
    counts = (
        selected,
        resolved,
        pending,
        deferred,
        action_required,
        failed,
        exhausted,
    )
    if any(type(value) is not int or value < 0 for value in counts):
        raise ValueError("acquisition progress counts must be nonnegative integers")
    if sum(counts[1:]) != selected:
        raise ValueError("acquisition progress outcomes must partition selected targets")


@dataclass(frozen=True, slots=True)
class AcquisitionGroupProgress:
    """One secret-free Publisher/risk-group view of current cohort state."""

    provider_group: str
    selected: int
    resolved: int
    pending: int
    deferred: int
    action_required: int
    failed: int
    exhausted: int

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "provider_group",
            _provider_group(self.provider_group),
        )
        _validate_progress_counts(
            selected=self.selected,
            resolved=self.resolved,
            pending=self.pending,
            deferred=self.deferred,
            action_required=self.action_required,
            failed=self.failed,
            exhausted=self.exhausted,
        )

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("AcquisitionGroupProgress cannot be serialized")


@dataclass(frozen=True, slots=True)
class AcquisitionProgressSnapshot:
    """A derived tier snapshot; never a Report, database fact, or retry input."""

    tier: AcquisitionPath
    phase: AcquisitionProgressPhase
    selected: int
    resolved: int
    pending: int
    deferred: int
    action_required: int
    failed: int
    exhausted: int
    groups: tuple[AcquisitionGroupProgress, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.tier, AcquisitionPath):
            raise TypeError("tier must be AcquisitionPath")
        if not isinstance(self.phase, AcquisitionProgressPhase):
            raise TypeError("phase must be AcquisitionProgressPhase")
        _validate_progress_counts(
            selected=self.selected,
            resolved=self.resolved,
            pending=self.pending,
            deferred=self.deferred,
            action_required=self.action_required,
            failed=self.failed,
            exhausted=self.exhausted,
        )
        if not isinstance(self.groups, tuple) or any(
            not isinstance(group, AcquisitionGroupProgress) for group in self.groups
        ):
            raise TypeError("groups must contain AcquisitionGroupProgress values")
        identities = tuple(group.provider_group for group in self.groups)
        if identities != tuple(sorted(identities)) or len(identities) != len(set(identities)):
            raise ValueError("acquisition progress groups must be unique and sorted")
        group_totals = tuple(
            sum(getattr(group, field_name) for group in self.groups)
            for field_name in (
                "selected",
                "resolved",
                "pending",
                "deferred",
                "action_required",
                "failed",
                "exhausted",
            )
        )
        if group_totals != (
            self.selected,
            self.resolved,
            self.pending,
            self.deferred,
            self.action_required,
            self.failed,
            self.exhausted,
        ):
            raise ValueError("acquisition progress groups must partition the cohort snapshot")

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("AcquisitionProgressSnapshot cannot be serialized")


def _work_key(value: object) -> str:
    if type(value) is not str:
        raise TypeError("work_key must be a string")
    candidate = value.strip()
    if _WORK_KEY.fullmatch(candidate) is None:
        raise ValueError("work_key must be a stable operation-local identity")
    return candidate


def _provider_group(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("provider_group must be a string")
    candidate = value.strip()
    if _WORK_KEY.fullmatch(candidate) is None:
        raise ValueError("provider_group must be a stable operation-local identity")
    return str(candidate)


@dataclass(slots=True)
class AcquisitionWorkItem:
    """Mutable operation-local state for one frozen Literature snapshot."""

    work_key: str
    plan: AcquisitionPlan
    request: AcquisitionRequest | None = field(default=None, repr=False)
    planning_session: AcquisitionPlanningSession | None = field(default=None, repr=False)
    disposition: WorkItemDisposition = field(
        default=WorkItemDisposition.PENDING,
        init=False,
    )
    current_tier: AcquisitionPath | None = field(default=None, init=False)
    attempted_route_keys: list[str] = field(default_factory=list, init=False, repr=False)
    route_hints: list[AccessRouteHint] = field(default_factory=list, init=False, repr=False)
    route_issues: list[RouteExecutionResult] = field(
        default_factory=list,
        init=False,
        repr=False,
    )
    temporary_pdf: TemporaryPdf | None = field(default=None, init=False, repr=False)
    failure: StableFailure | None = field(default=None, init=False)
    publication_receipt: object | None = field(default=None, init=False, repr=False)
    candidate_keys: CandidateKeyTracker = field(init=False, repr=False)
    delivered_candidate_keys: set[str] = field(default_factory=set, init=False, repr=False)
    plan_revisions: list[str] = field(default_factory=list, init=False, repr=False)

    def __post_init__(self) -> None:
        self.work_key = _work_key(self.work_key)
        if not isinstance(self.plan, AcquisitionPlan):
            raise TypeError("plan must be AcquisitionPlan")
        if self.request is not None and not isinstance(self.request, AcquisitionRequest):
            raise TypeError("request must be AcquisitionRequest or None")
        if self.planning_session is not None and not isinstance(
            self.planning_session,
            AcquisitionPlanningSession,
        ):
            raise TypeError("planning_session must be AcquisitionPlanningSession or None")
        if self.planning_session is not None and (
            self.request is not self.planning_session.request
            or self.plan != self.planning_session.plan
        ):
            raise ValueError("planning_session must describe the work item request and plan")
        excluded = () if self.request is None else self.request.excluded_candidate_keys
        self.candidate_keys = CandidateKeyTracker(excluded)
        self.delivered_candidate_keys.update(excluded)
        self.plan_revisions.append(self.plan.revision)

    @property
    def exhausted(self) -> bool:
        return self.disposition is WorkItemDisposition.EXHAUSTED

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("AcquisitionWorkItem cannot be serialized")


@dataclass(frozen=True, slots=True)
class AcquisitionWorkItemResult:
    work_key: str
    disposition: WorkItemDisposition
    attempted_route_keys: tuple[str, ...]
    route_hints: tuple[AccessRouteHint, ...]
    temporary_pdf: TemporaryPdf | None = field(default=None, repr=False)
    failure: StableFailure | None = None

    def __post_init__(self) -> None:
        _work_key(self.work_key)
        if not isinstance(self.disposition, WorkItemDisposition):
            raise TypeError("disposition must be WorkItemDisposition")
        if not isinstance(self.attempted_route_keys, tuple):
            raise TypeError("attempted_route_keys must be a tuple")
        if not isinstance(self.route_hints, tuple) or any(
            not isinstance(hint, AccessRouteHint) for hint in self.route_hints
        ):
            raise TypeError("route_hints must contain AccessRouteHint values")
        if self.temporary_pdf is not None and not isinstance(self.temporary_pdf, TemporaryPdf):
            raise TypeError("temporary_pdf must be TemporaryPdf or None")
        if self.failure is not None and not isinstance(self.failure, StableFailure):
            raise TypeError("failure must be StableFailure or None")
        if (self.disposition is WorkItemDisposition.DELIVERED) != (self.temporary_pdf is not None):
            raise ValueError("only a delivered work item carries TemporaryPdf")
        has_failure_disposition = self.disposition in {
            WorkItemDisposition.DEFERRED,
            WorkItemDisposition.ACTION_REQUIRED,
            WorkItemDisposition.FAILED,
        }
        if has_failure_disposition != (self.failure is not None):
            raise ValueError("only nonterminal-success dispositions carry failure")

    @property
    def exhausted(self) -> bool:
        return self.disposition is WorkItemDisposition.EXHAUSTED

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("AcquisitionWorkItemResult cannot be serialized")


@dataclass(frozen=True, slots=True)
class CohortExecutionResult:
    items: tuple[AcquisitionWorkItemResult, ...]
    browser_admission: BrowserAdmissionResult

    def __post_init__(self) -> None:
        if not isinstance(self.items, tuple) or any(
            not isinstance(item, AcquisitionWorkItemResult) for item in self.items
        ):
            raise TypeError("items must contain AcquisitionWorkItemResult values")
        keys = tuple(item.work_key for item in self.items)
        if len(keys) != len(set(keys)):
            raise ValueError("cohort result work keys must be unique")
        if not isinstance(self.browser_admission, BrowserAdmissionResult):
            raise TypeError("browser_admission must be BrowserAdmissionResult")

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("CohortExecutionResult cannot be serialized")


RouteExecutor = Callable[[AcquisitionWorkItem, RouteSpec], RouteExecutionResult]
PlanRefresher = Callable[[AcquisitionWorkItem], AcquisitionPlan]
TierCompletionObserver: TypeAlias = Callable[
    [AcquisitionPath, tuple[AcquisitionWorkItemResult, ...]],
    None,
]
AcquisitionProgressObserver: TypeAlias = Callable[[AcquisitionProgressSnapshot], None]
BrowserEscalationObserver: TypeAlias = Callable[[BrowserEscalationSummary], None]


class TieredCohortExecutor:
    """Finish every active work item in one tier before opening the next."""

    __slots__ = ("_browser_admission", "_browser_scheduler", "_max_concurrency")

    def __init__(
        self,
        *,
        max_concurrency: int = 4,
        browser_admission: BrowserAdmissionController | None = None,
        browser_scheduler: BrowserGroupScheduler | None = None,
    ) -> None:
        if isinstance(max_concurrency, bool) or not isinstance(max_concurrency, int):
            raise TypeError("max_concurrency must be an integer")
        if max_concurrency < 1:
            raise ValueError("max_concurrency must be positive")
        if browser_admission is not None and not isinstance(
            browser_admission,
            BrowserAdmissionController,
        ):
            raise TypeError("browser_admission must be BrowserAdmissionController or None")
        if browser_scheduler is not None and not isinstance(
            browser_scheduler,
            BrowserGroupScheduler,
        ):
            raise TypeError("browser_scheduler must be BrowserGroupScheduler or None")
        self._max_concurrency = max_concurrency
        self._browser_admission = browser_admission or BrowserAdmissionController()
        self._browser_scheduler = browser_scheduler

    def execute(
        self,
        items: tuple[AcquisitionWorkItem, ...],
        execute_route: RouteExecutor,
        *,
        refresh_plan: PlanRefresher | None = None,
        on_tier_completed: TierCompletionObserver | None = None,
        on_progress: AcquisitionProgressObserver | None = None,
        on_browser_escalation: BrowserEscalationObserver | None = None,
        cancel_event: BrowserSchedulerCancellation | None = None,
    ) -> CohortExecutionResult:
        self._validate_inputs(
            items,
            execute_route,
            refresh_plan,
            on_tier_completed,
            on_progress,
            on_browser_escalation,
            cancel_event,
        )
        cohort_started_ns = time.monotonic_ns()
        _LOGGER.debug(
            "event=acquisition-cohort-started target_count=%d",
            len(items),
        )
        for item in items:
            _log_plan(item, event="acquisition-plan-ready")
        for tier in _TIER_ORDER[:2]:
            tier_started_ns = time.monotonic_ns()
            self._notify_progress(
                items,
                tier,
                AcquisitionProgressPhase.STARTED,
                on_progress,
                elapsed_ms=None,
            )
            self._execute_tier_with_replanning(
                items,
                tier,
                execute_route,
                refresh_plan,
            )
            if tier is AcquisitionPath.AUTHORIZED_PROVIDER_API:
                _finalize_blocking_low_risk_route_issues(items)
            self._notify_progress(
                items,
                tier,
                AcquisitionProgressPhase.FINISHED,
                on_progress,
                elapsed_ms=_elapsed_ms(tier_started_ns),
            )
            self._notify_tier_completed(items, tier, on_tier_completed)
        browser_admission = self._admit_browser(items)
        _log_browser_admission(browser_admission)
        if on_browser_escalation is not None:
            on_browser_escalation(browser_admission.summary)
        self._apply_browser_admission(items, browser_admission)
        browser_tier_started_ns = time.monotonic_ns()
        self._notify_progress(
            items,
            AcquisitionPath.CONTROLLED_BROWSER,
            AcquisitionProgressPhase.STARTED,
            on_progress,
            elapsed_ms=None,
        )
        self._execute_browser_tier(
            items,
            browser_admission,
            execute_route,
            cancel_event=cancel_event,
        )
        for item in items:
            _finalize_route_issue(item)
            if item.disposition is WorkItemDisposition.PENDING:
                item.disposition = WorkItemDisposition.EXHAUSTED
                item.current_tier = None
        self._notify_progress(
            items,
            AcquisitionPath.CONTROLLED_BROWSER,
            AcquisitionProgressPhase.FINISHED,
            on_progress,
            elapsed_ms=_elapsed_ms(browser_tier_started_ns),
        )
        self._notify_tier_completed(
            items,
            AcquisitionPath.CONTROLLED_BROWSER,
            on_tier_completed,
        )
        _log_cohort_finished(items, elapsed_ms=_elapsed_ms(cohort_started_ns))
        return CohortExecutionResult(
            tuple(_freeze_result(item) for item in items),
            browser_admission=browser_admission,
        )

    def _validate_inputs(
        self,
        items: tuple[AcquisitionWorkItem, ...],
        execute_route: RouteExecutor,
        refresh_plan: PlanRefresher | None,
        on_tier_completed: TierCompletionObserver | None,
        on_progress: AcquisitionProgressObserver | None,
        on_browser_escalation: BrowserEscalationObserver | None,
        cancel_event: BrowserSchedulerCancellation | None,
    ) -> None:
        if not isinstance(items, tuple) or any(
            not isinstance(item, AcquisitionWorkItem) for item in items
        ):
            raise TypeError("items must contain AcquisitionWorkItem values")
        keys = tuple(item.work_key for item in items)
        if len(keys) != len(set(keys)):
            raise ValueError("cohort work keys must be unique")
        if not callable(execute_route):
            raise TypeError("execute_route must be callable")
        if refresh_plan is not None and not callable(refresh_plan):
            raise TypeError("refresh_plan must be callable or None")
        if on_tier_completed is not None and not callable(on_tier_completed):
            raise TypeError("on_tier_completed must be callable or None")
        if on_progress is not None and not callable(on_progress):
            raise TypeError("on_progress must be callable or None")
        if on_browser_escalation is not None and not callable(on_browser_escalation):
            raise TypeError("on_browser_escalation must be callable or None")
        if cancel_event is not None and not isinstance(
            cancel_event,
            BrowserSchedulerCancellation,
        ):
            raise TypeError("cancel_event must expose is_set() or be None")
        if any(item.disposition is not WorkItemDisposition.PENDING for item in items):
            raise ValueError("cohort work items must be fresh")

    @staticmethod
    def _notify_tier_completed(
        items: tuple[AcquisitionWorkItem, ...],
        tier: AcquisitionPath,
        observer: TierCompletionObserver | None,
    ) -> None:
        if observer is None:
            return
        observer(tier, tuple(_freeze_result(item) for item in items))

    @staticmethod
    def _notify_progress(
        items: tuple[AcquisitionWorkItem, ...],
        tier: AcquisitionPath,
        phase: AcquisitionProgressPhase,
        observer: AcquisitionProgressObserver | None,
        *,
        elapsed_ms: int | None,
    ) -> None:
        snapshot = _progress_snapshot(items, tier=tier, phase=phase)
        _log_tier_progress(snapshot, elapsed_ms=elapsed_ms)
        if observer is not None:
            observer(snapshot)

    def _execute_tier(
        self,
        item: AcquisitionWorkItem,
        tier: AcquisitionPath,
        execute_route: RouteExecutor,
    ) -> None:
        item.current_tier = tier
        routes = item.plan.routes_for(tier)
        for route_index, route in enumerate(routes):
            if item.disposition is not WorkItemDisposition.PENDING:
                break
            if route.route_key in item.attempted_route_keys:
                _LOGGER.debug(
                    "event=acquisition-route-skipped work_key=%s tier=%s route_key=%s "
                    "provider_group=%s reason=already-attempted",
                    item.work_key,
                    tier.value,
                    route.route_key,
                    _route_group(route),
                )
                continue
            item.attempted_route_keys.append(route.route_key)
            _LOGGER.debug(
                "event=acquisition-route-started work_key=%s tier=%s route_key=%s "
                "provider_group=%s readiness=%s capability=%s plan_revision=%s "
                "resolution_evidence_kind=%s",
                item.work_key,
                tier.value,
                route.route_key,
                _route_group(route),
                route.readiness.value,
                route.capability.value,
                item.plan.revision,
                _resolution_evidence_kind(item),
            )
            route_started_ns = time.monotonic_ns()
            try:
                readiness = _readiness_outcome(route)
                result = readiness if readiness is not None else execute_route(item, route)
            except Exception:
                _LOGGER.error(
                    "event=acquisition-route-crashed work_key=%s tier=%s route_key=%s "
                    "provider_group=%s disposition=fatal next=stop elapsed_ms=%d "
                    "code=acquisition-route-unexpected",
                    item.work_key,
                    tier.value,
                    route.route_key,
                    _route_group(route),
                    _elapsed_ms(route_started_ns),
                )
                raise
            if not isinstance(result, RouteExecutionResult):
                raise TypeError("execute_route must return RouteExecutionResult")
            _log_route_result(
                item,
                route,
                result,
                next_step=_route_next_step(
                    item,
                    route,
                    result,
                    has_remaining_route=route_index + 1 < len(routes),
                ),
                elapsed_ms=_elapsed_ms(route_started_ns),
            )
            _apply_route_result(item, result)
            if tier is AcquisitionPath.CONTROLLED_BROWSER:
                _finalize_route_issue(item)

    def _execute_parallel_tier(
        self,
        items: tuple[AcquisitionWorkItem, ...],
        tier: AcquisitionPath,
        execute_route: RouteExecutor,
    ) -> None:
        active = tuple(item for item in items if item.disposition is WorkItemDisposition.PENDING)
        self._run_parallel(
            tuple(
                lambda item=item: self._execute_tier(item, tier, execute_route) for item in active
            )
        )

    def _execute_tier_with_replanning(
        self,
        items: tuple[AcquisitionWorkItem, ...],
        tier: AcquisitionPath,
        execute_route: RouteExecutor,
        refresh_plan: PlanRefresher | None,
    ) -> None:
        while True:
            self._execute_parallel_tier(items, tier, execute_route)
            if refresh_plan is None:
                return
            self._refresh_pending(items, refresh_plan)
            if not any(
                item.disposition is WorkItemDisposition.PENDING
                and any(
                    route.route_key not in item.attempted_route_keys
                    for route in item.plan.routes_for(tier)
                )
                for item in items
            ):
                return

    def _refresh_pending(
        self,
        items: tuple[AcquisitionWorkItem, ...],
        refresh_plan: PlanRefresher,
    ) -> None:
        active = tuple(item for item in items if item.disposition is WorkItemDisposition.PENDING)

        def refresh(item: AcquisitionWorkItem) -> None:
            previous_revision = item.plan.revision
            plan = refresh_plan(item)
            if not isinstance(plan, AcquisitionPlan):
                raise TypeError("refresh_plan must return AcquisitionPlan")
            if plan.revision != previous_revision:
                if plan.revision in item.plan_revisions:
                    failure = _plan_cycle_failure()
                    failed_tier = item.current_tier.value if item.current_tier is not None else "-"
                    item.disposition = WorkItemDisposition.FAILED
                    item.failure = failure
                    item.current_tier = None
                    _log_failure(
                        event="acquisition-plan-failed",
                        work_key=item.work_key,
                        tier=failed_tier,
                        route_key="-",
                        provider_group="-",
                        failure=failure,
                    )
                    return
                item.plan_revisions.append(plan.revision)
            item.plan = plan
            if plan.revision != previous_revision:
                _log_plan(
                    item,
                    event="acquisition-plan-refreshed",
                    previous_revision=previous_revision,
                )
            else:
                _LOGGER.debug(
                    "event=acquisition-plan-unchanged work_key=%s plan_revision=%s "
                    "resolution_evidence_kind=%s",
                    item.work_key,
                    plan.revision,
                    _resolution_evidence_kind(item),
                )

        self._run_parallel(tuple(lambda item=item: refresh(item) for item in active))

    def _admit_browser(
        self,
        items: tuple[AcquisitionWorkItem, ...],
    ) -> BrowserAdmissionResult:
        candidates = []
        for item in items:
            if item.disposition is not WorkItemDisposition.PENDING:
                continue
            routes = tuple(
                route
                for route in item.plan.routes_for(AcquisitionPath.CONTROLLED_BROWSER)
                if route.route_key not in item.attempted_route_keys
            )
            if not routes:
                continue
            if len(routes) != 1:
                item.disposition = WorkItemDisposition.FAILED
                item.failure = _browser_plan_failure()
                item.current_tier = None
                continue
            route = routes[0]
            if route.risk_group is None:
                item.disposition = WorkItemDisposition.FAILED
                item.failure = _browser_plan_failure()
                item.current_tier = None
                continue
            candidates.append(
                BrowserAdmissionCandidate(
                    work_key=item.work_key,
                    route_key=route.route_key,
                    rate_limit_group=route.risk_group,
                    readiness=route.readiness,
                    failure=route.failure,
                )
            )
        runtime_states: list[BrowserGroupRuntimeSnapshot] = []
        scheduler = self._browser_scheduler
        if scheduler is not None:
            for group_key in sorted({candidate.rate_limit_group for candidate in candidates}):
                group = self._browser_admission.group_state_for(group_key)
                if group is not None:
                    runtime_states.append(scheduler.runtime_snapshot(group.policy))
        return self._browser_admission.evaluate(
            tuple(candidates),
            runtime_states=tuple(runtime_states),
        )

    @staticmethod
    def _apply_browser_admission(
        items: tuple[AcquisitionWorkItem, ...],
        result: BrowserAdmissionResult,
    ) -> None:
        by_key = {item.work_key: item for item in items}
        for decision in result.decisions:
            item = by_key[decision.work_key]
            if decision.disposition is BrowserAdmissionDisposition.DEFERRED:
                item.disposition = WorkItemDisposition.DEFERRED
                item.failure = decision.failure
                item.current_tier = None
            elif decision.disposition is BrowserAdmissionDisposition.ACTION_REQUIRED:
                item.disposition = WorkItemDisposition.ACTION_REQUIRED
                item.failure = decision.failure
                item.current_tier = None

    def _execute_browser_tier(
        self,
        items: tuple[AcquisitionWorkItem, ...],
        admission: BrowserAdmissionResult,
        execute_route: RouteExecutor,
        *,
        cancel_event: BrowserSchedulerCancellation | None,
    ) -> None:
        allowed = {
            decision.work_key
            for decision in admission.decisions
            if decision.disposition is BrowserAdmissionDisposition.ALLOWED
        }
        active = tuple(
            item
            for item in items
            if item.work_key in allowed and item.disposition is WorkItemDisposition.PENDING
        )
        if not active:
            return
        scheduler = self._browser_scheduler
        if scheduler is None:
            for item in active:
                item.disposition = WorkItemDisposition.FAILED
                item.failure = _browser_scheduler_failure()
                item.current_tier = None
            return
        attempts = []
        items_by_key = {item.work_key: item for item in active}
        for item in active:
            route = self._pending_browser_route(item)
            if route is None or route.risk_group is None:
                item.disposition = WorkItemDisposition.FAILED
                item.failure = _browser_plan_failure()
                item.current_tier = None
                continue
            group = self._browser_admission.group_state_for(route.risk_group)
            if group is None:
                item.disposition = WorkItemDisposition.FAILED
                item.failure = _browser_scheduler_failure()
                item.current_tier = None
                continue
            attempts.append(
                BrowserArticleAttempt(
                    attempt_key=item.work_key,
                    rate_limit_group=group.rate_limit_group,
                    session_key=str(group.session_key),
                    policy=group.policy,
                )
            )

        def run(attempt: BrowserArticleAttempt) -> BrowserAttemptCompletion[None]:
            item = items_by_key[attempt.attempt_key]
            pending_route = self._pending_browser_route(item)
            started_ns = time.monotonic_ns()
            _LOGGER.debug(
                "event=acquisition-browser-group-item-started work_key=%s "
                "provider_group=%s route_key=%s",
                item.work_key,
                attempt.rate_limit_group,
                pending_route.route_key if pending_route is not None else "-",
            )
            self._execute_tier(
                item,
                AcquisitionPath.CONTROLLED_BROWSER,
                execute_route,
            )
            failed = item.disposition in {
                WorkItemDisposition.DEFERRED,
                WorkItemDisposition.ACTION_REQUIRED,
                WorkItemDisposition.FAILED,
            }
            _LOGGER.debug(
                "event=acquisition-browser-group-item-finished work_key=%s "
                "provider_group=%s outcome=%s elapsed_ms=%d",
                item.work_key,
                attempt.rate_limit_group,
                item.disposition.value,
                _elapsed_ms(started_ns),
            )
            return BrowserAttemptCompletion(
                None,
                (
                    BrowserAttemptDisposition.FAILED
                    if failed
                    else BrowserAttemptDisposition.COMPLETED
                ),
                _browser_group_feedback(item),
            )

        scheduled = scheduler.execute(tuple(attempts), run, cancel_event=cancel_event)
        _apply_scheduled_browser_blocks(scheduled, items_by_key)

    @staticmethod
    def _pending_browser_route(item: AcquisitionWorkItem) -> RouteSpec | None:
        routes = tuple(
            route
            for route in item.plan.routes_for(AcquisitionPath.CONTROLLED_BROWSER)
            if route.route_key not in item.attempted_route_keys
        )
        return routes[0] if len(routes) == 1 else None

    def _run_parallel(self, callbacks: tuple[Callable[[], None], ...]) -> None:
        if not callbacks:
            return
        if len(callbacks) == 1:
            callbacks[0]()
            return
        with ThreadPoolExecutor(
            max_workers=min(self._max_concurrency, len(callbacks)),
            thread_name_prefix="sciretriever-acquisition-cohort",
        ) as executor:
            futures: tuple[Future[None], ...] = tuple(
                executor.submit(callback) for callback in callbacks
            )
            for future in futures:
                future.result()


def _readiness_outcome(route: RouteSpec) -> RouteExecutionResult | None:
    if route.readiness is RouteReadiness.READY:
        return None
    if route.readiness in {RouteReadiness.DISABLED, RouteReadiness.UNSUPPORTED}:
        return RouteExecutionResult.normal_miss()
    if route.readiness is RouteReadiness.UNCONFIGURED:
        if route.allows_browser_after_unconfigured:
            return RouteExecutionResult.normal_miss()
        return RouteExecutionResult.action_required(
            route.failure
            or StableFailure(
                code="acquisition-route-unconfigured",
                reason="An applicable acquisition route is not configured.",
                action="Configure the route or disable it before retrying.",
                retryable=False,
            )
        )
    return RouteExecutionResult.deferred(
        route.failure
        or StableFailure(
            code="acquisition-route-temporarily-unavailable",
            reason="An applicable acquisition route is temporarily unavailable.",
            action="Retry after the route becomes available.",
            retryable=True,
        )
    )


def _browser_plan_failure() -> StableFailure:
    return StableFailure(
        code="acquisition-browser-plan-contract",
        reason="The acquisition plan contains an invalid Browser route set.",
        action="Refresh the installation and retry the acquisition operation.",
        retryable=False,
    )


def _browser_scheduler_failure() -> StableFailure:
    return StableFailure(
        code="acquisition-browser-scheduler-unavailable",
        reason="The admitted Browser route has no matching in-process scheduler policy.",
        action="Correct Browser scheduler assembly before retrying acquisition.",
        retryable=False,
    )


def _browser_group_feedback(item: AcquisitionWorkItem) -> BrowserGroupFeedback:
    if item.disposition in {
        WorkItemDisposition.PENDING,
        WorkItemDisposition.DELIVERED,
        WorkItemDisposition.EXHAUSTED,
    }:
        return BrowserGroupFeedback.SUCCESS
    failure = item.failure
    if failure is None:
        return BrowserGroupFeedback.NONE
    return {
        "acquisition-browser-login-required": BrowserGroupFeedback.LOGIN_REQUIRED,
        "acquisition-browser-mfa-required": BrowserGroupFeedback.MFA_REQUIRED,
        "acquisition-browser-ip-blocked": BrowserGroupFeedback.IP_BLOCKED,
        "acquisition-browser-account-warning": BrowserGroupFeedback.ACCOUNT_WARNING,
        "acquisition-browser-rate-limited": BrowserGroupFeedback.RATE_LIMITED,
        "acquisition-browser-runtime-failed": BrowserGroupFeedback.RUNTIME_FAILURE,
        "acquisition-browser-cleanup-failed": BrowserGroupFeedback.CLEANUP_FAILURE,
        "acquisition-browser-page-state-conflict": BrowserGroupFeedback.RUNTIME_FAILURE,
    }.get(failure.code, BrowserGroupFeedback.NONE)


def _browser_runtime_block_failure(
    state: BrowserGroupRuntimeSnapshot,
) -> StableFailure:
    if state.circuit_reason is None:
        return StableFailure(
            code="acquisition-browser-group-rate-limited",
            reason="The Browser provider risk group is still rate limited.",
            action="Retry after the declared provider cooldown has elapsed.",
            retryable=True,
        )
    action_by_reason = {
        BrowserCircuitReason.LOGIN_REQUIRED: (
            "Use an authorized API or provide the PDF manually; Browser login is unsupported."
        ),
        BrowserCircuitReason.MFA_REQUIRED: (
            "Use an authorized API or provide the PDF manually; Browser MFA is unsupported."
        ),
        BrowserCircuitReason.IP_BLOCKED: "Review the provider IP access block.",
        BrowserCircuitReason.ACCOUNT_WARNING: "Review the provider account warning.",
        BrowserCircuitReason.CLEANUP_FAILURE: (
            "Repair Browser resource cleanup and explicitly acknowledge the provider circuit."
        ),
        BrowserCircuitReason.RUNTIME_FAILURE: (
            "Repair the Browser runtime and explicitly acknowledge the provider circuit."
        ),
    }
    return StableFailure(
        code=f"acquisition-browser-group-{state.circuit_reason.value}",
        reason="The Browser provider risk group requires operator attention.",
        action=action_by_reason[state.circuit_reason],
        retryable=False,
    )


def _apply_scheduled_browser_blocks(
    scheduled: tuple[BrowserScheduledAttemptResult[None], ...],
    items_by_key: dict[str, AcquisitionWorkItem],
) -> None:
    for result in scheduled:
        if result.disposition is BrowserScheduledDisposition.EXECUTED:
            continue
        item = items_by_key[result.attempt_key]
        runtime_state = result.runtime_state
        if runtime_state is None:
            raise RuntimeError("Browser scheduler omitted runtime state for a blocked attempt")
        item.current_tier = None
        failure = _browser_runtime_block_failure(runtime_state)
        item.failure = failure
        item.disposition = (
            WorkItemDisposition.DEFERRED
            if result.disposition is BrowserScheduledDisposition.DEFERRED
            else WorkItemDisposition.ACTION_REQUIRED
        )
        _log_failure(
            event="acquisition-browser-group-blocked",
            work_key=item.work_key,
            tier=AcquisitionPath.CONTROLLED_BROWSER.value,
            route_key="-",
            provider_group=runtime_state.rate_limit_group,
            failure=failure,
            disposition=item.disposition.value,
            next_step="stop",
        )


def _plan_cycle_failure() -> StableFailure:
    return StableFailure(
        code="acquisition-plan-cycle",
        reason="The acquisition plan returned to an earlier revision.",
        action="Review route planning configuration before retrying acquisition.",
        retryable=False,
    )


def _apply_route_result(item: AcquisitionWorkItem, result: RouteExecutionResult) -> None:
    for hint in result.hints:
        if hint not in item.route_hints:
            item.route_hints.append(hint)
    if result.outcome in {RouteOutcome.NORMAL_MISS, RouteOutcome.HINTS}:
        return
    if result.outcome is RouteOutcome.PDF_DELIVERED:
        item.temporary_pdf = result.temporary_pdf
        item.failure = None
        item.route_issues.clear()
        item.disposition = WorkItemDisposition.DELIVERED
        return
    if result.outcome is RouteOutcome.FATAL_FAILURE:
        item.failure = result.failure
        item.disposition = WorkItemDisposition.FAILED
        return
    item.route_issues.append(result)


def _finalize_blocking_low_risk_route_issues(
    items: tuple[AcquisitionWorkItem, ...],
) -> None:
    """Stop Browser escalation only for low-risk outcomes that require a pause."""

    for item in items:
        if any(
            issue.outcome in {RouteOutcome.DEFERRED, RouteOutcome.ACTION_REQUIRED}
            for issue in item.route_issues
        ):
            _finalize_route_issue(item)


def _finalize_route_issue(item: AcquisitionWorkItem) -> None:
    if item.disposition is not WorkItemDisposition.PENDING or not item.route_issues:
        return
    blocking = tuple(
        issue
        for issue in item.route_issues
        if issue.outcome in {RouteOutcome.DEFERRED, RouteOutcome.ACTION_REQUIRED}
    )
    # A blocking route result is more actionable than a route-local failure.
    # Otherwise the last concrete failure is the deepest route that actually
    # ran.  A Browser normal miss adds no issue, so the earlier Public/API
    # failure remains intact; a specific Browser failure becomes the primary
    # result while every earlier route still has its own debug event.
    issue = blocking[-1] if blocking else item.route_issues[-1]
    item.failure = issue.failure
    item.disposition = {
        RouteOutcome.DEFERRED: WorkItemDisposition.DEFERRED,
        RouteOutcome.ACTION_REQUIRED: WorkItemDisposition.ACTION_REQUIRED,
        RouteOutcome.FAILURE: WorkItemDisposition.FAILED,
    }[issue.outcome]
    item.current_tier = None


def _resolution_evidence_kind(item: AcquisitionWorkItem) -> str:
    selected = item.plan.resolution.selected_evidence_kind
    return "unresolved" if selected is None else selected.value


def _route_group(route: RouteSpec) -> str:
    return route.risk_group or route.quota_group or route.profile_access_key or "public"


def _log_plan(
    item: AcquisitionWorkItem,
    *,
    event: str,
    previous_revision: str = "-",
) -> None:
    resolution = item.plan.resolution
    _LOGGER.debug(
        "event=%s work_key=%s plan_revision=%s previous_revision=%s "
        "resolution=%s resolution_evidence_kind=%s route_count=%d",
        event,
        item.work_key,
        item.plan.revision,
        previous_revision,
        resolution.access_key or ("conflicting" if resolution.conflicted else "unresolved"),
        _resolution_evidence_kind(item),
        len(item.plan.routes),
    )


def _progress_group(
    item: AcquisitionWorkItem,
    tier: AcquisitionPath,
) -> str:
    routes = item.plan.routes_for(tier)
    if tier is AcquisitionPath.CONTROLLED_BROWSER:
        risk_group = next(
            (route.risk_group for route in routes if route.risk_group is not None),
            None,
        )
        if risk_group is not None:
            return risk_group
    resolution = item.plan.resolution.access_key
    if resolution is not None:
        return resolution
    for field_name in ("profile_access_key", "quota_group", "risk_group"):
        value = next(
            (
                getattr(route, field_name)
                for route in routes
                if getattr(route, field_name) is not None
            ),
            None,
        )
        if isinstance(value, str):
            return value
    return "unresolved"


def _progress_counts(
    items: tuple[AcquisitionWorkItem, ...],
) -> tuple[int, int, int, int, int, int, int]:
    counts = {
        disposition: sum(item.disposition is disposition for item in items)
        for disposition in WorkItemDisposition
    }
    return (
        len(items),
        counts[WorkItemDisposition.DELIVERED],
        counts[WorkItemDisposition.PENDING],
        counts[WorkItemDisposition.DEFERRED],
        counts[WorkItemDisposition.ACTION_REQUIRED],
        counts[WorkItemDisposition.FAILED],
        counts[WorkItemDisposition.EXHAUSTED],
    )


def _progress_snapshot(
    items: tuple[AcquisitionWorkItem, ...],
    *,
    tier: AcquisitionPath,
    phase: AcquisitionProgressPhase,
) -> AcquisitionProgressSnapshot:
    grouped: dict[str, list[AcquisitionWorkItem]] = {}
    for item in items:
        grouped.setdefault(_progress_group(item, tier), []).append(item)
    groups = tuple(
        _group_progress(provider_group, tuple(group_items))
        for provider_group, group_items in sorted(grouped.items())
    )
    counts = _progress_counts(items)
    return AcquisitionProgressSnapshot(
        tier=tier,
        phase=phase,
        selected=counts[0],
        resolved=counts[1],
        pending=counts[2],
        deferred=counts[3],
        action_required=counts[4],
        failed=counts[5],
        exhausted=counts[6],
        groups=groups,
    )


def _group_progress(
    provider_group: str,
    items: tuple[AcquisitionWorkItem, ...],
) -> AcquisitionGroupProgress:
    counts = _progress_counts(items)
    return AcquisitionGroupProgress(
        provider_group=provider_group,
        selected=counts[0],
        resolved=counts[1],
        pending=counts[2],
        deferred=counts[3],
        action_required=counts[4],
        failed=counts[5],
        exhausted=counts[6],
    )


def _log_tier_progress(
    snapshot: AcquisitionProgressSnapshot,
    *,
    elapsed_ms: int | None,
) -> None:
    event = f"acquisition-tier-{snapshot.phase.value}"
    # Entry owns the user-facing tier snapshot.  Keep the Acquisition copy at
    # DEBUG so a configured CLI does not print the same cohort partition
    # twice, while direct diagnostics still retain the module boundary.
    _LOGGER.debug(
        "event=%s tier=%s selected=%d resolved=%d pending=%d deferred=%d "
        "action_required=%d failed=%d exhausted=%d provider_group_count=%d "
        "next=%s elapsed_ms=%s",
        event,
        snapshot.tier.value,
        snapshot.selected,
        snapshot.resolved,
        snapshot.pending,
        snapshot.deferred,
        snapshot.action_required,
        snapshot.failed,
        snapshot.exhausted,
        len(snapshot.groups),
        _tier_next_step(snapshot),
        "-" if elapsed_ms is None else elapsed_ms,
    )
    for group in snapshot.groups:
        _LOGGER.debug(
            "event=acquisition-tier-group-progress phase=%s tier=%s provider_group=%s "
            "selected=%d resolved=%d pending=%d deferred=%d action_required=%d "
            "failed=%d exhausted=%d",
            snapshot.phase.value,
            snapshot.tier.value,
            group.provider_group,
            group.selected,
            group.resolved,
            group.pending,
            group.deferred,
            group.action_required,
            group.failed,
            group.exhausted,
        )


def _log_route_result(
    item: AcquisitionWorkItem,
    route: RouteSpec,
    result: RouteExecutionResult,
    *,
    next_step: str,
    elapsed_ms: int,
) -> None:
    common = (
        item.work_key,
        route.tier.value,
        route.route_key,
        _route_group(route),
    )
    if result.outcome in {RouteOutcome.NORMAL_MISS, RouteOutcome.HINTS}:
        _LOGGER.debug(
            "event=acquisition-route-missed work_key=%s tier=%s route_key=%s "
            "provider_group=%s outcome=%s disposition=miss next=%s hint_count=%d "
            "elapsed_ms=%d",
            *common,
            result.outcome.value,
            next_step,
            len(result.hints),
            elapsed_ms,
        )
        return
    if result.outcome is RouteOutcome.PDF_DELIVERED:
        _LOGGER.debug(
            "event=acquisition-route-delivered work_key=%s tier=%s route_key=%s "
            "provider_group=%s outcome=pdf-delivered disposition=delivered next=stop "
            "elapsed_ms=%d",
            *common,
            elapsed_ms,
        )
        return
    failure = result.failure
    if failure is None:
        failure = _browser_plan_failure()
    _log_failure(
        event=f"acquisition-route-{result.outcome.value}",
        work_key=item.work_key,
        tier=route.tier.value,
        route_key=route.route_key,
        provider_group=_route_group(route),
        failure=failure,
        disposition=_route_disposition(result.outcome),
        next_step=next_step,
        elapsed_ms=elapsed_ms,
    )


def _log_failure(
    *,
    event: str,
    work_key: str,
    tier: str,
    route_key: str,
    provider_group: str,
    failure: StableFailure,
    disposition: str = "failure",
    next_step: str = "stop",
    elapsed_ms: int | None = None,
) -> None:
    _LOGGER.debug(
        "event=%s work_key=%s tier=%s route_key=%s provider_group=%s "
        "disposition=%s next=%s elapsed_ms=%s code=%s retryable=%s reason=%s action=%s",
        event,
        work_key,
        tier,
        route_key,
        provider_group,
        disposition,
        next_step,
        "-" if elapsed_ms is None else elapsed_ms,
        failure.code,
        str(failure.retryable).lower(),
        failure.reason,
        failure.action,
    )


def _log_browser_admission(result: BrowserAdmissionResult) -> None:
    groups = result.summary.groups
    durations = tuple(
        group.conservative_minimum_duration_seconds
        for group in groups
        if group.conservative_minimum_duration_seconds is not None
    )
    _LOGGER.debug(
        "event=acquisition-browser-escalation-ready selected=%d parallel_group_count=%d "
        "eligible=%d admitted=%d allowed=%d deferred=%d action_required=%d rejected=%d "
        "minimum_duration_seconds=%s",
        sum(group.paper_count for group in groups),
        sum(group.allowed_count > 0 for group in groups),
        sum(group.eligible_count for group in groups),
        sum(group.allowed_count for group in groups),
        sum(group.allowed_count for group in groups),
        sum(group.deferred_count for group in groups),
        sum(group.action_required_count for group in groups),
        sum(group.rejected_count for group in groups),
        "-" if not durations else f"{max(durations):g}",
    )
    for group in groups:
        _LOGGER.debug(
            "event=acquisition-browser-group-admission provider_group=%s papers=%d "
            "eligible=%d allowed=%d deferred=%d action_required=%d rejected=%d "
            "readiness=%s minimum_start_interval=%s earliest_start_in_seconds=%s "
            "next_allowed_in_seconds=%s minimum_duration_seconds=%s "
            "required_action_count=%d",
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
            group.earliest_start_in_seconds,
            group.conservative_minimum_duration_seconds,
            len(group.required_actions),
        )
        for action in group.required_actions:
            _LOGGER.debug(
                "event=acquisition-browser-group-action provider_group=%s action=%s",
                group.rate_limit_group,
                action,
            )
    for decision in result.decisions:
        if decision.failure is not None:
            _log_failure(
                event=f"acquisition-browser-admission-{decision.disposition.value}",
                work_key=decision.work_key,
                tier=AcquisitionPath.CONTROLLED_BROWSER.value,
                route_key=decision.route_key,
                provider_group=decision.rate_limit_group,
                failure=decision.failure,
                disposition=decision.disposition.value,
                next_step="stop",
            )
        elif decision.disposition is BrowserAdmissionDisposition.REJECTED:
            _LOGGER.debug(
                "event=acquisition-browser-admission-rejected work_key=%s tier=%s "
                "route_key=%s provider_group=%s outcome=normal-skip",
                decision.work_key,
                AcquisitionPath.CONTROLLED_BROWSER.value,
                decision.route_key,
                decision.rate_limit_group,
            )
        else:
            _LOGGER.debug(
                "event=acquisition-browser-admission-allowed work_key=%s tier=%s "
                "route_key=%s provider_group=%s",
                decision.work_key,
                AcquisitionPath.CONTROLLED_BROWSER.value,
                decision.route_key,
                decision.rate_limit_group,
            )


def _log_cohort_finished(
    items: tuple[AcquisitionWorkItem, ...],
    *,
    elapsed_ms: int,
) -> None:
    counts = {
        disposition: sum(item.disposition is disposition for item in items)
        for disposition in WorkItemDisposition
    }
    _LOGGER.debug(
        "event=acquisition-cohort-finished target_count=%d delivered=%d exhausted=%d "
        "deferred=%d action_required=%d failed=%d elapsed_ms=%d",
        len(items),
        counts[WorkItemDisposition.DELIVERED],
        counts[WorkItemDisposition.EXHAUSTED],
        counts[WorkItemDisposition.DEFERRED],
        counts[WorkItemDisposition.ACTION_REQUIRED],
        counts[WorkItemDisposition.FAILED],
        elapsed_ms,
    )


def _route_disposition(outcome: RouteOutcome) -> str:
    return {
        RouteOutcome.NORMAL_MISS: "miss",
        RouteOutcome.HINTS: "miss",
        RouteOutcome.PDF_DELIVERED: "delivered",
        RouteOutcome.DEFERRED: "deferred",
        RouteOutcome.ACTION_REQUIRED: "action-required",
        RouteOutcome.FAILURE: "failure",
        RouteOutcome.FATAL_FAILURE: "fatal",
    }[outcome]


def _route_next_step(
    item: AcquisitionWorkItem,
    route: RouteSpec,
    result: RouteExecutionResult,
    *,
    has_remaining_route: bool,
) -> str:
    if result.outcome in {RouteOutcome.PDF_DELIVERED, RouteOutcome.FATAL_FAILURE}:
        return "stop"
    if has_remaining_route:
        return "next-route"
    if route.tier is AcquisitionPath.PUBLIC:
        return "next-tier"
    if route.tier is AcquisitionPath.AUTHORIZED_PROVIDER_API:
        route_issues = (*item.route_issues, result)
        if any(
            issue.outcome in {RouteOutcome.DEFERRED, RouteOutcome.ACTION_REQUIRED}
            for issue in route_issues
        ):
            return "stop"
        return "browser-admission"
    return "stop"


def _tier_next_step(snapshot: AcquisitionProgressSnapshot) -> str:
    if snapshot.phase is AcquisitionProgressPhase.STARTED:
        return "execute-tier"
    if snapshot.tier is AcquisitionPath.PUBLIC:
        return "next-tier"
    if snapshot.tier is AcquisitionPath.AUTHORIZED_PROVIDER_API:
        return "browser-admission"
    return "stop"


def _elapsed_ms(started_ns: int) -> int:
    return max(0, (time.monotonic_ns() - started_ns) // 1_000_000)


def _freeze_result(item: AcquisitionWorkItem) -> AcquisitionWorkItemResult:
    return AcquisitionWorkItemResult(
        work_key=item.work_key,
        disposition=item.disposition,
        attempted_route_keys=tuple(item.attempted_route_keys),
        route_hints=tuple(item.route_hints),
        temporary_pdf=item.temporary_pdf,
        failure=item.failure,
    )


__all__ = (
    "AcquisitionGroupProgress",
    "AcquisitionProgressObserver",
    "AcquisitionProgressPhase",
    "AcquisitionProgressSnapshot",
    "AcquisitionWorkItem",
    "AcquisitionWorkItemResult",
    "BrowserEscalationObserver",
    "CohortExecutionResult",
    "TieredCohortExecutor",
    "WorkItemDisposition",
)
