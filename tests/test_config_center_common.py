from __future__ import annotations

import io
import unittest
from contextlib import redirect_stderr
from unittest.mock import Mock, patch

from sciretriever.entry.cli.config_center import common
from sciretriever.entry.cli.config_ui import ConfigActionKind
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
