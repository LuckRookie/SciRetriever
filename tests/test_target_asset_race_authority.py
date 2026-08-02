from __future__ import annotations

import unittest
from typing import Protocol

import anyio

from sciretriever.adapters.acquisition import CandidateRace


class _ReadOnlyRaceState(Protocol):
    @property
    def deadline(self) -> float: ...

    @property
    def cancelled(self) -> bool: ...


class TargetAssetRaceAuthorityTests(unittest.TestCase):
    def test_race_operation_receives_no_winner_or_cancellation_authority(self) -> None:
        exposed_methods: list[tuple[bool, bool]] = []

        async def operation(token: _ReadOnlyRaceState) -> str:
            exposed_methods.append((hasattr(token, "claim"), hasattr(token, "cancel")))
            return "winner"

        async def scenario() -> str:
            race = CandidateRace[str](deadline_seconds=1.0)
            return await race.run((("candidate", operation),), lambda _value: None)

        self.assertEqual(anyio.run(scenario), "winner")
        self.assertEqual(exposed_methods, [(False, False)])


if __name__ == "__main__":
    unittest.main()
