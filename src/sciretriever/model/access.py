"""Neutral, bounded values exchanged at the HTTP and Browser boundaries.

The Network module owns URL policy, DNS/redirect checks and admission.  These
models intentionally carry only the small, already-bounded exchange needed by
an adapter.  They do not carry a client/session/page, an access permit, a
credential, or any retry/quota state.
"""

from __future__ import annotations

import base64
import re
from typing import TypeAlias
from urllib.parse import parse_qsl, urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

_HEADER_NAME = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
_ANY_CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")
_HEADER_CONTROL_CHARACTER = re.compile(r"[\x00-\x08\x0a-\x1f\x7f]")
_WINDOWS_ABSOLUTE_PATH = re.compile(r"^[A-Za-z]:[\\/]")
_INVALID_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")
_SENSITIVE_QUERY_KEYS = frozenset(
    {
        "api_key",
        "apikey",
        "awsaccesskeyid",
        "auth",
        "authorization",
        "bearer",
        "cookie",
        "credential",
        "credentials",
        "email",
        "id_token",
        "key",
        "password",
        "passwd",
        "refresh_token",
        "secret",
        "sig",
        "signature",
        "token",
        "access_token",
    }
)
_SENSITIVE_QUERY_SUFFIXES = (
    "_credential",
    "_key",
    "_secret",
    "_signature",
    "_token",
)

# These names either carry credentials or can echo credentials supplied by a
# remote service.  They are deliberately rejected rather than merely hidden
# from repr: a model that accepts them could still serialise the secret.  The
# comparison below removes field-name separators so provider spellings such as
# ``Api-Key`` and ``X-ELS-Insttoken`` cannot cross this boundary by aliasing.
_SECRET_HEADER_NAME_MARKERS = frozenset(
    {
        "authorization",
        "apikey",
        "cookie",
        "credential",
        "password",
        "secret",
        "signature",
        "token",
    }
)

# Network owns authority, message framing, and connection-scoped fields.  They
# are generated from the verified destination and actual request body rather
# than crossing the neutral model boundary as caller-controlled headers.
_NETWORK_OWNED_HEADER_NAMES = frozenset(
    {
        "host",
        "contentlength",
        "transferencoding",
        "connection",
        "keepalive",
        "proxyauthenticate",
        "proxyauthorization",
        "proxyconnection",
        "te",
        "trailer",
        "upgrade",
    }
)


class _AccessValidationError(ValueError):
    pass


class _AccessModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        ser_json_bytes="base64",
        strict=True,
        val_json_bytes="base64",
    )


def _nonblank(value: str, *, field_name: str) -> str:
    candidate = value.strip()
    if not candidate:
        raise _AccessValidationError(f"{field_name} must be a nonblank string")
    return candidate


def _normalise_header_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.casefold())


def has_sensitive_query_parameter(query: str) -> bool:
    """Return whether a URL query carries a credential or signature field.

    This pure predicate is shared by neutral access models, persisted asset
    hints, and Network URL policy so those boundaries cannot drift onto
    different credential-name lists.  Malformed percent escapes or UTF-8 fail
    closed without echoing the query value.
    """

    if type(query) is not str or _INVALID_PERCENT_ESCAPE.search(query) is not None:
        raise _AccessValidationError("URL query must be well formed")
    try:
        query_fields = parse_qsl(
            query,
            keep_blank_values=True,
            strict_parsing=False,
            encoding="utf-8",
            errors="strict",
        )
    except (UnicodeDecodeError, ValueError):
        raise _AccessValidationError("URL query must be well formed") from None
    for key, _ in query_fields:
        normalized_key = key.casefold().replace("-", "_")
        if normalized_key in _SENSITIVE_QUERY_KEYS or normalized_key.endswith(
            _SENSITIVE_QUERY_SUFFIXES
        ):
            return True
    return False


