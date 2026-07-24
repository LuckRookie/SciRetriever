import contextlib
import io
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase, mock


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import (
    ReferenceRepository,
    WorkRepository,
    create_catalog_engine,
    initialize_catalog,
    open_catalog_engine,
)
from sciretriever.cli import library as library_cli
from sciretriever.cli import search as search_cli
from sciretriever.cli.main import main
from sciretriever.core.contracts import Identifier
from sciretriever.discovery import ProviderRecord


class FakeProvider:
    def __init__(self, name, records=(), error=None):
        self.name = name
        self.records = tuple(records)
        self.error = error

    def search(self, _spec):
        if self.error is not None:
            raise self.error
        return self.records


def provider_record(
    provider, rank, title, doi, *, keywords=(), open_access_status=None,
    provider_record_id=None, extra_identifiers=(), publication_date=None,
):
    return ProviderRecord(
        provider=provider,
        rank=rank,
        raw_identifiers=(("doi", doi), *tuple(extra_identifiers)),
        title=title,
        abstract="Canonical abstract",
        authors=("Ada Lovelace",),
        year=2026,
        venue="Canonical Venue",
        keywords=tuple(keywords),
        open_access_status=open_access_status,
        provider_record_id=provider_record_id,
        publication_date=publication_date,
    )


