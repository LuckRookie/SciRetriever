"""Shared interaction primitives for owner-scoped configuration pages."""

from __future__ import annotations

import sys
from collections.abc import Callable, Sequence
from typing import Literal, TypeVar

from sciretriever.configuration import configuration_diff
from sciretriever.entry.cli.config_ui import (
    ConfigActionKind,
    ConfigConsole,
    ConfigOption,
    TerminalChoice,
    interactive_terminal,
)
from sciretriever.model.configuration import Configuration

_T = TypeVar("_T")


def option(
    value: _T,
    label: str | None = None,
    *,
    kind: ConfigActionKind = ConfigActionKind.CONFIGURE,
) -> ConfigOption[_T]:
    """Build one single-word option without losing its interaction meaning."""

    return ConfigOption(value=value, label=str(value) if label is None else label, kind=kind)


def confirm(prompt: str) -> bool:
    try:
        sys.stderr.write(prompt)
        sys.stderr.flush()
        answer = input()
    except EOFError:
        return False
    return answer.strip().casefold() in {"y", "yes"}


def read_line(prompt: str) -> str | None:
    try:
        sys.stderr.write(prompt)
        sys.stderr.flush()
        return input().strip()
    except EOFError:
        return None


def select_value(
    prompt: str,
    values: Sequence[ConfigOption[str]],
    *,
    console: ConfigConsole,
    default: str | None = None,
    searchable: bool = False,
) -> str | None:
    if default is not None and default not in {item.value for item in values}:
        raise ValueError("selection default is not an available value")
    if interactive_terminal():
        choice_options: list[ConfigOption[str | None]] = [
            ConfigOption(value=item.value, label=item.label, kind=item.kind) for item in values
        ]
        choice_options.append(
            ConfigOption(
                value=None,
                label="Cancel",
                kind=ConfigActionKind.NAVIGATE,
            )
        )
        return TerminalChoice[str | None](
            message=prompt,
            options=choice_options,
            default=default,
            theme=console.palette.name,
            back_value=None,
            searchable=searchable,
        ).prompt()
    console.message(prompt, kind="muted")
    default_index: int | None = None
    for index, item in enumerate(values, start=1):
        marker = " [default]" if item.value == default else ""
        sys.stderr.write(f"  {index}. {item.plain_label}{marker}\n")
        if item.value == default:
            default_index = index
    suffix = f" [{default_index}]" if default_index is not None else ""
    answer = read_line(f"Choose a number{suffix} (b to cancel): ")
    if answer is None or answer.casefold() in {"b", "back", "q", "quit"}:
        return None
    if not answer and default is not None:
        return default
    if answer.isdecimal() and 1 <= int(answer) <= len(values):
        return values[int(answer) - 1].value
    console.message("Invalid selection; no configuration was changed.", kind="warning")
    return None


def ask_text(label: str, *, default: str | None = None) -> str | None:
    suffix = f" [{default}]" if default else ""
    value = read_line(f"{label}{suffix}: ")
    if value is None:
        return None
    return default if not value and default is not None else value


def ask_positive_integer(label: str, *, default: int | None = None) -> int | None:
    while True:
        raw = ask_text(label, default=None if default is None else str(default))
        if raw is None:
            return None
        try:
            value = int(raw)
        except ValueError:
            value = 0
        if value > 0:
            return value
        sys.stderr.write("Enter a positive integer, or press Ctrl+C to cancel.\n")


def ask_boolean(
    prompt: str,
    *,
    console: ConfigConsole,
    default: bool,
) -> bool | None:
    selected = select_value(
        prompt,
        [option("yes", "Yes"), option("no", "No")],
        console=console,
        default="yes" if default else "no",
    )
    return None if selected is None else selected == "yes"


_ConfigurationSection = Literal[
    "sources",
    "providers",
    "models",
    "analyze",
    "download",
    "parsing",
]


def confirm_changes(
    console: ConfigConsole,
    before: Configuration,
    after: Configuration,
    *,
    section: _ConfigurationSection | tuple[_ConfigurationSection, ...],
    confirmer: Callable[[str], bool] | None = None,
) -> bool:
    sections = (section,) if isinstance(section, str) else section
    changes = configuration_diff(before, after, sections=sections)
    if not changes:
        console.message("No ordinary configuration changes are needed.", kind="muted")
        return True
    console.changes(changes)
    confirm_save = confirm if confirmer is None else confirmer
    return confirm_save("Save these ordinary configuration changes? [y/N] ")


__all__ = (
    "ask_boolean",
    "ask_positive_integer",
    "ask_text",
    "confirm",
    "confirm_changes",
    "option",
    "read_line",
    "select_value",
)
