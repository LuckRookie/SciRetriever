from __future__ import annotations

import argparse
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

from sciretriever.catalog import CompletionStage
from sciretriever.cli import analyze, catalog, download
from sciretriever.cli.completion_context import CommandCompletionRuntime
from sciretriever.completion import (
    BatchItemResult,
    BatchItemStatus,
    BatchPolicy,
    BatchResult,
    CompletionStop,
    ForceAnalysisBatchItem,
    ForceAnalysisBatchResult,
    OutcomeReason,
    WorkVersionTarget,
)
from sciretriever.core.enums import AssetRole
from sciretriever.config import AnalysisConfig


VERSION_A = "11111111-1111-4111-8111-111111111111"
VERSION_B = "22222222-2222-4222-8222-222222222222"
REPOSITORY = Path(__file__).resolve().parents[1]


class FreshProcessRuntimeImportTests(unittest.TestCase):
    def test_runtime_modules_and_affected_cli_help_import_in_fresh_processes(self) -> None:
        commands = (
            ("-c", "import sciretriever.cli.completion_runtime"),
            (
                "-c",
                "from sciretriever.cli.analysis_runtime import AnalysisRuntimeServices; "
                "assert AnalysisRuntimeServices.__module__ == "
                "'sciretriever.cli.analysis_runtime'",
            ),
            ("-m", "sciretriever.cli.main", "--help"),
            ("-m", "sciretriever.cli.main", "download", "--help"),
            ("-m", "sciretriever.cli.main", "analyze", "--help"),
            ("-m", "sciretriever.cli.main", "catalog", "import-asset", "--help"),
        )

        for arguments in commands:
            with self.subTest(arguments=arguments):
                result = subprocess.run(
                    [sys.executable, *arguments],
                    cwd=REPOSITORY,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)


class RuntimeFake:
    def __init__(self) -> None:
        self.closed = False
        self.catalog = mock.Mock()
        self.completion = SimpleNamespace(pipeline=mock.Mock())

    def close(self) -> None:
        self.closed = True


def batch(*versions: str, interrupted: bool = False) -> BatchResult:
    items = [
        BatchItemResult.succeeded(
            WorkVersionTarget(version), version, CompletionStage.ANALYSIS_PENDING
        )
        for version in versions
    ]
    if interrupted:
        items.append(BatchItemResult.interrupted(WorkVersionTarget(VERSION_B)))
    return BatchResult(BatchPolicy(), tuple(items))


