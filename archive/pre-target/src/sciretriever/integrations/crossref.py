"""Crossref metadata search and DOI lookup client."""

from __future__ import annotations

from typing import Any, Mapping
from urllib.parse import quote

from sciretriever.network import HttpResponse, Transport

from .common import BaseClient, IntegrationError, parse_json
from .models import VendorPage, VendorWork

CROSSREF_WORKS_URL = "https://api.crossref.org/works"


class CrossrefClient(BaseClient):
    vendor = "crossref"

    def __init__(
        self,
        transport: Transport,
        *,
        mailto: str | None = None,
        user_agent: str | None,
        timeout: float | None = 30.0,
        endpoint: str = CROSSREF_WORKS_URL,
    ) -> None:
        if mailto is not None and (
            not isinstance(mailto, str) or not mailto.strip()
        ):
            raise ValueError("mailto must be a non-blank string or None")
        if user_agent is not None and (
            not isinstance(user_agent, str) or not user_agent.strip()
        ):
            raise ValueError("user_agent must be a non-blank string")
        super().__init__(transport, timeout=timeout)
        self.endpoint = endpoint
        self.mailto = mailto.strip() if mailto is not None else None
        self.headers = (
            {"Accept": "application/json", "User-Agent": user_agent.strip()}
            if user_agent is not None
            else None
        )

    def work_url(self, doi: str) -> str:
        return f"{self.endpoint}/{quote(doi, safe='')}"

    def search(
        self,
        query: str,
        limit: int,
        year_from: int | None,
        year_to: int | None,
        *,
        max_page_size: int,
        timeout: float | None = None,
    ) -> tuple[VendorWork, ...]:
        records: list[VendorWork] = []
        cursor = "*"
        while len(records) < limit:
            rows = min(limit - len(records), max_page_size)
            params: dict[str, str | int] = {
                "query": query,
                "rows": rows,
                "cursor": cursor,
            }
            filters = self._filters(year_from, year_to)
            if filters:
                params["filter"] = filters
            if self.mailto is not None:
                params["mailto"] = self.mailto
            response = self.transport.get(
                self.endpoint,
                params=params,
                headers=self.headers,
                timeout=self.request_timeout(timeout),
            )
            page = self.parse_page(response)
            records.extend(page.works[: limit - len(records)])
            if len(page.works) < rows or len(records) == limit:
                break
            if page.next_cursor is None or page.next_cursor == cursor:
                break
            cursor = page.next_cursor
        return tuple(records)

    def lookup_doi(
        self, doi: str, *, timeout: float | None = None
    ) -> tuple[VendorWork, str]:
        url = self.work_url(doi)
        response = self.transport.get(
            url,
            headers=self.headers,
            timeout=self.request_timeout(timeout),
        )
        payload = parse_json(response, self.vendor)
        try:
            message = payload["message"]
            if not isinstance(message, dict):
                raise TypeError("message must be an object")
            return self.parse_work(message), response.url
        except (KeyError, TypeError, ValueError, IndexError) as error:
            raise IntegrationError("crossref returned malformed work schema") from error

    def resolve_pdf_doi(
        self, doi: str, *, timeout: float | None = None
    ) -> tuple[str, str]:
        url = self.work_url(doi)
        response = self.transport.get(
            url,
            headers=self.headers,
            timeout=self.request_timeout(timeout),
        )
        payload = parse_json(response, self.vendor)
        try:
            message = payload["message"]
            if not isinstance(message, dict):
                raise TypeError("message must be an object")
            links = message.get("link")
            if not isinstance(links, list):
                raise TypeError("message.link must be an array")
            for link in links:
                if not isinstance(link, dict):
                    raise TypeError("message.link entries must be objects")
                content_type = str(link.get("content-type", "")).lower()
                candidate = link.get("URL")
                if content_type == "application/pdf" and isinstance(candidate, str):
                    return candidate, response.url
        except (KeyError, TypeError, ValueError) as error:
            raise IntegrationError("crossref returned malformed link schema") from error
        raise IntegrationError("Crossref supplied no PDF link")

    @classmethod
    def parse_page(cls, response: HttpResponse) -> VendorPage:
        payload = parse_json(response, "crossref")
        try:
            message = payload["message"]
            if not isinstance(message, dict):
                raise TypeError("message must be an object")
            items = message["items"]
            if not isinstance(items, list) or not all(
                isinstance(item, dict) for item in items
            ):
                raise TypeError("message.items must be an array of objects")
            next_cursor = message.get("next-cursor")
            if next_cursor is not None and not isinstance(next_cursor, str):
                raise TypeError("message.next-cursor must be a string")
            return VendorPage(
                tuple(cls.parse_work(item) for item in items),
                next_cursor=next_cursor,
            )
        except (KeyError, TypeError, ValueError, IndexError) as error:
            raise IntegrationError("crossref returned malformed JSON or schema") from error

    @classmethod
    def parse_work(cls, item: Mapping[str, Any]) -> VendorWork:
        doi = cls._optional_string(item, "DOI")
        return VendorWork(
            raw_id=doi or "",
            title=cls._first_string(item, "title"),
            abstract=cls._optional_string(item, "abstract"),
            doi=doi,
            authors=cls._authors(item),
            year=cls._year(item),
            publication_date=cls._publication_date(item),
            venue=cls._first_string(item, "container-title"),
            identifiers=(("doi", doi),) if doi else (),
            keywords=cls._string_tuple(item, "subject"),
            publisher=cls._optional_string(item, "publisher"),
        )

    @classmethod
    def _publication_date(cls, item: Mapping[str, Any]) -> str | None:
        for key in ("published", "published-print", "published-online", "issued"):
            value = item.get(key)
            if not isinstance(value, dict):
                continue
            parts = value.get("date-parts")
            if (
                isinstance(parts, list)
                and parts
                and isinstance(parts[0], list)
                and parts[0]
                and all(isinstance(part, int) and not isinstance(part, bool) for part in parts[0])
            ):
                date = parts[0]
                if len(date) >= 3:
                    return f"{date[0]:04d}-{date[1]:02d}-{date[2]:02d}"
                return f"{date[0]:04d}"
        return None

    @staticmethod
    def _filters(year_from: int | None, year_to: int | None) -> str:
        filters: list[str] = []
        if year_from is not None:
            filters.append(f"from-pub-date:{year_from:04d}-01-01")
        if year_to is not None:
            filters.append(f"until-pub-date:{year_to:04d}-12-31")
        return ",".join(filters)

    @staticmethod
    def _optional_string(item: Mapping[str, Any], key: str) -> str | None:
        value = item.get(key)
        if value is None:
            return None
        if not isinstance(value, str):
            raise TypeError(f"{key} must be a string")
        return value

    @staticmethod
    def _first_string(item: Mapping[str, Any], key: str) -> str | None:
        values = item.get(key)
        if values is None:
            return None
        if not isinstance(values, list) or not all(
            isinstance(value, str) for value in values
        ):
            raise TypeError(f"{key} must be an array of strings")
        return values[0] if values else None

    @staticmethod
    def _string_tuple(item: Mapping[str, Any], key: str) -> tuple[str, ...]:
        values = item.get(key)
        if values is None:
            return ()
        if not isinstance(values, list) or not all(
            isinstance(value, str) for value in values
        ):
            raise TypeError(f"{key} must be an array of strings")
        return tuple(values)

    @staticmethod
    def _authors(item: Mapping[str, Any]) -> tuple[str, ...]:
        values = item.get("author")
        if values is None:
            return ()
        if not isinstance(values, list) or not all(
            isinstance(value, dict) for value in values
        ):
            raise TypeError("author must be an array of objects")
        authors: list[str] = []
        for value in values:
            name = value.get("name")
            if name is not None:
                if not isinstance(name, str):
                    raise TypeError("author.name must be a string")
                authors.append(name)
                continue
            given = value.get("given")
            family = value.get("family")
            if given is not None and not isinstance(given, str):
                raise TypeError("author.given must be a string")
            if family is not None and not isinstance(family, str):
                raise TypeError("author.family must be a string")
            combined = " ".join(part for part in (given, family) if part)
            if combined:
                authors.append(combined)
        return tuple(authors)

    @staticmethod
    def _year(item: Mapping[str, Any]) -> int | None:
        for key in ("published", "published-print", "published-online", "issued"):
            value = item.get(key)
            if value is None:
                continue
            if not isinstance(value, dict):
                raise TypeError(f"{key} must be an object")
            date_parts = value.get("date-parts")
            if (
                not isinstance(date_parts, list)
                or not date_parts
                or not isinstance(date_parts[0], list)
                or not date_parts[0]
            ):
                raise TypeError(f"{key}.date-parts must contain a date")
            year = date_parts[0][0]
            if year is None:
                continue
            if not isinstance(year, int) or isinstance(year, bool):
                raise TypeError(f"{key} year must be an integer")
            return year
        return None


__all__ = ("CROSSREF_WORKS_URL", "CrossrefClient")
