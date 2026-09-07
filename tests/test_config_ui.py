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
    ConfigActionKind,
    ConfigConsole,
    ConfigOption,
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
        },
        "browser": {
            "enabled": True,
            "model": "openai/gpt-browser",
            "model_locally_ready": True,
            "selected_model": {
                "reference": "openai/gpt-browser",
                "provider": "openai",
                "model": "gpt-browser",
                "reasoning": "high",
                "image": True,
            },
            "mode": "headed-fixed-profile",
            "interactive_authentication_supported": False,
            "article_entitlement": "checked-per-article",
            "local_max_concurrency": 2,
            "runtime": {
                "cloak_wrapper_available": True,
                "playwright_api_available": True,
                "binary_presence": True,
                "binary_version": "146.0.7680.177.5",
                "binary_verified": True,
                "headed_display_available": True,
                "fixed_identity_manifest": True,
                "identity_schema": "sciretriever.browser-identity.v1",
                "profile_lease": "not-assessed",
                "launch_assessed": False,
            },
            "profile": {
                "selected": "fixture-profile",
                "presence": "configured",
            },
            "session": {
                "assessment": "not-assessed",
                "authenticated": None,
                "article_entitlement": "not-proven",
            },
            "automatic_acquisition_available": True,
            "production_route_count": 1,
            "automatic_route_count": 1,
            "routes": [
                {
                    "access_key": "generic",
                    "display_name": "Generic Browser",
                    "route_key": "browser:generic",
                    "rate_limit_group": "browser-generic",
                    "production_available": True,
                    "automatic_acquisition_eligible": True,
                    "policy": {
                        "evidence": "project-conservative",
                        "policy_revision": "generic-browser-v1",
                        "verification_date": "2026-09-05",
                        "notes_reference": (
                            "docs/architecture/decisions/"
                            "0017-shared-agents-and-controlled-browser-agent.md"
                        ),
                        "max_concurrency": 1,
                        "minimum_start_interval": 1.0,
                        "maximum_starts_per_window": 120,
                        "window_seconds": 3600.0,
                        "cooldown_after_completion": 0.0,
                        "rate_limit_cooldown": 60.0,
                        "failure_cooldown": 5.0,
                        "runtime_failure_threshold": 3,
                    },
                }
            ],
            "probe": {
                "available": True,
                "requires_explicit_target": True,
                "supported_access_keys": ["generic"],
            },
            "action_required": [],
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
        "models": {
            "providers": [
                {
                    "name": "openai",
                    "api": "openai-responses",
                    "base_url": "https://api.openai.com/v1",
                    "key": {
                        "required": True,
                        "configured": True,
                        "origin_matches": True,
                    },
                }
            ],
            "models": [
                {
                    "reference": "openai/gpt-summary",
                    "provider": "openai",
                    "model": "gpt-summary",
                    "reasoning": "max",
                    "image": False,
                },
                {
                    "reference": "openai/gpt-browser",
                    "provider": "openai",
                    "model": "gpt-browser",
                    "reasoning": "high",
                    "image": True,
                },
            ],
        },
        "analyze": {
            "model": "openai/gpt-summary",
            "reference_locally_ready": True,
            "selected_model": {
                "reference": "openai/gpt-summary",
                "provider": "openai",
                "model": "gpt-summary",
                "reasoning": "max",
                "image": False,
            },
        },
        "download": {"mode": "auto", "sources": ["wiley"]},
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
            console.access(
                api_routes=(("Wiley", "Ready", "No local action"),),
                browser_state="Unavailable",
                browser_detail="The persistent headed runtime is unavailable.",
                browser_action="Install the reviewed Browser runtime if needed.",
            )
            console.changes((("analysis.model", "old", "new"),))
        self.assertEqual(stdout.getvalue(), "")
        rendered = stderr.getvalue()
        self.assertIn("SciRetriever · Configuration", rendered)
        self.assertIn("LOCAL · NO NETWORK REQUESTS", rendered)
        self.assertIn("Controlled Browser", rendered)
        self.assertIn("Proposed ordinary configuration", rendered)
        self.assertIn("changes", rendered)
        self.assertNotIn("\x1b[", rendered)
        self.assertNotIn(_SECRET, rendered)

    def test_model_setup_steps_and_review_are_compact_and_secret_free(self) -> None:
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            console = ConfigConsole("mono", width=72)
            console.setup_step(1, 8, "PROVIDER", "Choose the shared endpoint.")
            console.section(
                "Models · example/gpt-fixture",
                "API openai-responses · URL https://gateway.example.invalid/v1\n"
                "reasoning max · image yes",
            )

        rendered = stderr.getvalue()
        semantic_text = " ".join(rendered.split())
        for value in (
            "01/08",
            "PROVIDER",
            "Models · example/gpt-fixture",
            "openai-responses",
            "gpt-fixture",
            "reasoning max",
            "image yes",
        ):
            self.assertIn(value, semantic_text)
        self.assertNotIn("Profile", rendered)
        self.assertNotIn("Service", rendered)
        self.assertNotIn("Preset", rendered)
        self.assertNotIn("context_window_tokens", rendered)
        self.assertNotIn("structured_output", rendered)
        self.assertNotIn("max_chunk_bytes", rendered)
        self.assertNotIn("image_bytes", rendered)
        self.assertNotIn(_SECRET, rendered)

    def test_header_keeps_context_without_duplicating_configuration_navigation(self) -> None:
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            ConfigConsole("mono", width=80).header(
                config_path="/tmp/config.toml",
                credentials_path="/tmp/credentials.toml",
            )
        rendered = stderr.getvalue()
        semantic_text = " ".join(rendered.split())
        for value in (
            "SciRetriever · Configuration",
            "Config",
            "/tmp/config.toml",
            "Secrets",
            "/tmp/credentials.toml",
            "LOCAL · NO NETWORK REQUESTS",
        ):
            self.assertIn(value, semantic_text)
        for value in (
            "CONFIGURATION AREAS",
            "Models",
            "Search",
            "Download",
            "Parse",
            "Analyze",
            "Browser",
            "Status",
            "Theme",
        ):
            self.assertNotIn(value, rendered)
        self.assertNotIn("fingerprint_seed", rendered)
        self.assertNotIn("browser-profiles/", rendered)
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
        semantic_text = " ".join(rendered.replace("│", " ").split())
        for text in (
            "Models, Analyze, Browser and Parse",
            "Provider · openai",
            "Model · openai/gpt-…",
            "model: gpt-summary",
            "model: gpt-browser",
            "Analyze",
            "Browser · Model",
            "reasoning max",
            "reasoning high",
            "Analyze selects one configured Model",
            "Parse",
            "Metadata APIs",
            "Authorized primary-PDF APIs",
            "PDF acquisition routes",
            "Controlled Browser",
            "Access mode",
            "Selected profile",
            "Browser lifecycle",
            "Publisher lanes",
            "Interactive authent",
            "not assessed",
            "Article access",
            "checked-per-article",
            "not evaluated",
        ):
            self.assertIn(text, semantic_text)
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
                            "Headed runtime is unavailable; article entitlement is not assessed."
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
                browser_detail="Local runtime readiness only.",
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
                    "Access mode",
                    "fixed profile",
                    "Selected profile",
                    "Browser lifecycle",
                    "one fixed",
                    "Publisher lanes",
                    "Interactive authent",
                    "Article access",
                    "checked-per-article",
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
                "article_entitlement": "not-proven",
                "navigation_count": 1,
                "failure_code": None,
                "persisted": False,
            }
        )
        rendered = output.getvalue()
        self.assertIn("Browser · springerlink", rendered)
        self.assertIn("One approved Browser navigation", rendered)
        self.assertIn("Browser launched and reached", rendered)
        self.assertNotIn("entitlement", rendered)
        self.assertNotIn("browser-session-not-authenticated", rendered)
        self.assertNotIn(_SECRET, rendered)
        self.assertNotIn("\x1b[", rendered)

    def test_browser_agent_probe_presentation_names_its_closed_request(self) -> None:
        output = io.StringIO()
        ConfigStatusPresenter(
            "mono",
            file=output,
            force_terminal=False,
            width=120,
        ).probes(
            {
                "service": "agents",
                "outcome": "skipped",
                "local_ready": False,
                "failure_code": "browser-agent-not-ready",
                "details": {
                    "role": "browser-agent",
                    "request_kind": "browser-agent-tool",
                    "image_input": True,
                    "tool_decision": True,
                    "image_count": 1,
                    "tool_count": 1,
                    "sends_user_literature": False,
                    "sends_page_content": False,
                    "sends_pdf": False,
                    "may_consume_quota": True,
                },
            }
        )
        rendered = output.getvalue()
        self.assertIn("Browser · not selected", rendered)
        self.assertIn("Not sent", rendered)
        self.assertIn("not locally ready for image input", rendered)
        self.assertIn("image-capable Model", rendered)
        self.assertNotIn(_SECRET, rendered)
        self.assertNotIn("\x1b[", rendered)

    def test_provider_and_exact_model_probe_presentations_keep_their_distinct_meaning(
        self,
    ) -> None:
        payloads = (
            (
                {
                    "service": "agents",
                    "outcome": "passed",
                    "local_ready": True,
                    "failure_code": None,
                    "details": {
                        "request_kind": "model-catalog",
                        "provider": "main",
                        "protocol": "openai-responses",
                        "request_method": "GET",
                        "request_url": "https://models.example/v1/models",
                        "catalog_count": 2,
                        "catalog_truncated": False,
                        "may_consume_quota": True,
                    },
                },
                (
                    "Provider · main",
                    "GET https://models.example/v1/models",
                    "2 Model IDs were",
                    "parsed.",
                ),
            ),
            (
                {
                    "service": "agents",
                    "outcome": "passed",
                    "local_ready": True,
                    "failure_code": None,
                    "details": {
                        "request_kind": "model-text",
                        "reference": "main/probe-model",
                        "provider": "main",
                        "model": "probe-model",
                        "protocol": "openai-responses",
                        "reasoning": "max",
                        "image_input": False,
                        "request_method": "POST",
                        "request_url": "https://models.example/v1/responses",
                        "response_parseable": True,
                    },
                },
                (
                    "Model · probe-model",
                    "Provider · main",
                    "POST https://models.example/v1/responses",
                    "returned a valid strict response",
                ),
            ),
        )
        for payload, expected in payloads:
            with self.subTest(expected=expected):
                output = io.StringIO()
                ConfigStatusPresenter(
                    "mono",
                    file=output,
                    force_terminal=False,
                    width=120,
                ).probes(payload)
                rendered = output.getvalue()
                normalized = " ".join(rendered.replace("│", " ").split())
                for value in expected:
                    self.assertIn(value, normalized)
                if expected[0] == "Model · probe-model":
                    self.assertNotIn("Model · main/probe-model", normalized)
                self.assertNotIn(_SECRET, rendered)

    def test_download_probe_presentation_does_not_claim_a_pdf_or_entitlement(self) -> None:
        output = io.StringIO()
        ConfigStatusPresenter(
            "mono",
            file=output,
            force_terminal=False,
            width=120,
        ).probes(
            {
                "results": [
                    {
                        "provider": "crossref",
                        "capability": "acquisition",
                        "outcome": "skipped",
                        "local_ready": False,
                        "failure_code": "acquisition-probe-unavailable",
                    }
                ]
            }
        )
        rendered = output.getvalue()
        normalized = " ".join(rendered.split())
        self.assertIn("Download · crossref", rendered)
        self.assertIn("No safe config-only Download request", normalized)
        self.assertIn("complete pdf", normalized)
        self.assertNotIn("acquisition-probe-unavailable", rendered)

    def test_global_probe_presentation_recognizes_the_owner_scoped_groups(self) -> None:
        output = io.StringIO()
        ConfigStatusPresenter(
            "mono",
            file=output,
            force_terminal=False,
            width=120,
        ).probes(
            {
                "search": {
                    "results": [
                        {
                            "provider": "crossref",
                            "capability": "metadata",
                            "outcome": "passed",
                            "failure_code": None,
                        }
                    ]
                },
                "download": {"results": []},
                "analyze": {
                    "service": "agents",
                    "outcome": "passed",
                    "details": {"role": "analysis"},
                },
                "parse": {
                    "service": "mineru",
                    "outcome": "passed",
                    "details": {"request_kind": "health-only"},
                },
            }
        )
        rendered = output.getvalue()
        self.assertIn("Search · crossref", rendered)
        self.assertIn("Analyze · not selected", rendered)
        self.assertIn("MinerU", rendered)
        self.assertNotIn("Browser ·", rendered)

    def test_failed_model_probe_shows_model_url_reason_and_next_check_without_raw_body(
        self,
    ) -> None:
        output = io.StringIO()
        ConfigStatusPresenter(
            "mono",
            file=output,
            force_terminal=False,
            width=140,
        ).probes(
            {
                "service": "agents",
                "outcome": "failed",
                "local_ready": True,
                "failure_code": "agent-not-found",
                "failure_evidence": {
                    "http_status": 404,
                    "access_code": None,
                    "remote_error": None,
                },
                "details": {
                    "request_kind": "model-text",
                    "reference": "qiuzk/gpt-5.6-luna",
                    "provider": "qiuzk",
                    "model": "gpt-5.6-luna",
                    "protocol": "openai-responses",
                    "reasoning": "max",
                    "stream": True,
                    "image_input": False,
                    "request_method": "POST",
                    "request_url": "https://qiuzk.example/v1/responses",
                },
            }
        )

        rendered = " ".join(output.getvalue().replace("│", " ").split())
        self.assertIn("Model · gpt-5.6-luna", rendered)
        self.assertIn("Provider · qiuzk", rendered)
        self.assertNotIn("Model · qiuzk/gpt-5.6-luna", rendered)
        self.assertIn("POST https://qiuzk.example/v1/responses", rendered)
        self.assertIn("Stream · on", rendered)
        self.assertIn("Failed", rendered)
        self.assertIn("HTTP 404", rendered)
        self.assertIn("Model or API endpoint was", rendered)
        self.assertIn("not found", rendered)
        self.assertIn("exact Model name first", rendered)
        self.assertNotIn("agent-not-found", rendered)
        self.assertNotIn("PRIVATE-RESPONSE-SENTINEL", rendered)


