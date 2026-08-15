"""Provider-risk-group scheduling for bounded Browser article attempts."""

from __future__ import annotations

import re
import threading
from collections import deque
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from enum import Enum, unique
from typing import Generic, Protocol, TypeVar, cast, runtime_checkable

_ATTEMPT_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$", re.ASCII)
_GROUP_KEY = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", re.ASCII)
_POLICY_REVISION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$", re.ASCII)
_SENSITIVE_MARKERS = frozenset({"cookie", "credential", "password", "secret", "signature", "token"})
_ResultT = TypeVar("_ResultT")


@runtime_checkable
class BrowserSchedulerCancellation(Protocol):
    """The cancellation surface accepted without importing an Entry concern."""

    def is_set(self) -> bool: ...


@runtime_checkable
class BrowserSchedulerClock(Protocol):
    """Injectable monotonic clock with one cancellable deadline wait."""

    def now(self) -> float: ...

    def wait_until(
        self,
        deadline: float,
        cancel_event: BrowserSchedulerCancellation | None,
    ) -> None: ...


class BrowserSchedulingCancelled(RuntimeError):
    """A Browser queue stopped before starting another article flow."""


def _attempt_key(value: object) -> str:
    if type(value) is not str:
        raise TypeError("attempt_key must be a string")
    candidate = value.strip()
    if _ATTEMPT_KEY.fullmatch(candidate) is None:
        raise ValueError("attempt_key must be a stable operation-local identity")
    return candidate


def _group_key(value: object, *, field_name: str) -> str:
    if type(value) is not str:
        raise TypeError(f"{field_name} must be a string")
    candidate = value.strip().casefold()
    if _GROUP_KEY.fullmatch(candidate) is None or any(
        marker in candidate.split("-") for marker in _SENSITIVE_MARKERS
    ):
        raise ValueError(f"{field_name} must be a stable non-sensitive token")
    return candidate


