"""Test-owned startup probe installed only in an isolated acceptance venv."""

from __future__ import annotations

import os

marker = os.environ.get("SCIRETRIEVER_TEST_STARTUP_MARKER")
if marker is not None:
    with open(marker, "xb") as stream:
        stream.write(b"loaded")
