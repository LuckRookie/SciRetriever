"""WP6 five-checkbox closure reconstruction validation."""

from __future__ import annotations

import base64
import binascii
from collections.abc import Mapping
from pathlib import Path
import re
from typing import Final

from scripts.wp6_common import (
    JsonValue,
    canonical_json,
    load_json,
    read_regular_bytes,
    sha256_bytes,
)
from scripts.wp6_closure_controls import is_boulder_transition
from scripts.wp6_review_manifest import find_wp6_review_manifest_violations


_ROLES: Final = ("f1", "f2", "f3", "f4")
_HEADINGS: Final = ("33", "F1", "F2", "F3", "F4")
_CLOSURE_FIELDS: Final = frozenset(
    {
        "version",
        "plan_sha256",
        "product_manifest_sha256",
        "full_manifest_sha256",
        "receipt_files",
        "post_closure",
        "ledger",
        "boulder",
    }
)


def _decode_snapshot(raw: str, label: str) -> tuple[bytes | None, str | None]:
    try:
        decoded = base64.b64decode(raw, validate=True)
    except (ValueError, binascii.Error) as error:
        return None, f"closure manifest {label} is invalid base64: {error}"
    if base64.b64encode(decoded).decode("ascii") != raw:
        return None, f"closure manifest {label} is not canonical base64"
    return decoded, None


def _receipt_rows(
    root: Path,
    value: Mapping[str, JsonValue],
    identities: tuple[str, str, str],
) -> tuple[dict[str, str], tuple[str, ...]]:
    rows = value.get("receipt_files")
    if not isinstance(rows, list):
        return {}, ("closure manifest receipt_files must be a list",)
    parsed: dict[str, str] = {}
    violations: list[str] = []
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"path", "sha256"}:
            return {}, ("closure manifest has invalid receipt entry",)
        path = row.get("path")
        digest = row.get("sha256")
        if not isinstance(path, str) or not isinstance(digest, str):
            return {}, ("closure manifest has invalid receipt entry",)
        parsed[path] = digest
    expected_paths = tuple(f".omo/evidence/wp6/final-{role}.json" for role in _ROLES)
    if tuple(parsed) != expected_paths:
        violations.append("closure receipt paths are incomplete or unsorted")
    for path, digest in parsed.items():
        payload, error = read_regular_bytes(root / path)
        if error is not None or payload is None or sha256_bytes(payload) != digest:
            violations.append(f"{path}: closure receipt hash drifted")
            continue
        receipt, load_error = load_json(root / path)
        if load_error is not None or not isinstance(receipt, dict):
            violations.append(f"{path}: invalid approval receipt")
            continue
        commands = receipt.get("commands")
        expected_fields = {
            "role",
            "session_id",
            "plan_sha256",
            "product_manifest_sha256",
            "full_manifest_sha256",
            "verdict",
            "commands",
        }
        valid_commands = isinstance(commands, list) and all(
            isinstance(command, dict)
            and set(command) == {"command", "exit_code"}
            and isinstance(command.get("command"), str)
            and command.get("exit_code") == 0
            for command in commands
        )
        if (
            set(receipt) != expected_fields
            or receipt.get("role") != Path(path).stem.removeprefix("final-").upper()
            or receipt.get("verdict") != "APPROVE"
            or receipt.get("plan_sha256") != identities[0]
            or receipt.get("product_manifest_sha256") != identities[1]
            or receipt.get("full_manifest_sha256") != identities[2]
            or not isinstance(receipt.get("session_id"), str)
            or not valid_commands
        ):
            violations.append(f"{path}: approval receipt identity mismatch")
    return parsed, tuple(violations)


def _control_bytes(
    value: Mapping[str, JsonValue],
    field: str,
) -> tuple[dict[str, bytes], tuple[str, ...]]:
    control = value.get(field)
    if not isinstance(control, dict):
        return {}, (f"closure manifest {field} control is invalid",)
    expected_fields = (
        {"path", "pre_sha256", "post_sha256", "pre_base64", "appended_base64"}
        if field == "ledger"
        else {"path", "pre_sha256", "post_sha256", "pre_base64", "post_base64"}
    )
    expected_path = (
        ".omo/start-work/ledger.jsonl" if field == "ledger" else ".omo/boulder.json"
    )
    if set(control) != expected_fields or control.get("path") != expected_path:
        return {}, (f"closure manifest {field} control schema mismatch",)
    snapshots: dict[str, bytes] = {}
    keys = ("pre_base64", "appended_base64") if field == "ledger" else (
        "pre_base64",
        "post_base64",
    )
    for key in keys:
        raw = control.get(key)
        if not isinstance(raw, str):
            return {}, (f"closure manifest {field}.{key} is invalid",)
        decoded, error = _decode_snapshot(raw, f"{field}.{key}")
        if error is not None or decoded is None:
            return {}, (error or f"closure manifest {field}.{key} is invalid",)
        snapshots[key] = decoded
    return snapshots, ()


