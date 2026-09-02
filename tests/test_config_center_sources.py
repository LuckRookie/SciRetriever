from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from sciretriever.entry.cli.config_center import sources
from sciretriever.entry.cli.config_ui import ConfigActionKind
from sciretriever.model.configuration import Configuration, ProviderName, SourceMode


class SourcePageTests(unittest.TestCase):
    def test_area_menus_keep_source_owned_settings_and_browser_separate(self) -> None:
        console = Mock()
        configuration = Configuration()
        with (
            patch.object(sources, "load_editable_user_configuration", return_value=configuration),
            patch.object(sources, "metadata_source_providers", return_value=()),
            patch.object(sources, "acquisition_source_providers", return_value=()),
            patch.object(sources, "select_value", return_value="back") as select,
        ):
            sources.manage_search(console)
            search_options = select.call_args.args[1]
            sources.manage_download(console)
            download_options = select.call_args.args[1]

        self.assertEqual(
            [item.label for item in search_options],
            ["Sources", "Limit", "Test", "Back"],
        )
        self.assertEqual(
            [item.label for item in download_options],
            ["Sources", "Test", "Back"],
        )
        self.assertTrue(all(" " not in item.label for item in (*search_options, *download_options)))
        self.assertIs(search_options[-1].kind, ConfigActionKind.NAVIGATE)
        self.assertIs(download_options[-1].kind, ConfigActionKind.NAVIGATE)
        download_description = console.page.call_args_list[-1].args[1]
        self.assertIn("separate Browser area", download_description)

    def test_source_object_owns_setup_key_test_and_enablement(self) -> None:
        actions = sources._source_actions(
            "search",
            ProviderName.CROSSREF,
            configurable_keys=frozenset({ProviderName.CROSSREF}),
            enabled=True,
            mode=SourceMode.CUSTOM,
        )

        disabled_download = sources._source_actions(
            "download",
            ProviderName.CROSSREF,
            configurable_keys=frozenset(),
            enabled=False,
            mode=SourceMode.CUSTOM,
        )
        self.assertEqual(
            [item.label for item in disabled_download],
            ["Test", "Enable", "Back"],
        )
        self.assertEqual(
            [item.label for item in actions],
            ["Setup", "Key", "Test", "Disable", "Back"],
        )
        self.assertEqual(
            [item.kind for item in actions],
            [
                ConfigActionKind.CONFIGURE,
                ConfigActionKind.CONFIGURE,
                ConfigActionKind.TEST,
                ConfigActionKind.DANGER,
                ConfigActionKind.NAVIGATE,
            ],
        )

    def test_area_test_can_run_all_or_choose_an_enabled_or_disabled_source(self) -> None:
        console = Mock()
        with (
            patch.object(sources, "select_value", return_value="all"),
            patch.object(sources, "run_interactive_test") as run,
        ):
            sources._manage_source_tests("search", console)

        request = run.call_args.args[0]
        self.assertEqual(
            (request.owner, request.target, request.all_targets),
            ("search", None, True),
        )

        with (
            patch.object(
                sources,
                "select_value",
                side_effect=("source", ProviderName.CROSSREF.value),
            ),
            patch.object(sources, "run_interactive_test") as run,
        ):
            sources._manage_source_tests("download", console)

        request = run.call_args.args[0]
        self.assertEqual(
            (request.owner, request.target, request.all_targets),
            ("download", "crossref", False),
        )

    def test_source_menu_describes_purpose_activity_and_capability_key_contract(self) -> None:
        console = Mock()
        configuration = Configuration()
        credentials = Mock()
        credentials.has_provider.return_value = False
        credentials.field_names.return_value = ()
        with (
            patch.object(
                sources,
                "load_editable_user_configuration",
                return_value=configuration,
            ),
            patch.object(
                sources,
                "metadata_source_providers",
                return_value=(ProviderName.CROSSREF, ProviderName.CORE),
            ),
            patch.object(sources, "load_credentials", return_value=credentials),
            patch.object(sources, "select_value", return_value="back") as select,
        ):
            sources._manage_sources("search", console)

        options = {item.label: item for item in select.call_args.args[1]}
        self.assertIn("Freeze 2 active Sources", options["Custom"].description)
        self.assertEqual(
            options["crossref"].description,
            "Active · No API key · DOI metadata discovery through the public or polite pool",
        )
        self.assertIn("CORE API metadata", options["core"].description)
        self.assertIn("API key optional · not configured", options["core"].description)
        self.assertEqual(options["Back"].description, "Return to Search")
        self.assertEqual(
            sources._source_credential_description(
                "download",
                ProviderName.CORE,
                credentials,
            ),
            "API key required · missing",
        )

    def test_custom_freezes_effective_sources_and_auto_clears_explicit_list(self) -> None:
        console = Mock()
        automatic = Configuration()
        frozen = Configuration.model_validate(
            {
                "sources": {
                    "metadata": {
                        "mode": "custom",
                        "providers": ["semantic-scholar", "crossref"],
                    }
                }
            }
        )
        with (
            patch.object(sources, "load_editable_user_configuration", return_value=automatic),
            patch.object(
                sources,
                "metadata_source_providers",
                return_value=(ProviderName.SEMANTIC_SCHOLAR, ProviderName.CROSSREF),
            ),
            patch.object(sources, "confirm_changes", return_value=True),
            patch.object(sources, "update_configuration_sections") as update,
        ):
            sources._set_source_mode("search", SourceMode.CUSTOM, console)

        custom = update.call_args.kwargs["sources"].metadata
        self.assertIs(custom.mode, SourceMode.CUSTOM)
        self.assertEqual(
            custom.providers,
            (ProviderName.SEMANTIC_SCHOLAR, ProviderName.CROSSREF),
        )

        with (
            patch.object(sources, "load_editable_user_configuration", return_value=frozen),
            patch.object(sources, "confirm_changes", return_value=True),
            patch.object(sources, "update_configuration_sections") as update,
        ):
            sources._set_source_mode("search", SourceMode.AUTO, console)

        automatic_again = update.call_args.kwargs["sources"].metadata
        self.assertIs(automatic_again.mode, SourceMode.AUTO)
        self.assertEqual(automatic_again.providers, ())

    def test_limit_is_per_source_and_reports_the_current_aggregate_ceiling(self) -> None:
        console = Mock()
        before = Configuration.model_validate(
            {"sources": {"metadata": {"mode": "custom", "providers": ["crossref"]}}}
        )
        with (
            patch.object(sources, "load_editable_user_configuration", return_value=before),
            patch.object(sources, "ask_text", return_value="250"),
            patch.object(
                sources,
                "metadata_source_providers",
                return_value=(
                    ProviderName.CROSSREF,
                    ProviderName.SEMANTIC_SCHOLAR,
                    ProviderName.OPENALEX,
                ),
            ),
            patch.object(sources, "confirm_changes", return_value=True),
            patch.object(sources, "update_configuration_sections") as update,
        ):
            sources._set_metadata_source_limit(console)

        self.assertEqual(update.call_args.kwargs["sources"].metadata.limit, 250)
        messages = "\n".join(call.args[0] for call in console.message.call_args_list)
        self.assertIn("Each Search Source may scan 250 raw items", messages)
        self.assertIn("750 across 3 Sources", messages)

    def test_sci_hub_mirrors_are_scoped_explained_and_do_not_enable_source(self) -> None:
        console = Mock()
        with patch.object(sources, "select_value", return_value="back") as select:
            result = sources._edit_sci_hub_urls(None, console)

        self.assertIsNone(result)
        self.assertEqual(
            [item.label for item in select.call_args.args[1]],
            [
                "Add",
                "Remove",
                "Save",
                "Reset",
                "Back",
            ],
        )
        page = console.page.call_args
        self.assertEqual(page.args[0], "Source · sci-hub · Mirrors")
        self.assertIn("built-in list", page.args[1])
        self.assertIn("does not enable Sci-Hub", " ".join(page.kwargs["notes"]))


if __name__ == "__main__":
    unittest.main()
