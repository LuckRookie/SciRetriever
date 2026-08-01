from __future__ import annotations

import argparse
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import io
from pathlib import Path
from types import SimpleNamespace
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

from sciretriever.catalog import CompletionStage
from sciretriever.cli import analyze, catalog, download, expand, search
from sciretriever.cli.stage_admission import StageKind
from sciretriever.completion import BatchPolicy, BatchResult
from sciretriever.config import AnalysisConfig
from sciretriever.core.enums import AssetRole
from sciretriever.errors import StageAdmissionConflict


@contextmanager
def recording_admission(
    calls: list[tuple[Path | str, tuple[StageKind, ...]]],
    catalog_path: Path | str,
    stages: tuple[StageKind, ...],
):
    calls.append((catalog_path, stages))
    yield


class StageAdmissionWiringTests(unittest.TestCase):
    def test_download_holds_acquisition_around_required_and_optional_assets(self) -> None:
        calls: list[tuple[Path | str, tuple[StageKind, ...]]] = []
        args = argparse.Namespace(catalog=Path("catalog.sqlite"))
        with mock.patch.object(download, "admit_catalog_stages",
                               side_effect=lambda path, stages: recording_admission(calls, path, stages)), \
                mock.patch.object(download, "_execute", return_value=(BatchResult(BatchPolicy(), ()), [])):
            code = download.run(args)
        self.assertEqual(code, 0)
        self.assertEqual(calls, [(args.catalog, (StageKind.ACQUISITION,))])

    def test_analyze_holds_analysis_for_force_and_non_force_batches(self) -> None:
        for force in (False, True):
            calls: list[tuple[Path | str, tuple[StageKind, ...]]] = []
            args = argparse.Namespace(catalog=Path("catalog.sqlite"), force=force)
            result = SimpleNamespace(interrupted=False, to_dict=lambda *unused: {})
            with mock.patch.object(analyze, "admit_catalog_stages",
                                   side_effect=lambda path, stages: recording_admission(calls, path, stages)), \
                    mock.patch.object(analyze, "_execute", return_value=result):
                code = analyze.run(args)
            self.assertEqual(code, 0)
            self.assertEqual(calls, [(args.catalog, (StageKind.ANALYSIS,))])

    def test_search_maps_levels_to_no_acquisition_or_both_stages(self) -> None:
        expected = {
            "metadata": (),
            "download": (StageKind.ACQUISITION,),
            "analyze": (StageKind.ACQUISITION, StageKind.ANALYSIS),
        }
        for level, stages in expected.items():
            calls: list[tuple[Path | str, tuple[StageKind, ...]]] = []
            args = _search_args(level)
            runtime = _SearchRuntime()
            with mock.patch.object(search, "build_search_completion_runtime", return_value=runtime), \
                    mock.patch.object(search, "admit_catalog_stages",
                                      side_effect=lambda path, requested: recording_admission(calls, path, requested)), \
                    mock.patch.object(search, "run_completion_batch",
                                      return_value=BatchResult(BatchPolicy(), ())), \
                    redirect_stdout(io.StringIO()):
                code = search.run(args)
            self.assertEqual(code, 0)
            self.assertEqual(calls, [] if not stages else [(args.catalog, stages)])

    def test_exact_deep_search_conflict_prevents_runtime_construction(self) -> None:
        for level, stage in (("download", StageKind.ACQUISITION),
                             ("analyze", StageKind.ANALYSIS)):
            args = _search_args(level)
            args.query = "10.1000/exact"
            build = mock.Mock()
            error = io.StringIO()
            with mock.patch.object(search, "build_search_completion_runtime", build), \
                    mock.patch.object(search, "admit_catalog_stages",
                                      side_effect=StageAdmissionConflict(stage)), \
                    redirect_stderr(error):
                code = search.run(args)
            self.assertEqual(code, 1)
            build.assert_not_called()
            self.assertEqual(
                error.getvalue(),
                f"sciretriever: error: {stage.value} stage is already active\n",
            )

    def test_non_exact_deep_search_runs_metadata_before_stage_conflict(self) -> None:
        events: list[str] = []
        args = _search_args("download")
        runtime = _SearchRuntime(events)

        def conflict(unused_path: Path, unused_stages: tuple[StageKind, ...]) -> None:
            events.append("admission")
            raise StageAdmissionConflict(StageKind.ACQUISITION)

        with mock.patch.object(
                search, "build_search_completion_runtime",
                side_effect=lambda unused: events.append("runtime") or runtime,
            ), mock.patch.object(search, "admit_catalog_stages", side_effect=conflict), \
                redirect_stderr(io.StringIO()):
            code = search.run(args)

        self.assertEqual(code, 1)
        self.assertEqual(events, ["runtime", "metadata", "admission", "close"])

    def test_expand_depth_zero_takes_no_stage_and_deeper_takes_both(self) -> None:
        for depth, expected in ((0, []), (1, [(StageKind.ACQUISITION, StageKind.ANALYSIS)])):
            calls: list[tuple[Path | str, tuple[StageKind, ...]]] = []
            args = argparse.Namespace(catalog=Path("catalog.sqlite"), depth=depth)
            runtime = SimpleNamespace(
                execute=lambda unused: SimpleNamespace(interrupted=False, to_dict=lambda: {}),
                close=lambda: None,
            )
            with mock.patch.object(expand, "build_expand_runtime", return_value=runtime), \
                    mock.patch.object(expand, "admit_catalog_stages",
                                      side_effect=lambda path, stages: recording_admission(calls, path, stages)), \
                    redirect_stdout(io.StringIO()):
                code = expand.run(args)
            self.assertEqual(code, 0)
            self.assertEqual([stages for _, stages in calls], expected)

    def test_catalog_local_import_locks_only_complete_analysis(self) -> None:
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        storage = Path(temporary.name)
        for stop, expected in (("asset", []), ("complete", [(StageKind.ANALYSIS,)])):
            calls: list[tuple[Path | str, tuple[StageKind, ...]]] = []
            importer = mock.Mock()
            importer.import_asset.return_value = SimpleNamespace(
                disposition="imported", work_version_id="11111111-1111-4111-8111-111111111111",
                raw_asset_id="22222222-2222-4222-8222-222222222222", sha256="a" * 64,
            )
            engine = mock.Mock()
            completion = SimpleNamespace(
                pipeline=SimpleNamespace(ensure_complete=mock.AsyncMock()),
                facts=SimpleNamespace(get=lambda unused: SimpleNamespace(stage=CompletionStage.COMPLETE)),
            )
            args = argparse.Namespace(
                catalog=storage / "catalog.sqlite", storage_root=storage, asset=storage / "paper.pdf",
                asset_role=AssetRole.PRIMARY_PDF.value,
                work_version_id="11111111-1111-4111-8111-111111111111", stop=stop,
                _config_analysis=AnalysisConfig(),
            )
            with mock.patch.object(catalog, "_importer", return_value=(engine, importer)), \
                    mock.patch.object(catalog, "CompletionFactsRepository", return_value=completion.facts), \
                    mock.patch.object(catalog, "build_import_completion_runtime", return_value=completion), \
                    mock.patch.object(catalog, "admit_catalog_stages",
                                      side_effect=lambda path, stages: recording_admission(calls, path, stages)), \
                    redirect_stdout(io.StringIO()):
                code = catalog._import_asset(args)
            self.assertEqual(code, 0)
            self.assertEqual([stages for _, stages in calls], expected)
            importer.import_asset.assert_called_once()

    def test_conflicts_are_stage_only_and_prevent_command_execution(self) -> None:
        for module, args, stage in (
            (download, argparse.Namespace(catalog=Path("/secret/catalog.sqlite")), StageKind.ACQUISITION),
            (analyze, argparse.Namespace(catalog=Path("/secret/catalog.sqlite")), StageKind.ANALYSIS),
        ):
            error = io.StringIO()
            execute = mock.Mock()
            with mock.patch.object(module, "admit_catalog_stages",
                                   side_effect=StageAdmissionConflict(stage)), \
                    mock.patch.object(module, "_execute", execute), redirect_stderr(error):
                code = module.run(args)
            self.assertEqual(code, 1)
            execute.assert_not_called()
            self.assertEqual(error.getvalue(),
                             f"sciretriever: error: {stage.value} stage is already active\n")
            self.assertNotIn("secret", error.getvalue())


class _SearchRuntime:
    completion = SimpleNamespace(pipeline=object())

    def __init__(self, events: list[str] | None = None) -> None:
        self.events = events

    def search(self) -> SimpleNamespace:
        if self.events is not None:
            self.events.append("metadata")
        return SimpleNamespace(results=(), failures=())

    def targets(self, unused: SimpleNamespace) -> tuple[str, ...]:
        return ()

    def close(self) -> None:
        if self.events is not None:
            self.events.append("close")
        return None


def _search_args(level: str) -> argparse.Namespace:
    return argparse.Namespace(
        query="ordinary query", level=level, catalog=Path("catalog.sqlite"), storage_root=None,
        provider=["crossref"], precedence=["crossref"], filter=[], limit=1000, completion_limit=100,
        provider_timeout=30.0, max_concurrency=8, crossref_mailto=None,
        download_provider=["direct"], download_timeout=30.0, download_provider_concurrency=4,
        host_concurrency=2, host_min_interval=0.0, max_asset_bytes=1024,
        forbidden_urls=None, xml=False, html=False,
    )


if __name__ == "__main__":
    unittest.main()