def _safe_locator(value: str) -> str:
    """Keep URL-like locators free of filesystem and credential material.

    The actual URL/DNS/redirect policy belongs to Network.  This boundary only
    prevents an adapter from accidentally handing a user-visible model an
    absolute local path, URL userinfo, or control characters.
    """

    candidate = _nonblank(value, field_name="locator")
    if _ANY_CONTROL_CHARACTER.search(candidate) is not None:
        raise _AccessValidationError("locator must not contain control characters")
    if candidate.startswith(("/", "\\", "~")) or _WINDOWS_ABSOLUTE_PATH.match(candidate):
        raise _AccessValidationError("locator must not be an absolute filesystem path")
    if "\\" in candidate:
        raise _AccessValidationError("locator must not contain backslashes")
    try:
        parsed = urlsplit(candidate)
    except ValueError as error:
        raise _AccessValidationError("locator must be a safe URL-like value") from error
    if (
        parsed.scheme.lower() == "file"
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise _AccessValidationError("locator must not contain credentials or a file URL")
    if has_sensitive_query_parameter(parsed.query):
        raise _AccessValidationError("locator must not contain credential query parameters")
    return candidate


def _decode_json_bytes(value: object) -> object:
    """Decode the base64 representation emitted for nested bytes in JSON."""

    if not isinstance(value, str):
        return value
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        raise _AccessValidationError("byte values must use canonical base64 JSON") from None


class Header(_AccessModel):
    """A non-credential HTTP field that can cross the transport boundary."""

    name: str
    value: str = Field(repr=False)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        if _HEADER_NAME.fullmatch(value) is None:
            raise _AccessValidationError("must be an HTTP field-name token")
        normalized = _normalise_header_name(value)
        if normalized in _NETWORK_OWNED_HEADER_NAMES:
            raise _AccessValidationError("network-owned headers are not model data")
        if any(marker in normalized for marker in _SECRET_HEADER_NAME_MARKERS):
            raise _AccessValidationError("credential-bearing headers are not model data")
        return value

    @field_validator("value")
    @classmethod
    def validate_value(cls, value: str) -> str:
        if _HEADER_CONTROL_CHARACTER.search(value) is not None:
            raise _AccessValidationError("must not contain control characters")
        return value


class BoundedByteStream(_AccessModel):
    """A bounded byte sequence returned by HTTP or a Browser download."""

    chunks: tuple[bytes, ...] = Field(repr=False)
    media_type: str
    final_locator: str
    size: int = Field(strict=True, ge=0)

    @field_validator("chunks", mode="before")
    @classmethod
    def normalize_chunks(cls, value: object) -> object:
        if isinstance(value, list):
            return tuple(_decode_json_bytes(item) for item in value)
        return value

    @field_validator("media_type")
    @classmethod
    def validate_media_type(cls, value: str) -> str:
        return _nonblank(value, field_name="media_type")

    @field_validator("final_locator")
    @classmethod
    def validate_final_locator(cls, value: str) -> str:
        return _safe_locator(value)

    @model_validator(mode="after")
    def validate_size(self) -> "BoundedByteStream":
        if self.size != sum(len(chunk) for chunk in self.chunks):
            raise _AccessValidationError("size must match the byte chunks")
        return self


class TransportRequest(_AccessModel):
    """A safe request envelope understood by an injected transport."""

    method: str
    url: str
    headers: tuple[Header, ...]
    body: bytes | None = Field(repr=False)
    timeout_seconds: float = Field(strict=True, gt=0)
    max_response_bytes: int = Field(strict=True, ge=1)

    @field_validator("method")
    @classmethod
    def validate_method(cls, value: str) -> str:
        if _HEADER_NAME.fullmatch(value) is None:
            raise _AccessValidationError("must be an HTTP method token")
        return value

    @field_validator("url")
    @classmethod
    def validate_url_text(cls, value: str) -> str:
        return _safe_locator(value)

    @field_validator("headers", mode="before")
    @classmethod
    def normalize_headers(cls, value: object) -> object:
        if isinstance(value, list):
            return tuple(value)
        return value


class TransportResponse(_AccessModel):
    """A protocol-neutral response with no client/session object."""

    status: int = Field(strict=True, ge=100, le=599)
    final_url: str
    headers: tuple[Header, ...]
    body: bytes = Field(repr=False)

    @field_validator("body", mode="before")
    @classmethod
    def decode_json_body(cls, value: object) -> object:
        return _decode_json_bytes(value)

    @field_validator("final_url")
    @classmethod
    def validate_final_url_text(cls, value: str) -> str:
        return _safe_locator(value)

    @field_validator("headers", mode="before")
    @classmethod
    def normalize_headers(cls, value: object) -> object:
        if isinstance(value, list):
            return tuple(value)
        return value


class BrowserRequest(_AccessModel):
    """A minimal browser navigation/download request.

    Browser is a peer of HTTP at the Network boundary.  Provider-specific
    selector/click logic and all browser objects stay in the adapter; this
    value only carries a safe destination and resource bounds.
    """

    url: str
    timeout_seconds: float = Field(strict=True, gt=0)
    max_response_bytes: int = Field(strict=True, ge=1)

    @field_validator("url")
    @classmethod
    def validate_url_text(cls, value: str) -> str:
        return _safe_locator(value)


class AccessFailure(_AccessModel):
    """A stable, de-identified failure from an access boundary."""

    code: str = Field(repr=False, max_length=128)
    reason: str = Field(repr=False, max_length=512)
    action: str = Field(repr=False, max_length=512)
    retryable: bool = Field(strict=True)

    @field_validator("code", "reason", "action")
    @classmethod
    def validate_failure_text(cls, value: str) -> str:
        candidate = _nonblank(value, field_name="failure field")
        if _ANY_CONTROL_CHARACTER.search(candidate) is not None:
            raise _AccessValidationError("failure text must not contain control characters")
        if _looks_like_private_access_detail(candidate):
            raise _AccessValidationError("failure text must be de-identified")
        return candidate


def _looks_like_private_access_detail(value: str) -> bool:
    """Reject obvious URL/header/path/credential details at the failure edge."""

    candidate = value.casefold()
    if "://" in candidate or candidate.startswith(("/", "\\", "file:")):
        return True
    if _WINDOWS_ABSOLUTE_PATH.match(value):
        return True
    if "authorization:" in candidate or "cookie:" in candidate:
        return True
    if "bearer " in candidate:
        return True
    return any(
        f"{key}=" in candidate or f"{key}:" in candidate
        for key in (
            "api_key",
            "apikey",
            "access_token",
            "authorization",
            "cookie",
            "email",
            "password",
            "secret",
            "signature",
            "token",
        )
    )


AccessResponse: TypeAlias = TransportResponse | BoundedByteStream
AccessResult: TypeAlias = AccessResponse | AccessFailure
BrowserResult: TypeAlias = BoundedByteStream | AccessFailure
HttpResult: TypeAlias = TransportResponse | AccessFailure


__all__ = (
    "AccessFailure",
    "AccessResponse",
    "AccessResult",
    "BoundedByteStream",
    "BrowserRequest",
    "BrowserResult",
    "Header",
    "HttpResult",
    "TransportRequest",
    "TransportResponse",
    "has_sensitive_query_parameter",
)
