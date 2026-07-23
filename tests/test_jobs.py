import importlib
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import FrozenInstanceError
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

catalog_api = importlib.import_module("sciretriever.catalog")
domain_runs_api = importlib.import_module("sciretriever.catalog.domain_runs")
jobs_api = importlib.import_module("sciretriever.catalog.jobs")
enums = importlib.import_module("sciretriever.core.enums")
CatalogError = importlib.import_module("sciretriever.errors").CatalogError
IntegrityError = importlib.import_module("sqlalchemy.exc").IntegrityError


class JobTests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.path = Path(self.temporary_directory.name) / "catalog.sqlite"
        self.catalog = catalog_api.create_catalog_engine(self.path)
        self.addCleanup(self.catalog.dispose)
        catalog_api.initialize_catalog(self.catalog)
        resolution = catalog_api.IdentityResolver(self.catalog).create_or_reuse_work(
            {"doi": "10.1000/jobs"}
        )
        self.work_version_id = resolution.work_version.id
        self.jobs = jobs_api.JobRepository(self.catalog)

    def table_count(self, table: str) -> int:
        with self.catalog.connect() as connection:
            return connection.exec_driver_sql(f'SELECT count(*) FROM "{table}"').scalar_one()

    def test_catalog_root_exports_job_and_domain_run_apis(self) -> None:
        expected = {
            "JobRepository": jobs_api.JobRepository,
            "LEGAL_JOB_STATE_TRANSITIONS": jobs_api.LEGAL_JOB_STATE_TRANSITIONS,
            "DomainRunRepository": domain_runs_api.DomainRunRepository,
            "LEGAL_DOMAIN_RUN_TRANSITIONS": domain_runs_api.LEGAL_DOMAIN_RUN_TRANSITIONS,
        }
        for name, value in expected.items():
            with self.subTest(name=name):
                self.assertIs(getattr(catalog_api, name), value)
                self.assertIn(name, catalog_api.__all__)

    def test_concurrent_admission_returns_one_nonterminal_job(self) -> None:
        def attach(index: int):
            return jobs_api.attach_or_create_job(
                self.catalog,
                self.work_version_id,
                enums.AssetRole.PRIMARY_PDF,
                f"request-{index}",
            )

        with ThreadPoolExecutor(max_workers=8) as executor:
            jobs = tuple(executor.map(attach, range(16)))
        self.assertEqual(len({job.id for job in jobs}), 1)
        self.assertEqual(self.table_count("acquisition_jobs"), 1)
        self.assertEqual(self.table_count("download_requests"), 16)
        with self.assertRaises(FrozenInstanceError):
            jobs[0].state = enums.JobState.ACTIVE

    def test_concurrent_same_doi_flow_creates_one_work_and_one_job(self) -> None:
        def acquire(index: int):
            work = catalog_api.IdentityResolver(self.catalog).create_or_reuse_work({"doi": "10.1000/concurrent-flow"}).work_version
            job = jobs_api.JobRepository(self.catalog).attach_or_create_job(
                work.id,
                "primary_pdf",
                f"flow-request-{index}",
            )
            return work.id, job.id

        with ThreadPoolExecutor(max_workers=8) as executor:
            results = tuple(executor.map(acquire, range(16)))
        work_ids = {work_id for work_id, _ in results}
        job_ids = {job_id for _, job_id in results}
        self.assertEqual(len(work_ids), 1)
        self.assertEqual(len(job_ids), 1)
        work_id = next(iter(work_ids))
        with self.catalog.connect() as connection:
            identifier_count = connection.exec_driver_sql(
                "SELECT count(*) FROM identifiers JOIN work_versions ON work_versions.work_id = identifiers.work_id WHERE work_versions.id = ?",
                (work_id,),
            ).scalar_one()
            nonterminal_job_count = connection.exec_driver_sql(
                "SELECT count(*) FROM acquisition_jobs "
                "WHERE work_version_id = ? AND state IN ('pending', 'active')",
                (work_id,),
            ).scalar_one()
        self.assertEqual(identifier_count, 1)
        self.assertEqual(nonterminal_job_count, 1)

    def test_duplicate_request_key_is_idempotent_and_conflicts_are_rejected(self) -> None:
        first = self.jobs.attach_or_create_job(
            self.work_version_id,
            "primary_pdf",
            "stable-key",
            request_provenance={"provider": "example"},
        )
        counts = (self.table_count("acquisition_jobs"), self.table_count("download_requests"), self.table_count("events"))
        second = self.jobs.attach_or_create_job(self.work_version_id, "primary_pdf", "stable-key")
        self.assertEqual(second, first)
        self.assertEqual(
            (self.table_count("acquisition_jobs"), self.table_count("download_requests"), self.table_count("events")),
            counts,
        )
        other_work = catalog_api.IdentityResolver(self.catalog).create_or_reuse_work({"doi": "10.1000/other"}).work_version
        with self.assertRaises(CatalogError):
            self.jobs.attach_or_create_job(other_work.id, "primary_pdf", "stable-key")

    def test_foreground_restart_and_terminal_history(self) -> None:
        first = self.jobs.attach_or_create_job(self.work_version_id, "primary_pdf")
        active = self.jobs.restart_foreground_job(first.id)
        self.assertEqual(active.state, enums.JobState.ACTIVE)
        succeeded = self.jobs.complete_job_and_requests(first.id, "succeeded")
        self.assertEqual(succeeded.state, enums.JobState.SUCCEEDED)
        with self.assertRaises(CatalogError):
            self.jobs.complete_job_and_requests(first.id, "failed")
        second = self.jobs.attach_or_create_job(self.work_version_id, "primary_pdf")
        self.assertNotEqual(second.id, first.id)
        self.assertEqual(self.table_count("acquisition_jobs"), 2)

    def test_retired_job_control_states_are_absent_and_rejected(self) -> None:
        self.assertFalse(hasattr(enums.JobState, "PAUSED"))
        self.assertFalse(hasattr(enums.JobState, "RETRYABLE"))
        job = self.jobs.attach_or_create_job(self.work_version_id, "xml")
        for state in ("paused", "retryable"):
            with self.subTest(state=state), self.assertRaises(IntegrityError):
                with self.catalog.critical_transaction() as connection:
                    connection.exec_driver_sql(
                        "UPDATE acquisition_jobs SET state = ? WHERE id = ?",
                        (state, job.id),
                    )

    def test_attempt_start_finish_events_and_failures(self) -> None:
        job = self.jobs.attach_or_create_job(self.work_version_id, "xml")
        with self.assertRaises(CatalogError):
            self.jobs.start_attempt(job.id, "provider")
        self.jobs.restart_foreground_job(job.id)
        attempt = self.jobs.start_attempt(
            job.id,
            "provider",
            source_url="https://example.test/article.xml",
            details={"b": 2, "a": 1},
        )
        self.assertEqual(attempt.details_json, '{"a":1,"b":2}')
        finished = self.jobs.finish_attempt(
            attempt.id,
            enums.AttemptOutcome.RETRYABLE,
            details={"reason": "temporary"},
        )
        self.assertEqual(finished.outcome, enums.AttemptOutcome.RETRYABLE)
        self.assertIsNotNone(finished.finished_at)
        with self.assertRaises(CatalogError):
            self.jobs.finish_attempt(attempt.id, "failed")

        event = self.jobs.append_event("acquisition_job", job.id, "job.note", {"b": 2, "a": 1})
        failure = self.jobs.append_failure(
            "provider_error",
            "temporary provider failure",
            work_version_id=self.work_version_id,
            job_id=job.id,
            attempt_id=attempt.id,
            retryable=True,
            details={"status": 503},
        )
        self.assertEqual(event.details_json, '{"a":1,"b":2}')
        self.assertTrue(failure.retryable)
        with self.assertRaises(FrozenInstanceError):
            failure.message = "changed"

    def test_candidate_checkpoint_repository_api_is_removed(self) -> None:
        self.assertFalse(hasattr(self.jobs, "update_active_attempt_details_json"))

    def test_acquisition_repository_redacts_direct_durable_payloads(self) -> None:
        marker = "FIXED-JOB-SECRET"
        path_marker = "PATH-CREDENTIAL-MARKER"
        arbitrary_marker = "ARBITRARY-RAW-EXCEPTION-BODY"
        job = self.jobs.attach_or_create_job(
            self.work_version_id,
            "xml",
            "redaction-key",
            request_provenance={"session": marker, "source_url": f"https://x.test/access/{path_marker}?token={marker}"},
        )
        self.jobs.restart_foreground_job(job.id)
        attempt = self.jobs.start_attempt(
            job.id,
            "provider",
            source_url=f"https://x.test/access/{path_marker}?signature={marker}",
            details={"headers": {"Authorization": f"Bearer {marker}"}},
        )
        event = self.jobs.append_event("acquisition_attempt", attempt.id, "attempt.note", {"cookie": marker})
        failure = self.jobs.append_failure(
            "provider_error",
            arbitrary_marker,
            job_id=job.id,
            attempt_id=attempt.id,
            details={"password": marker, "error_context": arbitrary_marker, "payload": RuntimeError(arbitrary_marker)},
        )
        durable = "\n".join(
            (
                self.jobs.get_request("redaction-key").provenance_json if self.jobs.get_request("redaction-key") is not None else "",
                attempt.source_url or "",
                attempt.details_json or "",
                event.details_json or "",
                failure.message,
                failure.details_json or "",
            )
        )
        self.assertNotIn(marker, durable)
        self.assertNotIn(path_marker, durable)
        self.assertNotIn(arbitrary_marker, durable)
        self.assertEqual(failure.message, "Acquisition failure recorded")
        self.assertEqual(json.loads(failure.details_json)["password"], "[REDACTED]")

    def test_durable_control_repository_apis_are_removed(self) -> None:
        for name in (
            "reserve_attempt",
            "transition_job",
            "latest_primary_document_start",
            "list_due_retryable_jobs",
            "pause_job",
            "retry_failed_job",
            "claim_job",
            "get_resume_state",
            "set_source_plan_if_absent",
            "set_source_plan_json_if_absent",
        ):
            self.assertFalse(hasattr(self.jobs, name), name)

    def test_atomic_job_cancellation_closes_all_unfinished_attempts_idempotently(self) -> None:
        job = self.jobs.attach_or_create_job(
            self.work_version_id, "primary_pdf", "cancel-all"
        )
        self.jobs.restart_foreground_job(job.id)
        finished = self.jobs.start_attempt(job.id, "finished")
        self.jobs.finish_attempt(finished.id, enums.AttemptOutcome.FAILED)
        unfinished = (
            self.jobs.start_attempt(job.id, "first"),
            self.jobs.start_attempt(job.id, "second"),
        )

        cancelled = self.jobs.cancel_job_and_requests(
            job.id,
            details={"diagnostic": {"summary": "Operation cancelled"}},
        )
        event_count = self.table_count("events")
        repeated = self.jobs.cancel_job_and_requests(job.id)

        self.assertEqual(cancelled.state, enums.JobState.CANCELLED)
        self.assertEqual(repeated, cancelled)
        self.assertEqual(self.table_count("events"), event_count)
        attempts = {attempt.id: attempt for attempt in self.jobs.list_attempts(job.id)}
        self.assertEqual(attempts[finished.id].outcome, enums.AttemptOutcome.FAILED)
        for attempt in unfinished:
            self.assertEqual(attempts[attempt.id].outcome, enums.AttemptOutcome.CANCELLED)
            self.assertIsNotNone(attempts[attempt.id].finished_at)
        self.assertEqual(self.jobs.list_requests(job.id)[0].status, "cancelled")

        with self.catalog.connect() as connection:
            event_types = connection.exec_driver_sql(
                "SELECT event_type FROM events WHERE subject_id = ? ORDER BY id",
                (job.id,),
            ).scalars().all()
        self.assertIn("acquisition.cancelled", event_types)
        self.assertIn("job.completed", event_types)

    def test_job_cancellation_does_not_rewrite_terminal_job(self) -> None:
        job = self.jobs.attach_or_create_job(self.work_version_id, "xml")
        self.jobs.restart_foreground_job(job.id)
        attempt = self.jobs.start_attempt(job.id, "provider")
        self.jobs.finish_attempt_and_job(attempt.id, "succeeded", "succeeded")
        events_before = self.table_count("events")
        returned = self.jobs.cancel_job_and_requests(job.id)
        self.assertEqual(returned.state, enums.JobState.SUCCEEDED)
        self.assertEqual(self.table_count("events"), events_before)


if __name__ == "__main__":
    import unittest

    unittest.main()
