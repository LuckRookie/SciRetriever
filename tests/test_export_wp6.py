from __future__ import annotations

import contextlib
import io
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from cli_wp2_fixture import CliWp2Fixture, WorkRepository, open_catalog_engine
from sciretriever.catalog import CatalogDiagnosticService
from sciretriever.core.export_publication import (
    ExportCheckpoint,
    ExportPublication,
    publish_export,
)
from sciretriever.errors import StorageError
from sciretriever.diagnostics import (
    DiagnosticWriteRequest,
    ProductFailure,
    ProductFailureAction,
    ProductFailureReason,
    ProductFailureStage,
)
from sciretriever.diagnostics.product import DiagnosticSubjectKind, RerunGuidance
import test_package_export_wp6 as package_fixture


SENTINEL = "WP6-TODO21-FIXED-SENTINEL"


class InjectedCrash(BaseException):
    pass


class ExportPublicationWp6Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-export-security-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.catalog = self.root / "catalog.sqlite"
        self.catalog.write_bytes(b"catalog")

    def publication(self, destination: Path, payload: bytes = b'{"accepted":true}\n') -> ExportPublication:
        return ExportPublication(destination, self.catalog, payload)

    def test_crash_before_and_after_rename_has_only_absent_or_canonical_target(self) -> None:
        for checkpoint in (ExportCheckpoint.BEFORE_RENAME, ExportCheckpoint.AFTER_RENAME):
            with self.subTest(checkpoint=checkpoint):
                destination = self.root / f"{checkpoint.value}.json"

                def crash(observed: ExportCheckpoint) -> None:
                    if observed is checkpoint:
                        raise InjectedCrash(checkpoint.value)

                with self.assertRaises(InjectedCrash):
                    publish_export(self.publication(destination), checkpoint=crash)

                if checkpoint is ExportCheckpoint.BEFORE_RENAME:
                    self.assertFalse(destination.exists())
                else:
                    self.assertEqual(destination.read_bytes(), b'{"accepted":true}\n')
                self.assertEqual(tuple(self.root.glob(".*.tmp")), ())

    def test_symlink_hardlink_and_catalog_sidecar_swaps_fail_closed(self) -> None:
        victim = self.root / "victim.json"
        victim.write_bytes(b"preserved")
        swaps = ("symlink", "hardlink", "sidecar")
        for swap in swaps:
            with self.subTest(swap=swap):
                destination = self.root / f"race-{swap}.json"

                def replace_target(checkpoint: ExportCheckpoint) -> None:
                    if checkpoint is not ExportCheckpoint.BEFORE_TARGET_REVALIDATION:
                        return
                    if swap == "symlink":
                        destination.symlink_to(victim)
                    elif swap == "hardlink":
                        os.link(victim, destination)
                    else:
                        destination.symlink_to(Path(f"{self.catalog}-wal"))

                with self.assertRaises(StorageError):
                    publish_export(self.publication(destination), checkpoint=replace_target)

                self.assertEqual(victim.read_bytes(), b"preserved")
                self.assertEqual(tuple(self.root.glob(".*.tmp")), ())
                destination.unlink(missing_ok=True)


class ExportCliSecurityWp6Tests(CliWp2Fixture):
    def seed_secret_work(self):
        engine = open_catalog_engine(self.catalog, allow_repository_write=True)
        work_version = WorkRepository(engine).ingest_version(
            provider="fixture",
            provider_record_id="private-record",
            title="Safe export title",
            doi="10.1000/export-security",
            version_class="formal_publication",
        )
        CatalogDiagnosticService(engine).append(DiagnosticWriteRequest(
            ProductFailure(
                ProductFailureStage.ACQUISITION,
                DiagnosticSubjectKind.WORK_VERSION,
                work_version.id,
                ProductFailureReason.PROVIDER,
                ProductFailureAction.RETRY,
                RerunGuidance.RETRY,
            ),
            True,
            {
                "token": SENTINEL,
                "runtime_path": f"/tmp/{SENTINEL}/payload",
                "provider_payload": {"secret": SENTINEL},
            },
        ))
        engine.dispose()
        return work_version

    def test_reading_cli_excludes_sentinel_runtime_and_backend_material(self) -> None:
        work_version = self.seed_secret_work()
        destination = self.base / "reading.json"
        runtime_path = str(self.base).encode()

        code, output, error = self.invoke([
            "library", "export", "--mode", "reading", "--catalog", str(self.catalog),
            "--work-version-id", work_version.id, "--output", str(destination),
            "--include-references",
        ])

        catalog_bytes = self.catalog.read_bytes()
        exported = destination.read_bytes()
        terminal = f"{output}\n{error}".encode()
        self.assertEqual((code, error), (0, ""))
        self.assertNotIn(SENTINEL.encode(), exported)
        self.assertNotIn(SENTINEL.encode(), terminal)
        self.assertNotIn(runtime_path, exported)
        for forbidden in (b"provider_record_id", b"diagnostic", b"storage_path", b"provenance"):
            self.assertNotIn(forbidden, exported)
        self.assertNotIn(SENTINEL.encode(), catalog_bytes)

    def test_package_cli_concurrent_exact_replay_is_immutable_and_secret_free(self) -> None:
        fixture = package_fixture.PackageExportWP6Tests(
            "test_latest_and_exact_export_preserve_stored_canonical_bytes"
        )
        fixture.setUp()
        old_bytes = fixture.stored_bytes()
        destinations = tuple(fixture.root / f"replay-{index}.json" for index in range(4))

        from sciretriever.cli.main import main as fixture_main

        try:
            requests = tuple(fixture.request(destination, exact=True) for destination in destinations)
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=4) as executor:
                results = tuple(executor.map(fixture.exporter.export, requests))
            stdout = io.StringIO()
            stderr = io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = fixture_main([
                    "--no-config", "library", "export", "--mode", "package",
                    "--catalog", str(fixture.catalog_path),
                    "--storage-root", str(fixture.derived_store.root),
                    "--work-version-id", fixture.work_version_id,
                    "--package-version", str(fixture.publication.record.version),
                    "--package-sha256", fixture.publication.record.sha256,
                    "--output", str(destinations[0]),
                ])

            self.assertEqual(code, 0)
            self.assertEqual({result.package_bytes for result in results}, {old_bytes})
            self.assertEqual({destination.read_bytes() for destination in destinations}, {old_bytes})
            self.assertEqual(fixture.stored_bytes(), old_bytes)
            rendered = f"{stdout.getvalue()}\n{stderr.getvalue()}".encode()
            self.assertNotIn(SENTINEL.encode(), rendered)
            self.assertNotIn(str(fixture.root).encode(), old_bytes)
        finally:
            fixture.doCleanups()


if __name__ == "__main__":
    unittest.main()
