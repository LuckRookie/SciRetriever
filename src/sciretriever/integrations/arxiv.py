"""arXiv Atom metadata search and canonical PDF routing client."""

from __future__ import annotations

from collections.abc import Callable
from urllib.parse import quote, urlsplit
from xml.etree import ElementTree

from sciretriever.network import HttpResponse, Transport

from .common import BaseClient, IntegrationError
from .models import VendorPage, VendorWork

ARXIV_QUERY_URL = "https://export.arxiv.org/api/query"
ATOM = "http://www.w3.org/2005/Atom"
ARXIV = "http://arxiv.org/schemas/atom"
OPENSEARCH = "http://a9.com/-/spec/opensearch/1.1/"


class ArxivClient(BaseClient):
    vendor = "arxiv"

    def __init__(
        self,
        transport: Transport,
        *,
        user_agent: str | None,
        timeout: float | None = 30.0,
        endpoint: str = ARXIV_QUERY_URL,
    ) -> None:
        if user_agent is not None and (
            not isinstance(user_agent, str) or not user_agent.strip()
        ):
            raise ValueError("user_agent must be a non-blank string")
        super().__init__(transport, timeout=timeout)
        self.endpoint = endpoint
        self.headers = (
            {"Accept": "application/atom+xml", "User-Agent": user_agent.strip()}
            if user_agent is not None
            else None
        )

    def search(
        self,
        query: str,
        limit: int,
        year_from: int | None,
        year_to: int | None,
        *,
        max_page_size: int,
        sleeper: Callable[[float], None],
        page_delay: float,
        timeout: float | None = None,
    ) -> tuple[VendorWork, ...]:
        query = self.query_with_years(query, year_from, year_to)
        records: list[VendorWork] = []
        start = 0
        while len(records) < limit:
            page_size = min(limit - len(records), max_page_size)
            response = self.transport.get(
                self.endpoint,
                params={
                    "search_query": query,
                    "start": start,
                    "max_results": page_size,
                },
                headers=self.headers,
                timeout=self.request_timeout(timeout),
            )
            page = self.parse_page(response)
            records.extend(page.works[: limit - len(records)])
            start += len(page.works)
            if len(page.works) < page_size or len(records) == limit:
                break
            if page.total_results is not None and start >= page.total_results:
                break
            sleeper(page_delay)
        return tuple(records)

    @staticmethod
    def pdf_url(identifier: str) -> str:
        return f"https://arxiv.org/pdf/{quote(identifier, safe='/')}.pdf"

    @staticmethod
    def query_with_years(
        query: str, year_from: int | None, year_to: int | None
    ) -> str:
        if year_from is None and year_to is None:
            return query
        lower = f"{year_from:04d}01010000" if year_from is not None else "000001010000"
        upper = f"{year_to:04d}12312359" if year_to is not None else "999912312359"
        return f"({query}) AND submittedDate:[{lower} TO {upper}]"

    @classmethod
    def parse_page(cls, response: HttpResponse) -> VendorPage:
        if not 200 <= response.status < 300:
            raise IntegrationError(
                f"arxiv returned HTTP {response.status}", status=response.status
            )
        try:
            root = ElementTree.fromstring(response.body)
            if root.tag != f"{{{ATOM}}}feed":
                raise TypeError("root element must be an Atom feed")
            entries = root.findall(f"{{{ATOM}}}entry")
            total_element = root.find(f"{{{OPENSEARCH}}}totalResults")
            total_results: int | None = None
            if total_element is not None:
                if (
                    total_element.text is None
                    or not total_element.text.strip().isdecimal()
                ):
                    raise TypeError("opensearch:totalResults must be an integer")
                total_results = int(total_element.text.strip())
            return VendorPage(
                tuple(cls.parse_work(entry) for entry in entries),
                total_results=total_results,
            )
        except (ElementTree.ParseError, TypeError, ValueError) as error:
            raise IntegrationError(
                "arxiv returned malformed Atom XML or schema"
            ) from error

    @classmethod
    def parse_work(cls, entry: ElementTree.Element) -> VendorWork:
        raw_id = cls._required_text(entry, f"{{{ATOM}}}id", "entry id")
        arxiv_id = cls._arxiv_identifier(raw_id)
        doi = cls._optional_text(entry, f"{{{ARXIV}}}doi")
        identifiers = (("arxiv", arxiv_id),)
        if doi:
            identifiers += (("doi", doi),)
        return VendorWork(
            raw_id=arxiv_id,
            title=cls._optional_text(entry, f"{{{ATOM}}}title"),
            abstract=cls._optional_text(entry, f"{{{ATOM}}}summary"),
            doi=doi,
            authors=tuple(
                cls._required_text(author, f"{{{ATOM}}}name", "author name")
                for author in entry.findall(f"{{{ATOM}}}author")
            ),
            year=cls._published_year(entry),
            venue=cls._optional_text(entry, f"{{{ARXIV}}}journal_ref"),
            identifiers=identifiers,
            keywords=cls._categories(entry),
        )

    @classmethod
    def _optional_text(
        cls, parent: ElementTree.Element, tag: str
    ) -> str | None:
        element = parent.find(tag)
        return None if element is None else cls._element_content(element)

    @classmethod
    def _required_text(
        cls, parent: ElementTree.Element, tag: str, name: str
    ) -> str:
        value = cls._optional_text(parent, tag)
        if value is None or not value.strip():
            raise TypeError(f"{name} must contain text")
        return value

    @staticmethod
    def _element_content(element: ElementTree.Element) -> str:
        if not list(element):
            return element.text or ""
        content = element.text or ""
        content += "".join(
            ElementTree.tostring(child, encoding="unicode") for child in element
        )
        return content

    @staticmethod
    def _arxiv_identifier(raw_id: str) -> str:
        path = urlsplit(raw_id).path.rstrip("/")
        marker = "/abs/"
        if marker not in path:
            raise ValueError("entry id must be an arXiv abstract URL")
        identifier = path.split(marker, 1)[1]
        if not identifier:
            raise ValueError("entry id must contain an arXiv identifier")
        return identifier

    @classmethod
    def _published_year(cls, entry: ElementTree.Element) -> int | None:
        published = cls._optional_text(entry, f"{{{ATOM}}}published")
        if published is None:
            return None
        if (
            len(published) < 4
            or not published[:4].isascii()
            or not published[:4].isdecimal()
        ):
            raise TypeError("published must begin with a four-digit year")
        return int(published[:4])

    @staticmethod
    def _categories(entry: ElementTree.Element) -> tuple[str, ...]:
        categories: list[str] = []
        for category in entry.findall(f"{{{ATOM}}}category"):
            term = category.get("term")
            if term is None:
                raise TypeError("category must have a term")
            categories.append(term)
        return tuple(categories)


__all__ = ("ARXIV_QUERY_URL", "ArxivClient")
