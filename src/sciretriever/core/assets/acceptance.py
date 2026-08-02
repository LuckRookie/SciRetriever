from __future__ import annotations

import re
import unicodedata
import xml.etree.ElementTree as ElementTree
from html.parser import HTMLParser
from io import BytesIO
from typing import assert_never

from PyPDF2 import PdfReader
from PyPDF2.errors import PdfReadError

from sciretriever.model import assets as asset_models
from sciretriever.model.access import BoundedByteStream
from sciretriever.model.primitives import AssetId, AssetRole, LightDocumentId

from .errors import AssetValidationCode

_DOI_PATTERN = re.compile(r"10\.\d{4,9}/[-._;()/:a-z0-9]+", re.IGNORECASE)
_MAX_PDF_PAGES = 5
_MAX_TEXT_CHARACTERS = 200_000
_MAX_METADATA_FIELDS = 128
_HTML_DOI_METADATA_NAMES = frozenset(
    {"citation_doi", "dc.identifier", "dc.identifier.doi", "prism.doi"}
)


def _dois(value: str) -> set[str]:
    return {match.group(0).casefold().rstrip(".,;:)]}") for match in _DOI_PATTERN.finditer(value)}


def _local_name(value: str) -> str:
    return value.rsplit("}", 1)[-1].casefold()


class _VisibleTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._hidden_depth = 0
        self._fragments: list[str] = []
        self.declared_dois: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {name.casefold(): value or "" for name, value in attrs}
        if tag.casefold() == "meta":
            name = (attributes.get("name") or attributes.get("property") or "").casefold()
            if name in _HTML_DOI_METADATA_NAMES:
                self.declared_dois.update(_dois(attributes.get("content", "")))
        if tag.casefold() in {"head", "script", "style", "template"}:
            self._hidden_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() in {"head", "script", "style", "template"} and self._hidden_depth:
            self._hidden_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._hidden_depth == 0:
            self._fragments.append(data)

    def text(self) -> str:
        return " ".join(fragment.strip() for fragment in self._fragments if fragment.strip())