def _finite_nonnegative(value: object, *, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{field_name} must be a number")
    candidate = float(value)
    if candidate < 0.0 or candidate == float("inf") or candidate != candidate:
        raise ValueError(f"{field_name} must be finite and nonnegative")
    return candidate


def _positive_integer_or_none(value: object, *, field_name: str) -> int | None:
    if value is None:
        return None
    if type(value) is not int:
        raise TypeError(f"{field_name} must be an integer or None")
    if value < 1:
        raise ValueError(f"{field_name} must be positive")
    return value


def _positive_integer(value: object, *, field_name: str) -> int:
    candidate = _positive_integer_or_none(value, field_name=field_name)
    if candidate is None:
        raise TypeError(f"{field_name} must be an integer")
    return candidate


def _positive_number_or_none(value: object, *, field_name: str) -> float | None:
    if value is None:
        return None
    candidate = _finite_nonnegative(value, field_name=field_name)
    if candidate == 0.0:
        raise ValueError(f"{field_name} must be positive")
    return candidate


def _positive_number(value: object, *, field_name: str) -> float:
    candidate = _positive_number_or_none(value, field_name=field_name)
    if candidate is None:
        raise TypeError(f"{field_name} must be a number")
    return candidate


def _policy_revision(value: object) -> str:
    if type(value) is not str:
        raise TypeError("policy_revision must be a string")
    candidate = value.strip()
    if _POLICY_REVISION.fullmatch(candidate) is None or any(
        marker in candidate.casefold().split("-") for marker in _SENSITIVE_MARKERS
    ):
        raise ValueError("policy_revision must be a stable non-sensitive identity")
    return candidate


@dataclass(frozen=True, slots=True)
class BrowserGroupPolicy:
    """One conservative article-start policy for a shared Browser risk group."""

    rate_limit_group: str
    policy_revision: str
    minimum_start_interval: float
    rate_limit_cooldown: float
    runtime_failure_threshold: int
    max_concurrency: int = 1
    maximum_starts_per_window: int | None = None
    window_seconds: float | None = None
    cooldown_after_completion: float = 0.0
    failure_cooldown: float = 0.0

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "rate_limit_group",
            _group_key(self.rate_limit_group, field_name="rate_limit_group"),
        )
        object.__setattr__(
            self,
            "policy_revision",
            _policy_revision(self.policy_revision),
        )
        object.__setattr__(
            self,
            "minimum_start_interval",
            _finite_nonnegative(
                self.minimum_start_interval,
                field_name="minimum_start_interval",
            ),
        )
        object.__setattr__(
            self,
            "rate_limit_cooldown",
            _positive_number(
                self.rate_limit_cooldown,
                field_name="rate_limit_cooldown",
            ),
        )
        object.__setattr__(
            self,
            "runtime_failure_threshold",
            _positive_integer(
                self.runtime_failure_threshold,
                field_name="runtime_failure_threshold",
            ),
        )
        if type(self.max_concurrency) is not int:
            raise TypeError("max_concurrency must be an integer")
        if self.max_concurrency != 1:
            raise ValueError("Browser risk-group concurrency is fixed at one")
        object.__setattr__(
            self,
            "maximum_starts_per_window",
            _positive_integer_or_none(
                self.maximum_starts_per_window,
                field_name="maximum_starts_per_window",
            ),
        )
        object.__setattr__(
            self,
            "window_seconds",
            _positive_number_or_none(
                self.window_seconds,
                field_name="window_seconds",
            ),
        )
        if (self.maximum_starts_per_window is None) != (self.window_seconds is None):
            raise ValueError("Browser start-window count and duration must be configured together")
        for field_name in ("cooldown_after_completion", "failure_cooldown"):
            object.__setattr__(
                self,
                field_name,
                _finite_nonnegative(getattr(self, field_name), field_name=field_name),
            )

    @property
    def has_pacing(self) -> bool:
        return any(
            (
                self.minimum_start_interval > 0.0,
                self.maximum_starts_per_window is not None,
                self.cooldown_after_completion > 0.0,
                self.failure_cooldown > 0.0,
            )
        )

    def tightened_by(self, operator: BrowserGroupPolicy) -> BrowserGroupPolicy:
        """Combine one operator policy without allowing any declared limit to relax."""

        if not isinstance(operator, BrowserGroupPolicy):
            raise TypeError("operator must be a BrowserGroupPolicy")
        if (
            operator.rate_limit_group != self.rate_limit_group
            or operator.policy_revision != self.policy_revision
        ):
            raise ValueError("Browser policy tightening must preserve group and revision")
        window_count, window_seconds = self._strictest_window(operator)
        return BrowserGroupPolicy(
            rate_limit_group=self.rate_limit_group,
            policy_revision=self.policy_revision,
            minimum_start_interval=max(
                self.minimum_start_interval,
                operator.minimum_start_interval,
            ),
            rate_limit_cooldown=max(
                self.rate_limit_cooldown,
                operator.rate_limit_cooldown,
            ),
            runtime_failure_threshold=min(
                self.runtime_failure_threshold,
                operator.runtime_failure_threshold,
            ),
            max_concurrency=1,
            maximum_starts_per_window=window_count,
            window_seconds=window_seconds,
            cooldown_after_completion=max(
                self.cooldown_after_completion,
                operator.cooldown_after_completion,
            ),
            failure_cooldown=max(
                self.failure_cooldown,
                operator.failure_cooldown,
            ),
        )

    def _strictest_window(
        self,
        operator: BrowserGroupPolicy,
    ) -> tuple[int | None, float | None]:
        if self.maximum_starts_per_window is None:
            return operator.maximum_starts_per_window, operator.window_seconds
        if operator.maximum_starts_per_window is None:
            return self.maximum_starts_per_window, self.window_seconds
        if (
            operator.maximum_starts_per_window > self.maximum_starts_per_window
            or operator.window_seconds is None
            or self.window_seconds is None
            or operator.window_seconds < self.window_seconds
        ):
            raise ValueError("operator Browser window cannot relax the declared policy")
        return operator.maximum_starts_per_window, operator.window_seconds


@unique
class BrowserAttemptDisposition(str, Enum):
    """The scheduler-level completion class used only for conservative cooldown."""

    COMPLETED = "completed"
    FAILED = "failed"


