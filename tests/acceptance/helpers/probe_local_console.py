"""Run the installed production console against one temporary local catalog."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def _configuration(root: Path) -> str:
    return f"""
[paths]
catalog_path = {json.dumps(os.fspath(root / "catalog.sqlite3"))}
artifact_root = {json.dumps(os.fspath(root / "artifacts"))}
"""


root = Path(os.environ["SCIRETRIEVER_ACCEPTANCE_ROOT"]) / "local-console"
root.mkdir(mode=0o700)
configuration = root / "config.toml"
configuration.write_text(_configuration(root), encoding="utf-8")
console = Path(sys.executable).with_name("sciretriever")
environment = dict(os.environ)
environment["SCIRETRIEVER_CONFIG"] = os.fspath(configuration)
completed = subprocess.run(
    (os.fspath(console), "literature", "search", "--json"),
    cwd=root,
    env=environment,
    check=False,
    capture_output=True,
    text=True,
    timeout=30,
)
payload = {
    "artifacts_exists": (root / "artifacts").exists(),
    "catalog_exists": (root / "catalog.sqlite3").exists(),
    "returncode": completed.returncode,
    "stderr": completed.stderr,
    "stdout": completed.stdout,
}
print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
