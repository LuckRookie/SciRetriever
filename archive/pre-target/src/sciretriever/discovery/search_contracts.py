"""Typed request and result contracts for catalog-writing metadata search."""

from __future__ import annotations

from dataclasses import dataclass
import re

from sciretriever.catalog.records import WorkVersionRecord
from sciretriever.core.contracts import CandidateMetadata, Identifier, SearchSpec


DEFAULT_SEARCH_LIMIT = 1000
DEFAULT_PROVIDER_TIMEOUT_SECONDS = 30.0
DEFAULT_MAX_CONCURRENCY = 8
_DOI_PATTERN = re.compile(r"10\.\d{4,9}/[-._;()/:a-z0-9]+", re.IGNORECASE)


def validate_provider_selection(
    providers: tuple[str, ...],
    precedence: tuple[str, ...],
    provider_timeout_seconds: float,
    max_concurrency: int,
) -> None:
    if not providers or len(set(providers)) != len(providers):
        raise ValueError("providers must be a non-empty tuple of unique names")
    if set(precedence) != set(providers) or len(precedence) != len(providers):
        raise ValueError("precedence must contain every selected provider exactly once")
    if (
        not isinstance(provider_timeout_seconds, (int, float))
        or isinstance(provider_timeout_seconds, bool)
        or provider_timeout_seconds <= 0
    ):
        raise ValueError("provider_timeout_seconds must be positive")
    if (
        not isinstance(max_concurrency, int)
        or isinstance(max_concurrency, bool)
        or max_concurrency < 1
    ):
        raise ValueError("max_concurrency must be a positive integer")


@dataclass(frozen=True, slots=True)
class MetadataSearchRequest:
    query: str
    providers: tuple[str, ...]
    precedence: tuple[str, ...]
    limit: int = DEFAULT_SEARCH_LIMIT
    provider_timeout_seconds: float = DEFAULT_PROVIDER_TIMEOUT_SECONDS
    max_concurrency: int = DEFAULT_MAX_CONCURRENCY
    filters: tuple[tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.query, str) or not self.query.strip():
            raise ValueError("query must be a non-blank string")
        validate_provider_selection(
            self.providers,
            self.precedence,
            self.provider_timeout_seconds,
            self.max_concurrency,
        )
        if not isinstance(self.limit, int) or isinstance(self.limit, bool) or self.limit < 1:
            raise ValueError("limit must be a positive integer")
        normalized_filters = SearchSpec(
            self.query, self.providers, self.limit, self.filters
        ).filters
        values = dict(normalized_filters)
        if values.keys() - {"year_from", "year_to"}:
            raise ValueError("unsupported search filter")
        years: dict[str, int] = {}
        for name, value in values.items():
            if not value.isascii() or not value.isdecimal() or not 1 <= int(value) <= 9999:
                raise ValueError(f"{name} must be a year from 1 through 9999")
            years[name] = int(value)
        if years.get("year_from", 1) > years.get("year_to", 9999):
            raise ValueError("year_from must not be later than year_to")
        object.__setattr__(self, "filters", normalized_filters)


@dataclass(frozen=True, slots=True)
class MetadataSearchFailure:
    provider: str
    category: str
    message: str


@dataclass(frozen=True, slots=True)
class MetadataSearchResult:
    work_version: WorkVersionRecord
    providers: tuple[str, ...]
    identifiers: tuple[Identifier, ...]
    metadata: CandidateMetadata


@dataclass(frozen=True, slots=True)
class MetadataSearchOutput:
    results: tuple[MetadataSearchResult, ...]
    failures: tuple[MetadataSearchFailure, ...]


@dataclass(frozen=True, slots=True)
class ExactMetadataRequest:
    doi: str
    providers: tuple[str, ...]
    precedence: tuple[str, ...]
    provider_timeout_seconds: float = DEFAULT_PROVIDER_TIMEOUT_SECONDS
    max_concurrency: int = DEFAULT_MAX_CONCURRENCY

    def __post_init__(self) -> None:
        normalized_doi = Identifier("doi", self.doi).value
        if _DOI_PATTERN.fullmatch(normalized_doi) is None:
            raise ValueError("invalid DOI")
        object.__setattr__(self, "doi", normalized_doi)
        validate_provider_selection(
            self.providers,
            self.precedence,
            self.provider_timeout_seconds,
            self.max_concurrency,
        )


@dataclass(frozen=True, slots=True)
class ExactMetadataOutput:
    doi: str
    result: MetadataSearchResult | None
    failures: tuple[MetadataSearchFailure, ...]


__all__ = (
    "DEFAULT_MAX_CONCURRENCY",
    "DEFAULT_PROVIDER_TIMEOUT_SECONDS",
    "DEFAULT_SEARCH_LIMIT",
    "ExactMetadataOutput",
    "ExactMetadataRequest",
    "MetadataSearchFailure",
    "MetadataSearchOutput",
    "MetadataSearchRequest",
    "MetadataSearchResult",
)
