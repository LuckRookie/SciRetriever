"""Exact tokenize-physical-v1 diff-scoped pure-LOC gate."""

from __future__ import annotations

import ast
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
import re
import tokenize
from typing import Final

from scripts.wp6_baseline import load_todo1_baseline
from scripts.wp6_common import changed_paths, git_bytes, load_json


_IGNORED_TOKENS: Final = frozenset(
    {
        tokenize.ENCODING,
        tokenize.NL,
        tokenize.NEWLINE,
        tokenize.INDENT,
        tokenize.DEDENT,
        tokenize.COMMENT,
        tokenize.ENDMARKER,
    }
)
@dataclass(frozen=True, slots=True)
class Baseline:
    commit: str
    files: dict[str, int]


def pure_loc(payload: bytes) -> int:
    payload.decode("utf-8")
    lines: set[int] = set()
    for token in tokenize.tokenize(BytesIO(payload).readline):
        if token.type not in _IGNORED_TOKENS:
            lines.update(range(token.start[0], token.end[0] + 1))
    return len(lines)


def _parse_baseline(root: Path, path: Path) -> tuple[Baseline | None, tuple[str, ...]]:
    expected_path = root / ".omo" / "evidence" / "wp6" / "baseline-pure-loc.json"
    candidate_path = path if path.is_absolute() else root / path
    if candidate_path != expected_path:
        return None, (f"{path}: Todo 1 baseline must use the fixed repository path",)
    identity, identity_errors = load_todo1_baseline(root)
    if identity is None:
        return None, identity_errors
    value, error = load_json(candidate_path)
    if error is not None or not isinstance(value, dict):
        return None, (error or f"{path}: baseline manifest must be an object",)
    expected = {"version", "baseline_commit", "python", "algorithm", "files"}
    if set(value) != expected:
        return None, (f"{path}: baseline manifest schema mismatch",)
    commit = value.get("baseline_commit")
    entries = value.get("files")
    if (
        value.get("version") != 1
        or value.get("python") != "3.12"
        or value.get("algorithm") != "tokenize-physical-v1"
        or not isinstance(commit, str)
        or not re.fullmatch(r"[0-9a-f]{40}", commit)
        or not isinstance(entries, list)
    ):
        return None, (f"{path}: invalid baseline manifest contract",)
    if identity.commit != commit:
        return None, (f"{path}: baseline commit does not match Todo 1 receipt",)
    if git_bytes(root, ("cat-file", "-e", f"{commit}^{{commit}}"))[1] is not None:
        return None, (f"{path}: baseline commit is not available",)
    files: dict[str, int] = {}
    for entry in entries:
        match entry:
            case {"path": str(entry_path), "pure_loc": int(entry_loc)} if (
                set(entry) == {"path", "pure_loc"}
                and entry_loc >= 0
                and entry_path not in files
            ):
                files[entry_path] = entry_loc
            case _:
                return None, (f"{path}: invalid baseline file entry",)
    if tuple(files) != tuple(sorted(files)):
        return None, (f"{path}: baseline file entries are not sorted",)
    return Baseline(commit=commit, files=files), ()


def _defined_names(payload: bytes) -> frozenset[str]:
    tree = ast.parse(payload.decode("utf-8"))
    return frozenset(
        node.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef)
    )


def find_wp6_pure_loc_violations(
    root: Path,
    baseline_path: Path,
    maximum: int,
) -> tuple[str, ...]:
    if maximum < 1:
        return ("changed Python maximum pure LOC must be positive",)
    baseline, errors = _parse_baseline(root, baseline_path)
    if baseline is None:
        return errors
    changes, errors = changed_paths(root, baseline.commit)
    if errors:
        return errors
    violations: list[str] = []
    for change in changes:
        if change.path == "src/sciretriever/core/package.py":
            violations.append(f"{change.path}: WP6 protected file changed")
        if not change.path.endswith(".py") or change.status == "D":
            continue
        path = root / change.path
        if path.is_symlink() or not path.is_file():
            violations.append(f"{change.path}: changed Python path must be a regular file")
            continue
        try:
            payload = path.read_bytes()
            current = pure_loc(payload)
        except (OSError, UnicodeDecodeError, SyntaxError, tokenize.TokenError) as error:
            violations.append(f"{change.path}: cannot tokenize: {error}")
            continue
        prior = baseline.files.get(change.path)
        if prior is None or prior <= maximum:
            if current > maximum:
                violations.append(f"{change.path}: pure LOC {current} exceeds {maximum}")
            continue
        if current >= prior:
            violations.append(
                f"{change.path}: baseline-oversized pure LOC must decrease from {prior}, got {current}"
            )
        previous, error = git_bytes(root, ("show", f"{baseline.commit}:{change.path}"))
        if error is not None or previous is None:
            violations.append(f"{change.path}: cannot read baseline source")
        elif _defined_names(payload) - _defined_names(previous):
            violations.append(f"{change.path}: baseline-oversized file adds WP6 symbols")
    return tuple(sorted(set(violations)))


__all__ = ("find_wp6_pure_loc_violations", "pure_loc")
