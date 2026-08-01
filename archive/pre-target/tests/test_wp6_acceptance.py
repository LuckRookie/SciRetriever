from __future__ import annotations

import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest

from wp6_acceptance_fixture import (
    INJECTIONS,
    InjectedAcceptanceFailure,
    run_acceptance,
)


class Wp6ProductAcceptanceTests(unittest.TestCase):
    def test_success_summary_is_byte_identical_across_independent_roots(self) -> None:
        with TemporaryDirectory(prefix="sciretriever-wp6-determinism-") as directory:
            base = Path(directory)
            summaries = tuple(
                run_acceptance(base / f"run-{index}").to_json()
                for index in range(3)
            )

        self.assertEqual(summaries[1:], summaries[:1] * 2)

    def test_full_offline_product_lifecycle_persists_shared_state(self) -> None:
        with TemporaryDirectory(prefix="sciretriever-wp6-acceptance-") as directory:
            root = Path(directory) / "run"
            summary = run_acceptance(root)
            rendered = json.loads(summary.to_json())
            self.assertEqual(rendered["status"], "passed")
            self.assertGreaterEqual(rendered["work_versions"], rendered["complete_versions"])
            self.assertEqual(rendered["raw_asset_sha256"], rendered["pdf_sha256"])
            self.assertEqual(rendered["package_sha256"], rendered["export_sha256"])
            self.assertGreaterEqual(rendered["references"], 2)
            self.assertGreaterEqual(rendered["curation_operations"], 9)
            self.assertEqual(rendered["complete_versions"], 4)
            self.assertEqual(rendered["package_versions"], 2)
            self.assertEqual(rendered["pdf_pages"], 2)
            self.assertRegex(rendered["work_version_id"], r"^[0-9a-f-]{36}$")
            root_bytes = str(root).encode("utf-8")
            self.assertNotIn(root_bytes, (root / "package-old.json").read_bytes())
            self.assertNotIn(root_bytes, (root / "package-current.json").read_bytes())

    def test_injected_failures_are_redacted_and_retain_rollback_evidence(self) -> None:
        with TemporaryDirectory(prefix="sciretriever-wp6-failure-") as directory:
            base = Path(directory)
            for injection in sorted(INJECTIONS):
                root = base / injection
                with self.subTest(injection=injection), self.assertRaises(InjectedAcceptanceFailure):
                    run_acceptance(root, injection)
                retained = json.loads((root / "failure-observation.json").read_text(encoding="utf-8"))
                self.assertEqual(retained["injection"], injection)
                self.assertTrue((root / "catalog.sqlite").is_file())
                self.assertNotIn("authorization", json.dumps(retained).lower())
                persisted = b"".join(
                    path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()
                ).lower()
                self.assertNotIn(b"wp6-secret-must-not-persist", persisted)
                self.assertNotIn(b"authorization", persisted)
                with sqlite3.connect(root / "catalog.sqlite") as connection:
                    counts = tuple(connection.execute(
                        f"SELECT count(*) FROM {table}"
                    ).fetchone()[0] for table in (
                        "current_analyses", "version_references",
                        "diagnostic_records", "curation_operations", "package_versions",
                    ))
                if injection in {"transaction", "config"}:
                    self.assertEqual(retained["before"], retained["after"])
                elif injection == "branch":
                    self.assertGreater(retained["after"][5], retained["before"][5])
                    self.assertGreater(retained["after"][4], retained["before"][4])
                    self.assertEqual(counts[:3], (2, 3, 3))
                else:
                    self.assertEqual((root / "immutable.json").read_bytes(), b"preserved")
                if injection == "transaction":
                    self.assertEqual(counts[3], 0)
                if injection == "config":
                    self.assertEqual((root / "config.toml").read_text(), "schema_version = [\n")
                if injection == "export":
                    self.assertEqual(counts[4], 2)


if __name__ == "__main__":
    unittest.main()
