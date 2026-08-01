from __future__ import annotations

from typing import Mapping, TypeAlias, assert_never

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
from .openalex import OpenAlexClient


_DIRECTIONS = frozenset({GraphDirection.REFERENCES, GraphDirection.CITED_BY})
JsonValue: TypeAlias = str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]


class OpenAlexGraphAdapter:
    graph_directions = _DIRECTIONS

    def __init__(
        self,
        client: OpenAlexClient,
        timeout: float | None = None,
        name: str = "openalex",
    ) -> None:
        self.client = client
        self.timeout = timeout
        self.name = name

    async def graph_page(self, request: GraphRequest) -> GraphPage:
        match request.direction:
            case GraphDirection.REFERENCES:
                return self._references(request)
            case GraphDirection.CITED_BY:
                return self._cited_by(request)
            case GraphDirection.BOTH:
                raise IntegrationError("openalex graph direction is unsupported")
            case unreachable:
                assert_never(unreachable)

    def _references(self, request: GraphRequest) -> GraphPage:
        offset = _offset(request.cursor)
        response = self.client.transport.get(
            _work_url(self.client, request.query.seed),
            params={"select": "referenced_works"},
            headers={"Accept": "application/json"},
            timeout=self.client.request_timeout(self.timeout),
        )
        payload = parse_json(response, self.name)
        values = payload.get("referenced_works")
        if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
            raise IntegrationError("openalex returned malformed references")
        end = min(offset + request.query.page_size, len(values))
        edges = tuple(
            ProviderEdge(
                _identifier_pair(request.query.seed),
                _identifier_pair(GraphIdentifier(GraphIdentifierNamespace.OPENALEX, value)),
            )
            for value in values[offset:end]
        )
        cursor = GraphCursor(f"offset:{end}") if end < len(values) else None
        return normalize_provider_page(request, edges, cursor)

    def _cited_by(self, request: GraphRequest) -> GraphPage:
        seed = request.query.seed
        cursor = "*" if request.cursor is None else str(request.cursor)
        response = self.client.transport.get(
            self.client.endpoint,
            params={
                "filter": f"cites:{_openalex_filter_identifier(seed)}",
                "per-page": request.query.page_size,
                "cursor": cursor,
                "select": "id,doi",
            },
            headers={"Accept": "application/json"},
            timeout=self.client.request_timeout(self.timeout),
        )
        payload = parse_json(response, self.name)
        values = payload.get("results")
        if not isinstance(values, list):
            raise IntegrationError("openalex returned malformed cited-by results")
        edges = tuple(
            ProviderEdge(_openalex_work_pair(value), _identifier_pair(seed))
            for value in values
        )
        meta = payload.get("meta")
        if meta is not None and not isinstance(meta, Mapping):
            raise IntegrationError("openalex returned malformed graph metadata")
        raw_cursor = meta.get("next_cursor") if isinstance(meta, Mapping) else None
        if raw_cursor is not None and not isinstance(raw_cursor, str):
            raise IntegrationError("openalex returned malformed graph cursor")
        next_cursor = GraphCursor(raw_cursor) if raw_cursor else None
        return normalize_provider_page(request, edges, next_cursor)


def _offset(cursor: GraphCursor | None) -> int:
    if cursor is None:
        return 0
    prefix, separator, value = cursor.partition(":")
    if prefix != "offset" or separator != ":" or not value.isascii() or not value.isdecimal():
        raise IntegrationError("openalex reference cursor is malformed")
    return int(value)


def _work_url(client: OpenAlexClient, seed: GraphIdentifier) -> str:
    match seed.namespace:
        case GraphIdentifierNamespace.DOI:
            return client.work_url(seed.value)
        case GraphIdentifierNamespace.OPENALEX:
            return f"{client.endpoint}/{seed.value}"
        case GraphIdentifierNamespace.PMID | GraphIdentifierNamespace.ARXIV | GraphIdentifierNamespace.S2:
            raise IntegrationError("openalex graph seed namespace is unsupported")
        case unreachable:
            assert_never(unreachable)


def _openalex_filter_identifier(seed: GraphIdentifier) -> str:
    match seed.namespace:
        case GraphIdentifierNamespace.DOI:
            return f"https://doi.org/{seed.value}"
        case GraphIdentifierNamespace.OPENALEX:
            return seed.value
        case GraphIdentifierNamespace.PMID | GraphIdentifierNamespace.ARXIV | GraphIdentifierNamespace.S2:
            raise IntegrationError("openalex graph seed namespace is unsupported")
        case unreachable:
            assert_never(unreachable)


def _openalex_work_pair(value: JsonValue) -> tuple[str, str]:
    if not isinstance(value, Mapping):
        raise IntegrationError("openalex returned a malformed cited-by work")
    doi = string_value(value.get("doi"))
    if doi is not None:
        return _identifier_pair(GraphIdentifier(GraphIdentifierNamespace.DOI, doi))
    raw_id = string_value(value.get("id"))
    if raw_id is None:
        raise IntegrationError("openalex cited-by work has no stable identifier")
    return _identifier_pair(GraphIdentifier(GraphIdentifierNamespace.OPENALEX, raw_id))


def _identifier_pair(identifier: GraphIdentifier) -> tuple[str, str]:
    return identifier.namespace.value, identifier.value


__all__ = ("OpenAlexGraphAdapter",)
