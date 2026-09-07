from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from tests.acceptance.helpers.installed_wheel import InstalledWheel


class InstalledDatabaseCompletionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = InstalledWheel()
        cls.install = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fixture.__exit__(None, None, None)

    def test_installed_completion_is_durable_across_exhaustion_failures_and_reruns(
        self,
    ) -> None:
        driver = Path(__file__).parent / "helpers" / "drive_database_completion.py"
        result = self.install.run_driver(driver, timeout=90)
        self.assertEqual(result.returncode, 0, result.stderr_text)
        diagnostics = result.stderr_text
        self.assertIn("event=completion-target-failed", diagnostics)
        self.assertIn("reason=", diagnostics)
        self.assertIn("action=", diagnostics)
        self.assertNotIn("Traceback", diagnostics)
        self.assertNotIn("://", diagnostics)
        payload = json.loads(result.stdout)
        catalog = payload["catalog"]

        venv = os.fspath(self.install.venv.resolve(strict=True))
        for module_file in payload["product_module_files"].values():
            self.assertTrue(module_file.startswith(venv + os.sep), module_file)
            self.assertIn(os.sep + "site-packages" + os.sep, module_file)

        success = payload["success"]
        success_report = success["report"]
        self.assertEqual(success_report["end"], {"kind": "finished"})
        self.assertEqual(len(success_report["goal_reached"]), 1)
        self.assertEqual(success_report["needs_manual_pdf"], [])
        self.assertEqual(success_report["failed"], [])
        self.assertEqual(success_report["interrupted"], [])
        self.assertEqual(success_report["not_started"], [])
        self.assertEqual(success_report["no_usable_content_literature_ids"], [])
        success_detail = success["detail"]
        self.assertEqual(success_detail["literature"]["status"], "CONTENT_READY")
        self.assertIsNone(success_detail["missing_step"])
        self.assertFalse(success_detail["needs_manual_pdf"])
        self.assertIsNotNone(success_detail["primary_pdf"])
        self.assertIsNotNone(success_detail["parser_result"])
        self.assertIsNotNone(success_detail["content"])
        self.assertEqual(
            success["pdf_sha256"],
            success_detail["primary_pdf"]["asset"]["sha256"],
        )
        self.assertEqual(
            success["artifact_sha256"]["parser_markdown"],
            success_detail["parser_result"]["markdown"]["sha256"],
        )
        self.assertEqual(
            success["artifact_sha256"]["content_markdown"],
            success_detail["content"]["markdown"]["sha256"],
        )
        self.assertIn("# Controlled completion study", success["parser_markdown"])
        self.assertIn("# 元数据", success["content_markdown"])
        self.assertIn("# 研究背景与目标", success["content_markdown"])
        self.assertIn("# 参考文献", success["content_markdown"])

        replacement = payload["replacement"]
        replacement_report = replacement["report"]
        self.assertEqual(replacement_report["end"], {"kind": "finished"})
        self.assertEqual(len(replacement_report["goal_reached"]), 1)
        self.assertEqual(len(replacement_report["no_usable_content_literature_ids"]), 1)
        self.assertEqual(replacement_report["failed"], [])
        self.assertEqual(replacement["detail"]["literature"]["status"], "CONTENT_READY")
        self.assertIsNone(replacement["detail"]["missing_step"])
        self.assertEqual(len(replacement["primary_rows"]), 1)
        cleanup = replacement["cleanup_observation"]
        self.assertEqual(cleanup["physical_exists"], [True, True])
        self.assertEqual(cleanup["physical_exists_after_operation"], [False, False])
        self.assertEqual(cleanup["artifact_rows"], [0, 0])
        self.assertEqual(cleanup["primary_rows"], 0)
        self.assertEqual(cleanup["parser_rows"], 0)
        self.assertEqual(cleanup["content_rows"], 0)
        self.assertEqual(len(cleanup["old_closure_paths"]), 2)

        boundary = payload["fake_boundary"]
        self.assertEqual(
            boundary["llm_kinds_by_title"]["Controlled completion study"],
            ["metadata", "content"],
        )
        self.assertEqual(
            boundary["llm_kinds_by_title"]["Controlled candidate replacement study"],
            ["metadata", "metadata", "content"],
        )
        replacement_requests = [
            item
            for item in boundary["source_requests"]
            if item["title"] == "Controlled candidate replacement study"
        ]
        self.assertEqual(len(replacement_requests), 2)
        self.assertEqual(replacement_requests[0]["excluded"], [])
        self.assertEqual(
            replacement_requests[1]["excluded"],
            ["rejected-content-candidate"],
        )

        exhaustion = payload["exhaustion_retry"]
        exhaustion_id = catalog["literature_ids"]["exhaustion_retry"]
        initial_exhaustion = exhaustion["initial_report"]
        self.assertEqual(initial_exhaustion["end"], {"kind": "finished"})
        self.assertEqual(initial_exhaustion["goal"], "ASSET_READY")
        self.assertEqual(initial_exhaustion["goal_reached"], [])
        self.assertEqual(initial_exhaustion["failed"], [])
        self.assertEqual(len(initial_exhaustion["needs_manual_pdf"]), 1)
        self.assertEqual(
            initial_exhaustion["needs_manual_pdf"][0]["literature_ids"],
            [exhaustion_id],
        )
        exhaustion_before = exhaustion["detail_before_retry"]
        self.assertEqual(exhaustion_before["literature"]["status"], "UNREVIEWED")
        self.assertEqual(exhaustion_before["missing_step"], "primary-pdf")
        self.assertTrue(exhaustion_before["needs_manual_pdf"])
        self.assertIsNone(exhaustion_before["primary_pdf"])
        self.assertEqual(exhaustion["rows_before_wide"], [exhaustion_id])

        wide = exhaustion["wide_report"]
        self.assertEqual(wide["end"], {"kind": "finished"})
        for partition in (
            "goal_reached",
            "needs_manual_pdf",
            "failed",
            "interrupted",
            "not_started",
        ):
            self.assertEqual(wide[partition], [])
        self.assertEqual(
            exhaustion["source_requests_after_wide"],
            exhaustion["source_requests_before_wide"],
        )
        self.assertEqual(exhaustion["rows_after_wide"], [exhaustion_id])

        retry = exhaustion["retry_report"]
        self.assertEqual(retry["end"], {"kind": "finished"})
        self.assertEqual(retry["failed"], [])
        self.assertEqual(retry["needs_manual_pdf"], [])
        self.assertEqual(
            [item["literature_id"] for item in retry["goal_reached"]],
            [exhaustion_id],
        )
        exhaustion_after = exhaustion["detail_after_retry"]
        self.assertEqual(exhaustion_after["literature"]["status"], "ASSET_READY")
        self.assertEqual(exhaustion_after["missing_step"], "parser-result")
        self.assertFalse(exhaustion_after["needs_manual_pdf"])
        self.assertIsNotNone(exhaustion_after["primary_pdf"])
        self.assertIsNone(exhaustion_after["parser_result"])
        self.assertIsNone(exhaustion_after["content"])
        self.assertEqual(exhaustion["rows_after_retry"], [])
        exhaustion_requests = [
            item
            for item in boundary["source_requests"]
            if item["title"] == "Controlled exhaustion retry study"
        ]
        self.assertEqual(len(exhaustion_requests), 2)
        self.assertEqual(exhaustion_requests[0]["configured"], [])
        self.assertEqual(
            exhaustion_requests[1]["configured"],
            ["exhaustion-retry-candidate"],
        )
        self.assertTrue(all(item["excluded"] == [] for item in exhaustion_requests))

        partial = payload["partial_failure"]
        partial_ids = {
            name: catalog["literature_ids"][name]
            for name in ("parser_failure", "llm_failure", "partial_success")
        }
        first_partial = partial["first_report"]
        self.assertEqual(first_partial["end"], {"kind": "finished"})
        self.assertEqual(first_partial["needs_manual_pdf"], [])
        self.assertEqual(first_partial["interrupted"], [])
        self.assertEqual(first_partial["not_started"], [])
        self.assertEqual(first_partial["no_usable_content_literature_ids"], [])
        first_failures = {item["literature_id"]: item for item in first_partial["failed"]}
        self.assertEqual(
            set(first_failures), {partial_ids["parser_failure"], partial_ids["llm_failure"]}
        )
        self.assertEqual(first_failures[partial_ids["parser_failure"]]["stage"], "parsing")
        self.assertEqual(
            first_failures[partial_ids["parser_failure"]]["failure"]["code"],
            "acceptance-parser-failed-once",
        )
        self.assertEqual(first_failures[partial_ids["llm_failure"]]["stage"], "analysis")
        self.assertEqual(
            first_failures[partial_ids["llm_failure"]]["failure"]["code"],
            "acceptance-llm-failed-once",
        )
        self.assertTrue(all(item["failure"]["retryable"] for item in first_failures.values()))
        self.assertEqual(
            [item["literature_id"] for item in first_partial["goal_reached"]],
            [partial_ids["partial_success"]],
        )

        details_after_first = partial["details_after_first"]
        parser_failed = details_after_first["parser_failure"]
        self.assertEqual(parser_failed["literature"]["status"], "ASSET_READY")
        self.assertIsNotNone(parser_failed["primary_pdf"])
        self.assertIsNone(parser_failed["parser_result"])
        self.assertIsNone(parser_failed["content"])
        self.assertEqual(parser_failed["missing_step"], "parser-result")
        llm_failed = details_after_first["llm_failure"]
        self.assertEqual(llm_failed["literature"]["status"], "ASSET_READY")
        self.assertIsNotNone(llm_failed["primary_pdf"])
        self.assertIsNotNone(llm_failed["parser_result"])
        self.assertIsNone(llm_failed["content"])
        self.assertEqual(llm_failed["missing_step"], "literature-content")
        first_success = details_after_first["success"]
        self.assertEqual(first_success["literature"]["status"], "CONTENT_READY")
        self.assertIsNotNone(first_success["primary_pdf"])
        self.assertIsNotNone(first_success["parser_result"])
        self.assertIsNotNone(first_success["content"])

        second_partial = partial["second_report"]
        self.assertEqual(second_partial["end"], {"kind": "finished"})
        self.assertEqual(second_partial["failed"], [])
        self.assertEqual(second_partial["needs_manual_pdf"], [])
        self.assertEqual(second_partial["interrupted"], [])
        self.assertEqual(second_partial["not_started"], [])
        self.assertEqual(
            [item["literature_id"] for item in second_partial["goal_reached"]],
            [partial_ids["parser_failure"], partial_ids["llm_failure"]],
        )
        for detail in partial["details_after_second"].values():
            self.assertEqual(detail["literature"]["status"], "CONTENT_READY")
            self.assertIsNone(detail["missing_step"])
            self.assertIsNotNone(detail["primary_pdf"])
            self.assertIsNotNone(detail["parser_result"])
            self.assertIsNotNone(detail["content"])

        counts_before = partial["counts_after_first"]
        counts_after = partial["counts_after_second"]
        self.assertEqual(
            counts_after["source_request_count"],
            counts_before["source_request_count"],
        )
        self.assertEqual(
            counts_before["parser_attempts"]["parser-failure-candidate"],
            1,
        )
        self.assertEqual(
            counts_after["parser_attempts"]["parser-failure-candidate"],
            2,
        )
        for candidate in ("llm-failure-candidate", "partial-success-candidate"):
            self.assertEqual(counts_before["parser_attempts"][candidate], 1)
            self.assertEqual(counts_after["parser_attempts"][candidate], 1)
        self.assertEqual(
            boundary["llm_kinds_by_title"]["Controlled parser retry study"],
            ["metadata", "content"],
        )
        self.assertEqual(
            boundary["llm_kinds_by_title"]["Controlled LLM retry study"],
            ["metadata", "metadata", "content"],
        )
        self.assertEqual(
            boundary["llm_kinds_by_title"]["Controlled partial batch success study"],
            ["metadata", "content"],
        )

        self.assertEqual(boundary["parser_request_count"], 7)
        self.assertTrue(
            all(
                item == {"discard_count": 1, "open_count": 1}
                for item in boundary["temporary_content"]
            )
        )

        counts = payload["storage"]["table_counts"]
        self.assertEqual(counts["assets"], 6)
        self.assertEqual(counts["literature_assets"], 6)
        self.assertEqual(counts["parser_results"], 5)
        self.assertEqual(counts["literature_contents"], 5)
        self.assertGreaterEqual(counts["artifact_objects"], 12)

        self.assertEqual(catalog["root_name"], "database-completion")
        self.assertEqual(
            catalog["catalog_relative_path"],
            "database-completion/catalog.sqlite3",
        )
        self.assertEqual(catalog["configuration_name"], "config.toml")
        console_expectations = {
            "exhaustion_retry": (exhaustion_after, "ASSET_READY", False),
            "llm_failure": (
                partial["details_after_second"]["llm_failure"],
                "CONTENT_READY",
                True,
            ),
            "parser_failure": (
                partial["details_after_second"]["parser_failure"],
                "CONTENT_READY",
                True,
            ),
            "partial_success": (
                partial["details_after_second"]["success"],
                "CONTENT_READY",
                True,
            ),
            "replacement": (replacement["detail"], "CONTENT_READY", True),
            "success": (success_detail, "CONTENT_READY", True),
        }
        for name, (api_detail, expected_status, has_content) in console_expectations.items():
            console = payload["console_details"][name]
            self.assertEqual(console["returncode"], 0, console["stderr"])
            self.assertEqual(console["stderr"], "")
            console_detail = json.loads(console["stdout"])
            self.assertEqual(console_detail, api_detail)
            self.assertEqual(
                console_detail["literature"]["literature_id"],
                catalog["literature_ids"][name],
            )
            self.assertEqual(console_detail["literature"]["status"], expected_status)
            self.assertIsNotNone(console_detail["primary_pdf"])
            if has_content:
                self.assertIsNotNone(console_detail["parser_result"])
                self.assertIsNotNone(console_detail["content"])
            else:
                self.assertIsNone(console_detail["parser_result"])
                self.assertIsNone(console_detail["content"])

        console_exports = payload["console_exports"]
        expected_exports = {
            "content": success["artifact_sha256"]["content_markdown"],
            "pdf": success["pdf_sha256"],
        }
        for name, expected_sha256 in expected_exports.items():
            exported = console_exports[name]
            self.assertEqual(exported["returncode"], 0, exported["stderr"])
            self.assertEqual(exported["stderr"], "")
            self.assertEqual(json.loads(exported["stdout"]), True)
            self.assertGreater(exported["bytes"], 0)
            self.assertEqual(exported["sha256"], expected_sha256)


if __name__ == "__main__":
    unittest.main()
