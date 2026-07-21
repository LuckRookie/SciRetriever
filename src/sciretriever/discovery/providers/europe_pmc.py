"""Europe PMC discovery adapter over the shared integration client."""

from __future__ import annotations

from sciretriever.core.contracts import SearchSpec
from sciretriever.discovery.models import ProviderRecord
from sciretriever.integrations import EuropePmcClient, VendorWork
from sciretriever.integrations.europe_pmc import EUROPE_PMC_SEARCH_URL

from ._common import run_integration_search, validated_year_filters
from .http import Transport

EUROPE_PMC_MAX_PAGE_SIZE = 1000
DEFAULT_USER_AGENT = "SciRetriever/0.1 (Europe PMC discovery adapter)"


class EuropePMCProvider:
    name = "europe-pmc"

    def __init__(
        self,
        transport: Transport,
        *,
        user_agent: str = DEFAULT_USER_AGENT,
        timeout: float | None = 30.0,
        endpoint: str = EUROPE_PMC_SEARCH_URL,
    ) -> None:
        self._client = EuropePmcClient(
            transport,
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
                max_page_size=EUROPE_PMC_MAX_PAGE_SIZE,
            ),
        )
        return tuple(_record(work, rank) for rank, work in enumerate(works, 1))


def _record(work: VendorWork, rank: int) -> ProviderRecord:
    return ProviderRecord(
        provider="europe-pmc",
        rank=rank,
        raw_identifiers=work.identifiers,
        title=work.title,
        abstract=work.abstract,
        authors=work.authors,
        year=work.year,
        venue=work.venue,
        keywords=work.keywords,
    )


def build_europe_pmc_provider(
    transport: Transport,
    *,
    user_agent: str = DEFAULT_USER_AGENT,
    timeout: float | None = 30.0,
) -> EuropePMCProvider:
    return EuropePMCProvider(transport, user_agent=user_agent, timeout=timeout)


__all__ = ("EuropePMCProvider", "build_europe_pmc_provider")