@unique
class BrowserGroupFeedback(str, Enum):
    """One secret-free completion signal for the provider risk group."""

    NONE = "none"
    SUCCESS = "success"
    RATE_LIMITED = "rate-limited"
    LOGIN_REQUIRED = "login-required"
    MFA_REQUIRED = "mfa-required"
    CHALLENGE_REQUIRED = "challenge-required"
    IP_BLOCKED = "ip-blocked"
    ACCOUNT_WARNING = "account-warning"
    RUNTIME_FAILURE = "runtime-failure"


@unique
class BrowserCircuitReason(str, Enum):
    """An action-required circuit reason without provider response details."""

    LOGIN_REQUIRED = "login-required"
    MFA_REQUIRED = "mfa-required"
    CHALLENGE_REQUIRED = "challenge-required"
    IP_BLOCKED = "ip-blocked"
    ACCOUNT_WARNING = "account-warning"
    RUNTIME_FAILURE = "runtime-failure"


@unique
class BrowserScheduledDisposition(str, Enum):
    """Whether a scheduled article callback ran or stopped before Browser I/O."""

    EXECUTED = "executed"
    DEFERRED = "deferred"
    ACTION_REQUIRED = "action-required"


@dataclass(frozen=True, slots=True)
class BrowserGroupRuntimeSnapshot:
    """One immutable process-local cooldown/circuit snapshot."""

    rate_limit_group: str
    policy_revision: str
    observed_at: float
    blocked_until: float
    consecutive_runtime_failures: int
    circuit_reason: BrowserCircuitReason | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "rate_limit_group",
            _group_key(self.rate_limit_group, field_name="rate_limit_group"),
        )
        object.__setattr__(self, "policy_revision", _policy_revision(self.policy_revision))
        object.__setattr__(
            self,
            "observed_at",
            _finite_nonnegative(self.observed_at, field_name="observed_at"),
        )
        object.__setattr__(
            self,
            "blocked_until",
            _finite_nonnegative(self.blocked_until, field_name="blocked_until"),
        )
        if (
            type(self.consecutive_runtime_failures) is not int
            or self.consecutive_runtime_failures < 0
        ):
            raise ValueError("consecutive_runtime_failures must be a nonnegative integer")
        if self.circuit_reason is not None and not isinstance(
            self.circuit_reason,
            BrowserCircuitReason,
        ):
            raise TypeError("circuit_reason must be BrowserCircuitReason or None")

    @property
    def blocked_for_seconds(self) -> float:
        return max(0.0, self.blocked_until - self.observed_at)

    @property
    def is_rate_limited(self) -> bool:
        return self.circuit_reason is None and self.blocked_for_seconds > 0.0

    @property
    def is_action_required(self) -> bool:
        return self.circuit_reason is not None

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("BrowserGroupRuntimeSnapshot cannot be serialized")


@dataclass(frozen=True, slots=True)
class BrowserScheduledAttemptResult(Generic[_ResultT]):
    """One ordered scheduler result, including callbacks stopped before I/O."""

    attempt_key: str
    disposition: BrowserScheduledDisposition
    value: _ResultT | None = None
    runtime_state: BrowserGroupRuntimeSnapshot | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "attempt_key", _attempt_key(self.attempt_key))
        if not isinstance(self.disposition, BrowserScheduledDisposition):
            raise TypeError("disposition must be BrowserScheduledDisposition")
        executed = self.disposition is BrowserScheduledDisposition.EXECUTED
        if executed == (self.runtime_state is not None):
            raise ValueError("only a non-executed Browser attempt carries runtime state")
        if not executed and self.value is not None:
            raise ValueError("a non-executed Browser attempt cannot carry a callback value")
        if self.runtime_state is not None and not isinstance(
            self.runtime_state,
            BrowserGroupRuntimeSnapshot,
        ):
            raise TypeError("runtime_state must be BrowserGroupRuntimeSnapshot or None")

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("BrowserScheduledAttemptResult cannot be serialized")


