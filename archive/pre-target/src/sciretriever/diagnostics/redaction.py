"""Recursive, bounded sanitization for durable diagnostics and provenance."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
import re
from urllib.parse import urlsplit, urlunsplit


REDACTED = "[REDACTED]"
TRUNCATED = "[TRUNCATED]"
_MAX_DEPTH = 8
_MAX_ITEMS = 50
_MAX_STRING = 512
_SENSITIVE_KEY = re.compile(
    r"(?:authorization|cookie|api[-_]?key|token|signature|sig|password|passwd|secret|session|email|response[-_]?body|body|error|exception|message|traceback)",
    re.IGNORECASE,
)
_URL = re.compile(r"https?://[^\s\]\[<>\"']+", re.IGNORECASE)
_EMAIL = re.compile(r"(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?![\w.-])")
_ASSIGNMENT = re.compile(
    r"(?i)\b(authorization|cookie|api[-_]?key|token|signature|sig|password|passwd|secret|session|email)\s*[:=]\s*([^\s,;]+)"
)
_BEARER = re.compile(r"(?i)\bBearer\s+[^\s,;]+")


def redact_url(value: str) -> str:
    try:
        parts = urlsplit(value)
    except ValueError:
        return REDACTED
    if not parts.scheme or not parts.netloc or parts.hostname is None:
        return REDACTED
    hostname = parts.hostname
    if ":" in hostname:
        hostname = f"[{hostname}]"
    try:
        netloc = hostname if parts.port is None else f"{hostname}:{parts.port}"
    except ValueError:
        return REDACTED
    return _bounded(urlunsplit((parts.scheme, netloc, "", "", "")))


def redact_text(value: object, *, limit: int = _MAX_STRING) -> str:
    text = str(value)
    text = _URL.sub(lambda match: redact_url(match.group(0)), text)
    text = _EMAIL.sub(REDACTED, text)
    text = _ASSIGNMENT.sub(lambda match: f"{match.group(1)}={REDACTED}", text)
    text = _BEARER.sub(f"Bearer {REDACTED}", text)
    return _bounded(" ".join(text.split()), limit)


def redact(value: object, *, _depth: int = 0) -> object:
    if _depth >= _MAX_DEPTH:
        return TRUNCATED
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, bytes):
        return REDACTED
    if isinstance(value, BaseException):
        return f"[REDACTED_EXCEPTION:{type(value).__name__}]"
    if isinstance(value, Mapping):
        result: dict[str, object] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= _MAX_ITEMS:
                result[TRUNCATED] = TRUNCATED
                break
            clean_key = redact_text(key, limit=80)
            result[clean_key] = REDACTED if _SENSITIVE_KEY.search(str(key)) else redact(item, _depth=_depth + 1)
        return result
    if isinstance(value, Sequence):
        items = [redact(item, _depth=_depth + 1) for item in value[:_MAX_ITEMS]]
        if len(value) > _MAX_ITEMS:
            items.append(TRUNCATED)
        return items
    return redact_text(value)


def _bounded(value: str, limit: int = _MAX_STRING) -> str:
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 0:
        raise ValueError("limit must be a non-negative integer")
    if len(value) <= limit:
        return value
    if limit <= len(TRUNCATED):
        return TRUNCATED[:limit]
    return value[: max(0, limit - len(TRUNCATED))] + TRUNCATED


__all__ = ("REDACTED", "TRUNCATED", "redact", "redact_text", "redact_url")
