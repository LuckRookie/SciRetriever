import importlib.util
import os
import sys
import tempfile
from pathlib import Path
from unittest import TestCase, mock


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from SciRetriever.database.optera import Delete, Insert, Optera, Query, Update
from SciRetriever.database.retired_paths import RETIRED_DATABASE_PATHS, retired_database_paths
from SciRetriever.workspace_paths import (
    WORKSPACE_MARKER_CONTENT,
    find_workspace_root,
    require_staged_write_override,
)


def load_script(name: str):
    path = REPOSITORY / "work" / name
    spec = importlib.util.spec_from_file_location(f"test_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DatabaseRetirementTests(TestCase):
    def test_all_subclasses_fail_missing_without_creation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing.db"
            for class_ in (Optera, Insert, Query, Update, Delete):
                with self.subTest(class_=class_.__name__), self.assertRaises(FileNotFoundError):
                    class_.connect_db(missing)
                self.assertFalse(missing.exists())

    def test_explicit_scratch_creation_succeeds(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            scratch = Path(directory) / "scratch.db"
            Insert.connect_db(scratch, create_db=True)
            self.assertTrue(scratch.is_file())
            Query.connect_db(scratch, create_db=False)

    def test_all_nine_retired_active_paths_are_refused(self) -> None:
        workspace = REPOSITORY.parents[2]
        self.assertEqual(len(RETIRED_DATABASE_PATHS), 9)
        for relative in RETIRED_DATABASE_PATHS:
            with self.subTest(relative=relative), self.assertRaisesRegex(PermissionError, "retired database"):
                Insert.connect_db(workspace / relative, create_db=True)

    def test_cli_omitted_database_arguments_do_not_mutate(self) -> None:
        scripts = (load_script("combin.py"), load_script("filter_database.py"), load_script("semantic_bulk.py"))
        with tempfile.TemporaryDirectory() as directory:
            current = Path(directory)
            before = set(current.iterdir())
            for script in scripts:
                with self.subTest(script=script.__name__), mock.patch.object(sys, "argv", [script.__file__]):
                    with self.assertRaises(SystemExit):
                        script.parse_args()
            self.assertEqual(set(current.iterdir()), before)

    def test_retired_alias_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            alias = Path(directory) / "alias"
            alias.symlink_to(REPOSITORY, target_is_directory=True)
            with self.assertRaises(PermissionError):
                Insert.connect_db(alias / "all.db", create_db=True)

    def test_workspace_marker_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child = root / "child"
            child.mkdir()
            with self.assertRaises(RuntimeError):
                find_workspace_root(child)
            marker = root / ".workspace-root"
            marker.write_bytes(b"wrong\n")
            with self.assertRaises(RuntimeError):
                find_workspace_root(child)
            marker.unlink()
            marker_target = root / "marker-target"
            marker_target.write_bytes(WORKSPACE_MARKER_CONTENT)
            marker.symlink_to(marker_target)
            with self.assertRaises(RuntimeError):
                find_workspace_root(child)
            marker.unlink()
            marker.write_bytes(WORKSPACE_MARKER_CONTENT)
            self.assertEqual(find_workspace_root(child), root)
            with mock.patch.dict(os.environ, {"SCIRETRIEVER_WORKSPACE_ROOT": str(root)}):
                self.assertEqual(find_workspace_root(Path("/")), root)

    def test_normal_workspace_override_for_repository(self) -> None:
        workspace = REPOSITORY.parents[2]
        with mock.patch.dict(os.environ, {"SCIRETRIEVER_WORKSPACE_ROOT": str(workspace)}):
            self.assertEqual(find_workspace_root(REPOSITORY), workspace)

    def test_unrelated_valid_marker_override_cannot_redirect_repository(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            unrelated = Path(directory)
            (unrelated / ".workspace-root").write_bytes(WORKSPACE_MARKER_CONTENT)
            with mock.patch.dict(os.environ, {"SCIRETRIEVER_WORKSPACE_ROOT": str(unrelated)}):
                with self.assertRaisesRegex(RuntimeError, "does not contain the active SciRetriever repository"):
                    find_workspace_root(REPOSITORY)
                with self.assertRaises(RuntimeError):
                    retired_database_paths(unrelated)

    def test_retired_paths_ignore_unrelated_start(self) -> None:
        workspace = REPOSITORY.parents[2]
        with tempfile.TemporaryDirectory() as directory:
            paths = retired_database_paths(Path(directory))
        self.assertEqual(paths, frozenset((workspace / path).resolve() for path in RETIRED_DATABASE_PATHS))

    def test_staged_write_check_fails_closed_for_invalid_markers(self) -> None:
        marker_cases = (None, b"wrong\n", "symlink")
        for marker_case in marker_cases:
            with self.subTest(marker_case=marker_case), tempfile.TemporaryDirectory() as directory:
                workspace = Path(directory)
                marker = workspace / ".workspace-root"
                if isinstance(marker_case, bytes):
                    marker.write_bytes(marker_case)
                elif marker_case == "symlink":
                    target = workspace / "marker-target"
                    target.write_bytes(WORKSPACE_MARKER_CONTENT)
                    marker.symlink_to(target)
                with mock.patch.dict(os.environ, {"SCIRETRIEVER_WORKSPACE_ROOT": str(workspace)}):
                    with self.assertRaisesRegex(PermissionError, "workspace could not be verified"):
                        require_staged_write_override(
                            REPOSITORY / "guarded.db",
                            allow_staged_write=False,
                            start=REPOSITORY,
                        )
