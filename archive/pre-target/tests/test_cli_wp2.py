from cli_wp2_fixture import *


class CliWp2Tests(CliWp2Fixture):
    def test_help_lists_wp2_commands_subcommands_and_options(self):
        for argv, expected in (
            (["--no-config", "--help"], ("search", "library")),
            (["--no-config", "search", "--help"], (
                "--catalog", "--level", "--provider", "--precedence", "--completion-limit",
                "--filter",
            )),
            (["--no-config", "library", "--help"], ("show", "search", "references", "cited-by", "export")),
            (["--no-config", "library", "search", "--help"], ("--author", "--year", "--publisher", "--venue", "--tag")),
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

    def test_search_explicit_limit_reaches_runtime_arguments(self):
        with mock.patch.object(search_cli, "run", return_value=0) as run:
            code = main([
                "--no-config", "search", "query", "--catalog", str(self.catalog),
                "--limit", "7",
            ])
        self.assertEqual(code, 0)
        self.assertEqual(run.call_args.args[0].limit, 7)

    def test_search_year_filters_reach_typed_request(self):
        captured = []

        def capture(args):
            config = metadata_runtime.MetadataCliConfig(
                args.query, tuple(args.provider), tuple(args.precedence), args.limit,
                args.provider_timeout, args.max_concurrency, args.crossref_mailto,
                filters=tuple(args.filter),
            )
            captured.append(config.request())
            return 0

        with mock.patch.object(search_cli, "run", side_effect=capture):
            code = main([
                "--no-config", "search", "query", "--catalog", str(self.catalog),
                "--filter", "year_from=2020", "--filter", "year_to=2025",
            ])
        self.assertEqual(code, 0)
        self.assertEqual(captured[0].filters, (("year_from", "2020"), ("year_to", "2025")))

    def test_search_rejects_invalid_filters_before_provider_construction(self):
        base = ["search", "query", "--catalog", str(self.catalog)]
        cases = (
            ("malformed", ["--filter", "year_from"]),
            ("unknown", ["--filter", "publisher=Example"]),
            ("nonnumeric", ["--filter", "year_from=20x0"]),
            ("out-of-range", ["--filter", "year_to=10000"]),
            ("duplicate", ["--filter", "year_from=2020", "--filter", "year_from=2021"]),
            ("reversed", ["--filter", "year_from=2026", "--filter", "year_to=2025"]),
        )
        for name, filters in cases:
            with self.subTest(name=name), mock.patch.object(
                metadata_runtime, "build_metadata_providers"
            ) as build_providers:
                self.parse_error([*base, *filters])
                build_providers.assert_not_called()

    def test_exact_doi_discards_search_filters(self):
        captured = []

        def capture(config):
            captured.append(config.metadata.request())
            raise RuntimeError("stop before provider construction")

        with mock.patch.object(search_cli, "build_search_completion_runtime", side_effect=capture):
            code, output, error = self.invoke([
                "search", "10.1000/example", "--catalog", str(self.catalog),
                "--filter", "year_from=2020",
            ])
        self.assertEqual((code, output), (1, ""))
        self.assertEqual(error, "sciretriever: error: metadata search failed\n")
        self.assertEqual(captured[0].filters, ())

    def test_metadata_commands_share_1000_default_and_search_deep_default_is_100(self):
        with mock.patch.object(search_cli, "run", return_value=0) as run:
            code = main(["--no-config", "search", "query", "--catalog", str(self.catalog)])
        self.assertEqual(code, 0)
        args = run.call_args.args[0]
        self.assertEqual((args.limit, args.completion_limit), (1000, 100))

        from sciretriever.cli import discover as discover_cli
        with mock.patch.object(discover_cli, "run", return_value=0) as discover_run:
            code = main([
                "--no-config", "discover", "query", "--catalog", str(self.catalog),
                "--output", str(self.base / "manifest.jsonl"),
                "--taxonomy", "topic", "--taxonomy-version", "1",
            ])
        self.assertEqual(code, 0)
        self.assertEqual(discover_run.call_args.args[0].limit, 1000)

    def test_search_rejects_nonpositive_completion_limit_at_cli_boundary(self):
        base = ["search", "query", "--catalog", str(self.catalog), "--completion-limit"]
        for value in ("0", "-1"):
            with self.subTest(value=value):
                self.assertIn("positive integer", self.parse_error([*base, value]))

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
