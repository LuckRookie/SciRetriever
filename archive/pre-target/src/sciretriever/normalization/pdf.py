"""Bounded PDF text-unit extraction."""

from __future__ import annotations

from io import BytesIO

from PyPDF2 import PdfReader

from sciretriever.errors import NormalizationError


def extract_pdf_units(payload: bytes, max_pages: int) -> tuple[tuple[str, str], ...]:
    try:
        reader = PdfReader(BytesIO(payload), strict=True)
        if reader.is_encrypted:
            raise NormalizationError("encrypted PDF input is unsupported")
        if len(reader.pages) > max_pages:
            raise NormalizationError("PDF exceeds the configured page bound")
        return tuple((f"page/{index + 1}", page.extract_text() or "") for index, page in enumerate(reader.pages))
    except NormalizationError:
        raise
    except Exception as error:
        raise NormalizationError(f"PDF parsing failed: {error}") from error


__all__ = ("extract_pdf_units",)
