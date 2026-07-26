from __future__ import annotations

import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from unittest import TestCase

from sciretriever.catalog import CatalogDiagnosticService, WorkRepository, create_catalog_engine, initialize_catalog
from sciretriever.diagnostics import DiagnosticWriteRequest
from sciretriever.diagnostics.owners import AcquisitionFailureOwner


REPOSITORY = Path(__file__).resolve().parents[1]
SECRET = "TODO28-SENTINEL-SECRET"


class FailuresCliTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-wp6-28-")
        self.addCleanup(self.temporary.cleanup)
        self.catalog_path = Path(self.temporary.name) / "catalog.sqlite"
        catalog = create_catalog_engine(self.catalog_path, allow_repository_write=True)
        initialize_catalog(catalog)
        version = WorkRepository(catalog).ingest_version(
            provider="fixture",
            provider_record_id="todo28",
            title="Todo 28",
            doi="10.1/todo28",
        )
        self.version_id = version.id
        owner = AcquisitionFailureOwner(CatalogDiagnosticService(catalog))
        owner.exhausted(
            version.id,
            "primary_pdf",
            ({"source": "direct", "outcome": "rejected", "url": f"https://example.test/?token={SECRET}"},),
        )
        catalog.dispose()

    def invoke(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ("uv", "run", "--frozen", "sciretriever", "--no-config", "failures", "--catalog", str(self.catalog_path), *arguments),
            cwd=REPOSITORY,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_default_latest_omits_details_and_explicit_all_details_is_redacted(self) -> None:
        # Given / When
        latest = self.invoke("--work-version-id", self.version_id)
        expanded = self.invoke(
            "--work-version-id", self.version_id,
            "--stage", "acquisition",
            "--role", "primary_pdf",
            "--source", "direct",
            "--outcome", "rejected",
            "--all",
            "--details",
        )

        # Then
        self.assertEqual(latest.returncode, 0, latest.stderr)
        self.assertEqual(expanded.returncode, 0, expanded.stderr)
        latest_payload = json.loads(latest.stdout)
        expanded_payload = json.loads(expanded.stdout)
        self.assertNotIn("details", latest_payload["failures"][0])
        self.assertEqual(expanded_payload["count"], 1)
        self.assertEqual(expanded_payload["failures"][0]["details"]["asset_role"], "primary_pdf")
        self.assertNotIn(SECRET, latest.stdout + expanded.stdout + latest.stderr + expanded.stderr)

    def test_conflicting_history_modes_fail_at_parse_boundary(self) -> None:
        # Given / When
        result = self.invoke("--latest", "--all")

        # Then
        self.assertEqual(result.returncode, 2)

    def test_malformed_subject_fails_at_parse_boundary(self) -> None:
        # Given / When
        result = self.invoke("--work-version-id", "not-a-uuid")

        # Then
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    import unittest

    unittest.main()
