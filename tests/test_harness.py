import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.harness import (
    ROOT,
    CommandCheck,
    _commands,
    _run,
    active_python_files,
    clean_build_staging,
    find_architecture_violations,
    find_completion_command_violations,
    find_documentation_violations,
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
            ("lint", "format", "compile", "typecheck", "harness tests"),
        )
        for check in commands[:4]:
            self.assertEqual(check.command[-len(files) :], files)
        self.assertEqual(commands[-1].minimum_tests, 1)

    def test_full_commands_extend_quick_with_tests_and_wheel(self) -> None:
        files = ("main.py",)

        quick = _commands("quick", files)
        full = _commands("full", files)

        self.assertEqual(full[: len(quick)], quick)
        self.assertEqual(tuple(check.name for check in full[-2:]), ("tests", "wheel"))
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

    def test_repository_documentation_and_architecture_gates_pass(self) -> None:
        self.assertEqual(find_documentation_violations(ROOT), ())
        self.assertEqual(find_architecture_violations(ROOT / "src" / "sciretriever"), ())

    def assert_architecture_violation(self, relative: str, source_text: str, expected: str) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            module = source / relative
            module.parent.mkdir(parents=True)
            module.write_text(source_text, encoding="utf-8")
            violations = find_architecture_violations(source)
        self.assertEqual(violations, (expected,))

    def test_architecture_gate_detects_cross_capability_import(self) -> None:
        self.assert_architecture_violation(
            "acquisition/bad.py",
            "from sciretriever.discovery import discover\n",
            "acquisition/bad.py: acquisition must not import sciretriever.discovery",
        )

    def test_architecture_gate_resolves_relative_cross_capability_import(self) -> None:
        self.assert_architecture_violation(
            "acquisition/bad.py",
            "from ..discovery import discover\n",
            "acquisition/bad.py: acquisition must not import sciretriever.discovery",
        )

    def test_architecture_gate_detects_imported_package_member(self) -> None:
        self.assert_architecture_violation(
            "core/bad.py",
            "from sciretriever import discovery\n",
            "core/bad.py: core must not import sciretriever.discovery",
        )

    def test_architecture_gate_rejects_stage_importing_completion(self) -> None:
        self.assert_architecture_violation(
            "analysis/bad.py",
            "from sciretriever.completion import CompletionStop\n",
            "analysis/bad.py: analysis must not import sciretriever.completion",
        )

    def test_architecture_gate_rejects_completion_importing_cli(self) -> None:
        self.assert_architecture_violation(
            "completion/bad.py",
            "from sciretriever.cli import main\n",
            "completion/bad.py: completion must not import sciretriever.cli",
        )

    def assert_cutover_violation(self, source_text: str) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            module = source / "cli" / "download.py"
            module.parent.mkdir(parents=True)
            module.write_text(source_text, encoding="utf-8")
            violations = find_completion_command_violations(source, frozenset({"download"}))
        self.assertEqual(
            violations,
            ("cli/download.py: cut-over command must use cli.completion_runtime",),
        )

    def test_command_cutover_gate_detects_direct_stage_construction(self) -> None:
        self.assert_cutover_violation(
            "from sciretriever.acquisition import WorkVersionAcquisitionService\n"
            "service = WorkVersionAcquisitionService()\n"
        )

    def test_command_cutover_rejects_runtime_plus_stage_submodule_sequencing(self) -> None:
        self.assert_cutover_violation(
            "from sciretriever.cli.completion_runtime import CompletionRuntime\n"
            "from sciretriever.acquisition.service import WorkVersionAcquisitionService\n"
            "service = WorkVersionAcquisitionService()\nservice.acquire()\n"
        )

    def test_command_cutover_rejects_runtime_import_of_stage_submodule(self) -> None:
        self.assert_cutover_violation(
            "import importlib\n"
            "from sciretriever.cli.completion_runtime import CompletionRuntime\n"
            "stage = importlib.import_module('sciretriever.analysis.service')\n"
            "stage.AnalysisService().run()\n"
        )

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
