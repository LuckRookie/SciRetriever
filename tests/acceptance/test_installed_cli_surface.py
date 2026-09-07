from __future__ import annotations

import json
import os
import stat
import threading
import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from tests.acceptance.helpers.installed_wheel import REPOSITORY_ROOT, InstalledWheel

EXPECTED_COMMANDS = {
    "discover": ("topic", "citations"),
    "complete": (),
    "literature": ("search", "show", "references", "cited-by"),
    "import": ("metadata", "pdf"),
    "export": ("metadata", "pdf", "content"),
    "config": ("status", "test"),
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


class _ModelCatalogHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/v1/models":
            self.send_error(404)
            return
        payload = json.dumps(
            {
                "object": "list",
                "data": [
                    {"id": "acceptance-analysis"},
                    {"id": "acceptance-browser"},
                ],
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: object) -> None:
        del format, args


@contextmanager
def _model_catalog_server() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _ModelCatalogHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5.0)


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
            ("config", "set"),
            ("config", "remove"),
            ("config", "--json"),
            ("import", "asset"),
        ):
            with self.subTest(arguments=arguments):
                result = self.install.run_console(arguments)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, b"")
                self.assertIn("usage:", result.stderr_text)
                self.assertNotIn("Traceback", result.stderr_text)

    def test_production_console_scopes_apply_readiness_before_creating_storage(self) -> None:
        root = self.install.root
        assert root is not None
        cases = (
            (
                "topic",
                ("discover", "topic", "controlled offline query", "--json"),
                """
[sources.metadata]
mode = "custom"
providers = []
""",
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
[sources.metadata]
mode = "custom"
providers = []

[providers.openai]
api = "openai-responses"
base_url = "https://api.openai.com/v1"
[models."openai/controlled-offline-model"]
reasoning = "default"
image = false
[analyze]
model = "openai/controlled-offline-model"
reference_max_output_tokens = 64
""",
                "metadata-not-ready",
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
                self.install.write_user_configuration(
                    "\n".join(
                        (
                            "[paths]",
                            f"catalog_path = {json.dumps(os.fspath(catalog))}",
                            f"artifact_root = {json.dumps(os.fspath(artifacts))}",
                            extra_configuration,
                        )
                    ),
                )
                result = self.install.run_console(
                    arguments,
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

        # Acquisition readiness is route-scoped.  An unconfigured Wiley route
        # must not globally block an empty frozen target cohort.  Unlike the
        # bootstrap-only readiness failures above, Acquisition may open the
        # catalog first because target selection defines route applicability.
        work = root / "production-pdf-readiness"
        work.mkdir(mode=0o700)
        catalog = work / "catalog.sqlite3"
        artifacts = work / "artifacts"
        self.install.write_user_configuration(
            "\n".join(
                (
                    "[paths]",
                    f"catalog_path = {json.dumps(os.fspath(catalog))}",
                    f"artifact_root = {json.dumps(os.fspath(artifacts))}",
                    "[sources.acquisition]",
                    'mode = "custom"',
                    'providers = ["wiley"]',
                )
            ),
        )
        result = self.install.run_console(
            ("complete", "pdf", "--all-pending", "--json"),
            cwd=work,
        )
        self.assertEqual(result.returncode, 0, result.stderr_text)
        self.assertNotIn("bootstrap failed", result.stderr_text)
        self.assertNotIn("Traceback", result.stderr_text)
        self.assertIsInstance(json.loads(result.stdout), dict)
        self.assertTrue(catalog.is_file())

    def test_config_test_skips_an_unready_provider_without_storage_or_network(self) -> None:
        root = self.install.root
        assert root is not None
        work = root / "config-test-unready"
        work.mkdir(mode=0o700)
        self.install.write_user_configuration("")
        result = self.install.run_console(
            ("config", "test", "search", "web-of-science", "--json"),
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
                        "diagnosis": {
                            "request": "Not sent",
                            "reason": (
                                "The request was not sent because local configuration "
                                "is incomplete."
                            ),
                            "action": "Complete this area's required settings and retry.",
                        },
                    }
                ]
            },
        )
        self.assertFalse((work / "catalog.sqlite3").exists())
        self.assertFalse((work / "artifacts").exists())

    def test_config_manager_creates_the_fixed_user_configuration_on_first_edit(self) -> None:
        root = self.install.root
        assert root is not None
        fresh_home = root / "fresh-config-home"
        fresh_home.mkdir(mode=0o700)
        work = root / "fresh-config-work"
        work.mkdir(mode=0o700)
        configuration = fresh_home / ".sciretriever" / "config.toml"
        self.assertFalse(configuration.exists())

        result = self.install.run_console(
            ("config",),
            stdin=b"s\n2\n600\ny\n3\nq\n",
            environment={"HOME": os.fspath(fresh_home)},
            cwd=work,
        )

        self.assertEqual(result.returncode, 0, result.stderr_text)
        self.assertEqual(result.stdout, b"")
        self.assertTrue(configuration.is_file())
        self.assertEqual(stat.S_IMODE(configuration.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(configuration.stat().st_mode), 0o600)
        self.assertIn("limit = 600", configuration.read_text(encoding="utf-8"))
        self.assertIn(b"Search Limit was saved.", result.stderr)

    def test_installed_config_manager_rejects_obsolete_config_without_writing(self) -> None:
        root = self.install.root
        assert root is not None
        fresh_home = root / "incompatible-config-home"
        private = fresh_home / ".sciretriever"
        private.mkdir(mode=0o700, parents=True)
        configuration = private / "config.toml"
        configuration.write_bytes(b"[agents]\n")
        configuration.chmod(0o600)
        credentials = private / "credentials.toml"
        secret = b"installed-legacy-secret-sentinel"
        credentials_payload = (
            b'[agents]\napi_key = "' + secret + b'"\norigin = "https://api.openai.com"\n'
        )
        credentials.write_bytes(credentials_payload)
        credentials.chmod(0o600)

        result = self.install.run_console(
            ("config", "--theme", "mono"),
            stdin=b"",
            environment={"HOME": os.fspath(fresh_home)},
            cwd=root,
        )

        self.assertEqual(result.returncode, 4, result.stderr_text)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(configuration.read_bytes(), b"[agents]\n")
        self.assertEqual(credentials.read_bytes(), credentials_payload)
        self.assertIn(b"configuration section is unknown", result.stderr)
        self.assertNotIn(b"Reset", result.stderr)
        self.assertNotIn(b"SciRetriever configuration center", result.stderr)
        self.assertNotIn(secret, result.stderr)

        configuration.write_bytes(b"")
        credentials_result = self.install.run_console(
            ("config", "--theme", "mono"),
            stdin=b"",
            environment={"HOME": os.fspath(fresh_home)},
            cwd=root,
        )

        self.assertEqual(credentials_result.returncode, 4, credentials_result.stderr_text)
        self.assertEqual(credentials_result.stdout, b"")
        self.assertEqual(configuration.read_bytes(), b"")
        self.assertEqual(credentials.read_bytes(), credentials_payload)
        self.assertIn(b"credentials provider is unknown", credentials_result.stderr)
        self.assertNotIn(b"SciRetriever configuration center", credentials_result.stderr)
        self.assertNotIn(secret, credentials_result.stderr)

    def test_installed_setup_discovers_and_selects_direct_models_from_a_fake_provider(
        self,
    ) -> None:
        root = self.install.root
        assert root is not None
        fresh_home = root / "fresh-llm-setup-home"
        fresh_home.mkdir(mode=0o700)
        work = root / "fresh-llm-setup-work"
        work.mkdir(mode=0o700)
        environment = {"HOME": os.fspath(fresh_home)}

        with _model_catalog_server() as base_url:
            configured = self.install.run_console(
                ("config",),
                stdin=(
                    "m\n"
                    "1\n"
                    "1\n"
                    "4\n"
                    f"{base_url}\n"
                    "2\n"
                    "1\n"
                    "8\n"
                    "2\n"
                    "1\n"
                    "y\n"
                    "1\n"
                    "1\n"
                    "2\n"
                    "7\n"
                    "1\n"
                    "1\n"
                    "y\n"
                    "5\n"
                    "a\n"
                    "1\n"
                    "1\n"
                    "2\n"
                    "y\n"
                    "4\n"
                    "b\n"
                    "1\n"
                    "1\n"
                    "\n"
                    "\n"
                    "y\n"
                    "y\n"
                    "6\n"
                    "q\n"
                ).encode(),
                environment=environment,
                cwd=work,
            )

        self.assertEqual(configured.returncode, 0, configured.stderr_text)
        self.assertEqual(configured.stdout, b"")
        self.assertEqual(configured.stderr.count(b"Reading the Provider model list"), 2)
        self.assertIn(b"Model 'local/acceptance-analysis' was saved", configured.stderr)
        self.assertIn(b"Model 'local/acceptance-browser' was saved", configured.stderr)
        self.assertIn(b"Analyze now uses 'local/acceptance-analysis'", configured.stderr)
        self.assertIn(b"Browser Setup and the local Profile were saved", configured.stderr)
        configuration = fresh_home / ".sciretriever" / "config.toml"
        credentials = fresh_home / ".sciretriever" / "credentials.toml"
        self.assertTrue(configuration.is_file())
        self.assertFalse(credentials.exists())
        rendered = configuration.read_text(encoding="utf-8")
        self.assertIn("[providers.local]", rendered)
        self.assertIn('api = "openai-chat-completions"', rendered)
        self.assertIn('[models."local/acceptance-analysis"]', rendered)
        self.assertIn('[models."local/acceptance-browser"]', rendered)
        self.assertEqual(rendered.count('reasoning = "max"'), 1)
        self.assertEqual(rendered.count('reasoning = "xhigh"'), 1)
        self.assertEqual(rendered.count("stream = true"), 2)
        self.assertIn("[analyze]", rendered)
        self.assertIn('model = "local/acceptance-analysis"', rendered)
        self.assertIn("[browser]", rendered)
        self.assertIn('model = "local/acceptance-browser"', rendered)
        self.assertEqual(rendered.count("image = true"), 1)
        for removed in (
            "profiles",
            "services",
            "context_window_tokens",
            "\nmax_output_tokens =",
            "structured_output",
            "tool_decision",
            "image_count",
            "image_bytes",
        ):
            self.assertNotIn(removed, rendered)

        status = self.install.run_console(
            ("config", "status", "--json"),
            environment=environment,
            cwd=work,
        )
        self.assertEqual(status.returncode, 0, status.stderr_text)
        self.assertEqual(status.stderr, b"")
        payload = json.loads(status.stdout)
        self.assertEqual(
            payload["analyze"]["selected_model"]["reasoning"],
            "max",
        )
        self.assertFalse(payload["analyze"]["selected_model"]["image"])
        self.assertEqual(
            payload["browser"]["selected_model"]["model"],
            "acceptance-browser",
        )
        self.assertEqual(payload["browser"]["selected_model"]["reasoning"], "xhigh")
        self.assertTrue(payload["browser"]["selected_model"]["image"])
        self.assertFalse((work / "catalog.sqlite3").exists())
        self.assertFalse((work / "artifacts").exists())

    def test_business_command_ignores_legacy_environment_and_cwd_configuration(self) -> None:
        root = self.install.root
        assert root is not None
        work = root / "fixed-configuration-selection"
        work.mkdir(mode=0o700)
        catalog = {
            name: work / f"catalog-{name}.sqlite3" for name in ("fixed", "cwd", "environment")
        }
        artifacts = {name: work / f"artifacts-{name}" for name in ("fixed", "cwd", "environment")}

        def payload(name: str) -> str:
            return "\n".join(
                (
                    "[paths]",
                    f"catalog_path = {json.dumps(os.fspath(catalog[name]))}",
                    f"artifact_root = {json.dumps(os.fspath(artifacts[name]))}",
                    "",
                )
            )

        self.install.write_user_configuration(payload("fixed"))
        cwd_configuration = work / "config.toml"
        cwd_configuration.write_text(payload("cwd"), encoding="utf-8")
        cwd_configuration.chmod(0o600)
        environment_configuration = work / "legacy-environment-config.toml"
        environment_configuration.write_text(payload("environment"), encoding="utf-8")
        environment_configuration.chmod(0o600)

        result = self.install.run_console(
            ("literature", "search", "--json"),
            environment={
                "SCIRETRIEVER_CONFIG": os.fspath(environment_configuration),
            },
            cwd=work,
        )

        self.assertEqual(result.returncode, 0, result.stderr_text)
        self.assertEqual(result.stderr, b"")
        self.assertIsInstance(json.loads(result.stdout), dict)
        self.assertTrue(catalog["fixed"].is_file())
        self.assertFalse(catalog["cwd"].exists())
        self.assertFalse(catalog["environment"].exists())

    def test_config_manager_status_and_remove_use_only_the_temporary_home(self) -> None:
        environment = self.install.isolated_environment()
        home = Path(environment["HOME"]).resolve(strict=True)
        work = Path(environment["SCIRETRIEVER_ACCEPTANCE_ROOT"]) / "config-console"
        work.mkdir(mode=0o700)
        configuration = self.install.write_user_configuration(
            """
[sources.metadata]
mode = "custom"
providers = ["web-of-science"]

[sources.metadata.web-of-science]
product = "starter"
database = "WOS"
"""
        )
        self.assertEqual(configuration, home / ".sciretriever" / "config.toml")
        credentials = home / ".sciretriever" / "credentials.toml"
        catalog = work / "catalog.sqlite3"
        artifacts = work / "artifacts"
        secret = "installed-secret-sentinel"

        created = self.install.run_console(
            ("config",),
            stdin=("s\n1\n2\n2\n1\n" + secret + "\n3\n5\n13\n3\nq\n").encode(),
            environment=environment,
            cwd=work,
        )
        self.assertEqual(created.returncode, 0, created.stderr_text)
        self.assertEqual(created.stdout, b"")
        self.assertNotIn(secret.encode(), created.stdout + created.stderr)
        self.assertIn(b"SciRetriever configuration center", created.stderr)
        self.assertIn(b"Models", created.stderr)
        self.assertIn(b"Search", created.stderr)
        self.assertIn(b"Download", created.stderr)
        self.assertIn(b"Parse", created.stderr)
        self.assertIn(b"Analyze", created.stderr)
        self.assertIn(b"Browser", created.stderr)
        self.assertNotIn(b"Providers & API Keys", created.stderr)
        self.assertNotIn(b"MinerU Parser", created.stderr)
        self.assertIn("Source · web-of-science · Key".encode(), created.stderr)
        self.assertIn(b"The key belongs to this Source", created.stderr)
        self.assertIn(b"https://developer.clarivate.com/", created.stderr)
        self.assertIn(b"were saved", created.stderr)
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
        self.assertEqual(
            set(status_payload),
            {
                "storage",
                "providers",
                "models",
                "analyze",
                "download",
                "browser",
                "parsing",
                "execution",
                "library",
            },
        )
        self.assertEqual(len(status_payload["providers"]["metadata"]), 11)
        self.assertEqual(len(status_payload["providers"]["acquisition"]), 12)
        web_of_science = next(
            item
            for item in status_payload["providers"]["metadata"]
            if item["provider"] == "web-of-science"
        )
        self.assertEqual(web_of_science["credentials"]["status"], "configured")
        self.assertEqual(
            web_of_science["credentials"]["fields"],
            [{"name": "api_key", "required": True, "configured": True}],
        )
        core = next(
            item
            for item in status_payload["providers"]["acquisition"]
            if item["provider"] == "core"
        )
        self.assertEqual(
            core["public_source"],
            {
                "saved_asset_hints_supported": True,
                "provider_service": None,
            },
        )
        self.assertTrue(core["authorized_api"]["available"])
        self.assertFalse(core["authorized_api"]["unsupported"])
        self.assertEqual(core["authorized_api"]["credentials"]["status"], "missing")
        self.assertEqual(
            core["authorized_api"]["credentials"]["fields"],
            [{"name": "api_key", "required": True, "configured": False}],
        )
        wiley = next(
            item
            for item in status_payload["providers"]["acquisition"]
            if item["provider"] == "wiley"
        )
        self.assertTrue(wiley["authorized_api"]["available"])
        self.assertFalse(wiley["authorized_api"]["unsupported"])
        self.assertEqual(wiley["authorized_api"]["credentials"]["status"], "missing")
        self.assertEqual(
            wiley["authorized_api"]["credentials"]["fields"],
            [{"name": "tdm_api_token", "required": True, "configured": False}],
        )
        browser = status_payload["browser"]
        self.assertFalse(browser["automatic_acquisition_available"])
        self.assertEqual(browser["production_route_count"], 1)
        self.assertEqual(browser["automatic_route_count"], 1)
        self.assertEqual(
            [route["access_key"] for route in browser["routes"]],
            ["generic"],
        )
        self.assertTrue(browser["runtime"]["cloak_wrapper_available"])
        self.assertTrue(browser["runtime"]["playwright_api_available"])
        self.assertFalse(browser["runtime"]["binary_presence"])
        self.assertFalse(browser["runtime"]["binary_verified"])
        self.assertFalse(browser["runtime"]["fixed_identity_manifest"])
        self.assertTrue(browser["runtime"]["headed_display_available"])
        self.assertFalse(browser["runtime"]["launch_assessed"])
        self.assertEqual(browser["mode"], "headed-fixed-profile")
        self.assertFalse(browser["interactive_authentication_supported"])
        self.assertEqual(browser["article_entitlement"], "checked-per-article")
        self.assertEqual(
            browser["profile"],
            {"selected": None, "presence": "missing"},
        )
        self.assertEqual(
            browser["session"],
            {
                "assessment": "not-assessed",
                "authenticated": None,
                "article_entitlement": "not-proven",
            },
        )
        self.assertTrue(browser["probe"]["available"])
        self.assertTrue(browser["probe"]["requires_explicit_target"])
        self.assertEqual(
            browser["probe"]["supported_access_keys"],
            [
                "acs-publications",
                "aip-publishing",
                "elsevier-sciencedirect",
                "iopscience",
                "oxford-academic",
                "rsc-publishing",
                "science-aaas",
                "springerlink",
                "wiley-online-library",
            ],
        )
        self.assertEqual(
            browser["action_required"][0]["code"],
            "browser-disabled",
        )
        self.assertFalse(status_payload["parsing"]["locally_ready"])
        self.assertEqual(status_payload["models"], {"providers": [], "models": []})
        self.assertIsNone(status_payload["analyze"]["model"])
        self.assertIsNone(status_payload["analyze"]["selected_model"])
        self.assertFalse(status_payload["analyze"]["content_locally_ready"])
        self.assertIsNone(status_payload["browser"]["model"])
        self.assertIsNone(status_payload["browser"]["selected_model"])
        self.assertFalse(catalog.exists())
        self.assertFalse(artifacts.exists())
        assert home is not None
        for relative in (
            ".cache/ms-playwright",
            ".cache/cloakbrowser",
            ".local/share/ms-playwright",
        ):
            self.assertFalse(
                (home / relative).exists(),
                f"fresh installed command implicitly created browser runtime cache: {relative}",
            )

        browser_probe = self.install.run_console(
            (
                "config",
                "test",
                "browser",
                "site",
                "springerlink",
                "--json",
            ),
            environment=environment,
            cwd=work,
        )
        self.assertEqual(browser_probe.returncode, 3, browser_probe.stderr_text)
        self.assertEqual(browser_probe.stderr, b"")
        self.assertNotIn(secret.encode(), browser_probe.stdout)
        browser_probe_payload = json.loads(browser_probe.stdout)
        self.assertEqual(browser_probe_payload["outcome"], "skipped")
        self.assertEqual(
            browser_probe_payload["failure_code"],
            "browser-disabled",
        )
        self.assertEqual(browser_probe_payload["navigation_count"], 0)
        self.assertEqual(browser_probe_payload["article_entitlement"], "not-proven")
        self.assertFalse(browser_probe_payload["persisted"])
        self.assertFalse(catalog.exists())
        self.assertFalse(artifacts.exists())

        removed = self.install.run_console(
            ("config",),
            stdin=b"s\n1\n2\n2\n2\ny\n3\n5\n13\n3\nq\n",
            environment=environment,
            cwd=work,
        )
        self.assertEqual(removed.returncode, 0, removed.stderr_text)
        self.assertEqual(removed.stdout, b"")
        self.assertIn(b"Remove credentials for web-of-science?", removed.stderr)
        self.assertIn(b"Source credentials were removed", removed.stderr)
        self.assertNotIn(secret.encode(), removed.stdout + removed.stderr)
        self.assertNotIn(secret.encode(), credentials.read_bytes())

        missing = self.install.run_console(
            ("config",),
            stdin=b"s\n1\n2\n2\n2\n3\n5\n13\n3\nq\n",
            environment=environment,
            cwd=work,
        )
        self.assertEqual(missing.returncode, 0, missing.stderr_text)
        self.assertEqual(missing.stdout, b"")
        self.assertIn(b"No credential is saved for this Source", missing.stderr)
        self.assertNotIn(b"Remove credentials for web-of-science?", missing.stderr)
        self.assertFalse(catalog.exists())
        self.assertFalse(artifacts.exists())

    def test_installed_core_service_status_and_probes_are_isolated_and_offline(self) -> None:
        with InstalledWheel() as install:
            helper = Path(__file__).parent / "helpers"
            install.install_sitecustomize(helper / "sitecustomize_production_fixture.py")
            install.install_startup_fixture(
                helper / "sciretriever_acceptance_transport.py",
            )
            environment = install.isolated_environment(
                {"SCIRETRIEVER_TEST_PRODUCTION_FIXTURE": "1"}
            )
            home = Path(environment["HOME"]).resolve(strict=True)
            assert install.root is not None
            work = install.root / "config-core-services"
            work.mkdir(mode=0o700)
            install.write_user_configuration(_core_service_configuration())
            credentials_directory = home / ".sciretriever"
            credentials_directory.mkdir(mode=0o700, exist_ok=True)
            credentials_directory.chmod(0o700)
            credentials = credentials_directory / "credentials.toml"
            secret = "installed-core-secret-sentinel"
            credentials.write_text(
                f'[providers.openai]\napi_key = "{secret}"\norigin = "https://api.openai.com"\n',
                encoding="utf-8",
            )
            credentials.chmod(0o600)

            status_json = install.run_console(
                ("config", "status", "--json"),
                environment=environment,
                cwd=work,
            )
            self.assertEqual(status_json.returncode, 0, status_json.stderr_text)
            self.assertEqual(status_json.stderr, b"")
            self.assertNotIn(b"\x1b[", status_json.stdout)
            self.assertNotIn(secret.encode(), status_json.stdout)
            status_payload = json.loads(status_json.stdout)
            self.assertTrue(status_payload["analyze"]["reference_locally_ready"])
            self.assertEqual(
                status_payload["analyze"]["selected_model"]["reasoning"],
                "medium",
            )
            self.assertEqual(
                status_payload["models"]["providers"][0]["key"],
                {
                    "required": True,
                    "configured": True,
                    "origin_matches": True,
                },
            )
            self.assertTrue(status_payload["parsing"]["locally_ready"])
            self.assertFalse(status_payload["parsing"]["bearer_token"]["required"])

            status_human = install.run_console(
                ("config", "status", "--theme", "mono"),
                environment=environment,
                cwd=work,
            )
            self.assertEqual(status_human.returncode, 0, status_human.stderr_text)
            self.assertEqual(status_human.stderr, b"")
            self.assertNotIn(b"\x1b[", status_human.stdout)
            self.assertNotIn(secret.encode(), status_human.stdout)
            self.assertIn(b"Models, Analyze, Browser and Parse", status_human.stdout)
            self.assertIn(b"reasoning medium", status_human.stdout)
            self.assertIn(b"Parse", status_human.stdout)

            analyze = install.run_console(
                ("config", "test", "analyze", "--json"),
                environment=environment,
                cwd=work,
            )
            self.assertEqual(analyze.returncode, 0, analyze.stderr_text)
            self.assertNotIn(secret.encode(), analyze.stderr)
            self.assertNotIn(b"Traceback", analyze.stderr)
            self.assertNotIn(secret.encode(), analyze.stdout)
            analyze_payload = json.loads(analyze.stdout)
            self.assertEqual(analyze_payload["outcome"], "passed")
            self.assertEqual(
                analyze_payload["details"]["request_kind"],
                "minimal-schema",
            )
            self.assertFalse(analyze_payload["details"]["sends_user_literature"])
            self.assertFalse(analyze_payload["persisted"])

            parse = install.run_console(
                ("config", "test", "parse", "--json"),
                environment=environment,
                cwd=work,
            )
            self.assertEqual(parse.returncode, 0, parse.stderr_text)
            self.assertNotIn(secret.encode(), parse.stderr)
            self.assertNotIn(b"Traceback", parse.stderr)
            parse_payload = json.loads(parse.stdout)
            self.assertEqual(parse_payload["outcome"], "passed")
            self.assertEqual(parse_payload["details"]["request_kind"], "health-only")
            self.assertFalse(parse_payload["details"]["uploaded_pdf"])
            self.assertFalse(parse_payload["persisted"])

            all_probes = install.run_console(
                ("config", "test", "--all", "--json"),
                environment=environment,
                cwd=work,
            )
            self.assertEqual(all_probes.returncode, 0, all_probes.stderr_text)
            self.assertNotIn(secret.encode(), all_probes.stdout)
            self.assertNotIn(secret.encode(), all_probes.stderr)
            self.assertNotIn(b"Traceback", all_probes.stderr)
            all_payload = json.loads(all_probes.stdout)
            self.assertEqual(all_payload["search"], {"results": []})
            self.assertEqual(all_payload["download"], {"results": []})
            self.assertEqual(all_payload["analyze"]["outcome"], "passed")
            self.assertEqual(all_payload["parse"]["outcome"], "passed")

            requests = [
                json.loads(line)
                for line in (install.root / "production-wire.ndjson")
                .read_text(encoding="utf-8")
                .splitlines()
                if json.loads(line)["kind"] == "request"
            ]
            self.assertEqual(
                [(item["host"], item["path"]) for item in requests],
                [
                    ("api.openai.com", "/v1/responses"),
                    ("127.0.0.1", "/health"),
                    ("api.openai.com", "/v1/responses"),
                    ("127.0.0.1", "/health"),
                ],
            )
            self.assertEqual(
                requests[0]["credential_header_names"],
                ["authorization"],
            )
            self.assertEqual(requests[1]["credential_header_names"], [])
            self.assertFalse((work / "catalog.sqlite3").exists())
            self.assertFalse((work / "artifacts").exists())


def _core_service_configuration() -> str:
    return """
[sources.metadata]
mode = "custom"
providers = []

[sources.acquisition]
mode = "custom"
providers = []

[parsing]
base_url = "http://127.0.0.1:8000"
connection_mode = "loopback"
model_identity = "mineru-3.4.4-vlm"
remote_upload_authorized = false

[providers.openai]
api = "openai-responses"
base_url = "https://api.openai.com/v1"
[models."openai/acceptance-model"]
reasoning = "medium"
image = false
[analyze]
model = "openai/acceptance-model"
metadata_max_output_tokens = 1024
content_max_output_tokens = 4096
reference_max_output_tokens = 1024
max_input_bytes = 1048576
max_chunk_bytes = 262144
max_chunk_count = 4
max_total_llm_requests = 6
max_total_output_tokens = 12288
"""


if __name__ == "__main__":
    unittest.main()
