"""Top-level configuration center navigation and local readiness home."""

from __future__ import annotations

import os

from sciretriever.configuration import (
    CloakRuntimeManager,
    ConfigurationError,
    acquisition_source_providers,
    browser_access_status,
    configuration_path,
    configuration_runtime_status,
    credential_path,
    load_credentials,
    load_editable_user_configuration,
    metadata_source_providers,
)
from sciretriever.entry.cli.config_center.analysis import manage_analyze
from sciretriever.entry.cli.config_center.browser import manage_browser
from sciretriever.entry.cli.config_center.common import option, read_line, select_value
from sciretriever.entry.cli.config_center.models import manage_models
from sciretriever.entry.cli.config_center.parsing import manage_parse
from sciretriever.entry.cli.config_center.sources import manage_download, manage_search
from sciretriever.entry.cli.config_center.status import show_local_status
from sciretriever.entry.cli.config_ui import (
    ConfigActionKind,
    ConfigConsole,
    ConfigTheme,
    TerminalChoice,
    interactive_terminal,
)
from sciretriever.model.configuration import (
    BrowserAccessStatus,
    BrowserController,
    BrowserProfilePresence,
    Configuration,
    ConfigurationRuntimeStatus,
)

_AREA_HANDLERS = {
    "models": manage_models,
    "search": manage_search,
    "download": manage_download,
    "parse": manage_parse,
    "analyze": manage_analyze,
    "browser": manage_browser,
}
_PLAIN_AREA_ALIASES = {
    "m": "models",
    "model": "models",
    "models": "models",
    "s": "search",
    "search": "search",
    "d": "download",
    "download": "download",
    "p": "parse",
    "parse": "parse",
    "mineru": "parse",
    "a": "analyze",
    "analyze": "analyze",
    "analysis": "analyze",
    "b": "browser",
    "browser": "browser",
    "i": "status",
    "info": "status",
    "status": "status",
    "t": "theme",
    "theme": "theme",
    "q": "quit",
    "quit": "quit",
}


def _configuration_summary() -> tuple[Configuration, ConfigurationRuntimeStatus]:
    configuration = load_editable_user_configuration()
    credentials = load_credentials(home=None)
    return configuration, configuration_runtime_status(
        configuration,
        credentials=credentials,
    )


def configuration_home_rows(
    configuration: Configuration,
    runtime: ConfigurationRuntimeStatus,
    browser: BrowserAccessStatus,
    cloak: object,
) -> dict[str, tuple[str, str]]:
    model_count = len(configuration.models.values)
    provider_count = len(configuration.providers.values)
    analysis_model = configuration.models.get(configuration.analysis.model)
    browser_model = configuration.models.get(configuration.access.model)
    metadata_count = len(metadata_source_providers(configuration))
    acquisition_count = len(acquisition_source_providers(configuration))
    cloak_version = getattr(cloak, "version", None)
    cloak_presence = getattr(cloak, "presence", "missing")
    cloak_verified = bool(getattr(cloak, "verified", False))
    profile = browser.profile
    profile_identity = profile.selected or "not selected"
    profile_ready = profile.presence is BrowserProfilePresence.CONFIGURED
    browser_runtime_ready = cloak_verified and profile_ready
    controller_ready = (
        configuration.access.browser_controller is BrowserController.RULES
        or runtime.agents.browser_locally_ready
    )
    return {
        "models": (
            f"{model_count} Models · {provider_count} Providers",
            "Ready" if model_count else "Incomplete",
        ),
        "search": (
            f"{configuration.sources.metadata.mode.value} · {metadata_count} Sources · "
            f"Limit {configuration.sources.metadata.limit} / Source",
            "Ready" if metadata_count else "Incomplete",
        ),
        "download": (
            f"{configuration.sources.acquisition.mode.value} · {acquisition_count} Sources",
            "Ready" if acquisition_count else "Incomplete",
        ),
        "parse": (
            "MinerU 3.4.4 · protocol 2"
            if configuration.parsing.base_url is not None
            else "not configured",
            "Ready" if runtime.parsing.configuration_complete else "Incomplete",
        ),
        "analyze": (
            "not selected"
            if analysis_model is None
            else f"{analysis_model.reference} · reasoning {analysis_model.reasoning.value}",
            "Ready" if runtime.agents.analysis_reference_locally_ready else "Incomplete",
        ),
        "browser": (
            f"{'enabled' if configuration.access.browser_enabled else 'off'} · "
            f"{configuration.access.browser_controller.value} · "
            f"{'no Model' if browser_model is None else browser_model.reference} · "
            f"Profile {profile_identity} · {cloak_presence} "
            f"{cloak_version or 'not installed'}",
            (
                "Ready"
                if configuration.access.browser_enabled
                and controller_ready
                and browser_runtime_ready
                else "Off"
                if not configuration.access.browser_enabled
                else "Incomplete"
            ),
        ),
    }


