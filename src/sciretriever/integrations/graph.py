"""Provider-neutral citation graph capability contracts."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import re
from typing import Protocol, TypeAlias


_CURSOR_PATTERN = re.compile(r"^[\x21-\x7e]{1,512}$")
_DOI_PREFIX = re.compile(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", re.IGNORECASE)
_DOI_VALUE = re.compile(r"^10\.\d{4,9}/\S+$", re.IGNORECASE)
_OPENALEX_PREFIX = re.compile(r"^https?://openalex\.org/", re.IGNORECASE)
_PROVIDER_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_MAX_IDENTIFIER_LENGTH = 512
_MAX_PAGE_SIZE = 200


def _provider_name(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError("graph provider must be a string")
    normalized = value.strip()
    if _PROVIDER_PATTERN.fullmatch(normalized) is None:
        raise ValueError("graph provider name is invalid")
    return normalized


class GraphDirection(str, Enum):
    REFERENCES = "references"
    CITED_BY = "cited-by"
    BOTH = "both"


_DIRECTION_ORDER = {
    GraphDirection.REFERENCES: 0,
    GraphDirection.CITED_BY: 1,
}


class GraphIdentifierNamespace(str, Enum):
    DOI = "doi"
    PMID = "pmid"
    ARXIV = "arxiv"
    OPENALEX = "openalex"
    S2 = "s2"


class ExpansionDepth(int):
    def __new__(cls, value: int) -> ExpansionDepth:
        if not isinstance(value, int) or isinstance(value, bool):
            raise TypeError("expansion depth must be an integer")
        if value < 0:
            raise ValueError("expansion depth must be nonnegative")
        return super().__new__(cls, value)


class GraphCursor(str):
    def __new__(cls, value: str) -> GraphCursor:
        if not isinstance(value, str):
            raise TypeError("graph cursor must be a string")
        if _CURSOR_PATTERN.fullmatch(value) is None:
            raise ValueError("graph cursor must be 1-512 visible ASCII characters")
        return super().__new__(cls, value)


@dataclass(frozen=True, slots=True, order=True)
class GraphIdentifier:
    namespace: GraphIdentifierNamespace
    value: str

    def __post_init__(self) -> None:
        if not isinstance(self.namespace, GraphIdentifierNamespace):
            raise TypeError("graph identifier namespace is invalid")
        if not isinstance(self.value, str):
            raise TypeError("graph identifier value must be a string")
        value = self.value.strip()
        match self.namespace:
            case GraphIdentifierNamespace.DOI:
                value = _DOI_PREFIX.sub("", value).strip().lower()
                if _DOI_VALUE.fullmatch(value) is None:
                    raise ValueError("DOI graph identifier is invalid")
            case GraphIdentifierNamespace.PMID:
                if not value.isascii() or not value.isdigit():
                    raise ValueError("PMID graph identifier is invalid")
            case GraphIdentifierNamespace.ARXIV:
                value = value.removeprefix("arXiv:").strip().lower()
            case GraphIdentifierNamespace.OPENALEX:
                value = _OPENALEX_PREFIX.sub("", value).strip().upper()
                if not value.startswith("W") or not value[1:].isdigit():
                    raise ValueError("OpenAlex graph identifier is invalid")
            case GraphIdentifierNamespace.S2:
                pass
        if not value or len(value) > _MAX_IDENTIFIER_LENGTH or not value.isprintable():
            raise ValueError("graph identifier value is invalid")
        object.__setattr__(self, "value", value)


@dataclass(frozen=True, slots=True, order=True)
class CitationEdge:
    source: GraphIdentifier
    target: GraphIdentifier

    def __post_init__(self) -> None:
        if not isinstance(self.source, GraphIdentifier) or not isinstance(
            self.target, GraphIdentifier
        ):
            raise TypeError("citation edge endpoints must be graph identifiers")
        if self.source == self.target:
            raise ValueError("citation edge must connect distinct identifiers")


@dataclass(frozen=True, slots=True)
class GraphQuery:
    seed: GraphIdentifier
    direction: GraphDirection
    depth: ExpansionDepth
    max_provider_calls: int
    page_size: int

    def __post_init__(self) -> None:
        if not isinstance(self.seed, GraphIdentifier):
            raise TypeError("graph query seed must be a graph identifier")
        if not isinstance(self.direction, GraphDirection):
            raise TypeError("graph query direction is invalid")
        if not isinstance(self.depth, ExpansionDepth):
            raise TypeError("graph query depth must be ExpansionDepth")
        if not isinstance(self.max_provider_calls, int) or isinstance(
            self.max_provider_calls, bool
        ):
            raise TypeError("max provider calls must be an integer")
        if self.max_provider_calls < 1:
            raise ValueError("max provider calls must be positive")
        if not isinstance(self.page_size, int) or isinstance(self.page_size, bool):
            raise TypeError("page size must be an integer")
        if not 1 <= self.page_size <= _MAX_PAGE_SIZE:
            raise ValueError("page size must be between 1 and 200")


@dataclass(frozen=True, slots=True)
class GraphRequest:
    query: GraphQuery
    direction: GraphDirection
    cursor: GraphCursor | None
    call_number: int

    def __post_init__(self) -> None:
        if not isinstance(self.query, GraphQuery):
            raise TypeError("graph request query is invalid")
        if self.direction not in (GraphDirection.REFERENCES, GraphDirection.CITED_BY):
            raise ValueError("a provider page request requires one concrete direction")
        if self.query.direction is not GraphDirection.BOTH and self.direction is not self.query.direction:
            raise ValueError("request direction conflicts with graph query")
        if self.cursor is not None and not isinstance(self.cursor, GraphCursor):
            raise TypeError("graph request cursor is invalid")
        if not isinstance(self.call_number, int) or isinstance(self.call_number, bool):
            raise TypeError("provider call number must be an integer")
        if not 1 <= self.call_number <= self.query.max_provider_calls:
            raise ValueError("provider call number exceeds query bound")


@dataclass(frozen=True, slots=True)
class GraphPage:
    request: GraphRequest
    edges: tuple[CitationEdge, ...]
    next_cursor: GraphCursor | None
    provider_returned: int

    def __post_init__(self) -> None:
        if not isinstance(self.request, GraphRequest):
            raise TypeError("graph page request is invalid")
        if not isinstance(self.edges, tuple) or not all(
            isinstance(edge, CitationEdge) for edge in self.edges
        ):
            raise TypeError("graph page edges must be a tuple of citation edges")
        if self.next_cursor is not None and not isinstance(self.next_cursor, GraphCursor):
            raise TypeError("graph page next cursor is invalid")
        if not isinstance(self.provider_returned, int) or isinstance(
            self.provider_returned, bool
        ):
            raise TypeError("provider returned count must be an integer")
        if not len(self.edges) <= self.provider_returned <= self.request.query.page_size:
            raise ValueError("provider returned count is outside page bounds")
        for edge in self.edges:
            if self.request.direction is GraphDirection.REFERENCES and edge.source != self.request.query.seed:
                raise ValueError("reference edge source conflicts with query seed")
            if self.request.direction is GraphDirection.CITED_BY and edge.target != self.request.query.seed:
                raise ValueError("cited-by edge target conflicts with query seed")
        object.__setattr__(self, "edges", tuple(sorted(set(self.edges))))


@dataclass(frozen=True, slots=True)
class GraphResult:
    provider: str
    query: GraphQuery
    pages: tuple[GraphPage, ...]
    edges: tuple[CitationEdge, ...] = field(init=False)
    provider_returned: int = field(init=False)

    def __post_init__(self) -> None:
        if not isinstance(self.pages, tuple) or not self.pages:
            raise ValueError("graph result requires at least one page")
        pages = tuple(sorted(self.pages, key=lambda page: (
            _DIRECTION_ORDER[page.request.direction], page.request.call_number, page.edges,
        )))
        for direction in (GraphDirection.REFERENCES, GraphDirection.CITED_BY):
            chain = tuple(page for page in pages if page.request.direction is direction)
            previous_cursor = None
            seen_cursors: set[GraphCursor] = set()
            for index, page in enumerate(chain, 1):
                if (
                    page.request.query != self.query
                    or page.request.call_number != index
                    or page.request.cursor != previous_cursor
                    or (index < len(chain) and page.next_cursor is None)
                    or page.next_cursor in seen_cursors
                ):
                    raise ValueError("graph result pages are not contiguous by direction")
                if page.next_cursor is not None:
                    seen_cursors.add(page.next_cursor)
                previous_cursor = page.next_cursor
        object.__setattr__(self, "provider", _provider_name(self.provider))
        object.__setattr__(self, "pages", pages)
        object.__setattr__(self, "edges", tuple(sorted({edge for page in pages for edge in page.edges})))
        object.__setattr__(self, "provider_returned", sum(page.provider_returned for page in pages))


@dataclass(frozen=True, slots=True)
class GraphQueryUnsupported:
    provider: str
    direction: GraphDirection

    def __post_init__(self) -> None:
        if not isinstance(self.direction, GraphDirection):
            raise TypeError("unsupported graph direction is invalid")
        object.__setattr__(self, "provider", _provider_name(self.provider))


@dataclass(frozen=True, slots=True)
class ProviderEdge:
    source: tuple[str, str]
    target: tuple[str, str]

    def __post_init__(self) -> None:
        for endpoint in (self.source, self.target):
            if not isinstance(endpoint, tuple) or len(endpoint) != 2:
                raise TypeError("provider edge endpoints must be identifier pairs")
            try:
                GraphIdentifier(GraphIdentifierNamespace(endpoint[0]), endpoint[1])
            except (TypeError, ValueError) as error:
                raise ValueError("provider edge contains an invalid public identifier") from error


def normalize_provider_page(
    request: GraphRequest,
    edges: tuple[ProviderEdge, ...],
    next_cursor: GraphCursor | None,
) -> GraphPage:
    if not isinstance(edges, tuple):
        raise TypeError("provider edges must be a tuple")
    neutral = tuple(
        CitationEdge(
            GraphIdentifier(GraphIdentifierNamespace(edge.source[0]), edge.source[1]),
            GraphIdentifier(GraphIdentifierNamespace(edge.target[0]), edge.target[1]),
        )
        for edge in edges
    )
    return GraphPage(request, neutral, next_cursor, len(edges))


class GraphCapability(Protocol):
    name: str
    graph_directions: frozenset[GraphDirection]

    async def graph_page(self, request: GraphRequest) -> GraphPage:
        ...


GraphQueryResult: TypeAlias = GraphResult | GraphQueryUnsupported


__all__ = (
    "CitationEdge", "ExpansionDepth", "GraphCapability", "GraphCursor",
    "GraphDirection", "GraphIdentifier", "GraphIdentifierNamespace", "GraphPage",
    "GraphQuery", "GraphQueryResult", "GraphQueryUnsupported", "GraphRequest",
    "GraphResult", "ProviderEdge", "normalize_provider_page",
)
