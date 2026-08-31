"""Direct contracts for deterministic Source selection configuration."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from sciretriever.configuration import (
    AUTO_ACQUISITION_SOURCE_PROVIDERS,
    AUTO_METADATA_SOURCE_PROVIDERS,
    ConfigurationError,
    acquisition_source_providers,
    metadata_source_providers,
    parse_configuration,
    update_configuration_sections,
)
from sciretriever.model.configuration import ProviderName, SourceMode


class SourceSelectionConfigurationTests(unittest.TestCase):
    def test_empty_configuration_uses_the_versioned_auto_catalog_and_default_limit(
        self,
    ) -> None:
        configuration = parse_configuration("")

        self.assertIs(configuration.sources.metadata.mode, SourceMode.AUTO)
        self.assertEqual(configuration.sources.metadata.providers, ())
        self.assertEqual(configuration.sources.metadata.limit, 500)
        self.assertEqual(
            metadata_source_providers(configuration),
            AUTO_METADATA_SOURCE_PROVIDERS,
        )
        self.assertEqual(
            AUTO_METADATA_SOURCE_PROVIDERS,
            (
                ProviderName.CROSSREF,
                ProviderName.SEMANTIC_SCHOLAR,
                ProviderName.ARXIV,
                ProviderName.OPENALEX,
                ProviderName.EUROPE_PMC,
                ProviderName.DATACITE,
                ProviderName.CORE,
                ProviderName.OPENCITATIONS,
            ),
        )
        self.assertIs(configuration.sources.acquisition.mode, SourceMode.AUTO)
        self.assertEqual(configuration.sources.acquisition.providers, ())
        self.assertEqual(
            acquisition_source_providers(configuration),
            AUTO_ACQUISITION_SOURCE_PROVIDERS,
        )
        self.assertEqual(
            AUTO_ACQUISITION_SOURCE_PROVIDERS,
            (ProviderName.ARXIV, ProviderName.EUROPE_PMC),
        )
        self.assertNotIn(ProviderName.SCI_HUB, AUTO_ACQUISITION_SOURCE_PROVIDERS)

    def test_auto_rejects_a_fixed_provider_list(self) -> None:
        payloads = (
            """
            [sources.metadata]
            mode = "auto"
            providers = ["crossref"]
            """,
            """
            [sources.acquisition]
            mode = "auto"
            providers = ["arxiv"]
            """,
        )

        for payload in payloads:
            with self.subTest(payload=payload), self.assertRaises(ConfigurationError):
                parse_configuration(payload)

    def test_custom_preserves_the_exact_order_and_allows_an_empty_list(self) -> None:
        selected = parse_configuration(
            """
            [sources.metadata]
            mode = "custom"
            providers = ["openalex", "crossref", "arxiv"]

            [sources.acquisition]
            mode = "custom"
            providers = ["europe-pmc", "arxiv"]
            """
        )
        disabled = parse_configuration(
            """
            [sources.metadata]
            mode = "custom"
            providers = []

            [sources.acquisition]
            mode = "custom"
            providers = []
            """
        )

        self.assertEqual(
            metadata_source_providers(selected),
            (ProviderName.OPENALEX, ProviderName.CROSSREF, ProviderName.ARXIV),
        )
        self.assertEqual(
            acquisition_source_providers(selected),
            (ProviderName.EUROPE_PMC, ProviderName.ARXIV),
        )
        self.assertEqual(metadata_source_providers(disabled), ())
        self.assertEqual(acquisition_source_providers(disabled), ())

    def test_metadata_limit_is_one_positive_integer_applied_to_the_selection(self) -> None:
        selected = parse_configuration(
            """
            [sources.metadata]
            mode = "custom"
            providers = ["crossref", "arxiv"]
            limit = 37
            """
        )
        self.assertEqual(selected.sources.metadata.limit, 37)

        for value in ("0", "-1", "1.5", '"10"', "true"):
            with self.subTest(value=value), self.assertRaises(ConfigurationError):
                parse_configuration(f"[sources.metadata]\nlimit = {value}\n")

    def test_legacy_discovery_section_is_unknown(self) -> None:
        with self.assertRaises(ConfigurationError):
            parse_configuration("[discovery]\nmetadata_scan_limit = 500\n")

    def test_current_source_schema_round_trips_through_the_fixed_file_store(self) -> None:
        selected = parse_configuration(
            """
            [sources.metadata]
            mode = "custom"
            providers = ["arxiv", "crossref"]
            limit = 41

            [sources.acquisition]
            mode = "custom"
            providers = ["europe-pmc"]
            """
        )

        with tempfile.TemporaryDirectory(prefix="sciretriever-source-selection-") as temporary:
            home = Path(temporary)
            reloaded = update_configuration_sections(sources=selected.sources, home=home)
            rendered = (home / ".sciretriever" / "config.toml").read_text(encoding="utf-8")

        self.assertEqual(reloaded.sources, selected.sources)
        self.assertIn('mode = "custom"', rendered)
        self.assertIn("limit = 41", rendered)
        self.assertNotIn("[discovery]", rendered)


if __name__ == "__main__":
    unittest.main()
