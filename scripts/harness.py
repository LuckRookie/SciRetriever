"""Unified local and CI quality gates for SciRetriever."""

from __future__ import annotations

import argparse
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.architecture_checks import (
    find_architecture_violations as _find_architecture_violations,
    find_completion_command_violations,
)
from scripts.documentation_checks import find_documentation_violations
from scripts.governance_checks import find_document_governance_violations


SOURCE_ROOT = ROOT / "src" / "sciretriever"
PACKAGE_ROOTS = ("sciretriever",)


@dataclass(frozen=True, slots=True)
class CommandCheck:
    name: str
    command: tuple[str, ...]


def find_architecture_violations(source_root: Path = SOURCE_ROOT) -> tuple[str, ...]:
    return _find_architecture_violations(source_root)


def clean_build_staging(root: Path = ROOT) -> None:
    shutil.rmtree(root / "build", ignore_errors=True)
    for wheel in (root / "dist").glob("sciretriever-*.whl"):
        wheel.unlink()


def find_wheel_content_violations(
    wheel: Path, source_root: Path = ROOT / "src",
) -> tuple[str, ...]:
    expected = {
        path.relative_to(source_root).as_posix()
        for package in PACKAGE_ROOTS
        for path in (source_root / package).rglob("*.py")
    }
    with zipfile.ZipFile(wheel) as archive:
        actual = {name for name in archive.namelist()
                  if name.endswith(".py") and name.split("/", 1)[0] in PACKAGE_ROOTS}
    violations = [f"wheel contains stale module: {name}" for name in actual - expected]
    violations.extend(f"wheel is missing source module: {name}" for name in expected - actual)
    return tuple(sorted(violations))


def _report_gate(name: str, violations: Iterable[str]) -> bool:
    items = tuple(violations)
    if not items:
        print(f"[harness] {name}: passed")
        return True
    print(f"[harness] {name}: failed", file=sys.stderr)
    for item in items:
        print(f"  - {item}", file=sys.stderr)
    return False


def _run(check: CommandCheck) -> bool:
    if check.name == "wheel":
        clean_build_staging()
    print(f"[harness] {check.name}: {' '.join(check.command)}")
    completed = subprocess.run(check.command, cwd=ROOT, check=False)
    if completed.returncode != 0:
        print(f"[harness] {check.name}: failed with exit code {completed.returncode}",
              file=sys.stderr)
        return False
    if check.name == "wheel":
        wheels = tuple((ROOT / "dist").glob("sciretriever-*.whl"))
        if not wheels:
            print("[harness] wheel: build produced no wheel", file=sys.stderr)
            return False
        wheel = max(wheels, key=lambda path: path.stat().st_mtime_ns)
        if not _report_gate("wheel contents", find_wheel_content_violations(wheel)):
            return False
    print(f"[harness] {check.name}: passed")
    return True


def _commands(mode: str) -> tuple[CommandCheck, ...]:
    compile_check = CommandCheck(
        "compile", (sys.executable, "-m", "compileall", "-q", "src", "tests", "scripts", "main.py")
    )
    if mode == "quick":
        return (
            compile_check,
            CommandCheck("harness tests", (sys.executable, "-m", "unittest", "discover",
                                            "-s", "tests", "-p", "test_harness*.py")),
            CommandCheck("CLI tests", (sys.executable, "-m", "unittest", "discover",
                                        "-s", "tests", "-p", "test_cli.py")),
        )
    return (
        compile_check,
        CommandCheck("typecheck", ("pyright", "src/sciretriever", "tests", "scripts")),
        CommandCheck("tests", (sys.executable, "-m", "unittest", "discover", "-s", "tests")),
        CommandCheck("wheel", (sys.executable, "-m", "build", "--wheel", "--no-isolation")),
    )


def run(mode: str) -> int:
    ok = True
    if mode in {"quick", "full", "docs"}:
        ok = _report_gate("documentation", find_documentation_violations()) and ok
    if mode in {"quick", "full", "architecture"}:
        ok = _report_gate("architecture", find_architecture_violations()) and ok
    if mode in {"quick", "full"}:
        for check in _commands(mode):
            ok = _run(check) and ok
    return 0 if ok else 1


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("quick", "full", "docs", "architecture"))
    return run(parser.parse_args(argv).mode)


if __name__ == "__main__":
    raise SystemExit(main())
