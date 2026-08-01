"""arXiv discovery adapter over the shared integration client."""

from __future__ import annotations

from collections.abc import Callable
import time

from sciretriever.core.contracts import SearchSpec
from sciretriever.discovery.models import ProviderRecord
from sciretriever.errors import ProviderSearchError
from sciretriever.integrations import ArxivClient, VendorWork
from sciretriever.integrations.arxiv import ARXIV_QUERY_URL

from ._common import run_integration_search, validated_year_filters
from .http import Transport

ARXIV_MAX_PAGE_SIZE = 2000
ARXIV_MAX_TOTAL = 30000
ARXIV_PAGE_DELAY_SECONDS = 3.0
DEFAULT_USER_AGENT = "SciRetriever/0.1 (arXiv discovery adapter)"


class ArxivProvider:
    name = "arxiv"

    def __init__(
        self,
        transport: Transport,
        *,
        sleeper: Callable[[float], None] = time.sleep,
        user_agent: str = DEFAULT_USER_AGENT,
        timeout: float | None = 30.0,
        endpoint: str = ARXIV_QUERY_URL,
    ) -> None:
        self._client = ArxivClient(
            transport,
            user_agent=user_agent,
            timeout=timeout,
            endpoint=endpoint,
        )
        self._sleeper = sleeper

    def search(self, spec: SearchSpec) -> tuple[ProviderRecord, ...]:
        year_from, year_to = validated_year_filters(spec, self.name)
        if spec.limit > ARXIV_MAX_TOTAL:
            raise ProviderSearchError.for_configuration(
                self.name, f"arxiv limit must not exceed {ARXIV_MAX_TOTAL}"
            )
        works = run_integration_search(
            self.name,
            lambda: self._client.search(
                spec.query,
                spec.limit,
                year_from,
                year_to,
                max_page_size=ARXIV_MAX_PAGE_SIZE,
                sleeper=self._sleeper,
                page_delay=ARXIV_PAGE_DELAY_SECONDS,
            ),
        )
        return tuple(_record(work, rank) for rank, work in enumerate(works, 1))


def _record(work: VendorWork, rank: int) -> ProviderRecord:
    return ProviderRecord(
        provider="arxiv",
        rank=rank,
        raw_identifiers=work.identifiers,
        title=work.title,
        abstract=work.abstract,
        authors=work.authors,
        year=work.year,
        venue=work.venue,
        keywords=work.keywords,
        publisher=work.publisher,
        publication_date=work.publication_date,
        open_access_status=work.open_access_status,
        provider_record_id=work.raw_id or None,
    )


def build_arxiv_provider(
    transport: Transport,
    *,
    sleeper: Callable[[float], None] = time.sleep,
    user_agent: str = DEFAULT_USER_AGENT,
    timeout: float | None = 30.0,
) -> ArxivProvider:
    return ArxivProvider(
        transport,
        sleeper=sleeper,
        user_agent=user_agent,
        timeout=timeout,
    )


__all__ = ("ArxivProvider", "build_arxiv_provider")
