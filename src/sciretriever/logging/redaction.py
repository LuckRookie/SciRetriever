"""Final, best-effort redaction for project log records.

Source adapters remain responsible for semantic conversion of provider and
network failures.  This module is only a last line of defence for records
that accidentally carry a recognisable secret-shaped field.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

_REDACTED = "<redacted>"
_LOGGING_UNAVAILABLE = "<logging unavailable>"

# Keys are compared after punctuation is removed.  Keeping this list narrow
# avoids turning ordinary diagnostic fields such as ``stage`` into secrets,
# while still covering common HTTP and provider spellings.
_SENSITIVE_KEYS = frozenset(
    {
        "access_token",
        "api_key",
        "apikey",
        "authorization",
        "client_secret",
        "cookie",
        "credential",
        "credentials",
        "id_token",
        "password",
        "private_key",
        "proxy_authorization",
        "refresh_token",
        "secret",
        "set_cookie",
        "signature",
        "sig",
        "token",
        "x_api_key",
    }
)

_SENSITIVE_KEY_NAMES = frozenset(
    {
        "accesstoken",
        "apikey",
        "authorization",
        "clientsecret",
        "cookie",
        "credential",
        "credentials",
        "idtoken",
        "password",
        "privatekey",
        "proxyauthorization",
        "refreshtoken",
        "secret",
        "setcookie",
        "signature",
        "sig",
        "token",
        "xapikey",
    }
)

_KEY_VALUE_RE = re.compile(
    r"(?P<prefix>['\"]?(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|"
    r"x[-_]?api[-_]?key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|"
    r"token|client[-_]?secret|private[-_]?key|credential[s]?|password|secret|signature|sig|hmac)"
    r"['\"]?\s*(?:=|:)\s*)"
    r"(?P<value>(?:['\"][^'\"]*['\"]|[^,;\s}\]&]+))",
    re.IGNORECASE,
)
_AUTH_SCHEME_RE = re.compile(r"\b(?P<scheme>Bearer|Basic)\s+(?P<value>[^\s,;]+)", re.I)
_URL_RE = re.compile(r"https?://[^\s<>\"']+", re.I)
_QUERY_RE = re.compile(
    r"(?P<prefix>[?&](?:token|access[-_]?token|refresh[-_]?token|id[-_]?token|"
    r"api[-_]?key|key|secret|password|signature|sig|auth|credential)[^=&#\s]*=)"
    r"(?P<value>[^&#\s,;}\]]+)",
    re.I,
)
_SENSITIVE_QUERY_NAME_RE = re.compile(
    r"(?:token|secret|password|api[-_]?key|credential|authorization|signature|(?:^|[-_])sig(?:$|[-_]))",
    re.I,
)

_STANDARD_RECORD_FIELDS = frozenset(
    {
        "name",
        "msg",
        "args",
        "levelname",
        "levelno",
        "pathname",
        "filename",
        "module",
        "exc_info",
        "exc_text",
        "stack_info",
        "lineno",
        "funcName",
        "created",
        "msecs",
        "relativeCreated",
        "thread",
        "threadName",
        "processName",
        "process",
        "taskName",
    }
)


def _normalise_key(key: object) -> str:
    if not isinstance(key, str):
        return ""
    return re.sub(r"[^a-z0-9]", "", key.lower())


def _is_sensitive_key(key: object) -> bool:
    normalized = _normalise_key(key)
    if not normalized:
        return False
    if normalized in _SENSITIVE_KEY_NAMES:
        return True
    return any(
        marker in normalized
        for marker in ("token", "secret", "password", "credential", "authorization", "cookie")
    )


def _redact_url(match: re.Match[str]) -> str:
    candidate = match.group(0)
    trailing = ""
    while candidate and candidate[-1] in ".,;:!?)]}":
        trailing = candidate[-1] + trailing
        candidate = candidate[:-1]
    try:
        parsed = urlsplit(candidate)
        hostname = parsed.hostname
        if hostname is None:
            safe_netloc = ""
        else:
            safe_hostname = f"[{hostname}]" if ":" in hostname else hostname
            port = parsed.port
            safe_netloc = safe_hostname if port is None else f"{safe_hostname}:{port}"
        pairs = parse_qsl(parsed.query, keep_blank_values=True)
        safe_pairs = [
            (key, _REDACTED if _SENSITIVE_QUERY_NAME_RE.search(key) else value)
            for key, value in pairs
        ]
        safe_query = urlencode(safe_pairs, doseq=True)
        safe_fragment = parsed.fragment
        if safe_fragment:
            fragment_query = _QUERY_RE.sub(
                lambda fragment_match: f"{fragment_match.group('prefix')}{_REDACTED}",
                "?" + safe_fragment,
            )
            safe_fragment = fragment_query[1:]
        rebuilt = urlunsplit((parsed.scheme, safe_netloc, parsed.path, safe_query, safe_fragment))
        return rebuilt + trailing
    except Exception:
        # A malformed URL is not a reason for logging to affect its caller.
        return "<url redacted>" + trailing


def redact_text(value: str) -> str:
    """Redact recognisable credentials and sensitive URL/query values in text."""

    safe = _URL_RE.sub(_redact_url, value)
    safe = _AUTH_SCHEME_RE.sub(lambda match: f"{match.group('scheme')} {_REDACTED}", safe)
    safe = _QUERY_RE.sub(lambda match: f"{match.group('prefix')}{_REDACTED}", safe)
    safe = _KEY_VALUE_RE.sub(lambda match: f"{match.group('prefix')}{_REDACTED}", safe)
    return safe


def _redact_object(value: object, *, key: object = None) -> object:
    if _is_sensitive_key(key):
        return _REDACTED
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, Mapping):
        return {
            object_key: _redact_object(item, key=object_key) for object_key, item in value.items()
        }
    if isinstance(value, tuple):
        return tuple(_redact_object(item) for item in value)
    if isinstance(value, list):
        return [_redact_object(item) for item in value]
    if isinstance(value, set):
        return {_redact_object(item) for item in value}
    return value


def redact_record(record: logging.LogRecord) -> None:
    """Sanitise the mutable fields used by the standard formatter.

    The exception and stack fields are intentionally removed rather than
    attempting to parse arbitrary traceback or filesystem text.  A caller can
    still retain its typed failure separately; logging is not that contract.
    """

    try:
        try:
            rendered = record.getMessage()
        except Exception:
            rendered = str(record.msg)
        if not isinstance(rendered, str):
            rendered = repr(rendered)
        record.msg = redact_text(rendered)
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        record.stack_info = None
        for key, value in tuple(record.__dict__.items()):
            if key not in _STANDARD_RECORD_FIELDS:
                record.__dict__[key] = _redact_object(value, key=key)
    except Exception:
        # Keep the final guard fail-closed even for hostile ``__str__`` or
        # mapping implementations supplied by an external adapter.
        record.msg = _LOGGING_UNAVAILABLE
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        record.stack_info = None


class RedactionFilter(logging.Filter):
    """A never-raising final filter installed on the project handler."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            redact_record(record)
        except Exception:
            # ``redact_record`` already guards itself; this outer guard keeps
            # the Filter contract safe if a future implementation changes.
            try:
                record.msg = _LOGGING_UNAVAILABLE
                record.args = ()
                record.exc_info = None
                record.exc_text = None
                record.stack_info = None
            except Exception:
                return False
        return True


class RedactingFormatter(logging.Formatter):
    """Formatter that never emits an exception traceback or unsafe fallback."""

    def formatException(self, ei: Any) -> str:
        return _REDACTED

    def formatStack(self, stack_info: str) -> str:
        return _REDACTED

    def format(self, record: logging.LogRecord) -> str:
        try:
            return redact_text(super().format(record))
        except Exception:
            return _LOGGING_UNAVAILABLE
