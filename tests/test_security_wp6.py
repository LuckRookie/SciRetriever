from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from sciretriever.catalog import (
    CatalogDiagnosticService,
    WorkRepository,
    create_catalog_engine,
    initialize_catalog,
    open_catalog_engine,
)
from sciretriever.cli.main import main
from sciretriever.core.export_publication import ExportPublication, publish_export
from sciretriever.diagnostics import (
    DiagnosticWriteRequest,
    ProductFailure,
    ProductFailureAction,
    ProductFailureReason,
    ProductFailureStage,
)
from sciretriever.diagnostics.product import DiagnosticSubjectKind, RerunGuidance
from sciretriever.errors import StorageError
from sciretriever.core.export_errors import ExportContractError
from wp6_acceptance_fixture import run_acceptance


SENTINEL = "WP6-RELEASE-SECRET-MUST-NOT-PERSIST"
SIGNED_URL = f"https://example.test/private/article?token={SENTINEL}"


class CanonicalSecurityTests(unittest.TestCase):
    def test_diagnostics_and_product_outputs_are_redacted(self) -> None:
        with TemporaryDirectory(prefix="sciretriever-security-release-") as temporary:
            root = Path(temporary) / "run"
            summary = run_acceptance(root)
            catalog_path = root / "catalog.sqlite"
            catalog = open_catalog_engine(catalog_path, allow_repository_write=True)
            self.addCleanup(catalog.dispose)
            version = WorkRepository(catalog).ingest_version(
                provider="fixture",
                provider_record_id="security-record",
                title="Security release fixture",
                doi="10.9000/security-release",
            )
            failure = ProductFailure(
                ProductFailureStage.ACQUISITION,
                DiagnosticSubjectKind.WORK_VERSION,
                version.id,
                ProductFailureReason.PROVIDER,
                ProductFailureAction.RETRY,
                RerunGuidance.RETRY,
            )
            row = CatalogDiagnosticService(catalog).append(DiagnosticWriteRequest(
                failure,
                True,
                {
                    "url": SIGNED_URL,
                    "headers": {"Authorization": f"Bearer {SENTINEL}"},
                    "runtime_path": f"/tmp/{SENTINEL}/payload",
                    "provider_payload": {"secret": SENTINEL},
                },
            ))
            rendered = json.dumps(row.to_dict(), sort_keys=True).encode()
            artifacts = (
                root / "reading-off.json",
                root / "reading-on.json",
                root / "package-old.json",
                root / "package-current.json",
            )
            output_bytes = b"".join(path.read_bytes() for path in artifacts)
            with catalog.connect() as connection:
                diagnostic_rows = connection.exec_driver_sql(
                    "SELECT id,stage,subject_kind,input_fingerprint,work_id,work_version_id,"
                    "processing_run_id,reason,action,retryable,summary,details_json,occurred_at "
                    "FROM diagnostic_records WHERE id=?",
                    (row.id,),
                ).all()
                curation_rows = connection.exec_driver_sql(
                    "SELECT before_snapshot_json,after_snapshot_json,evidence_json FROM curation_operations"
                ).all()
                connection.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)").one()
            self.assertEqual(len(diagnostic_rows), 1)
            diagnostic_bytes = b"".join(
                str(value).encode()
                for value in diagnostic_rows[0]
            )
            curation_bytes = b"".join(
                str(value).encode()
                for value in curation_rows
            )
            catalog.dispose()
            database_files = tuple(
                path for path in (
                    catalog_path,
                    Path(f"{catalog_path}-wal"),
                    Path(f"{catalog_path}-shm"),
                )
                if path.exists()
            )
            self.assertIn(catalog_path, database_files)
            database_bytes = b"".join(path.read_bytes() for path in database_files)

            self.assertEqual(json.loads(summary.to_json())["status"], "passed")
            inspected_bytes = (
                rendered + diagnostic_bytes + output_bytes + curation_bytes + database_bytes
            )
            for forbidden in (
                SENTINEL.encode(),
                b"/private/article",
                f"token={SENTINEL}".encode(),
                b"Authorization",
                f"Bearer {SENTINEL}".encode(),
                f"/tmp/{SENTINEL}/payload".encode(),
                str(root).encode(),
            ):
                self.assertNotIn(forbidden, inspected_bytes)

    def test_cli_stderr_and_unsafe_destinations_fail_closed(self) -> None:
        with TemporaryDirectory(prefix="sciretriever-security-release-") as temporary:
            root = Path(temporary)
            catalog = root / "catalog.sqlite"
            engine = create_catalog_engine(catalog, allow_repository_write=True)
            initialize_catalog(engine)
            engine.dispose()
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                code = main([
                    "--no-config", "library", "export", "--mode", "reading",
                    "--catalog", str(catalog), "--work-id", SENTINEL,
                    "--output", str(root / "missing.json"),
                ])
            self.assertEqual(code, 1)
            self.assertNotIn(SENTINEL, stderr.getvalue())
            self.assertNotIn(str(root), stderr.getvalue())

            victim = root / "victim.json"
            victim.write_bytes(b"preserved")
            for kind in ("symlink", "hardlink"):
                destination = root / f"{kind}.json"
                if kind == "symlink":
                    destination.symlink_to(victim)
                else:
                    os.link(victim, destination)
                with self.subTest(kind=kind), self.assertRaises((ExportContractError, StorageError)):
                    publish_export(ExportPublication(destination, catalog, b"unsafe"))
                self.assertEqual(victim.read_bytes(), b"preserved")


if __name__ == "__main__":
    unittest.main()
