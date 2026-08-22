from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from sciretriever.network.browser_runtime import (
    BrowserRuntimeBoundaryError,
    configure_pdf_download_preference,
)


class BrowserRuntimePreferenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="sciretriever-browser-runtime-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        os.chmod(self.directory, 0o700)

    def _preferences(self) -> Path:
        return self.directory / "Default" / "Preferences"

    def test_missing_preferences_get_only_the_controlled_pdf_keys(self) -> None:
        configure_pdf_download_preference(self.directory)

        self.assertEqual(
            json.loads(self._preferences().read_text(encoding="utf-8")),
            {
                "plugins": {
                    "always_open_pdf_externally": True,
                    "open_pdf_in_system_reader": False,
                }
            },
        )
        self.assertEqual(self._preferences().stat().st_mode & 0o777, 0o600)

    def test_existing_preferences_are_atomically_merged_and_other_fields_survive(self) -> None:
        default = self.directory / "Default"
        default.mkdir(mode=0o700)
        preferences = default / "Preferences"
        preferences.write_text(
            json.dumps(
                {
                    "intl": {
                        "selected_languages": "en-US,en,zh-CN,zh,ja,ko",
                        "accept_languages": "en-US,en,zh-CN,zh,ja,ko",
                    },
                    "plugins": {"custom_pdf_handler": "fixture"},
                    "profile": {"name": "long-lived"},
                },
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        os.chmod(preferences, 0o600)

        configure_pdf_download_preference(self.directory)
        merged = json.loads(preferences.read_text(encoding="utf-8"))
        self.assertEqual(
            merged["intl"],
            {
                "selected_languages": "en-US,en,zh-CN,zh,ja,ko",
                "accept_languages": "en-US,en,zh-CN,zh,ja,ko",
            },
        )
        self.assertEqual(merged["profile"], {"name": "long-lived"})
        self.assertEqual(
            merged["plugins"],
            {
                "always_open_pdf_externally": True,
                "custom_pdf_handler": "fixture",
                "open_pdf_in_system_reader": False,
            },
        )

        before = preferences.read_bytes()
        configure_pdf_download_preference(self.directory)
        self.assertEqual(preferences.read_bytes(), before)

    def test_conflicting_pdf_policy_fails_closed_without_overwrite(self) -> None:
        default = self.directory / "Default"
        default.mkdir(mode=0o700)
        preferences = default / "Preferences"
        preferences.write_text(
            json.dumps({"plugins": {"always_open_pdf_externally": False}, "sentinel": "keep"}),
            encoding="utf-8",
        )
        os.chmod(preferences, 0o600)
        before = preferences.read_bytes()

        with self.assertRaises(BrowserRuntimeBoundaryError):
            configure_pdf_download_preference(self.directory)

        self.assertEqual(preferences.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
