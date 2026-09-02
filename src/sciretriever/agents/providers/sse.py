"""Strict framing for bounded Server-Sent Events provider responses."""

from __future__ import annotations

from dataclasses import dataclass

from sciretriever.agents.providers.base import provider_failure


@dataclass(frozen=True, slots=True)
class ServerSentEvent:
    """One decoded SSE event after framing validation."""

    event: str | None
    data: str


def parse_sse_events(
    body: bytes,
    *,
    allow_done: bool,
) -> tuple[tuple[ServerSentEvent, ...], bool]:
    """Decode a bounded SSE body and return events plus an optional ``[DONE]``.

    Network owns byte and time limits before this function runs.  This layer
    rejects ambiguous framing, invalid UTF-8, duplicate terminal sentinels,
    and any meaningful data after ``[DONE]``.  Protocol-specific event
    semantics remain in each provider adapter.
    """

    if type(body) is not bytes:
        raise TypeError("SSE body must be bytes")
    try:
        text = body.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        raise provider_failure("protocol") from None
    if "\x00" in text:
        raise provider_failure("protocol")

    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    events: list[ServerSentEvent] = []
    done_seen = False
    for block in normalized.split("\n\n"):
        parsed = _parse_event(block)
        if parsed is None:
            continue
        if done_seen:
            raise provider_failure("protocol")
        if parsed.data == "[DONE]":
            if not allow_done or parsed.event is not None:
                raise provider_failure("protocol")
            done_seen = True
            continue
        events.append(parsed)
    return tuple(events), done_seen


def _parse_event(block: str) -> ServerSentEvent | None:  # noqa: C901
    """Parse one strict SSE event block without retaining ignored fields."""

    if type(block) is not str:
        raise provider_failure("protocol")
    event_name: str | None = None
    data_lines: list[str] = []
    meaningful = False
    for line in block.split("\n"):
        if not line or line.startswith(":"):
            continue
        meaningful = True
        field, separator, value = line.partition(":")
        if separator and value.startswith(" "):
            value = value[1:]
        if field == "event":
            if event_name is not None or not value or len(value) > 128:
                raise provider_failure("protocol")
            if any(character.isspace() or ord(character) < 33 for character in value):
                raise provider_failure("protocol")
            event_name = value
        elif field == "data":
            data_lines.append(value)
        elif field not in {"id", "retry"}:
            raise provider_failure("protocol")
    if not meaningful:
        return None
    if not data_lines:
        raise provider_failure("protocol")
    return ServerSentEvent(event=event_name, data="\n".join(data_lines))


__all__ = ("ServerSentEvent", "parse_sse_events")
