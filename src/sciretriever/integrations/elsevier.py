"""Elsevier Scopus search and article retrieval client."""

from urllib.parse import quote

from sciretriever.network import HttpResponse, Transport

from .common import (
    BaseClient, IntegrationError, abstract_value, integer_value,
    publication_year, string_value,
)
from .models import VendorWork

ELSEVIER_SCOPUS_MAX_PAGE_SIZE = 25


class ElsevierClient(BaseClient):
    vendor = "elsevier"
    endpoint = "https://api.elsevier.com/content/search/scopus"
    article_endpoint = "https://api.elsevier.com/content/article/doi/{doi}?view=FULL"
    object_endpoint = "https://api.elsevier.com/content/object/eid/{eid}"

    def __init__(
        self,
        transport: Transport,
        *,
        api_key: str,
        timeout: float | None = 30.0,
        article_endpoint: str | None = None,
        object_endpoint: str | None = None,
    ) -> None:
        if not api_key or not api_key.strip():
            raise ValueError("elsevier requires configured credentials")
        super().__init__(transport, timeout=timeout)
        self.headers = {
            "Accept": "application/json",
            "X-ELS-APIKey": api_key.strip(),
        }
        self.article_endpoint = article_endpoint or self.article_endpoint
        self.object_endpoint = object_endpoint or self.object_endpoint

    def retrieve_article(
        self, doi: str, *, accept: str, timeout: float | None = None
    ) -> HttpResponse:
        return self.transport.get(
            self.article_endpoint.format(doi=quote(doi, safe="")),
            headers={**self.headers, "Accept": accept},
            timeout=self.request_timeout(timeout),
        )

    def retrieve_object(
        self, eid: str, *, accept: str, timeout: float | None = None
    ) -> HttpResponse:
        return self.transport.get(
            self.object_endpoint.format(eid=quote(eid, safe="")),
            headers={**self.headers, "Accept": accept},
            timeout=self.request_timeout(timeout),
        )

    def search(
        self,
        query: str,
        limit: int,
        year_from: int | None,
        year_to: int | None,
        *,
        timeout: float | None = None,
    ) -> tuple[VendorWork, ...]:
        expression = f"TITLE-ABS-KEY({query})"
        if year_from is not None:
            expression += f" AND PUBYEAR AFT {year_from - 1}"
        if year_to is not None:
            expression += f" AND PUBYEAR BEF {year_to + 1}"
        records: list[VendorWork] = []
        start = 0
        while len(records) < limit:
            page_size = min(limit - len(records), ELSEVIER_SCOPUS_MAX_PAGE_SIZE)
            payload = self.get_json(
                params={"query": expression, "count": page_size, "start": start},
                headers=self.headers,
                timeout=timeout,
            )
            root = payload.get("search-results")
            items = root.get("entry") if isinstance(root, dict) else None
            if not isinstance(items, list):
                raise IntegrationError("elsevier returned malformed search results")
            page = tuple(self._work(item) for item in items)
            records.extend(page[: limit - len(records)])
            consumed = len(page)
            start += consumed
            total = self._total_results(root)
            if (
                consumed < page_size
                or len(records) == limit
                or (total is not None and start >= total)
            ):
                break
        return tuple(records)

    @staticmethod
    def _total_results(root: object) -> int | None:
        if not isinstance(root, dict):
            return None
        value = root.get("opensearch:totalResults")
        if value is None:
            return None
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
        if isinstance(value, str) and value.isascii() and value.isdecimal():
            return int(value)
        raise IntegrationError("elsevier returned malformed total results")

    @staticmethod
    def _work(value: object) -> VendorWork:
        if not isinstance(value, dict):
            raise IntegrationError("elsevier returned a malformed entry")
        raw_id = string_value(value.get("dc:identifier"))
        raw_id = raw_id or string_value(value.get("eid"))
        raw_id = raw_id or string_value(value.get("prism:doi"))
        if raw_id is None:
            raise IntegrationError("elsevier entry has no stable identifier")
        creators = value.get("author")
        authors = (
            tuple(
                name
                for author in creators
                if isinstance(author, dict)
                if (
                    name := string_value(author.get("authname"))
                    or string_value(author.get("ce:indexed-name"))
                )
            )
            if isinstance(creators, list)
            else ()
        )
        if not authors and (creator := string_value(value.get("dc:creator"))):
            authors = (creator,)
        links = value.get("link") or []
        canonical = (
            next(
                (
                    string_value(link.get("@href"))
                    for link in links
                    if isinstance(link, dict)
                    and link.get("@ref") in {"scopus", "self"}
                ),
                None,
            )
            if isinstance(links, list)
            else None
        )
        date = string_value(value.get("prism:coverDate"))
        return VendorWork(
            raw_id,
            string_value(value.get("dc:title")),
            abstract_value(value.get("dc:description")),
            string_value(value.get("prism:doi")),
            authors,
            publication_year(date),
            date,
            integer_value(value.get("citedby-count")),
            canonical,
            venue=string_value(value.get("prism:publicationName")),
        )


__all__ = ("ElsevierClient",)
