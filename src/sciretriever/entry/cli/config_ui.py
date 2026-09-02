"""Rich and prompt-toolkit presentation helpers for the configuration CLI."""

from __future__ import annotations

import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from typing import Generic, Mapping, Sequence, TextIO, TypeVar, cast

from prompt_toolkit.application.current import create_app_session
from prompt_toolkit.formatted_text import FormattedText
from prompt_toolkit.input import Input, create_input
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.output import Output, create_output
from prompt_toolkit.shortcuts.choice_input import ChoiceInput
from prompt_toolkit.shortcuts.prompt import prompt as prompt_text
from prompt_toolkit.styles import Style
from prompt_toolkit.utils import get_cwidth
from rich import box
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from sciretriever.entry.cli.config_probe_diagnostics import (
    diagnosed_probe_payload,
    diagnosis_lines,
)

_T = TypeVar("_T")
_NO_BACK = object()
_SEARCH_CHOICE = object()


def _truncate_display(value: str, width: int) -> str:
    if get_cwidth(value) <= width:
        return value
    if width <= 1:
        return ""
    available = width - 1
    result: list[str] = []
    consumed = 0
    for character in value:
        character_width = get_cwidth(character)
        if consumed + character_width > available:
            break
        result.append(character)
        consumed += character_width
    return "".join(result).rstrip() + "…"


class ConfigTheme(str, Enum):
    AUTO = "auto"
    DARK = "dark"
    LIGHT = "light"
    MONO = "mono"


class ConfigActionKind(str, Enum):
    """Stable visual semantics shared by every configuration menu."""

    CONFIGURE = "configure"
    INSPECT = "inspect"
    TEST = "test"
    DANGER = "danger"
    NAVIGATE = "navigate"


@dataclass(frozen=True, slots=True)
class ConfigOption(Generic[_T]):
    """One single-word menu option with an explicit interaction meaning."""

    value: _T
    label: str
    kind: ConfigActionKind = ConfigActionKind.CONFIGURE
    description: str = ""

    def __post_init__(self) -> None:
        if not self.label or any(character.isspace() for character in self.label):
            raise ValueError("configuration option label must be one word")
        if type(self.description) is not str:
            raise TypeError("configuration option description must be text")
        if self.description != self.description.strip() or any(
            character in self.description for character in "\r\n"
        ):
            raise ValueError("configuration option description must be one trimmed line")

    @property
    def marker(self) -> str:
        if self.kind is ConfigActionKind.CONFIGURE:
            return "◆"
        if self.kind is ConfigActionKind.INSPECT:
            return "◇"
        if self.kind is ConfigActionKind.TEST:
            return "▶"
        if self.kind is ConfigActionKind.DANGER:
            return "!"
        return "×" if self.label.casefold() == "quit" else "←"

    @property
    def plain_label(self) -> str:
        return f"{self.marker} {self.label}"

    def plain_row(self, *, label_width: int) -> str:
        """Return one aligned row for the deterministic non-TTY menu."""

        if not self.description:
            return self.plain_label
        label_display_width = get_cwidth(self.plain_label)
        padding = " " * (max(label_width, label_display_width) - label_display_width + 3)
        return f"{self.plain_label}{padding}{self.description}"

    def prompt_label(
        self,
        *,
        label_width: int,
        description_width: int | None = None,
    ) -> FormattedText:
        fragments = [(f"class:action.{self.kind.value}", self.plain_label)]
        if not self.description or description_width == 0:
            return FormattedText(fragments)
        description = (
            self.description
            if description_width is None
            else _truncate_display(self.description, description_width)
        )
        if not description:
            return FormattedText(fragments)
        label_display_width = get_cwidth(self.plain_label)
        padding = " " * (max(label_width, label_display_width) - label_display_width + 3)
        fragments.append(("class:option.description", f"{padding}{description}"))
        return FormattedText(fragments)


@dataclass(frozen=True, slots=True)
class ThemePalette:
    name: ConfigTheme
    accent: str
    heading: str
    ready: str
    warning: str
    muted: str
    border: str
    configure: str
    inspect: str
    test: str
    danger: str
    navigate: str
    no_color: bool


