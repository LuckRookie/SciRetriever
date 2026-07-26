from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
import zipfile

from sciretriever.cli.main import _build_parser
from scripts.harness import find_wheel_content_violations


REPOSITORY = Path(__file__).resolve().parents[1]
SOURCE = REPOSITORY / "src"
REQUIRED_COMMANDS = {
    "analyze", "catalog", "config", "discover", "download", "expand",
    "failures", "library", "package", "preflight", "search",
}
RETIRED_MODULES = {
    "sciretriever/acquisition/backfill.py",
    "sciretriever/analysis/backfill.py",
    "sciretriever/scheduler.py",
    "sciretriever/migration.py",
}


class CanonicalWp6DistributionTests(unittest.TestCase):
    def test_clean_wheel_is_byte_equal_to_source_and_has_final_surface(self) -> None:
        with TemporaryDirectory(prefix="sciretriever-wp6-wheel-") as temporary:
            output = Path(temporary)
            completed = subprocess.run(
                [sys.executable, "-m", "build", "--wheel", "--no-isolation", "--outdir", str(output)],
                cwd=REPOSITORY,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            wheels = tuple(output.glob("sciretriever-*.whl"))
            self.assertEqual(len(wheels), 1)
            wheel = wheels[0]
            self.assertEqual(find_wheel_content_violations(wheel), ())

            with zipfile.ZipFile(wheel) as archive:
                names = set(archive.namelist())
                modules = sorted(
                    name for name in names
                    if name.startswith("sciretriever/") and name.endswith(".py")
                )
                for name in modules:
                    source = SOURCE / name
                    self.assertEqual(
                        hashlib.sha256(archive.read(name)).digest(),
                        hashlib.sha256(source.read_bytes()).digest(),
                        name,
                    )
            self.assertTrue(RETIRED_MODULES.isdisjoint(names))
            self.assertFalse(any(name.endswith((".sqlite", ".db", ".pid")) for name in names))
            self.assertFalse(any(".workspace-root" in name or name.startswith(("build/", "dist/")) for name in names))

            parser = _build_parser()
            subparsers = next(
                action for action in parser._actions
                if isinstance(action, argparse._SubParsersAction)
            )
            commands = set(subparsers.choices)
            self.assertEqual(commands, REQUIRED_COMMANDS)

    def test_release_has_no_dependency_or_lock_drift(self) -> None:
        completed = subprocess.run(
            ["git", "diff", "--exit-code", "--", "pyproject.toml", "uv.lock"],
            cwd=REPOSITORY,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)


if __name__ == "__main__":
    unittest.main()
