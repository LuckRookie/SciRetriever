"""Crossref discovery adapter over the shared integration client."""

from __future__ import annotations

from sciretriever.core.contracts import SearchSpec
from sciretriever.discovery.models import ProviderRecord
from sciretriever.integrations import CrossrefClient, VendorWork
from sciretriever.integrations.crossref import CROSSREF_WORKS_URL

from ._common import run_integration_search, validated_year_filters
from .http import Transport

CROSSREF_MAX_ROWS = 1000
DEFAULT_USER_AGENT = "SciRetriever/0.1 (Crossref discovery adapter)"


class CrossrefProvider:
    name = "crossref"

    def __init__(
        self,
        transport: Transport,
        *,
        mailto: str | None = None,
        user_agent: str = DEFAULT_USER_AGENT,
        timeout: float | None = 30.0,
        endpoint: str = CROSSREF_WORKS_URL,
    ) -> None:
        self._client = CrossrefClient(
            transport,
            mailto=mailto,
            user_agent=user_agent,
            timeout=timeout,
            endpoint=endpoint,
        )

    def search(self, spec: SearchSpec) -> tuple[ProviderRecord, ...]:
        year_from, year_to = validated_year_filters(spec, self.name)
        works = run_integration_search(
            self.name,
            lambda: self._client.search(
                spec.query,
                spec.limit,
                year_from,
                year_to,
                max_page_size=CROSSREF_MAX_ROWS,
            ),
        )
        return tuple(_record(work, rank) for rank, work in enumerate(works, 1))


def _record(work: VendorWork, rank: int) -> ProviderRecord:
    return ProviderRecord(
        provider="crossref",
        rank=rank,
        raw_identifiers=work.identifiers,
        title=work.title,
        abstract=work.abstract,
        authors=work.authors,
        year=work.year,
        venue=work.venue,
        keywords=work.keywords,
    )


def build_crossref_provider(
    transport: Transport,
    *,
    mailto: str | None = None,
    user_agent: str = DEFAULT_USER_AGENT,
    timeout: float | None = 30.0,
) -> CrossrefProvider:
    return CrossrefProvider(
        transport,
        mailto=mailto,
        user_agent=user_agent,
        timeout=timeout,
    )


__all__ = ("CrossrefProvider", "build_crossref_provider")
