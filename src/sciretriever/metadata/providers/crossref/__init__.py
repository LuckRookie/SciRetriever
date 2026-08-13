"""Crossref Metadata search and exact-lookup production adapter."""

from .adapter import (
    POLITE_ACCESS_SCOPE,
    POLITE_BASELINE_ACCESS_POLICY,
    PUBLIC_ACCESS_SCOPE,
    PUBLIC_BASELINE_ACCESS_POLICY,
    CrossrefAdapter,
)

__all__ = (
    "CrossrefAdapter",
    "POLITE_ACCESS_SCOPE",
    "POLITE_BASELINE_ACCESS_POLICY",
    "PUBLIC_ACCESS_SCOPE",
    "PUBLIC_BASELINE_ACCESS_POLICY",
)
