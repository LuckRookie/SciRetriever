#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import sys

REPOSITORY = Path(__file__).resolve().parents[1]
TESTS = REPOSITORY / "tests"
sys.path.insert(0, str(REPOSITORY))
sys.path.insert(0, str(TESTS))

from tests.wp6_acceptance_fixture import InjectedAcceptanceFailure, run_acceptance


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the offline WP6 product acceptance fixture.")
    parser.add_argument("--work-root", type=Path, required=True)
    parser.add_argument("--keep-on-failure", action="store_true")
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    root = arguments.work_root.resolve()
    injection = os.environ.get("SCIRETRIEVER_WP6_QA_INJECT")
    try:
        summary = run_acceptance(root, injection)
    except (AssertionError, InjectedAcceptanceFailure, OSError) as error:
        if not arguments.keep_on_failure:
            shutil.rmtree(root, ignore_errors=True)
        print(json.dumps({"reason": str(error), "status": "failed"}, separators=(",", ":"), sort_keys=True))
        return 1
    shutil.rmtree(root)
    print(summary.to_json())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
