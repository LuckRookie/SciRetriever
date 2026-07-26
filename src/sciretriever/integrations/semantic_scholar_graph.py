from __future__ import annotations

from typing import Mapping, TypeAlias, assert_never
from urllib.parse import quote

from .common import IntegrationError, parse_json, string_value
from .graph import (
    GraphCursor,
    GraphDirection,
    GraphIdentifier,
    GraphIdentifierNamespace,
    GraphPage,
    GraphRequest,
    ProviderEdge,
    normalize_provider_page,
)
from .semantic_scholar import SemanticScholarClient


_DIRECTIONS = frozenset({GraphDirection.REFERENCES, GraphDirection.CITED_BY})
JsonValue: TypeAlias = str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]


class SemanticScholarGraphAdapter:
    graph_directions = _DIRECTIONS

    def __init__(
        self,
        client: SemanticScholarClient,
        timeout: float | None = None,
        name: str = "semantic-scholar",
    ) -> None:
        self.client = client
        self.timeout = timeout
        self.name = name

    async def graph_page(self, request: GraphRequest) -> GraphPage:
        offset = _offset(request.cursor)
        match request.direction:
            case GraphDirection.REFERENCES:
                relation = "references"
                item_name = "citedPaper"
            case GraphDirection.CITED_BY:
                relation = "citations"
                item_name = "citingPaper"
            case GraphDirection.BOTH:
                raise IntegrationError("semantic-scholar graph direction is unsupported")
            case unreachable:
                assert_never(unreachable)
        response = self.client.transport.get(
            f"https://api.semanticscholar.org/graph/v1/paper/{_paper_id(request.query.seed)}/{relation}",
            params={
                "fields": "paperId,externalIds",
                "limit": request.query.page_size,
                "offset": offset,
            },
            headers=self.client.headers,
            timeout=self.client.request_timeout(self.timeout),
        )
        payload = parse_json(response, self.name)
        values = payload.get("data")
        if not isinstance(values, list):
            raise IntegrationError("semantic-scholar returned malformed graph data")
        seed_pair = _identifier_pair(request.query.seed)
        peers = tuple(_paper_pair(value, item_name) for value in values)
        match request.direction:
            case GraphDirection.REFERENCES:
                edges = tuple(ProviderEdge(seed_pair, peer) for peer in peers)
            case GraphDirection.CITED_BY:
                edges = tuple(ProviderEdge(peer, seed_pair) for peer in peers)
            case GraphDirection.BOTH:
                raise IntegrationError("semantic-scholar graph direction is unsupported")
            case unreachable:
                assert_never(unreachable)
        raw_next = payload.get("next")
        if raw_next is not None and (
            not isinstance(raw_next, int) or isinstance(raw_next, bool) or raw_next < 0
        ):
            raise IntegrationError("semantic-scholar returned malformed graph cursor")
        next_cursor = GraphCursor(f"offset:{raw_next}") if isinstance(raw_next, int) else None
        return normalize_provider_page(request, edges, next_cursor)


def _paper_id(seed: GraphIdentifier) -> str:
    match seed.namespace:
        case GraphIdentifierNamespace.DOI:
            return quote(f"DOI:{seed.value}", safe=":")
        case GraphIdentifierNamespace.S2:
            return quote(seed.value, safe="")
        case GraphIdentifierNamespace.PMID | GraphIdentifierNamespace.ARXIV | GraphIdentifierNamespace.OPENALEX:
            raise IntegrationError("semantic-scholar graph seed namespace is unsupported")
        case unreachable:
            assert_never(unreachable)


def _offset(cursor: GraphCursor | None) -> int:
    if cursor is None:
        return 0
    prefix, separator, value = cursor.partition(":")
    if prefix != "offset" or separator != ":" or not value.isascii() or not value.isdecimal():
        raise IntegrationError("semantic-scholar graph cursor is malformed")
    return int(value)


def _paper_pair(value: JsonValue, item_name: str) -> tuple[str, str]:
    if not isinstance(value, Mapping):
        raise IntegrationError("semantic-scholar returned a malformed graph edge")
    paper = value.get(item_name)
    if not isinstance(paper, Mapping):
        raise IntegrationError("semantic-scholar returned a malformed graph paper")
    external = paper.get("externalIds")
    if external is not None and not isinstance(external, Mapping):
        raise IntegrationError("semantic-scholar returned malformed external identifiers")
    doi = string_value(external.get("DOI")) if isinstance(external, Mapping) else None
    if doi is not None:
        return _identifier_pair(GraphIdentifier(GraphIdentifierNamespace.DOI, doi))
    paper_id = string_value(paper.get("paperId"))
    if paper_id is None:
        raise IntegrationError("semantic-scholar graph paper has no stable identifier")
    return _identifier_pair(GraphIdentifier(GraphIdentifierNamespace.S2, paper_id))


def _identifier_pair(identifier: GraphIdentifier) -> tuple[str, str]:
    return identifier.namespace.value, identifier.value


__all__ = ("SemanticScholarGraphAdapter",)