@dataclass(frozen=True, slots=True)
class BrowserAttemptCompletion(Generic[_ResultT]):
    """One callback value plus whether provider failure cooldown must apply."""

    value: _ResultT
    disposition: BrowserAttemptDisposition
    group_feedback: BrowserGroupFeedback = BrowserGroupFeedback.NONE

    def __post_init__(self) -> None:
        if not isinstance(self.disposition, BrowserAttemptDisposition):
            raise TypeError("disposition must be a BrowserAttemptDisposition")
        if not isinstance(self.group_feedback, BrowserGroupFeedback):
            raise TypeError("group_feedback must be a BrowserGroupFeedback")
        if self.disposition is BrowserAttemptDisposition.COMPLETED and self.group_feedback not in {
            BrowserGroupFeedback.NONE,
            BrowserGroupFeedback.SUCCESS,
        }:
            raise ValueError("a completed Browser attempt cannot report failure feedback")
        if (
            self.disposition is BrowserAttemptDisposition.FAILED
            and self.group_feedback is BrowserGroupFeedback.SUCCESS
        ):
            raise ValueError("a failed Browser attempt cannot report success feedback")

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("BrowserAttemptCompletion cannot be serialized")


@dataclass(frozen=True, slots=True)
class BrowserArticleAttempt:
    """One complete landing-to-cleanup Browser article transaction."""

    attempt_key: str
    rate_limit_group: str
    session_key: str
    policy: BrowserGroupPolicy

    def __post_init__(self) -> None:
        object.__setattr__(self, "attempt_key", _attempt_key(self.attempt_key))
        object.__setattr__(
            self,
            "rate_limit_group",
            _group_key(self.rate_limit_group, field_name="rate_limit_group"),
        )
        object.__setattr__(
            self,
            "session_key",
            _group_key(self.session_key, field_name="session_key"),
        )
        if not isinstance(self.policy, BrowserGroupPolicy):
            raise TypeError("policy must be BrowserGroupPolicy")
        if self.rate_limit_group != self.policy.rate_limit_group:
            raise ValueError("attempt and policy rate-limit groups must match")

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("BrowserArticleAttempt cannot be serialized")


@dataclass(slots=True)
class _BrowserGroupRuntimeState:
    blocked_until: float = 0.0
    consecutive_runtime_failures: int = 0
    circuit_reason: BrowserCircuitReason | None = None


