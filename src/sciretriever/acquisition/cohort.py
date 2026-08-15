"""In-memory tier barriers for one bounded PDF-acquisition cohort."""

from __future__ import annotations

import re
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


@unique
class WorkItemDisposition(str, Enum):
    PENDING = "pending"
    DELIVERED = "delivered"
    EXHAUSTED = "exhausted"
    DEFERRED = "deferred"
    ACTION_REQUIRED = "action-required"
    FAILED = "failed"


def _work_key(value: object) -> str:
    if type(value) is not str:
        raise TypeError("work_key must be a string")
    candidate = value.strip()
    if _WORK_KEY.fullmatch(candidate) is None:
        raise ValueError("work_key must be a stable operation-local identity")
    return candidate


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
        cancel_event: BrowserSchedulerCancellation | None = None,
    ) -> CohortExecutionResult:
        self._validate_inputs(
            items,
            execute_route,
            refresh_plan,
            on_tier_completed,
            cancel_event,
        )
        for tier in _TIER_ORDER[:2]:
            self._execute_tier_with_replanning(
                items,
                tier,
                execute_route,
                refresh_plan,
            )
            self._notify_tier_completed(items, tier, on_tier_completed)
        browser_admission = self._admit_browser(items)
        self._apply_browser_admission(items, browser_admission)
        self._execute_browser_tier(
            items,
            browser_admission,
            execute_route,
            cancel_event=cancel_event,
        )
        for item in items:
            if item.disposition is WorkItemDisposition.PENDING:
                item.disposition = WorkItemDisposition.EXHAUSTED
                item.current_tier = None
        self._notify_tier_completed(
            items,
            AcquisitionPath.CONTROLLED_BROWSER,
            on_tier_completed,
        )
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

    def _execute_tier(
        self,
        item: AcquisitionWorkItem,
        tier: AcquisitionPath,
        execute_route: RouteExecutor,
    ) -> None:
        item.current_tier = tier
        for route in item.plan.routes_for(tier):
            if item.disposition is not WorkItemDisposition.PENDING:
                break
            if route.route_key in item.attempted_route_keys:
                continue
            item.attempted_route_keys.append(route.route_key)
            readiness = _readiness_outcome(route)
            result = readiness if readiness is not None else execute_route(item, route)
            if not isinstance(result, RouteExecutionResult):
                raise TypeError("execute_route must return RouteExecutionResult")
            _apply_route_result(item, result)

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
                    item.disposition = WorkItemDisposition.FAILED
                    item.failure = _plan_cycle_failure()
                    item.current_tier = None
                    return
                item.plan_revisions.append(plan.revision)
            item.plan = plan

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
                    resolution_confirmed=item.plan.resolution.is_strong,
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
            StableFailure(
                code="acquisition-route-unconfigured",
                reason="An applicable acquisition route is not configured.",
                action="Configure the route or disable it before retrying.",
                retryable=False,
            )
        )
    return RouteExecutionResult.deferred(
        StableFailure(
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
        "acquisition-browser-challenge-required": BrowserGroupFeedback.CHALLENGE_REQUIRED,
        "acquisition-browser-ip-blocked": BrowserGroupFeedback.IP_BLOCKED,
        "acquisition-browser-account-warning": BrowserGroupFeedback.ACCOUNT_WARNING,
        "acquisition-browser-rate-limited": BrowserGroupFeedback.RATE_LIMITED,
        "acquisition-browser-runtime-failed": BrowserGroupFeedback.RUNTIME_FAILURE,
        "acquisition-browser-cleanup-failed": BrowserGroupFeedback.RUNTIME_FAILURE,
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
        BrowserCircuitReason.LOGIN_REQUIRED: "Complete provider login outside automation.",
        BrowserCircuitReason.MFA_REQUIRED: "Complete provider MFA outside automation.",
        BrowserCircuitReason.CHALLENGE_REQUIRED: (
            "Review the provider challenge outside automation."
        ),
        BrowserCircuitReason.IP_BLOCKED: "Review the provider IP access block.",
        BrowserCircuitReason.ACCOUNT_WARNING: "Review the provider account warning.",
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
        item.failure = _browser_runtime_block_failure(runtime_state)
        item.disposition = (
            WorkItemDisposition.DEFERRED
            if result.disposition is BrowserScheduledDisposition.DEFERRED
            else WorkItemDisposition.ACTION_REQUIRED
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
        item.disposition = WorkItemDisposition.DELIVERED
        return
    item.failure = result.failure
    item.disposition = {
        RouteOutcome.DEFERRED: WorkItemDisposition.DEFERRED,
        RouteOutcome.ACTION_REQUIRED: WorkItemDisposition.ACTION_REQUIRED,
        RouteOutcome.FAILURE: WorkItemDisposition.FAILED,
    }[result.outcome]


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
    "AcquisitionWorkItem",
    "AcquisitionWorkItemResult",
    "CohortExecutionResult",
    "TieredCohortExecutor",
    "WorkItemDisposition",
)
