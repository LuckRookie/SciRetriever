"""Europe PMC metadata search and full-text route resolution client."""

from __future__ import annotations

from typing import Any, Mapping
from urllib.parse import quote

from sciretriever.network import HttpResponse, Transport, url_with_params

from .common import BaseClient, IntegrationError, parse_json
from .models import VendorPage, VendorWork

EUROPE_PMC_SEARCH_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"


class EuropePmcClient(BaseClient):
    vendor = "europe-pmc"

    def __init__(
        self,
        transport: Transport,
        *,
        user_agent: str | None,
        timeout: float | None = 30.0,
        endpoint: str = EUROPE_PMC_SEARCH_URL,
    ) -> None:
        if user_agent is not None and (
            not isinstance(user_agent, str) or not user_agent.strip()
        ):
            raise ValueError("user_agent must be a non-blank string")
        super().__init__(transport, timeout=timeout)
        self.endpoint = endpoint
        self.headers = (
            {"Accept": "application/json", "User-Agent": user_agent.strip()}
            if user_agent is not None
            else None
        )

    def lookup_url(self, *, doi: str | None = None, pmid: str | None = None) -> str:
        query = self.lookup_query(doi=doi, pmid=pmid)
        return url_with_params(self.endpoint, {"query": query, "format": "json"})

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
        query = self.query_with_years(query, year_from, year_to)
        records: list[VendorWork] = []
        cursor = "*"
        while len(records) < limit:
            page_size = min(limit - len(records), max_page_size)
            response = self.transport.get(
                self.endpoint,
                params={
                    "query": query,
                    "format": "json",
                    "resultType": "core",
                    "pageSize": page_size,
                    "cursorMark": cursor,
                },
                headers=self.headers,
                timeout=self.request_timeout(timeout),
            )
            page = self.parse_page(response)
            records.extend(page.works[: limit - len(records)])
            if len(page.works) < page_size or len(records) == limit:
                break
            if page.next_cursor is None or page.next_cursor == cursor:
                break
            cursor = page.next_cursor
        return tuple(records)

    def resolve_pdf_route(
        self,
        *,
        doi: str | None = None,
        pmid: str | None = None,
        timeout: float | None = None,
    ) -> tuple[str, str]:
        query = self.lookup_query(doi=doi, pmid=pmid)
        response = self.transport.get(
            self.endpoint,
            params={"query": query, "format": "json"},
            headers=self.headers,
            timeout=self.request_timeout(timeout),
        )
        page = self.parse_page(response, include_routes=True)
        if not page.works:
            raise IntegrationError("Europe PMC found no matching work")
        for work in page.works:
            if work.open_access_url is not None:
                return work.open_access_url, response.url
        raise IntegrationError("Europe PMC supplied no PDF route")

    @staticmethod
    def lookup_query(*, doi: str | None = None, pmid: str | None = None) -> str:
        if pmid is not None:
            return f"EXT_ID:{pmid}"
        if doi is not None:
            return f'DOI:"{doi}"'
        raise ValueError("Europe PMC lookup requires a DOI or PMID")

    @classmethod
    def parse_page(
        cls, response: HttpResponse, *, include_routes: bool = False
    ) -> VendorPage:
        payload = parse_json(response, "europe-pmc")
        try:
            result_list = payload["resultList"]
            if not isinstance(result_list, dict):
                raise TypeError("resultList must be an object")
            items = result_list["result"]
            if not isinstance(items, list) or not all(
                isinstance(item, dict) for item in items
            ):
                raise TypeError("resultList.result must be an array of objects")
            next_cursor = payload.get("nextCursorMark")
            if next_cursor is not None and not isinstance(next_cursor, str):
                raise TypeError("nextCursorMark must be a string")
            return VendorPage(
                tuple(
                    cls.parse_work(item, include_route=include_routes)
                    for item in items
                ),
                next_cursor=next_cursor,
            )
        except (KeyError, TypeError, ValueError) as error:
            raise IntegrationError(
                "europe-pmc returned malformed JSON or schema"
            ) from error

    @classmethod
    def parse_work(
        cls, item: Mapping[str, Any], *, include_route: bool = False
    ) -> VendorWork:
        doi = cls._optional_string(item, "doi")
        pmid = cls._optional_string(item, "pmid")
        pmcid = cls._optional_string(item, "pmcid")
        identifiers = tuple(
            (namespace, value)
            for namespace, value in (
                ("doi", doi),
                ("pmid", pmid),
                ("pmcid", pmcid),
            )
            if value
        )
        open_access = item.get("isOpenAccess")
        if open_access not in {None, "Y", "N"}:
            raise TypeError("isOpenAccess must be Y or N")
        return VendorWork(
            raw_id=doi or pmid or pmcid or "",
            title=cls._optional_string(item, "title"),
            abstract=cls._optional_string(item, "abstractText"),
            doi=doi,
            authors=cls._authors(item),
            year=cls._year(item),
            venue=cls._venue(item),
            open_access_url=cls._pdf_route(item, pmcid) if include_route else None,
            identifiers=identifiers,
            keywords=cls._keywords(item),
            open_access_status=(
                None
                if open_access is None
                else "open" if open_access == "Y" else "closed"
            ),
        )

    @staticmethod
    def query_with_years(
        query: str, year_from: int | None, year_to: int | None
    ) -> str:
        if year_from is None and year_to is None:
            return query
        lower = f"{year_from:04d}-01-01" if year_from is not None else "*"
        upper = f"{year_to:04d}-12-31" if year_to is not None else "*"
        return f"({query}) AND FIRST_PDATE:[{lower} TO {upper}]"

    @staticmethod
    def _optional_string(item: Mapping[str, Any], key: str) -> str | None:
        value = item.get(key)
        if value is None:
            return None
        if not isinstance(value, str):
            raise TypeError(f"{key} must be a string")
        return value

    @classmethod
    def _authors(cls, item: Mapping[str, Any]) -> tuple[str, ...]:
        author_list = item.get("authorList")
        if author_list is None:
            return ()
        if not isinstance(author_list, dict):
            raise TypeError("authorList must be an object")
        values = author_list.get("author")
        if values is None:
            return ()
        if not isinstance(values, list) or not all(
            isinstance(value, dict) for value in values
        ):
            raise TypeError("authorList.author must be an array of objects")
        authors: list[str] = []
        for value in values:
            full_name = value.get("fullName")
            if full_name is None:
                continue
            if not isinstance(full_name, str):
                raise TypeError("author.fullName must be a string")
            authors.append(full_name)
        return tuple(authors)

    @staticmethod
    def _year(item: Mapping[str, Any]) -> int | None:
        value = item.get("pubYear")
        if value is None:
            return None
        if isinstance(value, int) and not isinstance(value, bool):
            return value
        if isinstance(value, str) and value.isascii() and value.isdecimal():
            return int(value)
        raise TypeError("pubYear must be an integer year")

    @staticmethod
    def _venue(item: Mapping[str, Any]) -> str | None:
        journal_info = item.get("journalInfo")
        if journal_info is None:
            return None
        if not isinstance(journal_info, dict):
            raise TypeError("journalInfo must be an object")
        journal = journal_info.get("journal")
        if journal is None:
            return None
        if not isinstance(journal, dict):
            raise TypeError("journalInfo.journal must be an object")
        title = journal.get("title")
        if title is not None and not isinstance(title, str):
            raise TypeError("journalInfo.journal.title must be a string")
        return title

    @staticmethod
    def _keywords(item: Mapping[str, Any]) -> tuple[str, ...]:
        keyword_list = item.get("keywordList")
        if keyword_list is None:
            return ()
        if not isinstance(keyword_list, dict):
            raise TypeError("keywordList must be an object")
        values = keyword_list.get("keyword")
        if values is None:
            return ()
        if not isinstance(values, list) or not all(
            isinstance(value, str) for value in values
        ):
            raise TypeError("keywordList.keyword must be an array of strings")
        return tuple(values)

    @staticmethod
    def _pdf_route(item: Mapping[str, Any], pmcid: str | None) -> str | None:
        url_list = item.get("fullTextUrlList")
        if url_list is not None:
            if not isinstance(url_list, dict):
                raise TypeError("fullTextUrlList must be an object")
            values = url_list.get("fullTextUrl")
            if not isinstance(values, list):
                raise TypeError("fullTextUrlList.fullTextUrl must be an array")
            for value in values:
                if not isinstance(value, dict):
                    raise TypeError("fullTextUrl entries must be objects")
                if (
                    str(value.get("documentStyle", "")).lower() == "pdf"
                    and isinstance(value.get("url"), str)
                ):
                    return value["url"]
        if pmcid and pmcid.strip():
            identifier = quote(pmcid, safe="")
            return (
                "https://www.ebi.ac.uk/europepmc/webservices/rest/"
                f"{identifier}/fullTextPDF"
            )
        return None


__all__ = ("EUROPE_PMC_SEARCH_URL", "EuropePmcClient")
