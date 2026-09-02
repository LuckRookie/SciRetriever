"""CLI dispatch for the configuration manager, local status, and explicit tests."""

from __future__ import annotations

import argparse
import json
import logging
import sys

from sciretriever.entry.cli.config_center.common import confirm
from sciretriever.entry.cli.config_center.manager import run_config_manager
from sciretriever.entry.cli.config_center.probes import (
    ConfigurationTestRequest,
    confirmation_message,
    execute_configuration_test,
    payload_mapping,
)
from sciretriever.entry.cli.config_center.status import run_status
from sciretriever.entry.cli.config_ui import ConfigStatusPresenter
from sciretriever.logging.api import configure_logging


def _test_request(arguments: argparse.Namespace) -> ConfigurationTestRequest:
    if getattr(arguments, "test_global_all", False):
        return ConfigurationTestRequest(owner="all")
    owner = arguments.test_owner
    if owner == "provider":
        return ConfigurationTestRequest(owner="provider", target=arguments.target)
    if owner == "model":
        return ConfigurationTestRequest(
            owner="model",
            target=arguments.target,
            image_input=arguments.test_image,
        )
    if owner in {"search", "download"}:
        return ConfigurationTestRequest(
            owner=owner,
            target=arguments.target,
            all_targets=arguments.test_area_all,
        )
    if owner == "parse":
        return ConfigurationTestRequest(owner="parse")
    if owner == "analyze":
        return ConfigurationTestRequest(owner="analyze")
    if owner == "browser" and arguments.browser_test_target == "model":
        return ConfigurationTestRequest(owner="browser-model")
    if owner == "browser" and arguments.browser_test_target == "site":
        return ConfigurationTestRequest(owner="browser-site", target=arguments.target)
    raise ValueError("configuration test target is invalid")


def _run_test(arguments: argparse.Namespace) -> int:
    request = _test_request(arguments)
    prompt = confirmation_message(request)
    if not arguments.json and prompt is not None and not confirm(prompt):
        sys.stderr.write("Configuration test cancelled.\n")
        return 0
    execution = execute_configuration_test(request)
    payload = payload_mapping(execution.payload)
    if arguments.json:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    else:
        ConfigStatusPresenter(arguments.theme).probes(payload)
    return 0 if execution.passed else 3


def run_config(arguments: argparse.Namespace) -> int:
    configure_logging(level=logging.DEBUG if arguments.debug else logging.INFO)
    if arguments.action is None:
        return run_config_manager(arguments.theme)
    if arguments.action == "status":
        return run_status(arguments)
    return _run_test(arguments)


__all__ = ("run_config",)
