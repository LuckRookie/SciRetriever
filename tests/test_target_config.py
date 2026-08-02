import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock

from pydantic import ValidationError

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.model.configuration import LLMProtocol  # noqa: E402
from sciretriever.runtime.config import load_target_config  # noqa: E402


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
[metadata]
providers = ["crossref"]
[content.acquisition]
providers = ["crossref"]
[content.parser]
protocol = "loopback"
base_url = "http://127.0.0.1:8000"
model = "mineru-3.4.4"
[content.analysis]
{analysis}
[batching]
[interoperability]
[credentials]
[extensions]
"""

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
                self.assertEqual(config.content.analysis.protocol, LLMProtocol(protocol))
                self.assertEqual(config.content.analysis.model, model)

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
                "metadata",
                "content",
                "batching",
                "interoperability",
                "credentials",
                "extensions",
            ),
        )
        with self.assertRaises(ValidationError):
            config.content.analysis.model = "replacement"

    def test_templates_parse_without_environment_or_network(self) -> None:
        sentinel = "SECRET-MUST-NOT-APPEAR"
        with mock.patch.dict(os.environ, {"ANALYSIS_API_KEY": sentinel}, clear=True):
            minimal = load_target_config(REPOSITORY / "docs/guides/config.target.minimal.toml")
            full = load_target_config(REPOSITORY / "docs/guides/config.target.toml")
        self.assertEqual(minimal.metadata.providers, ("crossref", "europe-pmc", "arxiv"))
        self.assertEqual(full.content.analysis.protocol, LLMProtocol.OPENAI)
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
        full = (REPOSITORY / "docs/guides/config.target.toml").read_text(encoding="utf-8")
        for index, (valid, invalid) in enumerate(cases):
            with self.subTest(index=index), self.assertRaises(ValidationError):
                load_target_config(
                    self.write(full.replace(valid, invalid), f"coercion-{index}.toml")
                )
        with self.assertRaises(ValidationError):
            load_target_config(
                self.write(
                    self.base(valid_analysis).replace(
                        '[content.acquisition]\nproviders = ["crossref"]',
                        "[content.acquisition]\nproviders = [1]",
                    ),
                    "provider-coercion.toml",
                )
            )

    def test_original_path_symlinks_and_unsafe_permissions_fail_closed(self) -> None:
        analysis = (
            'protocol="openai"\nbase_url="https://api.openai.com/v1"\n'
            'model="gpt"\nsecret_ref="env:KEY"'
        )
        safe_storage = self.root / "safe-storage"
        safe_storage.mkdir(mode=0o700)
        storage_link = self.root / "storage-link"
        storage_link.symlink_to(safe_storage, target_is_directory=True)
        catalog_target = self.root / "catalog-target.sqlite"
        catalog_target.touch(mode=0o600)
        catalog_link = self.root / "catalog-link.sqlite"
        catalog_link.symlink_to(catalog_target)
        unsafe_root = self.root / "unsafe-root"
        unsafe_root.mkdir(mode=0o770)
        unsafe_root.chmod(0o770)
        bodies = (
            self.base(analysis).replace(
                'storage_root = "storage"', 'storage_root = "storage-link"'
            ),
            self.base(analysis).replace(
                'catalog = "catalog.sqlite"', 'catalog = "catalog-link.sqlite"'
            ),
            self.base(analysis).replace('storage_root = "storage"', 'storage_root = "unsafe-root"'),
            self.base(analysis).replace(
                'catalog = "catalog.sqlite"', 'catalog = "unsafe-root/catalog.sqlite"'
            ),
        )
        for index, body in enumerate(bodies):
            with self.subTest(index=index), self.assertRaisesRegex(ValidationError, "unsafe_path"):
                load_target_config(self.write(body, f"unsafe-path-{index}.toml"))

    def test_wrong_owner_alias_and_safe_nonexistent_targets(self) -> None:
        valid = load_target_config(
            self.write(
                self.base(
                    'protocol="openai"\nbase_url="https://api.openai.com/v1"\n'
                    'model="gpt"\nsecret_ref="env:KEY"'
                ),
                "safe-paths.toml",
            )
        )
        self.assertFalse(valid.paths.catalog.exists())
        self.assertFalse(valid.paths.storage_root.exists())

        with mock.patch("os.getuid", return_value=os.getuid() + 1):
            with self.assertRaisesRegex(ValidationError, "unsafe_path"):
                load_target_config(self.root / "safe-paths.toml")

        catalog = self.root / "catalog.sqlite"
        alias = self.root / "catalog-alias.sqlite"
        catalog.touch(mode=0o600)
        os.link(catalog, alias)
        with self.assertRaisesRegex(ValidationError, "unsafe_path"):
            load_target_config(self.root / "safe-paths.toml")

    def test_equal_normalized_paths_and_lexical_aliases_fail(self) -> None:
        analysis = (
            'protocol="openai"\nbase_url="https://api.openai.com/v1"\n'
            'model="gpt"\nsecret_ref="env:KEY"'
        )
        aliases = (
            ('catalog = "same"', 'storage_root = "same"'),
            ('catalog = "same"', 'storage_root = "./same"'),
        )
        for index, (catalog, storage) in enumerate(aliases):
            body = self.base(analysis).replace('catalog = "catalog.sqlite"', catalog)
            body = body.replace('storage_root = "storage"', storage)
            with (
                self.subTest(index=index),
                self.assertRaisesRegex(ValidationError, "must not overlap"),
            ):
                load_target_config(self.write(body, f"equal-alias-{index}.toml"))

        parent_alias = (
            self.base(analysis)
            .replace('catalog = "catalog.sqlite"', 'catalog = "nested/../same"')
            .replace('storage_root = "storage"', 'storage_root = "same"')
        )
        with self.assertRaisesRegex(ValidationError, "unsafe_path"):
            load_target_config(self.write(parent_alias, "parent-alias.toml"))

        siblings = load_target_config(self.write(self.base(analysis), "safe-siblings.toml"))
        self.assertNotEqual(siblings.paths.catalog, siblings.paths.storage_root)


if __name__ == "__main__":
    import unittest

    unittest.main()
