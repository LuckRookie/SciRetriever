"""Stable identifier helpers for public boundary contracts."""

from __future__ import annotations

import re
from uuid import UUID, uuid4


_CANONICAL_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


def validate_uuid(value: str, field_name: str = "UUID") -> str:
    """Return a canonical lowercase UUID string or raise a boundary error."""
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    if _CANONICAL_UUID.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be a canonical lowercase UUID")
    try:
        parsed = UUID(value)
    except ValueError as error:
        raise ValueError(f"{field_name} must be a valid UUID") from error
    if str(parsed) != value:
        raise ValueError(f"{field_name} must be a canonical lowercase UUID")
    return value


def new_uuid4() -> str:
    """Create a canonical lowercase UUIDv4 string."""
    return str(uuid4())
