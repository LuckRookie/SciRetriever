"""CLI command dispatch for configuration manager, status and explicit probes."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from typing import cast

from sciretriever.bootstrap import (
    ProductionConfigurationProbeSession,
    build_production_configuration_probe_session,
)
from sciretriever.configuration import load_user_configuration
from sciretriever.entry.cli.config_center.common import confirm
from sciretriever.entry.cli.config_center.manager import run_config_manager
from sciretriever.entry.cli.config_center.status import run_status
from sciretriever.entry.cli.config_ui import ConfigStatusPresenter
from sciretriever.logging.api import configure_logging
from sciretriever.model.configuration import (
    BrowserConfigurationProbeResult,
    BrowserController,
    ConfigurationProbeSummary,
    CoreConfigurationProbeResult,
    ProbeOutcome,
)


def _write_json(value: object) -> None:
    if isinstance(
        value,
        (
            ConfigurationProbeSummary,
            CoreConfigurationProbeResult,
            BrowserConfigurationProbeResult,
        ),
    ):
        payload: object = value.model_dump(mode="json")
    else:
        payload = value
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")


def _run_test(arguments: argparse.Namespace) -> int:
    configuration = load_user_configuration()
    session = build_production_configuration_probe_session(configuration)
    try:
        return _run_test_session(arguments, session)
    finally:
        session.close()


def _run_test_session(  # noqa: C901
    arguments: argparse.Namespace,
    session: ProductionConfigurationProbeSession,
) -> int:
    result: (
        ConfigurationProbeSummary
        | CoreConfigurationProbeResult
        | BrowserConfigurationProbeResult
        | dict[str, object]
    )
    if arguments.browser_access_key is not None:
        if not arguments.json and not confirm(
            "This starts one controlled headed Browser and visits exactly one approved minimal "
            "Publisher target. It does not prove institution-IP or article entitlement. "
            "Continue? [y/N] "
        ):
            sys.stderr.write("Browser probe cancelled.\n")
            return 0
        result = session.run_browser(arguments.browser_access_key)
        passed = result.outcome is ProbeOutcome.PASSED
    elif arguments.provider == "llm":
        if not arguments.json and not confirm(
            "The Analyze Model probe sends one minimal request and may consume quota. "
            "Continue? [y/N] "
        ):
            sys.stderr.write("Analyze Model probe cancelled.\n")
            return 0
        result = session.run_agents()
        passed = result.outcome is ProbeOutcome.PASSED
    elif arguments.provider == "browser-agent":
        if not arguments.json and not confirm(
            "The Browser Model probe sends one synthetic image and one closed tool. It sends no "
            "Literature, PDF, page content or real screenshot, and does not start a Browser. "
            "Continue? [y/N] "
        ):
            sys.stderr.write("Browser Model probe cancelled.\n")
            return 0
        result = session.run_browser_agent()
        passed = result.outcome is ProbeOutcome.PASSED
    elif arguments.provider == "mineru":
        if not arguments.json and not confirm(
            "The Parse probe performs GET health against MinerU. It uploads no PDF. "
            "Continue? [y/N] "
        ):
            sys.stderr.write("Parse probe cancelled.\n")
            return 0
        result = session.run_mineru()
        passed = result.outcome is ProbeOutcome.PASSED
    elif arguments.test_all:
        browser_agent_selected = (
            session.configuration.access.browser_controller is BrowserController.AGENT
        )
        browser_notice = (
            " It also sends the synthetic Browser Model probe because Agent is selected."
            if browser_agent_selected
            else ""
        )
        if not arguments.json and not confirm(
            "This runs enabled Source probes, one minimal Analyze Model request and a MinerU "
            "health check that uploads no PDF." + browser_notice + " Continue? [y/N] "
        ):
            sys.stderr.write("Configuration probes cancelled.\n")
            return 0
        provider_result = session.run(test_all=True)
        analyze_result = session.run_agents()
        mineru_result = session.run_mineru()
        result = {
            "providers": provider_result.model_dump(mode="json"),
            "llm": analyze_result.model_dump(mode="json"),
            "mineru": mineru_result.model_dump(mode="json"),
        }
        browser_result = session.run_browser_agent() if browser_agent_selected else None
        if browser_result is not None:
            result["browser-agent"] = browser_result.model_dump(mode="json")
        passed = provider_result.passed and all(
            item.outcome is ProbeOutcome.PASSED for item in (analyze_result, mineru_result)
        )
        if browser_result is not None:
            passed = passed and browser_result.outcome is ProbeOutcome.PASSED
    else:
        result = session.run(provider=arguments.provider)
        passed = result.passed
    if arguments.json:
        _write_json(result)
    else:
        payload = (
            result.model_dump(mode="json")
            if isinstance(
                result,
                (
                    ConfigurationProbeSummary,
                    CoreConfigurationProbeResult,
                    BrowserConfigurationProbeResult,
                ),
            )
            else cast(dict[str, object], result)
        )
        ConfigStatusPresenter(arguments.theme).probes(payload)
    return 0 if passed else 3


def run_config(arguments: argparse.Namespace) -> int:
    configure_logging(level=logging.DEBUG if arguments.debug else logging.INFO)
    if arguments.action is None:
        return run_config_manager(arguments.theme)
    if arguments.action == "status":
        return run_status(arguments)
    return _run_test(arguments)


__all__ = ("run_config",)