def _plan_preimage(plan: bytes, closure_digest: str) -> tuple[bytes | None, tuple[str, ...]]:
    try:
        text = plan.decode("utf-8")
    except UnicodeDecodeError as error:
        return None, (f"WP6 plan is not UTF-8: {error}",)
    if "\r" in text:
        return None, ("WP6 plan must use exact LF bytes",)
    for heading in _HEADINGS:
        pattern = re.compile(rf"(?m)^- \[x\] {re.escape(heading)}\.")
        if len(pattern.findall(text)) != 1:
            return None, (f"WP6 plan closure heading {heading} is not exactly complete",)
        text = pattern.sub(f"- [ ] {heading}.", text)
    commitment = re.compile(r"closure_manifest_sha256=([0-9a-f]{64})")
    matches = commitment.findall(text)
    if matches != [closure_digest]:
        return None, ("WP6 plan closure commitment mismatch",)
    text = commitment.sub("closure_manifest_sha256=" + "0" * 64, text)
    return text.encode("utf-8"), ()


def find_wp6_closure_violations(root: Path, review_path: Path) -> tuple[str, ...]:
    review, review_error = load_json(review_path)
    if review_error is not None or not isinstance(review, dict):
        return (review_error or "review manifest must be an object",)
    closure_path = root / ".omo" / "evidence" / "wp6" / "closure-manifest.json"
    closure, closure_error = load_json(closure_path)
    if closure_error is not None or not isinstance(closure, dict):
        return (closure_error or "closure manifest must be an object",)
    if set(closure) != _CLOSURE_FIELDS or closure.get("version") != 1:
        return ("closure manifest schema mismatch",)
    payload = closure_path.read_bytes()
    if canonical_json(closure) != payload:
        return ("closure manifest is not canonical compact JSON",)
    plan_identity = review.get("plan_sha256")
    product_identity = review.get("product_manifest_sha256")
    if not isinstance(plan_identity, str) or not isinstance(product_identity, str):
        return ("review manifest identities are invalid",)
    identities = (
        plan_identity,
        product_identity,
        sha256_bytes(review_path.read_bytes()),
    )
    expected_identities = (
        closure.get("plan_sha256"),
        closure.get("product_manifest_sha256"),
        closure.get("full_manifest_sha256"),
    )
    violations: list[str] = []
    if identities != expected_identities:
        violations.append("closure manifest review identities mismatch")
    receipts, receipt_errors = _receipt_rows(root, closure, identities)
    violations.extend(receipt_errors)
    post = closure.get("post_closure")
    if not isinstance(post, dict) or set(post) != {"path", "sha256"}:
        violations.append("closure post_closure entry is invalid")
    else:
        post_path, post_digest = post.get("path"), post.get("sha256")
        if (
            post_path != ".omo/evidence/wp6/post-closure.txt"
            or not isinstance(post_digest, str)
        ):
            violations.append("closure post_closure entry is invalid")
        else:
            post_payload, error = read_regular_bytes(
                root / ".omo/evidence/wp6/post-closure.txt"
            )
            if error is not None or post_payload is None or sha256_bytes(post_payload) != post_digest:
                violations.append("closure post-closure receipt drifted")
    ledger, ledger_errors = _control_bytes(closure, "ledger")
    boulder, boulder_errors = _control_bytes(closure, "boulder")
    violations.extend(ledger_errors)
    violations.extend(boulder_errors)
    for field, current, snapshots in (
        ("ledger", root / ".omo/start-work/ledger.jsonl", ledger),
        ("boulder", root / ".omo/boulder.json", boulder),
    ):
        control = closure.get(field)
        if not isinstance(control, dict) or not snapshots:
            continue
        current_payload, error = read_regular_bytes(current)
        post_key = "appended_base64" if field == "ledger" else "post_base64"
        expected = snapshots["pre_base64"] + snapshots[post_key] if field == "ledger" else snapshots[post_key]
        if error is not None or current_payload != expected:
            violations.append(f"closure {field} current bytes mismatch")
        if sha256_bytes(snapshots["pre_base64"]) != control.get("pre_sha256"):
            violations.append(f"closure {field} pre hash mismatch")
        if sha256_bytes(expected) != control.get("post_sha256"):
            violations.append(f"closure {field} post hash mismatch")
    if ledger:
        lines = tuple(line for line in ledger["appended_base64"].splitlines() if line)
        if len(lines) != 4:
            violations.append("closure ledger must append exactly four records")
        for path, digest in receipts.items():
            if not any(path.encode() in line and digest.encode() in line for line in lines):
                violations.append(f"closure ledger omits {path} identity")
    if boulder and not is_boulder_transition(
        boulder["pre_base64"],
        boulder["post_base64"],
    ):
        violations.append("closure Boulder transition exceeds active-to-completed fields")
    plan, plan_error = read_regular_bytes(root / ".omo/plans/wp6-product-closeout.md")
    if plan_error is not None or plan is None:
        violations.append(plan_error or "WP6 plan is missing")
    else:
        preimage, preimage_errors = _plan_preimage(plan, sha256_bytes(payload))
        violations.extend(preimage_errors)
        if preimage is not None and sha256_bytes(preimage) != identities[0]:
            violations.append("WP6 plan has non-closure byte drift")
    review_violations = find_wp6_review_manifest_violations(root, review_path)
    violations.extend(item for item in review_violations if item != "review manifest plan hash drifted")
    return tuple(sorted(set(violations)))


__all__ = ("find_wp6_closure_violations",)
