"""Unified local and CI quality gates for SciRetriever."""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import zipfile
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

PACKAGE_ROOTS = ("sciretriever",)
TEST_COUNT_PATTERN = re.compile(r"Ran\s+(\d+)\s+tests?")


@dataclass(frozen=True, slots=True)
class CommandCheck:
    name: str
    command: tuple[str, ...]
    minimum_tests: int | None = None


class UnsafeBuildStagingError(RuntimeError):
    def __init__(self, path: Path) -> None:
        super().__init__(f"{path.name} must not be a symbolic link")


def active_python_files(root: Path = ROOT) -> tuple[str, ...]:
    files = {path for path in root.glob("*.py") if path.is_file()}
    for relative in ("src/sciretriever", "tests", "scripts"):
        directory = root / relative
        if directory.is_dir():
            files.update(path for path in directory.rglob("*.py") if path.is_file())
    return tuple(sorted(path.relative_to(root).as_posix() for path in files))


def clean_build_staging(root: Path = ROOT) -> None:
    build = root / "build"
    dist = root / "dist"
    for staging_path in (build, dist):
        if staging_path.is_symlink():
            raise UnsafeBuildStagingError(staging_path)
    shutil.rmtree(build, ignore_errors=True)
    for wheel in dist.glob("sciretriever-*.whl"):
        wheel.unlink()


def find_wheel_content_violations(
    wheel: Path,
    source_root: Path = ROOT / "src",
) -> tuple[str, ...]:
    expected = {
        path.relative_to(source_root).as_posix()
        for package in PACKAGE_ROOTS
        for path in (source_root / package).rglob("*.py")
    }
    with zipfile.ZipFile(wheel) as archive:
        actual = {
            name
            for name in archive.namelist()
            if name.endswith(".py") and name.split("/", 1)[0] in PACKAGE_ROOTS
        }
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
    capture = check.minimum_tests is not None
    completed = subprocess.run(
        check.command,
        cwd=ROOT,
        check=False,
        capture_output=capture,
        text=capture,
    )
    if capture:
        sys.stdout.write(completed.stdout)
        sys.stderr.write(completed.stderr)
    if completed.returncode != 0:
        print(
            f"[harness] {check.name}: failed with exit code {completed.returncode}",
            file=sys.stderr,
        )
        return False
    if check.minimum_tests is not None:
        matches = tuple(TEST_COUNT_PATTERN.finditer(f"{completed.stdout}\n{completed.stderr}"))
        count = 0 if not matches else int(matches[-1].group(1))
        if count < check.minimum_tests:
            print(
                f"[harness] {check.name}: expected at least "
                f"{check.minimum_tests} tests, ran {count}",
                file=sys.stderr,
            )
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


def _commands(
    mode: str,
    python_files: Sequence[str] | None = None,
) -> tuple[CommandCheck, ...]:
    files = active_python_files() if python_files is None else tuple(python_files)
    shared = (
        CommandCheck("lint", ("ruff", "check", *files)),
        CommandCheck("format", ("ruff", "format", "--check", *files)),
        CommandCheck(
            "compile",
            (sys.executable, "-m", "compileall", "-q", *files),
        ),
    )
    if mode == "quick":
        return shared
    return shared + (
        CommandCheck("typecheck", ("pyright", *files)),
        CommandCheck(
            "tests",
            (sys.executable, "-m", "unittest", "discover", "-s", "tests"),
            minimum_tests=1,
        ),
        CommandCheck(
            "wheel",
            (sys.executable, "-m", "build", "--wheel", "--no-isolation"),
        ),
    )


def run(mode: str) -> int:
    ok = True
    for check in _commands(mode):
        ok = _run(check) and ok
    return 0 if ok else 1


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("quick", "full"))
    return run(parser.parse_args(argv).mode)


if __name__ == "__main__":
    raise SystemExit(main())
