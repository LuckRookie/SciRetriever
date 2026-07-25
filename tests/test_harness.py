import tempfile
import unittest
from pathlib import Path
import zipfile

from scripts.harness import (
    ROOT,
    clean_build_staging,
    find_architecture_violations,
    find_completion_command_violations,
    find_documentation_violations,
    find_wheel_content_violations,
)


class HarnessTests(unittest.TestCase):
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
            "acquisition/bad.py", "from ..discovery import discover\n",
            "acquisition/bad.py: acquisition must not import sciretriever.discovery",
        )

    def test_architecture_gate_detects_imported_package_member(self) -> None:
        self.assert_architecture_violation(
            "core/bad.py", "from sciretriever import discovery\n",
            "core/bad.py: core must not import sciretriever.discovery",
        )

    def test_architecture_gate_rejects_stage_importing_completion(self) -> None:
        self.assert_architecture_violation(
            "analysis/bad.py", "from sciretriever.completion import CompletionStop\n",
            "analysis/bad.py: analysis must not import sciretriever.completion",
        )

    def test_architecture_gate_rejects_completion_importing_cli(self) -> None:
        self.assert_architecture_violation(
            "completion/bad.py", "from sciretriever.cli import main\n",
            "completion/bad.py: completion must not import sciretriever.cli",
        )

    def assert_cutover_violation(self, source_text: str) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            module = source / "cli" / "download.py"
            module.parent.mkdir(parents=True)
            module.write_text(source_text, encoding="utf-8")
            violations = find_completion_command_violations(
                source, frozenset({"download"})
            )
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
