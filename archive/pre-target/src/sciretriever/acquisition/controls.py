"""Process-local acquisition budgets, health tracking, and circuits."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
import time
from typing import AsyncIterator, Awaitable, Callable



@dataclass(frozen=True, slots=True)
class HostBudget:
    concurrency: int = 2
    min_interval: float = 0.0

    def __post_init__(self) -> None:
        if not isinstance(self.concurrency, int) or isinstance(self.concurrency, bool) or self.concurrency <= 0:
            raise ValueError("host concurrency must be positive")
        if self.min_interval < 0:
            raise ValueError("host min_interval must be nonnegative")


class HostBudgetManager:
    def __init__(
        self,
        default: HostBudget = HostBudget(),
        overrides: dict[str, HostBudget] | None = None,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.default = default
        self.overrides = dict(overrides or {})
        self._clock = monotonic
        self._sleep = sleep
        self._semaphores: dict[str, asyncio.Semaphore] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._last_start: dict[str, float] = {}

    @asynccontextmanager
    async def acquire(self, host: str) -> AsyncIterator[None]:
        budget = self.overrides.get(host, self.default)
        semaphore = self._semaphores.setdefault(host, asyncio.Semaphore(budget.concurrency))
        interval_lock = self._locks.setdefault(host, asyncio.Lock())
        await semaphore.acquire()
        try:
            async with interval_lock:
                previous = self._last_start.get(host)
                if previous is not None:
                    delay = budget.min_interval - (self._clock() - previous)
                    if delay > 0:
                        await self._sleep(delay)
                self._last_start[host] = self._clock()
            yield
        finally:
            semaphore.release()


@dataclass(slots=True)
class _HealthState:
    success: float = 1.0
    latency: float = 0.0


class ProviderHealth:
    def __init__(self, alpha: float = 0.25) -> None:
        if not 0 < alpha <= 1:
            raise ValueError("health alpha must be in (0, 1]")
        self.alpha = alpha
        self._states: dict[str, _HealthState] = {}

    def record(self, provider: str, *, succeeded: bool, latency: float) -> None:
        if latency < 0:
            raise ValueError("latency must be nonnegative")
        state = self._states.setdefault(provider, _HealthState())
        sample = 1.0 if succeeded else 0.0
        state.success = self.alpha * sample + (1 - self.alpha) * state.success
        state.latency = latency if state.latency == 0 else self.alpha * latency + (1 - self.alpha) * state.latency

    def score(self, provider: str) -> tuple[float, float]:
        state = self._states.get(provider, _HealthState())
        return state.success, state.latency

    def order(self, providers: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(sorted(providers, key=lambda provider: (-self.score(provider)[0], self.score(provider)[1], providers.index(provider), provider)))


class CircuitState(str):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


@dataclass(slots=True)
class _Circuit:
    failures: int = 0
    state: str = CircuitState.CLOSED
    opened_at: float | None = None
    probe_active: bool = False


class CircuitBreaker:
    def __init__(self, failure_threshold: int = 3, reset_timeout: float = 60.0, *, clock: Callable[[], float] = time.monotonic) -> None:
        if failure_threshold <= 0 or reset_timeout < 0:
            raise ValueError("invalid circuit configuration")
        self.failure_threshold = failure_threshold
        self.reset_timeout = reset_timeout
        self._clock = clock
        self._circuits: dict[str, _Circuit] = {}

    def allow(self, host: str) -> bool:
        circuit = self._circuits.setdefault(host, _Circuit())
        if circuit.state == CircuitState.OPEN:
            if circuit.opened_at is None or self._clock() - circuit.opened_at < self.reset_timeout:
                return False
            circuit.state = CircuitState.HALF_OPEN
        if circuit.state == CircuitState.HALF_OPEN:
            if circuit.probe_active:
                return False
            circuit.probe_active = True
        return True

    def record_success(self, host: str) -> None:
        self._circuits[host] = _Circuit()

    def record_failure(self, host: str) -> None:
        circuit = self._circuits.setdefault(host, _Circuit())
        circuit.probe_active = False
        circuit.failures += 1
        if circuit.state == CircuitState.HALF_OPEN or circuit.failures >= self.failure_threshold:
            circuit.state = CircuitState.OPEN
            circuit.opened_at = self._clock()

    def state(self, host: str) -> str:
        return self._circuits.get(host, _Circuit()).state


__all__ = ("CircuitBreaker", "CircuitState", "HostBudget", "HostBudgetManager", "ProviderHealth")
