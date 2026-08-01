import subprocess
import sys
from pathlib import Path
import unittest
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever import __version__


class CliEntrypointTests(TestCase):
    def test_module_version_entry_point(self) -> None:
        result = subprocess.run(
            [sys.executable, "-m", "sciretriever.cli.main", "--version"],
            cwd=REPOSITORY,
            env={"PYTHONPATH": str(SRC)},
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, f"{__version__}\n")

    def test_root_shim_version_entry_point(self) -> None:
        result = subprocess.run(
            [sys.executable, "main.py", "--version"],
            cwd=REPOSITORY,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, f"{__version__}\n")

    def test_console_script_targets_cli_main(self) -> None:
        pyproject = (REPOSITORY / "pyproject.toml").read_text(encoding="utf-8")

        self.assertIn(
            'sciretriever = "sciretriever.cli.main:main"',
            pyproject,
        )


if __name__ == "__main__":
    unittest.main()
