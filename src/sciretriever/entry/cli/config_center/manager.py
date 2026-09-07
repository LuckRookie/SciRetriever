"""Top-level configuration center navigation and local readiness home."""

from __future__ import annotations

import os
from collections.abc import Mapping, Sequence

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
from sciretriever.entry.cli.config_center.common import (
    ConfigurationCenterQuit,
    option,
    read_line,
    select_value,
)
from sciretriever.entry.cli.config_center.models import manage_models
from sciretriever.entry.cli.config_center.parsing import manage_parse
from sciretriever.entry.cli.config_center.sources import manage_download, manage_search
from sciretriever.entry.cli.config_center.status import show_local_status
from sciretriever.entry.cli.config_ui import (
    ConfigActionKind,
    ConfigConsole,
    ConfigOption,
    ConfigTheme,
    TerminalChoice,
    interactive_terminal,
)
from sciretriever.model.configuration import (
    BrowserAccessStatus,
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
    browser_model = configuration.models.get(configuration.browser.model)
    metadata_count = len(metadata_source_providers(configuration))
    acquisition_count = len(acquisition_source_providers(configuration))
    cloak_version = getattr(cloak, "version", None)
    cloak_presence = getattr(cloak, "presence", "missing")
    cloak_verified = bool(getattr(cloak, "verified", False))
    profile = browser.profile
    profile_identity = profile.selected or "not selected"
    profile_ready = profile.presence is BrowserProfilePresence.CONFIGURED
    browser_runtime_ready = cloak_verified and profile_ready
    agent_ready = runtime.agents.browser_locally_ready
    parser_ready = runtime.parsing.configuration_complete and (
        not runtime.parsing.bearer_token_required
        or (
            runtime.parsing.bearer_token_configured is True
            and runtime.parsing.credential_origin_matches is True
        )
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
            "MinerU 3.4.4 · protocol 2 · vlm-engine"
            if configuration.parsing.base_url is not None
            else "not configured",
            "Ready" if parser_ready else "Incomplete",
        ),
        "analyze": (
            "not selected"
            if analysis_model is None
            else f"{analysis_model.reference} · reasoning {analysis_model.reasoning.value}",
            "Ready" if runtime.agents.analysis_reference_locally_ready else "Incomplete",
        ),
        "browser": (
            f"{'enabled' if configuration.browser.enabled else 'off'} · "
            f"{'no Model' if browser_model is None else browser_model.reference} · "
            f"Profile {profile_identity} · {cloak_presence} "
            f"{cloak_version or 'not installed'}",
            (
                "Ready"
                if configuration.browser.enabled and agent_ready and browser_runtime_ready
                else "Off"
                if not configuration.browser.enabled
                else "Incomplete"
            ),
        ),
    }


def _configuration_area_options(
    rows: Mapping[str, tuple[str, str]] | None,
    *,
    theme: ConfigTheme,
) -> tuple[ConfigOption[str], ...]:
    """Build the home navigation with status visible on every selectable row."""

    fallback = {
        "models": "Configure Providers, Models, reasoning and image capability",
        "search": "Choose metadata Sources and the per-Source scan limit",
        "download": "Choose named PDF acquisition Sources",
        "parse": "Configure the MinerU parser service",
        "analyze": "Choose the Model used for Markdown analysis",
        "browser": "Configure the generic Browser Agent, Profile and Runtime",
    }

    def description(area: str) -> str:
        if rows is None:
            return fallback[area]
        detail, state = rows[area]
        segments = detail.split(" · ")
        if segments[0].casefold() == state.casefold():
            detail = " · ".join(segments[1:])
        return state if not detail else f"{state} · {detail}"

    return (
        option("models", "Models", description=description("models")),
        option("search", "Search", description=description("search")),
        option("download", "Download", description=description("download")),
        option("parse", "Parse", description=description("parse")),
        option("analyze", "Analyze", description=description("analyze")),
        option("browser", "Browser", description=description("browser")),
        option(
            "status",
            "Status",
            kind=ConfigActionKind.INSPECT,
            description="View local readiness · no external requests",
        ),
        option(
            "theme",
            "Theme",
            description=f"{theme.value.title()} palette · local appearance only",
        ),
        option(
            "quit",
            "Quit",
            kind=ConfigActionKind.NAVIGATE,
            description="Close the configuration center",
        ),
    )


def _plain_area_menu(options: Sequence[ConfigOption[str]]) -> str:
    shortcuts = {
        "models": "M",
        "search": "S",
        "download": "D",
        "parse": "P",
        "analyze": "A",
        "browser": "B",
        "status": "I",
        "theme": "T",
        "quit": "Q",
    }
    left = tuple(f"{item.marker} {shortcuts[item.value]}. {item.label}" for item in options)
    width = max(len(value) for value in left)
    rows = tuple(
        f"  {value.ljust(width)}   {item.description}"
        for value, item in zip(left, options, strict=True)
    )
    return (
        "SciRetriever configuration center\n"
        "Local status only · no network requests\n\n" + "\n".join(rows)
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
        rows: dict[str, tuple[str, str]] | None = None
        try:
            configuration, runtime = _configuration_summary()
            browser = browser_access_status(configuration)
            cloak = CloakRuntimeManager().status()
            rows = configuration_home_rows(configuration, runtime, browser, cloak)
        except ConfigurationError:
            raise
        except (OSError, TypeError, ValueError):
            pass
        console.message(
            _plain_area_menu(_configuration_area_options(rows, theme=console.palette.name))
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
        rows = configuration_home_rows(configuration, runtime, browser, cloak)
        selected = TerminalChoice[str](
            message="Open a configuration area",
            options=_configuration_area_options(rows, theme=console.palette.name),
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
    try:
        return _run_rich(theme) if interactive_terminal() else _run_plain(theme)
    except ConfigurationCenterQuit:
        return 0


__all__ = ("configuration_home_rows", "run_config_manager")
