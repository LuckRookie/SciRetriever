from __future__ import annotations

import argparse
import contextlib
import io
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

from sciretriever.catalog import CompletionStage
from sciretriever.cli import analyze, catalog, download
from sciretriever.completion import CompletionStop, WorkVersionTarget
from sciretriever.config import AnalysisConfig
from sciretriever.core.enums import AssetRole

from test_cli_completion_backfill_wp5 import RuntimeFake

VERSION_A = "11111111-1111-4111-8111-111111111111"
VERSION_B = "22222222-2222-4222-8222-222222222222"
REPOSITORY = Path(__file__).resolve().parents[1]


class CatalogImportCompletionTests(unittest.TestCase):
    def test_primary_pdf_import_reuses_one_catalog_engine_and_one_close_owner(self) -> None:
        imported = SimpleNamespace(
            disposition="replayed", work_version_id=VERSION_A,
            raw_asset_id=VERSION_B, sha256="a" * 64,
        )
        engine = mock.Mock()
        importer = mock.Mock()
        importer.import_asset.return_value = imported
        completion = SimpleNamespace(pipeline=SimpleNamespace(
            ensure_complete=mock.AsyncMock()
        ), facts=SimpleNamespace(get=lambda _: SimpleNamespace(
            stage=CompletionStage.ANALYSIS_PENDING
        )))
        args = argparse.Namespace(
            catalog="catalog.sqlite", storage_root=".", asset="article.pdf",
            asset_role=AssetRole.PRIMARY_PDF.value, work_version_id=VERSION_A,
            stop="asset", _config_analysis=None,
        )

        with mock.patch.object(catalog, "_importer", return_value=(engine, importer)), \
                mock.patch.object(catalog, "CompletionFactsRepository", return_value=SimpleNamespace(
                    get=lambda _: SimpleNamespace(stage=CompletionStage.ANALYSIS_PENDING))), \
                mock.patch.object(
                    catalog, "build_import_completion_runtime", return_value=completion
                ) as build:
            catalog._import_asset(args)

        self.assertIs(build.call_args.args[0].catalog, engine)
        engine.dispose.assert_called_once_with()

    def test_disabled_analysis_config_infers_explicit_asset_stop(self) -> None:
        imported = SimpleNamespace(
            disposition="imported", work_version_id=VERSION_A,
            raw_asset_id=VERSION_B, sha256="a" * 64,
        )
        importer = mock.Mock()
        importer.import_asset.return_value = imported
        runtime = RuntimeFake()
        runtime.completion.pipeline.ensure_complete = mock.AsyncMock()
        runtime.completion.facts = SimpleNamespace(get=lambda _: SimpleNamespace(
            stage=CompletionStage.ANALYSIS_PENDING
        ))
        args = argparse.Namespace(
            catalog="catalog.sqlite", storage_root=".", asset="article.pdf",
            asset_role=AssetRole.PRIMARY_PDF.value, work_version_id=VERSION_A,
            stop=None, _config_analysis=AnalysisConfig(),
        )

        with mock.patch.object(catalog, "_importer", return_value=(mock.Mock(), importer)), \
                mock.patch.object(catalog, "CompletionFactsRepository", return_value=SimpleNamespace(
                    get=lambda _: SimpleNamespace(stage=CompletionStage.ANALYSIS_PENDING))), \
                mock.patch.object(
                    catalog, "build_import_completion_runtime", return_value=runtime.completion
                ) as build:
            catalog._import_asset(args)

        self.assertIs(build.call_args.args[2], CompletionStop.ASSET)

    def test_primary_pdf_import_invokes_explicit_shared_stop_on_replay(self) -> None:
        imported = SimpleNamespace(
            disposition="replayed", work_version_id=VERSION_A,
            raw_asset_id=VERSION_B, sha256="a" * 64,
        )
        importer = mock.Mock()
        importer.import_asset.return_value = imported
        runtime = RuntimeFake()
        runtime.completion.pipeline.ensure_complete = mock.AsyncMock(
            return_value=SimpleNamespace(final_stage=CompletionStage.ANALYSIS_PENDING)
        )
        runtime.completion.facts = SimpleNamespace(get=lambda _: SimpleNamespace(
            stage=CompletionStage.ANALYSIS_PENDING
        ))
        args = argparse.Namespace(
            catalog="catalog.sqlite", storage_root=".", asset="article.pdf",
            asset_role=AssetRole.PRIMARY_PDF.value, work_version_id=VERSION_A,
            stop="asset", _config_analysis=None,
        )
        output = io.StringIO()

        with mock.patch.object(catalog, "_importer", return_value=(mock.Mock(), importer)), \
                mock.patch.object(catalog, "CompletionFactsRepository", return_value=SimpleNamespace(
                    get=lambda _: SimpleNamespace(stage=CompletionStage.ANALYSIS_PENDING))), \
                mock.patch.object(
                    catalog, "build_import_completion_runtime", return_value=runtime.completion
                ), \
                contextlib.redirect_stdout(output):
            code = catalog._import_asset(args)

        self.assertEqual(code, 0)
        call = runtime.completion.pipeline.ensure_complete.call_args
        self.assertEqual(call.args, (WorkVersionTarget(VERSION_A), CompletionStop.ASSET))
        self.assertIn("stage=ANALYSIS_PENDING", output.getvalue())

    def test_supplementary_import_does_not_invoke_completion(self) -> None:
        imported = SimpleNamespace(
            disposition="imported", work_version_id=VERSION_A,
            raw_asset_id=VERSION_B, sha256="a" * 64,
        )
        importer = mock.Mock()
        importer.import_asset.return_value = imported
        args = argparse.Namespace(
            catalog="catalog.sqlite", storage_root=".", asset="article.xml",
            asset_role=AssetRole.XML.value, work_version_id=VERSION_A,
            stop=None, _config_analysis=None,
        )

        with mock.patch.object(catalog, "_importer", return_value=(mock.Mock(), importer)), \
                mock.patch.object(catalog, "CompletionFactsRepository", return_value=SimpleNamespace(
                    get=lambda _: SimpleNamespace(stage=CompletionStage.ANALYSIS_PENDING))), \
                mock.patch.object(catalog, "build_import_completion_runtime") as build:
            catalog._import_asset(args)

        build.assert_not_called()


class ClosedDeletionManifestTests(unittest.TestCase):
    def test_superseded_backfill_paths_and_symbols_are_absent(self) -> None:
        root = Path(download.__file__).resolve().parents[1]
        self.assertFalse((root / "acquisition" / "backfill.py").exists())
        self.assertFalse((root / "analysis" / "backfill.py").exists())
        sources = tuple(
            path.read_text(encoding="utf-8")
            for path in (Path(download.__file__), Path(analyze.__file__))
        )
        for retired in (
            "execute_work_versions", "interrupted_result", "DownloadBackfillService",
            "AnalysisBackfillService", "_download_backfill_service",
            "_analysis_backfill_service",
        ):
            self.assertTrue(all(retired not in source for source in sources), retired)


if __name__ == "__main__":
    unittest.main()
