import contextlib
import io
import os
from pathlib import Path
import stat
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase, mock


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.cli.main import _extract_config_selectors, _inject_config, main
from sciretriever.config import MAX_CONFIG_BYTES, load_config
from sciretriever.errors import ConfigError
from sciretriever.normalization.contracts import NormalizationParameters


class TomlConfigTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)

    def write(self, text: str, name: str = "config.toml", mode: int = 0o600) -> Path:
        path = self.base / name
        path.write_text(text, encoding="utf-8")
        path.chmod(mode)
        return path

    def test_strict_valid_load_resolves_paths_and_redacts_credentials(self) -> None:
        path = self.write(
            """schema_version = 1
[paths]
catalog = "data/catalog.sqlite"
storage_root = "~/storage"
[credentials]
unpaywall_email = " researcher@example.org "
semantic_scholar_api_key = "s2-secret"
elsevier_api_key = "elsevier-secret"
wiley_api_key = "wiley-secret"
springer_api_key = "springer-secret"
[discovery]
sources = ["crossref", "arxiv"]
limit = 7
timeout = 4.5
taxonomy = "topic"
taxonomy_version = "1"
crossref_mailto = "reader@example.org"
[discovery.filters]
year_from = 2020
year_to = 2025
[discovery.label_rules]
chemistry = ["catalysis", "kinetics"]
[acquisition]
providers = ["openalex", "semantic-scholar"]
timeout = 12
provider_concurrency = 4
host_concurrency = 3
host_min_interval = 0.25
max_asset_bytes = 100000
forbidden_urls = "rules/forbidden.txt"
include_xml = true
include_html = false
[package]
max_input_bytes = 1000
max_pages = 10
max_structural_units = 20
max_depth = 30
max_elements = 40
max_text_characters = 50
summary_max_characters = 60
enrichment = false
"""
        )
        loaded = load_config(path)
        self.assertEqual(loaded.paths.catalog, (self.base / "data/catalog.sqlite").resolve())
        self.assertEqual(loaded.paths.storage_root, Path("~/storage").expanduser().resolve())
        self.assertEqual(loaded.discovery.sources, ("crossref", "arxiv"))
        self.assertEqual(loaded.discovery.filters, (("year_from", "2020"), ("year_to", "2025")))
        self.assertEqual(loaded.acquisition.forbidden_urls, (self.base / "rules/forbidden.txt").resolve())
        encoded = repr(loaded)
        for secret in ("researcher@example.org", "s2-secret", "elsevier-secret", "wiley-secret", "springer-secret"):
            self.assertNotIn(secret, encoded)

    def test_relative_paths_stay_anchored_when_parent_symlink_changes(self) -> None:
        first = self.base / "first"
        second = self.base / "second"
        first.mkdir()
        second.mkdir()
        for directory in (first, second):
            (directory / "config.toml").write_text(
                'schema_version = 1\n[paths]\ncatalog = "catalog.sqlite"',
                encoding="utf-8",
            )
        selected = self.base / "selected"
        selected.symlink_to(first, target_is_directory=True)
        real_open = os.open

        def open_and_swap(path: str | os.PathLike[str], flags: int) -> int:
            descriptor = real_open(path, flags)
            selected.unlink()
            selected.symlink_to(second, target_is_directory=True)
            return descriptor

        with mock.patch("sciretriever.config.os.open", side_effect=open_and_swap):
            config = load_config(selected / "config.toml")
        self.assertEqual(config.paths.catalog, first / "catalog.sqlite")

    def test_canonical_config_directory_replacement_is_rejected(self) -> None:
        selected = self.base / "selected"
        replacement = self.base / "replacement"
        moved = self.base / "moved"
        selected.mkdir()
        replacement.mkdir()
        (selected / "config.toml").write_text(
            'schema_version = 1\n[paths]\ncatalog = "catalog.sqlite"',
            encoding="utf-8",
        )
        real_open = os.open

        def open_and_replace(path: str | os.PathLike[str], flags: int) -> int:
            descriptor = real_open(path, flags)
            selected.rename(moved)
            selected.symlink_to(replacement, target_is_directory=True)
            return descriptor

        with mock.patch("sciretriever.config.os.open", side_effect=open_and_replace):
            with self.assertRaisesRegex(ConfigError, "directory changed while reading"):
                load_config(selected / "config.toml")

    def test_malformed_oversized_symlink_nonregular_and_unknown_fail(self) -> None:
        malformed = self.write("schema_version = [")
        with self.assertRaisesRegex(ConfigError, "valid TOML"):
            load_config(malformed)
        oversized = self.base / "oversized.toml"
        oversized.write_bytes(b"x" * (MAX_CONFIG_BYTES + 1))
        with self.assertRaisesRegex(ConfigError, "exceeds"):
            load_config(oversized)
        target = self.write("schema_version = 1", "target.toml")
        symlink = self.base / "link.toml"
        symlink.symlink_to(target)
        with self.assertRaisesRegex(ConfigError, "non-symlink"):
            load_config(symlink)
        with self.assertRaisesRegex(ConfigError, "regular"):
            load_config(self.base)
        unknown = self.write("schema_version = 1\nunknown = true", "unknown.toml")
        with self.assertRaisesRegex(ConfigError, "unknown"):
            load_config(unknown)

    def test_wrong_versions_types_and_duplicate_collections_fail_by_field(self) -> None:
        cases = {
            "bool-version.toml": "schema_version = true",
            "wrong-version.toml": "schema_version = 2",
            "wrong-path.toml": "schema_version = 1\n[paths]\ncatalog = 2",
            "wrong-limit.toml": "schema_version = 1\n[discovery]\nlimit = true",
            "duplicate-source.toml": 'schema_version = 1\n[discovery]\nsources = ["arxiv", "arxiv"]',
            "duplicate-provider.toml": 'schema_version = 1\n[acquisition]\nproviders = ["wiley", "wiley"]',
            "wrong-enrichment.toml": 'schema_version = 1\n[package]\nenrichment = "yes"',
            "empty-sources.toml": 'schema_version = 1\n[discovery]\nsources = []',
        }
        for name, text in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(ConfigError):
                    load_config(self.write(text, name))

    def test_example_contains_no_active_credentials_and_matches_package_defaults(self) -> None:
        loaded = load_config(REPOSITORY / "config.example.toml")
        self.assertTrue(all(loaded.credentials.get(name) is None for name in (
            "unpaywall_email", "semantic_scholar_api_key", "elsevier_api_key",
            "wiley_api_key", "springer_api_key",
        )))
        defaults = NormalizationParameters()
        self.assertEqual(loaded.package.max_input_bytes, defaults.max_input_bytes)
        self.assertEqual(loaded.package.max_pages, defaults.max_pages)
        self.assertEqual(loaded.package.max_structural_units, defaults.max_structural_units)
        self.assertEqual(loaded.package.max_depth, defaults.max_depth)
        self.assertEqual(loaded.package.max_elements, defaults.max_elements)
        self.assertEqual(loaded.package.max_text_characters, defaults.max_text_characters)
        self.assertIsNotNone(loaded.acquisition.forbidden_urls)
        self.assertTrue(loaded.acquisition.forbidden_urls.is_file())

    def test_credential_mode_is_enforced_without_exposing_value(self) -> None:
        secret = "DO-NOT-PRINT"
        path = self.write(
            f'schema_version = 1\n[credentials]\nwiley_api_key = "{secret}"',
            mode=0o644,
        )
        if os.name == "posix":
            with self.assertRaises(ConfigError) as raised:
                load_config(path)
            self.assertNotIn(secret, str(raised.exception))
            path.chmod(stat.S_IRUSR | stat.S_IWUSR)
        self.assertEqual(load_config(path).credentials.wiley_api_key, secret)

    def test_removed_acquisition_task_keys_are_strictly_rejected(self) -> None:
        for name in ("source_plan", "routing", "asset_role"):
            with self.subTest(name=name), self.assertRaisesRegex(
                ConfigError, f"unknown config field: acquisition.{name}"
            ):
                load_config(self.write(
                    f'schema_version = 1\n[acquisition]\n{name} = "removed"',
                    f"{name}.toml",
                ))

    def test_search_config_accepts_only_wp2_metadata_settings(self) -> None:
        config = load_config(self.write(
            """schema_version = 1
[search]
level = "metadata"
limit = 100
providers = ["crossref", "openalex", "semantic-scholar"]
precedence = ["semantic-scholar", "crossref", "openalex"]
provider_timeout = 8.5
max_concurrency = 3
crossref_mailto = "reader@example.org"
"""
        ))
        self.assertEqual(config.search.level, "metadata")
        self.assertEqual(config.search.limit, 100)
        self.assertEqual(config.search.providers, ("crossref", "openalex", "semantic-scholar"))
        self.assertEqual(config.search.precedence, ("semantic-scholar", "crossref", "openalex"))
        self.assertEqual(config.search.provider_timeout, 8.5)
        self.assertEqual(config.search.max_concurrency, 3)
        self.assertEqual(config.search.crossref_mailto, "reader@example.org")

    def test_search_config_accepts_download_level(self) -> None:
        config = load_config(self.write(
            'schema_version = 1\n[search]\nlevel = "download"',
            "download-level.toml",
        ))
        self.assertEqual(config.search.level, "download")

    def test_search_config_rejects_unknown_wrong_and_future_values(self) -> None:
        cases = {
            "unknown.toml": "unknown = true",
            "level.toml": 'level = "analyze"',
            "limit.toml": "limit = 0",
            "timeout.toml": "provider_timeout = inf",
            "concurrency.toml": "max_concurrency = true",
            "mailto.toml": 'crossref_mailto = "   "',
            "providers-type.toml": 'providers = "crossref"\nprecedence = ["crossref"]',
            "unsupported-provider.toml": 'providers = ["unknown"]\nprecedence = ["unknown"]',
            "duplicate-precedence.toml": 'providers = ["crossref", "arxiv"]\nprecedence = ["crossref", "crossref"]',
        }
        for name, body in cases.items():
            with self.subTest(name=name), self.assertRaises(ConfigError):
                load_config(self.write(f"schema_version = 1\n[search]\n{body}", name))

    def test_search_provider_precedence_must_be_complete_and_exact(self) -> None:
        cases = {
            "providers-only.toml": 'providers = ["crossref"]',
            "precedence-only.toml": 'precedence = ["crossref"]',
            "missing.toml": 'providers = ["crossref", "arxiv"]\nprecedence = ["crossref"]',
            "extra.toml": 'providers = ["crossref"]\nprecedence = ["crossref", "arxiv"]',
            "duplicate-provider.toml": 'providers = ["crossref", "crossref"]\nprecedence = ["crossref"]',
            "empty.toml": "providers = []\nprecedence = []",
        }
        for name, body in cases.items():
            with self.subTest(name=name), self.assertRaises(ConfigError):
                load_config(self.write(f"schema_version = 1\n[search]\n{body}", name))

    def test_preflight_defaults_are_bounded(self) -> None:
        config = load_config(self.write("schema_version = 1"))
        self.assertEqual(config.acquisition.preflight.readiness, "none")
        self.assertEqual(config.acquisition.preflight.timeout, 10.0)
        self.assertGreaterEqual(
            config.acquisition.preflight.min_free_bytes,
            config.acquisition.preflight.max_asset_bytes,
        )

    def test_sci_hub_config_is_strict_opt_in_and_cross_field_consistent(self) -> None:
        disabled = load_config(self.write("schema_version = 1", "sci-disabled.toml"))
        self.assertFalse(disabled.acquisition.sci_hub.enabled)
        self.assertIsNone(disabled.acquisition.sci_hub.base_url)
        enabled = load_config(self.write(
            '''schema_version = 1
[acquisition]
providers = ["crossref", "sci-hub"]
[acquisition.sci_hub]
enabled = true
base_url = "https://authorized.test:443/base"
allowed_pdf_hosts = ["pdf.authorized.test"]
''',
            "sci-enabled.toml",
        ))
        self.assertEqual(enabled.acquisition.sci_hub.allowed_pdf_hosts, ("pdf.authorized.test",))

        invalid = {
            "selected-disabled": '[acquisition]\nproviders = ["sci-hub"]',
            "enabled-unselected": '[acquisition.sci_hub]\nenabled = true\nbase_url = "https://authorized.test"',
            "missing-url": '[acquisition]\nproviders = ["sci-hub"]\n[acquisition.sci_hub]\nenabled = true',
            "unknown": '[acquisition.sci_hub]\nunknown = true',
            "wrong-enabled": '[acquisition.sci_hub]\nenabled = "true"',
            "wrong-hosts": '[acquisition.sci_hub]\nallowed_pdf_hosts = "pdf.test"',
            "uppercase-host": '[acquisition.sci_hub]\nallowed_pdf_hosts = ["PDF.test"]',
            "scheme-host": '[acquisition.sci_hub]\nallowed_pdf_hosts = ["https://pdf.test"]',
            "wildcard-host": '[acquisition.sci_hub]\nallowed_pdf_hosts = ["*.pdf.test"]',
            "duplicate-host": '[acquisition.sci_hub]\nallowed_pdf_hosts = ["pdf.test", "pdf.test"]',
            "http-base": '[acquisition]\nproviders = ["sci-hub"]\n[acquisition.sci_hub]\nenabled = true\nbase_url = "http://authorized.test"',
            "userinfo-base": '[acquisition]\nproviders = ["sci-hub"]\n[acquisition.sci_hub]\nenabled = true\nbase_url = "https://user:secret@authorized.test"',
            "query-base": '[acquisition]\nproviders = ["sci-hub"]\n[acquisition.sci_hub]\nenabled = true\nbase_url = "https://authorized.test?secret=x"',
            "port-base": '[acquisition]\nproviders = ["sci-hub"]\n[acquisition.sci_hub]\nenabled = true\nbase_url = "https://authorized.test:8443"',
        }
        for name, body in invalid.items():
            with self.subTest(name=name), self.assertRaises(ConfigError):
                load_config(self.write(f"schema_version = 1\n{body}", f"sci-{name}.toml"))

    def test_translator_config_is_strict_opt_in_and_validates_templates(self) -> None:
        default = load_config(self.write("schema_version = 1", "translator-default.toml"))
        self.assertFalse(default.acquisition.translator.enabled)
        self.assertEqual(default.acquisition.translator.rules, ())
        enabled = load_config(self.write('''schema_version = 1
[acquisition.translator]
enabled = true
[[acquisition.translator.rules]]
name = "publisher-one"
landing_url_template = "https://landing.example/article?doi={doi}"
allowed_landing_hosts = ["redirect.example"]
allowed_pdf_hosts = ["pdf.example"]
''', "translator-enabled.toml"))
        self.assertEqual(enabled.acquisition.translator.rules[0].name, "publisher-one")
        invalid = {
            "disabled-rules": '''[acquisition.translator]
[[acquisition.translator.rules]]
name = "one"
landing_url_template = "https://landing.example/{doi}"''',
            "enabled-empty": "[acquisition.translator]\nenabled = true",
            "unknown": "[acquisition.translator]\nunknown = true",
            "wrong-enabled": '[acquisition.translator]\nenabled = "true"',
            "duplicate-name": '''[acquisition.translator]
enabled = true
[[acquisition.translator.rules]]
name = "one"
landing_url_template = "https://landing.example/{doi}"
[[acquisition.translator.rules]]
name = "one"
landing_url_template = "https://landing.example/{doi_path}"''',
            "uppercase-name": '''[acquisition.translator]
enabled = true
[[acquisition.translator.rules]]
name = "One"
landing_url_template = "https://landing.example/{doi}"''',
            "http": '''[acquisition.translator]
enabled = true
[[acquisition.translator.rules]]
name = "one"
landing_url_template = "http://landing.example/{doi}"''',
            "uppercase-host": '''[acquisition.translator]
enabled = true
[[acquisition.translator.rules]]
name = "one"
landing_url_template = "https://Landing.example/{doi}"''',
            "authority-placeholder": '''[acquisition.translator]
enabled = true
[[acquisition.translator.rules]]
name = "one"
landing_url_template = "https://{doi}.example/article"''',
            "both": '''[acquisition.translator]
enabled = true
[[acquisition.translator.rules]]
name = "one"
landing_url_template = "https://landing.example/{doi}/{doi_path}"''',
            "unknown-placeholder": '''[acquisition.translator]
enabled = true
[[acquisition.translator.rules]]
name = "one"
landing_url_template = "https://landing.example/{title}"''',
            "wildcard-host": '''[acquisition.translator]
enabled = true
[[acquisition.translator.rules]]
name = "one"
landing_url_template = "https://landing.example/{doi}"
allowed_pdf_hosts = ["*.example"]''',
        }
        for name, body in invalid.items():
            with self.subTest(name=name), self.assertRaises(ConfigError):
                load_config(self.write(f"schema_version = 1\n{body}", f"translator-{name}.toml"))

    def test_removed_automatic_config_and_strict_preflight(self) -> None:
        config = load_config(self.write(
            """schema_version = 1
[acquisition.preflight]
min_free_bytes = 2000
max_asset_bytes = 1000
readiness = "headers"
timeout = 2.5
"""
        ))
        self.assertEqual(config.acquisition.preflight.readiness, "headers")

        with self.assertRaisesRegex(ConfigError, "acquisition.automatic"):
            load_config(self.write(
                "schema_version = 1\n[acquisition.automatic]\nworkers = 1",
                "automatic.toml",
            ))

        invalid = {
            "readiness.toml": '[acquisition.preflight]\nreadiness = "body"',
            "timeout.toml": "[acquisition.preflight]\ntimeout = inf",
            "capacity.toml": "[acquisition.preflight]\nmin_free_bytes = 1\nmax_asset_bytes = 2",
        }
        for name, body in invalid.items():
            with self.subTest(name=name), self.assertRaises(ConfigError):
                load_config(self.write(f"schema_version = 1\n{body}", name))


class ConfigCliTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.catalog = self.base / "catalog.sqlite"
        self.storage = self.base / "storage"
        self.storage.mkdir()

    def write(self, text: str, name: str = "config.toml", mode: int = 0o600) -> Path:
        path = self.base / name
        path.write_text(text, encoding="utf-8")
        path.chmod(mode)
        return path

    def discovery_argv(self, *extra: str) -> list[str]:
        return ["discover", "query", "--output", str(self.base / "out.jsonl"), *extra]

    def test_selectors_work_anywhere_and_explicit_overrides_environment(self) -> None:
        env_config = self.write(
            'schema_version = 1\n[paths]\ncatalog = "env.sqlite"\n[discovery]\ntaxonomy = "env"\ntaxonomy_version = "1"',
            "env.toml",
        )
        explicit = self.write(
            'schema_version = 1\n[paths]\ncatalog = "explicit.sqlite"\n[discovery]\ntaxonomy = "explicit"\ntaxonomy_version = "2"',
            "explicit.toml",
        )
        for argv in (
            ["--config", str(explicit), *self.discovery_argv()],
            [*self.discovery_argv(), f"--config={explicit}"],
        ):
            with self.subTest(argv=argv), mock.patch.dict(os.environ, {"SCIRETRIEVER_CONFIG": str(env_config)}, clear=True), mock.patch("sciretriever.cli.discover.run", return_value=0) as run:
                self.assertEqual(main(argv), 0)
                self.assertEqual(run.call_args.args[0].taxonomy, "explicit")
                self.assertEqual(run.call_args.args[0].catalog, self.base / "explicit.sqlite")

    def test_no_config_disables_environment_and_duplicate_selectors_fail_cleanly(self) -> None:
        config = self.write("schema_version = 1")
        cases = (
            ["--config", str(config), "--config", str(config)],
            ["--config", str(config), "--no-config"],
        )
        for argv in cases:
            error = io.StringIO()
            with self.subTest(argv=argv), contextlib.redirect_stderr(error), self.assertRaises(SystemExit) as raised:
                main(argv)
            self.assertEqual(raised.exception.code, 2)
            self.assertNotIn("Traceback", error.getvalue())
        with mock.patch.dict(os.environ, {"SCIRETRIEVER_CONFIG": str(config)}, clear=True), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            main(["--no-config", *self.discovery_argv()])
        self.assertEqual(raised.exception.code, 2)

    def test_discovery_config_supplies_paths_taxonomy_defaults_and_cli_collections_replace(self) -> None:
        config = self.write(
            """schema_version = 1
[paths]
catalog = "catalog.sqlite"
[discovery]
sources = ["crossref", "arxiv"]
limit = 7
taxonomy = "configured"
taxonomy_version = "1"
[discovery.filters]
year_from = 2020
[discovery.label_rules]
configured = ["term"]
"""
        )
        with mock.patch("sciretriever.cli.discover.run", return_value=0) as run:
            result = main([
                *self.discovery_argv(
                    "--source", "europe-pmc", "--limit", "9", "--filter", "year_to=2025",
                    "--label-rule", "explicit=value",
                ),
                "--config", str(config),
            ])
        self.assertEqual(result, 0)
        args = run.call_args.args[0]
        self.assertEqual(args.source, ["europe-pmc"])
        self.assertEqual(args.limit, 9)
        self.assertEqual(args.filter, [("year_to", "2025")])
        self.assertEqual(args.label_rule, [("explicit", "value")])

    def test_search_config_injection_and_cli_values_replace_config(self) -> None:
        config = load_config(self.write(
            """schema_version = 1
[paths]
catalog = "catalog.sqlite"
[search]
level = "metadata"
limit = 100
providers = ["crossref", "openalex"]
precedence = ["openalex", "crossref"]
provider_timeout = 9.5
max_concurrency = 4
crossref_mailto = "configured@example.org"
"""
        ))
        injected = _inject_config(["search", "catalysis"], config)
        self.assertEqual(injected, [
            "search", "catalysis", "--catalog", str(self.catalog),
            "--level", "metadata", "--limit", "100", "--provider-timeout", "9.5",
            "--max-concurrency", "4", "--crossref-mailto", "configured@example.org",
            "--provider", "crossref", "--provider", "openalex",
            "--precedence", "openalex", "--precedence", "crossref",
        ])

        explicit = [
            "search", "catalysis", "--catalog", "explicit.sqlite", "--level", "metadata",
            "--limit=7", "--provider-timeout", "2", "--max-concurrency=2",
            "--crossref-mailto", "explicit@example.org", "--provider", "arxiv",
            "--precedence", "arxiv",
        ]
        self.assertEqual(_inject_config(explicit, config), explicit)

        provider_only = ["search", "catalysis", "--provider", "arxiv"]
        provider_only_result = _inject_config(provider_only, config)
        self.assertNotIn("--precedence", provider_only_result)
        self.assertEqual(provider_only_result[:4], provider_only)

        precedence_only = ["search", "catalysis", "--precedence", "arxiv"]
        precedence_only_result = _inject_config(precedence_only, config)
        self.assertEqual(precedence_only_result.count("--precedence"), 1)
        self.assertEqual(precedence_only_result[-4:], [
            "--provider", "crossref", "--provider", "openalex",
        ])

    def test_package_enrichment_can_be_overridden_in_both_directions(self) -> None:
        for configured, option, expected in (
            (False, "--enrichment", False),
            (True, "--no-enrichment", True),
        ):
            config = self.write(
                f'schema_version = 1\n[paths]\ncatalog = "catalog.sqlite"\nstorage_root = "storage"\n[package]\nenrichment = {str(configured).lower()}',
                f"package-{configured}.toml",
            )
            with self.subTest(configured=configured), mock.patch("sciretriever.cli.package.run", return_value=0) as run:
                result = main(["package", "--work-id", "id", option, "--config", str(config)])
            self.assertEqual(result, 0)
            self.assertIs(run.call_args.args[0].no_enrichment, expected)

    def test_catalog_create_uses_config_path_and_config_errors_have_no_side_effects(self) -> None:
        config = self.write('schema_version = 1\n[paths]\ncatalog = "created.sqlite"')
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(main(["catalog", "create", "--config", str(config)]), 0)
        self.assertTrue((self.base / "created.sqlite").is_file())
        self.assertNotIn(str(config), output.getvalue())

        invalid = self.write("schema_version = [", "invalid.toml")
        untouched = self.base / "must-not-exist.sqlite"
        error = io.StringIO()
        with contextlib.redirect_stderr(error), self.assertRaises(SystemExit) as raised:
            main(["catalog", "create", "--catalog", str(untouched), "--config", str(invalid)])
        self.assertEqual(raised.exception.code, 2)
        self.assertFalse(untouched.exists())
        self.assertNotIn("Traceback", error.getvalue())

    def test_catalog_import_receives_only_shared_configured_paths(self) -> None:
        config = self.write(
            'schema_version = 1\n[paths]\ncatalog = "catalog.sqlite"\nstorage_root = "storage"'
        )
        with mock.patch("sciretriever.cli.catalog.run", return_value=0) as run:
            result = main([
                "catalog", "import-asset", "--asset", "article.xml", "--asset-role", "xml",
                "--work-version-id", "00000000-0000-4000-8000-000000000001", "--config", str(config),
            ])
        self.assertEqual(result, 0)
        args = run.call_args.args[0]
        self.assertEqual((args.catalog, args.storage_root), (str(self.catalog), str(self.storage)))

    def test_root_help_documents_config_selectors(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as raised:
            main(["--help"])
        self.assertEqual(raised.exception.code, 0)
        self.assertIn("--config", output.getvalue())
        self.assertIn("--no-config", output.getvalue())

    def test_version_ignores_malformed_implicit_config(self) -> None:
        self.write("schema_version = [")
        previous = Path.cwd()
        try:
            os.chdir(self.base)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(main(["--version"]), 0)
        finally:
            os.chdir(previous)
        self.assertTrue(output.getvalue().strip())

    def test_version_validates_explicit_and_environment_config(self) -> None:
        missing = self.base / "missing.toml"
        for argv, environment in (
            (["--version", "--config", str(missing)], {}),
            (["--version"], {"SCIRETRIEVER_CONFIG": str(missing)}),
        ):
            with self.subTest(argv=argv), mock.patch.dict(os.environ, environment, clear=True):
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                    main(argv)
            self.assertEqual(raised.exception.code, 2)

    def test_config_selectors_after_double_dash_are_literal(self) -> None:
        argv = ["discover", "query", "--", "--config=/tmp/literal", "--no-config"]
        self.assertEqual(_extract_config_selectors(argv), (argv, None, False))


if __name__ == "__main__":
    import unittest

    unittest.main()
