from __future__ import annotations

from pathlib import Path
import argparse
from io import BytesIO
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase, mock
from uuid import uuid4

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import IdentityResolver, LibraryFilters, WorkVersionAnalysisRepository, create_catalog_engine, initialize_catalog
from sciretriever.config import AnalysisConfig, LLMConfig, MinerUConfig
from sciretriever.cli.main import _build_parser
from sciretriever.cli import analyze
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.storage import RawAssetStore


class AnalysisWP45Tests(TestCase):
    def setUp(self) -> None:
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.catalog_path = self.base / "catalog.sqlite"
        self.storage = self.base / "storage"
        self.storage.mkdir()
        self.catalog = create_catalog_engine(self.catalog_path)
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        resolver = IdentityResolver(self.catalog)
        first = resolver.create_or_reuse_work({"doi": "10.1/b"})
        second = resolver.create_or_reuse_work({"doi": "10.1/a"})
        self.first, self.first_work = first.work_version.id, first.work.id
        self.second = second.work_version.id
        self.repository = WorkVersionAnalysisRepository(self.catalog)

    def attach_pdf(self, work_version_id: str) -> str:
        store = RawAssetStore(self.storage)
        staged = store.stage(BytesIO(b"%PDF-1.4\nfixture\n%%EOF"), intent_id=str(uuid4()))
        publication = store.publish(staged)
        store.remove_staged(staged)
        raw_id = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, byte_size, provenance_json) VALUES (?, ?, ?, 'application/pdf', 'pdf', ?, '{}')",
                (raw_id, publication.sha256, publication.storage_path, publication.byte_size))
            connection.exec_driver_sql("INSERT INTO work_version_assets (work_version_id, raw_asset_id, asset_role) VALUES (?, ?, 'primary_pdf')",
                (work_version_id, raw_id))
        return raw_id

    def seed_current(self, work_version_id: str) -> None:
        raw_id = self.attach_pdf(work_version_id)
        parser_id, source_id, analysis_id, run_id, current_id = (str(uuid4()) for _ in range(5))
        now = utc_now_rfc3339()
        with self.catalog.transaction() as connection:
            for identifier, kind, sha in ((parser_id, "mineru_parser", "b" * 64),
                                           (source_id, "mineru_source_map", "c" * 64),
                                           (analysis_id, "analysis", "d" * 64)):
                connection.exec_driver_sql("INSERT INTO normalized_artifacts (id, work_version_id, raw_asset_id, kind, schema_version, storage_path, sha256, media_type, byte_size, provenance_json, created_at) VALUES (?, ?, ?, ?, '1', ?, ?, 'application/json', 1, '{}', ?)",
                    (identifier, work_version_id, raw_id, kind, f"derived/{kind}/{identifier}.json", sha, now))
            connection.exec_driver_sql("INSERT INTO processing_runs (id, work_version_id, stage, state, input_raw_asset_id, input_artifact_id, output_artifact_id, details_json, started_at, finished_at) VALUES (?, ?, 'analysis', 'succeeded', ?, ?, ?, '{}', ?, ?)",
                (run_id, work_version_id, raw_id, source_id, analysis_id, now, now))
            connection.exec_driver_sql("INSERT INTO current_analyses (id, work_version_id, revision, processing_run_id, parser_artifact_id, analysis_artifact_id, content_json, provenance_json, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, '{}', '{}', ?, ?)",
                (current_id, work_version_id, run_id, parser_id, analysis_id, now, now))

    def test_pending_is_bounded_deterministic_and_pdf_eligibility_is_strict(self) -> None:
        selected = self.repository.select_all_pending(limit=1).work_version_ids
        self.assertEqual(len(selected), 1)
        self.assertEqual(self.repository.get(self.first).eligibility_reason, "primary_pdf_missing")
        raw_id = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, byte_size, provenance_json) VALUES (?, ?, ?, ?, ?, ?, '{}')",
                (raw_id, "a" * 64, "raw/aa/" + "a" * 64, "application/xml", "xml", 1))
            connection.exec_driver_sql("INSERT INTO work_version_assets (work_version_id, raw_asset_id, asset_role) VALUES (?, ?, 'primary_pdf')", (self.first, raw_id))
        self.assertEqual(self.repository.get(self.first).eligibility_reason,
                         "primary_pdf_not_exactly_one_accepted_pdf")

    def test_exact_preferred_pending_force_and_selector_forwarding(self) -> None:
        self.assertEqual(self.repository.select_exact(work_version_id=self.first).work_version_ids, (self.first,))
        self.assertEqual(self.repository.select_exact(work_id=self.first_work).work_version_ids, (self.first,))
        with self.assertRaises(ValueError):
            self.repository.select_exact(work_id=self.first_work, work_version_id=self.first)
        result = type("Result", (), {"items": (type("Item", (), {"work_version_id": self.second})(),)})()
        filters = LibraryFilters(author="A", publication_year=2024, publisher="P", venue="V", tag="T")
        with mock.patch.object(self.repository._library, "search", return_value=result) as search:
            selected = self.repository.select_library("query", filters=filters, limit=7, force=True)
        self.assertEqual(selected.work_version_ids, (self.second,))
        search.assert_called_once_with("query", filters=filters, limit=7)
        with self.assertRaisesRegex(ValueError, "requires force"):
            self.repository.select_all_current(limit=1, force=False)

    def test_pending_excludes_seeded_current_and_exact_query_force_include_it(self) -> None:
        self.seed_current(self.first)
        self.assertNotIn(self.first, self.repository.select_all_pending(limit=10).work_version_ids)
        self.assertEqual(self.repository.select_exact(work_version_id=self.first).work_version_ids, ())
        self.assertEqual(self.repository.select_exact(work_version_id=self.first, force=True).work_version_ids,
                         (self.first,))
        item = type("Item", (), {"work_version_id": self.first})()
        with mock.patch.object(self.repository._library, "search",
                               return_value=type("Result", (), {"items": (item,)})()):
            self.assertEqual(self.repository.select_library("q", filters=LibraryFilters(), limit=10).work_version_ids, ())
            self.assertEqual(self.repository.select_library("q", filters=LibraryFilters(), limit=10,
                                                             force=True).work_version_ids, (self.first,))

    def test_pdf_eligibility_rejects_xml_and_multiple_pdfs_and_accepts_exactly_one(self) -> None:
        def attach(identifier: str, media_type: str) -> None:
            with self.catalog.transaction() as connection:
                connection.exec_driver_sql("INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, byte_size, provenance_json) VALUES (?, ?, ?, ?, ?, ?, '{}')",
                    (identifier, identifier.replace("-", "")[:1] * 64, "raw/" + identifier.replace("-", "")[:1] * 2 + "/" + identifier.replace("-", "")[:1] * 64,
                     media_type, "pdf" if media_type == "application/pdf" else "xml", 1))
                connection.exec_driver_sql("INSERT INTO work_version_assets (work_version_id, raw_asset_id, asset_role) VALUES (?, ?, 'primary_pdf')", (self.first, identifier))
        xml = "10000000-0000-4000-8000-000000000001"
        attach(xml, "application/xml")
        self.assertEqual(self.repository.get(self.first).eligibility_reason, "primary_pdf_not_exactly_one_accepted_pdf")
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("DELETE FROM work_version_assets WHERE work_version_id = ?", (self.first,))
        pdf1, pdf2 = "20000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000001"
        attach(pdf1, "application/pdf")
        self.assertIsNone(self.repository.get(self.first).eligibility_reason)
        attach(pdf2, "application/pdf")
        self.assertEqual(self.repository.get(self.first).eligibility_reason, "primary_pdf_not_exactly_one_accepted_pdf")

    def test_cli_help_publishes_analyze_and_force_confirmation(self) -> None:
        help_text = _build_parser().format_help()
        self.assertIn("analyze", help_text)
        analyze_parser = _build_parser()
        args = analyze_parser.parse_args(["analyze", "--catalog", "x", "--storage-root", "y", "--all-current"])
        with self.assertRaises(SystemExit):
            analyze.validate_arguments(analyze_parser, args)

    def test_cli_validation_is_fail_closed_and_selection_forwards_all_current_force(self) -> None:
        parser = argparse.ArgumentParser()
        analyze.configure_parser(parser)
        config = AnalysisConfig(MinerUConfig(mode="loopback", endpoint="http://127.0.0.1:8000", model="m"),
            LLMConfig(endpoint="https://llm.example/v1", model="m", credential_env="TOKEN"))
        for argv in (("--catalog", "x", "--storage-root", "y"),
                     ("--catalog", "x", "--storage-root", "y", "--work-id", self.first_work, "--query", "q")):
            args = parser.parse_args(argv)
            args._config_analysis = config
            with self.assertRaises(SystemExit):
                analyze.validate_arguments(parser, args)
        args = parser.parse_args(("--catalog", "x", "--storage-root", "y", "--all-current", "--force", "--limit", "3"))
        args._config_analysis = config
        analyze.validate_arguments(parser, args)
        repository = mock.Mock()
        repository.select_all_current.return_value.work_version_ids = (self.first,)
        self.assertEqual(analyze._selection(repository, args), (self.first,))
        repository.select_all_current.assert_called_once_with(limit=3, force=True)

if __name__ == "__main__":
    import unittest
    unittest.main()
