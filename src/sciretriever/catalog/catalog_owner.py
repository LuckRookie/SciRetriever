"""Shared catalog ownership for writable repositories."""

from __future__ import annotations

from sciretriever.catalog.engine import CatalogEngine


class CatalogOwner:
    _catalog: CatalogEngine

    @property
    def catalog(self) -> CatalogEngine:
        return self._catalog


__all__ = ("CatalogOwner",)
