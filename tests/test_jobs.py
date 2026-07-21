import importlib
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


class JobTests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.path = Path(self.temporary_directory.name) / "catalog.sqlite"
        self.catalog = catalog_api.create_catalog_engine(self.path)
        self.addCleanup(self.catalog.dispose)
        catalog_api.apply_migrations(self.catalog)
        resolution = catalog_api.IdentityResolver(self.catalog).create_or_reuse_work(
            {"doi": "10.1000/jobs"}
        )
        self.work_id = resolution.work.id
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
                self.work_id,
                enums.AssetRole.PRIMARY_PDF,
                f"request-{index}",
                source_plan={"providers": ["example"], "rank": 1},
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
            work = catalog_api.IdentityResolver(self.catalog).create_or_reuse_work(
                {"doi": "10.1000/concurrent-flow"}
            ).work
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
                "SELECT count(*) FROM identifiers WHERE work_id = ?",
                (work_id,),
            ).scalar_one()
            nonterminal_job_count = connection.exec_driver_sql(
                "SELECT count(*) FROM acquisition_jobs "
                "WHERE work_id = ? AND state IN ('pending', 'active', 'retryable', 'paused')",
                (work_id,),
            ).scalar_one()
        self.assertEqual(identifier_count, 1)
        self.assertEqual(nonterminal_job_count, 1)

    def test_duplicate_request_key_is_idempotent_and_conflicts_are_rejected(self) -> None:
        first = self.jobs.attach_or_create_job(
            self.work_id,
            "primary_pdf",
            "stable-key",
            request_provenance={"provider": "example"},
        )
        counts = (self.table_count("acquisition_jobs"), self.table_count("download_requests"), self.table_count("events"))
        second = self.jobs.attach_or_create_job(self.work_id, "primary_pdf", "stable-key")
        self.assertEqual(second, first)
        self.assertEqual(
            (self.table_count("acquisition_jobs"), self.table_count("download_requests"), self.table_count("events")),
            counts,
        )
        other_work = catalog_api.IdentityResolver(self.catalog).create_or_reuse_work(
            {"doi": "10.1000/other"}
        ).work
        with self.assertRaises(CatalogError):
            self.jobs.attach_or_create_job(other_work.id, "primary_pdf", "stable-key")

    def test_legal_transitions_terminal_history_and_illegal_transition(self) -> None:
        first = self.jobs.attach_or_create_job(self.work_id, "primary_pdf")
        active = self.jobs.transition_job(first.id, enums.JobState.ACTIVE)
        self.assertEqual(active.state, enums.JobState.ACTIVE)
        succeeded = self.jobs.transition_job(first.id, "succeeded")
        self.assertEqual(succeeded.state, enums.JobState.SUCCEEDED)
        with self.assertRaises(CatalogError):
            self.jobs.transition_job(first.id, "active")
        second = self.jobs.attach_or_create_job(self.work_id, "primary_pdf")
        self.assertNotEqual(second.id, first.id)
        self.assertEqual(self.table_count("acquisition_jobs"), 2)

    def test_attempt_start_finish_events_and_failures(self) -> None:
        job = self.jobs.attach_or_create_job(self.work_id, "xml")
        with self.assertRaises(CatalogError):
            self.jobs.start_attempt(job.id, "provider")
        self.jobs.transition_job(job.id, "active")
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
            work_id=self.work_id,
            job_id=job.id,
            attempt_id=attempt.id,
            retryable=True,
            details={"status": 503},
        )
        self.assertEqual(event.details_json, '{"a":1,"b":2}')
        self.assertTrue(failure.retryable)
        with self.assertRaises(FrozenInstanceError):
            failure.message = "changed"


if __name__ == "__main__":
    import unittest

    unittest.main()
