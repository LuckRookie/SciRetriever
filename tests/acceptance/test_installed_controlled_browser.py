from __future__ import annotations

import json
import os
import re
import unittest
from pathlib import Path

from tests.acceptance.helpers.installed_wheel import InstalledWheel

_CANDIDATE_KEY = re.compile(r"controlled-browser:[0-9a-f]{64}\Z")


class InstalledControlledBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = InstalledWheel()
        cls.install = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fixture.__exit__(None, None, None)

    def test_installed_browser_client_and_source_run_one_controlled_component_flow(
        self,
    ) -> None:
        driver = Path(__file__).parent / "helpers" / "drive_controlled_browser.py"
        result = self.install.run_driver(driver, timeout=90)
        self.assertEqual(result.returncode, 0, result.stderr_text)
        self.assertEqual(result.stderr, b"")
        payload = json.loads(result.stdout)

        venv = os.fspath(self.install.venv.resolve(strict=True))
        for module_file in payload["product_module_files"].values():
            self.assertTrue(module_file.startswith(venv + os.sep), module_file)
            self.assertIn(os.sep + "site-packages" + os.sep, module_file)

        production = payload["production_boundary"]
        self.assertEqual(production["catalog_rule_count"], 9)
        self.assertTrue(production["ready"])
        self.assertIsNone(production["readiness_code"])

        evidence = payload["evidence"]
        self.assertTrue(evidence["applicable"])
        self.assertEqual(evidence["priority"], ["asset-hint", "provider-record-identity"])
        self.assertEqual(len(evidence["tried_candidate_keys"]), 2)

        candidate = payload["candidate"]
        self.assertEqual(candidate["acquisition_path"], "controlled-browser")
        self.assertEqual(candidate["source_name"], "controlled-browser")
        self.assertEqual(candidate["declared_media_type"], "application/pdf")
        self.assertRegex(candidate["candidate_key"], _CANDIDATE_KEY)
        self.assertIn(candidate["candidate_key"], evidence["tried_candidate_keys"])
        self.assertTrue(
            all(_CANDIDATE_KEY.fullmatch(key) for key in evidence["tried_candidate_keys"])
        )
        self.assertEqual(
            candidate["safe_source_url"],
            "https://downloads.publisher.test/article.pdf",
        )
        self.assertEqual(
            payload["verification"]["delivered_pdf_sha256"],
            payload["verification"]["expected_pdf_sha256"],
        )

        runtime = payload["runtime"]
        self.assertEqual(
            runtime["route_urls"],
            [
                "https://publisher.test/article",
                "https://downloads.publisher.test/article.pdf?view=full",
            ],
        )
        self.assertEqual(
            runtime["route_bindings"],
            [["93.184.216.34"], ["93.184.216.35"]],
        )
        self.assertEqual(
            runtime["resolver_calls"],
            [
                "publisher.test",
                "publisher.test",
                "downloads.publisher.test",
                "publisher.test",
                "publisher.test",
                "publisher.test",
                "publisher.test",
                "downloads.publisher.test",
                "downloads.publisher.test",
                "publisher.test",
            ],
        )
        self.assertEqual(runtime["page_clicks"], ["a[data-action='pdf']"])
        self.assertTrue(runtime["context_closed"])
        self.assertTrue(runtime["page_closed"])
        self.assertTrue(runtime["process_closed"])
        self.assertTrue(runtime["download_deleted"])
        self.assertTrue(runtime["downloads_path_absolute"])
        self.assertFalse(runtime["downloads_path_exists_after_run"])
        self.assertEqual(runtime["factory_binding_addresses"], ["93.184.216.34"])
        self.assertIn("process-enter", runtime["events"])
        self.assertIn("context-close", runtime["events"])
        self.assertIn("process-exit", runtime["events"])

        provenance = payload["provenance"]
        self.assertEqual(provenance["source_kind"], "asset-provider")
        self.assertEqual(provenance["source_name"], "controlled-browser")
        self.assertEqual(provenance["source_record_id"], "controlled-publisher@1")
        self.assertIsNone(provenance["input_sha256"])
        self.assertIsNotNone(provenance["parameters_sha256"])


if __name__ == "__main__":
    unittest.main()
