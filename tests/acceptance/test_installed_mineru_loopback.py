from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from tests.acceptance.helpers.installed_wheel import InstalledWheel


class InstalledMinerULoopbackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = InstalledWheel()
        cls.install = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fixture.__exit__(None, None, None)

    def test_installed_mineru_protocol_and_adapter_produce_neutral_artifacts(self) -> None:
        driver = Path(__file__).parent / "helpers" / "drive_mineru_loopback.py"
        result = self.install.run_driver(driver, timeout=90)
        self.assertEqual(result.returncode, 0, result.stderr_text)
        self.assertEqual(result.stderr, b"")
        payload = json.loads(result.stdout)

        venv = os.fspath(self.install.venv.resolve(strict=True))
        for module_file in payload["product_module_files"].values():
            self.assertTrue(module_file.startswith(venv + os.sep), module_file)
            self.assertIn(os.sep + "site-packages" + os.sep, module_file)

        protocol = payload["protocol"]
        self.assertGreater(protocol["port"], 0)
        self.assertGreater(protocol["archive_bytes"], 0)
        self.assertEqual(protocol["methods"], ["GET", "POST", "GET", "GET", "GET"])
        self.assertEqual(
            protocol["paths"],
            [
                "/health",
                "/tasks",
                "/tasks/acceptance-task-0001",
                "/tasks/acceptance-task-0001",
                "/tasks/acceptance-task-0001/result",
            ],
        )
        self.assertEqual(protocol["poll_count"], 2)
        self.assertTrue(protocol["submit_contains_pdf"])
        self.assertTrue(protocol["submit_contains_profile"])

        self.assertEqual(payload["result"]["page_count"], 2)
        self.assertEqual(payload["input"]["open_count"], 1)
        self.assertEqual(
            payload["input"]["source_sha256"],
            payload["input"]["pdf_sha256"],
        )

        artifact = payload["artifact"]
        self.assertEqual(
            artifact["markdown_sha256"],
            payload["expected"]["markdown_sha256"],
        )
        self.assertEqual(artifact["markdown_verified_sha256"], artifact["markdown_sha256"])
        self.assertIn("# Controlled MinerU work", artifact["markdown"])
        self.assertEqual(len(artifact["resources"]), 1)
        resource = artifact["resources"][0]
        self.assertEqual(resource["reference"], "images/figure.png")
        self.assertEqual(resource["media_type"], "image/png")
        self.assertEqual(resource["sha256"], payload["expected"]["image_sha256"])
        self.assertEqual(resource["verified_sha256"], resource["sha256"])

        provenance = payload["provenance"]
        self.assertEqual(provenance["parser_version"], "3.4.4")
        self.assertEqual(provenance["mode"], "vlm-engine")
        self.assertEqual(
            provenance["model_identity"],
            "controlled-vlm-model@acceptance-revision",
        )
        self.assertEqual(provenance["provenance"]["source_kind"], "parser")
        self.assertEqual(provenance["provenance"]["source_name"], "mineru")
        self.assertEqual(
            provenance["provenance"]["input_sha256"],
            payload["input"]["pdf_sha256"],
        )
        self.assertIsNotNone(provenance["provenance"]["parameters_sha256"])

        hygiene = payload["temporary_hygiene"]
        self.assertEqual(hygiene["new_parser_staging_entries"], [])
        self.assertFalse(hygiene["server_thread_alive_after_join"])

        serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        for private_name in (
            "document_middle.json",
            "document_model.json",
            "document_content_list.json",
            "document_layout.pdf",
            "document_origin.pdf",
            "PRIVATE-MINERU-ARCHIVE-SENTINEL",
            "unreferenced.png",
        ):
            self.assertNotIn(private_name, serialized)


if __name__ == "__main__":
    unittest.main()
