"""Numbered transactional migration runner for catalog databases."""

from __future__ import annotations

from importlib import import_module
from types import ModuleType

from sqlalchemy.engine import Connection

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.errors import CatalogError


MIGRATION_MODULES = (
    "sciretriever.catalog.migrations.0001_initial",
    "sciretriever.catalog.migrations.0002_p3_asset_invariants",
)

_CREATE_LEDGER = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    revision TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    CONSTRAINT ck_schema_migrations_revision
        CHECK (length(revision) = 4 AND revision NOT GLOB '*[^0-9]*'),
    CONSTRAINT ck_schema_migrations_description
        CHECK (length(trim(description)) > 0),
    CONSTRAINT ck_schema_migrations_applied_at
        CHECK (
            length(applied_at) = 24
            AND applied_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        )
)
"""


def _migrations() -> tuple[ModuleType, ...]:
    migrations = tuple(import_module(name) for name in MIGRATION_MODULES)
    revisions = tuple(module.REVISION for module in migrations)
    if revisions != tuple(sorted(revisions)) or len(revisions) != len(set(revisions)):
        raise CatalogError("Catalog migrations must have unique ascending revisions")
    return migrations


def _applied_revisions(connection: Connection) -> frozenset[str]:
    rows = connection.exec_driver_sql(
        "SELECT revision FROM schema_migrations ORDER BY revision"
    )
    return frozenset(row[0] for row in rows)


def apply_migrations(catalog: CatalogEngine) -> tuple[str, ...]:
    """Apply pending migrations atomically and return applied revision numbers."""
    if not isinstance(catalog, CatalogEngine):
        raise TypeError("catalog must be a CatalogEngine")
    if catalog.read_only:
        raise CatalogError("Cannot migrate a read-only catalog")

    migrations = _migrations()
    known = frozenset(module.REVISION for module in migrations)
    applied_now: list[str] = []
    with catalog.critical_transaction() as connection:
        connection.exec_driver_sql(_CREATE_LEDGER)
        applied = _applied_revisions(connection)
        unknown = applied - known
        if unknown:
            revisions = ", ".join(sorted(unknown))
            raise CatalogError(f"Catalog contains unknown migration revisions: {revisions}")

        pending_seen = False
        for migration in migrations:
            if migration.REVISION not in applied:
                pending_seen = True
            elif pending_seen:
                raise CatalogError("Catalog migration ledger is not an ordered prefix")

        for migration in migrations:
            if migration.REVISION in applied:
                continue
            migration.upgrade(connection)
            connection.exec_driver_sql(
                "INSERT INTO schema_migrations (revision, description, applied_at) VALUES (?, ?, ?)",
                (migration.REVISION, migration.DESCRIPTION, utc_now_rfc3339()),
            )
            applied_now.append(migration.REVISION)
    return tuple(applied_now)


def applied_migrations(catalog: CatalogEngine) -> tuple[str, ...]:
    """Read the migration ledger without exposing SQLAlchemy metadata downstream."""
    if not isinstance(catalog, CatalogEngine):
        raise TypeError("catalog must be a CatalogEngine")
    with catalog.connect() as connection:
        exists = connection.exec_driver_sql(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
        ).first()
        if exists is None:
            return ()
        return tuple(
            row[0]
            for row in connection.exec_driver_sql(
                "SELECT revision FROM schema_migrations ORDER BY revision"
            )
        )
