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

from sciretriever.cli import acquire as acquire_cli
from sciretriever.cli.main import _extract_config_selectors, main
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
routing = "race"
asset_role = "primary_pdf"
timeout = 12
host_concurrency = 3
host_min_interval = 0.25
forbidden_urls = "rules/forbidden.txt"
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

    def test_acquisition_providers_and_source_plan_are_mutually_exclusive(self) -> None:
        path = self.write(
            'schema_version = 1\n[acquisition]\nproviders = ["crossref"]\nsource_plan = "plan.json"'
        )
        with self.assertRaisesRegex(ConfigError, "providers and source_plan"):
            load_config(path)
        source_plan = self.write(
            'schema_version = 1\n[acquisition]\nsource_plan = "plans/source-plan.json"',
            "source-plan.toml",
        )
        self.assertEqual(
            load_config(source_plan).acquisition.source_plan,
            (self.base / "plans/source-plan.json").resolve(),
        )


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

    def test_acquisition_config_supplies_paths_defaults_and_cli_source_replaces_plan(self) -> None:
        config = self.write(
            """schema_version = 1
[paths]
catalog = "catalog.sqlite"
storage_root = "storage"
[acquisition]
providers = ["openalex", "semantic-scholar"]
routing = "race"
asset_role = "xml"
timeout = 9
host_concurrency = 4
host_min_interval = 0.5
"""
        )
        with mock.patch("sciretriever.cli.acquire.run", return_value=0) as run:
            self.assertEqual(main(["acquire", "--doi", "10.1/config", "--config", str(config)]), 0)
        args = run.call_args.args[0]
        self.assertEqual(args.providers, ["openalex", "semantic-scholar"])
        self.assertEqual((args.routing, args.asset_role, args.timeout), ("race", "xml", 9.0))
        self.assertEqual((args.catalog, args.storage_root), (self.catalog, self.storage))

        with mock.patch("sciretriever.cli.acquire.run", return_value=0) as run:
            self.assertEqual(main(["acquire", "--doi", "10.1/config", "--provider", "crossref", "--config", str(config)]), 0)
        args = run.call_args.args[0]
        self.assertEqual(args.provider, "crossref")
        self.assertIsNone(args.providers)

    def test_environment_credentials_override_toml_and_all_five_reach_constructors(self) -> None:
        config_path = self.write(
            """schema_version = 1
[credentials]
unpaywall_email = "toml-email"
semantic_scholar_api_key = "toml-s2"
elsevier_api_key = "toml-elsevier"
wiley_api_key = "toml-wiley"
springer_api_key = "toml-springer"
"""
        )
        credentials = load_config(config_path).credentials
        policy = mock.sentinel.policy
        transport = mock.sentinel.transport
        constructors = {
            "unpaywall": ("UnpaywallProvider", "toml-email"),
            "semantic-scholar": ("SemanticScholarProvider", "toml-s2"),
            "elsevier": ("ElsevierProvider", "toml-elsevier"),
            "wiley": ("WileyProvider", "toml-wiley"),
            "springer": ("SpringerProvider", "toml-springer"),
        }
        for provider, (constructor_name, expected) in constructors.items():
            with self.subTest(provider=provider), mock.patch.object(acquire_cli, constructor_name, return_value=mock.sentinel.provider) as constructor, mock.patch.dict(os.environ, {}, clear=True):
                acquire_cli._provider(provider, transport, policy, credentials=credentials)
                self.assertEqual(constructor.call_args.args[1], expected)
        with mock.patch.object(acquire_cli, "WileyProvider", return_value=mock.sentinel.provider) as constructor, mock.patch.dict(os.environ, {"SCIRETRIEVER_WILEY_API_KEY": "environment-wiley"}, clear=True):
            acquire_cli._provider("wiley", transport, policy, credentials=credentials)
        self.assertEqual(constructor.call_args.args[1], "environment-wiley")

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
                "--identifier", "doi=10.1/example", "--config", str(config),
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
