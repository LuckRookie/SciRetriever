"""Process-local access admission for the Network boundary.

The coordinator deliberately separates a provider scope permit from a host
permit.  A scope permit spans one complete logical flow (and therefore owns
the web completion cooldown), while a HostPermit covers one actual connection
target or redirect hop and only consumes host budget.  Both kinds of dynamic
state stay in memory and carry no URL, credential, document identity or
response data.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Literal

Clock = Callable[[], float]
Channel = Literal["api", "web"]


class AdmissionError(RuntimeError):
    """Base error for a caller that cannot obtain or use a permit."""


class PolicyError(ValueError):
    """Raised when a static access policy is missing or invalid."""


class PolicyRequired(AdmissionError):
    """Raised when a scope has no explicit access policy."""


class AccessCancelled(AdmissionError):
    """Raised when a queued permit wait is cancelled."""


class AdmissionTimeout(AdmissionError):
    """Raised when a queued permit wait reaches its caller deadline."""


def _identity_text(value: str, *, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    candidate = value.strip().casefold()
    if not candidate:
        raise ValueError(f"{field_name} must be nonblank")
    if any(
        character.isspace() or ord(character) < 32 or ord(character) == 127
        for character in candidate
    ):
        raise ValueError(f"{field_name} must be a stable token")
    if any(marker in candidate for marker in ("://", "/", "\\", "@", "?", "#")):
        raise ValueError(f"{field_name} must not contain a URL or locator")
    return candidate


def _finite_number(value: float, *, field_name: str, minimum: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{field_name} must be a number")
    candidate = float(value)
    if not math.isfinite(candidate) or candidate < minimum:
        raise ValueError(f"{field_name} must be finite and >= {minimum}")
    return candidate


@dataclass(frozen=True, slots=True)
class AccessScope:
    """Stable provider/channel/service identity used for shared admission."""

    provider_name: str
    channel: Channel
    service_name: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "provider_name",
            _identity_text(self.provider_name, field_name="provider_name"),
        )
        if self.channel not in ("api", "web"):
            raise ValueError("channel must be 'api' or 'web'")
        if self.service_name is not None:
            object.__setattr__(
                self,
                "service_name",
                _identity_text(self.service_name, field_name="service_name"),
            )
        if self.channel == "web" and self.service_name is not None:
            raise ValueError("web scopes must not specify service_name")


@dataclass(frozen=True, slots=True)
class AccessPolicy:
    """A normalized static policy declared by an adapter."""

    max_concurrency: int
    min_start_interval: float = 0.0
    cooldown_after_completion: float = 0.0
    burst_limit: int | None = None
    window_seconds: float | None = None
    backoff_seconds: float = 1.0
    max_backoff_seconds: float = 60.0

    def __post_init__(self) -> None:
        if isinstance(self.max_concurrency, bool) or not isinstance(self.max_concurrency, int):
            raise TypeError("max_concurrency must be an integer")
        if self.max_concurrency < 1:
            raise ValueError("max_concurrency must be positive")
        for field_name in ("min_start_interval", "cooldown_after_completion"):
            _finite_number(getattr(self, field_name), field_name=field_name)
        if self.burst_limit is None:
            if self.window_seconds is not None:
                raise ValueError("window_seconds requires burst_limit")
        else:
            if isinstance(self.burst_limit, bool) or not isinstance(self.burst_limit, int):
                raise TypeError("burst_limit must be an integer")
            if self.burst_limit < 1:
                raise ValueError("burst_limit must be positive")
            if self.window_seconds is None:
                raise ValueError("burst_limit requires window_seconds")
            _finite_number(self.window_seconds, field_name="window_seconds", minimum=0.000001)
        _finite_number(self.backoff_seconds, field_name="backoff_seconds", minimum=0.000001)
        _finite_number(self.max_backoff_seconds, field_name="max_backoff_seconds", minimum=0.000001)
        if self.max_backoff_seconds < self.backoff_seconds:
            raise ValueError("max_backoff_seconds must be >= backoff_seconds")

    @classmethod
    def strictest(cls, *policies: AccessPolicy) -> AccessPolicy:
        """Combine policies without allowing any rule to become looser."""

        if not policies:
            raise ValueError("at least one policy is required")
        if any(not isinstance(policy, cls) for policy in policies):
            raise TypeError("policies must be AccessPolicy instances")
        burst_limits = [policy.burst_limit for policy in policies if policy.burst_limit is not None]
        windows = [
            policy.window_seconds
            for policy in policies
            if policy.burst_limit is not None and policy.window_seconds is not None
        ]
        return cls(
            max_concurrency=min(policy.max_concurrency for policy in policies),
            min_start_interval=max(policy.min_start_interval for policy in policies),
            cooldown_after_completion=max(policy.cooldown_after_completion for policy in policies),
            burst_limit=min(burst_limits) if burst_limits else None,
            window_seconds=max(windows) if windows else None,
            backoff_seconds=max(policy.backoff_seconds for policy in policies),
            max_backoff_seconds=max(policy.max_backoff_seconds for policy in policies),
        )


@dataclass(frozen=True, slots=True, init=False)
class AccessFeedback:
    """Adapter-normalized runtime feedback with no provider payload."""

    retry_after: float | None
    blocked_until: float | None
    quota_reset_at: float | None
    throttled: bool

    def __init__(
        self,
        retry_after: float | None = None,
        blocked_until: float | None = None,
        quota_reset_at: float | None = None,
        throttled: bool = False,
    ) -> None:
        retry_value = (
            _finite_number(retry_after, field_name="retry_after")
            if retry_after is not None
            else None
        )
        if blocked_until is not None:
            _finite_number(blocked_until, field_name="blocked_until")
        if quota_reset_at is not None:
            _finite_number(quota_reset_at, field_name="quota_reset_at")
        if not isinstance(throttled, bool):
            raise TypeError("throttled must be a boolean")
        object.__setattr__(self, "retry_after", retry_value)
        object.__setattr__(self, "blocked_until", blocked_until)
        object.__setattr__(self, "quota_reset_at", quota_reset_at)
        object.__setattr__(self, "throttled", throttled)


@dataclass(slots=True)
class _ResourceState:
    policy: AccessPolicy
    active: int = 0
    next_allowed_at: float = 0.0
    blocked_until: float = 0.0
    window_started_at: float | None = None
    window_count: int = 0
    backoff_level: int = 0


@dataclass(slots=True)
class _ScopeTicket:
    sequence: int
    scope: AccessScope
    policy: AccessPolicy
    cancel_event: threading.Event | None
    deadline: float | None
    wall_deadline: float | None


@dataclass(slots=True)
class _HostTicket:
    sequence: int
    owner: AccessPermit
    host: str
    policy: AccessPolicy
    cancel_event: threading.Event | None
    deadline: float | None
    wall_deadline: float | None


class HostPermit:
    """A host-only lease owned by a complete scope permit."""

    __slots__ = ("_coordinator", "_permit_id", "_owner", "_host", "_released")

    def __init__(
        self,
        coordinator: AccessCoordinator,
        permit_id: int,
        owner: AccessPermit,
        host: str,
    ) -> None:
        self._coordinator = coordinator
        self._permit_id = permit_id
        self._owner = owner
        self._host = host
        self._released = False

    @property
    def scope(self) -> AccessScope:
        return self._owner.scope

    @property
    def host(self) -> str:
        return self._host

    @property
    def released(self) -> bool:
        return self._released

    def release(self) -> None:
        if self._released:
            return
        self._coordinator._release_host(self)
        self._released = True

    cancel = release

    def __enter__(self) -> HostPermit:
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        self.release()
        return False

    def __repr__(self) -> str:
        state = "released" if self._released else "active"
        return f"<HostPermit {state}>"


class AccessPermit:
    """A complete provider scope permit that owns zero or more HostPermits."""

    __slots__ = (
        "_coordinator",
        "_permit_id",
        "_scope",
        "_released",
        "_host_permits",
    )

    def __init__(self, coordinator: AccessCoordinator, permit_id: int, scope: AccessScope) -> None:
        self._coordinator = coordinator
        self._permit_id = permit_id
        self._scope = scope
        self._released = False
        self._host_permits: set[HostPermit] = set()

    @property
    def scope(self) -> AccessScope:
        return self._scope

    @property
    def released(self) -> bool:
        return self._released

    def acquire_host(
        self,
        host: str,
        *,
        cancel_event: threading.Event | None = None,
        timeout: float | None = None,
    ) -> HostPermit:
        if self._released:
            raise AdmissionError("scope permit has been released")
        return self._coordinator._acquire_host(
            self,
            host,
            cancel_event=cancel_event,
            timeout=timeout,
        )

    def release(self, feedback: AccessFeedback | None = None) -> None:
        with self._coordinator._condition:
            if self._released:
                return
            # Mark the owner dead before removing and waking host waiters. A
            # waiter that wins the condition race must never observe a live
            # owner with a ticket already removed from the queue.
            self._released = True
            try:
                if feedback is not None:
                    self._coordinator.record_feedback(self, feedback)
            finally:
                try:
                    for host_permit in tuple(self._host_permits):
                        host_permit.release()
                finally:
                    self._coordinator._release_scope(self)

    cancel = release

    def __enter__(self) -> AccessPermit:
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        self.release()
        return False

    def __repr__(self) -> str:
        state = "released" if self._released else "active"
        return f"<AccessPermit {state}>"


class AccessCoordinator:
    """Fair, process-local coordinator for scope and host permits."""

    def __init__(
        self,
        *,
        clock: Clock | None = None,
        minimum_policy: AccessPolicy | None = None,
    ) -> None:
        if clock is not None and not callable(clock):
            raise TypeError("clock must be callable")
        if minimum_policy is not None and not isinstance(minimum_policy, AccessPolicy):
            raise TypeError("minimum_policy must be an AccessPolicy")
        self._clock: Clock = clock or time.monotonic
        self._minimum_policy = minimum_policy
        self._condition = threading.Condition(threading.RLock())
        self._policies: dict[AccessScope, AccessPolicy] = {}
        self._scope_states: dict[AccessScope, _ResourceState] = {}
        self._host_states: dict[str, _ResourceState] = {}
        self._scope_waiters: deque[_ScopeTicket] = deque()
        self._host_waiters: deque[_HostTicket] = deque()
        self._next_sequence = 0
        self._next_scope_permit_id = 0
        self._next_host_permit_id = 0
        self._active_scope_permits: dict[int, AccessPermit] = {}
        self._active_host_permits: dict[int, HostPermit] = {}

    def __repr__(self) -> str:
        with self._condition:
            return (
                "<AccessCoordinator "
                f"scopes={len(self._policies)} hosts={len(self._host_states)} "
                f"waiters={len(self._scope_waiters) + len(self._host_waiters)}>"
            )

    def register(
        self,
        scope: AccessScope,
        policy: AccessPolicy,
        *,
        operator_policy: AccessPolicy | None = None,
    ) -> AccessPolicy:
        """Register a scope and return its strictest effective policy."""

        scope = self._require_scope(scope)
        if not isinstance(policy, AccessPolicy):
            raise TypeError("policy must be an AccessPolicy")
        if operator_policy is not None and not isinstance(operator_policy, AccessPolicy):
            raise TypeError("operator_policy must be an AccessPolicy")
        policies = [policy]
        if self._minimum_policy is not None:
            policies.append(self._minimum_policy)
        if operator_policy is not None:
            policies.append(operator_policy)
        if scope.channel == "web":
            policies.append(AccessPolicy(max_concurrency=1, cooldown_after_completion=30.0))
        effective = AccessPolicy.strictest(*policies)
        with self._condition:
            existing = self._policies.get(scope)
            if existing is not None:
                effective = AccessPolicy.strictest(existing, effective)
            self._policies[scope] = effective
            state = self._scope_states.get(scope)
            if state is None:
                self._scope_states[scope] = _ResourceState(effective)
            else:
                state.policy = effective
            self._condition.notify_all()
        return effective

    def policy_for(self, scope: AccessScope) -> AccessPolicy:
        scope = self._require_scope(scope)
        with self._condition:
            try:
                return self._policies[scope]
            except KeyError as error:
                raise PolicyRequired("scope has no explicit AccessPolicy") from error

    def acquire_scope(
        self,
        scope: AccessScope,
        policy: AccessPolicy | None = None,
        *,
        operator_policy: AccessPolicy | None = None,
        cancel_event: threading.Event | None = None,
        timeout: float | None = None,
    ) -> AccessPermit:
        """Acquire one complete provider/channel/service scope permit."""

        scope = self._require_scope(scope)
        if policy is not None:
            effective = self.register(scope, policy, operator_policy=operator_policy)
        else:
            if operator_policy is not None:
                raise PolicyRequired("operator_policy requires an explicit AccessPolicy")
            effective = self.policy_for(scope)
        _validate_wait_inputs(cancel_event, timeout)
        with self._condition:
            ticket = self._scope_ticket(scope, effective, cancel_event, timeout)
            self._scope_waiters.append(ticket)
            while True:
                self._remove_cancelled_scope_waiters()
                now = self._clock()
                self._check_ticket(ticket, self._scope_waiters, now)
                if self._select_scope_ticket(now) is ticket:
                    _remove_ticket(ticket, self._scope_waiters)
                    self._start_scope(scope, now)
                    permit_id = self._next_scope_permit_id
                    self._next_scope_permit_id += 1
                    permit = AccessPermit(self, permit_id, scope)
                    self._active_scope_permits[permit_id] = permit
                    return permit
                self._condition.wait(self._scope_wait_duration(ticket, now))

    def record_feedback(
        self,
        source: AccessPermit | AccessScope,
        feedback: AccessFeedback,
    ) -> None:
        """Apply adapter-normalized feedback to provider scope state only."""

        if not isinstance(feedback, AccessFeedback):
            raise TypeError("feedback must be an AccessFeedback")
        if isinstance(source, AccessPermit):
            scope = source.scope
        elif isinstance(source, AccessScope):
            scope = source
        else:
            raise TypeError("feedback source must be an AccessPermit or AccessScope")
        with self._condition:
            state = self._scope_states.get(scope)
            if state is None or scope not in self._policies:
                raise PolicyRequired("scope has no explicit AccessPolicy")
            self._apply_feedback(state, feedback, self._clock())
            self._condition.notify_all()

    def wake(self) -> None:
        """Wake waiting callers after a fake clock or cancellation changes."""

        with self._condition:
            self._condition.notify_all()

    def _acquire_host(
        self,
        owner: AccessPermit,
        host: str,
        *,
        cancel_event: threading.Event | None,
        timeout: float | None,
    ) -> HostPermit:
        if owner.released:
            raise AdmissionError("scope permit has been released")
        normalized_host = _normalize_host(host)
        _validate_wait_inputs(cancel_event, timeout)
        policy = self.policy_for(owner.scope)
        with self._condition:
            if owner.released:
                raise AdmissionError("scope permit has been released")
            ticket = self._host_ticket(owner, normalized_host, policy, cancel_event, timeout)
            self._host_waiters.append(ticket)
            while True:
                self._remove_cancelled_host_waiters()
                now = self._clock()
                if owner.released:
                    _remove_ticket(ticket, self._host_waiters)
                    raise AdmissionError("scope permit was released while waiting for host")
                self._check_ticket(ticket, self._host_waiters, now)
                if self._select_host_ticket(now) is ticket:
                    _remove_ticket(ticket, self._host_waiters)
                    self._start_host(normalized_host, policy, now)
                    permit_id = self._next_host_permit_id
                    self._next_host_permit_id += 1
                    permit = HostPermit(self, permit_id, owner, normalized_host)
                    self._active_host_permits[permit_id] = permit
                    owner._host_permits.add(permit)
                    return permit
                self._condition.wait(self._host_wait_duration(ticket, now))

    def _release_scope(self, permit: AccessPermit) -> None:
        with self._condition:
            self._remove_owner_host_waiters(permit)
            active = self._active_scope_permits.pop(permit._permit_id, None)
            if active is None:
                return
            state = self._scope_states[permit.scope]
            state.active -= 1
            now = self._clock()
            state.next_allowed_at = max(
                state.next_allowed_at,
                now + state.policy.cooldown_after_completion,
            )
            self._condition.notify_all()

    def _remove_owner_host_waiters(self, owner: AccessPermit) -> None:
        for ticket in tuple(self._host_waiters):
            if ticket.owner is owner:
                self._host_waiters.remove(ticket)

    def _release_host(self, permit: HostPermit) -> None:
        with self._condition:
            active = self._active_host_permits.pop(permit._permit_id, None)
            if active is None:
                permit._owner._host_permits.discard(permit)
                return
            state = self._host_states[permit.host]
            state.active -= 1
            permit._owner._host_permits.discard(permit)
            self._condition.notify_all()

    def _start_scope(self, scope: AccessScope, now: float) -> None:
        state = self._scope_states[scope]
        self._refresh_window(state, now)
        state.active += 1
        self._consume_window(state, now)
        state.next_allowed_at = max(
            state.next_allowed_at,
            now + state.policy.min_start_interval,
        )

    def _start_host(self, host: str, policy: AccessPolicy, now: float) -> None:
        state = self._host_state(host, policy)
        self._refresh_window(state, now)
        state.active += 1
        self._consume_window(state, now)
        state.next_allowed_at = max(
            state.next_allowed_at,
            now + state.policy.min_start_interval,
        )

    def _select_scope_ticket(self, now: float) -> _ScopeTicket | None:
        for index, ticket in enumerate(self._scope_waiters):
            if any(
                previous.scope == ticket.scope for previous in list(self._scope_waiters)[:index]
            ):
                continue
            state = self._scope_states[ticket.scope]
            self._refresh_window(state, now)
            if self._resource_available(state, now):
                return ticket
        return None

    def _select_host_ticket(self, now: float) -> _HostTicket | None:
        for index, ticket in enumerate(self._host_waiters):
            if any(previous.host == ticket.host for previous in list(self._host_waiters)[:index]):
                continue
            state = self._host_state(ticket.host, ticket.policy)
            self._refresh_window(state, now)
            if self._resource_available(state, now):
                return ticket
        return None

    @staticmethod
    def _resource_available(state: _ResourceState, now: float) -> bool:
        if state.active >= state.policy.max_concurrency:
            return False
        if now < state.next_allowed_at or now < state.blocked_until:
            return False
        return state.policy.burst_limit is None or state.window_count < state.policy.burst_limit

    def _scope_wait_duration(self, ticket: _ScopeTicket, now: float) -> float:
        return self._wait_duration(
            self._scope_states[ticket.scope], now, ticket.deadline, ticket.wall_deadline
        )

    def _host_wait_duration(self, ticket: _HostTicket, now: float) -> float:
        return self._wait_duration(
            self._host_state(ticket.host, ticket.policy),
            now,
            ticket.deadline,
            ticket.wall_deadline,
        )

    def _wait_duration(
        self,
        state: _ResourceState,
        now: float,
        deadline: float | None,
        wall_deadline: float | None,
    ) -> float:
        wait_for = 0.05
        future_times = [state.next_allowed_at, state.blocked_until]
        if state.policy.burst_limit is not None and state.window_started_at is not None:
            future_times.append(state.window_started_at + state.policy.window_seconds)  # type: ignore[operator]
        future = max(future_times)
        if future > now:
            wait_for = min(wait_for, future - now)
        if deadline is not None:
            wait_for = min(wait_for, max(deadline - now, 0.001))
        if wall_deadline is not None:
            wait_for = min(wait_for, max(wall_deadline - time.monotonic(), 0.001))
        return max(wait_for, 0.001)

    def _host_state(self, host: str, policy: AccessPolicy) -> _ResourceState:
        state = self._host_states.get(host)
        if state is None:
            state = _ResourceState(policy)
            self._host_states[host] = state
        else:
            state.policy = AccessPolicy.strictest(state.policy, policy)
        return state

    @staticmethod
    def _refresh_window(state: _ResourceState, now: float) -> None:
        if state.policy.burst_limit is None or state.policy.window_seconds is None:
            return
        if state.window_started_at is None:
            state.window_started_at = now
        elif now >= state.window_started_at + state.policy.window_seconds:
            state.window_started_at = now
            state.window_count = 0

    @staticmethod
    def _consume_window(state: _ResourceState, now: float) -> None:
        if state.policy.burst_limit is not None:
            if state.window_started_at is None:
                state.window_started_at = now
            state.window_count += 1

    @staticmethod
    def _apply_feedback(state: _ResourceState, feedback: AccessFeedback, now: float) -> None:
        candidates = [state.blocked_until]
        if feedback.retry_after is not None:
            candidates.append(now + feedback.retry_after)
        if feedback.blocked_until is not None:
            candidates.append(feedback.blocked_until)
        if feedback.quota_reset_at is not None:
            candidates.append(feedback.quota_reset_at)
            if state.policy.window_seconds is not None:
                state.window_started_at = feedback.quota_reset_at - state.policy.window_seconds
        if feedback.throttled and feedback.retry_after is None and feedback.blocked_until is None:
            delay = min(
                state.policy.max_backoff_seconds,
                state.policy.backoff_seconds * (2**state.backoff_level),
            )
            candidates.append(now + delay)
            state.backoff_level = min(state.backoff_level + 1, 30)
        elif not feedback.throttled:
            state.backoff_level = 0
        state.blocked_until = max(candidates)

    def _scope_ticket(
        self,
        scope: AccessScope,
        policy: AccessPolicy,
        cancel_event: threading.Event | None,
        timeout: float | None,
    ) -> _ScopeTicket:
        now = self._clock()
        return _ScopeTicket(
            sequence=self._next_sequence_value(),
            scope=scope,
            policy=policy,
            cancel_event=cancel_event,
            deadline=now + timeout if timeout is not None else None,
            wall_deadline=time.monotonic() + timeout if timeout is not None else None,
        )

    def _host_ticket(
        self,
        owner: AccessPermit,
        host: str,
        policy: AccessPolicy,
        cancel_event: threading.Event | None,
        timeout: float | None,
    ) -> _HostTicket:
        now = self._clock()
        return _HostTicket(
            sequence=self._next_sequence_value(),
            owner=owner,
            host=host,
            policy=policy,
            cancel_event=cancel_event,
            deadline=now + timeout if timeout is not None else None,
            wall_deadline=time.monotonic() + timeout if timeout is not None else None,
        )

    def _next_sequence_value(self) -> int:
        value = self._next_sequence
        self._next_sequence += 1
        return value

    @staticmethod
    def _check_ticket(
        ticket: _ScopeTicket | _HostTicket,
        waiters: Any,
        now: float,
    ) -> None:
        if _event_is_set(ticket.cancel_event):
            _remove_ticket(ticket, waiters)
            raise AccessCancelled("permit wait was cancelled")
        if ticket.deadline is not None and (
            now >= ticket.deadline
            or (ticket.wall_deadline is not None and time.monotonic() >= ticket.wall_deadline)
        ):
            _remove_ticket(ticket, waiters)
            raise AdmissionTimeout("permit wait timed out")

    def _remove_cancelled_scope_waiters(self) -> None:
        for ticket in tuple(self._scope_waiters):
            if _event_is_set(ticket.cancel_event):
                self._scope_waiters.remove(ticket)

    def _remove_cancelled_host_waiters(self) -> None:
        for ticket in tuple(self._host_waiters):
            if _event_is_set(ticket.cancel_event):
                self._host_waiters.remove(ticket)

    @staticmethod
    def _require_scope(scope: AccessScope) -> AccessScope:
        if not isinstance(scope, AccessScope):
            raise TypeError("scope must be an AccessScope")
        return scope


def _validate_wait_inputs(
    cancel_event: threading.Event | None,
    timeout: float | None,
) -> None:
    if cancel_event is not None and not hasattr(cancel_event, "is_set"):
        raise TypeError("cancel_event must expose is_set()")
    if timeout is not None:
        _finite_number(timeout, field_name="timeout")


def _event_is_set(event: threading.Event | None) -> bool:
    return event is not None and event.is_set()


def _normalize_host(host: str) -> str:
    if not isinstance(host, str):
        raise TypeError("host must be a string")
    candidate = host.strip().casefold().rstrip(".")
    if not candidate:
        raise ValueError("host must be nonblank")
    if any(
        character.isspace() or ord(character) < 32 or ord(character) == 127
        for character in candidate
    ):
        raise ValueError("host must be a normalized host token")
    if any(marker in candidate for marker in ("://", "/", "\\", "@", "?", "#")):
        raise ValueError("host must not contain a URL or locator")
    return candidate


def _remove_ticket(
    ticket: Any,
    waiters: Any,
) -> None:
    try:
        waiters.remove(ticket)
    except ValueError:
        pass


__all__ = (
    "AccessCancelled",
    "AccessCoordinator",
    "AccessFeedback",
    "AccessPermit",
    "AccessPolicy",
    "AccessScope",
    "AdmissionError",
    "AdmissionTimeout",
    "HostPermit",
    "PolicyError",
    "PolicyRequired",
)
