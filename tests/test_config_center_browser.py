from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from sciretriever.entry.cli.config_center import browser
from sciretriever.entry.cli.config_ui import ConfigActionKind
from sciretriever.model.configuration import (
    BrowserController,
    BrowserProfilePresence,
    Configuration,
)


def _models_configuration() -> Configuration:
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
                        "reference": "openai/text-model",
                        "reasoning": "high",
                        "image": False,
                    },
                    {
                        "reference": "openai/browser-model",
                        "reasoning": "max",
                        "image": True,
                    },
                ]
            },
        }
    )


class BrowserPageTests(unittest.TestCase):
    def test_agent_setup_offers_only_image_capable_models(self) -> None:
        before = _models_configuration()
        selected = before.models.get("openai/browser-model")
        assert selected is not None
        console = Mock()
        profile_status = Mock(presence=BrowserProfilePresence.MISSING)
        with (
            patch.object(browser, "select_value", return_value="agent"),
            patch.object(browser, "choose_model", return_value=selected) as choose,
            patch.object(browser, "ask_text", return_value="institutional-access"),
            patch.object(browser, "_ask_concurrency", return_value=3),
            patch.object(browser, "browser_profile_status", return_value=profile_status),
        ):
            draft = browser._setup_candidate(before, console)

        self.assertIsNotNone(draft)
        assert draft is not None
        candidate, presence, after = draft
        self.assertIs(candidate.browser_controller, BrowserController.AGENT)
        self.assertEqual(candidate.model, "openai/browser-model")
        self.assertEqual(candidate.browser_profile, "institutional-access")
        self.assertEqual(candidate.browser_max_concurrency, 3)
        self.assertIs(presence, BrowserProfilePresence.MISSING)
        self.assertEqual(after.access, candidate)
        candidates = choose.call_args.kwargs["candidates"]
        self.assertEqual([item.reference for item in candidates], ["openai/browser-model"])

    def test_browser_page_owns_setup_profiles_runtime_and_tests(self) -> None:
        console = Mock()
        local = Mock()
        local.profile.presence = BrowserProfilePresence.MISSING
        runtime_manager = Mock()
        runtime_manager.status.return_value = Mock(verified=False)
        with (
            patch.object(
                browser,
                "load_editable_user_configuration",
                return_value=_models_configuration(),
            ),
            patch.object(browser, "browser_access_status", return_value=local),
            patch.object(browser, "CloakRuntimeManager", return_value=runtime_manager),
            patch.object(browser, "select_value", return_value="back") as select,
        ):
            browser.manage_browser(console)

        options = select.call_args.args[1]
        self.assertEqual(
            [item.label for item in options],
            ["Setup", "Profiles", "Runtime", "Test", "Reset", "Back"],
        )
        self.assertIs(options[3].kind, ConfigActionKind.TEST)
        self.assertIs(options[4].kind, ConfigActionKind.DANGER)
        self.assertIs(options[5].kind, ConfigActionKind.NAVIGATE)
        description = console.page.call_args.args[1]
        self.assertIn("controller Model, fixed Profile and Runtime", description)
        notes = " ".join(console.page.call_args.kwargs["notes"])
        self.assertIn("does not launch Chromium", notes)
        self.assertIn("never inferred from Profile presence", notes)

    def test_test_page_separates_model_contract_from_explicit_site_navigation(self) -> None:
        console = Mock()
        with patch.object(browser, "select_value", return_value="back") as select:
            browser._manage_tests(console)

        options = select.call_args.args[1]
        self.assertEqual([item.label for item in options], ["Model", "Site", "Back"])
        self.assertTrue(all(item.kind is ConfigActionKind.TEST for item in options[:2]))
        description = console.page.call_args.args[1]
        self.assertIn("synthetic 1×1 image", description)
        self.assertIn("Site launches", description)

        with (
            patch.object(browser, "select_value", return_value="model"),
            patch.object(browser, "run_interactive_test") as run,
        ):
            browser._manage_tests(console)
        self.assertEqual(run.call_args.args[0].owner, "browser-model")

    def test_reset_retains_profile_and_runtime_owned_state(self) -> None:
        before = Configuration.model_validate(
            {
                **_models_configuration().model_dump(mode="python"),
                "access": {
                    "model": "openai/browser-model",
                    "browser_enabled": True,
                    "browser_profile": "institutional-access",
                    "browser_controller": "agent",
                    "browser_max_concurrency": 3,
                },
            }
        )
        console = Mock()
        with (
            patch.object(browser, "load_editable_user_configuration", return_value=before),
            patch.object(browser, "confirm_changes", return_value=True),
            patch.object(browser, "confirm", return_value=True),
            patch.object(browser, "update_configuration_sections") as update,
        ):
            browser._reset(console)

        candidate = update.call_args.kwargs["access"]
        self.assertEqual(candidate.browser_profile, "institutional-access")
        self.assertFalse(candidate.browser_enabled)
        self.assertIsNone(candidate.model)
        self.assertIs(candidate.browser_controller, BrowserController.RULES)


if __name__ == "__main__":
    unittest.main()
