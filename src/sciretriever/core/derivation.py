"""Deterministic identities for replayable processing derivations."""

from __future__ import annotations

import hashlib
import json
import re
from uuid import UUID, uuid5


SCIRETRIEVER_DERIVATION_NAMESPACE = UUID("10c6af62-ddf8-5a87-9eb7-d500c168c406")
_KIND = re.compile(r"^[a-z][a-z0-9_]*$")


def canonical_json_bytes(value: object) -> bytes:
    """Return compact ASCII JSON bytes suitable for hashing and persistence."""

    try:
        encoded = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as error:
        raise ValueError("value must be canonical-JSON serializable") from error
    return encoded.encode("utf-8")


def canonical_sha256(value: object) -> str:
    """Hash the canonical JSON representation of a value."""

    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def stable_derivation_id(kind: str, key: object) -> str:
    """Return a stable UUIDv5 for a versioned derivation key."""

    if not isinstance(kind, str):
        raise TypeError("kind must be a string")
    if _KIND.fullmatch(kind) is None:
        raise ValueError("kind must be a lowercase token")
    name = f"sciretriever:v1:{kind}:{canonical_sha256(key)}"
    return str(uuid5(SCIRETRIEVER_DERIVATION_NAMESPACE, name))


__all__ = (
    "SCIRETRIEVER_DERIVATION_NAMESPACE",
    "canonical_json_bytes",
    "canonical_sha256",
    "stable_derivation_id",
)
