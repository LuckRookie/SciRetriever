"""Immutable WP6 pre-review manifest validation."""

from __future__ import annotations

from pathlib import Path
import re
from typing import Final

from scripts.wp6_baseline import load_todo1_baseline
from scripts.wp6_common import (
    JsonValue,
    canonical_json,
    changed_paths,
    git_bytes,
    load_json,
    read_regular_bytes,
    safe_relative_path,
    sha256_bytes,
)


_FIELDS: Final = (
    "version",
    "baseline_commit",
    "plan_sha256",
    "product_files",
    "deleted_files",
    "evidence_files",
    "commands",
    "product_manifest_sha256",
)
_CLOSURE_CONTROLS: Final = frozenset(
    {
        ".omo/plans/wp6-product-closeout.md",
        ".omo/start-work/ledger.jsonl",
        ".omo/boulder.json",
        ".omo/evidence/wp6/post-closure.txt",
        ".omo/evidence/wp6/closure-manifest.json",
    }
)
_EVIDENCE_EXCLUSIONS: Final = frozenset(
    {
        "review-manifest.json",
        "task-32-validation.txt",
        "final-f1.json",
        "final-f2.json",
        "final-f3.json",
        "final-f4.json",
        "post-closure.txt",
        "closure-manifest.json",
    }
)


def _rows(
    value: JsonValue,
    field: str,
    hash_field: str,
) -> tuple[dict[str, str], tuple[str, ...]]:
    if not isinstance(value, dict):
        return {}, (f"review manifest field {field!r} must be a list",)
    rows = value.get(field)
    if not isinstance(rows, list):
        return {}, (f"review manifest field {field!r} must be a list",)
    parsed: dict[str, str] = {}
    ordered: list[str] = []
    for row in rows:
        if not isinstance(row, dict):
            return {}, (f"review manifest field {field!r} has invalid entry",)
        path = row.get("path")
        digest = row.get(hash_field)
        if (
            set(row) != {"path", hash_field}
            or not isinstance(path, str)
            or not isinstance(digest, str)
            or safe_relative_path(path) is None
            or re.fullmatch(r"[0-9a-f]{64}", digest) is None
            or path in parsed
        ):
            return {}, (f"review manifest field {field!r} has invalid entry",)
        parsed[path] = digest
        ordered.append(path)
    if ordered != sorted(ordered):
        return {}, (f"review manifest field {field!r} is not sorted",)
    return parsed, ()


def _commands(value: JsonValue, evidence_paths: frozenset[str]) -> tuple[str, ...]:
    if not isinstance(value, dict):
        return ("review manifest commands must be a list",)
    rows = value.get("commands")
    if not isinstance(rows, list):
        return ("review manifest commands must be a list",)
    names: set[str] = set()
    for row in rows:
        match row:
            case {
                "name": str(name),
                "command": str(command),
                "exit_code": int(exit_code),
                "receipt": str(receipt),
            } if (
                set(row) == {"name", "command", "exit_code", "receipt"}
                and name
                and command
                and exit_code == 0
                and safe_relative_path(receipt) is not None
                and receipt in evidence_paths
                and name not in names
            ):
                names.add(name)
            case _:
                return ("review manifest has invalid command receipt",)
    return ()


def _expected_evidence(root: Path) -> tuple[dict[str, str], tuple[str, ...]]:
    evidence_root = root / ".omo" / "evidence" / "wp6"
    if evidence_root.is_symlink() or not evidence_root.is_dir():
        return {}, ("WP6 evidence directory must be a regular directory",)
    rows: dict[str, str] = {}
    for path in sorted(evidence_root.iterdir()):
        if path.name in _EVIDENCE_EXCLUSIONS:
            continue
        relative = path.relative_to(root).as_posix()
        payload, error = read_regular_bytes(path)
        if error is not None or payload is None:
            return {}, (error or f"{relative}: cannot read evidence",)
        rows[relative] = sha256_bytes(payload)
    return rows, ()


