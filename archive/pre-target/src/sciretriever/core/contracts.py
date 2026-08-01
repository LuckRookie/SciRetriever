"""Neutral, immutable wire contracts for SciRetriever v2 intake."""

from __future__ import annotations

from dataclasses import dataclass, field
import re
from typing import Any, ClassVar

from sciretriever.core.identifier_normalization import normalize_arxiv
from sciretriever.core.contract_support import (
    compact_json as _compact_json, fields as _fields, json_object as _json_object,
    mapping as _mapping, normalized_text as _normalized_text,
    optional_text as _optional_text, string_tuple as _string_tuple,
)


MANIFEST_ENTRY_SCHEMA_VERSION = "1"

IDENTIFIER_NAMESPACE_DOI = "doi"
IDENTIFIER_NAMESPACE_ARXIV = "arxiv"
IDENTIFIER_NAMESPACE_PMID = "pmid"
IDENTIFIER_NAMESPACE_URL = "url"
IDENTIFIER_NAMESPACE_OPENALEX = "openalex"
IDENTIFIER_NAMESPACE_S2 = "s2"

_DOI_PREFIX = re.compile(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", re.IGNORECASE)
@dataclass(frozen=True, slots=True)
class Identifier:
    namespace: str
    value: str

    _FIELDS: ClassVar[frozenset[str]] = frozenset({"namespace", "value"})

    def __post_init__(self) -> None:
        namespace = _normalized_text(self.namespace, "namespace").lower()
        value = _normalized_text(self.value, "identifier value")
        if namespace == IDENTIFIER_NAMESPACE_DOI:
            value = _DOI_PREFIX.sub("", value).strip().lower()
            if not value:
                raise ValueError("DOI value must not be blank")
        elif namespace == IDENTIFIER_NAMESPACE_ARXIV:
            value = normalize_arxiv(value)
            if not value:
                raise ValueError("arXiv value must not be blank")
        object.__setattr__(self, "namespace", namespace)
        object.__setattr__(self, "value", value)

    def to_dict(self) -> dict[str, str]:
        return {"namespace": self.namespace, "value": self.value}

    @classmethod
    def from_dict(cls, data: object) -> Identifier:
        values = _mapping(data, cls.__name__)
        _fields(values, cls.__name__, cls._FIELDS)
        return cls(namespace=values["namespace"], value=values["value"])


@dataclass(frozen=True, slots=True)
class CandidateMetadata:
    title: str | None = None
    abstract: str | None = None
    authors: tuple[str, ...] = ()
    year: int | None = None
    venue: str | None = None
    keywords: tuple[str, ...] = ()

    _FIELDS: ClassVar[frozenset[str]] = frozenset(
        {"title", "abstract", "authors", "year", "venue", "keywords"}
    )

    def __post_init__(self) -> None:
        if self.year is not None and (not isinstance(self.year, int) or isinstance(self.year, bool)):
            raise TypeError("year must be an integer or None")
        object.__setattr__(self, "title", _optional_text(self.title, "title"))
        object.__setattr__(self, "abstract", _optional_text(self.abstract, "abstract"))
        object.__setattr__(self, "authors", _string_tuple(self.authors, "authors"))
        object.__setattr__(self, "venue", _optional_text(self.venue, "venue"))
        object.__setattr__(self, "keywords", _string_tuple(self.keywords, "keywords"))

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "abstract": self.abstract,
            "authors": list(self.authors),
            "year": self.year,
            "venue": self.venue,
            "keywords": list(self.keywords),
        }

    @classmethod
    def from_dict(cls, data: object) -> CandidateMetadata:
        values = _mapping(data, cls.__name__)
        _fields(values, cls.__name__, cls._FIELDS)
        authors = values["authors"]
        keywords = values["keywords"]
        if not isinstance(authors, list) or not isinstance(keywords, list):
            raise TypeError("authors and keywords must be arrays")
        return cls(
            title=values["title"],
            abstract=values["abstract"],
            authors=tuple(authors),
            year=values["year"],
            venue=values["venue"],
            keywords=tuple(keywords),
        )


@dataclass(frozen=True, slots=True)
class Provenance:
    providers: tuple[str, ...]
    retrieved_at: str
    intake_run_id: str

    _FIELDS: ClassVar[frozenset[str]] = frozenset({"providers", "retrieved_at", "intake_run_id"})

    def __post_init__(self) -> None:
        providers = _string_tuple(self.providers, "providers")
        if not providers:
            raise ValueError("providers must not be empty")
        object.__setattr__(self, "providers", providers)
        object.__setattr__(self, "retrieved_at", _normalized_text(self.retrieved_at, "retrieved_at"))
        object.__setattr__(self, "intake_run_id", _normalized_text(self.intake_run_id, "intake_run_id"))

    def to_dict(self) -> dict[str, Any]:
        return {
            "providers": list(self.providers),
            "retrieved_at": self.retrieved_at,
            "intake_run_id": self.intake_run_id,
        }

    @classmethod
    def from_dict(cls, data: object) -> Provenance:
        values = _mapping(data, cls.__name__)
        _fields(values, cls.__name__, cls._FIELDS)
        providers = values["providers"]
        if not isinstance(providers, list):
            raise TypeError("providers must be an array")
        return cls(
            providers=tuple(providers),
            retrieved_at=values["retrieved_at"],
            intake_run_id=values["intake_run_id"],
        )


