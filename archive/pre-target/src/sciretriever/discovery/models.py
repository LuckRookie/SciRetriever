"""Provider-neutral immutable records produced by discovery adapters."""

from __future__ import annotations

from dataclasses import dataclass

from sciretriever.core.contracts import CandidateMetadata, Identifier, SearchSpec


@dataclass(frozen=True, slots=True)
class ProviderRecord:
    provider: str
    rank: int
    raw_identifiers: tuple[tuple[str, str], ...]
    title: str | None = None
    abstract: str | None = None
    authors: tuple[str, ...] = ()
    year: int | None = None
    venue: str | None = None
    keywords: tuple[str, ...] = ()
    publisher: str | None = None
    publication_date: str | None = None
    open_access_status: str | None = None
    provider_record_id: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.provider, str) or not self.provider.strip():
            raise ValueError("provider must be a non-blank string")
        if not isinstance(self.rank, int) or isinstance(self.rank, bool):
            raise TypeError("rank must be an integer")
        if self.rank < 1:
            raise ValueError("rank must be greater than zero")
        if not isinstance(self.raw_identifiers, tuple):
            raise TypeError("raw_identifiers must be a tuple")
        for identifier in self.raw_identifiers:
            if (
                not isinstance(identifier, tuple)
                or len(identifier) != 2
                or not all(isinstance(value, str) for value in identifier)
            ):
                raise TypeError("raw_identifiers must contain (namespace, value) string tuples")
        if not isinstance(self.authors, tuple) or not all(
            isinstance(author, str) for author in self.authors
        ):
            raise TypeError("authors must be a tuple of strings")
        if not isinstance(self.keywords, tuple) or not all(
            isinstance(keyword, str) for keyword in self.keywords
        ):
            raise TypeError("keywords must be a tuple of strings")
        if self.year is not None and (
            not isinstance(self.year, int) or isinstance(self.year, bool)
        ):
            raise TypeError("year must be an integer or None")
        if self.publisher is not None and not isinstance(self.publisher, str):
            raise TypeError("publisher must be a string or None")
        if self.publication_date is not None and not isinstance(
            self.publication_date, str
        ):
            raise TypeError("publication_date must be a string or None")
        if self.open_access_status is not None and not isinstance(
            self.open_access_status, str
        ):
            raise TypeError("open_access_status must be a string or None")
        if self.provider_record_id is not None and not isinstance(
            self.provider_record_id, str
        ):
            raise TypeError("provider_record_id must be a string or None")


@dataclass(frozen=True, slots=True)
class CandidateRetrievalRequest:
    spec: SearchSpec
    precedence: tuple[str, ...]
    provider_timeout_seconds: float = 30.0
    max_concurrency: int = 8

    def __post_init__(self) -> None:
        if set(self.precedence) != set(self.spec.sources) or len(
            self.precedence
        ) != len(self.spec.sources):
            raise ValueError("precedence must contain every source exactly once")
        if self.provider_timeout_seconds <= 0:
            raise ValueError("provider_timeout_seconds must be positive")
        if self.max_concurrency < 1:
            raise ValueError("max_concurrency must be positive")


@dataclass(frozen=True, slots=True)
class ProviderFailure:
    provider: str
    category: str
    message: str


@dataclass(frozen=True, slots=True)
class CandidateObservation:
    provider: str
    rank: int
    provider_record_id: str
    identifiers: tuple[Identifier, ...]
    metadata: CandidateMetadata
    publisher: str | None
    publication_date: str | None
    open_access_status: str | None


@dataclass(frozen=True, slots=True)
class RetrievedCandidate:
    identifiers: tuple[Identifier, ...]
    metadata: CandidateMetadata
    publisher: str | None
    publication_date: str | None
    open_access_status: str | None
    observations: tuple[CandidateObservation, ...]
    providers: tuple[str, ...]
    source_ranks: tuple[tuple[str, int], ...]
    quality_reasons: tuple[str, ...]
    identity_ambiguity_reasons: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class CandidateRetrievalResult:
    candidates: tuple[RetrievedCandidate, ...]
    failures: tuple[ProviderFailure, ...]
    all_providers_failed: bool = False


@dataclass(frozen=True, slots=True)
class Candidate:
    provider: str
    rank: int
    identifiers: tuple[Identifier, ...]
    metadata: CandidateMetadata

    def __post_init__(self) -> None:
        if not isinstance(self.provider, str) or not self.provider.strip():
            raise ValueError("provider must be a non-blank string")
        if not isinstance(self.rank, int) or isinstance(self.rank, bool):
            raise TypeError("rank must be an integer")
        if self.rank < 1:
            raise ValueError("rank must be greater than zero")
        if not isinstance(self.identifiers, tuple) or not all(
            isinstance(identifier, Identifier) for identifier in self.identifiers
        ):
            raise TypeError("identifiers must be a tuple of Identifier values")
        if not isinstance(self.metadata, CandidateMetadata):
            raise TypeError("metadata must be CandidateMetadata")
        if self.metadata.title is None and not self.identifiers:
            raise ValueError("a candidate requires a title or at least one identifier")


@dataclass(frozen=True, slots=True)
class MergedCandidate:
    identifiers: tuple[Identifier, ...]
    metadata: CandidateMetadata
    providers: tuple[str, ...]
    source_ranks: tuple[tuple[str, int], ...]
    needs_review: bool
    review_reasons: tuple[str, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.identifiers, tuple) or not all(
            isinstance(identifier, Identifier) for identifier in self.identifiers
        ):
            raise TypeError("identifiers must be a tuple of Identifier values")
        if not isinstance(self.metadata, CandidateMetadata):
            raise TypeError("metadata must be CandidateMetadata")
        if not isinstance(self.providers, tuple) or not self.providers or not all(
            isinstance(provider, str) and provider.strip() for provider in self.providers
        ):
            raise TypeError("providers must be a non-empty tuple of provider names")
        if not isinstance(self.source_ranks, tuple) or not all(
            isinstance(item, tuple)
            and len(item) == 2
            and isinstance(item[0], str)
            and isinstance(item[1], int)
            and not isinstance(item[1], bool)
            and item[1] > 0
            for item in self.source_ranks
        ):
            raise TypeError("source_ranks must contain (provider, rank) tuples")
        if not isinstance(self.needs_review, bool):
            raise TypeError("needs_review must be a boolean")
        if not isinstance(self.review_reasons, tuple) or not all(
            isinstance(reason, str) and reason for reason in self.review_reasons
        ):
            raise TypeError("review_reasons must be a tuple of non-blank strings")
        if self.needs_review != bool(self.review_reasons):
            raise ValueError("needs_review must match whether review_reasons is non-empty")
        if self.metadata.title is None and not self.identifiers:
            raise ValueError("a merged candidate requires a title or at least one identifier")


__all__ = (
    "Candidate",
    "CandidateObservation",
    "CandidateRetrievalRequest",
    "CandidateRetrievalResult",
    "MergedCandidate",
    "ProviderFailure",
    "ProviderRecord",
    "RetrievedCandidate",
)
