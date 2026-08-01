"""Springer Nature metadata search and authenticated retrieval client."""

from urllib.parse import urlencode

from sciretriever.network import HttpResponse, Transport

from .common import (
    BaseClient, IntegrationError, abstract_value, parse_json, publication_year,
    string_value,
)
from .models import VendorWork

SPRINGER_MAX_PAGE_SIZE = 100


class SpringerClient(BaseClient):
    vendor = "springer"
    endpoint = "https://api.springernature.com/meta/v2/json"

    def __init__(
        self,
        transport: Transport,
        *,
        api_key: str,
        timeout: float | None = 30.0,
    ) -> None:
        if not api_key or not api_key.strip():
            raise ValueError("springer requires configured credentials")
        super().__init__(transport, timeout=timeout)
        self.api_key = api_key.strip()

    def search(
        self,
        query: str,
        limit: int,
        year_from: int | None,
        year_to: int | None,
        *,
        timeout: float | None = None,
    ) -> tuple[VendorWork, ...]:
        expression = query
        if year_from is not None or year_to is not None:
            expression += f" year:{year_from or '*'}-{year_to or '*'}"
        records: list[VendorWork] = []
        start = 1
        while len(records) < limit:
            page_size = min(limit - len(records), SPRINGER_MAX_PAGE_SIZE)
            payload = self.get_json(
                params={
                    "q": expression,
                    "p": page_size,
                    "s": start,
                    "api_key": self.api_key,
                },
                headers={"Accept": "application/json"},
                timeout=timeout,
            )
            items = payload.get("records")
            if not isinstance(items, list):
                raise IntegrationError("springer returned malformed records")
            page = tuple(self._work(item) for item in items)
            records.extend(page[: limit - len(records)])
            consumed = len(page)
            start += consumed
            total = self._total_results(payload)
            if (
                consumed < page_size
                or len(records) == limit
                or (total is not None and start > total)
            ):
                break
        return tuple(records)

    @staticmethod
    def _total_results(payload: object) -> int | None:
        if not isinstance(payload, dict):
            return None
        result = payload.get("result")
        if result is None:
            return None
        if not isinstance(result, list) or not result or not isinstance(result[0], dict):
            raise IntegrationError("springer returned malformed result metadata")
        value = result[0].get("total")
        if value is None:
            return None
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
        if isinstance(value, str) and value.isascii() and value.isdecimal():
            return int(value)
        raise IntegrationError("springer returned malformed total results")

    def lookup_doi(
        self,
        doi: str,
        *,
        clean_url: str | None = None,
        timeout: float | None = None,
    ) -> tuple[VendorWork, str]:
        clean_url = clean_url or self.endpoint + "?" + urlencode({"q": "doi:" + doi})
        response = self.transport.get(
            clean_url,
            params={"api_key": self.api_key},
            headers={"Accept": "application/json"},
            timeout=self.request_timeout(timeout),
        )
        payload = parse_json(response, self.vendor)
        items = payload.get("records")
        if not isinstance(items, list) or not items:
            raise IntegrationError("springer returned malformed records")
        return self._work(items[0]), clean_url

    def authenticated_get(
        self,
        clean_url: str,
        *,
        accept: str,
        timeout: float | None = None,
    ) -> HttpResponse:
        response = self.transport.get(
            clean_url,
            params={"api_key": self.api_key},
            headers={"Accept": accept},
            timeout=self.request_timeout(timeout),
        )
        return HttpResponse(response.status, clean_url, response.headers, response.body)

    @staticmethod
    def _work(value: object) -> VendorWork:
        if not isinstance(value, dict):
            raise IntegrationError("springer returned a malformed record")
        doi = string_value(value.get("doi"))
        url_value = value.get("url")
        if isinstance(url_value, list):
            canonical = next(
                (
                    string_value(item.get("value"))
                    for item in url_value
                    if isinstance(item, dict)
                ),
                None,
            )
        else:
            canonical = string_value(url_value)
        creators = value.get("creators") or []
        authors = (
            tuple(
                name
                for item in creators
                if isinstance(item, dict)
                if (name := string_value(item.get("creator")))
            )
            if isinstance(creators, list)
            else ()
        )
        raw_id = doi or canonical
        if raw_id is None:
            raise IntegrationError("springer record has no stable identifier")
        date = string_value(value.get("publicationDate"))
        return VendorWork(
            raw_id,
            string_value(value.get("title")),
            abstract_value(value.get("abstract")),
            doi,
            authors,
            publication_year(date),
            date,
            canonical_url=canonical,
            venue=string_value(value.get("publicationName")),
        )


__all__ = ("SpringerClient",)
