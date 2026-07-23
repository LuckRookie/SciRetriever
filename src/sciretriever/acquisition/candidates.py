"""Internal URL-level candidate contracts for acquisition."""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import re
from types import MappingProxyType
from typing import Mapping
from urllib.parse import urlsplit

from sciretriever.acquisition.models import validate_provider_name
from sciretriever.core.enums import AssetRole
from sciretriever.core.timestamps import parse_rfc3339
from sciretriever.core.validation import validate_media_type


_TOKEN = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_HEADER_NAME = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$")
_SAFE_IDENTITY = re.compile(r"^[a-z][a-z0-9_-]{0,31}:[a-z0-9._~-]{1,191}$")
_CURSOR_MARKERS = (
    "url", "http", "www", "host", "scheme", "query", "header", "cookie", "token", "signature", "secret",
    "password", "credential", "auth", "referrer", "session", "body", "provenance",
    "response", "authorization",
)
_SENSITIVE_MARKERS = (
    "url", "query", "header", "cookie", "token", "signature", "secret", "password",
    "credential", "auth", "referrer", "session", "body", "provenance", "response",
    "authorization", "execution", "page_url", "request_headers", "auth_context",
    "set-cookie", "bearer",
)
_MAX_PROVENANCE_DEPTH = 4
_MAX_PROVENANCE_ITEMS = 64
_MAX_PROVENANCE_STRING_BYTES = 512


def _token(value: str, field_name: str) -> str:
    if not isinstance(value, str) or _TOKEN.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be a lowercase bounded token")
    return value


