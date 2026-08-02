from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from io import BytesIO
from typing import assert_never

from PyPDF2 import PdfReader

from sciretriever.content.model import BoundedByteStream, ContentTarget
from sciretriever.model.primitives import AssetRole


@dataclass(frozen=True, slots=True)
class AssetValidationFailure:
    code: str


def _normalized(value: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", unicodedata.normalize("NFKC", value).casefold()))


def _doi(target: ContentTarget) -> str | None:
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
    target: ContentTarget,
    role: AssetRole,
    *,
    min_pdf_bytes: int,
    max_asset_bytes: int,
) -> AssetValidationFailure | None:
    data = content.content
    if not data or len(data) > max_asset_bytes or content.size != len(data):
        return AssetValidationFailure("size-invalid")
    match role:
        case AssetRole.PRIMARY_PDF | AssetRole.SUPPLEMENTARY_PDF:
            return _validate_pdf(content, target, role, min_pdf_bytes)
        case AssetRole.XML:
            if content.media_type.split(";", 1)[0].strip().lower() not in {
                "application/xml",
                "text/xml",
                "application/jats+xml",
            }:
                return AssetValidationFailure("media-type-invalid")
            if not data.lstrip().startswith(b"<"):
                return AssetValidationFailure("format-invalid")
            return None
        case AssetRole.HTML:
            if content.media_type.split(";", 1)[0].strip().lower() not in {
                "text/html",
                "application/xhtml+xml",
            }:
                return AssetValidationFailure("media-type-invalid")
            if b"<html" not in data[:2048].lower():
                return AssetValidationFailure("format-invalid")
            return None
        case AssetRole.SUPPLEMENTARY:
            return None
        case unreachable:
            assert_never(unreachable)


def _validate_pdf(  # noqa: C901
    content: BoundedByteStream,
    target: ContentTarget,
    role: AssetRole,
    min_pdf_bytes: int,
) -> AssetValidationFailure | None:
    data = content.content
    if len(data) < min_pdf_bytes:
        return AssetValidationFailure("size-invalid")
    if content.media_type.split(";", 1)[0].strip().lower() != "application/pdf":
        return AssetValidationFailure("media-type-invalid")
    if not data.startswith(b"%PDF-") or b"%%EOF" not in data[-1024:]:
        return AssetValidationFailure("format-invalid")
    try:
        reader = PdfReader(BytesIO(data), strict=True)
        if len(reader.pages) < 1:
            return AssetValidationFailure("format-invalid")
        metadata = reader.metadata
    except (OSError, ValueError, TypeError, KeyError) as error:
        del error
        return AssetValidationFailure("parse-invalid")
    if role is AssetRole.SUPPLEMENTARY_PDF:
        return None
    title = "" if metadata is None else str(metadata.title or "")
    author = "" if metadata is None else str(metadata.author or "")
    evidence = "" if metadata is None else " ".join(str(value) for value in metadata.values())
    if "supplement" in _normalized(title):
        return AssetValidationFailure("not-primary")
    expected_doi = _doi(target)
    if expected_doi is not None:
        found = {
            match.casefold().rstrip(".,;)")
            for match in re.findall(r"10\.\d{4,9}/[^\s<>\]]+", evidence, re.IGNORECASE)
        }
        if expected_doi in found:
            return None
        if found:
            return AssetValidationFailure("identity-mismatch")
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
    return AssetValidationFailure("identity-unconfirmed")


__all__ = ("AssetValidationFailure", "validate_asset")
