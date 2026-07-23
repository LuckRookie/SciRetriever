import importlib
import re
import sys
from pathlib import Path
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


class PackagingTests(TestCase):
    def test_lowercase_packages_are_importable(self) -> None:
        package = importlib.import_module("sciretriever")
        core = importlib.import_module("sciretriever.core")

        self.assertEqual(package.__version__, "0.1.0")
        self.assertEqual(core.__name__, "sciretriever.core")

    def test_shared_error_hierarchy(self) -> None:
        from sciretriever.errors import ConfigError, SciRetrieverError

        self.assertTrue(issubclass(ConfigError, SciRetrieverError))
        self.assertTrue(issubclass(SciRetrieverError, Exception))

    def test_setuptools_discovers_packages_under_src(self) -> None:
        pyproject = (REPOSITORY / "pyproject.toml").read_text(encoding="utf-8")
        table = re.search(
            r"^\[tool\.setuptools\.packages\.find\]\s*$\n(?P<body>.*?)(?=^\[|\Z)",
            pyproject,
            flags=re.MULTILINE | re.DOTALL,
        )
        if table is None:
            self.fail("missing [tool.setuptools.packages.find] table")

        self.assertRegex(table.group("body"), r'(?m)^\s*where\s*=\s*\[\s*"src"\s*\]\s*(?:#.*)?$')
