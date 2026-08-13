"""Installed-wheel driver for the real Chromium controlled-Browser QA."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright_runtime import run_acceptance  # noqa: E402, I001


if __name__ == "__main__":
    run_acceptance()
