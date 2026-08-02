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

from sciretriever.runtime.config import load_target_config  # noqa: E402


class TargetConfigPathTests(TestCase):
    def setUp(self) -> None:
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

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
