from __future__ import annotations

import email.parser
import unittest
import zipfile
from pathlib import Path

from tests.acceptance.helpers.installed_wheel import InstalledWheel

LEGACY_PACKAGE_ROOTS = (
    "sciretriever/composition/",
    "sciretriever/core/",
    "sciretriever/infrastructure/",
    "sciretriever/interface/",
    "sciretriever/services/",
)
FORBIDDEN_RUNTIME_REQUIREMENTS = (
    "anthropic",
    "beautifulsoup4",
    "bibtexparser",
    "bs4",
    "fake-useragent",
    "ipykernel",
    "openai",
    "requests",
    "sqlalchemy",
)


class WheelContentsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = InstalledWheel()
        cls.install = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fixture.__exit__(None, None, None)

    def _wheel_path(self) -> Path:
        wheel = self.install.wheel
        if wheel is None:
            raise AssertionError("installed-wheel fixture has no built wheel")
        return wheel

    def test_wheel_has_only_the_active_product_package_and_distribution_metadata(self) -> None:
        with zipfile.ZipFile(self._wheel_path()) as archive:
            names = tuple(archive.namelist())
        self.assertTrue(any(name == "sciretriever/__init__.py" for name in names))
        for name in names:
            with self.subTest(name=name):
                self.assertFalse(name.startswith(("tests/", "acceptance/")))
                self.assertNotIn("sitecustomize.py", name)
                self.assertNotIn("__pycache__", name)
                self.assertFalse(name.endswith((".pyc", ".pyo", ".sqlite", ".sqlite3")))
                self.assertFalse(name.startswith(LEGACY_PACKAGE_ROOTS))

    def test_wheel_metadata_has_only_proven_runtime_dependencies_and_console_script(self) -> None:
        with zipfile.ZipFile(self._wheel_path()) as archive:
            metadata_name = next(
                name for name in archive.namelist() if name.endswith(".dist-info/METADATA")
            )
            entry_points_name = next(
                name for name in archive.namelist() if name.endswith(".dist-info/entry_points.txt")
            )
            metadata = email.parser.BytesParser().parsebytes(archive.read(metadata_name))
            entry_points = archive.read(entry_points_name).decode("utf-8")

        requirements = tuple(metadata.get_all("Requires-Dist", ()))
        normalized = tuple(requirement.lower().replace("_", "-") for requirement in requirements)
        self.assertEqual(
            normalized,
            (
                "playwright>=1.55.0",
                "pydantic>=2.12.0",
                "prompt-toolkit>=3.0.51",
                "pypdf2>=3.0.1",
                "rich>=14.1.0",
                'tomli>=1.1.0; python-version < "3.11"',
                "tomlkit>=0.13.3",
            ),
        )
        for forbidden in FORBIDDEN_RUNTIME_REQUIREMENTS:
            self.assertFalse(any(item.startswith(forbidden) for item in normalized))
        self.assertEqual(
            entry_points.strip(),
            "[console_scripts]\nsciretriever = sciretriever.entry.cli.main:main",
        )


if __name__ == "__main__":
    unittest.main()
