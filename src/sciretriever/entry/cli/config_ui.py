"""Rich and prompt-toolkit presentation helpers for the configuration CLI."""

from __future__ import annotations

import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from typing import Generic, Mapping, Sequence, TextIO, TypeVar, cast

from prompt_toolkit.application.current import create_app_session
from prompt_toolkit.input import Input, create_input
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.output import Output, create_output
from prompt_toolkit.shortcuts.choice_input import ChoiceInput
from prompt_toolkit.styles import Style
from rich import box
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

_T = TypeVar("_T")


class ConfigTheme(str, Enum):
    AUTO = "auto"
    DARK = "dark"
    LIGHT = "light"
    MONO = "mono"


@dataclass(frozen=True, slots=True)
class ThemePalette:
    name: ConfigTheme
    accent: str
    heading: str
    ready: str
    warning: str
    muted: str
    border: str
    no_color: bool


_PALETTES = {
    ConfigTheme.DARK: ThemePalette(
        ConfigTheme.DARK,
        "bright_cyan",
        "bold white",
        "bright_green",
        "bright_yellow",
        "grey66",
        "cyan",
        False,
    ),
    ConfigTheme.LIGHT: ThemePalette(
        ConfigTheme.LIGHT,
        "blue",
        "bold black",
        "green4",
        "dark_orange3",
        "grey42",
        "blue",
        False,
    ),
    ConfigTheme.MONO: ThemePalette(
        ConfigTheme.MONO,
        "none",
        "bold",
        "none",
        "none",
        "dim",
        "none",
        True,
    ),
}


def resolve_theme(
    value: str | ConfigTheme, *, environment: dict[str, str] | None = None
) -> ConfigTheme:
    try:
        requested = value if isinstance(value, ConfigTheme) else ConfigTheme(value)
    except (TypeError, ValueError):
        raise ValueError("theme is unsupported") from None
    values = os.environ if environment is None else environment
    if "NO_COLOR" in values:
        return ConfigTheme.MONO
    if requested is not ConfigTheme.AUTO:
        return requested
    color_term = values.get("COLORFGBG", "")
    if color_term:
        try:
            background = int(color_term.split(";")[-1])
        except ValueError:
            background = 0
        if background >= 7:
            return ConfigTheme.LIGHT
    return ConfigTheme.DARK


def interactive_terminal() -> bool:
    return bool(
        getattr(sys.stdin, "isatty", lambda: False)()
        and getattr(sys.stderr, "isatty", lambda: False)()
    )


