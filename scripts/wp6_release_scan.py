"""Read-only WP6 release scope, wheel, and artifact scan."""

from __future__ import annotations

from pathlib import Path
from typing import Final
import zipfile

from scripts.architecture_checks import find_architecture_violations
from scripts.wp6_common import git_bytes, load_json
from scripts.wp6_review_manifest import find_wp6_review_manifest_violations


_RETIRED_MARKERS: Final = (
    "scheduler",
    "migration",
    "compatibility",
    "legacy_config",
    "expansion_status",
)
_RUNTIME_SUFFIXES: Final = (".db", ".sqlite", ".sqlite3", ".pid")


def _wheel_violations(root: Path) -> tuple[str, ...]:
    wheels = tuple(sorted((root / "dist").glob("sciretriever-*.whl")))
    if not wheels:
        return ()
    expected = {
        path.relative_to(root / "src").as_posix()
        for path in (root / "src" / "sciretriever").rglob("*.py")
    }
    violations: list[str] = []
    for wheel in wheels:
        if wheel.is_symlink() or not wheel.is_file():
            violations.append(f"{wheel.relative_to(root)}: wheel must be a regular file")
            continue
        try:
            with zipfile.ZipFile(wheel) as archive:
                actual = {
                    name
                    for name in archive.namelist()
                    if name.startswith("sciretriever/") and name.endswith(".py")
                }
        except (OSError, zipfile.BadZipFile) as error:
            violations.append(f"{wheel.relative_to(root)}: invalid wheel: {error}")
            continue
        for path in sorted(actual - expected):
            violations.append(f"wheel contains stale module: {path}")
        for path in sorted(expected - actual):
            violations.append(f"wheel is missing source module: {path}")
    return tuple(violations)


def find_wp6_release_scan_violations(
    root: Path,
    review_path: Path,
) -> tuple[str, ...]:
    violations = list(find_wp6_review_manifest_violations(root, review_path))
    review, error = load_json(review_path)
    if error is not None or not isinstance(review, dict):
        return tuple(sorted(set(violations or [error or "invalid review manifest"])))
    baseline = review.get("baseline_commit")
    if not isinstance(baseline, str):
        return tuple(sorted(set((*violations, "invalid review baseline commit"))))
    dependency_diff, dependency_error = git_bytes(
        root,
        ("diff", "--exit-code", baseline, "--", "pyproject.toml", "uv.lock"),
    )
    if dependency_error is not None or dependency_diff:
        violations.append("release dependency or lockfile drift detected")
    violations.extend(find_architecture_violations(root / "src" / "sciretriever"))
    violations.extend(_wheel_violations(root))
    for path in root.iterdir():
        if path.name in {".venv", "build", "dist"}:
            continue
        if path.is_file() and path.suffix.casefold() in _RUNTIME_SUFFIXES:
            violations.append(f"{path.name}: runtime artifact is forbidden")
    product_rows = review.get("product_files")
    if isinstance(product_rows, list):
        for row in product_rows:
            if not isinstance(row, dict) or not isinstance(row.get("path"), str):
                continue
            relative_value = row.get("path")
            if not isinstance(relative_value, str):
                continue
            relative = relative_value
            lowered = relative.casefold()
            if any(marker in lowered for marker in _RETIRED_MARKERS):
                violations.append(f"{relative}: retired release path or symbol marker")
    return tuple(sorted(set(violations)))


__all__ = ("find_wp6_release_scan_violations",)
