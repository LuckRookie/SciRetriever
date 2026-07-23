import argparse
import asyncio
import contextlib
from importlib import import_module
from io import BytesIO, StringIO
from pathlib import Path
import signal
import sys
from tempfile import TemporaryDirectory
import time
from unittest import TestCase, mock


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition import AcquisitionTarget, AdmissionService, ProviderContent
from sciretriever.acquisition.multi_orchestrator import MultiSourceOrchestrator
from sciretriever.acquisition.plan import RoutingMode, SourceEntry, SourcePlan
from sciretriever.catalog import AssetRepository, IdentityResolver, JobRepository, initialize_catalog, create_catalog_engine, open_catalog_engine
from sciretriever.cli import acquire as acquire_cli
from sciretriever.core.contracts import CandidateMetadata, DownloadManifestEntry, Identifier, Provenance
from sciretriever.core.enums import AssetRole, AttemptOutcome, JobState
from sciretriever.storage import AssetAcceptanceCoordinator, RawAssetStore


def pdf_bytes() -> bytes:
    stream = BytesIO()
    writer = import_module("PyPDF2").PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata({"/Subject": "foreground acquisition" * 100})
    writer.write(stream)
    return stream.getvalue()


class FakeProvider:
    def __init__(self, name: str, outcomes: list[object], *, delay: float = 0.0) -> None:
        self.name = name
        self.outcomes = outcomes
        self.delay = delay
        self.calls = 0

    def initial_url(self, target: AcquisitionTarget) -> str:
        return f"https://{self.name}.example/article.pdf"

    def acquire(self, target: AcquisitionTarget, *, timeout: float) -> ProviderContent:
        self.calls += 1
        if self.delay:
            time.sleep(min(self.delay, timeout))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        if not isinstance(outcome, bytes):
            raise TypeError("fake outcome must be bytes or an exception")
        return ProviderContent(
            AssetRole.PRIMARY_PDF,
            "application/pdf",
            "pdf",
            f"https://{self.name}.example/article.pdf",
            self.name,
            outcome,
            {"source": self.name},
        )


