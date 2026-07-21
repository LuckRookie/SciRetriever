"""Generic loss-aware enrichment API."""

from .models import EnrichmentResult, Summarizer
from .projection import SearchProjectionBuilder
from .service import GenericEnricher, build_summary_input, deterministic_summary, normalize_tags

__all__ = (
    "EnrichmentResult", "GenericEnricher", "SearchProjectionBuilder", "Summarizer",
    "build_summary_input", "deterministic_summary", "normalize_tags",
)
