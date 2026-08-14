"""Provider-risk-group scheduling for bounded Browser article attempts."""

from __future__ import annotations

import re
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Protocol, TypeVar, cast, runtime_checkable

_ATTEMPT_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$", re.ASCII)
_GROUP_KEY = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", re.ASCII)
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


@dataclass(frozen=True, slots=True)
class BrowserGroupPolicy:
    """One conservative article-start policy for a shared Browser risk group."""

    rate_limit_group: str
    minimum_start_interval: float

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "rate_limit_group",
            _group_key(self.rate_limit_group, field_name="rate_limit_group"),
        )
        object.__setattr__(
            self,
            "minimum_start_interval",
            _finite_nonnegative(
                self.minimum_start_interval,
                field_name="minimum_start_interval",
            ),
        )


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
        self._next_allowed_at: dict[str, float] = {}

    def execute(
        self,
        attempts: tuple[BrowserArticleAttempt, ...],
        callback: Callable[[BrowserArticleAttempt], _ResultT],
        *,
        cancel_event: BrowserSchedulerCancellation | None = None,
    ) -> tuple[_ResultT, ...]:
        """Execute a finite snapshot and return results in its original order."""

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
        return cast(tuple[_ResultT, ...], tuple(results))

    def _validate_execution(
        self,
        attempts: tuple[BrowserArticleAttempt, ...],
        callback: Callable[[BrowserArticleAttempt], _ResultT],
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
        return {key: tuple(values) for key, values in grouped.items()}

    def _run_attempt(
        self,
        attempt: BrowserArticleAttempt,
        callback: Callable[[BrowserArticleAttempt], _ResultT],
        *,
        cancel_event: BrowserSchedulerCancellation | None,
    ) -> _ResultT:
        group_lock = self._group_lock(attempt.rate_limit_group)
        self._acquire(group_lock, cancel_event)
        try:
            self._check_cancel(cancel_event)
            deadline = self._deadline(attempt.rate_limit_group)
            if self._clock.now() < deadline:
                self._clock.wait_until(deadline, cancel_event)
            self._check_cancel(cancel_event)
            started_at = self._clock.now()
            self._remember_next_start(
                attempt.rate_limit_group,
                started_at + attempt.policy.minimum_start_interval,
            )
            self._acquire(self._global_permits, cancel_event)
            try:
                self._check_cancel(cancel_event)
                return callback(attempt)
            finally:
                self._global_permits.release()
        finally:
            group_lock.release()

    def _group_lock(self, group: str) -> threading.Lock:
        with self._state_lock:
            lock = self._group_locks.get(group)
            if lock is None:
                lock = threading.Lock()
                self._group_locks[group] = lock
            return lock

    def _deadline(self, group: str) -> float:
        with self._state_lock:
            return self._next_allowed_at.get(group, 0.0)

    def _remember_next_start(self, group: str, deadline: float) -> None:
        with self._state_lock:
            self._next_allowed_at[group] = max(
                self._next_allowed_at.get(group, 0.0),
                deadline,
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
    "BrowserArticleAttempt",
    "BrowserGroupPolicy",
    "BrowserGroupScheduler",
    "BrowserSchedulerCancellation",
    "BrowserSchedulerClock",
    "BrowserSchedulingCancelled",
)
