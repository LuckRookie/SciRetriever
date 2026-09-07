from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from tests.acceptance.helpers.installed_wheel import InstalledWheel


class InstalledCloakBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = InstalledWheel()
        cls.install = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fixture.__exit__(None, None, None)

    def test_real_cloakbrowser_runs_javascript_download_through_controlled_https(
        self,
    ) -> None:
        runtime_home = os.environ.get("SCIRETRIEVER_TEST_CLOAK_HOME", "").strip()
        if not runtime_home:
            self.skipTest("set SCIRETRIEVER_TEST_CLOAK_HOME for real installed-runtime QA")
        driver = Path(__file__).parent / "helpers" / "drive_cloakbrowser.py"
        fresh_site_packages = os.fspath(self.install.site_packages)
        result = self.install.run_driver(
            driver,
            environment={"SCIRETRIEVER_TEST_CLOAK_HOME": runtime_home},
            timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr_text)
        self.assertEqual(result.stderr, b"")
        payload = json.loads(result.stdout)

        for module_file in payload["product_module_files"].values():
            self.assertTrue(module_file.startswith(fresh_site_packages + os.sep), module_file)
        self.assertTrue(
            payload["cloakbrowser_module_file"].startswith(fresh_site_packages + os.sep),
            payload["cloakbrowser_module_file"],
        )
        self.assertTrue(
            payload["playwright_module_file"].startswith(fresh_site_packages + os.sep),
            payload["playwright_module_file"],
        )
        self.assertTrue(payload["runtime"]["cloak_wrapper_available"])
        self.assertTrue(payload["runtime"]["playwright_api_available"])
        self.assertTrue(payload["runtime"]["binary_executable_available"])
        self.assertTrue(payload["runtime"]["headed_display_available"])
        self.assertRegex(payload["runtime"]["browser_version"], r"^[0-9]+(?:\.[0-9]+){3,4}$")

        network = payload["network"]
        self.assertTrue(network["resolver_only_returned_loopback"])
        self.assertEqual(network["authorities"], [network["authority"]] * 4)
        self.assertEqual(
            network["paths"],
            ["/article", "/article.pdf", "/article.pdf", "/article.pdf"],
        )
        self.assertTrue(network["cookie_pair_preserved"])

        expected_sha256 = payload["verification"]["expected_pdf_sha256"]
        self.assertEqual(payload["verification"]["delivered_pdf_sha256"], [expected_sha256] * 2)
        self.assertLess(payload["verification"]["direct_pdf_elapsed_seconds"], 5.0)

        session = payload["session"]
        self.assertEqual(session["article_count"], 2)
        self.assertTrue(session["one_process_and_context_reused"])
        self.assertTrue(session["article_pages_closed"])
        self.assertTrue(session["persistent_profile_created"])

        cleanup = payload["cleanup"]
        self.assertFalse(cleanup["temporary_root_exists"])
        self.assertFalse(cleanup["runtime_directory_exists"])
        self.assertTrue(cleanup["profile_survived_broker_close"])
        self.assertFalse(cleanup["server_thread_alive"])
        self.assertEqual(cleanup["browser_threads_alive"], [])

        production = payload["production_boundary"]
        self.assertEqual(production["browser_strategy"], "generic-agent")
        self.assertTrue(production["ready"])
        self.assertIsNone(production["readiness_code"])


if __name__ == "__main__":
    unittest.main()
