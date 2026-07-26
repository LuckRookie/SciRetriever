from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest

from scripts.governance_checks import (
    find_wp6_closure_violations,
    find_wp6_release_scan_violations,
    find_wp6_review_manifest_violations,
)
from scripts.wp6_common import JsonValue, canonical_json


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def write_bytes(root: Path, relative: str, payload: bytes) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def initialize_repository(root: Path, files: dict[str, str]) -> str:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(
        ["git", "config", "user.email", "wp6@example.invalid"],
        cwd=root,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "WP6 Test"],
        cwd=root,
        check=True,
    )
    for relative, text in files.items():
        write_bytes(root, relative, text.encode())
    subprocess.run(["git", "add", "."], cwd=root, check=True)
    subprocess.run(["git", "commit", "-qm", "baseline"], cwd=root, check=True)
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


def plan_text(complete: bool = False, commitment: str | None = None) -> bytes:
    marker = "x" if complete else " "
    closure_hash = commitment if commitment is not None else "0" * 64
    headings = "\n".join(f"- [{marker}] {heading}. closure" for heading in ("33", "F1", "F2", "F3", "F4"))
    return (
        f"# WP6\n{headings}\nClosure commitment before execution: "
        f"`closure_manifest_sha256={closure_hash}`.\n"
    ).encode()


def create_review_fixture(root: Path) -> tuple[Path, dict[str, JsonValue]]:
    baseline_files = {
        "modified.py": "before = 1\n",
        "deleted.py": "deleted = True\n",
        ".omo/plans/wp6-product-closeout.md": plan_text().decode(),
        ".omo/start-work/ledger.jsonl": "",
        ".omo/boulder.json": (
            '{"active_work_id":"wp6-product-closeout","works":'
            '{"wp6-product-closeout":{"status":"active"}}}\n'
        ),
    }
    commit = initialize_repository(root, baseline_files)
    (root / "modified.py").write_text("after = 2\n", encoding="utf-8")
    (root / "deleted.py").unlink()
    write_bytes(root, "added.py", b"added = 3\n")
    baseline = canonical_json({
        "version": 1, "baseline_commit": commit, "python": "3.12",
        "algorithm": "tokenize-physical-v1", "files": [],
    })
    write_bytes(root, ".omo/evidence/wp6/baseline-pure-loc.json", baseline)
    task_one = (
        f"baseline_commit={commit}\n"
        f"baseline_pure_loc_sha256={digest(baseline)}\n"
    ).encode()
    write_bytes(root, ".omo/evidence/wp6/task-1.txt", task_one)
    write_bytes(root, ".omo/evidence/wp6/task-5.txt", b"task five\n")
    product_files: list[JsonValue] = [
        {"path": "added.py", "sha256": digest(b"added = 3\n")},
        {"path": "modified.py", "sha256": digest(b"after = 2\n")},
    ]
    deleted_files: list[JsonValue] = [
        {"path": "deleted.py", "baseline_sha256": digest(b"deleted = True\n")}
    ]
    evidence_files: list[JsonValue] = [
        {"path": ".omo/evidence/wp6/baseline-pure-loc.json", "sha256": digest(baseline)},
        {"path": ".omo/evidence/wp6/task-1.txt", "sha256": digest(task_one)},
        {"path": ".omo/evidence/wp6/task-5.txt", "sha256": digest(b"task five\n")},
    ]
    fields: dict[str, JsonValue] = {
        "version": 1,
        "baseline_commit": commit,
        "plan_sha256": digest(plan_text()),
        "product_files": product_files,
        "deleted_files": deleted_files,
        "evidence_files": evidence_files,
        "commands": [
            {
                "name": "task-5",
                "command": "python -m unittest tests.test_governance_wp6",
                "exit_code": 0,
                "receipt": ".omo/evidence/wp6/task-5.txt",
            }
        ],
    }
    fields["product_manifest_sha256"] = digest(canonical_json(fields))
    review_path = root / ".omo/evidence/wp6/review-manifest.json"
    review_path.write_bytes(canonical_json(fields))
    return review_path, fields


