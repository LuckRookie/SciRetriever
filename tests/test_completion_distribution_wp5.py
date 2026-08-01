from __future__ import annotations

import ast
import subprocess
import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from scripts.harness import (
    clean_build_staging,
    find_wheel_content_violations,
)

REPOSITORY = Path(__file__).resolve().parents[1]
SOURCE = REPOSITORY / "src" / "sciretriever"
RETIRED_PATHS = (
    "src/sciretriever/acquisition/backfill.py",
    "src/sciretriever/analysis/backfill.py",
)
RETIRED_SYMBOLS = (
    "execute_work_versions",
    "DownloadBackfillService",
    "AnalysisBackfillService",
    "_download_args",
    "_analysis_args",
)


class CompletionDistributionTests(unittest.TestCase):
    def test_closed_deletion_manifests(self) -> None:
        for relative in RETIRED_PATHS:
            self.assertFalse((REPOSITORY / relative).exists(), relative)
        paths = tuple((REPOSITORY / root).rglob("*.*") for root in ("src", "docs"))
        texts = {
            path.relative_to(REPOSITORY).as_posix(): path.read_text(encoding="utf-8")
            for group in paths
            for path in group
            if path.suffix in {".py", ".md"} and path.name != Path(__file__).name
        }
        for symbol in RETIRED_SYMBOLS:
            self.assertFalse(any(symbol in text for text in texts.values()), symbol)
        for path in (REPOSITORY / "tests").rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            names = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
            names.update(node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute))
            self.assertTrue(set(RETIRED_SYMBOLS).isdisjoint(names), str(path))

    def test_clean_wheel_matches_source_and_excludes_retired_modules(self) -> None:
        with TemporaryDirectory(prefix="sciretriever-wp5-wheel-") as temporary:
            clean_build_staging(REPOSITORY)
            completed = subprocess.run(
                [sys.executable, "-m", "build", "--wheel", "--no-isolation", "--outdir", temporary],
                cwd=REPOSITORY,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            wheel = next(Path(temporary).glob("sciretriever-*.whl"))
            self.assertEqual(find_wheel_content_violations(wheel), ())
            with zipfile.ZipFile(wheel) as archive:
                names = set(archive.namelist())
            for relative in RETIRED_PATHS:
                self.assertNotIn(relative.removeprefix("src/"), names)


if __name__ == "__main__":
    unittest.main()
