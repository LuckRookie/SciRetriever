from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from sciretriever.entry.cli.config_center import manager
from sciretriever.entry.cli.config_ui import ConfigActionKind, ConfigTheme, TerminalChoice
from sciretriever.model.configuration import BrowserProfilePresence, Configuration


def _configuration() -> Configuration:
    return Configuration.model_validate(
        {
            "providers": {
                "values": [
                    {
                        "name": "openai",
                        "api": "openai-responses",
                        "base_url": "https://api.openai.com/v1",
                    }
                ]
            },
            "models": {
                "values": [
                    {
                        "reference": "openai/browser-model",
                        "reasoning": "max",
                        "image": True,
                    }
                ]
            },
            "browser": {"model": "openai/browser-model"},
        }
    )


class ConfigurationManagerTests(unittest.TestCase):
    def test_submenu_quit_closes_the_configuration_center(self) -> None:
        with (
            patch.object(manager, "interactive_terminal", return_value=True),
            patch.object(
                manager,
                "_run_rich",
                side_effect=manager.ConfigurationCenterQuit,
            ),
        ):
            result = manager.run_config_manager("mono")

        self.assertEqual(result, 0)

    def test_home_rows_assign_model_use_to_browser_not_download(self) -> None:
        configuration = _configuration()
        runtime = Mock()
        runtime.agents.analysis_reference_locally_ready = False
        runtime.agents.browser_locally_ready = True
        browser = Mock()
        browser.profile.selected = None
        browser.profile.presence = BrowserProfilePresence.MISSING
        cloak = Mock(presence="missing", version=None, verified=False)
        with (
            patch.object(manager, "metadata_source_providers", return_value=()),
            patch.object(manager, "acquisition_source_providers", return_value=()),
        ):
            rows = manager.configuration_home_rows(configuration, runtime, browser, cloak)

        self.assertEqual(
            list(rows),
            ["models", "search", "download", "parse", "analyze", "browser"],
        )
        self.assertEqual(rows["download"][0], "auto · 0 Sources")
        self.assertNotIn("Model", rows["download"][0])
        self.assertIn("openai/browser-model", rows["browser"][0])

    def test_rich_home_exposes_exact_single_word_areas_and_semantic_controls(self) -> None:
        console = Mock()
        console.palette.name = ConfigTheme.MONO
        rows = {
            "models": ("1 Model · 1 Provider", "Ready"),
            "search": ("auto · 8 Sources · Limit 500 / Source", "Ready"),
            "download": ("auto · 2 Sources", "Ready"),
            "parse": ("not configured", "Incomplete"),
            "analyze": ("not selected", "Incomplete"),
            "browser": ("off · no Model", "Off"),
        }
        with (
            patch.object(manager, "ConfigConsole", return_value=console),
            patch.object(manager, "_configuration_summary", return_value=(Configuration(), Mock())),
            patch.object(manager, "browser_access_status", return_value=Mock()),
            patch.object(manager, "CloakRuntimeManager") as runtime_manager,
            patch.object(manager, "configuration_home_rows", return_value=rows),
            patch.object(TerminalChoice, "__init__", return_value=None) as initialize,
            patch.object(TerminalChoice, "prompt", return_value="quit"),
        ):
            runtime_manager.return_value.status.return_value = Mock()
            result = manager._run_rich("mono")

        self.assertEqual(result, 0)
        console.header.assert_called_once()
        options = initialize.call_args.kwargs["options"]
        self.assertEqual(
            [item.label for item in options],
            [
                "Models",
                "Search",
                "Download",
                "Parse",
                "Analyze",
                "Browser",
                "Status",
                "Theme",
                "Quit",
            ],
        )
        self.assertTrue(all(" " not in item.label for item in options))
        self.assertTrue(all(item.description for item in options))
        self.assertEqual(options[0].description, "Ready · 1 Model · 1 Provider")
        self.assertEqual(
            options[3].description,
            "Incomplete · not configured",
        )
        self.assertIn("no external requests", options[6].description)
        self.assertEqual(options[5].description, "Off · no Model")
        self.assertEqual(options[7].description, "Mono palette · local appearance only")
        self.assertIs(options[6].kind, ConfigActionKind.INSPECT)
        self.assertIs(options[-1].kind, ConfigActionKind.NAVIGATE)


if __name__ == "__main__":
    unittest.main()
