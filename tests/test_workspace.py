import ast
import importlib
import os
import sys
import tempfile
from pathlib import Path
from unittest import TestCase, mock


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

workspace = importlib.import_module("sciretriever.workspace")
WORKSPACE_MARKER = workspace.WORKSPACE_MARKER
WORKSPACE_MARKER_CONTENT = workspace.WORKSPACE_MARKER_CONTENT
WORKSPACE_ROOT_ENV = workspace.WORKSPACE_ROOT_ENV
find_repository_root = workspace.find_repository_root
find_workspace_root = workspace.find_workspace_root
require_staged_write_override = workspace.require_staged_write_override


class WorkspaceResolverTests(TestCase):
    def test_marker_constants_are_exact(self) -> None:
        self.assertEqual(WORKSPACE_MARKER, ".workspace-root")
        self.assertEqual(WORKSPACE_MARKER_CONTENT, b"duanjw-research-workspace:v1\n")
        self.assertEqual(WORKSPACE_ROOT_ENV, "SCIRETRIEVER_WORKSPACE_ROOT")

    def test_valid_marker_is_discovered_from_child(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child = root / "nested" / "child"
            child.mkdir(parents=True)
            (root / WORKSPACE_MARKER).write_bytes(WORKSPACE_MARKER_CONTENT)

            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(find_workspace_root(child), root)

    def test_missing_marker_fails_closed_without_side_effects(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child = root / "child"
            child.mkdir()
            before = tuple(root.iterdir())

            with mock.patch.dict(os.environ, {}, clear=True):
                with self.assertRaisesRegex(RuntimeError, "Unable to find the workspace root"):
                    find_workspace_root(child)

            self.assertEqual(tuple(root.iterdir()), before)
            self.assertFalse((root / WORKSPACE_MARKER).exists())

    def test_wrong_marker_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child = root / "child"
            child.mkdir()
            (root / WORKSPACE_MARKER).write_bytes(b"wrong\n")

            with mock.patch.dict(os.environ, {}, clear=True):
                with self.assertRaisesRegex(RuntimeError, "Malformed workspace marker"):
                    find_workspace_root(child)

    def test_symlink_marker_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child = root / "child"
            child.mkdir()
            target = root / "marker-target"
            target.write_bytes(WORKSPACE_MARKER_CONTENT)
            (root / WORKSPACE_MARKER).symlink_to(target)

            with mock.patch.dict(os.environ, {}, clear=True):
                with self.assertRaisesRegex(RuntimeError, "Invalid workspace marker"):
                    find_workspace_root(child)

    def test_valid_environment_override(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / WORKSPACE_MARKER).write_bytes(WORKSPACE_MARKER_CONTENT)

            with mock.patch.dict(os.environ, {WORKSPACE_ROOT_ENV: str(root)}, clear=True):
                self.assertEqual(find_workspace_root(Path("/")), root)

    def test_invalid_environment_overrides_fail_closed_without_creation(self) -> None:
        marker_cases = (None, b"wrong\n", "symlink")
        for marker_case in marker_cases:
            with self.subTest(marker_case=marker_case), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                marker = root / WORKSPACE_MARKER
                if isinstance(marker_case, bytes):
                    marker.write_bytes(marker_case)
                elif marker_case == "symlink":
                    target = root / "marker-target"
                    target.write_bytes(WORKSPACE_MARKER_CONTENT)
                    marker.symlink_to(target)
                before = tuple(root.iterdir())

                with mock.patch.dict(os.environ, {WORKSPACE_ROOT_ENV: str(root)}, clear=True):
                    with self.assertRaises(RuntimeError):
                        find_workspace_root(Path("/"))

                self.assertEqual(tuple(root.iterdir()), before)

    def test_nonexistent_environment_override_is_not_created(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing"
            with mock.patch.dict(os.environ, {WORKSPACE_ROOT_ENV: str(missing)}, clear=True):
                with self.assertRaisesRegex(RuntimeError, WORKSPACE_ROOT_ENV):
                    find_workspace_root(Path("/"))
            self.assertFalse(missing.exists())

    def test_unrelated_valid_override_cannot_redirect_active_repository(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            unrelated = Path(directory)
            (unrelated / WORKSPACE_MARKER).write_bytes(WORKSPACE_MARKER_CONTENT)

            with mock.patch.dict(os.environ, {WORKSPACE_ROOT_ENV: str(unrelated)}, clear=True):
                with self.assertRaisesRegex(RuntimeError, "does not contain the active SciRetriever repository"):
                    find_workspace_root(REPOSITORY)

    def test_repository_root_is_discovered_from_lowercase_package(self) -> None:
        self.assertEqual(find_repository_root(REPOSITORY / "src" / "sciretriever" / "workspace.py"), REPOSITORY)

    def test_repository_requires_pyproject_and_lowercase_package_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            nested = root / "nested"
            nested.mkdir()
            (root / "pyproject.toml").write_text("[project]\nname = 'fixture'\n", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "repository root"):
                find_repository_root(nested)

            package = root / "src" / "sciretriever"
            package.mkdir(parents=True)
            self.assertEqual(find_repository_root(nested), root)

    def test_staged_write_requires_explicit_override(self) -> None:
        target = REPOSITORY / "guarded.sqlite"
        with self.assertRaisesRegex(PermissionError, "staged SciRetriever repository"):
            require_staged_write_override(
                target,
                allow_staged_write=False,
                start=REPOSITORY,
            )
        self.assertEqual(
            require_staged_write_override(
                target,
                allow_staged_write=True,
                start=REPOSITORY,
            ),
            target.resolve(),
        )

    def test_staged_write_check_fails_closed_for_invalid_markers(self) -> None:
        marker_cases = (None, b"wrong\n", "symlink")
        for marker_case in marker_cases:
            with self.subTest(marker_case=marker_case), tempfile.TemporaryDirectory() as directory:
                workspace_root = Path(directory)
                marker = workspace_root / WORKSPACE_MARKER
                if isinstance(marker_case, bytes):
                    marker.write_bytes(marker_case)
                elif marker_case == "symlink":
                    target = workspace_root / "marker-target"
                    target.write_bytes(WORKSPACE_MARKER_CONTENT)
                    marker.symlink_to(target)

                with mock.patch.dict(
                    os.environ,
                    {WORKSPACE_ROOT_ENV: str(workspace_root)},
                    clear=True,
                ):
                    with self.assertRaisesRegex(PermissionError, "workspace could not be verified"):
                        require_staged_write_override(
                            REPOSITORY / "guarded.sqlite",
                            allow_staged_write=False,
                            start=REPOSITORY,
                        )

    def test_staged_write_check_works_without_source_repository_context(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace_root = Path(directory)
            staged_root = workspace_root / "literature" / "retrieval" / "SciRetriever"
            staged_root.mkdir(parents=True)
            (workspace_root / WORKSPACE_MARKER).write_bytes(WORKSPACE_MARKER_CONTENT)
            target = staged_root / "guarded.sqlite"

            with mock.patch.dict(os.environ, {}, clear=True):
                with self.assertRaisesRegex(PermissionError, "staged SciRetriever repository"):
                    require_staged_write_override(
                        target,
                        allow_staged_write=False,
                        start=workspace_root / "installed-package",
                    )
                self.assertEqual(
                    require_staged_write_override(
                        target,
                        allow_staged_write=True,
                        start=workspace_root / "installed-package",
                    ),
                    target.resolve(),
                )

    def test_runtime_module_has_no_legacy_import(self) -> None:
        module_path = REPOSITORY / "src" / "sciretriever" / "workspace.py"
        tree = ast.parse(module_path.read_text(encoding="utf-8"))
        imported_modules = {
            node.module
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module is not None
        }
        imported_modules.update(
            alias.name
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        )
        self.assertFalse(any(name == "SciRetriever" or name.startswith("SciRetriever.") for name in imported_modules))


if __name__ == "__main__":
    import unittest

    unittest.main()