class ReviewManifestWp6Tests(unittest.TestCase):
    def test_review_manifest_reconstructs_every_universe(self) -> None:
        # Given exact added, modified, deleted, evidence, plan, and command rows
        with TemporaryDirectory(prefix="sciretriever-wp6-review-") as temporary:
            root = Path(temporary)
            review_path, _ = create_review_fixture(root)

            # When review and release gates reconstruct the workspace
            review = find_wp6_review_manifest_violations(root, review_path)
            release = find_wp6_release_scan_violations(root, review_path)

        # Then both immutable universes and hashes are accepted
        self.assertEqual(review, ())
        self.assertEqual(release, ())

    def test_review_manifest_rejects_file_and_universe_drift(self) -> None:
        probes = ("product", "evidence", "plan", "extra", "missing", "traversal")
        for probe in probes:
            with self.subTest(probe=probe), TemporaryDirectory(
                prefix="sciretriever-wp6-review-"
            ) as temporary:
                # Given a previously valid review manifest
                root = Path(temporary)
                review_path, fields = create_review_fixture(root)
                if probe == "product":
                    (root / "modified.py").write_text("after = 9\n", encoding="utf-8")
                elif probe == "evidence":
                    write_bytes(root, ".omo/evidence/wp6/task-5.txt", b"drift\n")
                elif probe == "plan":
                    write_bytes(root, ".omo/plans/wp6-product-closeout.md", b"drift\n")
                elif probe == "extra":
                    products = fields["product_files"]
                    assert isinstance(products, list)
                    products.append({"path": "ghost.py", "sha256": "0" * 64})
                    preimage: dict[str, JsonValue] = {
                        key: value
                        for key, value in fields.items()
                        if key != "product_manifest_sha256"
                    }
                    fields["product_manifest_sha256"] = digest(canonical_json(preimage))
                    review_path.write_bytes(canonical_json(fields))
                else:
                    products = fields["product_files"]
                    assert isinstance(products, list)
                    if probe == "missing":
                        products.pop()
                    else:
                        products[0] = {"path": "../escape.py", "sha256": "0" * 64}
                    preimage: dict[str, JsonValue] = {
                        key: value
                        for key, value in fields.items()
                        if key != "product_manifest_sha256"
                    }
                    fields["product_manifest_sha256"] = digest(canonical_json(preimage))
                    review_path.write_bytes(canonical_json(fields))

                # When the review gate reconstructs current state
                violations = find_wp6_review_manifest_violations(root, review_path)

                # Then stale bytes or an exhaustive-universe mismatch fail closed
                self.assertTrue(violations)

    def test_review_manifest_rejects_symlink_substitution(self) -> None:
        # Given a valid manifest whose product is replaced by a symlink
        with TemporaryDirectory(prefix="sciretriever-wp6-review-") as temporary:
            root = Path(temporary)
            review_path, _ = create_review_fixture(root)
            target = root / "target.py"
            target.write_text("after = 2\n", encoding="utf-8")
            product = root / "modified.py"
            product.unlink()
            product.symlink_to(target)

            # When the review gate reads the product universe
            violations = find_wp6_review_manifest_violations(root, review_path)

        # Then type substitution is rejected
        self.assertTrue(violations)

    def test_closure_reconstructs_five_checkboxes_and_commitment(self) -> None:
        # Given a valid pre-review manifest and four approvals
        with TemporaryDirectory(prefix="sciretriever-wp6-close-") as temporary:
            root = Path(temporary)
            review_path, review = create_review_fixture(root)
            identities = (
                review["plan_sha256"],
                review["product_manifest_sha256"],
                digest(review_path.read_bytes()),
            )
            receipt_rows = []
            appended = b""
            for role in ("f1", "f2", "f3", "f4"):
                relative = f".omo/evidence/wp6/final-{role}.json"
                receipt = {
                    "role": role.upper(),
                    "session_id": f"session-{role}",
                    "plan_sha256": identities[0],
                    "product_manifest_sha256": identities[1],
                    "full_manifest_sha256": identities[2],
                    "verdict": "APPROVE",
                    "commands": [{"command": "verify", "exit_code": 0}],
                }
                payload = canonical_json(receipt)
                write_bytes(root, relative, payload)
                receipt_rows.append({"path": relative, "sha256": digest(payload)})
                appended += canonical_json({"path": relative, "sha256": digest(payload)}) + b"\n"
            ledger_path = root / ".omo/start-work/ledger.jsonl"
            ledger_pre = ledger_path.read_bytes()
            ledger_path.write_bytes(ledger_pre + appended)
            boulder_path = root / ".omo/boulder.json"
            boulder_pre = boulder_path.read_bytes()
            boulder_post = (
                b'{"active_work_id":null,"works":'
                b'{"wp6-product-closeout":{"status":"completed"}}}\n'
            )
            boulder_path.write_bytes(boulder_post)
            post_payload = b"closure receipt\n"
            write_bytes(root, ".omo/evidence/wp6/post-closure.txt", post_payload)
            closure = {
                "version": 1,
                "plan_sha256": identities[0],
                "product_manifest_sha256": identities[1],
                "full_manifest_sha256": identities[2],
                "receipt_files": receipt_rows,
                "post_closure": {
                    "path": ".omo/evidence/wp6/post-closure.txt",
                    "sha256": digest(post_payload),
                },
                "ledger": {
                    "path": ".omo/start-work/ledger.jsonl",
                    "pre_sha256": digest(ledger_pre),
                    "post_sha256": digest(ledger_pre + appended),
                    "pre_base64": base64.b64encode(ledger_pre).decode(),
                    "appended_base64": base64.b64encode(appended).decode(),
                },
                "boulder": {
                    "path": ".omo/boulder.json",
                    "pre_sha256": digest(boulder_pre),
                    "post_sha256": digest(boulder_post),
                    "pre_base64": base64.b64encode(boulder_pre).decode(),
                    "post_base64": base64.b64encode(boulder_post).decode(),
                },
            }
            closure_payload = canonical_json(closure)
            write_bytes(root, ".omo/evidence/wp6/closure-manifest.json", closure_payload)
            write_bytes(
                root,
                ".omo/plans/wp6-product-closeout.md",
                plan_text(complete=True, commitment=digest(closure_payload)),
            )

            # When the closure gate reconstructs pre-closure bytes
            violations = find_wp6_closure_violations(root, review_path)

        # Then the exact five transitions and commitment are accepted
        self.assertEqual(violations, ())


if __name__ == "__main__":
    unittest.main()
