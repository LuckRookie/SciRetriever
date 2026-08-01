"""Discovery adapters over shared vendor integration clients."""

from __future__ import annotations

from typing import Protocol
from sciretriever.core.contracts import SearchSpec
from sciretriever.discovery.models import ProviderRecord
from sciretriever.errors import ProviderSearchError
from sciretriever.integrations import (
    ElsevierClient, OpenAlexClient, SemanticScholarClient,
    SpringerClient, VendorWork,
)
from sciretriever.network import Transport

from ._common import run_integration_search, validated_year_filters


class _SearchClient(Protocol):
    def search(self, query: str, limit: int, year_from: int | None,
               year_to: int | None) -> tuple[VendorWork, ...]: ...


class _VendorProvider:
    name = "vendor"

    def __init__(self, client: _SearchClient) -> None:
        self._client = client

    def search(self, spec: SearchSpec) -> tuple[ProviderRecord, ...]:
        year_from, year_to = validated_year_filters(spec, self.name)
        works = run_integration_search(
            self.name,
            lambda: self._client.search(spec.query, spec.limit, year_from, year_to),
        )
        return tuple(self._record(work, rank) for rank, work in enumerate(works, 1))

    def _record(self, work: VendorWork, rank: int) -> ProviderRecord:
        identifiers: list[tuple[str, str]] = []
        if work.doi:
            identifiers.append(("doi", work.doi))
        if work.canonical_url:
            identifiers.append(("url", work.canonical_url))
        return ProviderRecord(
            provider=self.name,
            rank=rank,
            raw_identifiers=tuple(identifiers),
            title=work.title,
            abstract=work.abstract,
            authors=work.authors,
            year=work.year,
            venue=work.venue,
            publisher=work.publisher,
            publication_date=work.publication_date,
            open_access_status=(
                work.open_access_status
                if work.open_access_status is not None
                else "open" if work.open_access_url is not None else None
            ),
            provider_record_id=work.raw_id,
        )


class OpenAlexProvider(_VendorProvider):
    name = "openalex"


class SemanticScholarProvider(_VendorProvider):
    name = "semantic-scholar"


class ElsevierProvider(_VendorProvider):
    name = "elsevier"


class SpringerProvider(_VendorProvider):
    name = "springer"


def build_openalex_provider(transport: Transport, *, timeout: float | None = 30.0) -> OpenAlexProvider:
    return OpenAlexProvider(OpenAlexClient(transport, timeout=timeout))


def build_semantic_scholar_provider(transport: Transport, *, api_key: str | None = None,
                                    timeout: float | None = 30.0) -> SemanticScholarProvider:
    return SemanticScholarProvider(SemanticScholarClient(transport, api_key=api_key, timeout=timeout))


def build_elsevier_provider(transport: Transport, *, api_key: str | None,
                            timeout: float | None = 30.0) -> ElsevierProvider:
    if api_key is None or not api_key.strip():
        raise ProviderSearchError.for_configuration("elsevier", "elsevier requires configured credentials")
    return ElsevierProvider(ElsevierClient(transport, api_key=api_key, timeout=timeout))


def build_springer_provider(transport: Transport, *, api_key: str | None,
                           timeout: float | None = 30.0) -> SpringerProvider:
    if api_key is None or not api_key.strip():
        raise ProviderSearchError.for_configuration("springer", "springer requires configured credentials")
    return SpringerProvider(SpringerClient(transport, api_key=api_key, timeout=timeout))


__all__ = (
    "ElsevierProvider", "OpenAlexProvider", "SemanticScholarProvider", "SpringerProvider",
    "build_elsevier_provider", "build_openalex_provider",
    "build_semantic_scholar_provider", "build_springer_provider",
)
