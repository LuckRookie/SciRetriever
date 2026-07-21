"""Semantic Scholar metadata search and acquisition resolution client."""

from urllib.parse import quote

from sciretriever.network import Transport

from .common import (
    BaseClient, IntegrationError, abstract_value, integer_value, parse_json,
    publication_year, string_value,
)
from .models import VendorWork

SEMANTIC_SCHOLAR_MAX_PAGE_SIZE = 100


class SemanticScholarClient(BaseClient):
    vendor = "semantic-scholar"
    endpoint = "https://api.semanticscholar.org/graph/v1/paper/search"
    fields = (
        "paperId,title,abstract,externalIds,authors,year,publicationDate,"
        "citationCount,isOpenAccess,openAccessPdf,url"
    )

    def __init__(
        self,
        transport: Transport,
        *,
        api_key: str | None = None,
        timeout: float | None = 30.0,
    ) -> None:
        super().__init__(transport, timeout=timeout)
        self.headers = {"Accept": "application/json"}
        if api_key and api_key.strip():
            self.headers["x-api-key"] = api_key.strip()

    @staticmethod
    def paper_url(doi: str) -> str:
        paper_id = quote("DOI:" + doi, safe=":")
        return f"https://api.semanticscholar.org/graph/v1/paper/{paper_id}"

    def lookup_doi(self, doi: str, *, timeout: float | None = None) -> VendorWork:
        response = self.transport.get(
            self.paper_url(doi),
            params={"fields": self.fields},
            headers=self.headers,
            timeout=self.request_timeout(timeout),
        )
        return self._work(parse_json(response, self.vendor))

    def resolve_pdf_doi(
        self, doi: str, *, timeout: float | None = None
    ) -> tuple[str, str]:
        acquisition_headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() == "x-api-key"
        }
        response = self.transport.get(
            self.paper_url(doi),
            params={"fields": "openAccessPdf"},
            headers=acquisition_headers,
            timeout=self.request_timeout(timeout),
        )
        payload = parse_json(response, self.vendor)
        pdf = payload.get("openAccessPdf")
        candidate = string_value(pdf.get("url")) if isinstance(pdf, dict) else None
        if candidate is None or not candidate.startswith("https://"):
            raise IntegrationError("semantic-scholar supplied no OA PDF")
        return candidate, response.url

    def search(
        self,
        query: str,
        limit: int,
        year_from: int | None,
        year_to: int | None,
        *,
        timeout: float | None = None,
    ) -> tuple[VendorWork, ...]:
        base_params: dict[str, str | int] = {
            "query": query,
            "fields": self.fields,
        }
        if year_from is not None or year_to is not None:
            base_params["year"] = f"{year_from or ''}-{year_to or ''}"
        records: list[VendorWork] = []
        offset = 0
        while len(records) < limit:
            page_size = min(
                limit - len(records), SEMANTIC_SCHOLAR_MAX_PAGE_SIZE
            )
            payload = self.get_json(
                params={**base_params, "limit": page_size, "offset": offset},
                headers=self.headers,
                timeout=timeout,
            )
            items = payload.get("data")
            if not isinstance(items, list):
                raise IntegrationError("semantic-scholar returned malformed data")
            page = tuple(self._work(item) for item in items)
            records.extend(page[: limit - len(records)])
            consumed = len(page)
            offset += consumed
            total = payload.get("total")
            if total is not None and (
                not isinstance(total, int) or isinstance(total, bool) or total < 0
            ):
                raise IntegrationError("semantic-scholar returned malformed total")
            if (
                consumed < page_size
                or len(records) == limit
                or (isinstance(total, int) and offset >= total)
            ):
                break
        return tuple(records)

    @staticmethod
    def _work(value: object) -> VendorWork:
        if not isinstance(value, dict) or not (
            raw_id := string_value(value.get("paperId"))
        ):
            raise IntegrationError("semantic-scholar returned a malformed paper")
        external = value.get("externalIds") or {}
        authors = value.get("authors") or []
        if not isinstance(external, dict) or not isinstance(authors, list):
            raise IntegrationError(
                "semantic-scholar returned malformed identifiers or authors"
            )
        names = tuple(
            name
            for author in authors
            if isinstance(author, dict)
            if (name := string_value(author.get("name")))
        )
        pdf = value.get("openAccessPdf")
        date = string_value(value.get("publicationDate"))
        return VendorWork(
            raw_id,
            string_value(value.get("title")),
            abstract_value(value.get("abstract")),
            string_value(external.get("DOI")),
            names,
            publication_year(date, value.get("year")),
            date,
            integer_value(value.get("citationCount")),
            string_value(value.get("url")),
            string_value(pdf.get("url")) if isinstance(pdf, dict) else None,
        )


__all__ = ("SemanticScholarClient",)
