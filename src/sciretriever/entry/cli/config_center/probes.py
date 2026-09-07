"""Shared owner-scoped configuration tests for TUI and scripted CLI paths."""

from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Literal, Mapping, TypeAlias, cast

from sciretriever.bootstrap import (
    ProductionConfigurationProbeSession,
    build_production_configuration_probe_session,
)
from sciretriever.configuration import ConfigurationError, load_user_configuration
from sciretriever.entry.cli.config_center.common import confirm
from sciretriever.entry.cli.config_probe_diagnostics import diagnosed_probe_payload
from sciretriever.entry.cli.config_ui import ConfigConsole, ConfigStatusPresenter
from sciretriever.model.configuration import (
    BrowserConfigurationProbeResult,
    Configuration,
    ConfigurationProbeSummary,
    CoreConfigurationProbeResult,
    ProbeOutcome,
    ProviderCapability,
    ProviderName,
)

ConfigurationTestOwner: TypeAlias = Literal[
    "provider",
    "model",
    "search",
    "download",
    "parse",
    "analyze",
    "browser-model",
    "browser-site",
    "all",
]
ConfigurationTestPayload: TypeAlias = (
    ConfigurationProbeSummary
    | CoreConfigurationProbeResult
    | BrowserConfigurationProbeResult
    | dict[str, object]
)


@dataclass(frozen=True, slots=True)
class ConfigurationTestRequest:
    """One explicit configuration-test selection shared by both CLI surfaces."""

    owner: ConfigurationTestOwner
    target: str | None = None
    all_targets: bool = False
    image_input: bool = False

    def __post_init__(self) -> None:
        if self.owner in {"provider", "model", "browser-site"}:
            if self.target is None or self.all_targets:
                raise ValueError("configuration test target is invalid")
        elif self.owner in {"search", "download"}:
            if (self.target is None) == (not self.all_targets):
                raise ValueError("configuration test target is invalid")
        elif self.target is not None or self.all_targets:
            raise ValueError("configuration test target is invalid")
        if self.image_input and self.owner != "model":
            raise ValueError("configuration test image selection is invalid")


@dataclass(frozen=True, slots=True)
class ConfigurationTestExecution:
    """One typed payload plus the shell-level success interpretation."""

    payload: ConfigurationTestPayload
    passed: bool


def confirmation_message(request: ConfigurationTestRequest) -> str | None:
    """Describe the exact external side effect before a human-mode test."""

    if request.owner == "provider":
        return "Read this Model Provider's bounded catalog now? It may consume quota. [y/N] "
    if request.owner == "model":
        kind = "synthetic image" if request.image_input else "minimal strict response"
        return f"Send one {kind} request to this exact Model? It may consume quota. [y/N] "
    if request.owner == "search":
        scope = "enabled Search Sources" if request.all_targets else "this Search Source"
        return f"Run bounded read-only metadata probes for {scope}? They may consume quota. [y/N] "
    if request.owner == "download":
        return None
    if request.owner == "parse":
        return "Perform GET health against MinerU now? No PDF will be uploaded. [y/N] "
    if request.owner == "analyze":
        return (
            "Send one minimal strict-schema request through the selected Analyze Model? "
            "It may consume quota. [y/N] "
        )
    if request.owner == "browser-model":
        return (
            "Send one synthetic image and one closed tool through the Browser Model? "
            "It may consume quota. [y/N] "
        )
    if request.owner == "browser-site":
        return (
            "Launch one controlled headed Browser and visit the selected approved minimal "
            "site target? [y/N] "
        )
    return (
        "Run every active safe configuration probe? Browser site navigation, PDF download, "
        "and PDF upload are excluded. [y/N] "
    )


def _provider_name(value: str) -> ProviderName:
    try:
        return ProviderName(value)
    except ValueError:
        raise ConfigurationError("provider is unsupported") from None


def _source_provider(request: ConfigurationTestRequest) -> ProviderName | None:
    if request.owner not in {"search", "download"} or request.target is None:
        return None
    return _provider_name(request.target)


def _validate_registry_target(
    request: ConfigurationTestRequest,
    configuration: Configuration,
) -> None:
    if request.owner == "provider" and configuration.providers.get(request.target) is None:
        raise ConfigurationError("provider is unsupported")
    if request.owner == "model" and configuration.models.get(request.target) is None:
        raise ConfigurationError("configuration value is invalid")


def _validate_source_target(
    request: ConfigurationTestRequest,
    session: ProductionConfigurationProbeSession,
    source_provider: ProviderName | None,
) -> None:
    if source_provider is None:
        return
    expected = (
        ProviderCapability.METADATA if request.owner == "search" else ProviderCapability.ACQUISITION
    )
    if not any(
        status.provider is source_provider and status.capability is expected
        for status in session.status.capabilities
    ):
        raise ConfigurationError("capability is unsupported")


