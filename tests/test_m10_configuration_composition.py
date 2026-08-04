from __future__ import annotations

import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib
from pydantic import ValidationError

from sciretriever.composition.configuration import (
    EnvironmentSecretResolver,
    SecretResolutionError,
    load_target_config,
    parse_configuration,
    resolve_secret_reference,
    select_configuration_path,
)
from sciretriever.model.configuration import LLMProtocol


class M10ConfigurationCompositionTests(TestCase):
    def setUp(self) -> None:
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def body(
        self,
        extra: str = "",
        *,
        catalog: str = "catalog.sqlite",
        storage_root: str = "storage",
        analysis: str = (
            'protocol = "openai"\nbase_url = "https://api.openai.com/v1"\n'
            'model = "gpt-5.1"\nsecret_ref = "env:SCIRETRIEVER_TEST_SECRET"'
        ),
    ) -> str:
        return f"""schema_version = 2
[paths]
catalog = "{catalog}"
storage_root = "{storage_root}"
[collection]
citation_providers = ["openalex"]
[sources]
providers = ["crossref"]
[assets]
providers = ["crossref"]
[parsing]
protocol = "loopback"
base_url = "http://127.0.0.1:8000"
model = "mineru-3.4.4"
[analysis]
{analysis}
[execution]
[library]
[access]
[credentials]
{extra}
"""

    def test_valid_config_preserves_reference_and_exact_groups(self) -> None:
        config = parse_configuration(self.body(), base_dir=self.root)
        self.assertEqual(config.analysis.protocol, LLMProtocol.OPENAI)
        self.assertEqual(config.analysis.secret_ref, "env:SCIRETRIEVER_TEST_SECRET")
        self.assertEqual(
            tuple(type(config).model_fields),
            (
                "schema_version",
                "paths",
                "collection",
                "sources",
                "assets",
                "parsing",
                "analysis",
                "execution",
                "library",
                "access",
                "credentials",
            ),
        )

    def test_unknown_keys_and_enums_fail_before_wiring(self) -> None:
        cases = (
            self.body("future = true"),
            self.body().replace('protocol = "openai"', 'protocol = "future"'),
            self.body().replace("[sources]\nproviders", "[sources]\nfuture = true\nproviders"),
        )
        for index, body in enumerate(cases):
            with self.subTest(index=index), self.assertRaises(ValidationError):
                parse_configuration(body, base_dir=self.root)

    def test_malformed_toml_and_unknown_environment_are_not_silently_used(self) -> None:
        with self.assertRaises(tomllib.TOMLDecodeError):
            parse_configuration("schema_version = [", base_dir=self.root)
        local = self.root / "config.toml"
        local.write_text(self.body(), encoding="utf-8")
        selected = select_configuration_path(
            environment={"SCIRETRIEVER_UNKNOWN": "ignored"}, cwd=self.root
        )
        self.assertEqual(selected, local)

    def test_explicit_path_has_precedence_over_configuration_environment(self) -> None:
        environment_path = self.root / "environment.toml"
        explicit_path = self.root / "explicit.toml"
        environment_path.write_text(self.body(), encoding="utf-8")
        explicit_path.write_text(self.body(), encoding="utf-8")
        selected = select_configuration_path(
            explicit_path,
            environment={"SCIRETRIEVER_CONFIG": str(environment_path)},
            cwd=self.root,
        )
        self.assertEqual(selected, explicit_path)
        loaded = load_target_config(selected)
        self.assertEqual(loaded.paths.catalog, explicit_path.parent / "catalog.sqlite")

    def test_secret_value_is_not_present_in_config_or_resolution_failure(self) -> None:
        sentinel = "SECRET-MUST-NOT-APPEAR"
        config = parse_configuration(self.body(), base_dir=self.root)
        self.assertNotIn(sentinel, repr(config))
        self.assertNotIn(sentinel, config.model_dump_json())
        resolver = EnvironmentSecretResolver({"SCIRETRIEVER_TEST_SECRET": sentinel})
        self.assertEqual(resolve_secret_reference(config.analysis.secret_ref, resolver), sentinel)
        with self.assertRaises(SecretResolutionError) as raised:
            resolve_secret_reference(
                config.analysis.secret_ref,
                EnvironmentSecretResolver({"SCIRETRIEVER_TEST_SECRET": ""}),
            )
        self.assertNotIn(sentinel, repr(raised.exception))

        class FailingResolver:
            def resolve(self, reference: str) -> str:
                raise RuntimeError(sentinel)

        with self.assertRaises(SecretResolutionError) as sanitized:
            resolve_secret_reference(config.analysis.secret_ref, FailingResolver())
        self.assertNotIn(sentinel, str(sanitized.exception))

    def test_repository_boundary_rejects_repo_but_allows_sibling_and_temp_paths(self) -> None:
        analysis = (
            'protocol="openai"\nbase_url="https://api.openai.com/v1"\n'
            'model="gpt"\nsecret_ref="env:KEY"'
        )
        repository = Path(__file__).resolve().parents[1]
        with TemporaryDirectory() as sibling_name:
            cases = (
                ("repository", repository / "m10-path-case"),
                ("sibling", Path(sibling_name)),
                ("temporary", self.root / "external-path-case"),
            )
            for name, target in cases:
                body = self.body(
                    analysis=analysis,
                    catalog=str(target / "catalog.sqlite"),
                    storage_root=str(target / "storage"),
                )
                if name == "repository":
                    with (
                        self.subTest(name=name),
                        self.assertRaisesRegex(ValidationError, "unsafe_path"),
                    ):
                        parse_configuration(body, base_dir=self.root)
                else:
                    with self.subTest(name=name):
                        config = parse_configuration(body, base_dir=self.root)
                        self.assertEqual(config.paths.catalog, target / "catalog.sqlite")
                        self.assertEqual(config.paths.storage_root, target / "storage")


if __name__ == "__main__":
    import unittest

    unittest.main()
