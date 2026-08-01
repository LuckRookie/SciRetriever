"""Fresh catalog schema initialization without migration compatibility."""

from __future__ import annotations

from sciretriever.catalog.bootstrap import initialize_schema
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.errors import CatalogError


def initialize_catalog(catalog: CatalogEngine) -> None:
    """Initialize an empty writable catalog exactly once."""
    if not isinstance(catalog, CatalogEngine):
        raise TypeError("catalog must be a CatalogEngine")
    if catalog.read_only:
        raise CatalogError("Cannot initialize a read-only catalog")

    with catalog.critical_transaction() as connection:
        tables = connection.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).all()
        if tables:
            raise CatalogError("Catalog initialization requires an empty database")
        initialize_schema(connection)


__all__ = ("initialize_catalog",)
