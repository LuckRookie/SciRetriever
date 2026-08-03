from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path

SRC = Path(__file__).parents[1] / "src" / "sciretriever"
STORAGE = SRC / "infrastructure" / "storage"
SQL_PATTERN = re.compile(r"\b(?:SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT)\b")


def _import_names(node: ast.AST) -> tuple[str, ...] | None:
    if isinstance(node, ast.Import):
        return tuple(alias.name for alias in node.names)
    if isinstance(node, ast.ImportFrom):
        return (node.module or "",)
    return None


class TargetStorageBoundaryTests(unittest.TestCase):
    def test_storage_has_no_core_imports(self) -> None:
        for path in sorted(STORAGE.rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                names = _import_names(node)
                if names is None:
                    continue
                self.assertFalse(
                    any(
                        name == "sciretriever.core" or name.startswith("sciretriever.core.")
                        for name in names
                    ),
                    path,
                )

    def test_files_storage_has_no_sql_or_sqlite_dependency(self) -> None:
        files_root = STORAGE / "files"
        for path in sorted(files_root.rglob("*.py")):
            source = path.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=str(path))
            for node in ast.walk(tree):
                names = _import_names(node)
                if names is None:
                    continue
                self.assertNotIn("sqlite3", names, path)
                self.assertFalse(
                    any(
                        name == "sciretriever.infrastructure.storage.sqlite"
                        or name.startswith("sciretriever.infrastructure.storage.sqlite.")
                        for name in names
                    ),
                    path,
                )
            self.assertIsNone(SQL_PATTERN.search(source), path)


if __name__ == "__main__":
    unittest.main()
