"""Small, side-effect-free values shared by the target Model contracts.

The types in this module deliberately describe representation only.  They do not
resolve identifiers, inspect the filesystem, read configuration, or make any
decision about a literature record.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta
from enum import Enum, unique
from pathlib import PurePosixPath
from urllib.parse import urlsplit

from pydantic import ConfigDict, RootModel, field_validator

_CANONICAL_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_RFC3339_UTC = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2})T(?P<time>\d{2}:\d{2}:\d{2})"
    r"(?P<fraction>\.\d+)?Z$"
)


class _StringRoot(RootModel[str]):
    """An immutable, strict string value object with deterministic string output."""

    model_config = ConfigDict(frozen=True, hide_input_in_errors=True, strict=True)

    def __hash__(self) -> int:
        return hash((type(self), self.root))

    def __str__(self) -> str:
        return self.root


class InternalId(_StringRoot):
    """A canonical UUID used for an internal domain identity.

    The base value intentionally carries no domain meaning.  Domain-specific
    IDs below are nominal wrappers so that one kind of identity cannot be
    accidentally passed where another is expected.
    """

    __hash__ = _StringRoot.__hash__

    @field_validator("root")
    @classmethod
    def validate_id(cls, value: str) -> str:
        if _CANONICAL_UUID.fullmatch(value) is None:
            raise ValueError("must be a canonical lowercase UUID")
        return value


class ProvenanceId(InternalId):
    __hash__ = InternalId.__hash__


class MetaLiteratureId(InternalId):
    __hash__ = InternalId.__hash__


class LiteratureId(InternalId):
    __hash__ = InternalId.__hash__


class ObservationId(InternalId):
    __hash__ = InternalId.__hash__


class ReferenceId(InternalId):
    __hash__ = InternalId.__hash__


class AssetId(InternalId):
    __hash__ = InternalId.__hash__


class LiteratureAssetId(InternalId):
    __hash__ = InternalId.__hash__


class DiscoveryRunId(InternalId):
    __hash__ = InternalId.__hash__


class Sha256(_StringRoot):
    """A lowercase hexadecimal SHA-256 digest."""

    __hash__ = _StringRoot.__hash__

    @field_validator("root")
    @classmethod
    def validate_sha256(cls, value: str) -> str:
        if _SHA256.fullmatch(value) is None:
            raise ValueError("must be lowercase 64-hex SHA-256")
        return value


def sha256_digest(value: bytes) -> Sha256:
    """Return the SHA-256 digest for an exact byte sequence."""

    if not isinstance(value, bytes):
        raise TypeError("value must be bytes")
    return Sha256(hashlib.sha256(value).hexdigest())


class RelativeArtifactPath(_StringRoot):
    """A canonical, relative POSIX path within the configured artifact store.

    This is a representation boundary, not a filesystem path object.  It does
    not resolve symlinks or access the filesystem; callers must perform those
    checks at the storage boundary.
    """

    __hash__ = _StringRoot.__hash__

    @field_validator("root")
    @classmethod
    def validate_path(cls, value: str) -> str:
        try:
            parsed = urlsplit(value)
            path = PurePosixPath(value)
        except ValueError as error:
            raise ValueError("must be a normalized relative POSIX path") from error

        has_control_character = any(
            ord(character) < 32 or ord(character) == 127 for character in value
        )
        invalid = (
            not value
            or has_control_character
            or "\\" in value
            or bool(parsed.scheme or parsed.netloc or parsed.query or parsed.fragment)
            or path.is_absolute()
            or value != path.as_posix()
            or any(part in {"", ".", ".."} for part in value.split("/"))
        )
        if invalid:
            raise ValueError("must be a normalized relative POSIX path")
        return value


class UtcTimestamp(_StringRoot):
    """An RFC 3339 timestamp whose offset is UTC and whose output uses ``Z``.

    String input must already use an RFC 3339 UTC representation.  An aware
    ``datetime`` is accepted as a convenience at the Python boundary and is
    immediately converted to the same canonical string representation.  Naive
    and non-UTC datetimes are rejected instead of being silently interpreted.
    """

    __hash__ = _StringRoot.__hash__

    @field_validator("root", mode="before")
    @classmethod
    def normalize_timestamp(cls, value: object) -> str:
        if isinstance(value, datetime):
            if value.tzinfo is None or value.utcoffset() != timedelta(0):
                raise ValueError("must be an aware UTC timestamp")
            candidate = value.isoformat(timespec="microseconds").replace("+00:00", "Z")
            if "." in candidate:
                prefix, fraction = candidate[:-1].split(".", maxsplit=1)
                candidate = f"{prefix}.{fraction.rstrip('0')}Z"
                if candidate.endswith(".Z"):
                    candidate = candidate[:-2] + "Z"
            return candidate
        if not isinstance(value, str):
            raise TypeError("must be an RFC 3339 UTC timestamp")

        candidate = value
        if candidate.endswith("+00:00"):
            candidate = candidate[:-6] + "Z"
        if _RFC3339_UTC.fullmatch(candidate) is None:
            raise ValueError("must be RFC3339 UTC ending in Z")
        try:
            parsed = datetime.fromisoformat(candidate[:-1] + "+00:00")
        except ValueError as error:
            raise ValueError("must be a valid UTC date-time") from error
        if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
            raise ValueError("must be an aware UTC timestamp")
        return candidate


@unique
class SourceKind(str, Enum):
    """The closed set of source contexts understood by the target Model."""

    METADATA_PROVIDER = "metadata-provider"
    ASSET_PROVIDER = "asset-provider"
    PARSER = "parser"
    ANALYSIS = "analysis"
    USER = "user"


__all__ = (
    "AssetId",
    "DiscoveryRunId",
    "InternalId",
    "LiteratureAssetId",
    "LiteratureId",
    "MetaLiteratureId",
    "ObservationId",
    "ProvenanceId",
    "ReferenceId",
    "RelativeArtifactPath",
    "Sha256",
    "SourceKind",
    "UtcTimestamp",
    "sha256_digest",
)