class BrowserGroupScheduler:
    """Run independent groups concurrently and each group strictly serially."""

    def __init__(
        self,
        *,
        clock: BrowserSchedulerClock,
        max_concurrency: int,
    ) -> None:
        if not isinstance(clock, BrowserSchedulerClock):
            raise TypeError("clock must implement BrowserSchedulerClock")
        if isinstance(max_concurrency, bool) or not isinstance(max_concurrency, int):
            raise TypeError("max_concurrency must be an integer")
        if max_concurrency < 1:
            raise ValueError("max_concurrency must be positive")
        self._clock = clock
        self._max_concurrency = max_concurrency
        self._global_permits = threading.BoundedSemaphore(max_concurrency)
        self._state_lock = threading.Lock()
        self._group_locks: dict[str, threading.Lock] = {}
        self._policies: dict[str, BrowserGroupPolicy] = {}
        self._next_allowed_at: dict[str, float] = {}
        self._start_history: dict[str, deque[float]] = {}
        self._runtime_states: dict[str, _BrowserGroupRuntimeState] = {}

    def execute(
        self,
        attempts: tuple[BrowserArticleAttempt, ...],
        callback: Callable[[BrowserArticleAttempt], BrowserAttemptCompletion[_ResultT]],
        *,
        cancel_event: BrowserSchedulerCancellation | None = None,
    ) -> tuple[BrowserScheduledAttemptResult[_ResultT], ...]:
        """Execute a finite snapshot and return ordered pre-I/O-aware results."""

        groups = self._validate_execution(attempts, callback, cancel_event)
        if not attempts:
            return ()
        missing = object()
        results: list[object] = [missing] * len(attempts)

        def run_group(indexed: tuple[tuple[int, BrowserArticleAttempt], ...]) -> None:
            for index, attempt in indexed:
                results[index] = self._run_attempt(
                    attempt,
                    callback,
                    cancel_event=cancel_event,
                )

        with ThreadPoolExecutor(
            max_workers=min(self._max_concurrency, len(groups)),
            thread_name_prefix="sciretriever-browser-group",
        ) as executor:
            futures = tuple(executor.submit(run_group, indexed) for indexed in groups.values())
            for future in futures:
                future.result()
        if any(result is missing for result in results):
            raise RuntimeError("Browser scheduler did not complete every attempt")
        return cast(tuple[BrowserScheduledAttemptResult[_ResultT], ...], tuple(results))

    def runtime_snapshot(
        self,
        policy: BrowserGroupPolicy,
    ) -> BrowserGroupRuntimeSnapshot:
        """Return current process-local state while pinning the policy revision."""

        if not isinstance(policy, BrowserGroupPolicy):
            raise TypeError("policy must be a BrowserGroupPolicy")
        self._register_policies((policy,))
        return self._runtime_snapshot(policy, self._clock.now())

    def acknowledge_circuit(
        self,
        rate_limit_group: str,
        policy_revision: str,
    ) -> BrowserGroupRuntimeSnapshot:
        """Explicitly close one action-required circuit without clearing cooldown."""

        group = _group_key(rate_limit_group, field_name="rate_limit_group")
        revision = _policy_revision(policy_revision)
        with self._state_lock:
            policy = self._policies.get(group)
            if policy is None or policy.policy_revision != revision:
                raise ValueError("Browser circuit acknowledgement requires its active policy")
            state = self._runtime_states.setdefault(group, _BrowserGroupRuntimeState())
            if state.circuit_reason is None:
                raise ValueError("Browser risk group has no action-required circuit")
            state.circuit_reason = None
            state.consecutive_runtime_failures = 0
        return self._runtime_snapshot(policy, self._clock.now())

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("BrowserGroupScheduler cannot be serialized")

    def _validate_execution(
        self,
        attempts: tuple[BrowserArticleAttempt, ...],
        callback: Callable[[BrowserArticleAttempt], BrowserAttemptCompletion[_ResultT]],
        cancel_event: BrowserSchedulerCancellation | None,
    ) -> dict[str, tuple[tuple[int, BrowserArticleAttempt], ...]]:
        if not isinstance(attempts, tuple) or any(
            not isinstance(attempt, BrowserArticleAttempt) for attempt in attempts
        ):
            raise TypeError("attempts must contain BrowserArticleAttempt values")
        if not callable(callback):
            raise TypeError("callback must be callable")
        if cancel_event is not None and not isinstance(
            cancel_event,
            BrowserSchedulerCancellation,
        ):
            raise TypeError("cancel_event must expose is_set() or be None")
        keys = tuple(attempt.attempt_key for attempt in attempts)
        if len(keys) != len(set(keys)):
            raise ValueError("attempt keys must be unique")
        policies: dict[str, BrowserGroupPolicy] = {}
        grouped: dict[str, list[tuple[int, BrowserArticleAttempt]]] = {}
        for index, attempt in enumerate(attempts):
            prior = policies.setdefault(attempt.rate_limit_group, attempt.policy)
            if prior != attempt.policy:
                raise ValueError("one rate-limit group must use one policy snapshot")
            grouped.setdefault(attempt.rate_limit_group, []).append((index, attempt))
        self._register_policies(tuple(policies.values()))
        return {key: tuple(values) for key, values in grouped.items()}

    def _run_attempt(
        self,
        attempt: BrowserArticleAttempt,
        callback: Callable[[BrowserArticleAttempt], BrowserAttemptCompletion[_ResultT]],
        *,
        cancel_event: BrowserSchedulerCancellation | None,
    ) -> BrowserScheduledAttemptResult[_ResultT]:
        group_lock = self._group_lock(attempt.rate_limit_group)
        self._acquire(group_lock, cancel_event)
        try:
            self._check_cancel(cancel_event)
            blocked = self._runtime_block(attempt)
            if blocked is not None:
                return cast(BrowserScheduledAttemptResult[_ResultT], blocked)
            deadline = self._deadline(attempt.policy)
            if self._clock.now() < deadline:
                self._clock.wait_until(deadline, cancel_event)
            self._check_cancel(cancel_event)
            blocked = self._runtime_block(attempt)
            if blocked is not None:
                return cast(BrowserScheduledAttemptResult[_ResultT], blocked)
            self._acquire(self._global_permits, cancel_event)
            failed = True
            started = False
            completion: BrowserAttemptCompletion[_ResultT] | None = None
            try:
                self._check_cancel(cancel_event)
                blocked = self._runtime_block(attempt)
                if blocked is not None:
                    return cast(BrowserScheduledAttemptResult[_ResultT], blocked)
                started_at = self._clock.now()
                self._remember_start(attempt.policy, started_at)
                started = True
                completion = callback(attempt)
                if not isinstance(completion, BrowserAttemptCompletion):
                    raise TypeError("Browser callback must return BrowserAttemptCompletion")
                failed = completion.disposition is BrowserAttemptDisposition.FAILED
                return BrowserScheduledAttemptResult(
                    attempt_key=attempt.attempt_key,
                    disposition=BrowserScheduledDisposition.EXECUTED,
                    value=completion.value,
                )
            finally:
                try:
                    if started:
                        completed_at = self._clock.now()
                        self._remember_completion(
                            attempt.policy,
                            completed_at,
                            failed=failed,
                        )
                        self._remember_feedback(
                            attempt.policy,
                            (
                                BrowserGroupFeedback.RUNTIME_FAILURE
                                if completion is None
                                else completion.group_feedback
                            ),
                            completed_at,
                        )
                finally:
                    self._global_permits.release()
        finally:
            group_lock.release()

    def _register_policies(self, policies: tuple[BrowserGroupPolicy, ...]) -> None:
        with self._state_lock:
            for policy in policies:
                existing = self._policies.get(policy.rate_limit_group)
                if existing is not None and existing != policy:
                    raise ValueError("one scheduler risk group must retain one policy revision")
            self._policies.update({policy.rate_limit_group: policy for policy in policies})

    def _group_lock(self, group: str) -> threading.Lock:
        with self._state_lock:
            lock = self._group_locks.get(group)
            if lock is None:
                lock = threading.Lock()
                self._group_locks[group] = lock
            return lock

    def _deadline(self, policy: BrowserGroupPolicy) -> float:
        now = self._clock.now()
        with self._state_lock:
            deadline = self._next_allowed_at.get(policy.rate_limit_group, 0.0)
            count = policy.maximum_starts_per_window
            window = policy.window_seconds
            if count is None or window is None:
                return deadline
            history = self._start_history.setdefault(policy.rate_limit_group, deque())
            while history and history[0] + window <= now:
                history.popleft()
            if len(history) >= count:
                deadline = max(deadline, history[-count] + window)
            return deadline

    def _remember_start(self, policy: BrowserGroupPolicy, started_at: float) -> None:
        with self._state_lock:
            group = policy.rate_limit_group
            self._next_allowed_at[group] = max(
                self._next_allowed_at.get(group, 0.0),
                started_at + policy.minimum_start_interval,
            )
            if policy.maximum_starts_per_window is not None:
                self._start_history.setdefault(group, deque()).append(started_at)

    def _remember_completion(
        self,
        policy: BrowserGroupPolicy,
        completed_at: float,
        *,
        failed: bool,
    ) -> None:
        delay = policy.cooldown_after_completion
        if failed:
            delay = max(delay, policy.failure_cooldown)
        with self._state_lock:
            group = policy.rate_limit_group
            self._next_allowed_at[group] = max(
                self._next_allowed_at.get(group, 0.0),
                completed_at + delay,
            )

    def _remember_feedback(
        self,
        policy: BrowserGroupPolicy,
        feedback: BrowserGroupFeedback,
        completed_at: float,
    ) -> None:
        reason_by_feedback = {
            BrowserGroupFeedback.LOGIN_REQUIRED: BrowserCircuitReason.LOGIN_REQUIRED,
            BrowserGroupFeedback.MFA_REQUIRED: BrowserCircuitReason.MFA_REQUIRED,
            BrowserGroupFeedback.CHALLENGE_REQUIRED: BrowserCircuitReason.CHALLENGE_REQUIRED,
            BrowserGroupFeedback.IP_BLOCKED: BrowserCircuitReason.IP_BLOCKED,
            BrowserGroupFeedback.ACCOUNT_WARNING: BrowserCircuitReason.ACCOUNT_WARNING,
        }
        with self._state_lock:
            state = self._runtime_states.setdefault(
                policy.rate_limit_group,
                _BrowserGroupRuntimeState(),
            )
            if feedback is BrowserGroupFeedback.RUNTIME_FAILURE:
                state.consecutive_runtime_failures += 1
                if state.consecutive_runtime_failures >= policy.runtime_failure_threshold:
                    state.circuit_reason = (
                        state.circuit_reason or BrowserCircuitReason.RUNTIME_FAILURE
                    )
                return
            state.consecutive_runtime_failures = 0
            if feedback is BrowserGroupFeedback.RATE_LIMITED:
                state.blocked_until = max(
                    state.blocked_until,
                    completed_at + policy.rate_limit_cooldown,
                )
                return
            reason = reason_by_feedback.get(feedback)
            if reason is not None:
                state.circuit_reason = state.circuit_reason or reason

    def _runtime_block(
        self,
        attempt: BrowserArticleAttempt,
    ) -> BrowserScheduledAttemptResult[None] | None:
        snapshot = self._runtime_snapshot(attempt.policy, self._clock.now())
        if snapshot.is_action_required:
            return BrowserScheduledAttemptResult(
                attempt_key=attempt.attempt_key,
                disposition=BrowserScheduledDisposition.ACTION_REQUIRED,
                runtime_state=snapshot,
            )
        if snapshot.is_rate_limited:
            return BrowserScheduledAttemptResult(
                attempt_key=attempt.attempt_key,
                disposition=BrowserScheduledDisposition.DEFERRED,
                runtime_state=snapshot,
            )
        return None

    def _runtime_snapshot(
        self,
        policy: BrowserGroupPolicy,
        observed_at: float,
    ) -> BrowserGroupRuntimeSnapshot:
        with self._state_lock:
            state = self._runtime_states.setdefault(
                policy.rate_limit_group,
                _BrowserGroupRuntimeState(),
            )
            return BrowserGroupRuntimeSnapshot(
                rate_limit_group=policy.rate_limit_group,
                policy_revision=policy.policy_revision,
                observed_at=observed_at,
                blocked_until=state.blocked_until,
                consecutive_runtime_failures=state.consecutive_runtime_failures,
                circuit_reason=state.circuit_reason,
            )

    @staticmethod
    def _acquire(
        permit: threading.Lock | threading.BoundedSemaphore,
        cancel_event: BrowserSchedulerCancellation | None,
    ) -> None:
        if cancel_event is None:
            permit.acquire()
            return
        while not permit.acquire(timeout=0.05):
            BrowserGroupScheduler._check_cancel(cancel_event)
        try:
            BrowserGroupScheduler._check_cancel(cancel_event)
        except BaseException:
            permit.release()
            raise

    @staticmethod
    def _check_cancel(cancel_event: BrowserSchedulerCancellation | None) -> None:
        if cancel_event is None:
            return
        try:
            cancelled = cancel_event.is_set()
        except Exception:
            raise BrowserSchedulingCancelled("Browser scheduling was interrupted") from None
        if type(cancelled) is not bool or cancelled:
            raise BrowserSchedulingCancelled("Browser scheduling was interrupted")


__all__ = (
    "BrowserAttemptCompletion",
    "BrowserAttemptDisposition",
    "BrowserArticleAttempt",
    "BrowserCircuitReason",
    "BrowserGroupFeedback",
    "BrowserGroupPolicy",
    "BrowserGroupRuntimeSnapshot",
    "BrowserGroupScheduler",
    "BrowserScheduledAttemptResult",
    "BrowserScheduledDisposition",
    "BrowserSchedulerCancellation",
    "BrowserSchedulerClock",
    "BrowserSchedulingCancelled",
)
