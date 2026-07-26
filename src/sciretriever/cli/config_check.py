from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass, replace
import json
import os
from typing import TypedDict

from sciretriever.acquisition.browser import validate_browser_profile
from sciretriever.acquisition.preflight import run_preflight
from sciretriever.config import ConfigCheckMode, SciRetrieverConfig, get_credential
from sciretriever.errors import ConfigError
from sciretriever.cli.runtime_readiness import RuntimeReadiness, build_runtime_readiness


class ConfigCheckReport(TypedDict):
    checks: list[dict[str, str]]
    mode: str
    status: str


@dataclass(frozen=True, slots=True)
class ConfigCheck:
    name: str
    status: str
    reason: str


def configure_parser(parser: argparse.ArgumentParser) -> None:
    parser.description = "Validate configuration, with optional bounded read-only runtime probes."
    parser.add_argument(
        "--runtime",
        action="store_true",
        help="probe enabled capabilities with bounded read-only identity requests",
    )


def _analysis_secret_checks(
    config: SciRetrieverConfig,
    env: dict[str, str],
) -> list[ConfigCheck]:
    checks: list[ConfigCheck] = []
    mineru = config.analysis.mineru
    if mineru.mode == "remote" and mineru.auth_env is not None:
        status = "ready" if get_credential(mineru.auth_env, env=env) is not None else "missing"
        reason = "secret reference is available" if status == "ready" else "enabled capability secret is missing"
        checks.append(ConfigCheck("analysis.mineru.auth_env", status, reason))
    llm = config.analysis.llm
    if llm.endpoint is not None and llm.credential_env is not None:
        status = "ready" if get_credential(llm.credential_env, env=env) is not None else "missing"
        reason = "secret reference is available" if status == "ready" else "enabled capability secret is missing"
        checks.append(ConfigCheck("analysis.llm.credential_env", status, reason))
    return checks


def check_config(
    config: SciRetrieverConfig,
    *,
    env: dict[str, str] | None = None,
    mode: ConfigCheckMode = ConfigCheckMode.OFFLINE,
    readiness: RuntimeReadiness | None = None,
) -> ConfigCheckReport:
    environment = dict(os.environ if env is None else env)
    checks = [ConfigCheck("config", "ready", "strict TOML loaded")]
    preflight = run_preflight(config, env=environment)
    configured_names: set[str] = set()
    if config.paths.catalog is not None:
        configured_names.add("catalog")
    if config.paths.storage_root is not None:
        configured_names.update(("storage_root", "storage_capacity"))
    if config.acquisition.forbidden_urls is not None:
        configured_names.add("forbidden_urls")
    for check in preflight.checks:
        if check.name in configured_names or (
            check.name.startswith("provider:") and check.status in {"missing", "invalid"}
        ):
            checks.append(ConfigCheck(check.name, check.status, check.reason))
    browser = config.acquisition.browser
    if browser.enabled:
        try:
            if config.paths.storage_root is None:
                raise ValueError("storage root is required")
            inspected_browser = browser
            if browser.profile_reference is not None:
                inspected_browser = replace(browser, profile_dir=browser.profile_reference)
            validate_browser_profile(inspected_browser, config.paths.storage_root)
        except (ConfigError, OSError, ValueError):
            checks.append(ConfigCheck(
                "acquisition.browser.profile_dir", "invalid", "enabled browser profile is invalid"
            ))
        else:
            checks.append(ConfigCheck(
                "acquisition.browser.profile_dir", "ready", "enabled browser profile is ready"
            ))
    checks.extend(_analysis_secret_checks(config, environment))
    if mode is ConfigCheckMode.RUNTIME:
        runtime = readiness or build_runtime_readiness(config, env=environment)
        checks.extend(
            ConfigCheck(check.name, check.status, check.reason)
            for check in runtime.check(config)
        )
    status = "ready" if all(check.status == "ready" for check in checks) else "invalid"
    return {
        "checks": [asdict(check) for check in checks],
        "mode": mode.value,
        "status": status,
    }


def run(args: argparse.Namespace) -> int:
    mode = ConfigCheckMode.RUNTIME if args.runtime else ConfigCheckMode.OFFLINE
    config: SciRetrieverConfig | None = getattr(args, "_loaded_config", None)
    if config is None:
        report: ConfigCheckReport = {
            "checks": [{
                "name": "config", "status": "missing", "reason": "a selected config file is required",
            }],
            "mode": mode.value,
            "status": "invalid",
        }
    else:
        report = check_config(config, mode=mode)
    print(json.dumps(report, sort_keys=True, separators=(",", ":"), ensure_ascii=True))
    return 0 if report["status"] == "ready" else 1


__all__ = ("ConfigCheck", "ConfigCheckReport", "check_config", "configure_parser", "run")
