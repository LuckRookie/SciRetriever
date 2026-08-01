"""Bounded in-memory article identity validation for acquired content."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from io import BytesIO
import re
from typing import Protocol
import unicodedata
import xml.etree.ElementTree as ET

from bs4 import BeautifulSoup, Tag
from PyPDF2 import PdfReader

from sciretriever.acquisition.models import AcquisitionTarget, ProviderContent
from sciretriever.core.enums import AssetRole


MAX_TEXT_CHARACTERS = 200_000
MAX_PDF_PAGES = 5
MAX_METADATA_FIELDS = 128
_DOI = re.compile(r"10\.\d{4,9}/[-._;()/:a-z0-9]+", re.IGNORECASE)
_YEAR = re.compile(r"(?<!\d)(?:18|19|20|21)\d{2}(?!\d)")
_STOPWORDS = frozenset({
    "a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of",
    "on", "or", "the", "to", "using", "via", "with",
})


class IdentityDisposition(str, Enum):
    PASS = "pass"
    MISMATCH = "mismatch"
    UNCONFIRMED = "unconfirmed"


@dataclass(frozen=True, slots=True)
class IdentityValidationResult:
    disposition: IdentityDisposition


class IdentityValidator(Protocol):
    def validate(
        self, content: ProviderContent, target: AcquisitionTarget
    ) -> IdentityValidationResult: ...


@dataclass(slots=True)
class _Evidence:
    declared_dois: set[str]
    leading_dois: set[str]
    declared_titles: list[str]
    text: str
    authors: set[str]
    years: set[int]


@dataclass(slots=True)
class _CharacterBudget:
    remaining: int = MAX_TEXT_CHARACTERS

    def take(self, value: str | None) -> str:
        if not value or self.remaining <= 0:
            return ""
        bounded = value[:self.remaining]
        self.remaining -= len(bounded)
        return bounded


def _normalize_doi(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).strip().casefold()
    normalized = re.sub(
        r"^(?:doi\s*:\s*|https?://(?:dx\.)?doi\.org/)", "", normalized
    )
    return normalized.rstrip(" \t\r\n.,;:)]}")


def _dois(value: str) -> set[str]:
    return {_normalize_doi(match.group(0)) for match in _DOI.finditer(value)}


def _normalize_title(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    without_punctuation = "".join(
        " " if unicodedata.category(character)[0] in {"P", "S"} else character
        for character in normalized
    )
    return " ".join(without_punctuation.split())


def _tokens(value: str) -> tuple[str, ...]:
    return tuple(
        token for token in _normalize_title(value).split()
        if token not in _STOPWORDS and len(token) > 1
    )[:256]


def _surname(value: str) -> str:
    tokens = _tokens(value)
    return tokens[-1] if tokens else ""


def _coverage(expected: tuple[str, ...], observed: str) -> float:
    if not expected:
        return 0.0
    observed_tokens = set(_tokens(observed))
    return len(set(expected) & observed_tokens) / len(set(expected))


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].casefold()


class ContentIdentityValidator:
    """Confirm a target identity from bounded PDF, XML, or HTML evidence."""

    def validate(
        self, content: ProviderContent, target: AcquisitionTarget
    ) -> IdentityValidationResult:
        try:
            evidence = self._extract(content)
        except Exception:
            return IdentityValidationResult(IdentityDisposition.UNCONFIRMED)
        expected_dois = {
            _normalize_doi(identifier.value)
            for identifier in target.identifiers
            if identifier.namespace.casefold() == "doi"
        }
        expected_title = _normalize_title(target.title or "")
        if not expected_dois and not expected_title:
            return IdentityValidationResult(IdentityDisposition.UNCONFIRMED)
        if expected_dois & (evidence.declared_dois | evidence.leading_dois):
            return IdentityValidationResult(IdentityDisposition.PASS)
        if evidence.declared_dois and not expected_dois.intersection(evidence.declared_dois):
            return IdentityValidationResult(IdentityDisposition.MISMATCH)
        if expected_title:
            expected_tokens = _tokens(expected_title)
            searchable = " ".join((*evidence.declared_titles, evidence.text))
            normalized_searchable = _normalize_title(searchable)
            if len(expected_title) >= 12 and expected_title in normalized_searchable:
                return IdentityValidationResult(IdentityDisposition.PASS)
            coverage = _coverage(expected_tokens, searchable)
            if len(expected_tokens) >= 4 and coverage >= 0.85:
                return IdentityValidationResult(IdentityDisposition.PASS)
            expected_surnames = {_surname(author) for author in target.authors} - {""}
            corroborated = bool(expected_surnames & evidence.authors) or (
                target.publication_year is not None
                and target.publication_year in evidence.years
            )
            if len(expected_tokens) >= 4 and coverage >= 0.65 and corroborated:
                return IdentityValidationResult(IdentityDisposition.PASS)
            for declared_title in evidence.declared_titles:
                declared_tokens = _tokens(declared_title)
                if len(declared_tokens) >= 4 and _coverage(expected_tokens, declared_title) < 0.30:
                    return IdentityValidationResult(IdentityDisposition.MISMATCH)
        return IdentityValidationResult(IdentityDisposition.UNCONFIRMED)

    def _extract(self, content: ProviderContent) -> _Evidence:
        if content.role in {AssetRole.PRIMARY_PDF, AssetRole.SUPPLEMENTARY_PDF}:
            return self._pdf(content.data)
        if content.role is AssetRole.XML:
            return self._xml(content.data)
        if content.role is AssetRole.HTML:
            return self._html(content.data)
        raise ValueError("unsupported identity validation role")

    @staticmethod
    def _pdf(data: bytes) -> _Evidence:
        reader = PdfReader(BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise ValueError("encrypted PDF")
        metadata = reader.metadata or {}
        metadata_text = " ".join(str(value) for value in metadata.values() if value)
        declared_dois = _dois(metadata_text)
        declared_titles = [str(metadata.get("/Title", ""))] if metadata.get("/Title") else []
        authors = {
            _surname(str(metadata.get(key, ""))) for key in ("/Author", "/Authors")
        } - {""}
        years = {int(year) for year in _YEAR.findall(metadata_text)}
        parts: list[str] = []
        remaining = MAX_TEXT_CHARACTERS
        for page in reader.pages[:MAX_PDF_PAGES]:
            if remaining <= 0:
                break
            text = page.extract_text() or ""
            parts.append(text[:remaining])
            remaining -= min(len(text), remaining)
        leading = " ".join(parts)
        return _Evidence(declared_dois, _dois(leading), declared_titles, leading, authors, years)

    @staticmethod
    def _xml(data: bytes) -> _Evidence:
        root = ET.fromstring(data)
        texts: list[str] = []
        dois: set[str] = set()
        titles: list[str] = []
        authors: set[str] = set()
        years: set[int] = set()
        budget = _CharacterBudget()
        metadata_fields = 0
        for element in root.iter():
            name = _local_name(element.tag)
            recognized = name in {
                "article-id", "pub-id", "article-title", "title", "surname",
                "name", "date", "year", "pub-date",
            }
            if recognized and metadata_fields < MAX_METADATA_FIELDS and budget.remaining:
                metadata_fields += 1
                value_parts: list[str] = []
                for part in element.itertext():
                    bounded = budget.take(part)
                    if bounded:
                        value_parts.append(bounded)
                    if not budget.remaining:
                        break
                value = " ".join(value_parts).strip()
                if name in {"article-id", "pub-id"}:
                    dois.update(_dois(value))
                elif name in {"article-title", "title"} and value:
                    titles.append(value)
                elif name in {"surname", "name"}:
                    surname = _surname(value)
                    if surname:
                        authors.add(surname)
                elif name in {"date", "year", "pub-date"}:
                    years.update(int(year) for year in _YEAR.findall(value))
            direct_text = budget.take(element.text)
            if direct_text:
                texts.append(direct_text)
            tail = budget.take(element.tail)
            if tail:
                texts.append(tail)
        text = " ".join(texts)
        return _Evidence(dois, _dois(text), titles, text, authors, years)

    @staticmethod
    def _html(data: bytes) -> _Evidence:
        text = data.decode("utf-8")
        soup = BeautifulSoup(text, "html.parser")
        for element in soup(["script", "style"]):
            element.decompose()
        dois: set[str] = set()
        titles: list[str] = []
        authors: set[str] = set()
        years: set[int] = set()
        metadata_budget = _CharacterBudget()
        metadata_fields = 0
        for meta in soup.find_all("meta"):
            if not isinstance(meta, Tag):
                continue
            name = str(meta.get("name") or meta.get("property") or "").casefold()
            recognized = name in {
                "citation_doi", "dc.identifier", "dc.identifier.doi", "prism.doi",
                "citation_title", "dc.title", "og:title", "citation_author",
                "dc.creator", "author", "citation_publication_date", "citation_date",
                "dc.date", "article:published_time",
            }
            if not recognized or metadata_fields >= MAX_METADATA_FIELDS:
                continue
            metadata_fields += 1
            value = metadata_budget.take(str(meta.get("content") or ""))
            if not value:
                continue
            if name in {"citation_doi", "dc.identifier", "dc.identifier.doi", "prism.doi"}:
                dois.update(_dois(value))
            elif name in {"citation_title", "dc.title", "og:title"} and value:
                titles.append(value)
            elif name in {"citation_author", "dc.creator", "author"}:
                surname = _surname(value)
                if surname:
                    authors.add(surname)
            elif name in {"citation_publication_date", "citation_date", "dc.date", "article:published_time"}:
                years.update(int(year) for year in _YEAR.findall(value))
        visible = soup.get_text(" ", strip=True)[:MAX_TEXT_CHARACTERS]
        return _Evidence(dois, _dois(visible), titles, visible, authors, years)


__all__ = (
    "ContentIdentityValidator", "IdentityDisposition", "IdentityValidationResult",
    "IdentityValidator", "MAX_METADATA_FIELDS", "MAX_PDF_PAGES",
    "MAX_TEXT_CHARACTERS",
)
