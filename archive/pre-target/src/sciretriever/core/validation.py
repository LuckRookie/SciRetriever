"""Small neutral validators shared by immutable core contracts."""

from __future__ import annotations

from pathlib import PurePosixPath
import re
import unicodedata
from urllib.parse import urlsplit


_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_MEDIA_TYPE = re.compile(
    r"^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$"
)
_MEDIA_COMPONENT = r"[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*"
_MIME_TOKEN = r"[A-Za-z0-9!#$%&'*+.^_`|~-]+"
_MIME_QUOTED_VALUE = r'"(?:[\t !#-\[\]-~]|\\[\t -~])+"'
_PARAMETERIZED_MEDIA_TYPE = re.compile(
    rf"^[ \t]*({_MEDIA_COMPONENT})/({_MEDIA_COMPONENT})"
    rf"(?:[ \t]*;[ \t]*{_MIME_TOKEN}[ \t]*=[ \t]*"
    rf"(?:{_MIME_TOKEN}|{_MIME_QUOTED_VALUE}))*[ \t]*$"
)
_TOKEN = re.compile(r"^[a-z][a-z0-9_]*$")


def require_string(value: str, field_name: str, *, allow_blank: bool = False) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    normalized = unicodedata.normalize("NFC", value)
    if not allow_blank and not normalized.strip():
        raise ValueError(f"{field_name} must not be blank")
    return normalized


def normalize_content_text(value: str, field_name: str, *, allow_blank: bool = False) -> str:
    value = require_string(value, field_name, allow_blank=True)
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    if not allow_blank and not normalized.strip():
        raise ValueError(f"{field_name} must not be blank")
    return normalized


def validate_sha256(value: str, field_name: str = "sha256") -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    if _SHA256.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be a lowercase 64-hex SHA-256")
    return value


def validate_media_type(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError("media_type must be a string")
    if _MEDIA_TYPE.fullmatch(value) is None:
        raise ValueError("media_type must be a lowercase MIME type without parameters")
    return value


def normalize_media_type(value: str) -> str:
    """Return the canonical base MIME type after validating all parameters."""
    if not isinstance(value, str):
        raise TypeError("media_type must be a string")
    match = _PARAMETERIZED_MEDIA_TYPE.fullmatch(value)
    if match is None:
        raise ValueError("media_type must be a valid MIME type with valid parameters")
    return validate_media_type(f"{match.group(1).lower()}/{match.group(2).lower()}")


def validate_storage_path(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError("storage_path must be a string")
    parsed = urlsplit(value)
    if not value or "\\" in value or parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        raise ValueError("storage_path must be a root-relative POSIX path")
    path = PurePosixPath(value)
    if path.is_absolute() or value != path.as_posix() or any(part in {"", ".", ".."} for part in value.split("/")):
        raise ValueError("storage_path must be normalized and must not contain traversal")
    return value


def validate_token(value: str, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    if _TOKEN.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be a lowercase neutral token")
    return value


def validate_nonnegative_int(value: int, field_name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{field_name} must be an integer")
    if value < 0:
        raise ValueError(f"{field_name} must be nonnegative")
    return value