def _run_registry_test(
    request: ConfigurationTestRequest,
    session: ProductionConfigurationProbeSession,
) -> ConfigurationTestExecution:
    target = cast(str, request.target)
    if request.owner == "provider":
        payload = session.run_model_provider(target)
    else:
        payload = session.run_model(target, image_input=request.image_input)
    return ConfigurationTestExecution(
        payload=payload,
        passed=payload.outcome is ProbeOutcome.PASSED,
    )


def _run_source_test(
    request: ConfigurationTestRequest,
    session: ProductionConfigurationProbeSession,
    source_provider: ProviderName | None,
) -> ConfigurationTestExecution:
    if request.owner == "search":
        payload = session.run(provider=source_provider, test_all=request.all_targets)
    else:
        payload = session.run_acquisition(
            provider=source_provider,
            test_all=request.all_targets,
        )
    return ConfigurationTestExecution(payload=payload, passed=payload.passed)


def _run_service_test(
    request: ConfigurationTestRequest,
    session: ProductionConfigurationProbeSession,
) -> ConfigurationTestExecution:
    if request.owner == "parse":
        payload: ConfigurationTestPayload = session.run_mineru()
    elif request.owner == "analyze":
        payload = session.run_agents()
    elif request.owner == "browser-model":
        payload = session.run_browser_agent()
    else:
        payload = session.run_browser(cast(str, request.target))
    return ConfigurationTestExecution(
        payload=payload,
        passed=payload.outcome is ProbeOutcome.PASSED,
    )


def _run_selected_test(
    request: ConfigurationTestRequest,
    session: ProductionConfigurationProbeSession,
    source_provider: ProviderName | None,
) -> ConfigurationTestExecution:
    if request.owner in {"provider", "model"}:
        return _run_registry_test(request, session)
    if request.owner in {"search", "download"}:
        return _run_source_test(request, session, source_provider)
    if request.owner == "all":
        payload, passed = _run_all(session)
        return ConfigurationTestExecution(payload=payload, passed=passed)
    return _run_service_test(request, session)


def execute_configuration_test(
    request: ConfigurationTestRequest,
) -> ConfigurationTestExecution:
    """Execute one selected test through a no-Storage production probe session."""

    configuration = load_user_configuration()
    _validate_registry_target(request, configuration)
    source_provider = _source_provider(request)
    session = build_production_configuration_probe_session(configuration)
    try:
        _validate_source_target(request, session, source_provider)
        return _run_selected_test(request, session, source_provider)
    finally:
        session.close()


def _run_all(
    session: ProductionConfigurationProbeSession,
) -> tuple[dict[str, object], bool]:
    search = session.run(test_all=True)
    download = session.run_acquisition(test_all=True)
    analyze = session.run_agents()
    parse = session.run_mineru()
    payload: dict[str, object] = {
        "search": search.model_dump(mode="json"),
        "download": download.model_dump(mode="json"),
        "analyze": analyze.model_dump(mode="json"),
        "parse": parse.model_dump(mode="json"),
    }
    required = [analyze, parse]
    if session.configuration.browser.enabled:
        browser = session.run_browser_agent()
        payload["browser"] = browser.model_dump(mode="json")
        required.append(browser)
    download_ready = all(
        item.outcome is ProbeOutcome.PASSED
        or (
            item.outcome is ProbeOutcome.SKIPPED
            and item.failure_code == "acquisition-probe-unavailable"
        )
        for item in download.results
    )
    passed = (
        search.passed
        and download_ready
        and all(item.outcome is ProbeOutcome.PASSED for item in required)
    )
    # Only the absence of a safe content-independent Download probe is
    # neutral.  Local readiness failures still make the aggregate fail.
    return payload, passed


def payload_mapping(payload: ConfigurationTestPayload) -> Mapping[str, object]:
    if isinstance(
        payload,
        (
            ConfigurationProbeSummary,
            CoreConfigurationProbeResult,
            BrowserConfigurationProbeResult,
        ),
    ):
        return diagnosed_probe_payload(payload.model_dump(mode="json"))
    return diagnosed_probe_payload(payload)


def run_interactive_test(
    request: ConfigurationTestRequest,
    console: ConfigConsole,
) -> ConfigurationTestExecution | None:
    """Confirm, execute, and render one TUI-owned configuration test."""

    prompt = confirmation_message(request)
    if prompt is not None and not confirm(prompt):
        console.message("Configuration test cancelled.", kind="muted")
        return None
    execution = execute_configuration_test(request)
    ConfigStatusPresenter(
        console.palette.name,
        file=sys.stderr,
    ).probes(payload_mapping(execution.payload))
    return execution


__all__ = (
    "ConfigurationTestExecution",
    "ConfigurationTestRequest",
    "confirmation_message",
    "execute_configuration_test",
    "payload_mapping",
    "run_interactive_test",
)
