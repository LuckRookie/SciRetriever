from __future__ import annotations

import asyncio
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition.pacing import DocumentStartGate
from sciretriever.config import load_config
from sciretriever.errors import ConfigError


class FakeTime:
    def __init__(self) -> None:
        self.value = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.value

    async def sleep(self, delay: float) -> None:
        self.sleeps.append(delay)
        self.value += delay


class AcquisitionSafetyFloorTests(unittest.TestCase):
    def test_config_rejects_interval_below_safety_floor(self) -> None:
        # Given
        with TemporaryDirectory(prefix="sciretriever-pacing-config-") as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text(
                "schema_version = 1\ndocument_start_interval_seconds = 29.999\n",
                encoding="utf-8",
            )
            path.chmod(0o600)

            # When / Then
            with self.assertRaisesRegex(ConfigError, "between 30 and 86400"):
                load_config(path)

    def test_direct_gate_rejects_interval_below_safety_floor(self) -> None:
        # Given / When / Then
        with self.assertRaisesRegex(ValueError, "between 30 and 86400"):
            DocumentStartGate(29.999)

    def test_direct_gate_preserves_type_finite_and_upper_bounds(self) -> None:
        # Given / When / Then
        for value, error in (
            (True, TypeError),
            (float("inf"), ValueError),
            (86_400.001, ValueError),
        ):
            with self.subTest(value=value), self.assertRaises(error):
                DocumentStartGate(value)

    def test_gate_accepts_floor_and_preserves_stricter_applicable_interval(self) -> None:
        # Given
        fake = FakeTime()
        gate = DocumentStartGate(30.0, monotonic=fake.monotonic, sleep=fake.sleep)

        async def run() -> tuple[float, ...]:
            return (
                await gate.wait(),
                await gate.wait(45.0),
                await gate.wait(),
            )

        # When
        starts = asyncio.run(run())

        # Then
        self.assertEqual(starts, (0.0, 45.0, 75.0))
        self.assertEqual(fake.sleeps, [45.0, 30.0])


if __name__ == "__main__":
    unittest.main()