def _render_home(
    console: ConfigConsole,
    configuration: Configuration,
    runtime: ConfigurationRuntimeStatus,
    browser: BrowserAccessStatus,
    cloak: object,
) -> None:
    rows = configuration_home_rows(configuration, runtime, browser, cloak)
    parser = configuration.parsing
    parser_ready = runtime.parsing.configuration_complete and (
        not runtime.parsing.bearer_token_required
        or (
            runtime.parsing.bearer_token_configured is True
            and runtime.parsing.credential_origin_matches is True
        )
    )
    console.home(
        models_state=rows["models"][1],
        models_detail=rows["models"][0],
        search_state=rows["search"][1],
        search_detail=rows["search"][0],
        download_state=rows["download"][1],
        download_detail=rows["download"][0],
        parse_state="Ready" if parser_ready else "Incomplete",
        parse_detail=(
            "MinerU 3.4.4 · protocol 2 · vlm-engine"
            if parser.base_url is not None
            else "Not configured"
        ),
        analyze_state=rows["analyze"][1],
        analyze_detail=rows["analyze"][0],
        browser_state=rows["browser"][1],
        browser_detail=rows["browser"][0],
        status_detail="Local status only · external Tests stay with their owner",
        theme_detail=console.palette.name.value.title(),
    )


def _choose_theme(current: str, console: ConfigConsole) -> str:
    console.page(
        "Theme",
        "Choose an accessible terminal palette. NO_COLOR always forces Mono; semantic action "
        "markers remain visible when colors are unavailable.",
        facts=(("Current", console.palette.name.value),),
    )
    selected = select_value(
        "Theme",
        [
            option(ConfigTheme.AUTO.value, "Auto"),
            option(ConfigTheme.DARK.value, "Dark"),
            option(ConfigTheme.LIGHT.value, "Light"),
            option(ConfigTheme.MONO.value, "Mono"),
        ],
        console=console,
        default=current,
    )
    return current if selected is None else selected


def _open_area(selected: str, console: ConfigConsole, active_theme: str) -> str:
    if selected == "theme":
        return _choose_theme(active_theme, console)
    if selected == "status":
        show_local_status(active_theme)
        return active_theme
    handler = _AREA_HANDLERS.get(selected)
    if handler is not None:
        handler(console)
    return active_theme


def _run_plain(theme: str) -> int:
    active_theme = theme
    while True:
        console = ConfigConsole(ConfigTheme.MONO)
        try:
            configuration, runtime = _configuration_summary()
            browser = browser_access_status(configuration)
            cloak = CloakRuntimeManager().status()
            _render_home(console, configuration, runtime, browser, cloak)
        except ConfigurationError:
            raise
        except (OSError, TypeError, ValueError):
            pass
        console.message(
            "SciRetriever configuration center\n"
            "Local status only · no network requests\n\n"
            "  ◆ M. Models\n"
            "  ◆ S. Search\n"
            "  ◆ D. Download\n"
            "  ◆ P. Parse\n"
            "  ◆ A. Analyze\n"
            "  ◆ B. Browser\n"
            "  ◇ I. Status\n"
            "  ◆ T. Theme\n"
            "  × Q. Quit"
        )
        answer = read_line("Choose M, S, D, P, A, B, I, T, or Q: ")
        if answer is None:
            return 0
        selected = _PLAIN_AREA_ALIASES.get(answer.casefold())
        if selected == "quit":
            return 0
        if selected is None:
            console.message("Invalid selection.", kind="warning")
            continue
        active_theme = _open_area(selected, console, active_theme)


def _run_rich(theme: str) -> int:
    active_theme = theme
    while True:
        console = ConfigConsole(active_theme)
        configuration, runtime = _configuration_summary()
        browser = browser_access_status(configuration)
        cloak = CloakRuntimeManager().status()
        console.header(
            config_path=os.fspath(configuration_path()),
            credentials_path=os.fspath(credential_path()),
        )
        _render_home(console, configuration, runtime, browser, cloak)
        selected = TerminalChoice[object](
            message="Open a configuration area",
            options=[
                option("models", "Models"),
                option("search", "Search"),
                option("download", "Download"),
                option("parse", "Parse"),
                option("analyze", "Analyze"),
                option("browser", "Browser"),
                option("status", "Status", kind=ConfigActionKind.INSPECT),
                option("theme", "Theme"),
                option("quit", "Quit", kind=ConfigActionKind.NAVIGATE),
            ],
            theme=active_theme,
            shortcuts={
                "a": "analyze",
                "b": "browser",
                "d": "download",
                "i": "status",
                "m": "models",
                "p": "parse",
                "s": "search",
                "t": "theme",
                "q": "quit",
            },
        ).prompt()
        if selected == "quit":
            return 0
        active_theme = _open_area(str(selected), console, active_theme)


def run_config_manager(theme: str = ConfigTheme.AUTO.value) -> int:
    return _run_rich(theme) if interactive_terminal() else _run_plain(theme)


__all__ = ("configuration_home_rows", "run_config_manager")
