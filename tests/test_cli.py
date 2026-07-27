import contextlib
import io
import argparse
import json
import sqlite3
import stat
from types import SimpleNamespace
import sys
from tempfile import TemporaryDirectory
import unittest
from pathlib import Path
from unittest import TestCase
from unittest import mock


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever import __version__
from sciretriever.catalog import IdentityResolver, initialize_catalog, create_catalog_engine
from sciretriever.cli.main import PLACEHOLDER_COMMANDS, main
from sciretriever.cli import preflight as preflight_cli
from sciretriever.cli import package as package_cli
from sciretriever.network import HeadersResponse
from sciretriever.core.contracts import DownloadManifestEntry
from sciretriever.core.enums import PackageQuality
from sciretriever.discovery import LabelInput, ProviderRecord


EXPLICIT_RUN_ID = "00000000-0000-4000-8000-000000000001"
EXPLICIT_RETRIEVED_AT = "2026-07-20T12:00:00Z"


class StaticProvider:
    name = "crossref"

    def search(self, _spec):
        return (
            ProviderRecord(
                provider="crossref",
                rank=1,
                raw_identifiers=(("doi", "10.1000/example"),),
                title="Catalysis result",
                abstract=None,
            ),
        )


class CliTests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.directory = Path(self.temporary_directory.name)
        self.catalog = self.directory / "catalog.sqlite"
        self.output = self.directory / "manifest.jsonl"

    def discover_args(self, *extra: str) -> list[str]:
        return [
            "discover",
            "catalysis",
            "--catalog",
            str(self.catalog),
            "--output",
            str(self.output),
            "--taxonomy",
            "topic",
            "--taxonomy-version",
            "1",
            *extra,
        ]

    def assert_parse_error(self, *extra: str) -> str:
        error = io.StringIO()
        with contextlib.redirect_stderr(error):
            with self.assertRaises(SystemExit) as raised:
                main(self.discover_args(*extra))
        self.assertEqual(raised.exception.code, 2)
        self.assertNotIn("Traceback", error.getvalue())
        return error.getvalue()

    def test_version_returns_zero_and_prints_package_version(self) -> None:
        output = io.StringIO()

        with contextlib.redirect_stdout(output):
            result = main(["--version"])

        self.assertEqual(result, 0)
        self.assertEqual(output.getvalue(), f"{__version__}\n")

    def test_catalog_is_implemented_and_no_placeholders_remain(self) -> None:
        self.assertEqual(PLACEHOLDER_COMMANDS, ())
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as raised:
                main(["catalog", "--help"])
        self.assertEqual(raised.exception.code, 0)
        for command in ("create", "import-asset"):
            self.assertIn(command, output.getvalue())
        self.assertNotIn("import-legacy-db", output.getvalue())

    def test_download_exists_and_durable_acquire_controls_are_removed(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as raised:
            main(["download", "--help"])
        self.assertEqual(raised.exception.code, 0)
        self.assertIn("--all-missing", output.getvalue())
        commands = (
            ["acquire", "--resume-job", "00000000-0000-4000-8000-000000000001"],
            ["acquire", "--due-jobs"],
        )
        for command in commands:
            with self.subTest(command=command), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    main(command)
            self.assertEqual(raised.exception.code, 2)

    def test_discover_help_lists_bounded_options(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as raised:
                main(["discover", "--help"])

        self.assertEqual(raised.exception.code, 0)
        help_text = output.getvalue()
        for option in (
            "--source",
            "--filter",
            "--catalog",
            "--output",
            "--label-rule",
            "--crossref-mailto",
        ):
            self.assertIn(option, help_text)

    def test_package_help_lists_offline_selection_and_bounds(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as raised:
                main(["package", "--help"])
        self.assertEqual(raised.exception.code, 0)
        for option in (
            "--catalog", "--storage-root", "--work-id", "--raw-asset-id",
            "--work-version-id",
            "--max-pages", "--max-structural-units", "--max-depth", "--max-elements",
        ):
            self.assertIn(option, output.getvalue())

    def test_package_output_reports_creation_and_replay_disposition(self) -> None:
        for created, disposition in ((True, "created"), (False, "replayed")):
            catalog = mock.MagicMock()
            pipeline = mock.MagicMock()
            pipeline.run.return_value = SimpleNamespace(
                created=created,
                package=SimpleNamespace(
                    package_version=2,
                    quality=PackageQuality.LIMITED_XML_HTML,
                    package_sha256="a" * 64,
                ),
                record=SimpleNamespace(storage_path="derived/document_package/id"),
            )
            output = io.StringIO()
            args = argparse.Namespace(
                catalog=str(self.catalog), storage_root=str(self.directory),
                work_id=EXPLICIT_RUN_ID, raw_asset_id=None,
                max_input_bytes=1024, max_pages=10, max_structural_units=20,
                max_depth=30, max_elements=40, max_text_characters=50,
            )
            with (
                mock.patch.object(package_cli, "open_catalog_engine", return_value=catalog),
                mock.patch.object(package_cli, "RawAssetStore", return_value=mock.sentinel.raw),
                mock.patch.object(package_cli, "DerivedArtifactStore", return_value=mock.sentinel.derived),
                mock.patch.object(package_cli, "PackagePipeline", return_value=pipeline) as pipeline_type,
                contextlib.redirect_stdout(output),
            ):
                result = package_cli.run(args)
            self.assertEqual(result, 0)
            self.assertIn(f"disposition={disposition}", output.getvalue())
            parameters = pipeline_type.call_args.kwargs["normalization_parameters"]
            self.assertEqual((parameters.max_depth, parameters.max_elements), (30, 40))
            catalog.dispose.assert_called_once_with()

    def test_preflight_is_read_only_and_indirect_provider_is_not_checked(self) -> None:
        storage = self.directory / "storage"
        storage.mkdir()
        engine = create_catalog_engine(self.catalog)
        initialize_catalog(engine)
        engine.dispose()
        forbidden = self.directory / "forbidden.txt"
        forbidden.write_text("# local policy\nhttps://blocked.example/\n", encoding="utf-8")
        config = self.directory / "config.toml"
        config.write_text(
            """schema_version = 1
[paths]
catalog = "catalog.sqlite"
storage_root = "storage"
[acquisition]
providers = ["crossref"]
forbidden_urls = "forbidden.txt"
[acquisition.preflight]
min_free_bytes = 1
max_asset_bytes = 1
readiness = "headers"
timeout = 1
""",
            encoding="utf-8",
        )
        config.chmod(0o600)

        def snapshot() -> tuple[tuple[str, int, int, int], ...]:
            return tuple(sorted(
                (str(path.relative_to(self.directory)), path.lstat().st_mode, path.lstat().st_size, path.lstat().st_mtime_ns)
                for path in self.directory.rglob("*")
            ))

        before = snapshot()
        config_bytes = config.read_bytes()
        config_mode = stat.S_IMODE(config.stat().st_mode)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(main(["preflight", "--config", str(config)]), 0)
        report = json.loads(output.getvalue())
        provider = next(check for check in report["checks"] if check["name"] == "provider:crossref")
        self.assertEqual(provider["status"], "not_checked")
        self.assertNotIn("workers", report["policy"])
        self.assertNotIn("document_interval_seconds", report["policy"])
        self.assertNotIn(str(config), output.getvalue())
        self.assertEqual(config.read_bytes(), config_bytes)
        self.assertEqual(stat.S_IMODE(config.stat().st_mode), config_mode)
        self.assertEqual(snapshot(), before)
        with sqlite3.connect(self.catalog) as connection:
            for table in ("works", "diagnostic_records", "raw_assets"):
                self.assertEqual(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0], 0)

    def test_preflight_direct_uses_headers_transport_and_has_no_policy_overrides(self) -> None:
        storage = self.directory / "storage"
        storage.mkdir()
        config = self.directory / "direct.toml"
        config.write_text(
            """schema_version = 1
[paths]
catalog = "catalog.sqlite"
storage_root = "storage"
[acquisition]
providers = ["direct"]
[acquisition.preflight]
min_free_bytes = 10
max_asset_bytes = 10
readiness = "headers"
timeout = 2
""",
            encoding="utf-8",
        )

        class FakeHeadersTransport:
            def __init__(self, *_args, **_kwargs):
                self.calls: list[tuple[str, float | None]] = []

            def head(self, url, *, params=None, headers=None, timeout=None):
                self.calls.append((url, timeout))
                return HeadersResponse(200, url, {"content-length": "10"})

        fake = FakeHeadersTransport()
        output = io.StringIO()
        with (
            mock.patch.object(preflight_cli, "UrllibAcquisitionTransport", return_value=fake),
            contextlib.redirect_stdout(output),
        ):
            result = main(["preflight", "--url", "https://example.test/paper", "--config", str(config)])
        self.assertEqual(result, 0)
        report = json.loads(output.getvalue())
        direct = next(check for check in report["checks"] if check["name"] == "provider:direct")
        self.assertEqual(direct["status"], "ready")
        self.assertEqual(fake.calls, [("https://example.test/paper", 2.0)])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            main(["preflight", "--workers", "2", "--config", str(config)])

    def test_preflight_rejects_unwritable_catalog_and_storage_paths(self) -> None:
        storage = self.directory / "storage"
        storage.mkdir()
        config = self.directory / "permissions.toml"
        config.write_text(
            """schema_version = 1
[paths]
catalog = "catalog.sqlite"
storage_root = "storage"
[acquisition]
providers = ["crossref"]
[acquisition.preflight]
min_free_bytes = 1
max_asset_bytes = 1
""",
            encoding="utf-8",
        )
        output = io.StringIO()
        with (
            mock.patch("sciretriever.acquisition.preflight.os.access", return_value=False),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(main(["preflight", "--config", str(config)]), 1)
        report = json.loads(output.getvalue())
        checks = {check["name"]: check["status"] for check in report["checks"]}
        self.assertEqual(checks["catalog"], "invalid")
        self.assertEqual(checks["storage_root"], "invalid")

    def test_package_requires_exactly_one_selection(self) -> None:
        base = ["package", "--catalog", str(self.catalog), "--storage-root", str(self.directory)]
        for extra in ((), ("--work-id", EXPLICIT_RUN_ID, "--raw-asset-id", EXPLICIT_RUN_ID)):
            with self.subTest(extra=extra):
                with contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as raised:
                        main([*base, *extra])
                self.assertEqual(raised.exception.code, 2)

    def test_discover_defaults_build_all_providers_and_generated_provenance(self) -> None:
        self.catalog.touch()
        engine = mock.MagicMock()
        engine.read_only = True
        providers = [mock.Mock(name=name) for name in ("crossref", "europe-pmc", "arxiv")]
        generated_run_id = "00000000-0000-4000-8000-000000000002"
        generated_time = "2026-07-20T12:01:00Z"

        with (
            mock.patch("sciretriever.cli.discover.open_read_only_catalog_engine", return_value=engine),
            mock.patch("sciretriever.cli.discover.ReadOnlyCatalogView", return_value=mock.sentinel.catalog),
            mock.patch("sciretriever.cli.discover.build_crossref_provider", return_value=providers[0]) as crossref,
            mock.patch("sciretriever.cli.discover.build_europe_pmc_provider", return_value=providers[1]) as europe_pmc,
            mock.patch("sciretriever.cli.discover.build_arxiv_provider", return_value=providers[2]) as arxiv,
            mock.patch("sciretriever.cli.discover.new_uuid4", return_value=generated_run_id),
            mock.patch("sciretriever.cli.discover.utc_now_rfc3339", return_value=generated_time),
            mock.patch("sciretriever.cli.discover.discover_to_jsonl", return_value=()) as discover,
        ):
            result = main(["--no-config", *self.discover_args()])

        self.assertEqual(result, 0)
        spec = discover.call_args.args[0]
        self.assertEqual(spec.query, "catalysis")
        self.assertEqual(spec.sources, ("crossref", "europe-pmc", "arxiv"))
        self.assertEqual(spec.limit, 100)
        self.assertEqual(spec.filters, ())
        self.assertEqual(discover.call_args.kwargs["intake_run_id"], generated_run_id)
        self.assertEqual(discover.call_args.kwargs["retrieved_at"], generated_time)
        transports = {
            crossref.call_args.args[0],
            europe_pmc.call_args.args[0],
            arxiv.call_args.args[0],
        }
        self.assertEqual(len(transports), 1)
        self.assertEqual(crossref.call_args.kwargs, {"mailto": None, "timeout": 30.0})
        engine.dispose.assert_called_once_with()

    def test_discover_repeated_values_and_explicit_provenance(self) -> None:
        self.catalog.touch()
        engine = mock.MagicMock()
        engine.read_only = True
        with (
            mock.patch("sciretriever.cli.discover.open_read_only_catalog_engine", return_value=engine),
            mock.patch("sciretriever.cli.discover.ReadOnlyCatalogView", return_value=mock.sentinel.catalog),
            mock.patch("sciretriever.cli.discover.build_crossref_provider", return_value=mock.sentinel.crossref),
            mock.patch("sciretriever.cli.discover.build_arxiv_provider", return_value=mock.sentinel.arxiv),
            mock.patch("sciretriever.cli.discover.discover_to_jsonl", return_value=()) as discover,
            mock.patch("sciretriever.cli.discover.new_uuid4") as new_uuid,
            mock.patch("sciretriever.cli.discover.utc_now_rfc3339") as utc_now,
        ):
            result = main(
                self.discover_args(
                    "--source",
                    "crossref",
                    "--source",
                    "arxiv",
                    "--limit",
                    "7",
                    "--filter",
                    "year_from=2020",
                    "--filter",
                    "year_to=2025",
                    "--label-rule",
                    "chemistry=catalysis",
                    "--label-rule",
                    "chemistry=kinetics",
                    "--timeout",
                    "4.5",
                    "--intake-run-id",
                    EXPLICIT_RUN_ID,
                    "--retrieved-at",
                    EXPLICIT_RETRIEVED_AT,
                    "--crossref-mailto",
                    "reader@example.org",
                )
            )

        self.assertEqual(result, 0)
        spec = discover.call_args.args[0]
        self.assertEqual(spec.sources, ("crossref", "arxiv"))
        self.assertEqual(spec.limit, 7)
        self.assertEqual(spec.filters, (("year_from", "2020"), ("year_to", "2025")))
        self.assertEqual(discover.call_args.kwargs["intake_run_id"], EXPLICIT_RUN_ID)
        self.assertEqual(discover.call_args.kwargs["retrieved_at"], EXPLICIT_RETRIEVED_AT)
        labeler = discover.call_args.kwargs["labeler"]
        self.assertEqual(labeler.label(LabelInput("Catalysis kinetics", None)).labels, ("chemistry",))
        new_uuid.assert_not_called()
        utc_now.assert_not_called()

    def test_discover_writes_real_manifest_with_fake_provider(self) -> None:
        writable = create_catalog_engine(self.catalog)
        initialize_catalog(writable)
        writable.dispose()
        output = io.StringIO()

        with (
            mock.patch("sciretriever.cli.discover._providers", return_value={"crossref": StaticProvider()}),
            contextlib.redirect_stdout(output),
        ):
            result = main(
                self.discover_args(
                    "--source",
                    "crossref",
                    "--label-rule",
                    "chemistry=catalysis",
                    "--intake-run-id",
                    EXPLICIT_RUN_ID,
                    "--retrieved-at",
                    EXPLICIT_RETRIEVED_AT,
                )
            )

        self.assertEqual(result, 0)
        lines = self.output.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 1)
        entry = DownloadManifestEntry.from_json_line(lines[0])
        self.assertEqual(entry.labels, ("chemistry",))
        self.assertTrue(entry.missing_abstract)
        self.assertEqual(entry.provenance.intake_run_id, EXPLICIT_RUN_ID)
        self.assertIn(f"Wrote 1 entries to {self.output}", output.getvalue())

    def test_discover_always_disposes_read_only_engine_on_operational_failure(self) -> None:
        self.catalog.touch()
        engine = mock.MagicMock()
        engine.read_only = True
        error = io.StringIO()
        with (
            mock.patch("sciretriever.cli.discover.open_read_only_catalog_engine", return_value=engine),
            mock.patch("sciretriever.cli.discover.ReadOnlyCatalogView", return_value=mock.sentinel.catalog),
            mock.patch("sciretriever.cli.discover._providers", return_value={}),
            mock.patch(
                "sciretriever.cli.discover.discover_to_jsonl",
                side_effect=OSError("write failed"),
            ),
            contextlib.redirect_stderr(error),
        ):
            result = main(self.discover_args())

        self.assertEqual(result, 1)
        self.assertEqual(error.getvalue(), "sciretriever: error: write failed\n")
        self.assertNotIn("Traceback", error.getvalue())
        engine.dispose.assert_called_once_with()

    def test_discover_missing_catalog_and_output_parent_return_one(self) -> None:
        for extra, expected in (
            ((), "Catalog does not exist"),
            (("--output", str(self.directory / "missing" / "manifest.jsonl")), "manifest parent"),
        ):
            with self.subTest(expected=expected):
                error = io.StringIO()
                with contextlib.redirect_stderr(error):
                    result = main(self.discover_args(*extra))
                self.assertEqual(result, 1)
                self.assertIn(expected, error.getvalue())
                self.assertNotIn("Traceback", error.getvalue())

    def test_discover_rejects_malformed_filters_rules_and_positive_values(self) -> None:
        cases = (
            ("--filter", "year=2020"),
            ("--filter", "year_from"),
            ("--filter", "year_from=2020", "--filter", "year_from=2021"),
            ("--filter", "year_from=2025", "--filter", "year_to=2020"),
            ("--label-rule", "chemistry"),
            ("--label-rule", "=term"),
            ("--label-rule", "label="),
            ("--timeout", "nan"),
        )
        for case in cases:
            with self.subTest(case=case):
                self.assertIn("error:", self.assert_parse_error(*case))

    def test_discover_limit_accepts_arbitrarily_large_positive_integer(self) -> None:
        huge_limit = "9" * 310
        output = io.StringIO()
        error = io.StringIO()
        with (
            mock.patch(
                "sciretriever.cli.discover._execute",
                return_value=(self.output, 0),
            ) as execute,
            contextlib.redirect_stdout(output),
            contextlib.redirect_stderr(error),
        ):
            result = main(self.discover_args("--limit", huge_limit))

        self.assertEqual(result, 0)
        self.assertEqual(error.getvalue(), "")
        self.assertNotIn("Traceback", output.getvalue())
        self.assertEqual(execute.call_args.args[0].limit, int(huge_limit))

    def test_discover_limit_rejects_zero_and_huge_negative_integer(self) -> None:
        for value in ("0", f"-{'9' * 310}"):
            with self.subTest(value=value):
                error = self.assert_parse_error("--limit", value)
                self.assertIn("must be a positive integer", error)

    def test_discover_rejects_invalid_explicit_provenance(self) -> None:
        for case in (
            ("--intake-run-id", "not-a-uuid"),
            ("--retrieved-at", "2026-07-20 12:00:00"),
        ):
            with self.subTest(case=case):
                self.assertIn("error:", self.assert_parse_error(*case))

if __name__ == "__main__":
    unittest.main()
