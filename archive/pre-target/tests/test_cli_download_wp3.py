import contextlib
import io
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase, mock
import os

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.cli import download
from sciretriever.cli.main import main


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
            "sciretriever.cli.search.build_search_completion_runtime"
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
        self.assertTrue(run.call_args.args[0]._config_translator.enabled)

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

if __name__ == "__main__":
    import unittest
    unittest.main()