class ConfigConsole:
    """One stderr-only Rich console and its resolved accessible palette."""

    def __init__(
        self,
        theme: str | ConfigTheme = ConfigTheme.AUTO,
        *,
        width: int | None = None,
    ) -> None:
        resolved = resolve_theme(theme)
        self.palette = _PALETTES[resolved]
        self.console = Console(
            file=sys.stderr,
            stderr=True,
            force_terminal=interactive_terminal() and not self.palette.no_color,
            no_color=self.palette.no_color,
            safe_box=True,
            highlight=False,
            emoji=False,
            soft_wrap=False,
            width=width,
        )

    def header(self, *, config_path: str, credentials_path: str) -> None:
        body = Table.grid(padding=(0, 1))
        body.add_column(style=self.palette.muted, no_wrap=True)
        body.add_column(overflow="fold")
        body.add_row("Project", config_path)
        body.add_row("Secrets", credentials_path)
        body.add_row("Theme", self.palette.name.value.title())
        self.console.print(
            Panel(
                body,
                title="SciRetriever · Configuration",
                border_style=self.palette.border,
                box=box.ROUNDED,
                padding=(0, 1),
            )
        )

    def home(
        self,
        *,
        llm_state: str,
        llm_detail: str,
        mineru_state: str,
        mineru_detail: str,
        providers: Sequence[tuple[str, str, str]],
        access_state: str = "Unavailable",
        access_detail: str = "Authorized APIs and controlled Browser",
        agent_provider: tuple[str, str] | None = None,
        analysis_role: tuple[str, str] | None = None,
        browser_role: tuple[str, str] | None = None,
        cloak_binary: tuple[str, str] | None = None,
        selected_profile: tuple[str, str] | None = None,
        browser_enabled: tuple[str, str] | None = None,
    ) -> None:
        core = self._home_table()
        core.add_row("[L]", "LLM Analysis", llm_detail, _state_text(llm_state, self.palette))
        core.add_row("[M]", "MinerU Parser", mineru_detail, _state_text(mineru_state, self.palette))
        capability_rows = (
            ("[P]", "Agent provider", agent_provider),
            ("[A]", "Analysis role", analysis_role),
            ("[B]", "Browser role", browser_role),
            ("[C]", "Cloak binary", cloak_binary),
            ("[R]", "Selected Profile", selected_profile),
            ("[E]", "Browser enabled", browser_enabled),
        )
        capability_table = self._home_table()
        for shortcut, label, row in capability_rows:
            if row is None:
                continue
            detail, state = row
            capability_table.add_row(
                shortcut,
                label,
                detail,
                _state_text(state, self.palette),
            )
        provider_table = self._home_table()
        provider_table.add_row(
            "[A]",
            "Provider Access",
            access_detail,
            _state_text(access_state, self.palette),
        )
        for index, (name, purpose, state) in enumerate(providers, start=1):
            provider_table.add_row(str(index), name, purpose, _state_text(state, self.palette))
        self.console.print(Text("CORE SERVICES", style=self.palette.heading))
        self.console.print(core)
        if capability_table.row_count:
            self.console.print(Text("AGENTS & BROWSER", style=self.palette.heading))
            self.console.print(capability_table)
        self.console.print(Text("LITERATURE PROVIDERS", style=self.palette.heading))
        self.console.print(provider_table)
        self.console.print(
            "[dim]↑↓ Move · Enter Open · A Access · L LLM · M MinerU · T Theme · Q Quit[/dim]"
            if not self.palette.no_color
            else "Move: arrows  Open: Enter  Shortcuts: A/L/M/T/Q"
        )

    def access(
        self,
        *,
        api_routes: Sequence[tuple[str, str, str]],
        browser_state: str,
        browser_detail: str,
        browser_action: str,
    ) -> None:
        table = Table(
            title="Literature Provider access",
            box=box.ROUNDED,
            border_style=self.palette.border,
            expand=True,
        )
        table.add_column("Route", style=self.palette.accent, no_wrap=True)
        table.add_column("Local readiness", no_wrap=True)
        table.add_column("What this means", overflow="fold")
        table.add_column("Next action", overflow="fold")
        for name, state, action in api_routes:
            table.add_row(
                f"API · {name}",
                _state_text(state, self.palette),
                "Official authorized primary-PDF API; separate from headed Browser access.",
                action,
            )
        table.add_row(
            "Controlled Browser",
            _state_text(browser_state, self.palette),
            browser_detail,
            browser_action,
        )
        self.console.print(table)
        self.console.print(
            Text(
                "Controlled Browser uses one headed fixed-profile CloakBrowser process and "
                "context. Publisher lanes share its history, settings and site state; the "
                "same Publisher remains serialized, and entitlement is checked per article.",
                style=self.palette.muted,
            )
        )

    def _home_table(self) -> Table:
        table = Table(box=None, pad_edge=False, expand=True, show_header=False)
        table.add_column(width=5, style=self.palette.accent)
        table.add_column(ratio=2)
        table.add_column(ratio=3, style=self.palette.muted)
        table.add_column(width=16, justify="right")
        return table

    def section(self, title: str, subtitle: str | None = None) -> None:
        text = Text(title, style=self.palette.heading)
        if subtitle:
            text.append(f"\n{subtitle}", style=self.palette.muted)
        self.console.print(Panel(text, border_style=self.palette.border, box=box.ROUNDED))

    def message(self, value: str, *, kind: str = "normal") -> None:
        style = {
            "success": self.palette.ready,
            "warning": self.palette.warning,
            "muted": self.palette.muted,
        }.get(kind)
        self.console.print(value, style=style)

    def changes(self, changes: Sequence[tuple[str, object, object]]) -> None:
        table = Table(
            title="Proposed ordinary configuration changes",
            box=box.SIMPLE,
            border_style=self.palette.border,
        )
        table.add_column("Field", style=self.palette.accent)
        table.add_column("Before")
        table.add_column("After")
        for field, before, after in changes:
            table.add_row(field, _plain_value(before), _plain_value(after))
        self.console.print(table)


