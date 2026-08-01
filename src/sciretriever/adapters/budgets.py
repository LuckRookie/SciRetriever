from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
import ipaddress
from typing import TypeVar

import anyio

from sciretriever.adapters.acquisition import RaceToken


ResultT = TypeVar("ResultT")


@dataclass(frozen=True, slots=True)
class InvalidHostBudget(Exception):
    max_per_host: int

    def __str__(self) -> str:
        return "host concurrency budget must be positive"


@dataclass(frozen=True, slots=True)
class InvalidHostname(Exception):
    def __str__(self) -> str:
        return "host must be a valid DNS name or IP address"


def canonical_hostname(host: str) -> str:
    if not isinstance(host, str) or not host:
        raise InvalidHostname
    candidate = host[:-1] if host.endswith(".") else host
    if not candidate or candidate.endswith(".") or any(not label for label in candidate.split(".")):
        raise InvalidHostname
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        try:
            canonical = candidate.encode("idna").decode("ascii").lower()
        except UnicodeError:
            raise InvalidHostname from None
        if any(not label or len(label) > 63 for label in canonical.split(".")):
            raise InvalidHostname
        return canonical


class HostBudgetManager:
    def __init__(self, max_per_host: int) -> None:
        if max_per_host < 1:
            raise InvalidHostBudget(max_per_host)
        self._max_per_host = max_per_host
        self._limiters: dict[str, anyio.CapacityLimiter] = {}

    async def run(
        self, host: str, token: RaceToken,
        operation: Callable[[RaceToken], Awaitable[ResultT]],
    ) -> ResultT:
        key = canonical_hostname(host)
        limiter = self._limiters.setdefault(
            key, anyio.CapacityLimiter(self._max_per_host),
        )
        with anyio.fail_after(max(0.0, token.deadline - anyio.current_time())):
            async with limiter:
                if token.cancelled:
                    raise TimeoutError
                return await operation(token)


__all__ = (
    "HostBudgetManager", "InvalidHostBudget", "InvalidHostname", "canonical_hostname",
)
