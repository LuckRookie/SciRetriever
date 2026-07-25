from cli_wp2_fixture import *


class CliWp2Tests(CliWp2Fixture):
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
        with mock.patch.object(metadata_runtime, "build_metadata_providers", return_value=providers):
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
        with mock.patch.object(metadata_runtime, "build_metadata_providers", return_value=providers):
            code, output, error = self.invoke([
                "search", "query", "--catalog", str(self.catalog),
                "--provider", "crossref", "--provider", "arxiv",
            ])
        self.assertEqual((code, output), (1, ""))
        self.assertEqual(error, "sciretriever: error: all metadata search providers failed\n")
        self.assertEqual(self.counts(), before)

    def test_provider_construction_failure_is_sanitized(self):
        with mock.patch.object(
            metadata_runtime, "build_metadata_providers", side_effect=RuntimeError("api_key=TOPSECRET")
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
            metadata_runtime,
            "build_metadata_providers",
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
