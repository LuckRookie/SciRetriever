"""Deterministic SQLite schema manifest for the Storage boundary.

The shared technical tables, Literature-owned relations, and DiscoveryRun
relations are combined here as the one manifest consumed by :mod:`engine`.
There is intentionally no migration path, ORM dependency, JSON fallback, or
second schema entry point.
"""

from __future__ import annotations

import hashlib
from typing import Final

from .schema_discovery import (
    DISCOVERY_SCHEMA_INDEXES,
    DISCOVERY_SCHEMA_MANIFEST,
    DISCOVERY_SCHEMA_TABLES,
    DISCOVERY_SCHEMA_TRIGGERS,
)
from .schema_literature import (
    LITERATURE_SCHEMA_INDEXES,
    LITERATURE_SCHEMA_MANIFEST,
    LITERATURE_SCHEMA_TABLES,
)

SCHEMA_PRODUCT: Final[str] = "sciretriever"
SCHEMA_VERSION: Final[int] = 1

_SCHEMA_IDENTITY_DDL: Final[str] = (
    "CREATE TABLE schema_identity("
    "singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),"
    "product TEXT NOT NULL CHECK(product='sciretriever'),"
    "schema_version INTEGER NOT NULL CHECK(schema_version=1),"
    "schema_fingerprint TEXT NOT NULL CHECK(length(schema_fingerprint)=64 AND "
    "schema_fingerprint=lower(schema_fingerprint) AND "
    "schema_fingerprint NOT GLOB '*[^0-9a-f]*'),"
    "created_at TEXT NOT NULL CHECK(length(trim(created_at))>0)"
    ") STRICT"
)

_ARTIFACT_OBJECTS_DDL: Final[str] = (
    "CREATE TABLE artifact_objects("
    "artifact_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(artifact_id))>0),"
    "sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256=lower(sha256) AND "
    "sha256 NOT GLOB '*[^0-9a-f]*'),"
    "byte_size INTEGER NOT NULL CHECK(typeof(byte_size)='integer' AND byte_size>0),"
    "media_type TEXT NOT NULL CHECK(length(trim(media_type))>0),"
    "relative_path TEXT NOT NULL UNIQUE CHECK(length(trim(relative_path))>0 AND "
    "relative_path NOT LIKE '/%' AND relative_path NOT LIKE '%\\\\%' AND "
    "relative_path NOT LIKE '%//%' AND relative_path NOT LIKE '../%' AND "
    "relative_path NOT LIKE '%/../%' AND relative_path NOT LIKE './%' AND "
    "relative_path NOT LIKE '%/./%' AND relative_path NOT IN ('.','..')) ,"
    "UNIQUE(sha256,byte_size),"
    "UNIQUE(relative_path,sha256,byte_size,media_type)"
    ") STRICT"
)

_PROVENANCES_DDL: Final[str] = (
    "CREATE TABLE provenances("
    "provenance_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(provenance_id))>0),"
    "source_kind TEXT NOT NULL CHECK(source_kind IN "
    "('metadata-provider','asset-provider','parser','analysis','user')),"
    "source_name TEXT NOT NULL CHECK(length(trim(source_name))>0),"
    "source_record_id TEXT CHECK(source_record_id IS NULL OR length(trim(source_record_id))>0),"
    "observed_at TEXT NOT NULL CHECK(length(trim(observed_at))>0),"
    "input_sha256 TEXT CHECK(input_sha256 IS NULL OR "
    "(length(input_sha256)=64 AND input_sha256=lower(input_sha256) AND "
    "input_sha256 NOT GLOB '*[^0-9a-f]*')),"
    "parameters_sha256 TEXT CHECK(parameters_sha256 IS NULL OR "
    "(length(parameters_sha256)=64 AND parameters_sha256=lower(parameters_sha256) AND "
    "parameters_sha256 NOT GLOB '*[^0-9a-f]*'))"
    ") STRICT"
)

SCHEMA_MANIFEST: Final[tuple[str, ...]] = (
    _SCHEMA_IDENTITY_DDL,
    _ARTIFACT_OBJECTS_DDL,
    _PROVENANCES_DDL,
    *LITERATURE_SCHEMA_MANIFEST,
    *DISCOVERY_SCHEMA_MANIFEST,
)

SCHEMA_FINGERPRINT: Final[str] = hashlib.sha256(
    "\n".join(SCHEMA_MANIFEST).encode("utf-8")
).hexdigest()

SCHEMA_TABLES: Final[tuple[str, ...]] = (
    "schema_identity",
    "artifact_objects",
    "provenances",
    *LITERATURE_SCHEMA_TABLES,
    *DISCOVERY_SCHEMA_TABLES,
)

SCHEMA_INDEXES: Final[tuple[str, ...]] = (
    *LITERATURE_SCHEMA_INDEXES,
    *DISCOVERY_SCHEMA_INDEXES,
)

SCHEMA_TRIGGERS: Final[tuple[str, ...]] = (*DISCOVERY_SCHEMA_TRIGGERS,)


def schema_fingerprint(manifest: tuple[str, ...] = SCHEMA_MANIFEST) -> str:
    """Return the deterministic SHA-256 fingerprint of a DDL manifest."""

    if type(manifest) is not tuple or not all(type(item) is str for item in manifest):
        raise TypeError("manifest must be a tuple of strings")
    return hashlib.sha256("\n".join(manifest).encode("utf-8")).hexdigest()


__all__ = (
    "SCHEMA_FINGERPRINT",
    "SCHEMA_INDEXES",
    "SCHEMA_MANIFEST",
    "SCHEMA_PRODUCT",
    "SCHEMA_TABLES",
    "SCHEMA_TRIGGERS",
    "SCHEMA_VERSION",
    "schema_fingerprint",
)
