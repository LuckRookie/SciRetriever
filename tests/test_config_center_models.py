from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from sciretriever.agents.api import AgentModelCatalog, AgentModelSummary
from sciretriever.entry.cli.config_center import models
from sciretriever.entry.cli.config_ui import ConfigActionKind
from sciretriever.model.configuration import (
    AgentProtocol,
    AgentReasoningEffort,
    Configuration,
    ModelProviderConfig,
)


def _provider() -> ModelProviderConfig:
    return ModelProviderConfig(
        name="openai",
        api=AgentProtocol.OPENAI_RESPONSES,
        base_url="https://api.openai.com/v1",
    )


class ModelPageTests(unittest.TestCase):
    def test_reasoning_menu_contains_xhigh_and_max_as_model_properties(self) -> None:
        console = Mock()
        with patch.object(models, "select_value", return_value="max") as select:
            selected = models._select_reasoning(
                console,
                current=AgentReasoningEffort.HIGH,
            )

        self.assertIs(selected, AgentReasoningEffort.MAX)
        options = select.call_args.args[1]
        values = [item.value for item in options]
        self.assertIn("xhigh", values)
        self.assertIn("max", values)
        self.assertTrue(all(" " not in item.label for item in options))

    def test_model_catalog_is_read_automatically_before_manual_fallback(self) -> None:
        console = Mock()
        catalog = AgentModelCatalog(
            models=(AgentModelSummary(model="gpt-fixture"),),
        )
        with (
            patch.object(models, "fetch_agent_models", return_value=catalog) as fetch,
            patch.object(models, "select_value", return_value="gpt-fixture"),
            patch.object(models, "ask_text") as manual,
        ):
            selected = models._fetch_model(_provider(), api_key="secret", console=console)

        self.assertEqual(selected, AgentModelSummary(model="gpt-fixture"))
        fetch.assert_called_once_with(
            provider_name="openai",
            api=AgentProtocol.OPENAI_RESPONSES,
            base_url="https://api.openai.com/v1",
            api_key="secret",
        )
        manual.assert_not_called()

    def test_add_model_publishes_provider_model_and_exact_origin_key_together(self) -> None:
        console = Mock()
        provider = _provider()
        before = Configuration()
        with (
            patch.object(models, "load_editable_user_configuration", return_value=before),
            patch.object(models, "_choose_provider", return_value="new"),
            patch.object(models, "_create_provider", return_value=provider),
            patch.object(models, "_provider_key", return_value=("secret", True, True)),
            patch.object(
                models,
                "_fetch_model",
                return_value=AgentModelSummary(model="gpt-fixture"),
            ),
            patch.object(
                models,
                "_select_reasoning",
                return_value=AgentReasoningEffort.MAX,
            ),
            patch.object(models, "ask_boolean", side_effect=(True, False)) as ask_boolean,
            patch.object(models, "confirm_changes", return_value=True),
            patch.object(models, "update_model_provider_configuration") as update,
        ):
            models._add_model(console)

        saved = update.call_args.kwargs
        self.assertEqual(saved["provider"], "openai")
        self.assertEqual(saved["secret"], "secret")
        self.assertEqual(saved["origin"], "https://api.openai.com")
        self.assertEqual([item.name for item in saved["providers"].values], ["openai"])
        model = saved["models"].values[0]
        self.assertEqual(model.reference, "openai/gpt-fixture")
        self.assertIs(model.reasoning, AgentReasoningEffort.MAX)
        self.assertTrue(model.image)
        self.assertFalse(model.stream)
        self.assertEqual(
            [(call.args[0], call.kwargs["default"]) for call in ask_boolean.call_args_list],
            [("Image", False), ("Stream", True)],
        )

    def test_models_and_provider_pages_use_owner_scoped_single_word_actions(self) -> None:
        configuration = Configuration.model_validate(
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
                            "reference": "openai/gpt-fixture",
                            "reasoning": "max",
                            "image": True,
                        }
                    ]
                },
            }
        )
        console = Mock()
        credentials = Mock()
        credentials.model_secret_for_origin.return_value = "configured"
        with (
            patch.object(models, "load_editable_user_configuration", return_value=configuration),
            patch.object(models, "load_credentials", return_value=credentials),
            patch.object(models, "select_value", return_value="back") as select,
        ):
            models.manage_models(console)
            model_options = select.call_args.args[1]
            models._manage_model("openai/gpt-fixture", console)
            model_actions = select.call_args.args[1]
            models._manage_provider("openai", console)
            provider_options = select.call_args.args[1]

        self.assertEqual(
            [item.label for item in model_options],
            ["Add", "openai/gpt-fixture", "Providers", "Back"],
        )
        self.assertEqual(
            [item.label for item in model_actions],
            ["Edit", "Test", "Remove", "Back"],
        )
        self.assertEqual(
            [item.label for item in provider_options],
            ["Edit", "Key", "Test", "Remove", "Back"],
        )
        self.assertIs(model_actions[1].kind, ConfigActionKind.TEST)
        self.assertIs(provider_options[2].kind, ConfigActionKind.TEST)
        self.assertIs(provider_options[3].kind, ConfigActionKind.DANGER)
        self.assertIs(provider_options[4].kind, ConfigActionKind.NAVIGATE)

    def test_edit_model_can_disable_stream_without_changing_provider(self) -> None:
        configuration = Configuration.model_validate(
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
                            "reference": "openai/gpt-fixture",
                            "reasoning": "high",
                            "image": True,
                        }
                    ]
                },
            }
        )
        console = Mock()
        with (
            patch.object(
                models,
                "load_editable_user_configuration",
                return_value=configuration,
            ),
            patch.object(
                models,
                "_select_reasoning",
                return_value=AgentReasoningEffort.HIGH,
            ),
            patch.object(models, "ask_boolean", side_effect=(True, False)) as ask_boolean,
            patch.object(models, "confirm_changes", return_value=True),
            patch.object(models, "update_configuration_sections") as update,
        ):
            models._edit_model("openai/gpt-fixture", console)

        replacement = update.call_args.kwargs["models"].values[0]
        self.assertFalse(replacement.stream)
        self.assertEqual(replacement.provider, "openai")
        self.assertEqual(
            [(call.args[0], call.kwargs["default"]) for call in ask_boolean.call_args_list],
            [("Image", True), ("Stream", True)],
        )

    def test_model_test_selects_text_or_image_without_changing_task_bindings(self) -> None:
        console = Mock()
        with (
            patch.object(models, "select_value", return_value="image") as select,
            patch.object(models, "run_interactive_test") as run,
        ):
            models._test_model("openai/gpt-fixture", image=True, console=console)

        self.assertEqual(
            [item.label for item in select.call_args.args[1]],
            ["Text", "Image", "Back"],
        )
        request = run.call_args.args[0]
        self.assertEqual((request.owner, request.target), ("model", "openai/gpt-fixture"))
        self.assertTrue(request.image_input)

    def test_provider_test_uses_the_shared_owner_scoped_probe(self) -> None:
        configuration = Configuration.model_validate(
            {
                "providers": {
                    "values": [
                        {
                            "name": "openai",
                            "api": "openai-responses",
                            "base_url": "https://api.openai.com/v1",
                        }
                    ]
                }
            }
        )
        console = Mock()
        with (
            patch.object(models, "load_editable_user_configuration", return_value=configuration),
            patch.object(models, "run_interactive_test") as run,
        ):
            models._test_provider("openai", console)

        request = run.call_args.args[0]
        self.assertEqual((request.owner, request.target), ("provider", "openai"))


if __name__ == "__main__":
    unittest.main()
