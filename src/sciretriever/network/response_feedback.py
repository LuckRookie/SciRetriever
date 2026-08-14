"""Secret-free parsing helpers for adapter-owned access feedback."""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from sciretriever.model.access import Header

from .admission import AccessFeedback

_DELTA_SECONDS = re.compile(r"[0-9]+", re.ASCII)


class FeedbackHeaderError(ValueError):
    """A selected response header cannot be interpreted safely."""


def header_value(headers: Sequence[Header], name: str) -> str | None:
    """Read one case-insensitive header without choosing conflicting duplicates."""

    if type(name) is not str:
        raise TypeError("name must be a string")
    target = name.strip().casefold()
    if not target:
        raise ValueError("name must be nonblank")
    values: list[str] = []
    for header in headers:
        if not isinstance(header, Header):
            raise TypeError("headers must contain Header values")
        if header.name.casefold() == target:
            values.append(header.value.strip())
    if not values:
        return None
    first = values[0]
    if any(value != first for value in values[1:]):
        raise FeedbackHeaderError("response feedback header values conflict")
    return first


def nonnegative_integer_header(headers: Sequence[Header], name: str) -> int | None:
    """Parse one optional nonnegative integer header or fail closed."""

    value = header_value(headers, name)
    if value is None:
        return None
    if not value.isdigit():
        raise FeedbackHeaderError("response feedback integer header is invalid")
    return int(value, 10)


def nonnegative_number_header(headers: Sequence[Header], name: str) -> float | None:
    """Parse one optional finite nonnegative numeric header or fail closed."""

    value = header_value(headers, name)
    if value is None:
        return None
    try:
        candidate = float(value)
    except ValueError:
        raise FeedbackHeaderError("response feedback numeric header is invalid") from None
    if not math.isfinite(candidate) or candidate < 0:
        raise FeedbackHeaderError("response feedback numeric header is invalid")
    return candidate


def parse_retry_after(value: str | None, *, wall_now: datetime) -> float | None:
    """Parse RFC Retry-After into a nonnegative duration."""

    current = _aware_datetime(wall_now, field_name="wall_now")
    if value is None:
        return None
    if type(value) is not str:
        raise TypeError("value must be a string or None")
    candidate = value.strip()
    if not candidate:
        return None
    if _DELTA_SECONDS.fullmatch(candidate) is not None:
        try:
            return float(int(candidate, 10))
        except (ValueError, OverflowError):
            return None
    try:
        parsed = parsedate_to_datetime(candidate)
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return max(0.0, (parsed - current).total_seconds())


def retry_after_feedback(
    status_code: int,
    headers: Sequence[Header],
    *,
    wall_now: datetime,
) -> AccessFeedback | None:
    """Interpret standard Retry-After and conservatively handle malformed 429."""

    if type(status_code) is not int or not 100 <= status_code <= 599:
        raise ValueError("status_code must be an HTTP status")
    delay = parse_retry_after(
        header_value(headers, "Retry-After"),
        wall_now=wall_now,
    )
    if delay is None:
        return AccessFeedback(throttled=True) if status_code == 429 else None
    return AccessFeedback(retry_after=delay, throttled=status_code == 429)


def quota_reset_deadline(
    value: str | None,
    *,
    wall_now: datetime,
    monotonic_now: float,
) -> float | None:
    """Project an official Unix-epoch reset header into the process clock."""

    current = _aware_datetime(wall_now, field_name="wall_now")
    monotonic = _finite_nonnegative(monotonic_now, field_name="monotonic_now")
    if value is None:
        return None
    if type(value) is not str:
        raise TypeError("value must be a string or None")
    candidate = value.strip()
    if not candidate.isdigit():
        raise FeedbackHeaderError("quota reset header is invalid")
    try:
        reset = datetime.fromtimestamp(int(candidate, 10), tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        raise FeedbackHeaderError("quota reset header is invalid") from None
    return monotonic + max(0.0, (reset - current).total_seconds())


def _aware_datetime(value: datetime, *, field_name: str) -> datetime:
    if not isinstance(value, datetime):
        raise TypeError(f"{field_name} must be a datetime")
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{field_name} must be timezone-aware")
    return value


def _finite_nonnegative(value: float, *, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{field_name} must be a number")
    candidate = float(value)
    if not math.isfinite(candidate) or candidate < 0:
        raise ValueError(f"{field_name} must be finite and nonnegative")
    return candidate


__all__ = (
    "FeedbackHeaderError",
    "header_value",
    "nonnegative_integer_header",
    "nonnegative_number_header",
    "parse_retry_after",
    "quota_reset_deadline",
    "retry_after_feedback",
)