@dataclass(frozen=True, slots=True)
class DownloadManifestEntry:
    identifiers: tuple[Identifier, ...]
    metadata: CandidateMetadata
    labels: tuple[str, ...]
    missing_abstract: bool
    needs_review: bool
    review_reason: str | None
    provenance: Provenance
    schema_version: str = MANIFEST_ENTRY_SCHEMA_VERSION

    _FIELDS: ClassVar[frozenset[str]] = frozenset(
        {
            "identifiers",
            "metadata",
            "labels",
            "missing_abstract",
            "needs_review",
            "review_reason",
            "provenance",
            "schema_version",
        }
    )

    def __post_init__(self) -> None:
        if not isinstance(self.identifiers, tuple):
            raise TypeError("identifiers must be a tuple")
        if not all(isinstance(identifier, Identifier) for identifier in self.identifiers):
            raise TypeError("identifiers must contain Identifier values")
        if not isinstance(self.metadata, CandidateMetadata):
            raise TypeError("metadata must be CandidateMetadata")
        if not isinstance(self.provenance, Provenance):
            raise TypeError("provenance must be Provenance")
        if not isinstance(self.missing_abstract, bool) or not isinstance(self.needs_review, bool):
            raise TypeError("missing_abstract and needs_review must be booleans")
        if self.missing_abstract != (self.metadata.abstract is None):
            raise ValueError("missing_abstract must match whether metadata.abstract is None")
        if self.schema_version != MANIFEST_ENTRY_SCHEMA_VERSION:
            raise ValueError(f"unsupported manifest entry schema version: {self.schema_version!r}")
        labels = _string_tuple(self.labels, "labels")
        review_reason = _optional_text(self.review_reason, "review_reason")
        if self.metadata.title is None and not self.identifiers:
            raise ValueError("a manifest entry requires a title or at least one identifier")
        object.__setattr__(self, "labels", labels)
        object.__setattr__(self, "review_reason", review_reason)

    def to_dict(self) -> dict[str, Any]:
        return {
            "identifiers": [identifier.to_dict() for identifier in self.identifiers],
            "metadata": self.metadata.to_dict(),
            "labels": list(self.labels),
            "missing_abstract": self.missing_abstract,
            "needs_review": self.needs_review,
            "review_reason": self.review_reason,
            "provenance": self.provenance.to_dict(),
            "schema_version": self.schema_version,
        }

    @classmethod
    def from_dict(cls, data: object) -> DownloadManifestEntry:
        values = _mapping(data, cls.__name__)
        _fields(values, cls.__name__, cls._FIELDS)
        identifiers = values["identifiers"]
        labels = values["labels"]
        if not isinstance(identifiers, list) or not isinstance(labels, list):
            raise TypeError("identifiers and labels must be arrays")
        return cls(
            identifiers=tuple(Identifier.from_dict(item) for item in identifiers),
            metadata=CandidateMetadata.from_dict(values["metadata"]),
            labels=tuple(labels),
            missing_abstract=values["missing_abstract"],
            needs_review=values["needs_review"],
            review_reason=values["review_reason"],
            provenance=Provenance.from_dict(values["provenance"]),
            schema_version=values["schema_version"],
        )

    def to_json_line(self) -> str:
        return _compact_json(self.to_dict())

    @classmethod
    def from_json_line(cls, line: str) -> DownloadManifestEntry:
        return cls.from_dict(_json_object(line, cls.__name__))


@dataclass(frozen=True, slots=True)
class SearchSpec:
    query: str
    sources: tuple[str, ...]
    limit: int
    filters: tuple[tuple[str, str], ...] = field(default_factory=tuple)

    _FIELDS: ClassVar[frozenset[str]] = frozenset({"query", "sources", "limit", "filters"})

    def __post_init__(self) -> None:
        query = _normalized_text(self.query, "query")
        sources = _string_tuple(self.sources, "sources")
        if not sources:
            raise ValueError("sources must not be empty")
        if not isinstance(self.limit, int) or isinstance(self.limit, bool):
            raise TypeError("limit must be an integer")
        if self.limit <= 0:
            raise ValueError("limit must be greater than zero")
        if not isinstance(self.filters, tuple):
            raise TypeError("filters must be a tuple")
        normalized_filters: list[tuple[str, str]] = []
        for item in self.filters:
            if not isinstance(item, tuple) or len(item) != 2:
                raise TypeError("filters must contain (name, value) tuples")
            normalized_filters.append(
                (_normalized_text(item[0], "filter name"),
                 _normalized_text(item[1], "filter value"))
            )
        names = [name for name, _ in normalized_filters]
        if len(names) != len(set(names)):
            raise ValueError("filter names must be unique")
        object.__setattr__(self, "query", query)
        object.__setattr__(self, "sources", sources)
        object.__setattr__(self, "filters", tuple(sorted(normalized_filters)))

    def to_dict(self) -> dict[str, Any]:
        return {"query": self.query, "sources": list(self.sources),
                "limit": self.limit, "filters": dict(self.filters)}

    @classmethod
    def from_dict(cls, data: object) -> SearchSpec:
        values = _mapping(data, cls.__name__)
        _fields(values, cls.__name__, cls._FIELDS)
        sources = values["sources"]
        filters = values["filters"]
        if not isinstance(sources, list):
            raise TypeError("sources must be an array")
        if not isinstance(filters, dict):
            raise TypeError("filters must be an object")
        return cls(values["query"], tuple(sources), values["limit"], tuple(filters.items()))

    def to_json_line(self) -> str:
        return _compact_json(self.to_dict())

    @classmethod
    def from_json_line(cls, line: str) -> SearchSpec:
        return cls.from_dict(_json_object(line, cls.__name__))
