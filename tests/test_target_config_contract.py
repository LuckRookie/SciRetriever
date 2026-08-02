import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from types import ModuleType
from unittest import TestCase

from pydantic import ValidationError

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import sciretriever.model.configuration as configuration_module  # noqa: E402
from sciretriever.runtime.config import load_target_config  # noqa: E402


class TargetConfigContractTests(TestCase):
    def setUp(self) -> None:
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def write(self, body: str, name: str) -> Path:
        path = self.root / name
        path.write_text(body, encoding="utf-8")
        return path

    def base(self, analysis: str) -> str:
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

    def test_target_groups_are_strict_frozen_and_model_is_legacy_free(self) -> None:
        config = load_target_config(
            self.write(
                self.base(
                    'protocol = "openai"\nbase_url = "https://api.openai.com/v1"\n'
                    'model = "gpt-5.1"\nsecret_ref = "env:ANALYSIS_API_KEY"\n'
                ),
                "model-contract.toml",
            )
        )
        for name in tuple(type(config).model_fields)[1:]:
            group_type = type(getattr(config, name))
            self.assertTrue(group_type.model_config["frozen"])
            self.assertEqual(group_type.model_config["extra"], "forbid")
        legacy_modules = tuple(
            value.__name__
            for value in vars(configuration_module).values()
            if isinstance(value, ModuleType) and value.__name__.startswith("sciretriever.legacy")
        )
        self.assertEqual(legacy_modules, ())

    def test_access_group_is_empty_and_rejects_unrecognized_settings(self) -> None:
        analysis = (
            'protocol="openai"\nbase_url="https://api.openai.com/v1"\n'
            'model="gpt"\nsecret_ref="env:KEY"'
        )
        config = load_target_config(self.write(self.base(analysis), "empty-access.toml"))
        self.assertEqual(config.access.model_dump(), {})
        with self.assertRaises(ValidationError):
            load_target_config(
                self.write(
                    self.base(analysis).replace("[access]", "[access]\nmax_concurrency = 1"),
                    "access-setting.toml",
                )
            )


if __name__ == "__main__":
    import unittest

    unittest.main()
