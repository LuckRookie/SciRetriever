from cli_wp2_fixture import *


class CliLibraryWp2Tests(CliWp2Fixture):
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

    def test_library_show_by_doi_exposes_only_stable_public_identifiers(self):
        draft, formal, _ = self.seed_library()
        code, output, error = self.invoke([
            "library", "show", "--catalog", str(self.catalog),
            "--doi", " DOI:10.1000/DRAFT ",
        ])
        self.assertEqual((code, error), (0, ""))
        self.assertEqual(json.loads(output), [{
            **json.loads(output)[0],
            "identifiers": [{"namespace": "doi", "value": "10.1000/draft"}],
            "work_version_id": draft.id,
        }])
        for forbidden in ("SECRET-DRAFT", "SECRET-FORMAL", "provider_record_id", "provenance"):
            self.assertNotIn(forbidden, output)
        self.assertNotEqual(draft.id, formal.id)

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
