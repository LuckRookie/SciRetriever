from __future__ import annotations

import json

from cli_wp2_fixture import *
import test_package_export_wp6 as package_fixture


class CliExportWp6Tests(CliWp2Fixture):
    def seed_work(self):
        engine = open_catalog_engine(self.catalog, allow_repository_write=True)
        work_version = WorkRepository(engine).ingest_version(
            provider="fixture",
            provider_record_id="private-record",
            title="Explicit export mode",
            doi="10.1000/export-mode",
            version_class="formal_publication",
        )
        engine.dispose()
        return work_version

    def test_help_requires_explicit_modes_and_exposes_mode_options(self):
        # Given
        output = io.StringIO()

        # When
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as raised:
            main(["--no-config", "library", "export", "--help"])

        # Then
        self.assertEqual(raised.exception.code, 0)
        self.assertIn("--mode {reading,package}", output.getvalue())
        self.assertIn("--package-version", output.getvalue())
        self.assertIn("--package-sha256", output.getvalue())
        self.assertIn("--storage-root", output.getvalue())

    def test_reading_mode_exports_through_existing_projection(self):
        # Given
        work_version = self.seed_work()
        destination = self.base / "reading.json"

        # When
        code, output, error = self.invoke([
            "library", "export", "--mode", "reading",
            "--catalog", str(self.catalog), "--work-id", work_version.work_id,
            "--output", str(destination), "--include-references",
        ])

        # Then
        self.assertEqual((code, error), (0, ""))
        self.assertEqual(json.loads(destination.read_bytes())[0]["work_version_id"], work_version.id)
        self.assertIn(str(destination), output)

    def test_incompatible_options_reject_before_output_side_effects(self):
        # Given
        work_version = self.seed_work()
        invalid = (
            ["--mode", "reading", "--work-version-id", work_version.id,
             "--package-version", "1"],
            ["--mode", "package", "--work-id", work_version.work_id,
             "--storage-root", str(self.base)],
            ["--mode", "package", "--work-version-id", work_version.id,
             "--storage-root", str(self.base), "--include-references"],
            ["--mode", "package", "--work-version-id", work_version.id,
             "--storage-root", str(self.base), "--format", "jsonl"],
            ["--mode", "package", "--work-version-id", work_version.id,
             "--storage-root", str(self.base), "--package-version", "1"],
        )

        # When / Then
        for index, options in enumerate(invalid):
            destination = self.base / f"invalid-{index}.json"
            with self.subTest(options=options):
                self.parse_error([
                    "library", "export", "--catalog", str(self.catalog),
                    "--output", str(destination), *options,
                ])
                self.assertFalse(destination.exists())
        self.assertEqual(tuple(self.base.glob(".*.tmp")), ())

    def test_package_latest_reports_verified_snapshot_identity(self):
        # Given
        fixture = package_fixture.PackageExportWP6Tests(
            "test_latest_and_exact_export_preserve_stored_canonical_bytes"
        )
        fixture.setUp()
        destination = fixture.root / "cli-latest.json"

        try:
            # When
            code, output, error = self.invoke([
                "library", "export", "--mode", "package",
                "--catalog", str(fixture.catalog_path),
                "--storage-root", str(fixture.derived_store.root),
                "--work-version-id", fixture.work_version_id,
                "--output", str(destination),
            ])

            # Then
            self.assertEqual((code, error), (0, ""))
            report = json.loads(output)
            self.assertEqual(report, {
                "disposition": "replayed",
                "mode": "package",
                "package_sha256": fixture.publication.record.sha256,
                "package_version": fixture.publication.record.version,
                "work_version_id": fixture.work_version_id,
            })
            self.assertEqual(destination.read_bytes(), fixture.stored_bytes())
            self.assertIn(b'"references":', destination.read_bytes())
        finally:
            fixture.doCleanups()

    def test_package_exact_version_and_hash_export_same_snapshot(self):
        # Given
        fixture = package_fixture.PackageExportWP6Tests(
            "test_latest_and_exact_export_preserve_stored_canonical_bytes"
        )
        fixture.setUp()
        destination = fixture.root / "cli-exact.json"

        try:
            # When
            code, output, error = self.invoke([
                "library", "export", "--mode", "package",
                "--catalog", str(fixture.catalog_path),
                "--storage-root", str(fixture.derived_store.root),
                "--work-version-id", fixture.work_version_id,
                "--package-version", str(fixture.publication.record.version),
                "--package-sha256", fixture.publication.record.sha256,
                "--output", str(destination),
            ])

            # Then
            self.assertEqual((code, error), (0, ""))
            self.assertEqual(json.loads(output)["disposition"], "replayed")
            self.assertEqual(destination.read_bytes(), fixture.stored_bytes())
        finally:
            fixture.doCleanups()

    def test_legacy_export_selectors_and_missing_mode_reject(self):
        # Given
        destination = self.base / "legacy.json"

        # When / Then
        for selector in (("--doi", "10.1000/export-mode"), ("--title", "Legacy")):
            with self.subTest(selector=selector):
                self.parse_error([
                    "library", "export", "--catalog", str(self.catalog),
                    "--output", str(destination), *selector,
                ])
                self.assertFalse(destination.exists())


if __name__ == "__main__":
    import unittest
    unittest.main()
