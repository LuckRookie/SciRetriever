from __future__ import annotations

import io
import unittest
from contextlib import redirect_stderr
from unittest.mock import Mock, patch

from sciretriever.entry.cli.config_center import common
from sciretriever.entry.cli.config_ui import ConfigActionKind, ConfigTheme, TerminalChoice
from sciretriever.model.configuration import Configuration


class ConfigurationInteractionTests(unittest.TestCase):
    def test_plain_selection_renders_semantic_markers_and_returns_the_selected_value(self) -> None:
        console = Mock()
        options = [
            common.option("setup", "Setup"),
            common.option("test", "Test", kind=ConfigActionKind.TEST),
            common.option("back", "Back", kind=ConfigActionKind.NAVIGATE),
        ]
        with (
            patch.object(common, "interactive_terminal", return_value=False),
            patch.object(common, "read_line", return_value="2"),
            redirect_stderr(io.StringIO()) as output,
        ):
            selected = common.select_value("Action", options, console=console)

        self.assertEqual(selected, "test")
        rendered = output.getvalue()
        self.assertIn("◆ Setup", rendered)
        self.assertIn("▶ Test", rendered)
        self.assertIn("← Back", rendered)

    def test_rich_selection_appends_quit_without_replacing_explicit_back(self) -> None:
        def select_quit(choice: TerminalChoice[object]) -> object:
            return choice.options[-1].value

        console = Mock()
        console.palette.name = ConfigTheme.MONO
        options = [
            common.option("setup", "Setup"),
            common.option("back", "Back", kind=ConfigActionKind.NAVIGATE),
        ]
        with (
            patch.object(common, "interactive_terminal", return_value=True),
            patch.object(
                TerminalChoice,
                "prompt",
                autospec=True,
                side_effect=select_quit,
            ) as prompt,
            self.assertRaises(common.ConfigurationCenterQuit),
        ):
            common.select_value("Action", options, console=console)

        choice = prompt.call_args.args[0]
        captured_options = choice.options
        self.assertEqual([item.label for item in captured_options], ["Setup", "Back", "Quit"])
        self.assertEqual([item.marker for item in captured_options[-2:]], ["←", "×"])
        self.assertEqual(
            choice.shortcuts,
            {"q": captured_options[-1].value},
        )

    def test_plain_selection_distinguishes_back_from_quit(self) -> None:
        options = [
            common.option("setup", "Setup"),
            common.option("back", "Back", kind=ConfigActionKind.NAVIGATE),
        ]
        with (
            patch.object(common, "interactive_terminal", return_value=False),
            patch.object(common, "read_line", return_value="back") as read_line,
            redirect_stderr(io.StringIO()) as output,
        ):
            selected = common.select_value("Action", options, console=Mock())

        self.assertIsNone(selected)
        self.assertIn("× Quit", output.getvalue())
        self.assertIn("b to back, q to quit", read_line.call_args.args[0])

        with (
            patch.object(common, "interactive_terminal", return_value=False),
            patch.object(common, "read_line", return_value="quit"),
            redirect_stderr(io.StringIO()),
            self.assertRaises(common.ConfigurationCenterQuit),
        ):
            common.select_value("Action", options, console=Mock())

    def test_confirm_changes_resolves_the_confirmation_function_at_call_time(self) -> None:
        console = Mock()
        configuration = Configuration()
        with (
            patch.object(
                common,
                "configuration_diff",
                return_value=(("sources.metadata.limit", 500, 250),),
            ),
            patch.object(common, "confirm", return_value=True) as confirm,
        ):
            accepted = common.confirm_changes(
                console,
                configuration,
                configuration,
                section="sources",
            )

        self.assertTrue(accepted)
        confirm.assert_called_once_with("Save these ordinary configuration changes? [y/N] ")


if __name__ == "__main__":
    unittest.main()
