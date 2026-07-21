"""Strict UTC RFC3339 helpers used at SciRetriever boundaries."""

from __future__ import annotations

from datetime import datetime, timezone
import re


_RFC3339_UTC = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2})T(?P<time>\d{2}:\d{2}:\d{2})"
    r"(?P<fraction>\.\d+)?Z$"
)


def parse_rfc3339(value: str) -> datetime:
    """Parse the schema's strict UTC RFC3339 representation."""
    if not isinstance(value, str):
        raise TypeError("RFC3339 timestamp must be a string")
    if _RFC3339_UTC.fullmatch(value) is None:
        raise ValueError("timestamp must be RFC3339 UTC and end with 'Z'")
    try:
        return datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise ValueError("timestamp is not a valid RFC3339 UTC date-time") from error


def utc_now_rfc3339() -> str:
    """Return the current time in canonical millisecond UTC RFC3339 form."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
