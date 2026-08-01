import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase
from uuid import UUID

from sqlalchemy.exc import IntegrityError

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import (
    CatalogDiagnosticService,
    CompletionFactsRepository,
    WorkRepository,
    create_catalog_engine,
    initialize_catalog,
)
from sciretriever.catalog.wp6_models import MAX_DIAGNOSTIC_DETAILS_BYTES
from sciretriever.diagnostics import (
    DiagnosticQuery,
    DiagnosticWriteRequest,
    ProductFailure,
    ProductFailureAction,
    ProductFailureReason,
    ProductFailureStage,
)
from sciretriever.diagnostics.product import DiagnosticSubjectKind, RerunGuidance
from sciretriever.errors import CatalogError

SECRET = "FIXED-SENTINEL-SECRET"
SIGNED_URL = f"https://example.test/private/file?signature={SECRET}&token={SECRET}"


class DiagnosticWp6Tests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-wp6-")
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "catalog.sqlite"
        self.catalog = create_catalog_engine(self.path, allow_repository_write=True)
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        self.service = CatalogDiagnosticService(self.catalog)
        version = WorkRepository(self.catalog).ingest_version(
            provider="fixture", provider_record_id="record", title="Diagnostic Work", doi="10.1/diagnostic"
        )
        self.work_id = version.work_id
        self.version_id = version.id
        self.processing_id = "123e4567-e89b-42d3-a456-426614174010"
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO processing_runs (id,work_version_id,stage) VALUES (?,?,'analysis')",
                (self.processing_id, self.version_id),
            )

    def failure(
        self,
        stage: ProductFailureStage,
        kind: DiagnosticSubjectKind,
        subject_id: str,
        reason: ProductFailureReason = ProductFailureReason.PROVIDER,
        action: ProductFailureAction = ProductFailureAction.RETRY,
    ) -> ProductFailure:
        return ProductFailure(stage, kind, subject_id, reason, action, RerunGuidance.RETRY)

    def test_all_four_stages_append_redacted_history_without_mutating_completion_facts(self) -> None:
        # Given
        input_id = "sha256:" + "a" * 64
        failures = (
            self.failure(ProductFailureStage.METADATA, DiagnosticSubjectKind.INPUT, input_id),
            self.failure(ProductFailureStage.ACQUISITION, DiagnosticSubjectKind.WORK_VERSION, self.version_id),
            self.failure(ProductFailureStage.ANALYSIS, DiagnosticSubjectKind.PROCESSING_RUN, self.processing_id),
            self.failure(ProductFailureStage.EXPANSION, DiagnosticSubjectKind.EXPANSION, self.work_id),
        )
        facts_before = CompletionFactsRepository(self.catalog).get(self.version_id)

        # When
        written = tuple(self.service.append(DiagnosticWriteRequest(
            failure=failure,
            retryable=True,
            details={
                "url": SIGNED_URL,
                "headers": {"Authorization": f"Bearer {SECRET}"},
                "runtime_path": f"/tmp/{SECRET}/response.json",
                "provider_payload": {"value": SECRET},
                "exception": RuntimeError(SECRET),
            },
        )) for failure in failures)

        # Then
        rows = self.service.query(DiagnosticQuery())
        self.assertEqual(tuple(row.id for row in rows), tuple(row.id for row in reversed(written)))
        self.assertEqual({row.failure.stage for row in rows}, set(ProductFailureStage))
        self.assertEqual(CompletionFactsRepository(self.catalog).get(self.version_id), facts_before)
        persisted = b"".join(path.read_bytes() for path in sorted(self.path.parent.glob("catalog.sqlite*")))
        rendered = json.dumps([row.to_dict() for row in rows], sort_keys=True)
        self.assertNotIn(SECRET, persisted.decode("utf-8", errors="ignore"))
        self.assertNotIn(SECRET, rendered)
        self.assertNotIn("/private/file", rendered)
        self.assertNotIn("/tmp/", rendered)

    def test_query_filters_and_latest_are_deterministic(self) -> None:
        # Given
        subject = self.failure(ProductFailureStage.ACQUISITION, DiagnosticSubjectKind.WORK_VERSION, self.version_id)
        first = self.service.append(DiagnosticWriteRequest(subject, True, {"outcome": "first"}))
        second_failure = self.failure(
            ProductFailureStage.ACQUISITION,
            DiagnosticSubjectKind.WORK_VERSION,
            self.version_id,
            ProductFailureReason.CONTENT,
            ProductFailureAction.REVIEW,
        )
        second = self.service.append(DiagnosticWriteRequest(second_failure, False, {"outcome": "second"}))

        # When
        latest = self.service.query(DiagnosticQuery(subject=subject, latest=True))
        filtered = self.service.query(DiagnosticQuery(
            subject=second_failure,
            stage=ProductFailureStage.ACQUISITION,
            reason=ProductFailureReason.CONTENT,
            action=ProductFailureAction.REVIEW,
            retryable=False,
        ))

        # Then
        self.assertEqual(latest, (second,))
        self.assertEqual(filtered, (second,))
        self.assertEqual(self.service.query(DiagnosticQuery(subject=subject)), (second, first))

    def test_query_filters_object_and_acquisition_details_before_latest(self) -> None:
        # Given
        failure = self.failure(
            ProductFailureStage.ACQUISITION,
            DiagnosticSubjectKind.WORK_VERSION,
            self.version_id,
        )
        direct = self.service.append(DiagnosticWriteRequest(
            failure,
            False,
            {"asset_role": "primary_pdf", "outcome": "missing", "sources": (
                {"source": "direct", "outcome": "rejected"},
            )},
        ))
        self.service.append(DiagnosticWriteRequest(
            failure,
            True,
            {"asset_role": "xml", "outcome": "failed", "sources": (
                {"source": "elsevier", "outcome": "failed"},
            )},
        ))

        # When
        rows = self.service.query(DiagnosticQuery(
            subject_kind=DiagnosticSubjectKind.WORK_VERSION,
            subject_id=self.version_id,
            role="primary_pdf",
            source="direct",
            outcome="missing",
            latest=True,
        ))

        # Then
        self.assertEqual(rows, (direct,))

    def test_malformed_historical_details_project_as_bounded_safe_corruption(self) -> None:
        # Given
        row_id = "123e4567-e89b-42d3-a456-426614174099"
        hostile = "{" + SECRET + SIGNED_URL + "x" * 5000
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("PRAGMA ignore_check_constraints=ON")
            connection.exec_driver_sql(
                "INSERT INTO diagnostic_records (id,stage,subject_kind,work_version_id,reason,action,retryable,summary,details_json) "
                "VALUES (?,'analysis','work_version',?,'provider','retry',1,'unsafe',?)",
                (row_id, self.version_id, hostile),
            )

        # When
        projected = self.service.query(DiagnosticQuery())

        # Then
        self.assertEqual(len(projected), 1)
        self.assertTrue(projected[0].corrupted)
        self.assertEqual(projected[0].failure.reason, ProductFailureReason.CATALOG)
        rendered = json.dumps(projected[0].to_dict(), sort_keys=True)
        self.assertLess(len(rendered), 1024)
        self.assertNotIn(SECRET, rendered)
        self.assertNotIn("example.test", rendered)

    def test_valid_oversized_historical_details_project_as_bounded_safe_corruption(self) -> None:
        # Given
        row_id = "123e4567-e89b-42d3-a456-426614174098"
        historical_secret = "SECRET-SENTINEL"
        historical_url = f"https://example.test/private/file?signature={historical_secret}"
        hostile = json.dumps({
            "details": {
                "nested": [{
                    "url": historical_url,
                    "headers": {"Authorization": f"Bearer {historical_secret}"},
                    "runtime_path": f"/tmp/{historical_secret}/response.json",
                    "provider_payload": {"secret": historical_secret, "padding": "x" * 5000},
                }],
            },
            "rerun": "retry",
        }, separators=(",", ":"), sort_keys=True)
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("PRAGMA ignore_check_constraints=ON")
            connection.exec_driver_sql(
                "INSERT INTO diagnostic_records (id,stage,subject_kind,work_version_id,reason,action,retryable,summary,details_json) "
                "VALUES (?,'analysis','work_version',?,'provider','retry',1,'unsafe',?)",
                (row_id, self.version_id, hostile),
            )

        # When
        projected = self.service.query(DiagnosticQuery())

        # Then
        self.assertGreater(len(hostile.encode("utf-8")), 5000)
        self.assertEqual(len(projected), 1)
        self.assertTrue(projected[0].corrupted)
        self.assertEqual(projected[0].failure.reason, ProductFailureReason.CATALOG)
        rendered = json.dumps(projected[0].to_dict(), sort_keys=True)
        self.assertLessEqual(len(rendered.encode("utf-8")), MAX_DIAGNOSTIC_DETAILS_BYTES)
        self.assertNotIn(historical_secret, rendered)
        self.assertNotIn("example.test", rendered)
        self.assertNotIn("/tmp/", rendered)
        with self.catalog.connect() as connection:
            stored = connection.exec_driver_sql(
                "SELECT details_json FROM diagnostic_records WHERE id=?", (row_id,)
            ).scalar_one()
        self.assertEqual(stored, hostile)

    def test_valid_bounded_historical_details_are_redacted_without_corruption(self) -> None:
        # Given
        row_id = "123e4567-e89b-42d3-a456-426614174097"
        hostile = json.dumps({
            "details": {
                "note": f"token={SECRET}",
                "url": SIGNED_URL,
                "runtime_path": f"/tmp/{SECRET}/response.json",
            },
            "rerun": "retry",
        }, separators=(",", ":"), sort_keys=True)
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO diagnostic_records (id,stage,subject_kind,work_version_id,reason,action,retryable,summary,details_json) "
                "VALUES (?,'analysis','work_version',?,'provider','retry',1,'safe',?)",
                (row_id, self.version_id, hostile),
            )

        # When
        projected = self.service.query(DiagnosticQuery())

        # Then
        self.assertEqual(len(projected), 1)
        self.assertFalse(projected[0].corrupted)
        self.assertEqual(projected[0].failure.reason, ProductFailureReason.PROVIDER)
        rendered = json.dumps(projected[0].to_dict(), sort_keys=True)
        self.assertNotIn(SECRET, rendered)
        self.assertNotIn("/private/file", rendered)
        self.assertNotIn("/tmp/", rendered)
        with self.catalog.connect() as connection:
            stored = connection.exec_driver_sql(
                "SELECT details_json FROM diagnostic_records WHERE id=?", (row_id,)
            ).scalar_one()
        self.assertEqual(stored, hostile)

    def test_database_guards_history_against_update_and_delete(self) -> None:
        # Given
        failure = self.failure(ProductFailureStage.EXPANSION, DiagnosticSubjectKind.EXPANSION, self.work_id)
        record = self.service.append(DiagnosticWriteRequest(failure, True, {}))
        UUID(record.id)

        # When / Then
        for statement in (
            "UPDATE diagnostic_records SET retryable=0 WHERE id=?",
            "DELETE FROM diagnostic_records WHERE id=?",
        ):
            with self.subTest(statement=statement), self.assertRaises(IntegrityError), self.catalog.transaction() as connection:
                connection.exec_driver_sql(statement, (record.id,))

    def test_rejected_write_does_not_echo_untrusted_details(self) -> None:
        # Given
        orphan = self.failure(
            ProductFailureStage.ANALYSIS,
            DiagnosticSubjectKind.WORK_VERSION,
            "123e4567-e89b-42d3-a456-426614174088",
        )

        # When
        with self.assertRaises(CatalogError) as captured:
            self.service.append(DiagnosticWriteRequest(orphan, True, {"note": SECRET, "url": SIGNED_URL}))

        # Then
        self.assertNotIn(SECRET, str(captured.exception))
        self.assertNotIn("example.test", str(captured.exception))


if __name__ == "__main__":
    import unittest

    unittest.main()
