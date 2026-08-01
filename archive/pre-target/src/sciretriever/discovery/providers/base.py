"""Protocols shared by discovery provider adapters."""

from __future__ import annotations

from typing import Protocol

from sciretriever.core.contracts import SearchSpec
from sciretriever.discovery.models import ProviderRecord


class DiscoveryProvider(Protocol):
    """A provider adapter that returns ordered immutable raw records."""

    @property
    def name(self) -> str:
        ...

    def search(self, spec: SearchSpec) -> tuple[ProviderRecord, ...]:
        ...


__all__ = ("DiscoveryProvider",)