class ConfigStatusPresenter:
    """Compact stdout-only Rich presenter for local configuration status."""

    def __init__(
        self,
        theme: str | ConfigTheme = ConfigTheme.AUTO,
        *,
        file: TextIO | None = None,
        force_terminal: bool | None = None,
        width: int | None = None,
    ) -> None:
        resolved = resolve_theme(theme)
        self.palette = _PALETTES[resolved]
        stream = sys.stdout if file is None else file
        terminal = bool(getattr(stream, "isatty", lambda: False)())
        self.console = Console(
            file=stream,
            force_terminal=(terminal if force_terminal is None else force_terminal)
            and not self.palette.no_color,
            no_color=self.palette.no_color,
            safe_box=True,
            highlight=False,
            emoji=False,
            soft_wrap=False,
            width=width,
        )

    def status(self, payload: Mapping[str, object]) -> None:
        self.console.print(
            Panel(
                Text(
                    "Local configuration only · no network requests · credentials are shown "
                    "by presence, never by value",
                    style=self.palette.muted,
                ),
                title="SciRetriever · Configuration Status",
                border_style=self.palette.border,
                box=box.ROUNDED,
            )
        )
        self.console.print(self._core_services(payload))
        self.console.print(self._metadata_apis(payload))
        self.console.print(self._acquisition_apis(payload))
        self.console.print(self._pdf_routes(payload))
        self.console.print(self._controlled_browser(payload))
        self.console.print(self._local_runtime(payload))

    def probes(self, payload: Mapping[str, object]) -> None:
        table = Table(
            title="Configuration probes",
            box=box.ROUNDED,
            border_style=self.palette.border,
            expand=True,
        )
        table.add_column("Target", style=self.palette.accent, no_wrap=True)
        table.add_column("Outcome", no_wrap=True)
        table.add_column("What was checked", overflow="fold")
        table.add_column("Failure", overflow="fold")
        for target, outcome, detail, failure in _probe_rows(payload):
            table.add_row(
                target,
                _state_text(outcome, self.palette),
                detail,
                failure or "—",
            )
        self.console.print(table)
        self.console.print(
            Text(
                "LLM: minimal strict schema request; may consume quota; no Literature content. "
                "MinerU: GET health only; no PDF upload. Browser: one explicitly selected "
                "approved minimal target; article entitlement remains not proven. Results are "
                "not persisted.",
                style=self.palette.muted,
            )
        )

    def _core_services(self, payload: Mapping[str, object]) -> Table:
        parsing = _mapping(payload["parsing"])
        analysis = _mapping(payload.get("agents", payload.get("analysis", {})))
        parser_secret = _mapping(parsing["bearer_token"])
        analysis_secret = _mapping(analysis["api_key"])
        implementation = _mapping(parsing["implementation"])
        table = Table(
            title="Core services",
            box=box.ROUNDED,
            border_style=self.palette.border,
            expand=True,
        )
        table.add_column("Service / readiness", width=20, no_wrap=True)
        table.add_column("Configured values", overflow="fold")
        llm_identity = (
            " · ".join(
                value
                for value in (
                    _shown(analysis.get("provider")),
                    _shown(analysis.get("model", analysis.get("analysis_model"))),
                    _token_count(analysis.get("context_window_tokens")),
                )
                if value != "not set"
            )
            or "not set"
        )
        table.add_row(
            _layer_state(
                "LLM Analysis",
                "ready" if analysis.get("reference_locally_ready") is True else "needs setup",
                self.palette,
            ),
            f"protocol: {_shown(analysis.get('protocol'))}\n"
            f"endpoint: {_shown(analysis.get('base_url'))}\n"
            f"model: {llm_identity}\n"
            f"credential: {_core_credential_state(analysis_secret)}",
        )
        analysis_role = _mapping(analysis.get("analysis_role"))
        browser_role = _mapping(analysis.get("browser_role"))
        table.add_row(
            _layer_state(
                "Analysis role",
                "ready" if analysis_role.get("locally_ready") is True else "needs setup",
                self.palette,
            ),
            "model: {} · context: {} · structured text: {}".format(
                _shown(analysis_role.get("model")),
                _token_count(analysis_role.get("context_window_tokens")),
                "yes" if analysis_role.get("structured_output") is True else "no",
            ),
        )
        browser_role_ready = browser_role.get("locally_ready") is True
        table.add_row(
            _layer_state(
                "Browser role",
                "ready" if browser_role_ready else "not configured",
                self.palette,
            ),
            "model: {} · context: {} · image input: {} · tool decision: {}".format(
                _shown(browser_role.get("model")),
                _token_count(browser_role.get("context_window_tokens")),
                "yes" if browser_role.get("image_input") is True else "no",
                "yes" if browser_role.get("tool_decision") is True else "no",
            ),
        )
        parser_identity = (
            f"MinerU {implementation.get('release')} · protocol "
            f"{implementation.get('api_protocol')} · {implementation.get('profile')}\n"
            f"archive {implementation.get('archive_backend')} · parse "
            f"{implementation.get('parse_method')} · model "
            f"{_shown(parsing.get('model_identity'))}"
        )
        table.add_row(
            _layer_state(
                "MinerU Parser",
                "ready" if parsing.get("locally_ready") is True else "needs setup",
                self.palette,
            ),
            f"mode: {_shown(parsing.get('connection_mode'))}\n"
            f"endpoint: {_shown(parsing.get('base_url'))}\n"
            f"identity: {parser_identity}\n"
            f"credential: {_core_credential_state(parser_secret)}",
        )
        return table

    def _metadata_apis(self, payload: Mapping[str, object]) -> Table:
        providers = _mapping(payload["providers"])
        table = Table(
            title=f"Metadata APIs · secrets in {providers['credentials_file']}",
            box=box.ROUNDED,
            border_style=self.palette.border,
            expand=True,
        )
        table.add_column("Provider / readiness", width=18, no_wrap=True)
        table.add_column("Credential fields", overflow="fold")
        table.add_column("Next action", overflow="fold")
        metadata = _mapping_sequence(providers["metadata"])
        visible = tuple(item for item in metadata if _provider_is_relevant(item))
        if not visible:
            table.add_row("None enabled", "—", "Open sciretriever config to select a Provider.")
        for item in visible:
            table.add_row(
                _provider_identity_state(item, self.palette),
                _credential_summary(_mapping(item["credentials"])),
                _provider_next_action(item),
            )
        hidden = len(metadata) - len(visible)
        if hidden:
            table.caption = f"{hidden} additional Metadata APIs are disabled and omitted."
            table.caption_style = self.palette.muted
        return table

    def _acquisition_apis(self, payload: Mapping[str, object]) -> Table:
        providers = _mapping(payload["providers"])
        table = Table(
            title=f"Authorized primary-PDF APIs · secrets in {providers['credentials_file']}",
            box=box.ROUNDED,
            border_style=self.palette.border,
            expand=True,
        )
        table.add_column("Provider / readiness", width=18, no_wrap=True)
        table.add_column("Credential fields", overflow="fold")
        table.add_column("Next action", overflow="fold")
        for item in _mapping_sequence(providers["acquisition"]):
            authorized = _mapping(item["authorized_api"])
            if (
                authorized.get("available") is not True
                and authorized.get("unsupported") is not True
            ):
                continue
            unsupported = authorized.get("unsupported") is True
            table.add_row(
                _provider_identity_state(item, self.palette, unsupported=unsupported),
                _credential_summary(_mapping(item["credentials"])),
                str(authorized.get("detail"))
                if unsupported and authorized.get("detail")
                else _provider_next_action(item),
            )
        return table

    def _pdf_routes(self, payload: Mapping[str, object]) -> Table:
        providers = _mapping(payload["providers"])
        acquisition = _mapping_sequence(providers["acquisition"])
        public = [
            str(item["provider"])
            for item in acquisition
            if _mapping(_mapping(item["public_source"]).get("provider_service"))
        ]
        authorized = [
            str(item["provider"])
            for item in acquisition
            if _mapping(item["authorized_api"])["available"] is True
        ]
        unsupported = [
            str(item["provider"])
            for item in acquisition
            if _mapping(item["authorized_api"])["unsupported"] is True
        ]
        browser = _mapping(providers["controlled_browser"])
        table = Table(
            title="PDF acquisition routes · attempted in order",
            box=box.ROUNDED,
            border_style=self.palette.border,
            expand=True,
        )
        table.add_column("Route", style=self.palette.accent, no_wrap=True)
        table.add_column("Current support", overflow="fold")
        table.add_row(
            "1 · Public",
            "saved direct-PDF/landing hints; Provider services: " + (", ".join(public) or "none"),
        )
        detail = ", ".join(authorized) or "none"
        if unsupported:
            detail += f" · known unavailable: {', '.join(unsupported)}"
        table.add_row("2 · Authorized API", detail)
        route_count = browser.get("production_route_count", 0)
        automatic_route_count = browser.get("automatic_route_count", 0)
        route_word = "route" if route_count == 1 else "routes"
        if browser.get("automatic_acquisition_available") is True:
            browser_support = (
                f"ready · {automatic_route_count}/{route_count} production {route_word} "
                "eligible for paced article checks"
            )
        elif route_count:
            browser_support = (
                f"installed · {route_count} production {route_word} · local Browser not ready"
            )
        else:
            browser_support = "unavailable · no production routes"
        table.add_row("3 · Controlled browser", browser_support)
        return table

    def _controlled_browser(self, payload: Mapping[str, object]) -> Table:
        providers = _mapping(payload["providers"])
        browser = _mapping(providers["controlled_browser"])
        runtime = _mapping(browser["runtime"])
        profile = _mapping(browser["profile"])
        session = _mapping(browser["session"])
        probe = _mapping(browser["probe"])
        license_status = _mapping(browser.get("cloakbrowser_license"))
        routes = _mapping_sequence(browser["routes"])
        actions = _mapping_sequence(browser["action_required"])
        table = Table(
            title="Controlled Browser · local status only",
            box=box.ROUNDED,
            border_style=self.palette.border,
            expand=True,
        )
        table.add_column("Layer / state", width=20, no_wrap=True)
        table.add_column("Evidence / meaning", ratio=2, overflow="fold")
        runtime_ready = (
            runtime.get("cloak_wrapper_available") is True
            and runtime.get("playwright_api_available") is True
            and runtime.get("binary_presence") is True
            and runtime.get("binary_verified") is True
            and runtime.get("headed_display_available") is True
            and runtime.get("fixed_identity_manifest") is True
        )
        table.add_row(
            _layer_state(
                "Production runtime",
                "ready" if runtime_ready else "not ready",
                self.palette,
            ),
            "CloakBrowser wrapper={} · Playwright API={} · fixed binary={} · version={} · "
            "verified={} · headed display={} · launch={}".format(
                "present" if runtime.get("cloak_wrapper_available") is True else "missing",
                "present" if runtime.get("playwright_api_available") is True else "missing",
                "present" if runtime.get("binary_presence") is True else "missing",
                _shown(runtime.get("binary_version")),
                "yes" if runtime.get("binary_verified") is True else "no",
                "present" if runtime.get("headed_display_available") is True else "missing",
                "not assessed" if runtime.get("launch_assessed") is False else "unknown",
            ),
        )
        table.add_row(
            _layer_state(
                "Fixed identity manifest",
                "ready" if runtime.get("fixed_identity_manifest") is True else "not ready",
                self.palette,
            ),
            f"schema: {_shown(runtime.get('identity_schema'))} · profile lease: "
            f"{runtime.get('profile_lease', 'not-assessed')} · launch not assessed",
        )
        table.add_row(
            _layer_state(
                "Optional Pro key",
                "saved" if license_status.get("configured") else "not set",
                self.palette,
            ),
            str(license_status.get("status", "reserved; not used by pinned free binary")),
        )
        route_names = ", ".join(
            f"{route.get('display_name')} [{route.get('rate_limit_group')}]" for route in routes
        )
        table.add_row(
            _layer_state(
                "Production routes",
                "available" if routes else "unavailable",
                self.palette,
            ),
            route_names or "none; unsupported site rules are not executable",
        )
        automatic_route_count = browser.get("automatic_route_count", 0)
        table.add_row(
            _layer_state(
                "Automatic routes",
                "ready" if browser.get("automatic_acquisition_available") is True else "not ready",
                self.palette,
            ),
            f"{automatic_route_count}/{len(routes)} routes locally eligible · "
            "article entitlement is checked by the Publisher during each paced attempt",
        )
        table.add_row(
            _layer_state(
                "Browser switch",
                "enabled" if browser.get("enabled") is True else "disabled",
                self.palette,
            ),
            f"local cross-group concurrency cap {browser.get('local_max_concurrency')}",
        )
        table.add_row(
            _layer_state("Access mode", "fixed profile", self.palette),
            f"{browser.get('mode')} · headed CloakBrowser · current machine network exit",
        )
        selected_profile = profile.get("selected")
        profile_presence = str(profile.get("presence", "missing"))
        table.add_row(
            _layer_state(
                "Selected profile",
                profile_presence,
                self.palette,
            ),
            (str(selected_profile) if selected_profile else "not selected")
            + " · opaque identity only; no Cookie or login data is inspected",
        )
        table.add_row(
            _layer_state("Browser lifecycle", "shared", self.palette),
            "one fixed profile · one CloakBrowser process/context · Publisher lanes share "
            "history, settings and site state",
        )
        table.add_row(
            _layer_state("Publisher lanes", "paced", self.palette),
            f"different Publishers may run up to {browser.get('local_max_concurrency')} lanes; "
            "the same Publisher is strictly serial",
        )
        table.add_row(
            _layer_state("Interactive authentication", "unsupported", self.palette),
            "interactive_authentication_supported={} · status never launches the Browser · "
            "session assessment={}".format(
                "yes" if browser.get("interactive_authentication_supported") is True else "no",
                session.get("assessment", "not-assessed"),
            ),
        )
        table.add_row(
            _layer_state("Article access", "not evaluated", self.palette),
            str(browser.get("article_entitlement", "checked-per-article"))
            + " · not evaluated by status; checked only per article during actual acquisition · "
            "profile presence or login never proves a particular PDF entitlement",
        )
        supported = ", ".join(
            str(value) for value in cast(Sequence[object], probe.get("supported_access_keys", ()))
        )
        table.add_row(
            _layer_state(
                "Explicit probe",
                "available" if probe.get("available") is True else "unavailable",
                self.palette,
            ),
            (supported or "no approved target") + " · never included in --all",
        )
        policy_lines = []
        for route in routes:
            policy = _mapping(route.get("policy"))
            policy_lines.append(
                f"{route.get('access_key')}: {policy.get('evidence')} · "
                f"{policy.get('policy_revision')} · verified {policy.get('verification_date')} · "
                f"group concurrency {policy.get('max_concurrency')} · "
                f"minimum start interval {policy.get('minimum_start_interval')}s · "
                f"{policy.get('notes_reference')}"
            )
        table.add_row(
            _layer_state(
                "Policy evidence",
                "ready" if policy_lines else "unavailable",
                self.palette,
            ),
            "\n".join(policy_lines) or "none because no production Browser route is admitted",
        )
        table.add_row(
            _layer_state(
                "Next action",
                "ready" if not actions else "action required",
                self.palette,
            ),
            "\n".join(f"{action.get('code')}: {action.get('action')}" for action in actions)
            or "no local action",
        )
        return table

    def _local_runtime(self, payload: Mapping[str, object]) -> Table:
        storage = _mapping(payload["storage"])
        execution = _mapping(payload["execution"])
        library = _mapping(payload["library"])
        table = Table.grid(padding=(0, 2))
        table.add_column(style=self.palette.muted, no_wrap=True)
        table.add_column(overflow="fold")
        table.add_row(
            "Storage",
            "ready"
            if storage["configuration_complete"] is True
            else "missing: " + ", ".join(cast(Sequence[str], storage["missing_fields"])),
        )
        table.add_row(
            "Execution",
            f"concurrency {execution['max_concurrency']} · bibliography input "
            f"{library['max_input_bytes']} bytes",
        )
        return table


