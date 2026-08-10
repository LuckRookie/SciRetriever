import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.harness import (
    CommandCheck,
    _commands,
    _run,
    active_python_files,
    clean_build_staging,
    find_wheel_content_violations,
)


class HarnessTests(unittest.TestCase):
    def test_active_python_files_use_one_sorted_project_scope(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            included = (
                root / "main.py",
                root / "src" / "sciretriever" / "package.py",
                root / "tests" / "test_package.py",
                root / "scripts" / "check.py",
            )
            for path in included:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("", encoding="utf-8")
            excluded = root / "archive" / "legacy.py"
            excluded.parent.mkdir()
            excluded.write_text("", encoding="utf-8")

            files = active_python_files(root)

        self.assertEqual(
            files,
            ("main.py", "scripts/check.py", "src/sciretriever/package.py", "tests/test_package.py"),
        )

    def test_quick_commands_share_the_active_python_file_list(self) -> None:
        files = ("main.py", "scripts/check.py")

        commands = _commands("quick", files)

        self.assertEqual(
            tuple(check.name for check in commands),
            ("lint", "format", "compile"),
        )
        for check in commands:
            self.assertEqual(check.command[-len(files) :], files)

    def test_full_commands_extend_quick_with_typecheck_tests_and_wheel(self) -> None:
        files = ("main.py",)

        quick = _commands("quick", files)
        full = _commands("full", files)

        self.assertEqual(full[: len(quick)], quick)
        self.assertEqual(
            tuple(check.name for check in full[-3:]),
            ("typecheck", "tests", "wheel"),
        )
        self.assertEqual(full[-2].minimum_tests, 1)

    def test_test_command_fails_when_command_reports_zero_tests(self) -> None:
        check = CommandCheck(
            "empty tests",
            (
                sys.executable,
                "-c",
                "import sys; print('Ran 0 tests in 0.000s', file=sys.stderr)",
            ),
            minimum_tests=1,
        )

        passed = _run(check)

        self.assertFalse(passed)

    def test_test_command_uses_outer_summary_after_nested_zero_test_probe(self) -> None:
        check = CommandCheck(
            "nested test probe",
            (
                sys.executable,
                "-c",
                "import sys; "
                "print('Ran 0 tests in 0.000s', file=sys.stderr); "
                "print('Ran 2 tests in 0.001s', file=sys.stderr)",
            ),
            minimum_tests=1,
        )

        passed = _run(check)

        self.assertTrue(passed)

    def test_clean_build_staging_removes_deleted_module_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stale = root / "build" / "lib" / "sciretriever" / "deleted.py"
            stale.parent.mkdir(parents=True)
            stale.write_text("stale = True\n", encoding="utf-8")
            dist = root / "dist"
            dist.mkdir()
            wheel = dist / "sciretriever-0.0.0-py3-none-any.whl"
            wheel.write_bytes(b"stale")
            clean_build_staging(root)
            self.assertFalse((root / "build").exists())
            self.assertFalse(wheel.exists())

    def test_clean_build_staging_rejects_symlinked_dist_without_deleting_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            external = root / "external"
            external.mkdir()
            wheel = external / "sciretriever-0.0.0-py3-none-any.whl"
            wheel.write_bytes(b"evidence")
            (root / "dist").symlink_to(external, target_is_directory=True)

            with self.assertRaisesRegex(RuntimeError, "dist must not be a symbolic link"):
                clean_build_staging(root)

            self.assertEqual(wheel.read_bytes(), b"evidence")

    def test_wheel_content_gate_detects_stale_and_missing_modules(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "src" / "sciretriever"
            package.mkdir(parents=True)
            (package / "current.py").write_text("current = True\n", encoding="utf-8")
            wheel = root / "sciretriever.whl"
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr("sciretriever/stale.py", "stale = True\n")
            self.assertEqual(
                find_wheel_content_violations(wheel, root / "src"),
                (
                    "wheel contains stale module: sciretriever/stale.py",
                    "wheel is missing source module: sciretriever/current.py",
                ),
            )


if __name__ == "__main__":
    unittest.main()
