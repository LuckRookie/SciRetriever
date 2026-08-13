from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from tests.acceptance.helpers.installed_wheel import InstalledWheel


class InstalledTopicDiscoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = InstalledWheel()
        cls.install = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fixture.__exit__(None, None, None)

    def test_installed_entry_preserves_partial_multi_source_discovery_in_one_catalog(
        self,
    ) -> None:
        driver = Path(__file__).parent / "helpers" / "drive_topic_discovery.py"
        result = self.install.run_driver(driver, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr_text)
        self.assertEqual(result.stderr, b"")
        payload = json.loads(result.stdout)

        venv = os.fspath(self.install.venv.resolve(strict=True))
        for module_file in payload["product_module_files"].values():
            self.assertTrue(module_file.startswith(venv + os.sep), module_file)
            self.assertIn(os.sep + "site-packages" + os.sep, module_file)

        report = payload["report"]
        self.assertEqual(report["run_status"], "PARTIAL")
        self.assertEqual(report["discovery_result_count"], 1)
        self.assertEqual(report["new_meta_literature_count"], 1)
        self.assertEqual(report["new_literature_count"], 1)
        self.assertEqual(report["new_metadata_observation_count"], 2)
        self.assertEqual(
            [
                (item["provider_name"], item["raw_item_count"], item["outcome"])
                for item in report["providers"]
            ],
            [
                ("alpha", 2, "SCAN_LIMIT_REACHED"),
                ("beta", 1, "FAILED"),
            ],
        )
        self.assertEqual(
            [item["accepted_observation_count"] for item in report["providers"]],
            [1, 1],
        )

        boundary = payload["fake_boundary"]
        self.assertEqual(boundary["alpha_pulled"], 2)
        self.assertEqual(boundary["alpha_converted"], 2)
        self.assertEqual(boundary["beta_pulled"], 1)
        self.assertEqual(boundary["beta_converted"], 1)
        self.assertEqual(
            [query["query"] for query in boundary["queries"]],
            ["controlled offline discovery", "controlled offline discovery"],
        )

        snapshot = payload["snapshot"]
        self.assertEqual(snapshot["run"]["status"], "PARTIAL")
        self.assertEqual(
            [item["outcome"] for item in snapshot["source_results"]],
            ["SCAN_LIMIT_REACHED", "FAILED"],
        )
        self.assertEqual(len(snapshot["results"]), 1)
        self.assertEqual(len(snapshot["causes"]), 2)
        self.assertTrue(all(item["kind"] == "topic" for item in snapshot["causes"]))
        self.assertEqual(
            {item["metadata_observation_id"] for item in snapshot["causes"]},
            set(payload["detail"]["observation_ids"]),
        )
        self.assertEqual(payload["detail"]["observation_sources"], ["alpha", "beta"])
        self.assertEqual(payload["local_page"]["total_count"], 1)

        console = payload["console"]
        self.assertEqual(console["returncode"], 0, console["stderr"])
        self.assertEqual(console["stderr"], "")
        console_page = json.loads(console["stdout"])
        self.assertEqual(console_page["total_count"], 1)
        self.assertEqual(len(console_page["items"]), 1)
        self.assertEqual(
            console_page["items"][0]["literature"]["literature_id"],
            payload["detail"]["literature_id"],
        )


if __name__ == "__main__":
    unittest.main()