def _state_text(state: str, palette: ThemePalette) -> Text:
    normalized = state.casefold()
    successful = normalized in {
        "available",
        "configured",
        "enabled",
        "optional",
        "passed",
        "ready",
    }
    style = palette.ready if successful else palette.warning
    symbol = "●" if successful else "○"
    return Text(f"{symbol} {state}", style=style)


def _layer_state(label: str, state: str, palette: ThemePalette) -> Text:
    result = Text(label, style=palette.accent)
    result.append("\n")
    result.append_text(_state_text(state, palette))
    return result


def _plain_value(value: object) -> str:
    if value is None:
        return "not set"
    if isinstance(value, bool):
        return "yes" if value else "no"
    return str(value)


def _mapping(value: object | None) -> Mapping[str, object]:
    return value if isinstance(value, Mapping) else {}


def _mapping_sequence(value: object) -> tuple[Mapping[str, object], ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(item for item in value if isinstance(item, Mapping))


def _shown(value: object) -> str:
    return "not set" if value is None or value == "" else str(value)


def _token_count(value: object) -> str:
    if type(value) is not int:
        return "not set"
    return f"{value:,} token context"


def _core_credential_state(value: Mapping[str, object]) -> str:
    if value.get("required") is not True:
        return "not required"
    if value.get("configured") is not True:
        return "missing"
    if value.get("origin_matches") is not True:
        return "configured · wrong origin"
    return "configured · origin matched"


def _provider_state_text(
    item: Mapping[str, object],
    palette: ThemePalette,
    *,
    unsupported: bool = False,
) -> Text:
    readiness = (
        "unsupported"
        if unsupported
        else ("ready" if item.get("local_ready") is True else "needs setup")
    )
    result = _state_text(readiness, palette)
    enabled = "enabled" if item.get("enabled") is True else "disabled"
    policy = "verified" if item.get("access_policy_ready") is True else "needs setup"
    result.append(f"\n{enabled} · policy {policy}", style=palette.muted)
    return result


def _provider_identity_state(
    item: Mapping[str, object],
    palette: ThemePalette,
    *,
    unsupported: bool = False,
) -> Text:
    result = Text(str(item.get("provider", "provider")), style=palette.accent)
    result.append("\n")
    result.append_text(_provider_state_text(item, palette, unsupported=unsupported))
    return result


def _provider_is_relevant(item: Mapping[str, object]) -> bool:
    if item.get("enabled") is True:
        return True
    credentials = _mapping(item.get("credentials"))
    return any(
        field.get("configured") is True for field in _mapping_sequence(credentials.get("fields"))
    )


def _credential_summary(credentials: Mapping[str, object]) -> str:
    fields = _mapping_sequence(credentials.get("fields"))
    status = str(credentials.get("status", "unknown"))
    if not fields:
        return "not required" if status == "not-required" else status
    return ", ".join(
        f"{field.get('name')}="
        f"{'configured' if field.get('configured') is True else 'missing'}"
        f"{' (optional)' if field.get('required') is not True else ''}"
        for field in fields
    )


def _provider_next_action(item: Mapping[str, object]) -> str:
    if item.get("production_available") is not True:
        return "This capability is not supported."
    if item.get("enabled") is not True:
        return "Enable in config.toml if you intend to use it."
    missing = tuple(
        str(value) for value in cast(Sequence[object], item.get("missing_ordinary_fields", ()))
    )
    if missing:
        return "Configure ordinary fields: " + ", ".join(missing) + "."
    credentials = _mapping(item.get("credentials"))
    if credentials.get("status") in {"missing", "partial"}:
        required = [
            str(field.get("name"))
            for field in _mapping_sequence(credentials.get("fields"))
            if field.get("required") is True and field.get("configured") is not True
        ]
        return "Configure credential fields: " + (", ".join(required) or "required fields") + "."
    if item.get("access_policy_ready") is not True:
        return "Complete the Provider access-policy settings."
    if item.get("local_ready") is True:
        return "No local action."
    return f"Resolve local readiness: {item.get('failure_code') or 'not-ready'}."


def _provider_probe_rows(payload: Mapping[str, object]) -> list[tuple[str, str, str, str]]:
    rows: list[tuple[str, str, str, str]] = []
    for item in _mapping_sequence(payload.get("results")):
        target = f"{item.get('provider', 'provider')} · {item.get('capability', 'service')}"
        outcome = str(item.get("outcome", "failed"))
        detail = "minimal read-only Provider request"
        rows.append((target, outcome, detail, str(item.get("failure_code") or "")))
    return rows


def _core_probe_row(payload: Mapping[str, object]) -> tuple[str, str, str, str]:
    service = str(payload.get("service", "service"))
    is_agents = service in {"agents", "llm"}
    details = _mapping(payload.get("details"))
    role = details.get("role")
    if is_agents and role == "browser-agent":
        detail = (
            "one synthetic-image + closed-tool request; no Literature/PDF/page content; "
            "may consume quota"
        )
        target = "Browser Agent"
    elif is_agents:
        detail = "minimal strict schema request; no Literature content"
        target = "LLM/Agents"
    else:
        detail = "health/release/protocol/profile only; no PDF upload"
        target = service.title()
    return (
        target,
        str(payload.get("outcome", "failed")),
        detail,
        str(payload.get("failure_code") or ""),
    )


def _browser_probe_row(payload: Mapping[str, object]) -> tuple[str, str, str, str]:
    launched = payload.get("browser_launched")
    target_reached = payload.get("minimal_target_reached")
    if launched is True and target_reached is True:
        runtime_detail = "runtime target reached"
    elif launched is True and target_reached is False:
        runtime_detail = "runtime launched; target not reached"
    elif launched is False:
        runtime_detail = "runtime not launched"
    else:
        runtime_detail = "runtime not assessed"
    return (
        f"Browser · {payload.get('access_key', 'publisher')}",
        str(payload.get("outcome", "failed")),
        f"{runtime_detail}; institution-IP/article entitlement not assessed",
        str(payload.get("failure_code") or ""),
    )


def _probe_rows(payload: Mapping[str, object]) -> tuple[tuple[str, str, str, str], ...]:
    if "providers" in payload:
        rows = _provider_probe_rows(_mapping(payload["providers"]))
        rows.append(_core_probe_row(_mapping(payload.get("llm", payload.get("agents")))))
        browser_agent = payload.get("browser-agent", payload.get("browser_agent"))
        if isinstance(browser_agent, Mapping):
            rows.append(_core_probe_row(browser_agent))
        rows.append(_core_probe_row(_mapping(payload.get("mineru"))))
        return tuple(rows)
    if "results" in payload:
        return tuple(_provider_probe_rows(payload))
    if "access_key" in payload:
        return (_browser_probe_row(payload),)
    return (_core_probe_row(payload),)


class TerminalChoice(Generic[_T]):
    """A prompt-toolkit choice wired explicitly to stdin and stderr."""

    def __init__(
        self,
        *,
        message: str,
        options: Sequence[tuple[_T, str]],
        default: _T | None = None,
        theme: str | ConfigTheme = ConfigTheme.AUTO,
        shortcuts: dict[str, _T] | None = None,
        input_factory: Callable[[], Input] | None = None,
        output_factory: Callable[[], Output] | None = None,
    ) -> None:
        self.message = message
        self.options = options
        self.default = default
        self.theme = resolve_theme(theme)
        self.shortcuts = dict(shortcuts or {})
        self._input_factory = input_factory
        self._output_factory = output_factory

    def prompt(self) -> _T:
        bindings = KeyBindings()
        for key, value in self.shortcuts.items():
            bindings.add(key)(self._shortcut(value))
        chooser = ChoiceInput[_T](
            message=self.message,
            options=self.options,
            default=self.default,
            symbol="›",
            bottom_toolbar="↑↓ move · Enter open · Ctrl+C cancel",
            show_frame=False,
            show_numbers=False,
            style=_prompt_style(self.theme),
            key_bindings=bindings,
        )
        input_stream = (
            create_input(stdin=sys.stdin, always_prefer_tty=True)
            if self._input_factory is None
            else self._input_factory()
        )
        output_stream = (
            create_output(stdout=sys.stderr, always_prefer_tty=True)
            if self._output_factory is None
            else self._output_factory()
        )
        try:
            with create_app_session(input=input_stream, output=output_stream):
                return chooser.prompt()
        finally:
            input_stream.close()

    @staticmethod
    def _shortcut(value: _T):  # noqa: ANN205
        def handler(event):  # noqa: ANN001, ANN202
            event.app.exit(result=value)

        return handler


def _prompt_style(theme: ConfigTheme) -> Style:
    if theme is ConfigTheme.MONO:
        return Style.from_dict({"selected-option": "bold", "bottom-toolbar": "reverse"})
    if theme is ConfigTheme.LIGHT:
        return Style.from_dict(
            {
                "selected-option": "bold fg:#005faf",
                "input-selection": "fg:#1c1c1c",
                "bottom-toolbar": "fg:#4e4e4e bg:#eeeeee",
            }
        )
    return Style.from_dict(
        {
            "selected-option": "bold fg:#5fffff",
            "input-selection": "fg:#eeeeee",
            "bottom-toolbar": "fg:#bcbcbc bg:#262626",
        }
    )


__all__ = (
    "ConfigConsole",
    "ConfigStatusPresenter",
    "ConfigTheme",
    "TerminalChoice",
    "interactive_terminal",
    "resolve_theme",
)
