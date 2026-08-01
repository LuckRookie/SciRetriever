from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.cli.main import main


class FakeProbeResponse:
    def __init__(self, url: str, payload: bytes) -> None:
        self.url = url
        self.status_code = 200
        self.headers = {"Content-Length": str(len(payload))}
        self._payload = payload

    def __enter__(self) -> FakeProbeResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def iter_content(self, chunk_size: int) -> tuple[bytes, ...]:
        del chunk_size
        return (self._payload,)


class RuntimeProbeIdentityWp6Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-runtime-probe-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)

    def write(self, text: str) -> Path:
        path = self.base / "config.toml"
        path.write_text(text, encoding="utf-8")
        path.chmod(0o600)
        return path

    def test_http_200_with_wrong_service_identity_and_capability_is_not_ready(self) -> None:
        # Given
        sentinel = "DO-NOT-EXPOSE-PROBE-BODY"
        config = self.write(
            """schema_version = 1
[search]
providers = ["openalex"]
precedence = ["openalex"]
[acquisition]
providers = ["crossref"]
[expansion]
direction = "both"
depth = 1
"""
        )
        calls: list[tuple[str, float, bool]] = []

        def fake_get(
            url: str,
            *,
            timeout: float,
            allow_redirects: bool,
            headers: dict[str, str],
            stream: bool,
        ) -> FakeProbeResponse:
            del headers
            calls.append((url, timeout, allow_redirects or not stream))
            if "crossref" in url:
                payload = (
                    f'{{"service":"wrong-service","capabilities":["acquisition"],'
                    f'"detail":"{sentinel}"}}'
                ).encode()
            else:
                payload = (
                    f'{{"service":"openalex","capabilities":["acquisition"],'
                    f'"detail":"{sentinel}"}}'
                ).encode()
            return FakeProbeResponse(url, payload)

        # When
        output = io.StringIO()
        with (
            mock.patch("sciretriever.cli.runtime_probe_http.requests.get", side_effect=fake_get),
            contextlib.redirect_stdout(output),
        ):
            exit_code = main(["--config", str(config), "config", "check", "--runtime"])
        report = json.loads(output.getvalue())

        # Then
        runtime_checks = [
            check for check in report["checks"] if check["name"].startswith("runtime:")
        ]
        self.assertEqual(exit_code, 1)
        self.assertEqual(report["status"], "invalid")
        self.assertEqual([check["status"] for check in runtime_checks], ["invalid", "invalid"])
        self.assertIn("identity mismatch", runtime_checks[0]["reason"])
        self.assertIn("capability mismatch", runtime_checks[1]["reason"])
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(timeout == 10.0 for _, timeout, _ in calls))
        self.assertTrue(all(not unsafe_options for _, _, unsafe_options in calls))
        self.assertNotIn(sentinel, str(report))

    def test_enabled_expansion_provider_without_graph_adapter_fails_explicitly(self) -> None:
        # Given
        config = self.write(
            """schema_version = 1
[search]
providers = ["crossref"]
precedence = ["crossref"]
[expansion]
direction = "references"
depth = 1
"""
        )

        # When
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exit_code = main(["--config", str(config), "config", "check", "--runtime"])
        report = json.loads(output.getvalue())

        # Then
        graph_checks = [
            check for check in report["checks"]
            if check["name"].startswith("runtime:graph:")
        ]
        self.assertEqual(exit_code, 1)
        self.assertEqual(report["status"], "invalid")
        self.assertEqual(len(graph_checks), 1)
        self.assertEqual(graph_checks[0]["name"], "runtime:graph:crossref")
        self.assertEqual(graph_checks[0]["status"], "invalid")


if __name__ == "__main__":
    unittest.main()
