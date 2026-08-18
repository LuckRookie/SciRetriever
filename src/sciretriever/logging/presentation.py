"""Best-effort human presentation for safe SciRetriever diagnostics."""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Final, TextIO

from .redaction import RedactingFormatter, redact_text

_LOGGING_UNAVAILABLE: Final[str] = "<logging unavailable>"
_ANSI_RESET: Final[str] = "\x1b[0m"

_FIELD_MARKER: Final[re.Pattern[str]] = re.compile(r"(?<!\S)(?P<key>[A-Za-z][A-Za-z0-9_-]*)=")
_EVENT_NAME: Final[re.Pattern[str]] = re.compile(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*")

_COMPONENT_PREFIXES: Final[tuple[tuple[str, str], ...]] = (
    ("metadata-", "metadata"),
    ("discovery-", "discovery"),
    ("citation-", "discovery"),
    ("completion-", "completion"),
    ("acquisition-", "acquisition"),
    ("authorized-", "authorized"),
    ("browser-", "browser"),
    ("network-", "network"),
    ("public-", "public"),
    ("parsing-", "parsing"),
    ("parser-", "parsing"),
    ("analysis-", "analysis"),
    ("literature-", "literature"),
    ("storage-", "storage"),
    ("configuration-", "config"),
    ("config-", "config"),
)

_FIELD_PRIORITY: Final[dict[str, int]] = {
    name: index
    for index, name in enumerate(
        (
            "progress",
            "phase",
            "stage",
            "depth",
            "goal",
            "provider",
            "provider_name",
            "product",
            "channel",
            "tier",
            "provider_group",
            "browser_rate_limit_group",
            "route_key",
            "browser_rule_id",
            "work_key",
            "attempt_key",
            "candidate_id",
            "session_key",
            "session_reused",
            "target_kind",
            "target_id",
            "http_status",
            "http_status_class",
            "representation",
            "envelope",
            "has_total",
            "has_start",
            "has_items_per_page",
            "has_cursor",
            "has_entry",
            "meta_literature_id",
            "literature_id",
            "raw_item_ordinal",
            "decision",
            "decision_reason",
            "deduplicated",
            "outcome",
            "status",
            "disposition",
            "next",
            "state",
            "group_feedback",
            "eligible",
            "admitted",
            "attempted",
            "scan_limit",
            "provider_count",
            "provider_group_count",
            "target_count",
            "attempt_count",
            "action_count",
            "selected",
            "resolved",
            "pending",
            "delivered",
            "failed",
            "raw_item_count",
            "accepted_item_count",
            "accepted_observation_count",
            "empty_item_count",
            "rejected_record_count",
            "observation_delta",
            "observation_count",
            "relation_delta",
            "relation_count",
            "result_count",
            "response_bytes",
            "elapsed_ms",
            "duration_ms",
            "queue_wait_ms",
            "wait_ms",
            "wait_seconds",
            "resource",
            "failure_kind",
            "code",
            "retryable",
            "reason",
            "action",
        )
    )
}

_FIELD_ALIASES: Final[dict[str, str]] = {
    "accepted_item_count": "accepted-items",
    "accepted_observation_count": "accepted",
    "action_count": "actions",
    "attempt_count": "attempts",
    "browser_rate_limit_group": "browser-group",
    "duration_ms": "duration",
    "elapsed_ms": "elapsed",
    "empty_item_count": "empty",
    "observation_count": "observations",
    "observation_delta": "observation-delta",
    "provider_count": "providers",
    "provider_group_count": "provider-groups",
    "queue_wait_ms": "queue-wait",
    "raw_item_count": "raw",
    "raw_item_ordinal": "raw-item",
    "rejected_record_count": "rejected",
    "relation_delta": "relation-delta",
    "relation_count": "relations",
    "response_bytes": "bytes",
    "result_count": "results",
    "scan_limit": "scan-limit",
    "target_count": "targets",
    "wait_ms": "wait",
}

_LEVEL_LABELS: Final[dict[int, str]] = {
    logging.DEBUG: "DEBUG",
    logging.INFO: "INFO",
    logging.WARNING: "WARN",
    logging.ERROR: "ERROR",
    logging.CRITICAL: "CRIT",
}

_LEVEL_COLORS: Final[dict[int, str]] = {
    logging.DEBUG: "\x1b[2;37m",
    logging.INFO: "\x1b[36m",
    logging.WARNING: "\x1b[33m",
    logging.ERROR: "\x1b[31m",
    logging.CRITICAL: "\x1b[1;31m",
}
_COMPONENT_COLOR: Final[str] = "\x1b[1;34m"
_SUCCESS_COLOR: Final[str] = "\x1b[32m"
_MUTED_COLOR: Final[str] = "\x1b[2;37m"
_TERMINAL_GLYPHS: Final[dict[str, str]] = {
    "failure": "✗",
    "failed": "✗",
    "fatal": "✗",
    "fatal-failure": "✗",
    "rejected": "✗",
    "deferred": "…",
    "action-required": "…",
    "cancelled": "…",
    "interrupted": "…",
    "queued": "…",
    "miss": "○",
    "normal-miss": "○",
    "empty": "○",
    "exhausted": "○",
    "skipped": "○",
    "accepted": "✓",
    "acquired": "✓",
    "completed": "✓",
    "delivered": "✓",
    "success": "✓",
}


@dataclass(frozen=True, slots=True)
class _ParsedMessage:
    event: str
    fields: tuple[tuple[str, str], ...]


def stream_supports_color(stream: TextIO) -> bool:
    """Return whether a production stream should receive ANSI presentation."""

    if "NO_COLOR" in os.environ or os.environ.get("TERM", "").lower() == "dumb":
        return False
    try:
        return bool(stream.isatty())
    except Exception:
        return False


def _parse_message(message: str) -> _ParsedMessage | None:
    matches = tuple(_FIELD_MARKER.finditer(message))
    if not matches or matches[0].start() != 0 or matches[0].group("key") != "event":
        return None
    values: list[tuple[str, str]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(message)
        value = message[match.end() : end].strip()
        values.append((match.group("key"), value))
    event = values[0][1]
    if _EVENT_NAME.fullmatch(event) is None:
        return None
    return _ParsedMessage(event=event, fields=tuple(values[1:]))


def _module_component(logger_name: str) -> str:
    prefix = "sciretriever."
    relative = logger_name[len(prefix) :] if logger_name.startswith(prefix) else logger_name
    component = relative.partition(".")[0].strip()
    return component or "runtime"


def _component_and_action(event: str, logger_name: str) -> tuple[str, str]:
    for prefix, component in _COMPONENT_PREFIXES:
        if event.startswith(prefix):
            return component, event[len(prefix) :].replace("-", " ")
    return _module_component(logger_name), event.replace("-", " ")


def _glyph(event: str, level: int, fields: tuple[tuple[str, str], ...]) -> str:
    tokens = frozenset(event.split("-"))
    field_values = {key: value.casefold() for key, value in fields}
    terminal = field_values.get("disposition", field_values.get("outcome", ""))
    terminal_glyph = _TERMINAL_GLYPHS.get(terminal)
    if terminal_glyph is not None:
        return terminal_glyph
    if tokens.intersection({"failed", "failure", "crashed", "rejected", "error"}):
        return "✗"
    if tokens.intersection({"interrupted", "deferred", "waiting", "paused", "queued"}):
        return "…"
    if tokens.intersection({"missed", "miss", "skipped", "exhausted", "unchanged"}):
        return "○"
    if tokens.intersection({"finished", "delivered", "accepted", "allowed", "committed", "passed"}):
        return "✓"
    if "started" in tokens:
        return "→"
    if level >= logging.WARNING:
        return "!"
    if level <= logging.DEBUG:
        return "·"
    return "•"


def _level_label(level: int, fallback: str) -> str:
    if level in _LEVEL_LABELS:
        return _LEVEL_LABELS[level]
    normalized = fallback.strip().upper()
    return normalized[:5] or "LOG"


def _paint(value: str, color: str, *, enabled: bool) -> str:
    return f"{color}{value}{_ANSI_RESET}" if enabled else value


def _format_milliseconds(value: str) -> str:
    try:
        milliseconds = float(value)
    except (TypeError, ValueError):
        return value
    if milliseconds < 0:
        return value
    return f"{milliseconds / 1000:.3f}s"


def _display_field(key: str, value: str) -> tuple[str, str]:
    display_key = _FIELD_ALIASES.get(key, key.replace("_", "-"))
    if key in {"elapsed_ms", "duration_ms", "queue_wait_ms", "wait_ms"}:
        return display_key, _format_milliseconds(value)
    return display_key, value


def _ordered_fields(
    fields: tuple[tuple[str, str], ...],
) -> tuple[tuple[str, str], ...]:
    indexed = tuple(enumerate(fields))
    ordered = sorted(
        indexed,
        key=lambda item: (_FIELD_PRIORITY.get(item[1][0], len(_FIELD_PRIORITY)), item[0]),
    )
    return tuple(field for _, field in ordered)


def _source_location(record: logging.LogRecord) -> str:
    prefix = "sciretriever."
    name = record.name[len(prefix) :] if record.name.startswith(prefix) else record.name
    return f"@ {name}:{record.lineno}"


class DiagnosticFormatter(RedactingFormatter):
    """Render safe event messages for humans while preserving exact event IDs."""

    def __init__(self, *, debug: bool, color: bool) -> None:
        super().__init__()
        self._debug = debug
        self._color = color

    def format(self, record: logging.LogRecord) -> str:
        try:
            message = record.getMessage()
            if not isinstance(message, str):
                message = repr(message)
            parsed = _parse_message(message)
            timestamp = self.formatTime(record, "%Y-%m-%d %H:%M:%S")
            timestamp = f"{timestamp}.{int(record.msecs):03d}"
            level = _level_label(record.levelno, record.levelname)
            if parsed is None:
                rendered = self._format_plain(record, timestamp, level, message)
            else:
                rendered = self._format_event(record, timestamp, level, parsed)
            return redact_text(rendered)
        except Exception:
            return _LOGGING_UNAVAILABLE

    def _prefix(
        self,
        *,
        timestamp: str,
        level: str,
        levelno: int,
        component: str,
    ) -> str:
        displayed_level = _paint(
            f"{level:<5}",
            _LEVEL_COLORS.get(levelno, _MUTED_COLOR),
            enabled=self._color,
        )
        displayed_component = _paint(
            f"{component:<12}",
            _COMPONENT_COLOR,
            enabled=self._color,
        )
        return f"{timestamp} {displayed_level} {displayed_component}"

    def _format_plain(
        self,
        record: logging.LogRecord,
        timestamp: str,
        level: str,
        message: str,
    ) -> str:
        component = _module_component(record.name)
        prefix = self._prefix(
            timestamp=timestamp,
            level=level,
            levelno=record.levelno,
            component=component,
        )
        glyph = _paint(
            "·" if record.levelno <= logging.DEBUG else "•", _MUTED_COLOR, enabled=self._color
        )
        suffix = f" {_source_location(record)}" if self._debug else ""
        return f"{prefix} {glyph} {message}{suffix}"

    def _format_event(
        self,
        record: logging.LogRecord,
        timestamp: str,
        level: str,
        parsed: _ParsedMessage,
    ) -> str:
        component, action = _component_and_action(parsed.event, record.name)
        prefix = self._prefix(
            timestamp=timestamp,
            level=level,
            levelno=record.levelno,
            component=component,
        )
        glyph_value = _glyph(parsed.event, record.levelno, parsed.fields)
        glyph_color = (
            _LEVEL_COLORS.get(record.levelno, _MUTED_COLOR)
            if record.levelno >= logging.WARNING
            else _SUCCESS_COLOR
            if glyph_value == "✓"
            else _MUTED_COLOR
        )
        glyph = _paint(glyph_value, glyph_color, enabled=self._color)

        reason: str | None = None
        next_action: str | None = None
        fields: list[str] = []
        for key, value in _ordered_fields(parsed.fields):
            if key == "reason":
                reason = value
                continue
            if key == "action":
                next_action = value
                continue
            display_key, display_value = _display_field(key, value)
            fields.append(f"{display_key}={display_value}")

        main = f"{prefix} {glyph} {action} [{parsed.event}]"
        if fields:
            main += " " + " · ".join(fields)
        if self._debug:
            main += f" {_source_location(record)}"

        continuation: list[str] = [main]
        if reason is not None:
            continuation.append(f"    reason  {reason}")
        if next_action is not None:
            continuation.append(f"    action  {next_action}")
        return "\n".join(continuation)


__all__ = ("DiagnosticFormatter", "stream_supports_color")