class TerminalChoiceTests(unittest.TestCase):
    def test_options_are_single_word_and_keep_color_independent_action_markers(self) -> None:
        cases = (
            (ConfigActionKind.CONFIGURE, "◆"),
            (ConfigActionKind.INSPECT, "◇"),
            (ConfigActionKind.TEST, "▶"),
            (ConfigActionKind.DANGER, "!"),
            (ConfigActionKind.NAVIGATE, "←"),
        )
        for kind, marker in cases:
            with self.subTest(kind=kind.value):
                item = ConfigOption("value", "Setup", kind)
                self.assertEqual(item.marker, marker)
                self.assertTrue(item.plain_label.startswith(marker))
        self.assertEqual(
            ConfigOption("quit", "Quit", ConfigActionKind.NAVIGATE).marker,
            "×",
        )
        with self.assertRaisesRegex(ValueError, "one word"):
            ConfigOption("invalid", "Two words")

    def test_option_description_is_aligned_separately_from_its_single_word_label(self) -> None:
        item = ConfigOption(
            "core",
            "core",
            description="Active · CORE API · API key optional",
        )

        self.assertEqual(
            item.plain_row(label_width=12),
            "◆ core         Active · CORE API · API key optional",
        )
        fragments = list(item.prompt_label(label_width=12, description_width=80))
        self.assertEqual(fragments[0], ("class:action.configure", "◆ core"))
        self.assertEqual(fragments[1][0], "class:option.description")
        self.assertTrue(fragments[1][1].endswith("API key optional"))
        with self.assertRaisesRegex(ValueError, "one trimmed line"):
            ConfigOption("invalid", "Invalid", description="two\nlines")

    def test_shortcut_uses_public_prompt_session_and_returns_mapped_value(self) -> None:
        with create_pipe_input() as pipe:
            pipe.send_text("a")
            result = TerminalChoice[str](
                message="Open a configuration area",
                options=(ConfigOption("access", "Access"), ConfigOption("quit", "Quit")),
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
                options=(ConfigOption("first", "First"), ConfigOption("second", "Second")),
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
                    options=(ConfigOption("first", "First"),),
                    input_factory=lambda: pipe,
                    output_factory=DummyOutput,
                ).prompt()

    def test_left_arrow_returns_the_configured_back_value(self) -> None:
        with create_pipe_input() as pipe:
            pipe.send_bytes(b"\x1b[D")
            result = TerminalChoice[str](
                message="Choose",
                options=(
                    ConfigOption("first", "First"),
                    ConfigOption("back", "Back", ConfigActionKind.NAVIGATE),
                ),
                back_value="back",
                input_factory=lambda: pipe,
                output_factory=DummyOutput,
            ).prompt()
        self.assertEqual(result, "back")

    def test_search_filters_a_long_choice_list_before_selection(self) -> None:
        with create_pipe_input() as pipe:
            pipe.send_text("/citation\r\r")
            result = TerminalChoice[str](
                message="Choose a model",
                options=(
                    ConfigOption("first", "First", description="Metadata"),
                    ConfigOption("second", "Second", description="Citation API"),
                ),
                searchable=True,
                input_factory=lambda: pipe,
                output_factory=DummyOutput,
            ).prompt()
        self.assertEqual(result, "second")

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
