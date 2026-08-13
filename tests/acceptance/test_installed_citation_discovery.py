from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from tests.acceptance.helpers.installed_wheel import InstalledWheel


class InstalledCitationDiscoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = InstalledWheel()
        cls.install = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fixture.__exit__(None, None, None)

    def test_installed_citation_entry_enforces_direction_depth_and_run_boundaries(
        self,
    ) -> None:
        driver = Path(__file__).parent / "helpers" / "drive_citation_discovery.py"
        result = self.install.run_driver(driver, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr_text)
        self.assertEqual(result.stderr, b"")
        payload = json.loads(result.stdout)

        venv = os.fspath(self.install.venv.resolve(strict=True))
        for module_file in payload["product_module_files"].values():
            self.assertTrue(module_file.startswith(venv + os.sep), module_file)
            self.assertIn(os.sep + "site-packages" + os.sep, module_file)

        budget = payload["budget"]
        self.assertEqual(budget["query_pulled"], 2)
        self.assertEqual(budget["query_converted"], 2)
        self.assertEqual(budget["lookup_pulled"], 3)
        self.assertEqual(budget["lookup_converted"], 3)
        self.assertEqual(budget["query_pulled"] + budget["lookup_pulled"], 5)
        self.assertEqual(len(budget["query_contexts"]), 1)
        self.assertEqual(budget["query_contexts"][0]["direction"], "references")
        self.assertEqual(len(budget["lookup_keys"]), 1)
        self.assertEqual(budget["lookup_keys"][0]["record_id"], "target")

        forward = payload["forward"]
        forward_report = forward["report"]
        self.assertEqual(forward_report["run_status"], "COMPLETED")
        self.assertEqual(forward_report["discovery_result_count"], 2)
        self.assertEqual(forward_report["new_meta_literature_count"], 1)
        self.assertEqual(forward_report["new_literature_count"], 1)
        self.assertEqual(forward_report["new_metadata_observation_count"], 1)
        self.assertEqual(forward_report["providers"][0]["raw_item_count"], 5)
        self.assertEqual(
            forward_report["providers"][0]["outcome"],
            "SCAN_LIMIT_REACHED",
        )
        self.assertEqual(
            forward_report["providers"][0]["accepted_observation_count"],
            1,
        )
        self.assertEqual(forward["snapshot"]["run"]["input"]["max_depth"], 2)
        self.assertEqual(forward["snapshot"]["run"]["input"]["result_limit"], 2)
        causes = forward["snapshot"]["causes"]
        self.assertEqual(len(causes), 2)
        cause_by_edge = {
            (item["source_literature_id"], item["target_literature_id"]): item for item in causes
        }
        expected_edges = {
            (payload["identities"]["seed"], payload["identities"]["target"]),
            (payload["identities"]["target"], payload["identities"]["depth_two"]),
        }
        self.assertEqual(set(cause_by_edge), expected_edges)
        self.assertEqual(
            cause_by_edge[(payload["identities"]["seed"], payload["identities"]["target"])][
                "depth"
            ],
            1,
        )
        self.assertEqual(
            cause_by_edge[(payload["identities"]["target"], payload["identities"]["depth_two"])][
                "depth"
            ],
            2,
        )
        self.assertTrue(all(item["kind"] == "citation" for item in causes))
        self.assertEqual(len(forward["snapshot"]["results"]), 2)
        self.assertEqual(forward["page"]["total_count"], 2)
        self.assertEqual(len(forward["seed_references"]["items"]), 1)
        self.assertEqual(len(forward["depth_two_cited_by"]["items"]), 1)

        reverse = payload["reverse"]
        self.assertEqual(reverse["report"]["discovery_result_count"], 1)
        self.assertEqual(reverse["snapshot"]["run"]["input"]["direction"], "cited-by")
        self.assertEqual(reverse["snapshot"]["run"]["input"]["max_depth"], 1)
        self.assertEqual(reverse["snapshot"]["run"]["input"]["result_limit"], 1)
        reverse_cause = reverse["snapshot"]["causes"][0]
        self.assertEqual(
            reverse_cause["source_literature_id"],
            payload["identities"]["reverse_citing"],
        )
        self.assertEqual(
            reverse_cause["target_literature_id"],
            payload["identities"]["reverse_cited"],
        )
        self.assertEqual(reverse_cause["depth"], 1)
        reverse_item = reverse["page"]["items"][0]
        self.assertEqual(
            reverse_item["reference"]["source_literature_id"],
            payload["identities"]["reverse_citing"],
        )
        self.assertEqual(
            reverse_item["reference"]["target_literature_id"],
            payload["identities"]["reverse_cited"],
        )
        self.assertGreaterEqual(reverse_item["support_count"], 1)

        self.assertEqual(payload["analysis_calls"], 0)
        self.assertEqual(payload["database"]["over_limit_edges"], 0)
        self.assertEqual(payload["database"]["counts"]["discovery_results"], 3)
        self.assertEqual(payload["database"]["counts"]["literature_references"], 3)
        self.assertEqual(
            payload["database"]["counts"]["provider_relation_reference_supports"],
            3,
        )

        console = payload["console"]
        self.assertEqual(console["returncode"], 0, console["stderr"])
        self.assertEqual(console["stderr"], "")
        console_page = json.loads(console["stdout"])
        self.assertEqual(console_page["total_count"], 2)
        self.assertEqual(len(console_page["items"]), 2)

        console_reads = payload["console_reads"]
        for evidence in console_reads.values():
            self.assertEqual(evidence["returncode"], 0, evidence["stderr"])
            self.assertEqual(evidence["stderr"], "")
        references = json.loads(console_reads["references"]["stdout"])
        self.assertEqual(len(references["items"]), 1)
        self.assertEqual(
            references["items"][0]["reference"]["source_literature_id"],
            payload["identities"]["seed"],
        )
        cited_by = json.loads(console_reads["cited_by"]["stdout"])
        self.assertEqual(len(cited_by["items"]), 1)
        self.assertEqual(
            cited_by["items"][0]["reference"]["target_literature_id"],
            payload["identities"]["depth_two"],
        )
        reference_detail = json.loads(console_reads["reference_detail"]["stdout"])
        self.assertEqual(
            reference_detail["reference"]["reference_id"],
            references["items"][0]["reference"]["reference_id"],
        )
        self.assertGreaterEqual(len(reference_detail["supports"]), 1)


if __name__ == "__main__":
    unittest.main()
