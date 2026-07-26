from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from scripts import governance_checks


REPOSITORY = Path(__file__).resolve().parents[1]


def run_git(root: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *arguments],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )


def initialize_repository(root: Path, files: dict[str, str]) -> str:
    self_check = run_git(root, "init", "-q")
    if self_check.returncode != 0:
        raise RuntimeError(self_check.stderr)
    run_git(root, "config", "user.email", "wp6@example.invalid")
    run_git(root, "config", "user.name", "WP6 Test")
    for relative, text in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    run_git(root, "add", ".")
    run_git(root, "commit", "-qm", "baseline")
    return run_git(root, "rev-parse", "HEAD").stdout.strip()


def write_baseline(root: Path, commit: str, entries: list[dict[str, int | str]]) -> Path:
    payload = {
        "algorithm": "tokenize-physical-v1",
        "baseline_commit": commit,
        "files": entries,
        "python": "3.12",
        "version": 1,
    }
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
    manifest = root / ".omo" / "evidence" / "wp6" / "baseline-pure-loc.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_bytes(encoded)
    digest = hashlib.sha256(encoded).hexdigest()
    (manifest.parent / "task-1.txt").write_text(
        f"baseline_commit={commit}\nbaseline_pure_loc_sha256={digest}\n",
        encoding="utf-8",
    )
    return manifest


