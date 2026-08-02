from __future__ import annotations

from sciretriever.kernel.errors import BoundaryError
from sciretriever.model.canonical_json import (
    CanonicalJsonInput,
    CanonicalJsonObject,
    CanonicalJsonScalar,
    CanonicalJsonValue,
    JsonOutput,
)
from sciretriever.model.canonical_json import (
    canonical_json_bytes as _canonical_json_bytes,
)
from sciretriever.model.canonical_json import (
    parse_canonical_json as _parse_canonical_json,
)


def parse_canonical_json(payload: str) -> CanonicalJsonValue:
    try:
        return _parse_canonical_json(payload)
    except ValueError as error:
        raise BoundaryError.for_field("payload", str(error)) from error


def canonical_json_bytes(value: CanonicalJsonValue) -> bytes:
    try:
        return _canonical_json_bytes(value)
    except ValueError as error:
        raise BoundaryError.for_field("payload", str(error)) from error


__all__ = (
    "CanonicalJsonInput",
    "CanonicalJsonObject",
    "CanonicalJsonScalar",
    "CanonicalJsonValue",
    "JsonOutput",
    "canonical_json_bytes",
    "parse_canonical_json",
)
