from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from sciretriever.entry.cli.config_center import source_credentials
from sciretriever.entry.cli.config_ui import ConfigActionKind
from sciretriever.model.configuration import CredentialFieldSpec, ProviderName


class SourceCredentialTests(unittest.TestCase):
    def test_key_page_is_owned_by_source_and_never_implies_enablement(self) -> None:
        console = Mock()
        with (
            patch.object(source_credentials, "credential_state", return_value="not configured"),
            patch.object(source_credentials, "select_value", return_value="back") as select,
        ):
            source_credentials.manage_source_key(ProviderName.SEMANTIC_SCHOLAR, console)

        options = select.call_args.args[1]
        self.assertEqual([item.label for item in options], ["Set", "Remove", "Back"])
        self.assertIs(options[1].kind, ConfigActionKind.DANGER)
        self.assertIs(options[2].kind, ConfigActionKind.NAVIGATE)
        self.assertIn("Saving a key never enables", console.page.call_args.args[1])

    def test_key_save_writes_only_source_credentials_and_never_renders_secret(self) -> None:
        console = Mock()
        sentinel = "source-key-secret-sentinel"
        with (
            patch.object(
                source_credentials,
                "credential_field_specs",
                return_value=(CredentialFieldSpec(name="api_key", required=True),),
            ),
            patch.object(source_credentials, "credential_section_exists", return_value=False),
            patch.object(source_credentials, "_read_field", return_value=sentinel),
            patch.object(source_credentials, "set_credentials") as save,
        ):
            source_credentials._set(ProviderName.SEMANTIC_SCHOLAR, console)

        save.assert_called_once_with(
            "semantic-scholar",
            {"api_key": sentinel},
            home=None,
        )
        rendered_arguments = repr(console.mock_calls)
        self.assertNotIn(sentinel, rendered_arguments)


if __name__ == "__main__":
    unittest.main()
