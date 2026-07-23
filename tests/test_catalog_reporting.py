import contextlib
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from sqlalchemy import insert
from sqlalchemy.exc import OperationalError

from sciretriever.catalog import (
    CatalogReportingRepository,
    CatalogEngine,
    IdentityResolver,
    JobRepository, initialize_catalog, create_catalog_engine,
open_read_only_catalog_engine,
)
from sciretriever.catalog.models import events, failures
from sciretriever.catalog.repository import canonical_json
from sciretriever.cli.main import main
from sciretriever.core.enums import AttemptOutcome, JobState
from sciretriever.core.ids import new_uuid4
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.diagnostics import AttemptMetadata, map_exception
from sciretriever.errors import ProviderSearchError, ProviderErrorCategory


class CatalogReportingTests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.path = Path(self.temporary_directory.name) / "catalog.sqlite"
        writable = create_catalog_engine(self.path)
        initialize_catalog(writable)
        self.work_id = IdentityResolver(writable).create_or_reuse_work({"doi": "10.1000/report"}).work_version.id
        self.other_work_id = IdentityResolver(writable).create_or_reuse_work({"doi": "10.1000/report-2"}).work_version.id
        jobs = JobRepository(writable)
        self.job = jobs.attach_or_create_job(self.work_id, "primary_pdf")
        jobs.restart_foreground_job(self.job.id)
        attempt = jobs.start_attempt(self.job.id, "example", source_url="https://example.test/file?token=SECRET")
        diagnostic = map_exception(
            ProviderSearchError("example", ProviderErrorCategory.RATE_LIMIT, "RAW_EXCEPTION", retryable=True),
            attempt=AttemptMetadata("candidate-1", 1, 12),
        )
        details = {"diagnostic": diagnostic.to_dict(), "body": "RESPONSE_BODY_SECRET"}
        jobs.finish_attempt_and_job(
            attempt.id,
            AttemptOutcome.RETRYABLE,
            JobState.FAILED,
            details=details,
        )
        self.failure = jobs.append_failure(
            "rate_limit",
            "RAW_EXCEPTION",
            work_version_id=self.work_id,
            job_id=self.job.id,
            attempt_id=attempt.id,
            retryable=True,
            details=details,
        )
        second = jobs.attach_or_create_job(self.other_work_id, "xml")
        jobs.restart_foreground_job(second.id)
        jobs.cancel_job_and_requests(second.id)
        self.second_job_id = second.id
        now = utc_now_rfc3339()
        with writable.transaction() as connection:
            connection.execute(
                insert(failures).values(
                    id=new_uuid4(), work_version_id=self.other_work_id, job_id=second.id,
                    attempt_id=None, processing_run_id=None, category="future_category",
                    message="SIGNED_URL https://host/path?signature=SECRET", retryable=0,
                    details_json=canonical_json({"diagnostic": {"schema_version": 999, "token": "SECRET"}}),
                    occurred_at=now,
                )
            )
            connection.execute(
                insert(events).values(
                    id=new_uuid4(), subject_type="future", subject_id=new_uuid4(),
                    event_type="future.unknown", details_json=canonical_json({"secret": "SECRET"}),
                    occurred_at=now,
                )
            )
        writable.dispose()

    def repository(self) -> tuple[CatalogEngine, CatalogReportingRepository]:
        engine = open_read_only_catalog_engine(self.path)
        self.addCleanup(engine.dispose)
        return engine, CatalogReportingRepository(engine)

    def test_reopen_is_read_only_and_projection_is_immutable_and_safe(self) -> None:
        engine, repository = self.repository()
        before = self.path.stat().st_mtime_ns
        projection = repository.get_job(self.job.id)
        self.assertIsNotNone(projection)
        assert projection is not None
        self.assertNotIn("next_retry_at", projection.to_dict())
        rendered = json.dumps(projection.to_dict(), sort_keys=True)
        for marker in ("SECRET", "RAW_EXCEPTION", "RESPONSE_BODY", "https://"):
            self.assertNotIn(marker, rendered)
        with self.assertRaises(ValueError):
            JobRepository(engine)
        with engine.transaction() as connection, self.assertRaises(OperationalError):
            connection.execute(insert(events).values(id=new_uuid4()))
        self.assertEqual(self.path.stat().st_mtime_ns, before)

    def test_ordering_filters_and_unknown_diagnostic_fail_closed(self) -> None:
        _engine, repository = self.repository()
        rows = repository.list_jobs(limit=10)
        self.assertEqual(rows, repository.list_jobs(limit=10))
        self.assertEqual({row.job_id for row in rows}, {self.job.id, self.second_job_id})
        self.assertEqual(repository.list_jobs(work_id=self.work_id)[0].job_id, self.job.id)
        self.assertEqual(repository.list_jobs(state="failed")[0].job_id, self.job.id)
        self.assertEqual(repository.list_jobs(retryable=True, category="rate_limit")[0].job_id, self.job.id)
        unknown = repository.get_job(self.second_job_id)
        assert unknown is not None
        diagnostic = unknown.failures[0].diagnostic
        self.assertEqual(diagnostic.reason_code.value, "unknown_failure")
        self.assertFalse(diagnostic.retryable)
        self.assertEqual(unknown.event_count, 4)

    def test_cli_json_and_jsonl_are_semantically_equivalent_and_read_only(self) -> None:
        before = self.path.stat().st_mtime_ns
        outputs: dict[str, str] = {}
        for output_format in ("terminal", "json", "jsonl"):
            stream = io.StringIO()
            with contextlib.redirect_stdout(stream):
                result = main(["--no-config", "report", "--catalog", str(self.path), "--format", output_format])
            self.assertEqual(result, 0)
            outputs[output_format] = stream.getvalue()
        json_rows = json.loads(outputs["json"])
        jsonl_rows = [json.loads(line) for line in outputs["jsonl"].splitlines()]
        self.assertEqual(json_rows, jsonl_rows)
        for row in json_rows:
            self.assertIn(f"job={row['job_id']} work={row['work_id']}", outputs["terminal"])
            for failure in row["failures"]:
                diagnostic = failure["diagnostic"]
                self.assertIn(f"reason={diagnostic['reason_code']}", outputs["terminal"])
                self.assertIn(f"diagnostic={diagnostic['diagnostic_id']}", outputs["terminal"])
        combined = "".join(outputs.values())
        for marker in ("SECRET", "RAW_EXCEPTION", "RESPONSE_BODY", "https://"):
            self.assertNotIn(marker, combined)
        self.assertEqual(self.path.stat().st_mtime_ns, before)


if __name__ == "__main__":
    import unittest

    unittest.main()
