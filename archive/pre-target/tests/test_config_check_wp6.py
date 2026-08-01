import contextlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.cli.main import main
from sciretriever.cli.config_check import ConfigCheckReport
from sciretriever.config import ConfigCheckMode, load_config
from sciretriever.errors import ConfigError


class ConfigCheckWp6Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-config-check-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)

    def write(self, text: str, name: str = "config.toml", mode: int = 0o600) -> Path:
        path = self.base / name
        path.write_text(text, encoding="utf-8")
        path.chmod(mode)
        return path

    def run_check(
        self,
        path: Path,
        *,
        env: dict[str, str] | None = None,
    ) -> tuple[int, ConfigCheckReport, str]:
        output = io.StringIO()
        error = io.StringIO()
        with (
            mock.patch.dict(os.environ, {} if env is None else env, clear=True),
            contextlib.redirect_stdout(output),
            contextlib.redirect_stderr(error),
        ):
            result = main(["--config", str(path), "config", "check"])
        return result, json.loads(output.getvalue()), error.getvalue()

    def run_cli_check_subprocess(self, path: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                "-m",
                "sciretriever.cli.main",
                "--config",
                str(path),
                "config",
                "check",
            ],
            cwd=REPOSITORY,
            env={"PYTHONPATH": str(SRC)},
            capture_output=True,
            text=True,
            check=False,
        )

    def test_wp6_defaults_and_explicit_values_are_strictly_parsed(self) -> None:
        default = load_config(self.write("schema_version = 1"))
        self.assertEqual(default.document_start_interval_seconds, 30.0)
        self.assertEqual(default.expansion.direction, "references")
        self.assertEqual(default.expansion.depth, 0)

        configured = load_config(self.write(
            """schema_version = 1
document_start_interval_seconds = 45
[expansion]
direction = "both"
depth = 3
""",
            "configured.toml",
        ))
        self.assertEqual(configured.document_start_interval_seconds, 45.0)
        self.assertEqual((configured.expansion.direction, configured.expansion.depth), ("both", 3))

    def test_wp6_unknown_type_conflict_and_bounds_fail_by_field(self) -> None:
        cases = {
            "unknown.toml": "[expansion]\nfuture = true",
            "direction.toml": '[expansion]\ndirection = "sideways"',
            "depth.toml": "[expansion]\ndepth = -1",
            "removed-curation.toml": '[curation]\noutput_format = "json"',
            "removed-export.toml": '[export]\noutput_format = "jsonl"',
            "interval-zero.toml": "document_start_interval_seconds = 0",
            "interval-bound.toml": "document_start_interval_seconds = 86401",
        }
        for name, body in cases.items():
            with self.subTest(name=name), self.assertRaises(ConfigError):
                load_config(self.write(f"schema_version = 1\n{body}", name))

    def test_minimal_offline_check_is_deterministic_and_network_free(self) -> None:
        config = self.write("schema_version = 1")
        calls = 0

        def blocked_connection(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            raise AssertionError("offline config check attempted network access")

        with mock.patch.object(socket, "create_connection", side_effect=blocked_connection):
            first = self.run_check(config)
            second = self.run_check(config)

        self.assertEqual(calls, 0)
        self.assertEqual(first, second)
        result, report, error = first
        self.assertEqual(result, 0)
        self.assertEqual(error, "")
        self.assertEqual(report["mode"], ConfigCheckMode.OFFLINE.value)
        self.assertEqual(report["status"], "ready")
        self.assertNotIn(str(config), json.dumps(report))

    def test_enabled_secret_references_are_required_and_redacted(self) -> None:
        sentinel = "DO-NOT-PRINT-SECRET"
        config = self.write(
            """schema_version = 1
[analysis.llm]
endpoint = "https://llm.example/v1"
model = "analysis-model"
credential_env = "LLM_SECRET"
"""
        )
        result, report, error = self.run_check(config)
        encoded = json.dumps(report)
        self.assertEqual(result, 1)
        self.assertEqual(error, "")
        self.assertNotIn(sentinel, encoded)
        self.assertIn("analysis.llm.credential_env", encoded)

        result, report, _ = self.run_check(config, env={"LLM_SECRET": sentinel})
        self.assertEqual(result, 0)
        self.assertEqual(report["status"], "ready")
        self.assertNotIn(sentinel, json.dumps(report))

    def test_disabled_capabilities_skip_secret_and_profile_checks(self) -> None:
        result, report, error = self.run_check(self.write("schema_version = 1"))
        names = {check["name"] for check in report["checks"]}
        self.assertEqual((result, error), (0, ""))
        self.assertNotIn("analysis.llm.credential_env", names)
        self.assertNotIn("analysis.mineru.auth_env", names)
        self.assertNotIn("acquisition.browser.profile_dir", names)

    def test_enabled_browser_profile_uses_existing_filesystem_validation(self) -> None:
        profile = self.base / "profile"
        profile.mkdir()
        profile.chmod(0o700)
        storage = self.base / "storage"
        storage.mkdir()
        config = self.write(
            """schema_version = 1
[paths]
storage_root = "storage"
[acquisition.browser]
enabled = true
profile_dir = "profile"
[[acquisition.browser.rules]]
name = "publisher"
landing_url_template = "https://landing.example/{doi}"
allowed_landing_hosts = []
allowed_pdf_hosts = ["pdf.example"]
allowed_network_hosts = ["landing.example", "pdf.example"]
"""
        )
        result, report, _ = self.run_check(config)
        self.assertEqual(result, 0, report)
        profile_check = next(
            check for check in report["checks"]
            if check["name"] == "acquisition.browser.profile_dir"
        )
        self.assertEqual(profile_check["status"], "ready")

        moved = self.base / "moved-profile"
        profile.rename(moved)
        profile.symlink_to(moved, target_is_directory=True)
        result, report, _ = self.run_check(config)
        self.assertEqual(result, 1)
        profile_check = next(
            check for check in report["checks"]
            if check["name"] == "acquisition.browser.profile_dir"
        )
        self.assertEqual(profile_check["status"], "invalid")

    def test_explicit_config_keeps_precedence_over_environment(self) -> None:
        explicit = self.write("schema_version = 1", "explicit.toml")
        invalid_environment = self.write("schema_version = [", "environment.toml")
        result, report, error = self.run_check(
            explicit,
            env={"SCIRETRIEVER_CONFIG": str(invalid_environment)},
        )
        self.assertEqual((result, report["status"], error), (0, "ready", ""))

    def test_symlink_config_error_redacts_runtime_path_at_cli_boundary(self) -> None:
        unique_directory = "TASK9-PRIVATE-DIRECTORY-7f31"
        unique_filename = "TASK9-PRIVATE-CONFIG-9c42.toml"
        private_directory = self.base / unique_directory
        private_directory.mkdir()
        target = self.write("schema_version = 1", "target.toml")
        selected = private_directory / unique_filename
        selected.symlink_to(target)

        completed = self.run_cli_check_subprocess(selected)

        rendered = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2)
        self.assertIn("config path must be a regular non-symlink file", rendered)
        self.assertNotIn(str(selected), rendered)
        self.assertNotIn(unique_directory, rendered)
        self.assertNotIn(unique_filename, rendered)

    def test_neighboring_config_errors_keep_category_without_runtime_tokens(self) -> None:
        sentinel = "TASK9-CONFIG-CONTENT-SENTINEL-a614"
        cases = (
            (
                self.base / "TASK9-MISSING-CONFIG-b105.toml",
                "selected config file does not exist",
            ),
            (
                self.write("schema_version = [", "TASK9-MALFORMED-CONFIG-c206.toml"),
                "config file is not valid TOML",
            ),
            (
                self.write('schema_version = "one"', "TASK9-TYPE-CONFIG-d307.toml"),
                "config field schema_version must be integer 1",
            ),
            (
                self.write(
                    f'schema_version = 1\n[credentials]\nunpaywall_email = "{sentinel}"',
                    "TASK9-PERMISSION-CONFIG-e408.toml",
                    mode=0o644,
                ),
                "config file containing credentials must have mode 0600 or stricter",
            ),
        )

        for path, reason in cases:
            with self.subTest(path=path.name):
                completed = self.run_cli_check_subprocess(path)
                rendered = completed.stdout + completed.stderr
                self.assertEqual(completed.returncode, 2)
                self.assertIn(reason, rendered)
                self.assertNotIn(str(path), rendered)
                self.assertNotIn(path.name, rendered)
                self.assertNotIn(sentinel, rendered)


if __name__ == "__main__":
    unittest.main()
