import argparse
import contextlib
import io
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase, mock
import os

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition.backfill import DownloadBackfillResult, WorkVersionDownloadOutcome
from sciretriever.analysis import AnalysisBackfillResult, WorkVersionAnalysisOutcome
from sciretriever.cli import download, search
from sciretriever.cli.main import main
from sciretriever.core.contracts import CandidateMetadata, Identifier
from sciretriever.discovery.search import MetadataSearchOutput, MetadataSearchResult
from sciretriever.catalog.records import WorkVersionRecord


def version(identifier):
    return WorkVersionRecord(
        identifier, "00000000-0000-4000-8000-000000000002", "unknown",
        "title", "Title", None, None, None, None, 2024, None, None,
        None, None, None, None, None, None, "fixture:key", False,
        "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z",
    )


class CliDownloadWp3Tests(TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.catalog = self.root / "catalog.sqlite"
        self.storage = self.root / "storage"
        self.storage.mkdir()

    def parse_error(self, argv):
        stream = io.StringIO()
        with contextlib.redirect_stderr(stream), self.assertRaises(SystemExit) as raised:
            main(argv)
        self.assertEqual(raised.exception.code, 2)
        return stream.getvalue()

    def test_no_selector_and_conflicting_selectors_fail_before_runtime(self):
        base = ["--no-config", "download", "--catalog", str(self.catalog), "--storage-root", str(self.storage)]
        with mock.patch("sciretriever.cli.download._execute") as execute:
            self.assertIn("requires an exact ID", self.parse_error(base))
            self.assertIn("cannot be combined", self.parse_error([
                *base, "--all-missing", "--query", "catalysis",
            ]))
        execute.assert_not_called()

    def test_sci_hub_cli_and_search_fail_closed_before_runtime_construction(self):
        download_argv = [
            "--no-config", "download", "--catalog", str(self.catalog),
            "--storage-root", str(self.storage), "--all-missing", "--provider", "sci-hub",
        ]
        search_argv = [
            "--no-config", "search", "test", "--catalog", str(self.catalog),
            "--level", "download", "--storage-root", str(self.storage),
            "--download-provider", "sci-hub",
        ]
        with mock.patch("sciretriever.cli.download._execute") as download_execute, mock.patch(
            "sciretriever.cli.search._execute"
        ) as search_execute:
            self.assertIn("explicitly enabled", self.parse_error(download_argv))
            self.assertIn("explicitly enabled", self.parse_error(search_argv))
        download_execute.assert_not_called()
        search_execute.assert_not_called()

    def test_sci_hub_config_injects_into_download_and_search_download(self):
        config = self.root / "config.toml"
        config.write_text(
            f'''schema_version = 1
[paths]
catalog = "{self.catalog}"
storage_root = "{self.storage}"
[acquisition]
providers = ["sci-hub"]
[acquisition.sci_hub]
enabled = true
base_url = "https://authorized.test/base"
allowed_pdf_hosts = ["pdf.test"]
''',
            encoding="utf-8",
        )
        config.chmod(0o600)

        with mock.patch("sciretriever.cli.download.run", return_value=0) as run:
            self.assertEqual(main(["--config", str(config), "download", "--all-missing"]), 0)
        args = run.call_args.args[0]
        self.assertEqual(args.provider, ["sci-hub"])
        self.assertTrue(args._config_sci_hub.enabled)

        with mock.patch("sciretriever.cli.search.run", return_value=0) as run:
            self.assertEqual(main([
                "--config", str(config), "search", "test", "--level", "download",
            ]), 0)
        args = run.call_args.args[0]
        self.assertEqual(args.download_provider, ["sci-hub"])
        self.assertTrue(args._config_sci_hub.enabled)

    def test_translator_config_injects_into_download_and_search_download(self):
        config = self.root / "translator.toml"
        config.write_text(
            f'''schema_version = 1
[paths]
catalog = "{self.catalog}"
storage_root = "{self.storage}"
[acquisition.translator]
enabled = true
[[acquisition.translator.rules]]
name = "publisher"
landing_url_template = "https://landing.example/article/{{doi}}"
allowed_pdf_hosts = ["pdf.example"]
''',
            encoding="utf-8",
        )
        config.chmod(0o600)
        with mock.patch("sciretriever.cli.download.run", return_value=0) as run:
            self.assertEqual(main(["--config", str(config), "download", "--all-missing"]), 0)
        self.assertTrue(run.call_args.args[0]._config_translator.enabled)

        with mock.patch("sciretriever.cli.search.run", return_value=0) as run:
            self.assertEqual(main([
                "--config", str(config), "search", "test", "--level", "download",
            ]), 0)
        search_args = run.call_args.args[0]
        self.assertTrue(search_args._config_translator.enabled)
        self.assertTrue(search._download_args(search_args)._config_translator.enabled)

    def test_all_selector_forms_reach_one_download_runtime(self):
        outcome = WorkVersionDownloadOutcome("00000000-0000-4000-8000-000000000001", "reused", (("primary_pdf", "reused"),), ())
        result = DownloadBackfillResult(1, 0, 1, 0, 0, (outcome,))
        seen = []

        async def execute(args):
            seen.append(args)
            return result

        selectors = (
            ["--work-version-id", outcome.work_version_id],
            ["--work-id", "00000000-0000-4000-8000-000000000002"],
            ["--query", "catalysis", "--author", "Ada", "--year", "2024", "--publisher", "Press", "--venue", "Journal", "--tag", "kinetics"],
            ["--all-missing"],
        )
        with mock.patch("sciretriever.cli.download._execute", side_effect=execute):
            for selector in selectors:
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    code = main([
                        "--no-config", "download", "--catalog", str(self.catalog),
                        "--storage-root", str(self.storage), *selector,
                    ])
                self.assertEqual(code, 0)
                payload = json.loads(output.getvalue())
                self.assertEqual(payload["counts"], {
                    "accepted": 0, "interrupted": 0, "missing": 0,
                    "reused": 1, "selected": 1,
                })
        self.assertEqual(len(seen), 4)

    def test_interrupted_result_returns_130_with_stable_counts(self):
        result = DownloadBackfillResult(2, 1, 0, 0, 1, ())

        async def execute(args):
            del args
            return result

        output = io.StringIO()
        with mock.patch("sciretriever.cli.download._execute", side_effect=execute), contextlib.redirect_stdout(output):
            code = main([
                "--no-config", "download", "--catalog", str(self.catalog),
                "--storage-root", str(self.storage), "--all-missing",
            ])
        self.assertEqual(code, 130)
        self.assertEqual(json.loads(output.getvalue())["counts"]["interrupted"], 1)

    def test_hard_interrupt_uses_retained_download_progress(self):
        completed = WorkVersionDownloadOutcome(
            "00000000-0000-4000-8000-000000000001", "succeeded",
            (("primary_pdf", "succeeded"),), (),
        )

        async def interrupt(args):
            args._download_backfill_service = SimpleNamespace(last_result=DownloadBackfillResult(
                3, 1, 0, 0, 0, (completed,),
            ))
            raise KeyboardInterrupt

        output = io.StringIO()
        with mock.patch("sciretriever.cli.download._execute", side_effect=interrupt), contextlib.redirect_stdout(output):
            code = main([
                "--no-config", "download", "--catalog", str(self.catalog),
                "--storage-root", str(self.storage), "--all-missing",
            ])
        self.assertEqual(code, 130)
        self.assertEqual(json.loads(output.getvalue())["counts"], {
            "accepted": 1, "interrupted": 2, "missing": 0,
            "reused": 0, "selected": 3,
        })

    def test_forbidden_policy_detects_replacement_during_open(self):
        policy = self.root / "forbidden.txt"
        replacement = self.root / "replacement.txt"
        policy.write_text("https://first.test/\n", encoding="utf-8")
        replacement.write_text("https://second.test/\n", encoding="utf-8")
        real_open = os.open

        def replace_then_open(path, flags):
            policy.unlink()
            replacement.rename(policy)
            return real_open(path, flags)

        with mock.patch("sciretriever.acquisition.policy_files.os.open", side_effect=replace_then_open):
            with self.assertRaisesRegex(ValueError, "changed while opening"):
                download._forbidden(policy)

    def test_search_download_uses_same_service_for_returned_versions(self):
        identifier = "00000000-0000-4000-8000-000000000001"
        metadata_output = MetadataSearchOutput((MetadataSearchResult(
            version(identifier), ("crossref",), (Identifier("doi", "10.1000/test"),),
            CandidateMetadata("Title", None, (), 2024, None, ()),
        ),), ())
        acquisition = DownloadBackfillResult(1, 1, 0, 0, 0, ())

        async def execute_download(args, ids):
            self.assertEqual(ids, (identifier,))
            self.assertEqual(args.storage_root, self.storage)
            return acquisition

        args = argparse.Namespace(
            level="download", storage_root=self.storage, catalog=self.catalog,
            download_provider=list(download.DEFAULT_PROVIDERS), download_timeout=1.0,
            download_provider_concurrency=2, host_concurrency=2,
            host_min_interval=0.0, max_asset_bytes=1000, forbidden_urls=None,
            xml=False, html=False,
        )
        output = io.StringIO()
        with mock.patch("sciretriever.cli.search._execute", return_value=metadata_output), mock.patch(
            "sciretriever.cli.download.execute_work_versions", side_effect=execute_download
        ) as called, contextlib.redirect_stdout(output):
            code = search.run(args)
        self.assertEqual(code, 0)
        called.assert_called_once()
        payload = json.loads(output.getvalue())
        self.assertEqual(payload["download"]["counts"]["accepted"], 1)
        self.assertEqual(payload["results"][0]["work_version_id"], identifier)

    def test_search_download_hard_interrupt_reports_retained_progress(self):
        identifier = "00000000-0000-4000-8000-000000000001"
        metadata_output = MetadataSearchOutput((MetadataSearchResult(
            version(identifier), ("crossref",), (Identifier("doi", "10.1000/test"),),
            CandidateMetadata("Title", None, (), 2024, None, ()),
        ),), ())

        async def interrupt(args, ids):
            del ids
            args._download_backfill_service = SimpleNamespace(last_result=DownloadBackfillResult(
                1, 0, 0, 0, 0, (),
            ))
            raise KeyboardInterrupt

        args = argparse.Namespace(
            level="download", storage_root=self.storage, catalog=self.catalog,
            download_provider=list(download.DEFAULT_PROVIDERS), download_timeout=1.0,
            download_provider_concurrency=2, host_concurrency=2,
            host_min_interval=0.0, max_asset_bytes=1000, forbidden_urls=None,
            xml=False, html=False,
        )
        output = io.StringIO()
        with mock.patch("sciretriever.cli.search._execute", return_value=metadata_output), mock.patch(
            "sciretriever.cli.download.execute_work_versions", side_effect=interrupt
        ), contextlib.redirect_stdout(output):
            code = search.run(args)
        self.assertEqual(code, 130)
        self.assertEqual(json.loads(output.getvalue())["download"]["counts"]["interrupted"], 1)

    def test_search_analyze_chains_only_returned_versions_and_serializes_partial_block(self):
        identifier = "00000000-0000-4000-8000-000000000001"
        metadata_output = MetadataSearchOutput((MetadataSearchResult(
            version(identifier), ("crossref",), (Identifier("doi", "10.1000/test"),),
            CandidateMetadata("Title", None, (), 2024, None, ()),
        ),), ())
        acquisition = DownloadBackfillResult(1, 0, 0, 1, 0, ())
        analyzed = AnalysisBackfillResult(1, 0, 0, 1, 0, 0, (
            WorkVersionAnalysisOutcome(identifier, "blocked", "primary_pdf_missing", "download_primary_pdf"),))

        async def execute_download(args, ids):
            self.assertEqual(ids, (identifier,))
            return acquisition

        def execute_analysis(args, ids):
            self.assertEqual(ids, (identifier,))
            return analyzed

        args = argparse.Namespace(level="analyze", storage_root=self.storage, catalog=self.catalog,
            download_provider=list(download.DEFAULT_PROVIDERS), download_timeout=1.0,
            download_provider_concurrency=2, host_concurrency=2, host_min_interval=0.0,
            max_asset_bytes=1000, forbidden_urls=None, xml=False, html=False,
            _config_analysis=SimpleNamespace())
        output = io.StringIO()
        with mock.patch("sciretriever.cli.search._execute", return_value=metadata_output), \
             mock.patch("sciretriever.cli.download.execute_work_versions", side_effect=execute_download), \
             mock.patch("sciretriever.cli.analyze.execute_work_versions", side_effect=execute_analysis), \
             contextlib.redirect_stdout(output):
            code = search.run(args)
        self.assertEqual(code, 0)
        payload = json.loads(output.getvalue())
        self.assertEqual(payload["download"]["counts"]["missing"], 1)
        self.assertEqual(payload["analysis"]["counts"]["blocked"], 1)

    def test_search_analyze_download_interrupt_always_serializes_analysis_counts(self):
        identifier = "00000000-0000-4000-8000-000000000001"
        metadata_output = MetadataSearchOutput((MetadataSearchResult(
            version(identifier), ("crossref",), (Identifier("doi", "10.1000/test"),),
            CandidateMetadata("Title", None, (), 2024, None, ()),
        ),), ())

        async def interrupted_download(args, ids):
            self.assertEqual(ids, (identifier,))
            return DownloadBackfillResult(1, 0, 0, 0, 1, ())

        args = argparse.Namespace(level="analyze", storage_root=self.storage, catalog=self.catalog,
            download_provider=list(download.DEFAULT_PROVIDERS), download_timeout=1.0,
            download_provider_concurrency=2, host_concurrency=2, host_min_interval=0.0,
            max_asset_bytes=1000, forbidden_urls=None, xml=False, html=False,
            _config_analysis=SimpleNamespace())
        output = io.StringIO()
        with mock.patch("sciretriever.cli.search._execute", return_value=metadata_output), \
             mock.patch("sciretriever.cli.download.execute_work_versions", side_effect=interrupted_download), \
             mock.patch("sciretriever.cli.analyze.execute_work_versions") as execute_analysis, \
             contextlib.redirect_stdout(output):
            code = search.run(args)
        self.assertEqual(code, 130)
        execute_analysis.assert_not_called()
        payload = json.loads(output.getvalue())
        self.assertEqual(payload["analysis"]["counts"], {
            "selected": 1, "analyzed": 0, "reused": 0, "blocked": 0, "failed": 0, "interrupted": 1})


if __name__ == "__main__":
    import unittest
    unittest.main()
