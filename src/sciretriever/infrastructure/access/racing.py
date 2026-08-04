from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Generic, TypeVar

import anyio
from typing_extensions import assert_never

from sciretriever.services.assets.ports import (
    CandidateRaceExhausted,
    InvalidRaceDeadline,
    RaceCallable,
)

ResultT = TypeVar("ResultT")


@dataclass(frozen=True, slots=True)
class RaceResult(Generic[ResultT]):
    identity: str
    value: ResultT


@dataclass(frozen=True, slots=True)
class RaceFailure:
    identity: str


class _RaceToken:
    def __init__(self, deadline: float) -> None:
        self.deadline = deadline
        self._winner: str | None = None
        self._cancelled = False

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    def _claim(self, identity: str) -> bool:
        if self._winner is not None or self._cancelled:
            return False
        self._winner = identity
        return True

    def _is_current(self, identity: str) -> bool:
        return self._winner == identity and not self._cancelled

    def _cancel(self) -> None:
        self._cancelled = True


class CandidateRace(Generic[ResultT]):
    def __init__(self, *, deadline_seconds: float) -> None:
        if deadline_seconds <= 0:
            raise InvalidRaceDeadline(deadline_seconds)
        self._deadline = deadline_seconds

    async def run(
        self,
        candidates: tuple[tuple[str, RaceCallable[ResultT]], ...],
        publish: Callable[[ResultT], None],
    ) -> ResultT:
        if not candidates:
            raise CandidateRaceExhausted
        send, receive = anyio.create_memory_object_stream[RaceResult[ResultT] | RaceFailure](
            len(candidates)
        )

        token = _RaceToken(anyio.current_time() + self._deadline)

        async def execute(identity: str, operation: RaceCallable[ResultT]) -> None:
            try:
                value = await operation(token)
            except (OSError, TimeoutError):
                await send.send(RaceFailure(identity))
                return
            await send.send(RaceResult(identity, value))

        try:
            with anyio.fail_after(self._deadline):
                async with anyio.create_task_group() as task_group:
                    async with send, receive:
                        for identity, operation in candidates:
                            task_group.start_soon(execute, identity, operation)
                        failures = 0
                        while failures < len(candidates):
                            outcome = await receive.receive()
                            match outcome:
                                case RaceFailure():
                                    failures += 1
                                case RaceResult(identity=identity, value=value):
                                    if token._claim(identity) and token._is_current(identity):
                                        publish(value)
                                        task_group.cancel_scope.cancel()
                                        return value
                                    failures += 1
                                case unreachable:
                                    assert_never(unreachable)
        finally:
            token._cancel()
        raise CandidateRaceExhausted


__all__ = (
    "CandidateRace",
    "RaceFailure",
    "RaceResult",
)