class DownloadCompletionCommandTests(unittest.TestCase):
    def test_every_download_selector_preserves_repository_order(self) -> None:
        repository = mock.Mock()
        expected = (VERSION_A, VERSION_B)
        for selected in (
            repository.select_exact.return_value,
            repository.select_all_missing_primary_pdf.return_value,
            repository.select_library.return_value,
        ):
            selected.work_version_ids = expected
        cases = (
            argparse.Namespace(work_version_id=VERSION_A, work_id=None, all_missing=False,
                               query=None, author=None, year=None, publisher=None, venue=None,
                               tag=None, limit=10),
            argparse.Namespace(work_version_id=None, work_id=VERSION_B, all_missing=False,
                               query=None, author=None, year=None, publisher=None, venue=None,
                               tag=None, limit=10),
            argparse.Namespace(work_version_id=None, work_id=None, all_missing=True,
                               query=None, author=None, year=None, publisher=None, venue=None,
                               tag=None, limit=10),
            argparse.Namespace(work_version_id=None, work_id=None, all_missing=False,
                               query="q", author="Ada", year=2024, publisher="Press",
                               venue="Journal", tag="tag", limit=10),
        )

        for args in cases:
            with self.subTest(args=args):
                self.assertEqual(download._selection(repository, args), expected)

    def test_every_selector_uses_shared_asset_batch_in_stable_order(self) -> None:
        runtime = RuntimeFake()
        result = batch(VERSION_A, VERSION_B)
        repository = mock.Mock()
        repository.select_library.return_value.work_version_ids = (VERSION_A, VERSION_B)
        args = argparse.Namespace(
            catalog=Path("catalog.sqlite"), storage_root=Path("storage"),
            work_version_id=None, work_id=None, all_missing=False, query="q",
            author=None, year=None, publisher=None, venue=None, tag=None, limit=10,
            xml=False, html=False,
        )

        with mock.patch.object(download, "build_download_completion_runtime", return_value=runtime), \
                mock.patch.object(download, "WorkVersionDownloadRepository", return_value=repository), \
                mock.patch.object(download, "run_completion_batch", return_value=result) as run_batch:
            observed, optional = download._execute(args)

        self.assertEqual(observed, result)
        self.assertEqual(optional, [])
        self.assertEqual(
            run_batch.call_args.args[1],
            (WorkVersionTarget(VERSION_A), WorkVersionTarget(VERSION_B)),
        )
        self.assertIs(run_batch.call_args.args[2], CompletionStop.ASSET)
        self.assertTrue(runtime.closed)

    def test_optional_xml_html_are_explicit_and_do_not_change_stage(self) -> None:
        runtime = CommandCompletionRuntime(mock.Mock(), mock.Mock())
        runtime.completion.pipeline.acquire_optional = mock.AsyncMock(
            side_effect=lambda request: SimpleNamespace(
                stage_before=CompletionStage.ANALYSIS_PENDING,
                stage_after=CompletionStage.ANALYSIS_PENDING,
                to_dict=lambda: {"kind": request.kind.value},
            )
        )
        args = argparse.Namespace(xml=True, html=True)

        optional = download._acquire_optional(runtime, args, batch(VERSION_A))

        self.assertEqual([item["kind"] for item in optional], ["xml", "html"])

    def test_interrupted_batch_returns_exit_130(self) -> None:
        output = io.StringIO()
        with mock.patch.object(download, "_execute", return_value=(
                    batch(VERSION_A, interrupted=True), [])), \
                contextlib.redirect_stdout(output):
            code = download.run(argparse.Namespace())

        self.assertEqual(code, 130)
        self.assertTrue(json.loads(output.getvalue())["interrupted"])


class AnalyzeCompletionCommandTests(unittest.TestCase):
    def test_non_force_routes_to_complete_batch(self) -> None:
        runtime = RuntimeFake()
        result = batch(VERSION_A)
        args = argparse.Namespace(force=False)

        with mock.patch.object(analyze, "_selected_targets", return_value=(WorkVersionTarget(VERSION_A),)), \
                mock.patch.object(analyze, "build_analysis_completion_runtime", return_value=runtime), \
                mock.patch.object(analyze, "WorkVersionAnalysisRepository"), \
                mock.patch.object(analyze, "run_completion_batch", return_value=result) as run_batch:
            observed = analyze._execute(args)

        self.assertEqual(observed, result)
        self.assertIs(run_batch.call_args.args[2], CompletionStop.COMPLETE)
        self.assertTrue(runtime.closed)

    def test_force_routes_to_shared_force_batch_and_preserves_failed_current(self) -> None:
        runtime = RuntimeFake()
        result = ForceAnalysisBatchResult((
            ForceAnalysisBatchItem(
                WorkVersionTarget(VERSION_B), BatchItemStatus.FAILED,
                reason=OutcomeReason.UNEXPECTED_FAILURE,
            ),
        ))
        args = argparse.Namespace(force=True)

        with mock.patch.object(analyze, "_selected_targets", return_value=(
                    WorkVersionTarget(VERSION_A), WorkVersionTarget(VERSION_B))), \
                mock.patch.object(analyze, "build_analysis_completion_runtime", return_value=runtime), \
                mock.patch.object(analyze, "WorkVersionAnalysisRepository"), \
                mock.patch.object(analyze, "run_force_analysis_batch", return_value=result) as force_batch:
            observed = analyze._execute(args)

        self.assertEqual(observed, result)
        force_batch.assert_called_once()
        self.assertEqual(result.failed, 1)
        self.assertTrue(runtime.closed)


