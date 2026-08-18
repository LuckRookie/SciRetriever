from __future__ import annotations

import io
import json
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import Mock, patch

from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.output import DummyOutput

from sciretriever.entry.cli.config_ui import (
    ConfigConsole,
    ConfigStatusPresenter,
    ConfigTheme,
    TerminalChoice,
    interactive_terminal,
    resolve_theme,
)

_SECRET = "configuration-ui-secret-sentinel"


def _status_payload() -> dict[str, object]:
    credentials = {
        "status": "configured",
        "fields": [{"name": "api_key", "required": True, "configured": True}],
    }
    return {
        "storage": {
            "configuration_complete": False,
            "missing_fields": ["catalog_path", "artifact_root"],
        },
        "providers": {
            "credentials_file": "~/.sciretriever/credentials.toml",
            "metadata": [
                {
                    "provider": "web-of-science",
                    "enabled": True,
                    "production_available": True,
                    "local_ready": True,
                    "failure_code": None,
                    "ordinary_settings": {
                        "product": "starter",
                        "database": "WOS",
                    },
                    "missing_ordinary_fields": [],
                    "credentials": credentials,
                    "access_policy_ready": True,
                    "probe_available": True,
                }
            ],
            "acquisition": [
                {
                    "provider": "wiley",
                    "enabled": True,
                    "production_available": True,
                    "local_ready": False,
                    "failure_code": "missing-required-credential",
                    "ordinary_settings": {},
                    "missing_ordinary_fields": [],
                    "credentials": {
                        "status": "missing",
                        "fields": [
                            {
                                "name": "tdm_api_token",
                                "required": True,
                                "configured": False,
                            }
                        ],
                    },
                    "access_policy_ready": True,
                    "probe_available": False,
                    "public_source": {
                        "provider_service": {"service": "wiley-public"},
                    },
                    "authorized_api": {"available": True, "unsupported": False},
                }
            ],
            "controlled_browser": {
                "enabled": True,
                "local_max_concurrency": 2,
                "runtime": {
                    "framework_available": True,
                    "python_dependency_available": True,
                    "chromium_executable_available": True,
                    "launch_assessed": False,
                },
                "profile": {
                    "selected": "institutional-access",
                    "presence": "configured",
                },
                "session": {
                    "assessment": "not-assessed",
                    "authenticated": None,
                    "article_entitlement": "not-proven",
                },
                "automatic_acquisition_available": True,
                "production_route_count": 1,
                "routes": [
                    {
                        "access_key": "springerlink",
                        "display_name": "SpringerLink",
                        "route_key": "browser:springerlink",
                        "rate_limit_group": "springerlink",
                        "production_available": True,
                        "policy": {
                            "evidence": "project-conservative",
                            "policy_revision": "springerlink-browser-2026-08-16",
                            "verification_date": "2026-08-16",
                            "notes_reference": "docs/notes/providers/springer-nature.md",
                            "max_concurrency": 1,
                            "minimum_start_interval": 10.0,
                            "maximum_starts_per_window": None,
                            "window_seconds": None,
                            "cooldown_after_completion": 0.0,
                            "rate_limit_cooldown": 300.0,
                            "failure_cooldown": 60.0,
                            "runtime_failure_threshold": 3,
                        },
                    }
                ],
                "probe": {
                    "available": True,
                    "requires_explicit_target": True,
                    "supported_access_keys": ["springerlink"],
                },
                "action_required": [
                    {
                        "code": "browser-session-not-assessed",
                        "reason": "Status does not launch the Browser.",
                        "action": "Run the explicit SpringerLink Browser probe.",
                    }
                ],
            },
        },
        "parsing": {
            "locally_ready": True,
            "connection_mode": "loopback",
            "base_url": "http://127.0.0.1:8000",
            "model_identity": "mineru-3.4.4-vlm",
            "implementation": {
                "release": "3.4.4",
                "api_protocol": 2,
                "profile": "vlm-engine",
                "archive_backend": "vlm",
                "parse_method": "auto",
            },
            "bearer_token": {
                "required": False,
                "configured": None,
                "origin_matches": None,
            },
        },
        "analysis": {
            "reference_locally_ready": True,
            "provider": "openai",
            "protocol": "openai-responses",
            "base_url": "https://api.openai.com/v1",
            "model": "gpt-test",
            "context_window_tokens": 128_000,
            "api_key": {
                "required": True,
                "configured": True,
                "origin_matches": True,
            },
        },
        "execution": {"max_concurrency": 4},
        "library": {"max_input_bytes": 1_000_000},
    }


