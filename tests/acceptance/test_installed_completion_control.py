from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from tests.acceptance.helpers.installed_wheel import InstalledWheel


class InstalledCompletionControlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = InstalledWheel()
        cls.install = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fixture.__exit__(None, None, None)

    def test_installed_completion_freezes_and_controls_all_r8_targets(self) -> None:
        driver = Path(__file__).parent / "helpers" / "drive_completion_control.py"
        result = self.install.run_driver(driver, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr_text)
        diagnostics = result.stderr_text
        self.assertIn("event=completion-target-failed", diagnostics)
        self.assertIn("code=control-network-failed", diagnostics)
        self.assertIn("reason=", diagnostics)
        self.assertIn("action=", diagnostics)
        self.assertNotIn("Traceback", diagnostics)
        self.assertNotIn("://", diagnostics)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["evidence_kind"], "installed-port-injection")

        venv = os.fspath(self.install.venv.resolve(strict=True))
        for module_file in payload["product_module_files"].values():
            self.assertTrue(module_file.startswith(venv + os.sep), module_file)
            self.assertIn(os.sep + "site-packages" + os.sep, module_file)

        selectors = payload["six_selectors"]
        self.assertEqual(
            set(selectors),
            {
                "all-pending",
                "discovery-run",
                "import-report",
                "query",
                "meta-literatures",
                "literatures",
            },
        )
        for evidence in selectors.values():
            self.assertEqual(evidence["selector_reads"], 1)
            self.assertEqual(len(evidence["partitions"]["goal_reached"]), 1)
            self.assertEqual(evidence["partitions"]["needs_manual_pdf"], [])
            self.assertEqual(evidence["partitions"]["failed"], [])
            self.assertEqual(evidence["partitions"]["interrupted"], [])
            self.assertEqual(evidence["partitions"]["not_started"], [])
            self.assertEqual(evidence["parser_calls"], 0)
            self.assertEqual(evidence["analysis_calls"], 0)

        freeze = payload["snapshot_freeze"]
        self.assertEqual(freeze["selector_reads"], 2)
        self.assertEqual(len(freeze["first"]["goal_reached"]), 1)
        self.assertEqual(len(freeze["second"]["goal_reached"]), 1)
        self.assertNotEqual(
            freeze["first_acquisition_ids"],
            freeze["second_acquisition_ids"],
        )

        typed = payload["typed_fallbacks"]
        primary = typed["no_primary_pdf"]
        self.assertEqual(len(primary["acquisition_order"]), 2)
        self.assertEqual(len(primary["report"]["goal_reached"]), 1)
        self.assertEqual(primary["report"]["failed"], [])
        no_content = typed["no_usable_content_then_exhaustion"]
        self.assertEqual(len(no_content["analysis_order"]), 2)
        self.assertEqual(len(no_content["cleanup_ids"]), 1)
        self.assertEqual(len(no_content["acquisition_order"]), 1)
        self.assertEqual(len(no_content["report"]["goal_reached"]), 1)
        self.assertEqual(
            no_content["report"]["no_usable_content_literature_ids"],
            no_content["cleanup_ids"],
        )

        ordering = payload["candidate_ordering"]
        self.assertNotEqual(ordering["input_order"], ordering["frozen_order"])
        self.assertEqual(ordering["frozen_order"], ordering["expected_order"])

        exhaustion = payload["exhaustion_control"]
        self.assertEqual(len(exhaustion["explicit"]["clear_calls"]), 1)
        self.assertEqual(
            exhaustion["explicit"]["clear_calls"],
            exhaustion["explicit"]["acquisition_calls"],
        )
        self.assertEqual(len(exhaustion["explicit"]["report"]["goal_reached"]), 1)
        self.assertEqual(exhaustion["wide"]["clear_calls"], [])
        self.assertEqual(exhaustion["wide"]["acquisition_calls"], [])
        self.assertEqual(len(exhaustion["wide"]["report"]["needs_manual_pdf"]), 1)
        self.assertEqual(len(exhaustion["all_pending_partial"]["acquisition_calls"]), 1)
        self.assertEqual(
            len(exhaustion["all_pending_partial"]["report"]["goal_reached"]),
            1,
        )
        self.assertEqual(exhaustion["all_pending_omitted"]["acquisition_calls"], [])
        for partition in (
            "goal_reached",
            "needs_manual_pdf",
            "failed",
            "interrupted",
            "not_started",
        ):
            self.assertEqual(
                exhaustion["all_pending_omitted"]["report"][partition],
                [],
            )

        failures = payload["failures_do_not_fallback"]
        for stage in ("acquisition", "parsing", "analysis", "literature"):
            evidence = failures[stage]
            self.assertEqual(len(evidence["calls"]), 1)
            self.assertEqual(len(evidence["report"]["failed"]), 1)
            self.assertEqual(evidence["report"]["failed"][0]["stage"], stage)
            self.assertEqual(evidence["report"]["goal_reached"], [])
            self.assertEqual(evidence["report"]["needs_manual_pdf"], [])

        interruption = payload["controlled_interruption"]
        self.assertEqual(interruption["end"], {"kind": "interrupted"})
        self.assertTrue(interruption["caller_event_set"])
        self.assertTrue(interruption["same_event_identity"])
        self.assertEqual(interruption["committed_status"], "ASSET_READY")
        self.assertEqual(interruption["committed_primary_count"], 1)
        self.assertEqual(interruption["parser_calls"], 0)
        self.assertEqual(interruption["analysis_calls"], 0)
        partitions = interruption["partitions"]
        self.assertEqual(partitions["goal_reached"], [])
        self.assertEqual(partitions["needs_manual_pdf"], [])
        self.assertEqual(partitions["failed"], [])
        self.assertEqual(len(partitions["interrupted"]), 1)
        self.assertEqual(len(partitions["not_started"]), 2)


if __name__ == "__main__":
    unittest.main()
