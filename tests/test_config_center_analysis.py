from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from sciretriever.entry.cli.config_center import analysis
from sciretriever.entry.cli.config_ui import ConfigActionKind
from sciretriever.model.configuration import AgentReasoningEffort, Configuration


def _configured_model() -> Configuration:
    return Configuration.model_validate(
        {
            "providers": {
                "values": [
                    {
                        "name": "deepseek",
                        "api": "openai-chat-completions",
                        "base_url": "https://api.deepseek.com/v1",
                    }
                ]
            },
            "models": {
                "values": [
                    {
                        "reference": "deepseek/deepseek-reasoner",
                        "reasoning": "max",
                        "image": False,
                    }
                ]
            },
        }
    )


class AnalyzePageTests(unittest.TestCase):
    def test_setup_selects_model_and_limits_without_overriding_model_reasoning(self) -> None:
        before = _configured_model()
        model = before.models.values[0]
        console = Mock()
        budgets = dict(analysis._BUDGET_PRESETS["balanced"])
        with (
            patch.object(analysis, "load_editable_user_configuration", return_value=before),
            patch.object(analysis, "choose_model", return_value=model),
            patch.object(analysis, "_choose_budgets", return_value=budgets),
            patch.object(analysis, "confirm_changes", return_value=True),
            patch.object(analysis, "update_configuration_sections") as update,
        ):
            analysis._setup(console)

        selected = update.call_args.kwargs["analysis"]
        self.assertEqual(selected.model, "deepseek/deepseek-reasoner")
        self.assertEqual(selected.max_total_output_tokens, 32_768)
        self.assertIs(model.reasoning, AgentReasoningEffort.MAX)
        facts = dict(console.page.call_args.kwargs["facts"])
        self.assertEqual(facts["Reasoning"], "max")

    def test_analyze_page_has_one_setup_for_model_and_limits(self) -> None:
        console = Mock()
        with (
            patch.object(
                analysis,
                "load_editable_user_configuration",
                return_value=_configured_model(),
            ),
            patch.object(analysis, "select_value", return_value="back") as select,
        ):
            analysis.manage_analyze(console)

        options = select.call_args.args[1]
        self.assertEqual([item.label for item in options], ["Setup", "Test", "Reset", "Back"])
        self.assertIs(options[1].kind, ConfigActionKind.TEST)
        self.assertIs(options[2].kind, ConfigActionKind.DANGER)
        self.assertIs(options[3].kind, ConfigActionKind.NAVIGATE)
        description = console.page.call_args.args[1]
        self.assertIn("Provider connection, key, reasoning", description)

    def test_analyze_test_uses_the_shared_owner_scoped_probe(self) -> None:
        console = Mock()
        with (
            patch.object(
                analysis,
                "load_editable_user_configuration",
                side_effect=(_configured_model(), _configured_model()),
            ),
            patch.object(analysis, "select_value", side_effect=("test", "back")),
            patch.object(analysis, "run_interactive_test") as run,
        ):
            analysis.manage_analyze(console)

        self.assertEqual(run.call_args.args[0].owner, "analyze")


if __name__ == "__main__":
    unittest.main()