class ConfigThemeTests(unittest.TestCase):
    def test_explicit_and_auto_themes_resolve_deterministically(self) -> None:
        self.assertIs(resolve_theme("dark", environment={}), ConfigTheme.DARK)
        self.assertIs(resolve_theme("light", environment={}), ConfigTheme.LIGHT)
        self.assertIs(resolve_theme("mono", environment={}), ConfigTheme.MONO)
        self.assertIs(resolve_theme("auto", environment={}), ConfigTheme.DARK)
        self.assertIs(
            resolve_theme("auto", environment={"COLORFGBG": "15;7"}),
            ConfigTheme.LIGHT,
        )
        self.assertIs(
            resolve_theme("auto", environment={"COLORFGBG": "15;0"}),
            ConfigTheme.DARK,
        )

    def test_no_color_forces_mono_for_every_requested_theme(self) -> None:
        for theme in ConfigTheme:
            with self.subTest(theme=theme.value):
                self.assertIs(
                    resolve_theme(theme, environment={"NO_COLOR": ""}),
                    ConfigTheme.MONO,
                )

    def test_unsupported_theme_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "theme is unsupported"):
            resolve_theme("neon", environment={})


class ConfigPresentationTests(unittest.TestCase):
    def test_config_console_writes_only_stderr_and_never_renders_secret(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with (
            redirect_stdout(stdout),
            redirect_stderr(stderr),
            patch.dict(os.environ, {"NO_COLOR": ""}, clear=True),
        ):
            console = ConfigConsole("dark")
            console.header(config_path="/tmp/config.toml", credentials_path="credentials.toml")
            console.home(
                llm_state="Ready",
                llm_detail="OpenAI Responses",
                mineru_state="Incomplete",
                mineru_detail="Not configured",
                providers=(("Wiley", "Authorized PDF", "Configured"),),
            )
            console.access(
                api_routes=(("Wiley", "Ready", "No local action"),),
                browser_state="Unavailable",
                browser_detail="Profile is missing; no production route is registered.",
                browser_action="Initialize only for future supported routes.",
            )
            console.changes((("analysis.model", "old", "new"),))
        self.assertEqual(stdout.getvalue(), "")
        rendered = stderr.getvalue()
        self.assertIn("SciRetriever · Configuration", rendered)
        self.assertIn("CORE SERVICES", rendered)
        self.assertIn("Provider Access", rendered)
        self.assertIn("Controlled Browser", rendered)
        self.assertIn("Proposed ordinary configuration", rendered)
        self.assertIn("changes", rendered)
        self.assertNotIn("\x1b[", rendered)
        self.assertNotIn(_SECRET, rendered)

    def test_status_presenter_is_stdout_only_and_survives_narrow_terminal(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            ConfigStatusPresenter(
                "mono",
                file=stdout,
                force_terminal=False,
                width=48,
            ).status(_status_payload())
        self.assertEqual(stderr.getvalue(), "")
        rendered = stdout.getvalue()
        for text in (
            "Core services",
            "LLM Analysis",
            "MinerU Parser",
            "Metadata APIs",
            "Authorized primary-PDF APIs",
            "PDF acquisition routes",
            "Controlled Browser",
            "Personal login",
            "not assessed",
            "IP / article access",
            "not-proven",
        ):
            self.assertIn(text, rendered)
        self.assertNotIn("\x1b[", rendered)
        self.assertNotIn(_SECRET, rendered)

    def test_dark_terminal_uses_ansi_but_mono_and_no_color_do_not(self) -> None:
        dark = io.StringIO()
        with patch.dict(os.environ, {}, clear=True):
            ConfigStatusPresenter(
                "dark",
                file=dark,
                force_terminal=True,
                width=100,
            ).status(_status_payload())
        self.assertIn("\x1b[", dark.getvalue())

        mono = io.StringIO()
        ConfigStatusPresenter(
            "mono",
            file=mono,
            force_terminal=True,
            width=100,
        ).status(_status_payload())
        self.assertNotIn("\x1b[", mono.getvalue())

        no_color = io.StringIO()
        with patch.dict(os.environ, {"NO_COLOR": "1"}, clear=True):
            ConfigStatusPresenter(
                "dark",
                file=no_color,
                force_terminal=True,
                width=100,
            ).status(_status_payload())
        self.assertNotIn("\x1b[", no_color.getvalue())

    def test_json_contract_remains_plain_and_secret_free(self) -> None:
        payload = _status_payload()
        rendered = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
        self.assertEqual(json.loads(rendered), payload)
        self.assertNotIn("\x1b[", rendered)
        self.assertNotIn(_SECRET, rendered)

    def test_access_view_supports_all_themes_no_color_and_narrow_terminals(self) -> None:
        for theme in ConfigTheme:
            with self.subTest(theme=theme.value):
                stderr = io.StringIO()
                with (
                    redirect_stderr(stderr),
                    patch.dict(os.environ, {}, clear=True),
                    patch(
                        "sciretriever.entry.cli.config_ui.interactive_terminal",
                        return_value=True,
                    ),
                ):
                    console = ConfigConsole(theme, width=44)
                    console.access(
                        api_routes=(
                            ("Elsevier", "Action required", "Configure the API credential."),
                            ("Wiley", "Ready", "No local action."),
                        ),
                        browser_state="Unavailable",
                        browser_detail=(
                            "Profile 'institutional-access' is configured; login is not assessed."
                        ),
                        browser_action="No production Browser route is registered.",
                    )
                rendered = stderr.getvalue()
                self.assertIn("Elsevier", rendered)
                self.assertIn("Wiley", rendered)
                self.assertIn("Controlled", rendered)
                self.assertIn("Browser", rendered)
                self.assertNotIn(_SECRET, rendered)
                if theme is ConfigTheme.MONO:
                    self.assertNotIn("\x1b[", rendered)

        no_color = io.StringIO()
        with (
            redirect_stderr(no_color),
            patch.dict(os.environ, {"NO_COLOR": "1"}, clear=True),
            patch(
                "sciretriever.entry.cli.config_ui.interactive_terminal",
                return_value=True,
            ),
        ):
            ConfigConsole("dark", width=40).access(
                api_routes=(("CORE", "Ready", "No local action."),),
                browser_state="Unavailable",
                browser_detail="Profile presence only.",
                browser_action="No production route.",
            )
        self.assertNotIn("\x1b[", no_color.getvalue())
        self.assertIn("CORE", no_color.getvalue())

    def test_status_browser_layers_remain_distinct_in_every_theme(self) -> None:
        for theme in ConfigTheme:
            with self.subTest(theme=theme.value):
                output = io.StringIO()
                with patch.dict(os.environ, {}, clear=True):
                    ConfigStatusPresenter(
                        theme,
                        file=output,
                        force_terminal=True,
                        width=46,
                    ).status(_status_payload())
                rendered = output.getvalue()
                for value in (
                    "Metadata APIs",
                    "Authorized primary-PDF APIs",
                    "Controlled Browser",
                    "Profile",
                    "configured",
                    "Personal login",
                    "not assessed",
                    "IP / article access",
                    "not-proven",
                    "Policy evidence",
                    "Next action",
                ):
                    self.assertIn(value, rendered)
                self.assertNotIn(_SECRET, rendered)
                self.assertNotIn("browser-profiles/", rendered)
                if theme is ConfigTheme.MONO:
                    self.assertNotIn("\x1b[", rendered)

    def test_browser_probe_presentation_is_stable_and_secret_free(self) -> None:
        output = io.StringIO()
        ConfigStatusPresenter(
            "mono",
            file=output,
            force_terminal=False,
            width=120,
        ).probes(
            {
                "access_key": "springerlink",
                "outcome": "passed",
                "local_ready": True,
                "browser_launched": True,
                "minimal_target_reached": True,
                "authentication_accepted": False,
                "article_entitlement": "not-proven",
                "navigation_count": 1,
                "failure_code": None,
                "persisted": False,
            }
        )
        rendered = output.getvalue()
        self.assertIn("Browser · springerlink", rendered)
        self.assertIn("runtime target reached", rendered)
        self.assertIn("personal login not detected", rendered)
        self.assertIn("IP/article", rendered)
        self.assertIn("entitlement not assessed", rendered)
        self.assertNotIn("browser-session-not-authenticated", rendered)
        self.assertNotIn(_SECRET, rendered)
        self.assertNotIn("\x1b[", rendered)


class TerminalChoiceTests(unittest.TestCase):
    def test_shortcut_uses_public_prompt_session_and_returns_mapped_value(self) -> None:
        with create_pipe_input() as pipe:
            pipe.send_text("a")
            result = TerminalChoice[str](
                message="Open a configuration area",
                options=(("access", "Provider Access"), ("quit", "Quit")),
                shortcuts={"a": "access", "q": "quit"},
                input_factory=lambda: pipe,
                output_factory=DummyOutput,
            ).prompt()
        self.assertEqual(result, "access")

    def test_direction_key_and_enter_select_an_option(self) -> None:
        with create_pipe_input() as pipe:
            pipe.send_bytes(b"\x1b[B\r")
            result = TerminalChoice[str](
                message="Choose",
                options=(("first", "First"), ("second", "Second")),
                input_factory=lambda: pipe,
                output_factory=DummyOutput,
            ).prompt()
        self.assertEqual(result, "second")

    def test_ctrl_c_cancels_without_returning_a_selection(self) -> None:
        with create_pipe_input() as pipe:
            pipe.send_bytes(b"\x03")
            with self.assertRaises(KeyboardInterrupt):
                TerminalChoice[str](
                    message="Choose",
                    options=(("first", "First"),),
                    input_factory=lambda: pipe,
                    output_factory=DummyOutput,
                ).prompt()

    def test_terminal_detection_requires_input_and_error_ttys(self) -> None:
        stdin = Mock()
        stderr = Mock()
        stdin.isatty.return_value = True
        stderr.isatty.return_value = False
        with (
            patch("sciretriever.entry.cli.config_ui.sys.stdin", stdin),
            patch("sciretriever.entry.cli.config_ui.sys.stderr", stderr),
        ):
            self.assertFalse(interactive_terminal())


if __name__ == "__main__":
    unittest.main()