class ForegroundAcquisitionTests(TestCase):
    def setUp(self) -> None:
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.engine = create_catalog_engine(self.base / "catalog.sqlite")
        initialize_catalog(self.engine)
        self.addCleanup(self.engine.dispose)
        self.jobs = JobRepository(self.engine)
        assets = AssetRepository(self.engine)
        self.admission = AdmissionService(IdentityResolver(self.engine), self.jobs, assets)
        storage = self.base / "storage"
        storage.mkdir()
        self.coordinator = AssetAcceptanceCoordinator(assets, RawAssetStore(storage))

    @staticmethod
    def plan(*names: str, mode: RoutingMode = RoutingMode.SERIAL) -> SourcePlan:
        return SourcePlan(
            AssetRole.PRIMARY_PDF,
            mode,
            tuple(SourceEntry(f"source_{index}", name, index) for index, name in enumerate(names)),
        )

    def run_plan(
        self,
        doi: str,
        providers: dict[str, FakeProvider],
        plan: SourcePlan,
    ):
        identifiers = (Identifier("doi", doi),)
        admission = self.admission.admit(
            identifiers,
            provider="multi-source",
            source_plan=plan,
        )
        result = asyncio.run(
            MultiSourceOrchestrator(self.jobs, self.coordinator, providers).acquire(
                admission, AcquisitionTarget(identifiers), plan, timeout=1
            )
        )
        return admission, result

    def test_serial_fallback_and_immutable_asset_reuse(self) -> None:
        first = FakeProvider("first", [ValueError("invalid body")])
        second = FakeProvider("second", [pdf_bytes()])
        plan = self.plan("first", "second")
        admission, result = self.run_plan("10.1/serial", {"first": first, "second": second}, plan)
        self.assertEqual(result.status, "succeeded")
        self.assertEqual((first.calls, second.calls), (1, 1))

        replay = FakeProvider("first", [AssertionError("asset was downloaded twice")])
        _, reused = self.run_plan("10.1/serial", {"first": replay, "second": second}, plan)
        self.assertEqual(reused.status, "reused")
        self.assertEqual(reused.raw_asset_id, result.raw_asset_id)
        self.assertEqual(replay.calls, 0)
        self.assertEqual(self.jobs.get_job(admission.job_id).state, JobState.SUCCEEDED)

    def test_failed_and_stale_work_reruns_from_first_source_without_checkpoint(self) -> None:
        first = FakeProvider("first", [TimeoutError("temporary"), pdf_bytes()])
        second = FakeProvider("second", [ValueError("missing")])
        plan = self.plan("first", "second")
        admission, failed = self.run_plan("10.1/rerun", {"first": first, "second": second}, plan)
        self.assertEqual(failed.status, "failed")
        self.assertEqual((first.calls, second.calls), (1, 1))

        stale_job = self.jobs.get_job(admission.job_id)
        self.assertEqual(stale_job.state, JobState.FAILED)
        _, succeeded = self.run_plan("10.1/rerun", {"first": first, "second": second}, plan)
        self.assertEqual(succeeded.status, "succeeded")
        self.assertEqual(first.calls, 2)
        attempts = self.jobs.list_attempts(admission.job_id)
        self.assertTrue(all(attempt.finished_at is not None for attempt in attempts))
        self.assertTrue(all('"candidates"' not in (attempt.details_json or "") for attempt in attempts))
        self.assertFalse(hasattr(self.jobs, "update_active_attempt_details_json"))

    def test_stale_active_attempt_is_closed_before_foreground_rerun(self) -> None:
        identifiers = (Identifier("doi", "10.1/stale"),)
        plan = self.plan("source")
        admission = self.admission.admit(identifiers, provider="multi-source", source_plan=plan)
        self.jobs.restart_foreground_job(admission.job_id)
        stale = self.jobs.start_attempt(admission.job_id, "source", details={"diagnostic": "old"})
        provider = FakeProvider("source", [pdf_bytes()])
        result = asyncio.run(
            MultiSourceOrchestrator(self.jobs, self.coordinator, {"source": provider}).acquire(
                admission, AcquisitionTarget(identifiers), plan, timeout=1
            )
        )
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(self.jobs.get_attempt(stale.id).outcome, AttemptOutcome.CANCELLED)

    def test_race_accepts_one_winner_and_prevents_late_loser_acceptance(self) -> None:
        fast = FakeProvider("fast", [pdf_bytes()])
        slow = FakeProvider("slow", [pdf_bytes()], delay=0.05)
        plan = self.plan("fast", "slow", mode=RoutingMode.RACE)
        admission, result = self.run_plan("10.1/race", {"fast": fast, "slow": slow}, plan)
        self.assertEqual(result.status, "succeeded")
        links = AssetRepository(self.engine).get_work_version_assets(admission.work_version_id)
        self.assertEqual(len(links), 1)
        attempts = self.jobs.list_attempts(admission.job_id)
        self.assertEqual(sum(item.outcome is AttemptOutcome.SUCCEEDED for item in attempts), 1)
        self.assertEqual(sum(item.outcome is AttemptOutcome.CANCELLED for item in attempts), 1)
        self.assertTrue(all(item.finished_at is not None for item in attempts))

    def test_signal_requests_stop_and_later_manifest_records_are_not_started(self) -> None:
        args = argparse.Namespace()
        captured: dict[int, object] = {}

        def install(signum: int, handler: object) -> object:
            captured[signum] = handler
            return signal.SIG_DFL

        async def execute(received: argparse.Namespace, *, on_success=None):
            handler = captured[signal.SIGTERM]
            if not callable(handler):
                raise AssertionError("SIGTERM handler was not installed")
            handler(signal.SIGTERM, None)
            self.assertTrue(received._stop_requested)
            return 1, 0

        output = StringIO()
        with (
            mock.patch.object(signal, "getsignal", return_value=signal.SIG_DFL),
            mock.patch.object(signal, "signal", side_effect=install),
            mock.patch.object(acquire_cli, "_execute_async", new=execute),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(acquire_cli.run(args), 0)
        self.assertIn("1 succeeded", output.getvalue())

    def test_execute_async_stops_between_manifest_records_after_first_commit(self) -> None:
        entries = (
            DownloadManifestEntry(
                (Identifier("doi", "10.1/stop-first"),),
                CandidateMetadata(title="First"),
                (),
                True,
                False,
                None,
                Provenance(("crossref",), "2026-07-23T00:00:00Z", "run"),
            ),
            DownloadManifestEntry(
                (Identifier("doi", "10.1/stop-second"),),
                CandidateMetadata(title="Second"),
                (),
                True,
                False,
                None,
                Provenance(("crossref",), "2026-07-23T00:00:00Z", "run"),
            ),
        )
        manifest = self.base / "stop.jsonl"
        manifest.write_text(
            "\n".join(entry.to_json_line() for entry in entries) + "\n",
            encoding="utf-8",
        )
        args = mock.Mock(
            manifest=manifest,
            doi=None,
            url=None,
            catalog=self.base / "stop-catalog.sqlite",
            storage_root=self.base / "stop-storage",
            provider="crossref",
            timeout=1.0,
            forbidden_urls=None,
            source_plan=None,
            providers=None,
            asset_role="primary_pdf",
            routing="serial",
            host_concurrency=2,
            host_min_interval=0.0,
            _stop_requested=False,
            _config_credentials=None,
        )
        catalog = create_catalog_engine(args.catalog)
        initialize_catalog(catalog)
        catalog.dispose()
        args.storage_root.mkdir()

        class StopProvider(FakeProvider):
            name = "crossref"

            def initial_url(self, target: AcquisitionTarget) -> str:
                return "https://crossref.example/article.pdf?token=STOP-SECRET"

            def acquire(self, target: AcquisitionTarget, *, timeout: float) -> ProviderContent:
                super().acquire(target, timeout=timeout)
                args._stop_requested = True
                return ProviderContent(
                    AssetRole.PRIMARY_PDF,
                    "application/pdf",
                    "pdf",
                    "https://crossref.example/article.pdf?token=STOP-SECRET",
                    self.name,
                    pdf_bytes(),
                    {"token": "STOP-SECRET"},
                )

        provider = StopProvider("crossref", [pdf_bytes()])
        with mock.patch.object(acquire_cli, "_provider", return_value=provider):
            self.assertEqual(asyncio.run(acquire_cli._execute_async(args)), (1, 0))

        catalog = open_catalog_engine(args.catalog)
        self.addCleanup(catalog.dispose)
        with catalog.connect() as connection:
            first_work_version_id = connection.exec_driver_sql(
                "SELECT works.preferred_work_version_id FROM identifiers "
                "JOIN works ON works.id = identifiers.work_id "
                "WHERE identifiers.namespace = ? AND identifiers.value = ?",
                ("doi", "10.1/stop-first"),
            ).scalar_one()
            second_count = connection.exec_driver_sql(
                "SELECT count(*) FROM identifiers WHERE namespace = ? AND value = ?",
                ("doi", "10.1/stop-second"),
            ).scalar_one()
            work_count = connection.exec_driver_sql("SELECT count(*) FROM works").scalar_one()
            job = connection.exec_driver_sql(
                "SELECT id, state FROM acquisition_jobs"
            ).one()
            attempt = connection.exec_driver_sql(
                "SELECT outcome, finished_at, details_json FROM acquisition_attempts"
            ).one()
        assets = AssetRepository(catalog)
        links = assets.get_work_version_assets(first_work_version_id)
        self.assertEqual(len(links), 1)
        raw_asset = assets.get_raw_asset(links[0].raw_asset_id)
        assert raw_asset is not None
        self.assertEqual(work_count, 1)
        self.assertEqual(job.state, JobState.SUCCEEDED.value)
        self.assertEqual(attempt.outcome, AttemptOutcome.SUCCEEDED.value)
        self.assertIsNotNone(attempt.finished_at)
        self.assertEqual(second_count, 0)
        self.assertEqual(provider.calls, 1)
        self.assertNotIn(
            "STOP-SECRET",
            "\n".join((raw_asset.provenance_json, attempt.details_json or "")),
        )


if __name__ == "__main__":
    import unittest

    unittest.main()
