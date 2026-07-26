from __future__ import annotations

import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest

from scripts import architecture_checks
from scripts.governance_checks import find_wp6_review_manifest_violations
from scripts.wp6_common import JsonValue, canonical_json, sha256_bytes


digest = sha256_bytes


def write_bytes(root: Path, relative: str, payload: bytes) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def commit_all(root: Path, message: str) -> str:
    subprocess.run(["git", "add", "."], cwd=root, check=True)
    subprocess.run(["git", "commit", "-qm", message], cwd=root, check=True)
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


def create_review_fixture(root: Path) -> tuple[Path, dict[str, JsonValue]]:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "wp6@example.invalid"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "WP6 Test"], cwd=root, check=True)
    write_bytes(root, "modified.py", b"before = 1\n")
    write_bytes(root, ".omo/plans/wp6-product-closeout.md", b"# WP6\n")
    commit = commit_all(root, "baseline")
    write_bytes(root, "modified.py", b"after = 2\n")
    write_bytes(root, ".omo/evidence/wp6/task-5.txt", b"task five\n")
    write_todo1_baseline(root, commit)
    evidence_root = root / ".omo" / "evidence" / "wp6"
    evidence: list[JsonValue] = [
        {"path": path.relative_to(root).as_posix(), "sha256": digest(path.read_bytes())}
        for path in sorted(evidence_root.iterdir())
    ]
    fields: dict[str, JsonValue] = {
        "version": 1,
        "baseline_commit": commit,
        "plan_sha256": digest(b"# WP6\n"),
        "product_files": [{"path": "modified.py", "sha256": digest(b"after = 2\n")}],
        "deleted_files": [],
        "evidence_files": evidence,
        "commands": [{
            "name": "task-5", "command": "verify", "exit_code": 0,
            "receipt": ".omo/evidence/wp6/task-5.txt",
        }],
    }
    fields["product_manifest_sha256"] = digest(canonical_json(fields))
    review_path = evidence_root / "review-manifest.json"
    review_path.write_bytes(canonical_json(fields))
    return review_path, fields


def write_todo1_baseline(root: Path, commit: str) -> None:
    baseline: dict[str, JsonValue] = {
        "version": 1,
        "baseline_commit": commit,
        "python": "3.12",
        "algorithm": "tokenize-physical-v1",
        "files": [],
    }
    payload = canonical_json(baseline)
    write_bytes(root, ".omo/evidence/wp6/baseline-pure-loc.json", payload)
    write_bytes(
        root,
        ".omo/evidence/wp6/task-1.txt",
        (
            f"baseline_commit={commit}\n"
            f"baseline_pure_loc_sha256={digest(payload)}\n"
        ).encode(),
    )


def rewrite_for_later_commit(
    root: Path,
    review_path: Path,
    fields: dict[str, JsonValue],
    later_commit: str,
) -> None:
    write_bytes(root, "modified.py", b"later change = 4\n")
    evidence_root = root / ".omo" / "evidence" / "wp6"
    evidence_rows: list[JsonValue] = []
    for path in sorted(evidence_root.iterdir()):
        if path.name == "review-manifest.json":
            continue
        evidence_rows.append(
            {"path": path.relative_to(root).as_posix(), "sha256": digest(path.read_bytes())}
        )
    fields["baseline_commit"] = later_commit
    fields["product_files"] = [
        {"path": "modified.py", "sha256": digest(b"later change = 4\n")}
    ]
    fields["deleted_files"] = []
    fields["evidence_files"] = evidence_rows
    preimage = {
        key: value for key, value in fields.items() if key != "product_manifest_sha256"
    }
    fields["product_manifest_sha256"] = digest(canonical_json(preimage))
    review_path.write_bytes(canonical_json(fields))


