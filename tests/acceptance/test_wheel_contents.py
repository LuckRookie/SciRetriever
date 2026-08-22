from __future__ import annotations

import email.parser
import json
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
FORBIDDEN_WHEEL_ARTIFACT_SEGMENTS = (
    "ms-playwright",
    "playwright-browsers",
    "binary-cache",
    "browser-cache",
    "browser-data",
    "browser-profile",
    "cache/",
    "chromium-",
    "chromium-linux",
    "chrome-linux",
    "chrome-mac",
    "chrome-win",
    "firefox-",
    "font-cache",
    "fonts/",
    "profile/",
    "profile-data",
    "profiles/",
    "runtime-cache",
    "runtime-data",
    "screenshots/",
    "user-data",
    "webkit-",
)
FORBIDDEN_WHEEL_ARTIFACT_SUFFIXES = (
    ".bin",
    ".exe",
    ".dll",
    ".dylib",
    ".so",
    ".ttf",
    ".otf",
    ".woff",
    ".woff2",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".mp4",
    ".webm",
    ".har",
    ".trace",
    ".log",
    ".sqlite",
    ".sqlite3",
    ".db",
    ".json",
    ".toml",
    ".yaml",
    ".yml",
)
FORBIDDEN_WHEEL_PATH_PREFIXES = (
    "sciretriever/analysis/providers/",
    "sciretriever/model/llm.py",
)

SOURCE_ROOT = Path(__file__).resolve().parents[2] / "src"


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
        metadata_name = next(name for name in names if name.endswith(".dist-info/METADATA"))
        distribution_root = metadata_name.split("/", 1)[0] + "/"
        for name in names:
            with self.subTest(name=name):
                self.assertTrue(
                    name.startswith(("sciretriever/", distribution_root)),
                    f"unexpected top-level wheel entry: {name}",
                )
                self.assertFalse(name.startswith(("tests/", "acceptance/")))
                self.assertNotIn("sitecustomize.py", name)
                self.assertNotIn("__pycache__", name)
                self.assertFalse(name.endswith((".pyc", ".pyo", ".sqlite", ".sqlite3")))
                self.assertFalse(name.startswith(LEGACY_PACKAGE_ROOTS))
                normalized = name.casefold()
                self.assertFalse(
                    any(
                        normalized.startswith(prefix.casefold())
                        for prefix in FORBIDDEN_WHEEL_PATH_PREFIXES
                    ),
                    f"retired product adapter leaked into wheel: {name}",
                )
                self.assertFalse(
                    any(segment in normalized for segment in FORBIDDEN_WHEEL_ARTIFACT_SEGMENTS),
                    f"browser binary/cache artifact leaked into wheel: {name}",
                )
                self.assertFalse(
                    normalized.endswith(FORBIDDEN_WHEEL_ARTIFACT_SUFFIXES),
                    f"native binary/font artifact leaked into wheel: {name}",
                )

    def test_wheel_python_modules_match_source_and_keep_cloak_agents_adapters(self) -> None:
        expected = {path.relative_to(SOURCE_ROOT).as_posix() for path in SOURCE_ROOT.rglob("*.py")}
        with zipfile.ZipFile(self._wheel_path()) as archive:
            actual = {
                name
                for name in archive.namelist()
                if name.startswith("sciretriever/") and name.endswith(".py")
            }

        self.assertEqual(actual, expected)
        self.assertIn("sciretriever/network/cloakbrowser.py", actual)
        self.assertIn("sciretriever/agents/__init__.py", actual)
        self.assertIn("sciretriever/agents/providers/base.py", actual)
        self.assertNotIn("sciretriever/model/llm.py", actual)
        self.assertFalse(
            any(name.startswith("sciretriever/analysis/providers/") for name in actual)
        )

    def test_fresh_wheel_without_vendor_binary_reports_missing_runtime_safely(self) -> None:
        code = "\n".join(
            (
                "import json",
                "import tempfile",
                "from pathlib import Path",
                "from sciretriever.configuration.cloak_runtime import CloakRuntimeManager",
                "from sciretriever.network.cloakbrowser import cloakbrowser_runtime_availability",
                "with tempfile.TemporaryDirectory(prefix='sciretriever-cba62-') as raw:",
                "    root = Path(raw)",
                "    status = CloakRuntimeManager(home=root).status()",
                "    availability = cloakbrowser_runtime_availability(",
                "        cache_directory=root / 'cache'",
                "    )",
                "    print(json.dumps({",
                "        'presence': status.presence,",
                "        'ready': status.ready,",
                "        'wrapper': availability.cloak_wrapper_available,",
                "        'playwright_api': availability.playwright_api_available,",
                "        'binary': availability.binary_executable_available,",
                "    }, sort_keys=True))",
            )
        )
        result = self.install.run_python(("-I", "-c", code))
        self.assertEqual(result.returncode, 0, result.stderr_text)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(
            json.loads(result.stdout),
            {
                "binary": False,
                "playwright_api": True,
                "presence": "missing",
                "ready": False,
                "wrapper": True,
            },
        )

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
                "cloakbrowser==0.5.8",
                "playwright==1.55.0",
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
