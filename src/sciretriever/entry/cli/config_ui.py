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
    ) -> None:
        core = self._home_table()
        core.add_row("[L]", "LLM Analysis", llm_detail, _state_text(llm_state, self.palette))
        core.add_row("[M]", "MinerU Parser", mineru_detail, _state_text(mineru_state, self.palette))
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
                "Official authorized primary-PDF API; separate from Browser session state.",
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
                "A local Browser profile only proves that its private container is present. "
                "It never proves login, institutional authorization, or article entitlement.",
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
        self.console.print(self._provider_credentials(payload))
        self.console.print(self._pdf_routes(payload))
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
                "MinerU: GET health only; no PDF upload. Results are not persisted.",
                style=self.palette.muted,
            )
        )

    def _core_services(self, payload: Mapping[str, object]) -> Table:
        parsing = _mapping(payload["parsing"])
        analysis = _mapping(payload["analysis"])
        parser_secret = _mapping(parsing["bearer_token"])
        analysis_secret = _mapping(analysis["api_key"])
        implementation = _mapping(parsing["implementation"])
        table = Table(
            title="Core services",
            box=box.ROUNDED,
            border_style=self.palette.border,
            expand=True,
        )
        table.add_column("Service", style=self.palette.accent, no_wrap=True)
        table.add_column("Endpoint / protocol", overflow="fold")
        table.add_column("Model / identity", overflow="fold")
        table.add_column("Credential", overflow="fold")
        table.add_column("Readiness", no_wrap=True)
        llm_identity = (
            " · ".join(
                value
                for value in (
                    _shown(analysis.get("provider")),
                    _shown(analysis.get("model")),
                    _token_count(analysis.get("context_window_tokens")),
                )
                if value != "not set"
            )
            or "not set"
        )
        table.add_row(
            "LLM Analysis",
            f"{_shown(analysis.get('protocol'))}\n{_shown(analysis.get('base_url'))}",
            llm_identity,
            _core_credential_state(analysis_secret),
            _state_text(
                "ready" if analysis.get("reference_locally_ready") is True else "needs setup",
                self.palette,
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
            "MinerU Parser",
            f"{_shown(parsing.get('connection_mode'))}\n{_shown(parsing.get('base_url'))}",
            parser_identity,
            _core_credential_state(parser_secret),
            _state_text(
                "ready" if parsing.get("locally_ready") is True else "needs setup",
                self.palette,
            ),
        )
        return table

    def _provider_credentials(self, payload: Mapping[str, object]) -> Table:
        providers = _mapping(payload["providers"])
        combined: dict[str, dict[str, object]] = {}
        for capability in ("metadata", "acquisition"):
            for item in _mapping_sequence(providers[capability]):
                provider = str(item["provider"])
                aggregate = combined.setdefault(
                    provider,
                    {
                        "purposes": [],
                        "enabled": False,
                        "credentials": item["credentials"],
                    },
                )
                cast(list[str], aggregate["purposes"]).append(capability)
                aggregate["enabled"] = bool(aggregate["enabled"] or item["enabled"])
                current = _mapping(aggregate["credentials"])
                candidate = _mapping(item["credentials"])
                if _credential_priority(str(candidate["status"])) > _credential_priority(
                    str(current["status"])
                ):
                    aggregate["credentials"] = candidate
        table = Table(
            title=f"Literature Provider credentials · {providers['credentials_file']}",
            box=box.ROUNDED,
            border_style=self.palette.border,
            expand=True,
        )
        table.add_column("Provider", style=self.palette.accent, no_wrap=True)
        table.add_column("Purpose", overflow="fold")
        table.add_column("Enabled", no_wrap=True)
        table.add_column("Credential fields", overflow="fold")
        for provider in sorted(combined):
            item = combined[provider]
            credentials = _mapping(item["credentials"])
            fields = _mapping_sequence(credentials["fields"])
            if not fields and credentials["status"] == "not-required":
                credential = "not required"
            elif not fields:
                credential = str(credentials["status"])
            else:
                credential = ", ".join(
                    f"{field['name']}="
                    f"{'configured' if field['configured'] else 'missing'}"
                    f"{' (optional)' if not field['required'] else ''}"
                    for field in fields
                )
            table.add_row(
                provider,
                " / ".join(cast(list[str], item["purposes"])),
                "yes" if item["enabled"] else "no",
                credential,
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
        table.add_row(
            "3 · Controlled browser",
            "available" if browser["available"] is True else "not implemented",
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
    successful = normalized in {"ready", "configured", "optional", "passed"}
    style = palette.ready if successful else palette.warning
    symbol = "●" if successful else "○"
    return Text(f"{symbol} {state}", style=style)


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


def _credential_priority(value: str) -> int:
    return {
        "unsupported": 0,
        "not-required": 1,
        "optional-missing": 2,
        "configured": 3,
        "missing": 4,
        "partial": 5,
    }.get(value, 6)


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
    detail = (
        "minimal strict schema request; no Literature content"
        if service == "llm"
        else "health/release/protocol/profile only; no PDF upload"
    )
    return (
        service.upper() if service == "llm" else service.title(),
        str(payload.get("outcome", "failed")),
        detail,
        str(payload.get("failure_code") or ""),
    )


def _probe_rows(payload: Mapping[str, object]) -> tuple[tuple[str, str, str, str], ...]:
    if "providers" in payload:
        rows = _provider_probe_rows(_mapping(payload["providers"]))
        rows.append(_core_probe_row(_mapping(payload.get("llm"))))
        rows.append(_core_probe_row(_mapping(payload.get("mineru"))))
        return tuple(rows)
    if "results" in payload:
        return tuple(_provider_probe_rows(payload))
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
