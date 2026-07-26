"""Read-only SciRetriever governance command entry point."""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.governance_documents import find_document_governance_violations
from scripts.wp6_closure import find_wp6_closure_violations
from scripts.wp6_pure_loc import find_wp6_pure_loc_violations
from scripts.wp6_release_scan import find_wp6_release_scan_violations
from scripts.wp6_review_manifest import find_wp6_review_manifest_violations


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wp6-review-manifest", type=Path, metavar="PATH")
    parser.add_argument("--wp6-close", type=Path, metavar="PATH")
    parser.add_argument("--changed-python-max-pure-loc", type=int, metavar="N")
    parser.add_argument("--baseline-pure-loc", type=Path, metavar="PATH")
    parser.add_argument("--wp6-release-scan", type=Path, metavar="PATH")
    return parser


def _argument_error(arguments: argparse.Namespace) -> str | None:
    has_maximum = arguments.changed_python_max_pure_loc is not None
    has_baseline = arguments.baseline_pure_loc is not None
    if has_maximum != has_baseline:
        return "--changed-python-max-pure-loc and --baseline-pure-loc require each other"
    exclusive = sum(
        path is not None
        for path in (arguments.wp6_close, arguments.wp6_release_scan)
    )
    if exclusive and (
        arguments.wp6_review_manifest is not None
        or has_maximum
        or exclusive > 1
    ):
        return "--wp6-close and --wp6-release-scan are standalone modes"
    if not (
        arguments.wp6_review_manifest is not None
        or arguments.wp6_close is not None
        or arguments.wp6_release_scan is not None
        or has_maximum
    ):
        return "at least one WP6 governance mode is required"
    return None


def run(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    arguments = parser.parse_args(argv)
    argument_error = _argument_error(arguments)
    if argument_error is not None:
        parser.error(argument_error)
    violations: list[str] = []
    if arguments.wp6_review_manifest is not None:
        violations.extend(
            find_wp6_review_manifest_violations(
                ROOT,
                arguments.wp6_review_manifest,
            )
        )
    if arguments.changed_python_max_pure_loc is not None:
        violations.extend(
            find_wp6_pure_loc_violations(
                ROOT,
                arguments.baseline_pure_loc,
                arguments.changed_python_max_pure_loc,
            )
        )
    if arguments.wp6_close is not None:
        violations.extend(find_wp6_closure_violations(ROOT, arguments.wp6_close))
    if arguments.wp6_release_scan is not None:
        violations.extend(
            find_wp6_release_scan_violations(ROOT, arguments.wp6_release_scan)
        )
    for violation in sorted(set(violations)):
        print(f"[governance] {violation}", file=sys.stderr)
    return 1 if violations else 0


def main() -> int:
    return run()


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = (
    "find_document_governance_violations",
    "find_wp6_closure_violations",
    "find_wp6_pure_loc_violations",
    "find_wp6_release_scan_violations",
    "find_wp6_review_manifest_violations",
    "main",
    "run",
)
