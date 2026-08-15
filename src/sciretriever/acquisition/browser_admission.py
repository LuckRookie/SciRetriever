"""Side-effect-free Browser escalation admission for one acquisition cohort."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum, unique
from typing import Final

from sciretriever.acquisition.access_profiles import BrowserSessionKey
from sciretriever.acquisition.planning import RouteReadiness
from sciretriever.model.report import StableFailure
from sciretriever.network.browser_scheduler import (
    BrowserCircuitReason,
    BrowserGroupPolicy,
    BrowserGroupRuntimeSnapshot,
)

_WORK_KEY: Final[re.Pattern[str]] = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$",
    re.ASCII,
)
_ROUTE_KEY: Final[re.Pattern[str]] = re.compile(
    r"^[a-z][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)+$",
    re.ASCII,
)


def _work_key(value: object) -> str:
    if type(value) is not str:
        raise TypeError("work_key must be a string")
    candidate = value.strip()
    if _WORK_KEY.fullmatch(candidate) is None:
        raise ValueError("work_key must be a stable operation-local identity")
    return candidate


def _route_key(value: object) -> str:
    if type(value) is not str:
        raise TypeError("route_key must be a string")
    candidate = value.strip().casefold()
    if len(candidate) > 128 or _ROUTE_KEY.fullmatch(candidate) is None:
        raise ValueError("route_key must be a namespaced stable identity")
    return candidate


def _finite_nonnegative(value: object, *, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{field_name} must be a number")
    candidate = float(value)
    if candidate < 0.0 or candidate == float("inf") or candidate != candidate:
        raise ValueError(f"{field_name} must be finite and nonnegative")
    return candidate


def _rate_limit_group(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("rate_limit_group must be a string")
    try:
        return BrowserGroupPolicy(
            rate_limit_group=str(value),
            policy_revision="identity-validation",
            minimum_start_interval=0.0,
            rate_limit_cooldown=1.0,
            runtime_failure_threshold=1,
        ).rate_limit_group
    except ValueError:
        raise ValueError("rate_limit_group must be a stable non-sensitive identity") from None


@unique
class BrowserAdmissionDisposition(str, Enum):
    """The only side-effect-free outcomes before Browser execution."""

    ALLOWED = "allowed"
    DEFERRED = "deferred"
    ACTION_REQUIRED = "action-required"
    REJECTED = "rejected"


@unique
class BrowserGroupReadiness(str, Enum):
    """Secret-free operator/runtime state visible to escalation admission."""

    READY = "ready"
    SESSION_MISSING = "session-missing"
    LOGIN_REQUIRED = "login-required"
    MFA_REQUIRED = "mfa-required"
    CHALLENGE_REQUIRED = "challenge-required"
    RATE_LIMITED = "rate-limited"
    IP_BLOCKED = "ip-blocked"
    ACCOUNT_WARNING = "account-warning"
    CIRCUIT_OPEN = "circuit-open"
    RUNTIME_FAILED = "runtime-failed"


@dataclass(frozen=True, slots=True)
class BrowserGroupAdmissionState:
    """One current risk-group snapshot without session contents or URLs."""

    policy: BrowserGroupPolicy
    session_key: str
    readiness: BrowserGroupReadiness
    earliest_start_in_seconds: float = 0.0

    def __post_init__(self) -> None:
        if not isinstance(self.policy, BrowserGroupPolicy):
            raise TypeError("policy must be a BrowserGroupPolicy")
        object.__setattr__(self, "session_key", BrowserSessionKey(self.session_key))
        if not isinstance(self.readiness, BrowserGroupReadiness):
            raise TypeError("readiness must be BrowserGroupReadiness")
        object.__setattr__(
            self,
            "earliest_start_in_seconds",
            _finite_nonnegative(
                self.earliest_start_in_seconds,
                field_name="earliest_start_in_seconds",
            ),
        )

    @property
    def rate_limit_group(self) -> str:
        return self.policy.rate_limit_group


@dataclass(frozen=True, slots=True)
class BrowserAdmissionConfiguration:
    """Operation-local authority and readiness supplied by Entry/Bootstrap."""

    explicitly_enabled: bool = False
    execution_confirmed: bool = False
    runtime_ready: bool = False
    groups: tuple[BrowserGroupAdmissionState, ...] = ()

    def __post_init__(self) -> None:
        for field_name in (
            "explicitly_enabled",
            "execution_confirmed",
            "runtime_ready",
        ):
            if type(getattr(self, field_name)) is not bool:
                raise TypeError(f"{field_name} must be a bool")
        if not isinstance(self.groups, tuple) or any(
            not isinstance(group, BrowserGroupAdmissionState) for group in self.groups
        ):
            raise TypeError("groups must contain BrowserGroupAdmissionState values")
        keys = tuple(group.rate_limit_group for group in self.groups)
        if len(keys) != len(set(keys)):
            raise ValueError("Browser admission group states must be unique")
        if self.execution_confirmed and not self.explicitly_enabled:
            raise ValueError("Browser execution cannot be confirmed while disabled")
        if self.runtime_ready and not self.explicitly_enabled:
            raise ValueError("Browser runtime cannot be ready while disabled")


@dataclass(frozen=True, slots=True)
class BrowserAdmissionCandidate:
    """One redacted, side-effect-free Browser route considered for escalation."""

    work_key: str
    route_key: str
    rate_limit_group: str
    readiness: RouteReadiness
    resolution_confirmed: bool

    def __post_init__(self) -> None:
        object.__setattr__(self, "work_key", _work_key(self.work_key))
        object.__setattr__(self, "route_key", _route_key(self.route_key))
        object.__setattr__(
            self,
            "rate_limit_group",
            _rate_limit_group(self.rate_limit_group),
        )
        if not isinstance(self.readiness, RouteReadiness):
            raise TypeError("readiness must be RouteReadiness")
        if type(self.resolution_confirmed) is not bool:
            raise TypeError("resolution_confirmed must be a bool")


@dataclass(frozen=True, slots=True)
class BrowserAdmissionDecision:
    work_key: str
    route_key: str
    rate_limit_group: str
    disposition: BrowserAdmissionDisposition
    failure: StableFailure | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "work_key", _work_key(self.work_key))
        object.__setattr__(self, "route_key", _route_key(self.route_key))
        object.__setattr__(
            self,
            "rate_limit_group",
            _rate_limit_group(self.rate_limit_group),
        )
        if not isinstance(self.disposition, BrowserAdmissionDisposition):
            raise TypeError("disposition must be BrowserAdmissionDisposition")
        if self.failure is not None and not isinstance(self.failure, StableFailure):
            raise TypeError("failure must be StableFailure or None")
        needs_failure = self.disposition in {
            BrowserAdmissionDisposition.DEFERRED,
            BrowserAdmissionDisposition.ACTION_REQUIRED,
        }
        if needs_failure != (self.failure is not None):
            raise ValueError("only deferred/action-required decisions carry a failure")


@dataclass(frozen=True, slots=True)
class BrowserEscalationGroupSummary:
    """Stable, redacted group summary created before any Browser side effect."""

    rate_limit_group: str
    paper_count: int
    eligible_count: int
    allowed_count: int
    deferred_count: int
    action_required_count: int
    rejected_count: int
    readiness: str
    minimum_start_interval: float | None
    earliest_start_in_seconds: float | None
    conservative_minimum_duration_seconds: float | None
    required_actions: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "rate_limit_group",
            _rate_limit_group(self.rate_limit_group),
        )
        counts = (
            self.paper_count,
            self.eligible_count,
            self.allowed_count,
            self.deferred_count,
            self.action_required_count,
            self.rejected_count,
        )
        if any(type(value) is not int or value < 0 for value in counts):
            raise ValueError("Browser escalation counts must be nonnegative integers")
        if self.eligible_count > self.paper_count:
            raise ValueError("Browser escalation eligible count cannot exceed papers")
        if sum(counts[2:]) != self.paper_count:
            raise ValueError("Browser escalation disposition counts must partition papers")
        if type(self.readiness) is not str or not self.readiness:
            raise ValueError("readiness must be a nonblank stable value")
        for field_name in (
            "minimum_start_interval",
            "earliest_start_in_seconds",
            "conservative_minimum_duration_seconds",
        ):
            value = getattr(self, field_name)
            if value is not None:
                object.__setattr__(
                    self,
                    field_name,
                    _finite_nonnegative(value, field_name=field_name),
                )
        if not isinstance(self.required_actions, tuple) or any(
            type(action) is not str or not action for action in self.required_actions
        ):
            raise TypeError("required_actions must contain nonblank stable strings")
        if self.required_actions != tuple(sorted(set(self.required_actions))):
            raise ValueError("required_actions must be unique and sorted")

    def to_json_value(self) -> dict[str, object]:
        return {
            "rate_limit_group": self.rate_limit_group,
            "paper_count": self.paper_count,
            "eligible_count": self.eligible_count,
            "allowed_count": self.allowed_count,
            "deferred_count": self.deferred_count,
            "action_required_count": self.action_required_count,
            "rejected_count": self.rejected_count,
            "readiness": self.readiness,
            "minimum_start_interval": self.minimum_start_interval,
            "earliest_start_in_seconds": self.earliest_start_in_seconds,
            "conservative_minimum_duration_seconds": (self.conservative_minimum_duration_seconds),
            "required_actions": list(self.required_actions),
        }


@dataclass(frozen=True, slots=True)
class BrowserEscalationSummary:
    """Deterministic current-operation summary; never a persisted business fact."""

    groups: tuple[BrowserEscalationGroupSummary, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.groups, tuple) or any(
            not isinstance(group, BrowserEscalationGroupSummary) for group in self.groups
        ):
            raise TypeError("groups must contain BrowserEscalationGroupSummary values")
        keys = tuple(group.rate_limit_group for group in self.groups)
        if keys != tuple(sorted(keys)) or len(keys) != len(set(keys)):
            raise ValueError("Browser escalation groups must be unique and sorted")

    def to_json_value(self) -> dict[str, object]:
        return {"groups": [group.to_json_value() for group in self.groups]}

    def render_text(self) -> str:
        if not self.groups:
            return "Browser escalation: no eligible groups."
        lines = ["Browser escalation:"]
        for group in self.groups:
            duration = group.conservative_minimum_duration_seconds
            duration_text = "-" if duration is None else f"{duration:g}s"
            interval = group.minimum_start_interval
            interval_text = "-" if interval is None else f"{interval:g}s"
            earliest = group.earliest_start_in_seconds
            earliest_text = "-" if earliest is None else f"{earliest:g}s"
            lines.append(
                "  "
                f"{group.rate_limit_group}: papers={group.paper_count} "
                f"eligible={group.eligible_count} allowed={group.allowed_count} "
                f"deferred={group.deferred_count} "
                f"action_required={group.action_required_count} "
                f"rejected={group.rejected_count} readiness={group.readiness} "
                f"interval={interval_text} earliest={earliest_text} "
                f"minimum_duration={duration_text}"
            )
            lines.extend(f"    action: {action}" for action in group.required_actions)
        return "\n".join(lines)

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("BrowserEscalationSummary cannot be serialized")


@dataclass(frozen=True, slots=True)
class BrowserAdmissionResult:
    decisions: tuple[BrowserAdmissionDecision, ...]
    summary: BrowserEscalationSummary

    def __post_init__(self) -> None:
        if not isinstance(self.decisions, tuple) or any(
            not isinstance(decision, BrowserAdmissionDecision) for decision in self.decisions
        ):
            raise TypeError("decisions must contain BrowserAdmissionDecision values")
        if not isinstance(self.summary, BrowserEscalationSummary):
            raise TypeError("summary must be BrowserEscalationSummary")
        keys = tuple(decision.work_key for decision in self.decisions)
        if len(keys) != len(set(keys)):
            raise ValueError("Browser admission work keys must be unique")

    def decision_for(self, work_key: str) -> BrowserAdmissionDecision | None:
        key = _work_key(work_key)
        return next(
            (decision for decision in self.decisions if decision.work_key == key),
            None,
        )


class BrowserAdmissionController:
    """Classify a finite escalation snapshot without starting Browser runtime."""

    __slots__ = ("_configuration", "_groups")

    def __init__(
        self,
        configuration: BrowserAdmissionConfiguration | None = None,
    ) -> None:
        effective = configuration or BrowserAdmissionConfiguration()
        if not isinstance(effective, BrowserAdmissionConfiguration):
            raise TypeError("configuration must be BrowserAdmissionConfiguration or None")
        self._configuration = effective
        self._groups = {group.rate_limit_group: group for group in effective.groups}

    def evaluate(
        self,
        candidates: tuple[BrowserAdmissionCandidate, ...],
        *,
        runtime_states: tuple[BrowserGroupRuntimeSnapshot, ...] = (),
    ) -> BrowserAdmissionResult:
        if not isinstance(candidates, tuple) or any(
            not isinstance(candidate, BrowserAdmissionCandidate) for candidate in candidates
        ):
            raise TypeError("candidates must contain BrowserAdmissionCandidate values")
        keys = tuple(candidate.work_key for candidate in candidates)
        if len(keys) != len(set(keys)):
            raise ValueError("Browser admission candidates must have unique work keys")
        groups = self._effective_groups(runtime_states)
        decisions = tuple(self._decide(candidate, groups) for candidate in candidates)
        return BrowserAdmissionResult(
            decisions=decisions,
            summary=self._summarize(candidates, decisions, groups),
        )

    def group_state_for(self, rate_limit_group: str) -> BrowserGroupAdmissionState | None:
        """Return one secret-free immutable snapshot for the in-process executor."""

        return self._groups.get(_rate_limit_group(rate_limit_group))

    def _decide(
        self,
        candidate: BrowserAdmissionCandidate,
        groups: dict[str, BrowserGroupAdmissionState],
    ) -> BrowserAdmissionDecision:
        disposition: BrowserAdmissionDisposition
        failure: StableFailure | None = None
        if not candidate.resolution_confirmed:
            disposition = BrowserAdmissionDisposition.REJECTED
        elif candidate.readiness in {RouteReadiness.DISABLED, RouteReadiness.UNSUPPORTED}:
            disposition = BrowserAdmissionDisposition.REJECTED
        elif candidate.readiness is RouteReadiness.UNCONFIGURED:
            disposition = BrowserAdmissionDisposition.ACTION_REQUIRED
            failure = _failure(
                "acquisition-browser-route-unconfigured",
                "The selected Browser route is not configured.",
                "Configure or disable this Browser route before retrying.",
                retryable=False,
            )
        elif candidate.readiness is RouteReadiness.TEMPORARILY_UNAVAILABLE:
            disposition = BrowserAdmissionDisposition.DEFERRED
            failure = _failure(
                "acquisition-browser-route-temporarily-unavailable",
                "The selected Browser route is temporarily unavailable.",
                "Retry after the Browser route becomes available.",
                retryable=True,
            )
        elif not self._configuration.explicitly_enabled:
            disposition = BrowserAdmissionDisposition.REJECTED
        elif not self._configuration.execution_confirmed:
            disposition = BrowserAdmissionDisposition.ACTION_REQUIRED
            failure = _failure(
                "acquisition-browser-confirmation-required",
                "Browser escalation has not been confirmed for this operation.",
                "Review the redacted Browser escalation summary and explicitly confirm it.",
                retryable=False,
            )
        elif not self._configuration.runtime_ready:
            disposition = BrowserAdmissionDisposition.ACTION_REQUIRED
            failure = _failure(
                "acquisition-browser-runtime-unavailable",
                "The controlled Browser runtime is not ready.",
                "Configure the controlled Browser runtime before retrying.",
                retryable=False,
            )
        else:
            group = groups.get(candidate.rate_limit_group)
            disposition, failure = _group_decision(group)
        return BrowserAdmissionDecision(
            work_key=candidate.work_key,
            route_key=candidate.route_key,
            rate_limit_group=candidate.rate_limit_group,
            disposition=disposition,
            failure=failure,
        )

    def _summarize(
        self,
        candidates: tuple[BrowserAdmissionCandidate, ...],
        decisions: tuple[BrowserAdmissionDecision, ...],
        groups: dict[str, BrowserGroupAdmissionState],
    ) -> BrowserEscalationSummary:
        grouped: dict[str, list[BrowserAdmissionDecision]] = {}
        for decision in decisions:
            grouped.setdefault(decision.rate_limit_group, []).append(decision)
        summaries = []
        for group_key in sorted(grouped):
            group_decisions = tuple(grouped[group_key])
            state = groups.get(group_key)
            allowed_count = _count_disposition(
                group_decisions,
                BrowserAdmissionDisposition.ALLOWED,
            )
            candidate_by_work_key = {
                candidate.work_key: candidate
                for candidate in candidates
                if candidate.rate_limit_group == group_key
            }
            eligible_count = sum(
                self._eligible_for_execution(
                    candidate_by_work_key[decision.work_key],
                    state,
                )
                for decision in group_decisions
            )
            if state is None:
                readiness = "unavailable"
                interval = None
                earliest = None
                duration = None
            else:
                readiness = state.readiness.value
                interval = state.policy.minimum_start_interval
                earliest = state.earliest_start_in_seconds
                duration = (
                    earliest + max(0, eligible_count - 1) * interval if eligible_count > 0 else None
                )
            required_actions = tuple(
                sorted(
                    {
                        decision.failure.action
                        for decision in group_decisions
                        if decision.failure is not None
                    }
                )
            )
            summaries.append(
                BrowserEscalationGroupSummary(
                    rate_limit_group=group_key,
                    paper_count=len(group_decisions),
                    eligible_count=eligible_count,
                    allowed_count=allowed_count,
                    deferred_count=_count_disposition(
                        group_decisions,
                        BrowserAdmissionDisposition.DEFERRED,
                    ),
                    action_required_count=_count_disposition(
                        group_decisions,
                        BrowserAdmissionDisposition.ACTION_REQUIRED,
                    ),
                    rejected_count=_count_disposition(
                        group_decisions,
                        BrowserAdmissionDisposition.REJECTED,
                    ),
                    readiness=readiness,
                    minimum_start_interval=interval,
                    earliest_start_in_seconds=earliest,
                    conservative_minimum_duration_seconds=duration,
                    required_actions=required_actions,
                )
            )
        return BrowserEscalationSummary(groups=tuple(summaries))

    def _effective_groups(
        self,
        runtime_states: tuple[BrowserGroupRuntimeSnapshot, ...],
    ) -> dict[str, BrowserGroupAdmissionState]:
        if not isinstance(runtime_states, tuple) or any(
            not isinstance(state, BrowserGroupRuntimeSnapshot) for state in runtime_states
        ):
            raise TypeError("runtime_states must contain BrowserGroupRuntimeSnapshot values")
        keys = tuple(state.rate_limit_group for state in runtime_states)
        if len(keys) != len(set(keys)):
            raise ValueError("Browser runtime group snapshots must be unique")
        groups = dict(self._groups)
        for runtime in runtime_states:
            configured = groups.get(runtime.rate_limit_group)
            if configured is None:
                raise ValueError("Browser runtime state must match a configured group")
            if runtime.policy_revision != configured.policy.policy_revision:
                raise ValueError("Browser runtime state must match the configured policy revision")
            readiness = configured.readiness
            if readiness is BrowserGroupReadiness.READY:
                readiness = _runtime_readiness(runtime)
            groups[runtime.rate_limit_group] = BrowserGroupAdmissionState(
                policy=configured.policy,
                session_key=str(configured.session_key),
                readiness=readiness,
                earliest_start_in_seconds=max(
                    configured.earliest_start_in_seconds,
                    runtime.blocked_for_seconds,
                ),
            )
        return groups

    def _eligible_for_execution(
        self,
        candidate: BrowserAdmissionCandidate,
        state: BrowserGroupAdmissionState | None,
    ) -> bool:
        return (
            candidate.resolution_confirmed
            and candidate.readiness is RouteReadiness.READY
            and self._configuration.explicitly_enabled
            and self._configuration.runtime_ready
            and state is not None
            and state.readiness is BrowserGroupReadiness.READY
        )


def _group_decision(
    group: BrowserGroupAdmissionState | None,
) -> tuple[BrowserAdmissionDisposition, StableFailure | None]:
    if group is None:
        return (
            BrowserAdmissionDisposition.ACTION_REQUIRED,
            _failure(
                "acquisition-browser-group-unavailable",
                "The Browser risk group has no current readiness snapshot.",
                "Configure the Browser group policy and session before retrying.",
                retryable=False,
            ),
        )
    if group.readiness is BrowserGroupReadiness.READY:
        return BrowserAdmissionDisposition.ALLOWED, None
    if group.readiness is BrowserGroupReadiness.RATE_LIMITED:
        return (
            BrowserAdmissionDisposition.DEFERRED,
            _failure(
                "acquisition-browser-group-deferred",
                "The Browser risk group is currently blocked or rate limited.",
                "Retry after the group policy permits another article attempt.",
                retryable=True,
            ),
        )
    return (
        BrowserAdmissionDisposition.ACTION_REQUIRED,
        _failure(
            f"acquisition-browser-{group.readiness.value}",
            "The Browser risk group requires operator attention.",
            "Review the Browser session and provider access state before retrying.",
            retryable=False,
        ),
    )


def _runtime_readiness(
    state: BrowserGroupRuntimeSnapshot,
) -> BrowserGroupReadiness:
    if state.circuit_reason is None:
        return (
            BrowserGroupReadiness.RATE_LIMITED
            if state.is_rate_limited
            else BrowserGroupReadiness.READY
        )
    return {
        BrowserCircuitReason.LOGIN_REQUIRED: BrowserGroupReadiness.LOGIN_REQUIRED,
        BrowserCircuitReason.MFA_REQUIRED: BrowserGroupReadiness.MFA_REQUIRED,
        BrowserCircuitReason.CHALLENGE_REQUIRED: BrowserGroupReadiness.CHALLENGE_REQUIRED,
        BrowserCircuitReason.IP_BLOCKED: BrowserGroupReadiness.IP_BLOCKED,
        BrowserCircuitReason.ACCOUNT_WARNING: BrowserGroupReadiness.ACCOUNT_WARNING,
        BrowserCircuitReason.RUNTIME_FAILURE: BrowserGroupReadiness.RUNTIME_FAILED,
    }[state.circuit_reason]


def _count_disposition(
    decisions: tuple[BrowserAdmissionDecision, ...],
    disposition: BrowserAdmissionDisposition,
) -> int:
    return sum(decision.disposition is disposition for decision in decisions)


def _failure(
    code: str,
    reason: str,
    action: str,
    *,
    retryable: bool,
) -> StableFailure:
    return StableFailure(
        code=code,
        reason=reason,
        action=action,
        retryable=retryable,
    )


__all__ = (
    "BrowserAdmissionCandidate",
    "BrowserAdmissionConfiguration",
    "BrowserAdmissionController",
    "BrowserAdmissionDecision",
    "BrowserAdmissionDisposition",
    "BrowserAdmissionResult",
    "BrowserEscalationGroupSummary",
    "BrowserEscalationSummary",
    "BrowserGroupAdmissionState",
    "BrowserGroupReadiness",
)
