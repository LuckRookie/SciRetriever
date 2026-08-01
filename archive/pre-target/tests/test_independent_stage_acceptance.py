from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import multiprocessing
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
import unittest
from uuid import uuid4

import anyio

from sciretriever.catalog import (
    CompletionStage, IdentityResolver,
)
from sciretriever.cli import analyze, discover, download, search
from sciretriever.cli.stage_admission import StageKind, admit_catalog_stages
from sciretriever.completion import (
    CompletionResult, CompletionStop, DoiTarget, WorkVersionTarget,
)
from sciretriever.config import MinerUConfig
from sciretriever.core.enums import AssetRole
from sciretriever.discovery.search_contracts import ExactMetadataRequest
from sciretriever.normalization import MinerUParsingService
from sciretriever.normalization.mineru_contracts import MinerUTaskStatus
from sciretriever.storage import DerivedArtifactStore

from test_completion_acceptance_fixture import pdf_bytes
from test_mineru_wp42 import ScriptedClient, TASK_ONE
from test_mineru_wp43 import archive_bytes
from wp6_acceptance_runtime import (
    AcceptanceRuntime, contend_stage, hold_stage, write_metadata,
)


class IndependentStageAcceptanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-stage-acceptance-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        pdf = self.root / "fixture.pdf"
        pdf.write_bytes(pdf_bytes())
        self.runtime = AcceptanceRuntime(self.root, pdf)
        self.addCleanup(self.runtime.close)

    def test_independent_stages_converge_and_replay_without_duplicate_calls(self) -> None:
        def ingest(doi: str) -> str:
            output = self.runtime.metadata.resolve(ExactMetadataRequest(
                doi, ("fixture",), ("fixture",), 1.0, 1
            ))
            if output.result is None:
                self.fail("offline metadata did not resolve")
            return output.result.work_version.id

        acquisition_id = ingest("10.1234/independent-acquisition")
        analysis_id = ingest("10.1234/independent-analysis")
        anyio.run(self.runtime.runtime.pipeline.ensure_complete,
                  WorkVersionTarget(analysis_id), CompletionStop.ASSET)
        barrier = Barrier(3)
        self.runtime.metadata.barrier = barrier
        self.runtime.acquisition.barrier = barrier
        self.runtime.analysis.barrier = barrier

        def complete(target, stop):
            return anyio.run(self.runtime.runtime.pipeline.ensure_complete, target, stop)

        with ThreadPoolExecutor(max_workers=3) as executor:
            metadata_future = executor.submit(
                complete, DoiTarget("10.1234/independent-metadata"), CompletionStop.METADATA
            )
            acquisition_future = executor.submit(
                complete, WorkVersionTarget(acquisition_id), CompletionStop.ASSET
            )
            analysis_future = executor.submit(
                complete, WorkVersionTarget(analysis_id), CompletionStop.COMPLETE
            )
            metadata_result = metadata_future.result()
            acquisition_result = acquisition_future.result()
            analysis_result = analysis_future.result()
        self.runtime.metadata.barrier = None
        self.runtime.acquisition.barrier = None
        self.runtime.analysis.barrier = None
        self.assertTrue(all(isinstance(result, CompletionResult) for result in (
            metadata_result, acquisition_result, analysis_result,
        )))
        if not isinstance(metadata_result, CompletionResult):
            self.fail("concurrent metadata did not resolve")
        self.assertEqual(self.runtime.facts.get(metadata_result.work_version_id).stage,
                         CompletionStage.ASSET_PENDING)
        self.assertEqual(self.runtime.facts.get(acquisition_id).stage,
                         CompletionStage.ANALYSIS_PENDING)
        self.assertEqual(self.runtime.facts.get(analysis_id).stage, CompletionStage.COMPLETE)
        anyio.run(self.runtime.runtime.pipeline.ensure_complete,
                  WorkVersionTarget(acquisition_id), CompletionStop.COMPLETE)
        before = (
            self.runtime.metadata.calls, self.runtime.acquisition.calls,
            self.runtime.analysis.calls, self.runtime.provider.calls,
            self.runtime.mineru.submissions,
            self.runtime.snapshot(),
        )
        first_facts = self.runtime.facts.get(acquisition_id)
        second_facts = self.runtime.facts.get(analysis_id)
        with self.runtime.catalog.connect() as connection:
            journal_mode = connection.exec_driver_sql("PRAGMA journal_mode").scalar_one()
            raw_path = connection.exec_driver_sql(
                "SELECT storage_path FROM raw_assets WHERE id = ?",
                (first_facts.primary_pdf_id,),
            ).scalar_one()
            analysis_input = connection.exec_driver_sql(
                "SELECT r.input_raw_asset_id FROM current_analyses c "
                "JOIN processing_runs r ON r.id = c.processing_run_id "
                "WHERE c.id = ?",
                (first_facts.current_analysis_id,),
            ).scalar_one()
            table_names = set(connection.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).scalars())
        immutable = (self.runtime.storage / raw_path).stat()

        anyio.run(self.runtime.runtime.pipeline.ensure_complete,
                  WorkVersionTarget(acquisition_id), CompletionStop.COMPLETE)
        anyio.run(self.runtime.runtime.pipeline.ensure_complete,
                  WorkVersionTarget(analysis_id), CompletionStop.COMPLETE)

        self.assertEqual((self.runtime.metadata.calls, self.runtime.acquisition.calls,
                          self.runtime.analysis.calls, self.runtime.provider.calls,
                          self.runtime.mineru.submissions,
                          self.runtime.snapshot()), before)
        self.assertEqual(before[:5], (3, 2, 2, 2, 2))
        self.assertEqual(journal_mode, "wal")
        self.assertEqual(analysis_input, first_facts.primary_pdf_id)
        self.assertEqual(first_facts.primary_pdf_id,
                         self.runtime.facts.get(acquisition_id).primary_pdf_id)
        self.assertIsNotNone(first_facts.current_analysis_id)
        self.assertIsNotNone(second_facts.current_analysis_id)
        self.assertEqual((immutable.st_ino, immutable.st_size), (
            (self.runtime.storage / raw_path).stat().st_ino,
            (self.runtime.storage / raw_path).stat().st_size,
        ))
        self.assertFalse(any("workflow" in name for name in table_names))

    def test_process_overlap_excludes_same_stage_and_preserves_metadata(self) -> None:
        context = multiprocessing.get_context("spawn")
        acquisition_ready, analysis_ready = context.Event(), context.Event()
        acquisition_release, analysis_release = context.Event(), context.Event()
        acquisition = context.Process(target=hold_stage, args=(
            str(self.runtime.catalog.path), StageKind.ACQUISITION,
            acquisition_ready, acquisition_release,
        ))
        analysis = context.Process(target=hold_stage, args=(
            str(self.runtime.catalog.path), StageKind.ANALYSIS,
            analysis_ready, analysis_release,
        ))
        acquisition.start()
        analysis.start()
        self.addCleanup(lambda: acquisition.kill() if acquisition.is_alive() else None)
        self.addCleanup(lambda: analysis.kill() if analysis.is_alive() else None)
        self.assertTrue(acquisition_ready.wait(10))
        self.assertTrue(analysis_ready.wait(10))
        output = context.Queue()
        metadata = context.Process(target=write_metadata, args=(
            str(self.runtime.catalog.path), output,
        ))
        metadata.start()
        metadata.join(10)
        self.assertEqual(metadata.exitcode, 0)
        metadata_id = output.get(timeout=2)

        for stage in (StageKind.ACQUISITION, StageKind.ANALYSIS):
            sentinel = self.root / f"{stage.value}-external"
            contender = context.Process(target=contend_stage, args=(
                str(self.runtime.catalog.path), stage, str(sentinel), output,
            ))
            contender.start()
            contender.join(10)
            self.assertEqual(contender.exitcode, 0)
            self.assertEqual(output.get(timeout=2), (1, stage.value))
            self.assertFalse(sentinel.exists())
        self.assertEqual(self.runtime.facts.get(metadata_id).stage,
                         CompletionStage.ASSET_PENDING)

        acquisition.kill()
        acquisition.join(10)
        with admit_catalog_stages(self.runtime.catalog.path, (StageKind.ACQUISITION,)):
            pass
        self.assertEqual(self.runtime.facts.get(metadata_id).stage,
                         CompletionStage.ASSET_PENDING)
        analysis_release.set()
        analysis.join(10)
        self.assertEqual(analysis.exitcode, 0)

    def test_defaults_and_interrupted_mineru_resume_are_stable(self) -> None:
        parsers = tuple(argparse.ArgumentParser() for _ in range(4))
        discover.configure_parser(parsers[0])
        search.configure_parser(parsers[1])
        download.configure_parser(parsers[2])
        analyze.configure_parser(parsers[3])
        self.assertEqual(tuple(parser.get_default("limit") for parser in parsers),
                         (1000, 1000, 100, 100))
        self.assertEqual(parsers[1].get_default("completion_limit"), 100)

        work_id = IdentityResolver(self.runtime.catalog).create_or_reuse_work(
            {"doi": "10.1234/mineru-resume"}
        ).work_version.id
        pdf = b"%PDF-x"
        raw_id = str(uuid4())
        sha = hashlib.sha256(pdf).hexdigest()
        with self.runtime.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, "
                "byte_size, provenance_json) VALUES (?, ?, ?, 'application/pdf', 'pdf', ?, '{}')",
                (raw_id, sha, f"raw/{sha[:2]}/{sha}", len(pdf)),
            )
            connection.exec_driver_sql(
                "INSERT INTO work_version_assets (work_version_id, raw_asset_id, asset_role) "
                "VALUES (?, ?, ?)", (work_id, raw_id, AssetRole.PRIMARY_PDF.value),
            )
        client = ScriptedClient([], interrupt_status=True)
        service = MinerUParsingService(
            self.runtime.catalog, DerivedArtifactStore(self.runtime.storage),
            MinerUConfig(mode="loopback", endpoint="http://127.0.0.1:8000", model="acceptance"),
            client, sleep=lambda unused: None,
        )
        with self.assertRaises(KeyboardInterrupt):
            service.run(work_id, raw_id, pdf)
        client.interrupt_status = False
        client.statuses.append(MinerUTaskStatus.COMPLETED)
        result = service.run(work_id, raw_id, pdf)
        attempts = service.attempts.list_for_run(result.run.id)
        self.assertEqual(client.submissions, 1)
        self.assertEqual(client.status_task_ids, [TASK_ONE, TASK_ONE])
        self.assertEqual([attempt.external_task_id for attempt in attempts], [TASK_ONE])
        self.assertEqual([attempt.state for attempt in attempts], ["succeeded"])


if __name__ == "__main__":
    unittest.main()
