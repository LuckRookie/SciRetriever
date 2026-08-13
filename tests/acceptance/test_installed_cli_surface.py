from __future__ import annotations

import json
import os
import stat
import unittest
from pathlib import Path

from tests.acceptance.helpers.installed_wheel import REPOSITORY_ROOT, InstalledWheel

EXPECTED_COMMANDS = {
    "discover": ("topic", "citations"),
    "complete": (),
    "literature": ("search", "show", "references", "cited-by"),
    "import": ("metadata", "pdf"),
    "export": ("metadata", "pdf", "content"),
    "config": ("set", "remove", "status", "test"),
}
FORBIDDEN_COMMANDS = frozenset(
    {
        "acquisition",
        "analysis",
        "artifact",
        "bibliography",
        "catalog",
        "collection",
        "download",
        "exchange",
        "metadata",
        "parsing",
        "process",
        "storage",
    }
)


def _positional_commands(help_text: str) -> set[str]:
    lines = help_text.splitlines()
    try:
        command_header = lines.index("  COMMAND")
    except ValueError:
        return set()
    commands: set[str] = set()
    for line in lines[command_header + 1 :]:
        if not line.startswith("    "):
            break
        commands.add(line.split()[0])
    return commands


class InstalledCliSurfaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = InstalledWheel()
        cls.install = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fixture.__exit__(None, None, None)

    def test_distribution_console_and_imports_come_only_from_the_fresh_venv(self) -> None:
        driver = Path(__file__).parent / "helpers" / "inspect_install.py"
        result = self.install.run_driver(driver)
        self.assertEqual(result.returncode, 0, result.stderr_text)
        self.assertEqual(result.stderr, b"")
        payload = json.loads(result.stdout)

        venv = os.fspath(self.install.venv.resolve(strict=True))
        module_file = payload["module_file"]
        self.assertTrue(module_file.startswith(venv + os.sep), module_file)
        self.assertIn(os.sep + "site-packages" + os.sep, module_file)
        self.assertEqual(payload["distribution_version"], "0.1.0")
        self.assertEqual(payload["module_version"], "0.1.0")
        self.assertEqual(
            payload["entry_points"],
            ["sciretriever.entry.cli.main:main"],
        )
        self.assertFalse(payload["user_site_enabled"])
        self.assertIsNone(payload["tests_module_origin"])
        self.assertEqual(
            payload["direct_url"],
            {
                "archive_info": {},
                "url": self.install.wheel.as_uri(),
            },
        )
        self.assertEqual(payload["archive_sha256"], self.install.wheel_sha256)

        forbidden_roots = (
            REPOSITORY_ROOT.resolve(strict=True),
            (REPOSITORY_ROOT / "src").resolve(strict=True),
            (REPOSITORY_ROOT / "tests").resolve(strict=True),
        )
        for value in payload["sys_path"]:
            if not value:
                continue
            path = Path(value)
            for forbidden in forbidden_roots:
                self.assertFalse(
                    path == forbidden or forbidden in path.parents,
                    f"repository path leaked into installed process sys.path: {path}",
                )

    def test_console_script_has_the_fresh_venv_shebang_and_executable_mode(self) -> None:
        console = self.install.console.resolve(strict=True)
        first_line = console.read_bytes().splitlines()[0]
        self.assertEqual(first_line, f"#!{self.install.python}".encode())
        self.assertTrue(console.stat().st_mode & stat.S_IXUSR)
        self.assertRegex(self.install.wheel_sha256, r"^[0-9a-f]{64}$")

    def test_test_owned_sitecustomize_can_instrument_the_real_console(self) -> None:
        with InstalledWheel() as install:
            source = Path(__file__).parent / "helpers" / "probe_sitecustomize.py"
            installed = install.install_sitecustomize(source)
            assert install.root is not None
            marker = install.root / "startup-marker"
            result = install.run_console(
                ("--help",),
                environment={"SCIRETRIEVER_TEST_STARTUP_MARKER": os.fspath(marker)},
            )

            self.assertEqual(result.returncode, 0, result.stderr_text)
            self.assertEqual(result.stderr, b"")
            self.assertEqual(marker.read_bytes(), b"loaded")
            self.assertEqual(installed.parent, install.site_packages)
            self.assertFalse(installed.is_relative_to(REPOSITORY_ROOT.resolve(strict=True)))

    def test_root_group_and_leaf_help_cover_the_closed_command_tree(self) -> None:
        root = self.install.run_console(("--help",))
        self.assertEqual(root.returncode, 0, root.stderr_text)
        self.assertEqual(root.stderr, b"")
        self.assertEqual(_positional_commands(root.stdout_text), set(EXPECTED_COMMANDS))
        self.assertTrue(_positional_commands(root.stdout_text).isdisjoint(FORBIDDEN_COMMANDS))

        for group, leaves in EXPECTED_COMMANDS.items():
            with self.subTest(path=group):
                group_help = self.install.run_console((group, "--help"))
                self.assertEqual(group_help.returncode, 0, group_help.stderr_text)
                self.assertEqual(group_help.stderr, b"")
                if leaves:
                    self.assertEqual(_positional_commands(group_help.stdout_text), set(leaves))
                else:
                    self.assertNotIn("  COMMAND", group_help.stdout_text)
            for leaf in leaves:
                with self.subTest(path=f"{group} {leaf}"):
                    leaf_help = self.install.run_console((group, leaf, "--help"))
                    self.assertEqual(leaf_help.returncode, 0, leaf_help.stderr_text)
                    self.assertEqual(leaf_help.stderr, b"")
                    self.assertIn("usage:", leaf_help.stdout_text)

    def test_unknown_and_retired_paths_are_clean_usage_failures(self) -> None:
        for arguments in (
            ("catalog",),
            ("exchange",),
            ("literature", "detail"),
            ("config", "check"),
            ("import", "asset"),
        ):
            with self.subTest(arguments=arguments):
                result = self.install.run_console(arguments)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, b"")
                self.assertIn("usage:", result.stderr_text)
                self.assertNotIn("Traceback", result.stderr_text)

    def test_production_console_scopes_fail_closed_before_creating_storage(self) -> None:
        root = self.install.root
        assert root is not None
        cases = (
            (
                "topic",
                ("discover", "topic", "controlled offline query", "--json"),
                "",
                "metadata-not-ready",
            ),
            (
                "citations",
                (
                    "discover",
                    "citations",
                    "--seed-literature-id",
                    "00000001-0000-4000-8000-000000000001",
                    "--json",
                ),
                """
[analysis]
provider = "openai"
model = "controlled-offline-model"
reference_max_output_tokens = 64
""",
                "metadata-not-ready",
            ),
            (
                "pdf",
                ("complete", "pdf", "--all-pending", "--json"),
                """
[sources.acquisition]
providers = ["wiley"]
""",
                "acquisition-not-ready",
            ),
            (
                "content",
                ("complete", "content", "--all-pending", "--json"),
                "",
                "parser-not-ready",
            ),
        )
        for name, arguments, extra_configuration, failure_code in cases:
            with self.subTest(scope=name):
                work = root / f"production-{name}-readiness"
                work.mkdir(mode=0o700)
                catalog = work / "catalog.sqlite3"
                artifacts = work / "artifacts"
                configuration = work / "config.toml"
                configuration.write_text(
                    "\n".join(
                        (
                            "[paths]",
                            f"catalog_path = {json.dumps(os.fspath(catalog))}",
                            f"artifact_root = {json.dumps(os.fspath(artifacts))}",
                            extra_configuration,
                        )
                    ),
                    encoding="utf-8",
                )
                configuration.chmod(0o600)
                result = self.install.run_console(
                    arguments,
                    environment={"SCIRETRIEVER_CONFIG": os.fspath(configuration)},
                    cwd=work,
                )
                self.assertEqual(result.returncode, 4)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(
                    result.stderr_text,
                    f"bootstrap failed ({failure_code}).\n",
                )
                self.assertNotIn("Traceback", result.stderr_text)
                self.assertFalse(catalog.exists())
                self.assertFalse(artifacts.exists())

    def test_config_test_skips_an_unready_provider_without_storage_or_network(self) -> None:
        root = self.install.root
        assert root is not None
        work = root / "config-test-unready"
        work.mkdir(mode=0o700)
        configuration = work / "config.toml"
        configuration.write_text("", encoding="utf-8")
        configuration.chmod(0o600)
        result = self.install.run_console(
            ("config", "test", "web-of-science", "--json"),
            environment={"SCIRETRIEVER_CONFIG": os.fspath(configuration)},
            cwd=work,
        )
        self.assertEqual(result.returncode, 3)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(
            json.loads(result.stdout),
            {
                "results": [
                    {
                        "provider": "web-of-science",
                        "capability": "metadata",
                        "outcome": "skipped",
                        "local_ready": False,
                        "network_reachable": None,
                        "authentication_accepted": None,
                        "api_product_usable": None,
                        "minimal_response_parseable": None,
                        "acquisition_entitlement": "not-proven",
                        "failure_code": "missing-ordinary-parameter",
                    }
                ]
            },
        )
        self.assertFalse((work / "catalog.sqlite3").exists())
        self.assertFalse((work / "artifacts").exists())

    def test_config_set_status_and_remove_use_only_the_temporary_home(self) -> None:
        environment = self.install.isolated_environment()
        home = Path(environment["HOME"]).resolve(strict=True)
        work = Path(environment["SCIRETRIEVER_ACCEPTANCE_ROOT"]) / "config-console"
        work.mkdir(mode=0o700)
        configuration = work / "config.toml"
        configuration.write_text("", encoding="utf-8")
        configuration.chmod(0o600)
        credentials = home / ".sciretriever" / "credentials.toml"
        catalog = work / "catalog.sqlite3"
        artifacts = work / "artifacts"
        secret = "installed-secret-sentinel"

        created = self.install.run_console(
            ("config", "set", "web-of-science", "--json"),
            stdin=(secret + "\n").encode(),
            environment=environment,
            cwd=work,
        )
        self.assertEqual(created.returncode, 0, created.stderr_text)
        self.assertEqual(
            json.loads(created.stdout),
            {"provider": "web-of-science", "status": "created"},
        )
        self.assertNotIn(secret.encode(), created.stdout + created.stderr)
        self.assertTrue(credentials.is_file())
        self.assertEqual(stat.S_IMODE(credentials.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(credentials.stat().st_mode), 0o600)
        self.assertIn(secret.encode(), credentials.read_bytes())
        self.assertFalse(catalog.exists())
        self.assertFalse(artifacts.exists())

        status = self.install.run_console(
            ("config", "status", "--json"),
            environment=environment,
            cwd=work,
        )
        self.assertEqual(status.returncode, 0, status.stderr_text)
        self.assertEqual(status.stderr, b"")
        self.assertNotIn(secret.encode(), status.stdout)
        self.assertNotIn(b"configuration_fingerprint", status.stdout)
        status_payload = json.loads(status.stdout)
        self.assertEqual(len(status_payload["capabilities"]), 23)
        web_of_science = next(
            item
            for item in status_payload["capabilities"]
            if item["provider"] == "web-of-science" and item["capability"] == "metadata"
        )
        self.assertEqual(web_of_science["credential"]["status"], "configured")
        self.assertEqual(
            web_of_science["credential"]["fields"],
            [{"name": "api_key", "required": True, "present": True}],
        )
        self.assertFalse(catalog.exists())
        self.assertFalse(artifacts.exists())

        removed = self.install.run_console(
            ("config", "remove", "web-of-science", "--json"),
            environment=environment,
            cwd=work,
        )
        self.assertEqual(removed.returncode, 0, removed.stderr_text)
        self.assertEqual(removed.stderr, b"")
        self.assertEqual(
            json.loads(removed.stdout),
            {"provider": "web-of-science", "status": "removed"},
        )
        self.assertNotIn(secret.encode(), credentials.read_bytes())

        missing = self.install.run_console(
            ("config", "remove", "web-of-science", "--json"),
            environment=environment,
            cwd=work,
        )
        self.assertEqual(missing.returncode, 0, missing.stderr_text)
        self.assertEqual(missing.stderr, b"")
        self.assertEqual(
            json.loads(missing.stdout),
            {"provider": "web-of-science", "status": "not-configured"},
        )
        self.assertFalse(catalog.exists())
        self.assertFalse(artifacts.exists())


if __name__ == "__main__":
    unittest.main()
