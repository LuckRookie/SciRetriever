from __future__ import annotations

import hashlib
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest

from scripts.governance_checks import find_wp6_review_manifest_violations
from scripts.wp6_common import JsonValue, canonical_json


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def write(root: Path, relative: str, payload: bytes) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def git(root: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", *arguments],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


def create_fixture(root: Path) -> tuple[Path, dict[str, JsonValue], str]:
    git(root, "init", "-q")
    git(root, "config", "user.email", "wp6@example.invalid")
    git(root, "config", "user.name", "WP6 Test")
    write(root, "item.py", b"before = 1\n")
    write(root, ".omo/plans/wp6-product-closeout.md", b"# WP6\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "baseline")
    baseline_commit = git(root, "rev-parse", "HEAD")
    baseline = {
        "algorithm": "tokenize-physical-v1",
        "baseline_commit": baseline_commit,
        "files": [],
        "python": "3.12",
        "version": 1,
    }
    baseline_payload = canonical_json(baseline)
    receipt = (
        f"baseline_commit={baseline_commit}\n"
        f"baseline_pure_loc_sha256={digest(baseline_payload)}\n"
    ).encode()
    write(root, ".omo/evidence/wp6/baseline-pure-loc.json", baseline_payload)
    write(root, ".omo/evidence/wp6/task-1.txt", receipt)
    write(root, ".omo/evidence/wp6/task-5.txt", b"verified\n")
    write(root, "item.py", b"after = 2\n")
    evidence: list[JsonValue] = [
        {
            "path": ".omo/evidence/wp6/baseline-pure-loc.json",
            "sha256": digest(baseline_payload),
        },
        {"path": ".omo/evidence/wp6/task-1.txt", "sha256": digest(receipt)},
        {"path": ".omo/evidence/wp6/task-5.txt", "sha256": digest(b"verified\n")},
    ]
    fields: dict[str, JsonValue] = {
        "version": 1,
        "baseline_commit": baseline_commit,
        "plan_sha256": digest(b"# WP6\n"),
        "product_files": [{"path": "item.py", "sha256": digest(b"after = 2\n")}],
        "deleted_files": [],
        "evidence_files": evidence,
        "commands": [
            {
                "name": "task-5",
                "command": "verify",
                "exit_code": 0,
                "receipt": ".omo/evidence/wp6/task-5.txt",
            }
        ],
    }
    fields["product_manifest_sha256"] = digest(canonical_json(fields))
    manifest = root / ".omo/evidence/wp6/review-manifest.json"
    manifest.write_bytes(canonical_json(fields))
    return manifest, fields, baseline_commit


class GovernanceBaselineWp6Tests(unittest.TestCase):
    def test_review_manifest_binds_exact_todo_one_baseline(self) -> None:
        # Given a matching review manifest followed by a different valid later commit
        with TemporaryDirectory(prefix="sciretriever-wp6-baseline-") as temporary:
            root = Path(temporary)
            manifest, fields, baseline_commit = create_fixture(root)
            protected = (
                root / ".omo/evidence/wp6/baseline-pure-loc.json",
                root / ".omo/evidence/wp6/task-1.txt",
            )
            before = tuple(digest(path.read_bytes()) for path in protected)
            matching = find_wp6_review_manifest_violations(root, manifest)
            git(root, "add", ".")
            git(root, "commit", "-qm", "later")
            later_commit = git(root, "rev-parse", "HEAD")
            self.assertNotEqual(later_commit, baseline_commit)
            fields["baseline_commit"] = later_commit
            fields["product_files"] = []
            preimage = {
                key: value
                for key, value in fields.items()
                if key != "product_manifest_sha256"
            }
            fields["product_manifest_sha256"] = digest(canonical_json(preimage))
            manifest.write_bytes(canonical_json(fields))

            # When the validator checks matching and substituted identities
            substituted = find_wp6_review_manifest_violations(root, manifest)
            after = tuple(digest(path.read_bytes()) for path in protected)

        # Then only Todo 1's immutable commit is accepted
        self.assertEqual(matching, ())
        self.assertEqual(after, before)
        self.assertIn(
            "review manifest baseline commit does not match Todo 1",
            substituted,
        )

    def test_review_manifest_rejects_malformed_todo_one_receipt_fields(self) -> None:
        probes = {
            "missing": lambda commit, sha: f"baseline_commit={commit}\n",
            "duplicate": lambda commit, sha: (
                f"baseline_commit={commit}\nbaseline_commit={commit}\n"
                f"baseline_pure_loc_sha256={sha}\n"
            ),
            "malformed": lambda commit, sha: (
                "baseline_commit=not-a-commit\n"
                f"baseline_pure_loc_sha256={sha}\n"
            ),
        }
        for probe, render in probes.items():
            with self.subTest(probe=probe), TemporaryDirectory(
                prefix="sciretriever-wp6-baseline-"
            ) as temporary:
                # Given a missing, duplicate, or malformed immutable receipt field
                root = Path(temporary)
                manifest, _, commit = create_fixture(root)
                baseline_path = root / ".omo/evidence/wp6/baseline-pure-loc.json"
                receipt = render(commit, digest(baseline_path.read_bytes())).encode()
                write(root, ".omo/evidence/wp6/task-1.txt", receipt)

                # When review validation loads the fixed Todo 1 artifacts
                violations = find_wp6_review_manifest_violations(root, manifest)

                # Then receipt schema failure precedes ordinary evidence drift
                self.assertTrue(any("Todo 1 receipt" in item for item in violations))


if __name__ == "__main__":
    unittest.main()