def _normalized(value: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", unicodedata.normalize("NFKC", value).casefold()))


def _doi(target: asset_models.ContentTarget) -> str | None:
    return next(
        (
            item.value.casefold()
            for item in target.current_metadata.identifiers
            if item.namespace.casefold() == "doi"
        ),
        None,
    )


def validate_asset(
    content: BoundedByteStream,
    target: asset_models.ContentTarget,
    role: AssetRole,
    *,
    min_pdf_bytes: int,
    max_asset_bytes: int,
) -> AssetValidationCode | None:
    """Return the stable rejection code for one bounded asset candidate."""
    data = b"".join(content.chunks)
    if not data or len(data) > max_asset_bytes or content.size != len(data):
        return AssetValidationCode.SIZE_INVALID
    match role:
        case AssetRole.PRIMARY_PDF | AssetRole.SUPPLEMENTARY_PDF:
            return _validate_pdf(content, target, role, min_pdf_bytes)
        case AssetRole.XML:
            if content.media_type.split(";", 1)[0].strip().lower() not in {
                "application/xml",
                "text/xml",
                "application/jats+xml",
            }:
                return AssetValidationCode.MEDIA_TYPE_INVALID
            if not data.lstrip().startswith(b"<"):
                return AssetValidationCode.FORMAT_INVALID
            return _validate_xml(data, target)
        case AssetRole.HTML:
            if content.media_type.split(";", 1)[0].strip().lower() not in {
                "text/html",
                "application/xhtml+xml",
            }:
                return AssetValidationCode.MEDIA_TYPE_INVALID
            if b"<html" not in data[:2048].lower():
                return AssetValidationCode.FORMAT_INVALID
            return _validate_html(data, target)
        case AssetRole.SUPPLEMENTARY:
            return None
        case unreachable:
            assert_never(unreachable)


def decide_primary_current(
    target: asset_models.ContentTarget,
) -> asset_models.ContentAssetReplay | asset_models.ContentAssetFailure | None:
    """Return replay, invalid-current, or no decision for a primary asset."""
    current = target.current_accepted_content
    if current is None:
        return None
    match current.content_id:
        case AssetId():
            return asset_models.ContentAssetReplay(
                asset_id=current.content_id,
                sha256=current.sha256,
            )
        case LightDocumentId():
            return asset_models.ContentAssetFailure(code="current-primary-invalid", evidence=())
        case unreachable:
            assert_never(unreachable)


def _bounded_pdf_text(reader: PdfReader) -> list[str]:
    text_fragments: list[str] = []
    remaining = _MAX_TEXT_CHARACTERS
    for page_index in range(min(len(reader.pages), _MAX_PDF_PAGES)):
        if remaining <= 0:
            break
        fragment = (reader.pages[page_index].extract_text() or "").strip()
        if fragment:
            text_fragments.append(fragment[:remaining])
            remaining -= min(len(fragment), remaining)
    return text_fragments


def _validate_pdf(
    content: BoundedByteStream,
    target: asset_models.ContentTarget,
    role: AssetRole,
    min_pdf_bytes: int,
) -> AssetValidationCode | None:
    data = b"".join(content.chunks)
    if len(data) < min_pdf_bytes:
        return AssetValidationCode.SIZE_INVALID
    if content.media_type.split(";", 1)[0].strip().lower() != "application/pdf":
        return AssetValidationCode.MEDIA_TYPE_INVALID
    if not data.startswith(b"%PDF-") or b"%%EOF" not in data[-1024:]:
        return AssetValidationCode.FORMAT_INVALID
    try:
        reader = PdfReader(BytesIO(data), strict=True)
        if reader.is_encrypted or len(reader.pages) < 1:
            return AssetValidationCode.PARSE_INVALID
        metadata = reader.metadata
        text_fragments = _bounded_pdf_text(reader)
    except (PdfReadError, OSError, ValueError, TypeError, KeyError):
        return AssetValidationCode.PARSE_INVALID
    if not text_fragments:
        return AssetValidationCode.PARSE_INVALID
    opening = _normalized(text_fragments[0][:200])
    if opening.startswith(("supplementary information", "supporting information")):
        return AssetValidationCode.NOT_PRIMARY
    metadata_evidence = (
        ""
        if metadata is None
        else " ".join(
            str(value) for value in tuple(metadata.values())[:_MAX_METADATA_FIELDS] if value
        )[:_MAX_TEXT_CHARACTERS]
    )
    declared_dois = _dois(metadata_evidence)
    evidence = " ".join((metadata_evidence, *text_fragments)).strip()
    if role is AssetRole.SUPPLEMENTARY_PDF:
        return _validate_supplementary_identity(declared_dois, target)
    title = "" if metadata is None else str(metadata.title or "")
    author = "" if metadata is None else str(metadata.author or "")
    return _validate_primary_identity(title, author, declared_dois, evidence, target)


def _validate_xml(data: bytes, target: asset_models.ContentTarget) -> AssetValidationCode | None:
    try:
        root = ElementTree.fromstring(data)
    except ElementTree.ParseError:
        return AssetValidationCode.PARSE_INVALID
    text = " ".join(fragment.strip() for fragment in root.itertext() if fragment.strip())
    if not text:
        return AssetValidationCode.PARSE_INVALID
    declared_dois: set[str] = set()
    for element in root.iter():
        name = _local_name(element.tag)
        attribute_values = {
            _local_name(key): value.casefold() for key, value in element.attrib.items()
        }
        is_doi_field = name == "doi" or (
            name in {"article-id", "pub-id"} and "doi" in attribute_values.values()
        )
        if is_doi_field:
            declared_dois.update(_dois(" ".join(element.itertext())))
    return _validate_supplementary_identity(declared_dois, target)


def _validate_html(data: bytes, target: asset_models.ContentTarget) -> AssetValidationCode | None:
    parser = _VisibleTextParser()
    parser.feed(data.decode("utf-8", errors="replace"))
    parser.close()
    text = parser.text()
    if not text:
        return AssetValidationCode.PARSE_INVALID
    return _validate_supplementary_identity(parser.declared_dois, target)


def _validate_supplementary_identity(
    declared_dois: set[str], target: asset_models.ContentTarget
) -> AssetValidationCode | None:
    expected_doi = _doi(target)
    if expected_doi is None:
        return None
    if declared_dois and expected_doi not in declared_dois:
        return AssetValidationCode.IDENTITY_MISMATCH
    return None


def _validate_primary_identity(
    title: str,
    author: str,
    declared_dois: set[str],
    evidence: str,
    target: asset_models.ContentTarget,
) -> AssetValidationCode | None:
    if "supplement" in _normalized(title):
        return AssetValidationCode.NOT_PRIMARY
    expected_doi = _doi(target)
    if expected_doi is not None:
        if expected_doi in declared_dois:
            return None
        if declared_dois:
            return AssetValidationCode.IDENTITY_MISMATCH
    expected_title = _normalized(target.current_metadata.title)
    title_matches = bool(expected_title) and _normalized(title) == expected_title
    surnames = {
        _normalized(item).split()[-1]
        for item in target.current_metadata.authors
        if _normalized(item)
    }
    author_matches = bool(surnames) and bool(surnames.intersection(_normalized(author).split()))
    year = target.current_metadata.publication_year
    year_matches = year is not None and str(year) in evidence
    if title_matches and author_matches and year_matches:
        return None
    return AssetValidationCode.IDENTITY_UNCONFIRMED


__all__ = ("decide_primary_current", "validate_asset")
