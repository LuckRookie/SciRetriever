"""OpenAlex metadata search and acquisition resolution client."""

from urllib.parse import quote

from .common import (
    BaseClient, IntegrationError, abstract_value, integer_value, parse_json,
    publication_year, string_value,
)
from .models import VendorWork

OPENALEX_MAX_PAGE_SIZE = 200


class OpenAlexClient(BaseClient):
    vendor = "openalex"
    endpoint = "https://api.openalex.org/works"

    def work_url(self, doi: str) -> str:
        return f"{self.endpoint}/https://doi.org/{quote(doi, safe='')}"

    def lookup_doi(self, doi: str, *, timeout: float | None = None) -> VendorWork:
        url = self.work_url(doi)
        response = self.transport.get(
            url,
            headers={"Accept": "application/json"},
            timeout=self.request_timeout(timeout),
        )
        return self._work(parse_json(response, self.vendor))

    def resolve_pdf_doi(
        self, doi: str, *, timeout: float | None = None
    ) -> tuple[str, str]:
        url = self.work_url(doi)
        response = self.transport.get(
            url,
            headers={"Accept": "application/json"},
            timeout=self.request_timeout(timeout),
        )
        payload = parse_json(response, self.vendor)
        for name in ("best_oa_location", "primary_location"):
            location = payload.get(name)
            if isinstance(location, dict):
                candidate = string_value(location.get("pdf_url"))
                if candidate and candidate.startswith("https://"):
                    return candidate, response.url
        locations = payload.get("locations")
        if isinstance(locations, list):
            for location in locations:
                candidate = (
                    string_value(location.get("pdf_url"))
                    if isinstance(location, dict)
                    else None
                )
                if candidate and candidate.startswith("https://"):
                    return candidate, response.url
        raise IntegrationError("openalex supplied no PDF URL")

    def search(
        self,
        query: str,
        limit: int,
        year_from: int | None,
        year_to: int | None,
        *,
        timeout: float | None = None,
    ) -> tuple[VendorWork, ...]:
        base_params: dict[str, str | int] = {"search": query}
        filters = []
        if year_from is not None:
            filters.append(f"from_publication_date:{year_from:04d}-01-01")
        if year_to is not None:
            filters.append(f"to_publication_date:{year_to:04d}-12-31")
        if filters:
            base_params["filter"] = ",".join(filters)
        records: list[VendorWork] = []
        cursor = "*"
        while len(records) < limit:
            page_size = min(limit - len(records), OPENALEX_MAX_PAGE_SIZE)
            payload = self.get_json(
                params={
                    **base_params,
                    "per-page": page_size,
                    "cursor": cursor,
                },
                headers={"Accept": "application/json"},
                timeout=timeout,
            )
            items = payload.get("results")
            if not isinstance(items, list):
                raise IntegrationError("openalex returned malformed results")
            page = tuple(self._work(item) for item in items)
            records.extend(page[: limit - len(records)])
            if len(page) < page_size or len(records) == limit:
                break
            meta = payload.get("meta")
            if meta is None:
                break
            if not isinstance(meta, dict):
                raise IntegrationError("openalex returned malformed metadata")
            next_cursor = meta.get("next_cursor")
            if next_cursor is not None and not isinstance(next_cursor, str):
                raise IntegrationError("openalex returned malformed next cursor")
            if not next_cursor or next_cursor == cursor:
                break
            cursor = next_cursor
        return tuple(records)

    @staticmethod
    def _work(value: object) -> VendorWork:
        if not isinstance(value, dict) or not (
            raw_id := string_value(value.get("id"))
        ):
            raise IntegrationError("openalex returned a malformed work")
        inverted = value.get("abstract_inverted_index")
        abstract = None
        if inverted is not None:
            if not isinstance(inverted, dict):
                raise IntegrationError("openalex returned a malformed abstract")
            positions: list[tuple[int, str]] = []
            for word, indexes in inverted.items():
                if (
                    not isinstance(word, str)
                    or not isinstance(indexes, list)
                    or not all(isinstance(index, int) for index in indexes)
                ):
                    raise IntegrationError("openalex returned a malformed abstract")
                positions.extend((index, word) for index in indexes)
            abstract = abstract_value(
                " ".join(word for _, word in sorted(positions))
            )
        authorships = value.get("authorships", [])
        if not isinstance(authorships, list):
            raise IntegrationError("openalex returned malformed authorships")
        authors = tuple(
            name
            for item in authorships
            if isinstance(item, dict) and isinstance(item.get("author"), dict)
            if (name := string_value(item["author"].get("display_name")))
        )
        doi = string_value(value.get("doi"))
        if doi and doi.lower().startswith("https://doi.org/"):
            doi = doi[16:]
        best = value.get("best_oa_location") or value.get("primary_location")
        oa_url = string_value(best.get("pdf_url")) if isinstance(best, dict) else None
        date = string_value(value.get("publication_date"))
        title = string_value(value.get("title"))
        title = title or string_value(value.get("display_name"))
        return VendorWork(
            raw_id,
            title,
            abstract,
            doi,
            authors,
            publication_year(date, value.get("publication_year")),
            date,
            integer_value(value.get("cited_by_count")),
            raw_id,
            oa_url,
        )


__all__ = ("OpenAlexClient",)
