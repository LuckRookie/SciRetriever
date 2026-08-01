from __future__ import annotations

import asyncio
import contextlib
import io
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition.pacing import DocumentStartGate
from sciretriever.cli.config_check import check_config
from sciretriever.cli.main import main
from sciretriever.cli.runtime_readiness import (
    CapabilityKind,
    CapabilityProbe,
    ProbeIdentity,
    RuntimeReadiness,
)
from sciretriever.config import ConfigCheckMode, load_config


class FakeTime:
    def __init__(self) -> None:
        self.value = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.value

    async def sleep(self, delay: float) -> None:
        self.sleeps.append(delay)
        self.value += delay


class RecordingProbe(CapabilityProbe):
    def __init__(
        self,
        calls: list[tuple[str, float]],
        name: str,
        result: ProbeIdentity | BaseException,
    ) -> None:
        self._calls = calls
        self._name = name
        self._result = result

    def probe(self, timeout: float) -> ProbeIdentity:
        self._calls.append((self._name, timeout))
        if isinstance(self._result, BaseException):
            raise self._result
        return self._result


class RuntimeReadinessWp6Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-runtime-readiness-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)

    def write(self, text: str, name: str = "config.toml") -> Path:
        path = self.base / name
        path.write_text(text, encoding="utf-8")
        path.chmod(0o600)
        return path

    def test_adjacent_document_starts_use_stricter_interval(self) -> None:
        # Given
        fake = FakeTime()
        gate = DocumentStartGate(30.0, monotonic=fake.monotonic, sleep=fake.sleep)

        async def run() -> tuple[float, ...]:
            starts = [await gate.wait(5.0)]
            starts.append(await gate.wait(45.0))
            starts.append(await gate.wait(5.0))
            return tuple(starts)

        # When
        starts = asyncio.run(run())

        # Then
        self.assertEqual(starts, (0.0, 45.0, 75.0))
        self.assertEqual(fake.sleeps, [45.0, 30.0])

    def test_stale_monotonic_observation_cannot_bypass_interval(self) -> None:
        # Given
        fake = FakeTime()
        fake.value = 100.0
        gate = DocumentStartGate(30.0, monotonic=fake.monotonic, sleep=fake.sleep)

        async def run() -> tuple[float, float]:
            first = await gate.wait()
            fake.value = 90.0
            second = await gate.wait()
            return first, second

        # When
        starts = asyncio.run(run())

        # Then
        self.assertEqual(starts, (100.0, 130.0))
        self.assertEqual(fake.sleeps, [40.0])

    def test_runtime_readiness_probes_only_enabled_capabilities(self) -> None:
        # Given
        config = load_config(self.write(
            """schema_version = 1
[acquisition]
providers = ["crossref"]
[analysis.mineru]
mode = "loopback"
endpoint = "http://127.0.0.1:8000"
model = "mineru-model"
[analysis.llm]
endpoint = "https://llm.example/v1"
model = "analysis-model"
credential_env = "LLM_SECRET"
timeout = 17
"""
        ))
        calls: list[tuple[str, float]] = []
        readiness = RuntimeReadiness(
            acquisition={
                "crossref": RecordingProbe(
                    calls, "acquisition:crossref",
                    ProbeIdentity("crossref", frozenset({"acquisition"})),
                ),
                "elsevier": RecordingProbe(
                    calls, "acquisition:elsevier",
                    ProbeIdentity("elsevier", frozenset({"acquisition"})),
                ),
            },
            graph={
                "openalex": RecordingProbe(
                    calls, "graph:openalex",
                    ProbeIdentity("openalex", frozenset({"graph:references"})),
                ),
            },
            mineru=RecordingProbe(calls, "mineru", ProbeIdentity("mineru:3.4.4:2")),
            llm=RecordingProbe(calls, "llm", ProbeIdentity("analysis-model")),
        )

        # When
        report = check_config(
            config,
            env={"LLM_SECRET": "DO-NOT-PRINT-SECRET"},
            mode=ConfigCheckMode.RUNTIME,
            readiness=readiness,
        )

        # Then
        self.assertEqual(report["status"], "ready")
        self.assertEqual(calls, [
            ("acquisition:crossref", 10.0),
            ("mineru", 10.0),
            ("llm", 17.0),
        ])
        self.assertNotIn("DO-NOT-PRINT-SECRET", json.dumps(report))

    def test_runtime_failure_is_bounded_redacted_and_identity_checked(self) -> None:
        # Given
        sentinel = "DO-NOT-PRINT-SECRET"
        config = load_config(self.write(
            """schema_version = 1
[acquisition]
providers = ["crossref"]
[analysis.llm]
endpoint = "https://llm.example/v1"
model = "expected-model"
credential_env = "LLM_SECRET"
timeout = 9
"""
        ))
        calls: list[tuple[str, float]] = []
        readiness = RuntimeReadiness(
            acquisition={
                "crossref": RecordingProbe(calls, "acquisition:crossref", TimeoutError(sentinel)),
            },
            llm=RecordingProbe(calls, "llm", ProbeIdentity("wrong-model", detail=sentinel)),
        )

        # When
        report = check_config(
            config,
            env={"LLM_SECRET": sentinel},
            mode=ConfigCheckMode.RUNTIME,
            readiness=readiness,
        )

        # Then
        encoded = json.dumps(report)
        self.assertEqual(report["status"], "invalid")
        self.assertEqual(calls, [("acquisition:crossref", 10.0), ("llm", 9.0)])
        self.assertNotIn(sentinel, encoded)
        self.assertIn("identity mismatch", encoded)

    def test_cli_runtime_flag_uses_runtime_composition(self) -> None:
        # Given
        config = self.write("schema_version = 1")
        output = io.StringIO()

        # When
        with contextlib.redirect_stdout(output):
            exit_code = main(["--config", str(config), "config", "check", "--runtime"])

        # Then
        report = json.loads(output.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(report["mode"], ConfigCheckMode.RUNTIME.value)

    def test_disabled_capabilities_issue_zero_runtime_probes(self) -> None:
        # Given
        config = load_config(self.write("schema_version = 1"))
        calls: list[tuple[str, float]] = []
        readiness = RuntimeReadiness(
            acquisition={
                "crossref": RecordingProbe(
                    calls, "acquisition:crossref",
                    ProbeIdentity("crossref", frozenset({"acquisition"})),
                ),
            },
            graph={
                "openalex": RecordingProbe(calls, "graph:openalex", ProbeIdentity("openalex")),
            },
            mineru=RecordingProbe(calls, "mineru", ProbeIdentity("mineru:3.4.4:2")),
            llm=RecordingProbe(calls, "llm", ProbeIdentity("unused")),
        )

        # When
        report = check_config(
            config,
            env={},
            mode=ConfigCheckMode.RUNTIME,
            readiness=readiness,
        )

        # Then
        self.assertEqual(report["status"], "ready")
        self.assertEqual(calls, [])
        names = {check["name"] for check in report["checks"]}
        self.assertFalse(any(name.startswith(CapabilityKind.GRAPH.value) for name in names))


if __name__ == "__main__":
    unittest.main()
