"""Strict bounded PRIMARY_PDF business validation."""

from __future__ import annotations

from importlib import import_module
from html.parser import HTMLParser
from io import BytesIO
import xml.etree.ElementTree as ET

from sciretriever.acquisition.models import ProviderContent
from sciretriever.core.enums import AssetRole
from sciretriever.errors import ValidationError


MIN_PDF_BYTES = 1_000
# Conservative P4 preview guard derived from the scansci evidence threshold:
# a single-page PDF below 50 KiB is treated as a likely preview, not an article.
SINGLE_PAGE_PREVIEW_MAX_BYTES = 50 * 1024


def validate_primary_pdf(
    content: ProviderContent,
    *,
    min_bytes: int = MIN_PDF_BYTES,
    max_bytes: int = 100 * 1024 * 1024,
    expected_role: AssetRole = AssetRole.PRIMARY_PDF,
) -> None:
    if min_bytes <= 0 or max_bytes <= 0 or min_bytes > max_bytes:
        raise ValueError("PDF size bounds must be positive and ordered")
    if expected_role not in {AssetRole.PRIMARY_PDF, AssetRole.SUPPLEMENTARY_PDF}:
        raise ValueError("PDF validation requires a PDF asset role")
    if content.role is not expected_role:
        raise ValidationError("PDF content role does not match the target")
    if content.format != "pdf":
        raise ValidationError("P4 requires pdf format content")
    data = content.data
    if not min_bytes <= len(data) <= max_bytes:
        raise ValidationError("PDF byte size is outside configured bounds")
    media_type = content.media_type.lower().split(";", 1)[0].strip()
    if media_type in {"text/html", "application/xhtml+xml"}:
        raise ValidationError("HTML content cannot be accepted as PDF")
    if not data.startswith(b"%PDF-"):
        raise ValidationError("PDF header is missing")
    if b"%%EOF" not in data[-1024:]:
        raise ValidationError("PDF EOF trailer is missing")
    try:
        reader = import_module("PyPDF2").PdfReader(BytesIO(data), strict=True)
        page_count = len(reader.pages)
        if page_count < 1:
            raise ValidationError("PDF must contain at least one page")
        if expected_role is AssetRole.PRIMARY_PDF and page_count == 1 and len(data) <= SINGLE_PAGE_PREVIEW_MAX_BYTES:
            raise ValidationError("suspicious single-page preview PDF")
    except ValidationError:
        raise
    except Exception as error:
        raise ValidationError(f"PDF is not parseable: {error}") from error


class _HTMLEvidenceParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tags = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.tags += 1


def validate_xml(content: ProviderContent, *, min_bytes: int = 32, max_bytes: int = 100 * 1024 * 1024) -> None:
    if content.role is not AssetRole.XML or content.format != "xml":
        raise ValidationError("XML content role and format must match the target")
    if not min_bytes <= len(content.data) <= max_bytes:
        raise ValidationError("XML byte size is outside configured bounds")
    media_type = content.media_type.lower().split(";", 1)[0].strip()
    if media_type not in {"application/xml", "text/xml", "application/jats+xml"}:
        raise ValidationError("XML content type is not accepted")
    try:
        root = ET.fromstring(content.data)
    except ET.ParseError as error:
        raise ValidationError(f"XML is not parseable: {error}") from error
    if root.tag.rsplit("}", 1)[-1].lower() == "html":
        raise ValidationError("HTML cannot satisfy an XML target")


def validate_html(content: ProviderContent, *, min_bytes: int = 64, max_bytes: int = 25 * 1024 * 1024) -> None:
    if content.role is not AssetRole.HTML or content.format != "html":
        raise ValidationError("HTML content role and format must match the target")
    if not min_bytes <= len(content.data) <= max_bytes:
        raise ValidationError("HTML byte size is outside configured bounds")
    media_type = content.media_type.lower().split(";", 1)[0].strip()
    if media_type not in {"text/html", "application/xhtml+xml"}:
        raise ValidationError("HTML content type is not accepted")
    try:
        text = content.data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValidationError("HTML must be UTF-8 parseable") from error
    parser = _HTMLEvidenceParser()
    try:
        parser.feed(text)
        parser.close()
    except Exception as error:
        raise ValidationError(f"HTML is not parseable: {error}") from error
    if parser.tags == 0:
        raise ValidationError("HTML must contain markup")


def validate_content(content: ProviderContent, expected_role: AssetRole) -> None:
    if content.role is not expected_role:
        raise ValidationError("provider content role does not match acquisition target")
    if expected_role in {AssetRole.PRIMARY_PDF, AssetRole.SUPPLEMENTARY_PDF}:
        validate_primary_pdf(content, expected_role=expected_role)
    elif expected_role is AssetRole.XML:
        validate_xml(content)
    elif expected_role is AssetRole.HTML:
        validate_html(content)
    else:
        raise ValidationError(f"unsupported acquisition role: {expected_role.value}")


__all__ = (
    "MIN_PDF_BYTES",
    "SINGLE_PAGE_PREVIEW_MAX_BYTES",
    "validate_content",
    "validate_html",
    "validate_primary_pdf",
    "validate_xml",
)
