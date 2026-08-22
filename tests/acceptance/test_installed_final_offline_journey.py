from __future__ import annotations

import re
import unittest
from pathlib import Path

from tests.acceptance.helpers.installed_wheel import InstalledWheel

_UNITTEST_SUMMARY = re.compile(rb"Ran [1-9][0-9]* tests? in [0-9.]+s")


class InstalledFinalOfflineJourneyTests(unittest.TestCase):
    """Run final Browser and tiered contracts only against an installed wheel."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = InstalledWheel()
        cls.install = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fixture.__exit__(None, None, None)

    def test_tiered_browser_agent_and_challenge_contracts_use_installed_product(
        self,
    ) -> None:
        repository_tests = Path(__file__).resolve().parents[1]
        drivers = (
            repository_tests / "test_tiered_acquisition_service.py",
            repository_tests / "test_browser_agent_integration.py",
            repository_tests / "test_browser_challenge_lifecycle.py",
        )

        for driver in drivers:
            with self.subTest(driver=driver.name):
                result = self.install.run_driver(driver, timeout=120)
                self.assertEqual(result.returncode, 0, result.stderr_text)
                self.assertEqual(result.stdout, b"")
                self.assertRegex(result.stderr, _UNITTEST_SUMMARY)
                self.assertIn(b"\nOK\n", result.stderr)
                self.assertNotIn(b"Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
