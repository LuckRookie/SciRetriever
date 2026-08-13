from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
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
        helper = Path(__file__).parent / "helpers" / "playwright_runtime.py"
        assert self.install.root is not None
        assert self.install.venv is not None
        copied_driver = self.install.root / "playwright-driver.py"
        copied_helper = self.install.root / helper.name
        shutil.copyfile(driver, copied_driver)
        shutil.copyfile(helper, copied_helper)

        purelib_probe = self.install.run_python(
            ("-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))")
        )
        self.assertEqual(purelib_probe.returncode, 0, purelib_probe.stderr_text)
        fresh_site_packages = os.fspath(
            Path(purelib_probe.stdout_text.strip()).resolve(strict=True)
        )

        browser_cache = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
        if browser_cache is None:
            browser_cache = os.fspath(Path.home() / ".cache" / "ms-playwright")
        environment = self.install.isolated_environment(
            {
                "PLAYWRIGHT_BROWSERS_PATH": browser_cache,
                "SCIRETRIEVER_FRESH_SITE_PACKAGES": fresh_site_packages,
            }
        )
        result = subprocess.run(
            (sys.executable, "-I", os.fspath(copied_driver)),
            cwd=self.install.root,
            env=environment,
            check=False,
            capture_output=True,
            text=False,
            timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        self.assertEqual(result.stderr, b"")
        payload = json.loads(result.stdout)

        for module_file in payload["product_module_files"].values():
            self.assertTrue(module_file.startswith(fresh_site_packages + os.sep), module_file)
        self.assertFalse(payload["playwright_module_file"].startswith(fresh_site_packages + os.sep))

        engine = payload["engine"]
        self.assertEqual(engine["name"], "chromium")
        self.assertRegex(engine["version"], r"^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$")
        executable_path = os.fspath(Path(engine["executable_path"]).resolve(strict=True))
        self.assertTrue(
            executable_path.startswith(environment["PLAYWRIGHT_BROWSERS_PATH"] + os.sep)
        )
        self.assertFalse(executable_path.startswith(fresh_site_packages + os.sep))
        self.assertEqual(engine["javascript_result"], "javascript-ran")
        self.assertEqual(engine["page_clicks"], ["button[data-action='pdf']"])
        self.assertEqual(engine["download_events"], 1)

        network = payload["network"]
        self.assertEqual(network["resolver_addresses"], ["127.0.0.1"])
        self.assertEqual(network["connected_addresses"], ["127.0.0.1", "127.0.0.1"])
        self.assertEqual(network["tls_server_names"], [network["hostname"], network["hostname"]])
        self.assertEqual(network["authorities"], [network["authority"], network["authority"]])
        self.assertEqual(network["paths"], ["/article", "/article.pdf"])
        self.assertTrue(network["certificate_san_matches_hostname"])
        self.assertTrue(network["all_bindings_acknowledged_before_continue"])
        self.assertTrue(network["download_request_was_live"])

        self.assertEqual(
            payload["verification"]["delivered_pdf_sha256"],
            payload["verification"]["expected_pdf_sha256"],
        )
        self.assertEqual(payload["candidate"]["acquisition_path"], "controlled-browser")
        self.assertEqual(payload["candidate"]["source_name"], "controlled-browser")

        cleanup = payload["cleanup"]
        self.assertTrue(cleanup["page_closed"])
        self.assertTrue(cleanup["context_closed"])
        self.assertTrue(cleanup["process_closed"])
        self.assertTrue(cleanup["download_deleted"])
        self.assertFalse(cleanup["browser_downloads_path_exists"])
        self.assertFalse(cleanup["fixture_temporary_root_exists"])
        self.assertFalse(cleanup["server_thread_alive"])

        production = payload["production_boundary"]
        self.assertEqual(production["catalog_rule_count"], 0)
        self.assertFalse(production["ready"])
        self.assertEqual(
            production["readiness_code"],
            "acquisition-browser-production-unavailable",
        )


if __name__ == "__main__":
    unittest.main()