def _expected_products(
    root: Path,
    baseline: str,
) -> tuple[dict[str, str], dict[str, str], tuple[str, ...]]:
    changes, errors = changed_paths(root, baseline)
    if errors:
        return {}, {}, errors
    products: dict[str, str] = {}
    deleted: dict[str, str] = {}
    for change in changes:
        if change.path in _CLOSURE_CONTROLS or change.path.startswith(
            ".omo/evidence/wp6/"
        ):
            continue
        if change.status == "D":
            payload, error = git_bytes(root, ("show", f"{baseline}:{change.path}"))
            if error is not None or payload is None:
                return {}, {}, (error or f"{change.path}: baseline blob is missing",)
            deleted[change.path] = sha256_bytes(payload)
            continue
        payload, error = read_regular_bytes(root / change.path)
        if error is not None or payload is None:
            return {}, {}, (error or f"{change.path}: changed file is invalid",)
        products[change.path] = sha256_bytes(payload)
    return products, deleted, ()


def find_wp6_review_manifest_violations(
    root: Path,
    manifest_path: Path,
) -> tuple[str, ...]:
    value, error = load_json(manifest_path)
    if error is not None or not isinstance(value, dict):
        return (error or "review manifest must be an object",)
    if set(value) != set(_FIELDS) or value.get("version") != 1:
        return ("review manifest schema mismatch",)
    baseline = value.get("baseline_commit")
    plan_digest = value.get("plan_sha256")
    product_digest = value.get("product_manifest_sha256")
    if (
        not isinstance(baseline, str)
        or re.fullmatch(r"[0-9a-f]{40}", baseline) is None
        or not isinstance(plan_digest, str)
        or re.fullmatch(r"[0-9a-f]{64}", plan_digest) is None
        or not isinstance(product_digest, str)
        or re.fullmatch(r"[0-9a-f]{64}", product_digest) is None
    ):
        return ("review manifest identity fields are invalid",)
    todo1_baseline, baseline_errors = load_todo1_baseline(root)
    if baseline_errors:
        return baseline_errors
    if todo1_baseline is None or baseline != todo1_baseline.commit:
        return ("review manifest baseline commit does not match Todo 1",)
    payload = manifest_path.read_bytes()
    if canonical_json(value) != payload:
        return ("review manifest is not canonical compact JSON",)
    product_rows, errors = _rows(value, "product_files", "sha256")
    deleted_rows, deleted_errors = _rows(
        value,
        "deleted_files",
        "baseline_sha256",
    )
    evidence_rows, evidence_errors = _rows(value, "evidence_files", "sha256")
    violations = [
        *errors,
        *deleted_errors,
        *evidence_errors,
        *_commands(value, frozenset(evidence_rows)),
    ]
    if violations:
        return tuple(violations)
    expected_products, expected_deleted, expected_errors = _expected_products(
        root,
        baseline,
    )
    expected_evidence, evidence_universe_errors = _expected_evidence(root)
    violations.extend(expected_errors)
    violations.extend(evidence_universe_errors)
    if product_rows != expected_products:
        violations.append("review manifest product universe or hashes drifted")
    if deleted_rows != expected_deleted:
        violations.append("review manifest deleted universe or hashes drifted")
    if evidence_rows != expected_evidence:
        violations.append("review manifest evidence universe or hashes drifted")
    plan, plan_error = read_regular_bytes(
        root / ".omo" / "plans" / "wp6-product-closeout.md"
    )
    if plan_error is not None or plan is None or sha256_bytes(plan) != plan_digest:
        violations.append("review manifest plan hash drifted")
    preimage = {field: value[field] for field in _FIELDS[:-1]}
    if sha256_bytes(canonical_json(preimage)) != product_digest:
        violations.append("review manifest product digest mismatch")
    return tuple(sorted(set(violations)))


__all__ = ("find_wp6_review_manifest_violations",)
