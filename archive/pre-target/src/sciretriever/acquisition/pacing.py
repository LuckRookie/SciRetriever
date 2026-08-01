from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
import math
import time


class DocumentStartGate:
    """Serialize new-document starts while leaving completed work outside the gate."""

    def __init__(
        self,
        interval: float = 30.0,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        if not isinstance(interval, (int, float)) or isinstance(interval, bool):
            raise TypeError("document start interval must be numeric")
        if not math.isfinite(interval) or not 30 <= interval <= 86_400:
            raise ValueError("document start interval must be finite and between 30 and 86400")
        self.interval = float(interval)
        self._monotonic = monotonic
        self._sleep = sleep
        self._lock = asyncio.Lock()
        self._last_start: float | None = None

    async def wait(self, applicable_interval: float = 0.0) -> float:
        """Admit one new document and return its monotonic start timestamp."""
        if not math.isfinite(applicable_interval) or applicable_interval < 0:
            raise ValueError("applicable interval must be nonnegative and finite")
        interval = max(self.interval, applicable_interval)
        async with self._lock:
            now = self._monotonic()
            if self._last_start is not None:
                delay = interval - (now - self._last_start)
                if delay > 0:
                    await self._sleep(delay)
                    now = self._monotonic()
            self._last_start = now
            return now


__all__ = ("DocumentStartGate",)