class ReviewBaselineBindingTests(unittest.TestCase):
    def test_review_rejects_later_commit_substituted_for_todo1_baseline(self) -> None:
        with TemporaryDirectory(prefix="sciretriever-wp6-baseline-repair-") as temporary:
            # Given Todo 1 pins the original commit and external baseline manifest
            root = Path(temporary)
            review_path, fields = create_review_fixture(root)
            original_commit = fields["baseline_commit"]
            assert isinstance(original_commit, str)
            write_todo1_baseline(root, original_commit)
            later_commit = commit_all(root, "later valid baseline")
            rewrite_for_later_commit(root, review_path, fields, later_commit)

            # When review validation receives a self-consistent later baseline
            violations = find_wp6_review_manifest_violations(root, review_path)

        # Then immutable Todo 1 identity wins over the substituted commit
        self.assertIn("review manifest baseline commit does not match Todo 1", violations)

    def test_review_rejects_invalid_todo1_receipt_and_manifest_identity(self) -> None:
        probes = {
            "missing": lambda text: "\n".join(
                line for line in text.splitlines() if not line.startswith("baseline_commit=")
            ),
            "duplicate": lambda text: text + "baseline_commit=" + "0" * 40 + "\n",
            "malformed": lambda text: text.replace(
                next(line for line in text.splitlines() if line.startswith("baseline_commit=")),
                "baseline_commit=invalid",
            ),
            "sha_mismatch": lambda text: text.replace(
                next(
                    line
                    for line in text.splitlines()
                    if line.startswith("baseline_pure_loc_sha256=")
                ),
                "baseline_pure_loc_sha256=" + "0" * 64,
            ),
        }
        for probe, mutate in probes.items():
            with self.subTest(probe=probe), TemporaryDirectory(
                prefix="sciretriever-wp6-receipt-repair-"
            ) as temporary:
                # Given an otherwise valid review fixture with one identity defect
                root = Path(temporary)
                review_path, _ = create_review_fixture(root)
                receipt = root / ".omo" / "evidence" / "wp6" / "task-1.txt"
                receipt.write_text(mutate(receipt.read_text(encoding="utf-8")), encoding="utf-8")

                # When review validation loads the fixed Todo 1 artifacts
                violations = find_wp6_review_manifest_violations(root, review_path)

                # Then malformed or non-equal identity is rejected before Git comparison
                self.assertTrue(any("Todo 1" in item for item in violations))


class ArchitectureDeclarationTests(unittest.TestCase):
    def test_forbidden_sqlalchemy_declarations_are_path_independent(self) -> None:
        cases = {
            "catalog/models.py": 'Table("expansion_status", MetaData())\n',
            "storage/records.py": 'class Record:\n    __tablename__ = "completion_status"\n',
            "core/jobs.py": 'Table("worker_tasks", MetaData())\n',
            "analysis/models.py": (
                'class Schedule:\n    __tablename__ = "expansion_scheduler_runs"\n'
            ),
        }
        for relative, source in cases.items():
            with self.subTest(relative=relative), TemporaryDirectory(
                prefix="sciretriever-wp6-declaration-repair-"
            ) as temporary:
                # Given a forbidden SQLAlchemy declaration outside a retired path
                source_root = Path(temporary)
                path = source_root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(source, encoding="utf-8")

                # When the architecture scanner parses the source tree
                violations = architecture_checks.find_architecture_violations(
                    source_root, frozenset()
                )

                # Then declaration semantics, not path spelling, cause rejection
                self.assertTrue(
                    any("forbidden WP6 schema table" in item for item in violations)
                )

    def test_benign_status_text_and_table_declarations_are_accepted(self) -> None:
        with TemporaryDirectory(
            prefix="sciretriever-wp6-declaration-repair-"
        ) as temporary:
            # Given comments, ordinary strings, and a non-forbidden SQLAlchemy table
            source_root = Path(temporary)
            path = source_root / "catalog" / "models.py"
            path.parent.mkdir(parents=True)
            path.write_text(
                '# Table("expansion_status", MetaData())\n'
                'MESSAGE = "completion_status"\n'
                'Table("works", MetaData())\n',
                encoding="utf-8",
            )

            # When the architecture scanner parses declarations
            violations = architecture_checks.find_architecture_violations(
                source_root, frozenset()
            )

        # Then non-declaration text and allowed table names do not false-positive
        self.assertEqual(violations, ())


if __name__ == "__main__":
    unittest.main()
