from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from tests.acceptance.helpers.installed_wheel import InstalledWheel


class InstalledPlaywrightBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = InstalledWheel()
        cls.install = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fixture.__exit__(None, None, None)

    def test_real_chromium_runs_javascript_download_through_controlled_https(
        self,
    ) -> None:
        driver = Path(__file__).parent / "helpers" / "drive_playwright_browser.py"
        fresh_site_packages = os.fspath(self.install.site_packages)
        browser_cache = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
        if browser_cache is None:
            browser_cache = os.fspath(Path.home() / ".cache" / "ms-playwright")
        result = self.install.run_driver(
            driver,
            environment={"PLAYWRIGHT_BROWSERS_PATH": browser_cache},
            timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr_text)
        self.assertEqual(result.stderr, b"")
        payload = json.loads(result.stdout)

        for module_file in payload["product_module_files"].values():
            self.assertTrue(module_file.startswith(fresh_site_packages + os.sep), module_file)
        self.assertTrue(
            payload["playwright_module_file"].startswith(fresh_site_packages + os.sep),
            payload["playwright_module_file"],
        )
        self.assertTrue(payload["runtime"]["python_dependency_available"])
        self.assertTrue(payload["runtime"]["chromium_executable_available"])

        network = payload["network"]
        self.assertTrue(network["resolver_only_returned_loopback"])
        self.assertEqual(network["authorities"], [network["authority"]] * 3)
        self.assertEqual(
            network["paths"],
            ["/article", "/article.pdf", "/article.pdf"],
        )
        self.assertTrue(network["cookie_pair_preserved"])

        expected_sha256 = payload["verification"]["expected_pdf_sha256"]
        self.assertEqual(payload["verification"]["delivered_pdf_sha256"], [expected_sha256] * 2)
        self.assertLess(payload["verification"]["direct_pdf_elapsed_seconds"], 5.0)

        session = payload["session"]
        self.assertEqual(session["article_count"], 2)
        self.assertTrue(session["one_process_and_context_reused"])
        self.assertTrue(session["article_pages_closed"])

        cleanup = payload["cleanup"]
        self.assertFalse(cleanup["temporary_root_exists"])
        self.assertFalse(cleanup["server_thread_alive"])
        self.assertEqual(cleanup["playwright_threads_alive"], [])

        production = payload["production_boundary"]
        self.assertEqual(production["catalog_rule_count"], 1)
        self.assertTrue(production["ready"])
        self.assertIsNone(production["readiness_code"])


if __name__ == "__main__":
    unittest.main()
