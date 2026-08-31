"""Explicit owner-scoped configuration probes used by interactive pages."""

from __future__ import annotations

import sys
from typing import Literal

from sciretriever.bootstrap import build_production_configuration_probe_session
from sciretriever.configuration import load_user_configuration
from sciretriever.entry.cli.config_center.common import confirm


def run_core_test(service: Literal["llm", "browser-agent", "mineru"]) -> None:
    if service == "llm":
        prompt = (
            "The Analyze probe sends one minimal strict-schema Model request and may consume "
            "a small amount of quota. Continue? [y/N] "
        )
        cancelled = "Analyze Model probe cancelled.\n"
    elif service == "browser-agent":
        prompt = (
            "The Browser Model probe sends one synthetic 1×1 image and one closed generic "
            "tool. It does not start a Browser or send Literature, PDF, page content, or a "
            "real screenshot, but may consume a small amount of quota. Continue? [y/N] "
        )
        cancelled = "Browser Model probe cancelled.\n"
    else:
        prompt = None
        cancelled = ""
    if prompt is not None and not confirm(prompt):
        sys.stderr.write(cancelled)
        return
    configuration = load_user_configuration()
    session = build_production_configuration_probe_session(configuration)
    try:
        if service == "llm":
            result = session.run_agents()
        elif service == "browser-agent":
            result = session.run_browser_agent()
        else:
            result = session.run_mineru()
    finally:
        session.close()
    label = {
        "llm": "Analyze Model",
        "browser-agent": "Browser Model",
        "mineru": "MinerU",
    }[service]
    sys.stderr.write(f"{label} configuration test: {result.outcome.value}.\n")
    if result.failure_code is not None:
        sys.stderr.write(f"  Failure: {result.failure_code}\n")


__all__ = ("run_core_test",)
