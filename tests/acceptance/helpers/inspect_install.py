"""Emit a JSON audit of one installed SciRetriever distribution."""

from __future__ import annotations

import hashlib
import importlib.metadata
import importlib.util
import json
import os
import site
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

import sciretriever


def _resolved_path(value: str) -> str:
    if not value:
        return ""
    return os.fspath(Path(value).resolve(strict=False))


distribution = importlib.metadata.distribution("sciretriever")
direct_url_path = Path(
    str(distribution.locate_file("sciretriever-0.1.0.dist-info/direct_url.json"))
)
direct_url = json.loads(direct_url_path.read_text(encoding="utf-8"))
archive_url = direct_url.get("url")
if type(archive_url) is not str:
    raise RuntimeError("installed distribution has no direct archive URL")
parsed_archive_url = urlparse(archive_url)
if parsed_archive_url.scheme != "file" or parsed_archive_url.netloc:
    raise RuntimeError("installed distribution archive URL is not a local file")
archive_path = Path(unquote(parsed_archive_url.path)).resolve(strict=True)
archive_digest = hashlib.sha256()
with archive_path.open("rb") as stream:
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        archive_digest.update(block)
entry_points = tuple(
    sorted(
        entry.value
        for entry in distribution.entry_points
        if entry.group == "console_scripts" and entry.name == "sciretriever"
    )
)
spec = importlib.util.find_spec("tests")
payload = {
    "archive_sha256": archive_digest.hexdigest(),
    "direct_url": direct_url,
    "distribution_version": distribution.version,
    "entry_points": entry_points,
    "module_file": _resolved_path(sciretriever.__file__ or ""),
    "module_version": sciretriever.__version__,
    "prefix": _resolved_path(sys.prefix),
    "sys_path": tuple(_resolved_path(item) for item in sys.path),
    "user_site_enabled": site.ENABLE_USER_SITE,
    "tests_module_origin": None if spec is None else _resolved_path(spec.origin or ""),
}
print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