class CliWp2Tests(TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.catalog = self.base / "catalog.sqlite"
        engine = create_catalog_engine(self.catalog)
        initialize_catalog(engine)
        engine.dispose()

    def invoke(self, argv):
        output = io.StringIO()
        error = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            code = main(["--no-config", *argv])
        return code, output.getvalue(), error.getvalue()

    def parse_error(self, argv):
        error = io.StringIO()
        with contextlib.redirect_stderr(error), self.assertRaises(SystemExit) as raised:
            main(["--no-config", *argv])
        self.assertEqual(raised.exception.code, 2)
        self.assertNotIn("Traceback", error.getvalue())
        return error.getvalue()

    def counts(self):
        names = ("works", "work_versions", "metadata_observations", "version_references")
        import sqlite3
        with sqlite3.connect(self.catalog) as connection:
            return tuple(connection.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0] for name in names)

    def test_help_lists_wp2_commands_subcommands_and_options(self):
        for argv, expected in (
            (["--help"], ("search", "library")),
            (["search", "--help"], ("--catalog", "--level", "--provider", "--precedence")),
            (["library", "--help"], ("show", "search", "references", "cited-by", "export")),
            (["library", "search", "--help"], ("--author", "--year", "--publisher", "--venue", "--tag")),
        ):
            output = io.StringIO()
            with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as raised:
                main(argv)
            self.assertEqual(raised.exception.code, 0)
            for value in expected:
                self.assertIn(value, output.getvalue())
        self.assertIn("requires --storage-root", self.parse_error([
            "search", "query", "--catalog", str(self.catalog), "--level", "download"
        ]))

    def test_search_provider_validation_and_explicit_order(self):
        base = ["search", "query", "--catalog", str(self.catalog)]
        self.assertIn("duplicate provider", self.parse_error([*base, "--provider", "arxiv", "--provider", "arxiv"]))
        self.assertIn("duplicate precedence", self.parse_error([
            *base, "--provider", "arxiv", "--provider", "crossref",
            "--precedence", "arxiv", "--precedence", "arxiv",
        ]))
        self.assertIn("every selected provider", self.parse_error([
            *base, "--provider", "arxiv", "--provider", "crossref", "--precedence", "arxiv",
        ]))
        with mock.patch.object(search_cli, "run", return_value=0) as run:
            self.assertEqual(main(["--no-config", *base, "--provider", "arxiv", "--provider", "crossref"]), 0)
        self.assertEqual(run.call_args.args[0].precedence, ["arxiv", "crossref"])

    def test_real_search_is_deterministic_persists_and_sanitizes_partial_failure(self):
        providers = {
            "crossref": FakeProvider("crossref", (
                provider_record(
                    "crossref", 1, "Canonical Work", "10.1000/wp2",
                    keywords=("SECRET-KEYWORD",), open_access_status="open",
                ),
            )),
            "arxiv": FakeProvider("arxiv", error=RuntimeError("token=SECRET")),
        }
        argv = [
            "search", "battery", "--catalog", str(self.catalog),
            "--provider", "crossref", "--provider", "arxiv",
        ]
        with mock.patch.object(search_cli, "_providers", return_value=providers):
            code, output, error = self.invoke(argv)
        self.assertEqual((code, error), (0, ""))
        payload = json.loads(output)
        self.assertEqual(payload["counts"], {"failures": 1, "results": 1})
        self.assertEqual(payload["failures"], [{
            "category": "provider_error", "message": "provider search failed", "provider": "arxiv"
        }])
        self.assertEqual(payload["results"][0]["metadata"]["title"], "Canonical Work")
        self.assertEqual(payload["results"][0]["metadata"]["open_access_status"], "open")
        for forbidden in ("SECRET", "keywords", "provider_record_id", "provenance", "storage_path"):
            self.assertNotIn(forbidden, output)
        persisted = self.counts()
        self.assertEqual(persisted[:2], (1, 1))
        self.assertGreater(persisted[2], 0)

    def test_all_provider_failure_returns_one_without_catalog_changes(self):
        before = self.counts()
        providers = {
            "crossref": FakeProvider("crossref", error=RuntimeError("secret one")),
            "arxiv": FakeProvider("arxiv", error=RuntimeError("secret two")),
        }
        with mock.patch.object(search_cli, "_providers", return_value=providers):
            code, output, error = self.invoke([
                "search", "query", "--catalog", str(self.catalog),
                "--provider", "crossref", "--provider", "arxiv",
            ])
        self.assertEqual((code, output), (1, ""))
        self.assertEqual(error, "sciretriever: error: all metadata search providers failed\n")
        self.assertEqual(self.counts(), before)

    def test_provider_construction_failure_is_sanitized(self):
        with mock.patch.object(
            search_cli, "_providers", side_effect=RuntimeError("api_key=TOPSECRET")
        ):
            code, output, error = self.invoke([
                "search", "query", "--catalog", str(self.catalog),
                "--provider", "crossref",
            ])
        self.assertEqual((code, output), (1, ""))
        self.assertEqual(error, "sciretriever: error: metadata search failed\n")
        self.assertNotIn("TOPSECRET", error)

    def test_search_output_filters_backend_provider_record_identifiers(self):
        record = provider_record(
            "openalex", 1, "Public Work", "10.1000/public",
            provider_record_id="https://openalex.org/SECRET-RAW-ID",
            extra_identifiers=(("openalex", "https://openalex.org/SECRET-RAW-ID"),),
            publication_date="2026-02-03",
        )
        with mock.patch.object(
            search_cli,
            "_providers",
            return_value={"openalex": FakeProvider("openalex", (record,))},
        ):
            code, output, error = self.invoke([
                "search", "query", "--catalog", str(self.catalog),
                "--provider", "openalex",
            ])
        self.assertEqual((code, error), (0, ""))
        payload = json.loads(output)
        self.assertEqual(payload["results"][0]["identifiers"], [
            {"namespace": "doi", "value": "10.1000/public"}
        ])
        self.assertEqual(
            payload["results"][0]["metadata"]["publication_date"], "2026-02-03"
        )
        self.assertNotIn("SECRET-RAW-ID", output)

    def test_search_operational_error_does_not_expose_catalog_path(self):
        missing = self.base / "private" / "catalog.sqlite"
        code, output, error = self.invoke([
            "search", "query", "--catalog", str(missing), "--provider", "arxiv",
        ])
        self.assertEqual((code, output), (1, ""))
        self.assertEqual(error, "sciretriever: error: metadata search failed\n")
        self.assertNotIn(str(missing), error)

    def seed_library(self):
        engine = open_catalog_engine(self.catalog)
        works = WorkRepository(engine)
        draft = works.ingest_version(
            provider="private", provider_record_id="SECRET-DRAFT", title="Earlier Draft",
            doi="10.1000/draft", version_class="preprint",
        )
        formal = works.ingest_version(
            provider="private", provider_record_id="SECRET-FORMAL", title="Preferred Publication",
            doi="10.1000/formal", version_class="formal_publication",
            related_work_version_id=draft.id, relation_evidence={"secret": "NEVER"},
            metadata={"abstract": "battery interface", "publication_year": 2025},
        )
        cited = works.ingest_version(
            provider="private", provider_record_id="SECRET-CITED", title="Cited Work", doi="10.1000/cited",
        )
        ReferenceRepository(engine).add(
            formal.id, 0, "SECRET RAW REFERENCE", cited_work_id=cited.work_id,
            identifier=Identifier("doi", "10.1000/cited"),
        )
        engine.dispose()
        return draft, formal, cited

    def test_library_commands_are_read_only_and_show_exact_versions(self):
        draft, formal, cited = self.seed_library()
        before = self.counts()
        commands = (
            (["library", "show", "--catalog", str(self.catalog), "--work-version-id", draft.id], draft.id),
            (["library", "show", "--catalog", str(self.catalog), "--work-id", draft.work_id], formal.id),
            (["library", "search", "battery", "--catalog", str(self.catalog), "--year", "2025"], formal.id),
            (["library", "references", "--catalog", str(self.catalog), "--work-id", formal.work_id], cited.id),
            (["library", "cited-by", "--catalog", str(self.catalog), "--work-id", cited.work_id], formal.id),
        )
        for argv, version_id in commands:
            with self.subTest(argv=argv):
                code, output, error = self.invoke(argv)
                self.assertEqual((code, error), (0, ""))
                self.assertEqual(json.loads(output)[0]["work_version_id"], version_id)
        self.assertEqual(self.counts(), before)

    def test_atomic_json_and_jsonl_exports_use_only_safe_rows(self):
        draft, formal, _ = self.seed_library()
        for output_format in ("json", "jsonl"):
            destination = self.base / f"export.{output_format}"
            code, output, error = self.invoke([
                "library", "export", "--catalog", str(self.catalog), "--work-id", draft.work_id,
                "--output", str(destination), "--format", output_format,
            ])
            self.assertEqual((code, error), (0, ""))
            self.assertIn(str(destination), output)
            content = destination.read_text(encoding="utf-8")
            rows = json.loads(content) if output_format == "json" else [json.loads(line) for line in content.splitlines()]
            self.assertEqual(rows[0]["work_version_id"], formal.id)
            for forbidden in ("SECRET", "NEVER", "provider_record_id", "provenance", "raw_reference"):
                self.assertNotIn(forbidden, content)
        missing = self.base / "missing" / "export.json"
        code, output, error = self.invoke([
            "library", "export", "--catalog", str(self.catalog), "--work-id", draft.work_id,
            "--output", str(missing),
        ])
        self.assertEqual((code, output), (1, ""))
        self.assertIn("library operation failed", error)
        self.assertEqual(tuple(self.base.glob(".*.tmp")), ())

    def test_export_rejects_catalog_sidecars_symlink_and_hardlink(self):
        draft, _, _ = self.seed_library()
        header = self.catalog.read_bytes()[:16]
        symlink = self.base / "catalog-link"
        symlink.symlink_to(self.catalog)
        hardlink = self.base / "catalog-hardlink"
        os.link(self.catalog, hardlink)
        protected = (
            self.catalog,
            Path(f"{self.catalog}-wal"),
            Path(f"{self.catalog}-shm"),
            Path(f"{self.catalog}-journal"),
            symlink,
            hardlink,
        )
        for destination in protected:
            with self.subTest(destination=destination):
                code, output, error = self.invoke([
                    "library", "export", "--catalog", str(self.catalog),
                    "--work-id", draft.work_id, "--output", str(destination),
                ])
                self.assertEqual((code, output), (1, ""))
                self.assertEqual(error, "sciretriever: error: library operation failed\n")
                self.assertEqual(self.catalog.read_bytes()[:16], header)
        self.assertTrue(symlink.is_symlink())
        self.assertEqual(tuple(self.base.glob(".*.tmp")), ())

    def test_export_replace_failure_cleans_temporary_file(self):
        draft, _, _ = self.seed_library()
        destination = self.base / "replace-failure.json"
        with mock.patch(
            "sciretriever.cli.library.os.replace", side_effect=OSError("replace failed")
        ):
            code, output, error = self.invoke([
                "library", "export", "--catalog", str(self.catalog),
                "--work-id", draft.work_id, "--output", str(destination),
            ])
        self.assertEqual((code, output), (1, ""))
        self.assertIn("library operation failed", error)
        self.assertFalse(destination.exists())
        self.assertEqual(tuple(self.base.glob(".*.tmp")), ())

    def test_export_remains_successful_when_directory_fsync_is_unavailable(self):
        draft, formal, _ = self.seed_library()
        destination = self.base / "durable.json"
        with mock.patch.object(library_cli.os, "open", side_effect=OSError("unsupported")):
            library_cli._fsync_directory(self.base)
        with mock.patch.object(library_cli, "_fsync_directory", return_value=None):
            code, output, error = self.invoke([
                "library", "export", "--catalog", str(self.catalog), "--work-id", draft.work_id,
                "--output", str(destination),
            ])
        self.assertEqual((code, error), (0, ""))
        self.assertIn(str(destination), output)
        self.assertEqual(json.loads(destination.read_text(encoding="utf-8"))[0]["work_version_id"], formal.id)

    def test_config_catalog_path_is_injected_for_search_and_library(self):
        config = self.base / "config.toml"
        config.write_text('schema_version = 1\n[paths]\ncatalog = "catalog.sqlite"\n', encoding="utf-8")
        with mock.patch.object(search_cli, "run", return_value=0) as run:
            self.assertEqual(main(["search", "query", "--provider", "arxiv", "--config", str(config)]), 0)
        self.assertEqual(run.call_args.args[0].catalog, self.catalog)
        with mock.patch("sciretriever.cli.library.run", return_value=0) as run:
            self.assertEqual(main(["library", "search", "--config", str(config)]), 0)
        self.assertEqual(run.call_args.args[0].catalog, self.catalog)


if __name__ == "__main__":
    import unittest
    unittest.main()
