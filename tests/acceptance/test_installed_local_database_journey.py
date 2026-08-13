from __future__ import annotations

import json
import unittest
from pathlib import Path

from tests.acceptance.helpers.installed_wheel import InstalledWheel


class InstalledLocalDatabaseJourneyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = InstalledWheel()
        cls.install = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fixture.__exit__(None, None, None)

    def test_empty_catalog_search_uses_the_production_console_without_any_external_secret(
        self,
    ) -> None:
        """Local-only commands must not require an unrelated external capability."""

        driver = Path(__file__).parent / "helpers" / "probe_local_console.py"
        result = self.install.run_driver(driver)
        self.assertEqual(result.returncode, 0, result.stderr_text)
        self.assertEqual(result.stderr, b"")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["returncode"], 0, payload["stderr"])
        self.assertEqual(payload["stderr"], "")
        self.assertEqual(
            json.loads(payload["stdout"]),
            {"items": [], "next_cursor": None, "total_count": 0},
        )
        self.assertTrue(payload["catalog_exists"])
        self.assertTrue(payload["artifacts_exists"])


if __name__ == "__main__":
    unittest.main()
