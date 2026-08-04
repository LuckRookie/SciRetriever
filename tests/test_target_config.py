import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock

from pydantic import ValidationError

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.composition.configuration import load_target_config  # noqa: E402
from sciretriever.model.configuration import LLMProtocol  # noqa: E402


class TargetConfigTests(TestCase):
    def setUp(self) -> None:
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.data = self.root / "data"
        self.data.mkdir()

    def write(self, body: str, name: str = "target.toml") -> Path:
        path = self.root / name
        path.write_text(body, encoding="utf-8")
        return path

    def base(self, analysis: str = "") -> str:
        return f"""schema_version = 2
[paths]
catalog = "catalog.sqlite"
storage_root = "storage"
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
"""

    def test_final_contract_has_exactly_ten_authoritative_groups(self) -> None:
        config = load_target_config(
            self.write(
                self.base(
                    'protocol = "openai"\nbase_url = "https://api.openai.com/v1"\n'
                    'model = "gpt-5.1"\nsecret_ref = "env:ANALYSIS_API_KEY"\n'
                ),
                "final-contract.toml",
            )
        )
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

    def test_openai_and_anthropic_are_explicit_offline_protocols(self) -> None:
        cases = (
            ("openai", "https://api.openai.com/v1", "gpt-5.1"),
            ("anthropic", "https://api.anthropic.com", "claude-sonnet-4-5"),
        )
        for protocol, base_url, model in cases:
            with self.subTest(protocol=protocol):
                config = load_target_config(
                    self.write(
                        self.base(
                            f'protocol = "{protocol}"\nbase_url = "{base_url}"\n'
                            f'model = "{model}"\nsecret_ref = "env:ANALYSIS_API_KEY"\n'
                        ),
                        f"{protocol}.toml",
                    )
                )
                self.assertEqual(config.analysis.protocol, LLMProtocol(protocol))
                self.assertEqual(config.analysis.model, model)

    def test_models_are_frozen_and_all_target_groups_exist(self) -> None:
        config = load_target_config(
            self.write(
                self.base(
                    'protocol = "openai"\nbase_url = "https://api.openai.com/v1"\n'
                    'model = "gpt-5.1"\nsecret_ref = "env:ANALYSIS_API_KEY"\n'
                )
            )
        )
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
        with self.assertRaises(ValidationError):
            config.analysis.model = "replacement"

    def test_templates_parse_without_environment_or_network(self) -> None:
        sentinel = "SECRET-MUST-NOT-APPEAR"
        analysis = (
            'protocol = "openai"\nbase_url = "https://api.openai.com/v1"\n'
            'model = "gpt-5.1"\nsecret_ref = "env:ANALYSIS_API_KEY"\n'
        )
        minimal_body = self.base(analysis).replace(
            'providers = ["crossref"]',
            'providers = ["crossref", "europe-pmc", "arxiv"]',
            1,
        )
        full_body = self.base(analysis)
        with mock.patch.dict(os.environ, {"ANALYSIS_API_KEY": sentinel}, clear=True):
            minimal = load_target_config(self.write(minimal_body, "minimal.toml"))
            full = load_target_config(self.write(full_body, "full.toml"))
        self.assertEqual(minimal.sources.providers, ("crossref", "europe-pmc", "arxiv"))
        self.assertEqual(full.analysis.protocol, LLMProtocol.OPENAI)
        self.assertNotIn(sentinel, repr(full))
        self.assertNotIn(sentinel, full.model_dump_json())

    def test_unknown_enum_bounds_and_unsafe_paths_fail_before_construction(self) -> None:
        cases = {
            "unknown": self.base() + "\nfuture = true\n",
            "protocol": self.base('protocol = "compatible"'),
            "timeout": self.base(
                'protocol="openai"\nbase_url="https://api.openai.com/v1"\nmodel="m"\nsecret_ref="env:KEY"\ntimeout_seconds=0'
            ),
            "traversal": self.base().replace(
                'catalog = "catalog.sqlite"', 'catalog = "../escape.sqlite"'
            ),
            "nested": self.base().replace('storage_root = "storage"', 'storage_root = "."'),
            "duplicate": self.base().replace('["crossref"]', '["crossref", "crossref"]', 1),
            "repository": self.base().replace(
                'catalog = "catalog.sqlite"', f'catalog = "{REPOSITORY / "runtime.sqlite"}"'
            ),
        }
        for name, body in cases.items():
            with self.subTest(name=name), self.assertRaises(ValidationError):
                load_target_config(self.write(body, f"{name}.toml"))

    def test_legacy_group_names_are_rejected(self) -> None:
        for name in ("metadata", "content", "batching", "interoperability", "extensions"):
            with self.subTest(name=name), self.assertRaises(ValidationError):
                load_target_config(self.write(self.base() + f"\n[{name}]\n", f"{name}.toml"))

    def test_blank_provider_names_are_rejected(self) -> None:
        analysis = (
            'protocol="openai"\nbase_url="https://api.openai.com/v1"\n'
            'model="gpt"\nsecret_ref="env:KEY"'
        )
        with self.assertRaises(ValidationError):
            load_target_config(
                self.write(
                    self.base(analysis).replace('["crossref"]', '[""]', 1),
                    "blank-provider.toml",
                )
            )

    def test_protocol_model_secret_and_url_combinations_fail_closed(self) -> None:
        invalid = (
            'protocol="openai"\nbase_url="https://api.openai.com/v1"\nmodel="gpt-5.1"',
            'protocol="anthropic"\nbase_url="https://api.anthropic.com"\nsecret_ref="env:KEY"',
            'protocol="anthropic"\nbase_url="https://api.anthropic.com?q=secret"\nmodel="claude"\nsecret_ref="env:KEY"',
            'protocol="openai"\nbase_url="https://user@api.openai.com/v1"\nmodel="gpt"\nsecret_ref="env:KEY"',
            'protocol="openai"\nbase_url="https://api.openai.com/v1"\nmodel="gpt"\nsecret_ref="literal-secret"',
        )
        for index, analysis in enumerate(invalid):
            with self.subTest(index=index), self.assertRaises(ValidationError):
                load_target_config(self.write(self.base(analysis), f"combination-{index}.toml"))

    def test_raw_secret_keys_are_rejected_without_echoing_values(self) -> None:
        sentinel = "SECRET-MUST-NOT-APPEAR"
        with self.assertRaises(ValidationError) as raised:
            load_target_config(
                self.write(
                    self.base(
                        'protocol="openai"\nbase_url="https://api.openai.com/v1"\n'
                        f'model="gpt"\nsecret_ref="env:KEY"\napi_key="{sentinel}"'
                    )
                )
            )
        self.assertNotIn(sentinel, str(raised.exception))

    def test_malformed_toml_fails_before_model_construction(self) -> None:
        with self.assertRaises(tomllib.TOMLDecodeError):
            load_target_config(self.write("schema_version = [", "malformed.toml"))

    def test_coercible_scalar_types_are_rejected_in_every_group(self) -> None:
        valid_analysis = (
            'protocol="openai"\nbase_url="https://api.openai.com/v1"\n'
            'model="gpt"\nsecret_ref="env:KEY"'
        )
        cases = (
            ("schema_version = 2", 'schema_version = "2"'),
            ("topic_limit = 1000", 'topic_limit = "1000"'),
            ("timeout_seconds = 30.0", 'timeout_seconds = "30.0"'),
            ("max_asset_bytes = 104857600", 'max_asset_bytes = "104857600"'),
            ("remote_upload = false", 'remote_upload = "false"'),
            ("max_targets = 1000", 'max_targets = "1000"'),
            ("max_input_bytes = 67108864", 'max_input_bytes = "67108864"'),
            ("max_results = 100", 'max_results = "100"'),
        )
        full = self.base(valid_analysis)
        full = full.replace("[parsing]\n", "[parsing]\nremote_upload = false\n", 1)
        full = full.replace("[collection]\n", "[collection]\ntopic_limit = 1000\n", 1)
        full = full.replace("[sources]\n", "[sources]\ntimeout_seconds = 30.0\n", 1)
        full = full.replace("[assets]\n", "[assets]\nmax_asset_bytes = 104857600\n", 1)
        full = full.replace("[execution]\n", "[execution]\nmax_targets = 1000\n", 1)
        full = full.replace(
            "[library]\n",
            "[library]\nmax_input_bytes = 67108864\nmax_results = 100\n",
            1,
        )
        for index, (valid, invalid) in enumerate(cases):
            with self.subTest(index=index), self.assertRaises(ValidationError):
                load_target_config(
                    self.write(full.replace(valid, invalid), f"coercion-{index}.toml")
                )
        with self.assertRaises(ValidationError):
            load_target_config(
                self.write(
                    self.base(valid_analysis).replace(
                        '[assets]\nproviders = ["crossref"]',
                        "[assets]\nproviders = [1]",
                    ),
                    "provider-coercion.toml",
                )
            )


if __name__ == "__main__":
    import unittest

    unittest.main()
