"""Provider-neutral DTOs returned by vendor integrations."""

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class VendorWork:
    raw_id: str
    title: str | None = None
    abstract: str | None = None
    doi: str | None = None
    authors: tuple[str, ...] = ()
    year: int | None = None
    publication_date: str | None = None
    citation_count: int | None = None
    canonical_url: str | None = None
    open_access_url: str | None = None
    venue: str | None = None
    identifiers: tuple[tuple[str, str], ...] = ()
    keywords: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class VendorPage:
    works: tuple[VendorWork, ...]
    next_cursor: str | None = None
    total_results: int | None = None


__all__ = ("VendorPage", "VendorWork")