_PALETTES = {
    ConfigTheme.DARK: ThemePalette(
        name=ConfigTheme.DARK,
        accent="bright_cyan",
        heading="bold white",
        ready="bright_green",
        warning="bright_yellow",
        muted="grey66",
        border="cyan",
        configure="bright_cyan",
        inspect="bright_magenta",
        test="bright_yellow",
        danger="bright_red",
        navigate="grey66",
        no_color=False,
    ),
    ConfigTheme.LIGHT: ThemePalette(
        name=ConfigTheme.LIGHT,
        accent="blue",
        heading="bold black",
        ready="green4",
        warning="dark_orange3",
        muted="grey42",
        border="blue",
        configure="blue",
        inspect="magenta3",
        test="dark_orange3",
        danger="red3",
        navigate="grey42",
        no_color=False,
    ),
    ConfigTheme.MONO: ThemePalette(
        name=ConfigTheme.MONO,
        accent="bold",
        heading="bold",
        ready="none",
        warning="none",
        muted="dim",
        border="none",
        configure="bold",
        inspect="underline",
        test="bold",
        danger="bold",
        navigate="dim",
        no_color=True,
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
        body.add_row("Config", config_path)
        body.add_row("Secrets", credentials_path)
        self.console.print(
            Panel(
                body,
                title="SciRetriever · Configuration",
                subtitle=Text("LOCAL · NO NETWORK REQUESTS", style=self.palette.muted),
                border_style=self.palette.border,
                box=box.ROUNDED,
                padding=(0, 1),
            )
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

    def section(self, title: str, subtitle: str | None = None) -> None:
        text = Text(title, style=self.palette.heading)
        if subtitle:
            text.append(f"\n{subtitle}", style=self.palette.muted)
        self.console.print(Panel(text, border_style=self.palette.border, box=box.ROUNDED))

    def page(
        self,
        title: str,
        description: str,
        *,
        facts: Sequence[tuple[str, object]] = (),
        notes: Sequence[str] = (),
    ) -> None:
        """Render a self-explanatory configuration page before its actions."""

        body = Table.grid(expand=True, padding=(0, 1))
        body.add_column(overflow="fold")
        body.add_row(Text(description))
        if facts:
            fact_table = Table.grid(expand=True, padding=(0, 1))
            fact_table.add_column(style=self.palette.muted, no_wrap=True)
            fact_table.add_column(overflow="fold")
            for name, value in facts:
                fact_table.add_row(name, _plain_value(value))
            body.add_row(Text())
            body.add_row(fact_table)
        for note in notes:
            body.add_row(Text(f"! {note}", style=self.palette.warning))
        self.console.print(
            Panel(
                body,
                title=Text(title, style=self.palette.heading),
                subtitle=Text("LOCAL CONFIGURATION", style=self.palette.muted),
                border_style=self.palette.border,
                box=box.ROUNDED,
                padding=(0, 1),
            )
        )

    def setup_step(self, position: int, total: int, title: str, detail: str) -> None:
        """Render one compact, consistent step marker for guided setup."""

        marker = Text(f" {position:02d}/{total:02d} ", style=f"reverse {self.palette.accent}")
        marker.append(f"  {title}", style=self.palette.heading)
        marker.append(f"\n         {detail}", style=self.palette.muted)
        self.console.print(marker)

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
        payload = diagnosed_probe_payload(payload)
        table = Table(
            title="Configuration test",
            box=box.ROUNDED,
            border_style=self.palette.border,
            expand=True,
        )
        table.add_column("Test", style=self.palette.accent, no_wrap=True)
        table.add_column("Request", overflow="fold")
        table.add_column("Result", overflow="fold")
        for target, outcome, request, result in _probe_rows(payload):
            table.add_row(
                target,
                request,
                Text.assemble(
                    _state_text(outcome.title(), self.palette),
                    "\n",
                    result,
                ),
            )
        self.console.print(table)

    def _core_services(self, payload: Mapping[str, object]) -> Table:
        parsing = _mapping(payload["parsing"])
        models = _mapping(payload.get("models"))
        analyze = _mapping(payload.get("analyze"))
        download = _mapping(payload.get("download"))
        parser_secret = _mapping(parsing["bearer_token"])
        implementation = _mapping(parsing["implementation"])
        table = Table(
            title="Models, Analyze, Download and Parse",
            box=box.ROUNDED,
            border_style=self.palette.border,
            expand=True,
        )
        table.add_column("Owner / readiness", width=20, no_wrap=True)
        table.add_column("Configured values", overflow="fold")

        model_providers = _mapping_sequence(models.get("providers", ()))
        if not model_providers:
            table.add_row(
                _layer_state("Models · Providers", "needs setup", self.palette),
                "none",
            )
        for provider in model_providers:
            key = _mapping(provider.get("key"))
            table.add_row(
                _layer_state(
                    f"Provider · {provider.get('name')}",
                    (
                        "ready"
                        if key.get("required") is not True
                        or (key.get("configured") is True and key.get("origin_matches") is True)
                        else "needs key"
                    ),
                    self.palette,
                ),
                f"api: {_shown(provider.get('api'))}\n"
                f"endpoint: {_shown(provider.get('base_url'))}\n"
                f"credential: {_core_credential_state(key)}",
            )

        configured_models = _mapping_sequence(models.get("models", ()))
        if not configured_models:
            table.add_row(
                _layer_state("Models", "needs setup", self.palette),
                "none",
            )
        for model in configured_models:
            table.add_row(
                _layer_state(f"Model · {model.get('reference')}", "configured", self.palette),
                f"provider: {_shown(model.get('provider'))}\n"
                f"model: {_shown(model.get('model'))}\n"
                f"reasoning: {_shown(model.get('reasoning'))} · "
                f"image: {'yes' if model.get('image') is True else 'no'} · "
                f"stream: {'on' if model.get('stream') is not False else 'off'}",
            )

        analyze_model = _mapping(analyze.get("selected_model"))
        table.add_row(
            _layer_state(
                "Analyze",
                "ready" if analyze.get("reference_locally_ready") is True else "needs setup",
                self.palette,
            ),
            f"model: {_shown(analyze.get('model'))}\n"
            f"remote: {_shown(analyze_model.get('model'))} · "
            f"reasoning {_shown(analyze_model.get('reasoning'))}\n"
            "Analyze selects one configured Model",
        )

        download_model = _mapping(download.get("selected_model"))
        table.add_row(
            _layer_state(
                "Download · Model",
                "ready" if download.get("model_locally_ready") is True else "optional",
                self.palette,
            ),
            f"model: {_shown(download.get('model'))}\n"
            f"remote: {_shown(download_model.get('model'))} · "
            f"reasoning {_shown(download_model.get('reasoning'))}\n"
            f"controller: {_shown(download.get('controller'))}",
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
                "Parse",
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
            title=(
                "Metadata APIs · {} · {} raw items / Source · secrets in {}".format(
                    providers.get("metadata_mode", "auto"),
                    _shown(providers.get("metadata_limit")),
                    providers["credentials_file"],
                )
            ),
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
            title=(
                "Authorized primary-PDF APIs · {} · secrets in {}".format(
                    providers.get("acquisition_mode", "auto"),
                    providers["credentials_file"],
                )
            ),
            box=box.ROUNDED,
            border_style=self.palette.border,
            expand=True,
        )
        table.add_column("Provider / readiness", width=18, no_wrap=True)
        table.add_column("Credential fields", overflow="fold")
        table.add_column("Next action", overflow="fold")
        visible = 0
        for item in _mapping_sequence(providers["acquisition"]):
            if item.get("enabled") is not True:
                continue
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
            visible += 1
        if not visible:
            table.add_row("None enabled", "—", "No authorized PDF API is enabled.")
        return table

    def _pdf_routes(self, payload: Mapping[str, object]) -> Table:
        providers = _mapping(payload["providers"])
        acquisition = _mapping_sequence(providers["acquisition"])
        public = [
            str(item["provider"])
            for item in acquisition
            if item.get("enabled") is True
            and _mapping(_mapping(item["public_source"]).get("provider_service"))
        ]
        authorized = [
            str(item["provider"])
            for item in acquisition
            if item.get("enabled") is True and _mapping(item["authorized_api"])["available"] is True
        ]
        unsupported = [
            str(item["provider"])
            for item in acquisition
            if item.get("enabled") is True
            and _mapping(item["authorized_api"])["unsupported"] is True
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
        controller = str(browser.get("controller", "rules"))
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
        table.add_row("3 · Controlled browser", f"{browser_support} · controller {controller}")
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
        controller = str(browser.get("controller", "rules"))
        controller_ready = browser.get("controller_ready") is True
        table.add_row(
            _layer_state(
                "Browser controller",
                "ready" if controller_ready else "needs setup",
                self.palette,
            ),
            f"{controller} · frozen before each job · Rules and Agent are mutually exclusive · "
            + (
                "no Agent role is required"
                if browser.get("controller_required_role") is None
                else "requires the ready Browser model role"
            ),
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


def _source_probe_rows(payload: Mapping[str, object]) -> list[tuple[str, str, str, str]]:
    rows: list[tuple[str, str, str, str]] = []
    for item in _mapping_sequence(payload.get("results")):
        capability = str(item.get("capability", "metadata"))
        owner = "Download" if capability == "acquisition" else "Search"
        target = f"{owner} · {item.get('provider', 'Source')}"
        outcome = str(item.get("outcome", "failed"))
        request, reason, action = diagnosis_lines(item)
        rows.append((target, outcome, request, _diagnosis_result(reason, action)))
    return rows


def _agent_probe_target(owner: str, details: Mapping[str, object]) -> str:
    """Name the wire Model separately from its local Provider reference."""

    provider = details.get("provider")
    model = details.get("model")
    reference = details.get("reference") or details.get("model_reference")
    if type(reference) is str and "/" in reference:
        reference_provider, reference_model = reference.split("/", 1)
        if type(provider) is not str or not provider:
            provider = reference_provider
        if type(model) is not str or not model:
            model = reference_model
    model_text = model if type(model) is str and model else "not selected"
    target = f"{owner} · {model_text}"
    if type(provider) is str and provider:
        target += f"\nProvider · {provider}"
    return target


def _core_probe_row(payload: Mapping[str, object]) -> tuple[str, str, str, str]:
    service = str(payload.get("service", "service"))
    is_agents = service in {"agents", "llm"}
    details = _mapping(payload.get("details"))
    request_kind = details.get("request_kind")
    role = details.get("role")
    if is_agents and request_kind == "model-catalog":
        target = f"Provider · {details.get('provider', 'unknown')}"
    elif is_agents and request_kind in {"model-text", "model-image"}:
        target = _agent_probe_target("Model", details)
    elif is_agents and role == "browser-agent":
        target = _agent_probe_target("Browser", details)
    elif is_agents:
        target = _agent_probe_target("Analyze", details)
    else:
        target = "MinerU" if service == "mineru" else service.title()
    request, reason, action = diagnosis_lines(payload)
    return (
        target,
        str(payload.get("outcome", "failed")),
        request,
        _diagnosis_result(reason, action),
    )


def _browser_probe_row(payload: Mapping[str, object]) -> tuple[str, str, str, str]:
    request, reason, action = diagnosis_lines(payload)
    return (
        f"Browser · {payload.get('access_key', 'publisher')}",
        str(payload.get("outcome", "failed")),
        request,
        _diagnosis_result(reason, action),
    )


def _diagnosis_result(reason: str, action: str | None) -> str:
    return reason if action is None else f"{reason}\nNext: {action}"


def _probe_rows(payload: Mapping[str, object]) -> tuple[tuple[str, str, str, str], ...]:
    if {"search", "download", "analyze", "parse"}.issubset(payload):
        rows = _source_probe_rows(_mapping(payload["search"]))
        rows.extend(_source_probe_rows(_mapping(payload["download"])))
        rows.append(_core_probe_row(_mapping(payload["analyze"])))
        rows.append(_core_probe_row(_mapping(payload["parse"])))
        browser = payload.get("browser")
        if isinstance(browser, Mapping):
            rows.append(_core_probe_row(browser))
        return tuple(rows)
    if "results" in payload:
        return tuple(_source_probe_rows(payload))
    if "access_key" in payload:
        return (_browser_probe_row(payload),)
    return (_core_probe_row(payload),)


class TerminalChoice(Generic[_T]):
    """A prompt-toolkit choice wired explicitly to stdin and stderr."""

    def __init__(
        self,
        *,
        message: str,
        options: Sequence[ConfigOption[_T]],
        default: _T | None = None,
        theme: str | ConfigTheme = ConfigTheme.AUTO,
        shortcuts: dict[str, _T] | None = None,
        back_value: _T | object = _NO_BACK,
        searchable: bool = False,
        input_factory: Callable[[], Input] | None = None,
        output_factory: Callable[[], Output] | None = None,
    ) -> None:
        self.message = message
        if not options:
            raise ValueError("configuration menu requires at least one option")
        self.options = tuple(options)
        self.default = default
        self.theme = resolve_theme(theme)
        self.shortcuts = dict(shortcuts or {})
        self.back_value = back_value
        self.searchable = searchable
        self._input_factory = input_factory
        self._output_factory = output_factory

    def prompt(self) -> _T:
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
                visible_options = list(self.options)
                label_width = max(get_cwidth(option.plain_label) for option in self.options)
                while True:
                    bindings = KeyBindings()
                    for key, value in self.shortcuts.items():
                        bindings.add(key)(self._shortcut(value))
                    if self.back_value is not _NO_BACK:
                        bindings.add("left", eager=True)(self._shortcut(self.back_value))
                        bindings.add("escape")(self._shortcut(self.back_value))
                    if self.searchable:
                        bindings.add("/", eager=True)(self._shortcut(_SEARCH_CHOICE))
                    toolbar = "↑↓ move · Enter open"
                    if self.back_value is not _NO_BACK:
                        toolbar += " · ←/Esc back"
                    if self.searchable:
                        toolbar += " · / search"
                    toolbar += " · Ctrl+C cancel · ◆ set · ◇ view · ▶ test · ! danger · ← control"
                    visible_values = {option.value for option in visible_options}
                    description_width = max(
                        0,
                        output_stream.get_size().columns - label_width - 8,
                    )
                    chooser = ChoiceInput[object](
                        message=self.message,
                        options=[
                            (
                                option.value,
                                option.prompt_label(
                                    label_width=label_width,
                                    description_width=description_width,
                                ),
                            )
                            for option in visible_options
                        ],
                        default=self.default if self.default in visible_values else None,
                        symbol="›",
                        bottom_toolbar=toolbar,
                        show_frame=False,
                        show_numbers=False,
                        style=_prompt_style(self.theme),
                        key_bindings=bindings,
                    )
                    result = chooser.prompt()
                    if result is not _SEARCH_CHOICE:
                        return cast(_T, result)
                    query = prompt_text("Search: ").strip().casefold()
                    filtered = [
                        option
                        for option in self.options
                        if query in option.label.casefold()
                        or query in option.description.casefold()
                    ]
                    visible_options = filtered or list(self.options)
        finally:
            input_stream.close()

    @staticmethod
    def _shortcut(value: object):  # noqa: ANN205
        def handler(event):  # noqa: ANN001, ANN202
            event.app.exit(result=value)

        return handler


def _prompt_style(theme: ConfigTheme) -> Style:
    if theme is ConfigTheme.MONO:
        return Style.from_dict(
            {
                "selected-option": "bold reverse",
                "action.configure": "bold",
                "action.inspect": "underline",
                "action.test": "bold",
                "action.danger": "bold",
                "action.navigate": "dim",
                "option.description": "dim",
                "bottom-toolbar": "reverse",
            }
        )
    if theme is ConfigTheme.LIGHT:
        return Style.from_dict(
            {
                "selected-option": "bold bg:#dceeff",
                "action.configure": "fg:#005faf",
                "action.inspect": "fg:#875faf",
                "action.test": "fg:#af5f00",
                "action.danger": "bold fg:#af0000",
                "action.navigate": "fg:#666666",
                "option.description": "fg:#666666",
                "input-selection": "fg:#1c1c1c",
                "bottom-toolbar": "fg:#4e4e4e bg:#eeeeee",
            }
        )
    return Style.from_dict(
        {
            "selected-option": "bold bg:#303a42",
            "action.configure": "fg:#5fffff",
            "action.inspect": "fg:#d787ff",
            "action.test": "fg:#ffd75f",
            "action.danger": "bold fg:#ff5f5f",
            "action.navigate": "fg:#a8a8a8",
            "option.description": "fg:#a8a8a8",
            "input-selection": "fg:#eeeeee",
            "bottom-toolbar": "fg:#bcbcbc bg:#262626",
        }
    )


__all__ = (
    "ConfigActionKind",
    "ConfigConsole",
    "ConfigOption",
    "ConfigStatusPresenter",
    "ConfigTheme",
    "TerminalChoice",
    "interactive_terminal",
    "resolve_theme",
)