class GovernanceWp6CharacterizationTests(unittest.TestCase):
    def test_empty_document_tree_is_accepted(self) -> None:
        # Given a repository root without governed documents
        with TemporaryDirectory(prefix="sciretriever-wp6-governance-") as temporary:
            # When the document governance gate runs
            violations = governance_checks.find_document_governance_violations(
                Path(temporary)
            )

        # Then the current empty-tree contract passes
        self.assertEqual(violations, ())

    def test_cli_help_exits_successfully_after_cutover(self) -> None:
        # Given the governance command entry point
        command = [sys.executable, "scripts/governance_checks.py", "--help"]

        # When help is requested
        completed = subprocess.run(
            command,
            cwd=REPOSITORY,
            check=False,
            capture_output=True,
            text=True,
        )

        # Then direct-script help succeeds after the package cutover
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_current_cli_rejects_unknown_option(self) -> None:
        # Given an option not implemented by the current script
        command = [sys.executable, "scripts/governance_checks.py", "--unknown"]

        # When the script is invoked
        completed = subprocess.run(
            command,
            cwd=REPOSITORY,
            check=False,
            capture_output=True,
            text=True,
        )

        # Then argparse rejects the unknown option
        self.assertEqual(completed.returncode, 2)
        self.assertIn("unrecognized arguments", completed.stderr)

    def test_wp6_help_lists_every_mode(self) -> None:
        # Given the final governance command surface
        command = [sys.executable, "scripts/governance_checks.py", "--help"]

        # When help is requested
        completed = subprocess.run(
            command,
            cwd=REPOSITORY,
            check=False,
            capture_output=True,
            text=True,
        )

        # Then all four WP6 modes are listed and help succeeds
        self.assertEqual(completed.returncode, 0, completed.stderr)
        for option in (
            "--wp6-review-manifest",
            "--wp6-close",
            "--changed-python-max-pure-loc",
            "--baseline-pure-loc",
            "--wp6-release-scan",
        ):
            self.assertIn(option, completed.stdout)

    def test_wp6_cli_rejects_incomplete_combinations(self) -> None:
        cases = (
            ("--changed-python-max-pure-loc", "250"),
            ("--baseline-pure-loc", "missing.json"),
        )
        for arguments in cases:
            with self.subTest(arguments=arguments):
                # Given one half of the combinable LOC mode
                command = [sys.executable, "scripts/governance_checks.py", *arguments]

                # When the strict parser runs
                completed = subprocess.run(
                    command,
                    cwd=REPOSITORY,
                    check=False,
                    capture_output=True,
                    text=True,
                )

                # Then the incomplete mode is rejected
                self.assertNotEqual(completed.returncode, 0)

    def test_diff_scoped_loc_accepts_mechanical_shrink(self) -> None:
        # Given a baseline-oversized file reduced and no new WP6 definitions
        with TemporaryDirectory(prefix="sciretriever-wp6-loc-") as temporary:
            root = Path(temporary)
            baseline_text = "".join(f"value_{index} = {index}\n" for index in range(251))
            commit = initialize_repository(root, {"legacy.py": baseline_text})
            manifest = write_baseline(
                root,
                commit,
                [{"path": "legacy.py", "pure_loc": 251}],
            )
            (root / "legacy.py").write_text(
                "".join(f"value_{index} = {index}\n" for index in range(250)),
                encoding="utf-8",
            )

            # When the exact diff-scoped LOC gate runs
            violations = governance_checks.find_wp6_pure_loc_violations(
                root,
                manifest,
                250,
            )

        # Then the mechanical shrink is accepted
        self.assertEqual(violations, ())

    def test_diff_scoped_loc_rejects_digest_growth_and_core_drift(self) -> None:
        # Given a small baseline file grown over cap and protected core package drift
        with TemporaryDirectory(prefix="sciretriever-wp6-loc-") as temporary:
            root = Path(temporary)
            commit = initialize_repository(
                root,
                {
                    "small.py": "value = 1\n",
                    "src/sciretriever/core/package.py": "VALUE = 1\n",
                },
            )
            manifest = write_baseline(
                root,
                commit,
                [
                    {"path": "small.py", "pure_loc": 1},
                    {"path": "src/sciretriever/core/package.py", "pure_loc": 1},
                ],
            )
            (root / "small.py").write_text("value = 1\n" * 251, encoding="utf-8")
            (root / "src/sciretriever/core/package.py").write_text(
                "VALUE = 2\n",
                encoding="utf-8",
            )

            # When the exact diff-scoped LOC gate runs
            violations = governance_checks.find_wp6_pure_loc_violations(
                root,
                manifest,
                250,
            )

            # Then growth and protected-file drift are both rejected
            self.assertTrue(any("exceeds 250" in item for item in violations))
            self.assertTrue(any("core/package.py" in item for item in violations))

            # When one byte of the immutable baseline manifest changes
            original = manifest.read_bytes()
            manifest.write_bytes(original + b" ")
            stale = governance_checks.find_wp6_pure_loc_violations(root, manifest, 250)

        # Then the external Todo 1 digest rejects the stale manifest
        self.assertTrue(any("SHA256" in item for item in stale))

    def test_diff_scoped_loc_rejects_new_overflow_and_grandfathered_symbol(self) -> None:
        probes = ("new-overflow", "grandfathered-symbol")
        for probe in probes:
            with self.subTest(probe=probe), TemporaryDirectory(
                prefix="sciretriever-wp6-loc-"
            ) as temporary:
                # Given an exact baseline and one prohibited changed-file shape
                root = Path(temporary)
                baseline_text = "".join(
                    f"value_{index} = {index}\n" for index in range(251)
                )
                commit = initialize_repository(root, {"legacy.py": baseline_text})
                manifest = write_baseline(
                    root,
                    commit,
                    [{"path": "legacy.py", "pure_loc": 251}],
                )
                if probe == "new-overflow":
                    (root / "new.py").write_text(
                        "value = 1\n" * 251,
                        encoding="utf-8",
                    )
                else:
                    (root / "legacy.py").write_text(
                        "".join(
                            f"value_{index} = {index}\n" for index in range(248)
                        )
                        + "def ExpansionService():\n    return None\n",
                        encoding="utf-8",
                    )

                # When the diff-scoped LOC gate runs
                violations = governance_checks.find_wp6_pure_loc_violations(
                    root,
                    manifest,
                    250,
                )

                # Then overflow or new behavior in a grandfathered file rejects
                expected = "exceeds 250" if probe == "new-overflow" else "adds WP6 symbols"
                self.assertTrue(any(expected in item for item in violations))

    def test_manifest_modes_reject_malformed_schema_without_writes(self) -> None:
        # Given malformed review input and a sentinel workspace file
        with TemporaryDirectory(prefix="sciretriever-wp6-manifest-") as temporary:
            root = Path(temporary)
            manifest = root / "review.json"
            manifest.write_text('{"version":1,"extra":true}', encoding="utf-8")
            before = manifest.read_bytes()

            # When each read-only manifest validator runs
            review = governance_checks.find_wp6_review_manifest_violations(root, manifest)
            closure = governance_checks.find_wp6_closure_violations(root, manifest)
            release = governance_checks.find_wp6_release_scan_violations(root, manifest)

            # Then every mode fails closed and the input is unchanged
            self.assertTrue(review)
            self.assertTrue(closure)
            self.assertTrue(release)
            self.assertEqual(manifest.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