def validate_resolver_cursor(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError("resolver_cursor must be a string")
    if not value.startswith("rc1:") or len(value) == 4 or len(value.encode("utf-8")) > 256:
        raise ValueError("resolver_cursor must be a nonempty rc1 cursor of at most 256 UTF-8 bytes")
    payload = value[4:]
    lowered = payload.casefold()
    if (
        any(marker in lowered for marker in _CURSOR_MARKERS)
        or any(character in payload for character in ":/?#&=\\\r\n\t")
        or not all(character.isascii() and (character.isalnum() or character in "._~-") for character in payload)
        or _looks_reversible(payload)
    ):
        raise ValueError("resolver_cursor contains prohibited or reversible material")
    return value


def _looks_reversible(value: str) -> bool:
    compact = value.replace("-", "+").replace("_", "/")
    if len(compact) < 24:
        return False
    if re.fullmatch(r"[A-Fa-f0-9]+", compact) and len(compact) % 2 == 0:
        try:
            decoded = bytes.fromhex(compact).decode("utf-8").casefold()
        except (ValueError, UnicodeDecodeError):
            decoded = ""
        if any(marker in decoded for marker in _CURSOR_MARKERS) or "://" in decoded:
            return True
    if re.fullmatch(r"[A-Za-z0-9+/=]+", compact):
        import base64
        try:
            decoded = base64.b64decode(compact + "=" * (-len(compact) % 4), validate=True).decode("utf-8").casefold()
        except (ValueError, UnicodeDecodeError):
            decoded = ""
        if any(marker in decoded for marker in _CURSOR_MARKERS) or "://" in decoded:
            return True
    return False


def _https_url(value: str | None, field_name: str, *, required: bool) -> str | None:
    if value is None and not required:
        return None
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise ValueError(f"{field_name} must be an HTTPS URL without userinfo")
    if field_name == "execution_url" and parsed.fragment:
        raise ValueError("execution_url must not contain a fragment")
    return value


def _headers(value: Mapping[str, str]) -> Mapping[str, str]:
    if not isinstance(value, Mapping):
        raise TypeError("request_headers must be a mapping")
    if len(value) > 32:
        raise ValueError("request_headers has too many entries")
    normalized: dict[str, str] = {}
    seen: set[str] = set()
    for name, header_value in value.items():
        if not isinstance(name, str) or _HEADER_NAME.fullmatch(name) is None:
            raise ValueError("request header name is invalid")
        if not isinstance(header_value, str) or not header_value or len(header_value.encode("utf-8")) > 4096:
            raise ValueError("request header value is invalid")
        if "\r" in header_value or "\n" in header_value:
            raise ValueError("request header value contains a line break")
        lowered = name.casefold()
        if lowered in {"host", "referer"} or lowered in seen:
            raise ValueError("request headers contain a controlled or duplicate name")
        seen.add(lowered)
        normalized[name] = header_value
    return MappingProxyType(normalized)


def _sanitize(value: object, *, depth: int = 0) -> object:
    if depth > _MAX_PROVENANCE_DEPTH:
        raise ValueError("sanitized_provenance is too deeply nested")
    if value is None or isinstance(value, bool) or isinstance(value, int):
        return value
    if isinstance(value, float):
        if value != value or value in {float("inf"), float("-inf")}:
            raise ValueError("sanitized_provenance must contain finite numbers")
        return value
    if isinstance(value, str):
        lowered = value.casefold()
        if len(value.encode("utf-8")) > _MAX_PROVENANCE_STRING_BYTES or "://" in lowered or _looks_reversible(value):
            return "[REDACTED]"
        if any(marker in lowered for marker in _SENSITIVE_MARKERS):
            return "[REDACTED]"
        return value
    if isinstance(value, Mapping):
        if len(value) > _MAX_PROVENANCE_ITEMS:
            raise ValueError("sanitized_provenance has too many entries")
        result: dict[str, object] = {}
        for key, item in value.items():
            if not isinstance(key, str) or not key or len(key.encode("utf-8")) > 64:
                raise ValueError("sanitized_provenance keys must be bounded strings")
            result[key] = "[REDACTED]" if any(marker in key.casefold() for marker in _SENSITIVE_MARKERS) else _sanitize(item, depth=depth + 1)
        return MappingProxyType(result)
    if isinstance(value, (list, tuple)):
        if len(value) > _MAX_PROVENANCE_ITEMS:
            raise ValueError("sanitized_provenance has too many items")
        return tuple(_sanitize(item, depth=depth + 1) for item in value)
    raise TypeError("sanitized_provenance must contain JSON-compatible values")


def _validate_redacted_identity(value: str) -> str:
    if not isinstance(value, str) or len(value.encode("utf-8")) > 224 or _SAFE_IDENTITY.fullmatch(value) is None:
        raise ValueError("redacted_url_identity must be a bounded safe projection")
    lowered = value.casefold()
    payload = value.split(":", 1)[1]
    if any(marker in lowered for marker in _SENSITIVE_MARKERS) or _looks_reversible(value) or re.fullmatch(r"[0-9a-f]{64}", payload):
        raise ValueError("redacted_url_identity contains prohibited material")
    return value


def make_download_candidate_id(
    source_candidate_id: str,
    resolver_id: str,
    role: AssetRole,
    resolver_cursor: str,
) -> str:
    source_candidate_id = _token(source_candidate_id, "source_candidate_id")
    resolver_id = _token(resolver_id, "resolver_id")
    if not isinstance(role, AssetRole):
        raise TypeError("role must be an AssetRole")
    resolver_cursor = validate_resolver_cursor(resolver_cursor)
    payload = json.dumps(
        [source_candidate_id, resolver_id, role.value, resolver_cursor],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return "dc1_" + hashlib.sha256(payload).hexdigest()


@dataclass(frozen=True, slots=True)
class RuntimeDownloadCandidate:
    download_candidate_id: str
    source_candidate_id: str
    resolver_id: str
    provider: str
    resolver_cursor: str
    execution_url: str
    role: AssetRole
    priority: int
    transport: str
    access_method: str
    redacted_url_identity: str
    sanitized_provenance: Mapping[str, object]
    page_url: str | None = None
    request_headers: Mapping[str, str] = field(default_factory=dict)
    referrer: str | None = None
    auth_context_ref: str | None = None
    media_type_hint: str | None = None
    expires_at: str | None = None

    def __post_init__(self) -> None:
        source_id = _token(self.source_candidate_id, "source_candidate_id")
        resolver_id = _token(self.resolver_id, "resolver_id")
        provider = validate_provider_name(self.provider)
        cursor = validate_resolver_cursor(self.resolver_cursor)
        if not isinstance(self.role, AssetRole):
            raise TypeError("role must be an AssetRole")
        expected = make_download_candidate_id(source_id, resolver_id, self.role, cursor)
        if not isinstance(self.download_candidate_id, str) or self.download_candidate_id != expected:
            raise ValueError("download_candidate_id does not match the stable candidate identity")
        if not isinstance(self.priority, int) or isinstance(self.priority, bool) or self.priority < 0:
            raise ValueError("priority must be a nonnegative integer")
        object.__setattr__(self, "provider", provider)
        object.__setattr__(self, "execution_url", _https_url(self.execution_url, "execution_url", required=True))
        object.__setattr__(self, "page_url", _https_url(self.page_url, "page_url", required=False))
        object.__setattr__(self, "referrer", _https_url(self.referrer, "referrer", required=False))
        object.__setattr__(self, "request_headers", _headers(self.request_headers))
        object.__setattr__(self, "transport", _token(self.transport, "transport"))
        object.__setattr__(self, "access_method", _token(self.access_method, "access_method"))
        object.__setattr__(self, "redacted_url_identity", _validate_redacted_identity(self.redacted_url_identity))
        provenance = _sanitize(self.sanitized_provenance)
        if not isinstance(provenance, Mapping):
            raise TypeError("sanitized_provenance must be a mapping")
        object.__setattr__(self, "sanitized_provenance", provenance)
        if self.auth_context_ref is not None:
            object.__setattr__(self, "auth_context_ref", _token(self.auth_context_ref, "auth_context_ref"))
        if self.media_type_hint is not None:
            object.__setattr__(self, "media_type_hint", validate_media_type(self.media_type_hint))
        if self.expires_at is not None:
            parse_rfc3339(self.expires_at)

    def __hash__(self) -> int:
        return hash(self.download_candidate_id)
