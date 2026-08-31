from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from sciretriever.entry.cli.config_center import parsing
from sciretriever.entry.cli.config_ui import ConfigActionKind
from sciretriever.model.configuration import Configuration, ParserConnectionMode


class ParsePageTests(unittest.TestCase):
    def test_loopback_setup_needs_neither_upload_consent_nor_token(self) -> None:
        console = Mock()
        with (
            patch.object(parsing, "load_editable_user_configuration", return_value=Configuration()),
            patch.object(parsing, "select_value", return_value="loopback"),
            patch.object(
                parsing,
                "ask_text",
                side_effect=("http://127.0.0.1:8000", "mineru-3.4.4-vlm"),
            ),
            patch.object(parsing, "confirm_changes", return_value=True),
            patch.object(parsing, "confirm") as confirm,
            patch.object(parsing, "_read_token") as read_token,
            patch.object(parsing, "update_core_service_configuration") as update,
        ):
            parsing._setup(console)

        configured = update.call_args.kwargs
        self.assertIs(configured["parsing"].connection_mode, ParserConnectionMode.LOOPBACK)
        self.assertFalse(configured["parsing"].remote_upload_authorized)
        self.assertIsNone(configured["secret"])
        self.assertIsNone(configured["origin"])
        confirm.assert_not_called()
        read_token.assert_not_called()

    def test_remote_setup_publishes_upload_authorization_and_origin_key_atomically(self) -> None:
        console = Mock()
        with (
            patch.object(parsing, "load_editable_user_configuration", return_value=Configuration()),
            patch.object(parsing, "select_value", return_value="remote"),
            patch.object(
                parsing,
                "ask_text",
                side_effect=("https://mineru.example.invalid/v1", "mineru-3.4.4-vlm"),
            ),
            patch.object(
                parsing,
                "_remote_credentials",
                return_value=("secret", "https://mineru.example.invalid"),
            ),
            patch.object(parsing, "confirm_changes", return_value=True),
            patch.object(parsing, "update_core_service_configuration") as update,
        ):
            parsing._setup(console)

        configured = update.call_args.kwargs
        self.assertIs(configured["parsing"].connection_mode, ParserConnectionMode.REMOTE)
        self.assertTrue(configured["parsing"].remote_upload_authorized)
        self.assertEqual(configured["secret"], "secret")
        self.assertEqual(configured["origin"], "https://mineru.example.invalid")

    def test_remote_key_is_resolved_for_the_exact_configured_origin(self) -> None:
        console = Mock()
        credentials = Mock()
        credentials.core_secret_for_origin.return_value = "saved-secret"
        with (
            patch.object(parsing, "confirm", return_value=True),
            patch.object(parsing, "load_credentials", return_value=credentials),
            patch.object(parsing, "select_value", return_value="keep"),
            patch.object(parsing, "_read_token") as read_token,
        ):
            result = parsing._remote_credentials(
                "https://mineru.example.invalid/v1",
                console,
            )

        self.assertEqual(result, ("saved-secret", "https://mineru.example.invalid"))
        credentials.core_secret_for_origin.assert_called_once()
        self.assertEqual(
            credentials.core_secret_for_origin.call_args.args[1],
            "https://mineru.example.invalid",
        )
        read_token.assert_not_called()

    def test_parse_page_is_setup_test_reset_back_with_explicit_probe_notice(self) -> None:
        console = Mock()
        with (
            patch.object(parsing, "load_editable_user_configuration", return_value=Configuration()),
            patch.object(parsing, "_key_state", return_value="not required"),
            patch.object(parsing, "select_value", return_value="back") as select,
        ):
            parsing.manage_parse(console)

        options = select.call_args.args[1]
        self.assertEqual([item.label for item in options], ["Setup", "Test", "Reset", "Back"])
        self.assertIs(options[1].kind, ConfigActionKind.TEST)
        self.assertIs(options[2].kind, ConfigActionKind.DANGER)
        self.assertIs(options[3].kind, ConfigActionKind.NAVIGATE)
        self.assertIn("never uploads a PDF", console.page.call_args.kwargs["notes"][0])


if __name__ == "__main__":
    unittest.main()
