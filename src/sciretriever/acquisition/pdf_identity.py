"""Acquisition-owned association checks for generic Browser PDF candidates."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from urllib.parse import unquote, urlsplit

from PyPDF2 import PdfReader

from sciretriever.acquisition.ports import (
    AcquisitionRequest,
    BrowserPdfAssociationEvidence,
    CancellationEvent,
)
from sciretriever.acquisition.rules import PdfValidationCancelled, ValidatedPdf
from sciretriever.model.literature import Identifier

_MAX_IDENTITY_PAGES = 3
_MAX_IDENTITY_TEXT = 65_536
_DOI = re.compile(r"10\.\d{4,9}/[^\s<>\"']+", re.IGNORECASE)
_WORD = re.compile(r"\w+", re.UNICODE)
_SUPPLEMENT = re.compile(
    r"(?:\bsupplement(?:al|ary)?\b|\bsupporting[\s_-]+(?:information|material|data)\b)",
    re.IGNORECASE,
)
_SUPPLEMENT_PATH = re.compile(
    r"(?:^|[/_.-])(?:supp(?:lement(?:al|ary)?)?|supporting[-_](?:info|material))(?:[/_.-]|$)",
    re.IGNORECASE,
)


def _cancel_if_requested(cancel_event: CancellationEvent | None) -> None:
    if cancel_event is None:
        return
    try:
        cancelled = cancel_event.is_set()
    except Exception:
        raise PdfValidationCancelled() from None
    if cancelled:
        raise PdfValidationCancelled()


def _canonical_dois(values: Iterable[str]) -> frozenset[str]:
    result: set[str] = set()
    for value in values:
        for match in _DOI.findall(unquote(value)):
            candidate = match.rstrip(".,;:)]}")
            try:
                result.add(Identifier(namespace="doi", value=candidate).value)
            except (TypeError, ValueError):
                continue
    return frozenset(result)


def _normalized_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return " ".join(_WORD.findall(normalized))


def _title_matches(title: str, document: str) -> bool:
    expected = _normalized_text(title)
    observed = _normalized_text(document)
    if not expected or not observed:
        return False
    if len(expected) >= 12 and expected in observed:
        return True
    expected_tokens = tuple(token for token in expected.split() if len(token) >= 3)
    if not expected_tokens:
        return False
    observed_tokens = frozenset(observed.split())
    matched = sum(token in observed_tokens for token in expected_tokens)
    required = max(3, (len(expected_tokens) * 4 + 4) // 5)
    return len(expected_tokens) >= 3 and matched >= required


def _author_matches(authors: tuple[str, ...], document: str) -> bool:
    observed = _normalized_text(document)
    if not observed:
        return False
    for author in authors:
        normalized = _normalized_text(author)
        if not normalized:
            continue
        if normalized in observed:
            return True
        parts = normalized.split()
        if parts and len(parts[-1]) >= 4 and parts[-1] in observed.split():
            return True
    return False


def _pdf_identity_text(
    validated_pdf: ValidatedPdf,
    *,
    cancel_event: CancellationEvent | None,
) -> tuple[str, str]:
    metadata_parts: list[str] = []
    page_parts: list[str] = []
    _cancel_if_requested(cancel_event)
    with validated_pdf.open() as stream:
        reader = PdfReader(stream, strict=False)
        _cancel_if_requested(cancel_event)
        try:
            metadata = reader.metadata
        except Exception:
            metadata = None
        if metadata is not None:
            for key in ("/Title", "/Author", "/Subject", "/Keywords"):
                _cancel_if_requested(cancel_event)
                try:
                    value = metadata.get(key)
                except Exception:
                    continue
                if isinstance(value, str):
                    metadata_parts.append(value[:4096])
        remaining = _MAX_IDENTITY_TEXT
        for page in reader.pages[:_MAX_IDENTITY_PAGES]:
            _cancel_if_requested(cancel_event)
            if remaining <= 0:
                break
            try:
                text = page.extract_text() or ""
            except Exception:
                continue
            selected = text[:remaining]
            page_parts.append(selected)
            remaining -= len(selected)
        _cancel_if_requested(cancel_event)
    return "\n".join(metadata_parts), "\n".join(page_parts)


def _looks_supplementary(evidence: BrowserPdfAssociationEvidence, document: str) -> bool:
    path = urlsplit(evidence.capture_locator).path
    return _SUPPLEMENT_PATH.search(path) is not None or _SUPPLEMENT.search(document) is not None


def browser_pdf_belongs_to_literature(
    request: AcquisitionRequest,
    evidence: BrowserPdfAssociationEvidence,
    validated_pdf: ValidatedPdf,
    *,
    cancel_event: CancellationEvent | None = None,
) -> bool:
    """Establish target-article identity without trusting the Agent or filename.

    A direct-file capture of the exact start URL is strong lineage. Otherwise
    the capture URL or validated PDF must carry the target DOI, or the PDF must
    match both the target title and at least one author. Explicitly conflicting
    DOI or supplementary-material evidence always rejects the candidate.
    """

    if not isinstance(request, AcquisitionRequest):
        raise TypeError("request must be an AcquisitionRequest")
    if not isinstance(evidence, BrowserPdfAssociationEvidence):
        raise TypeError("evidence must be BrowserPdfAssociationEvidence")
    if not isinstance(validated_pdf, ValidatedPdf):
        raise TypeError("validated_pdf must be ValidatedPdf")
    _cancel_if_requested(cancel_event)

    metadata_text, page_text = _pdf_identity_text(
        validated_pdf,
        cancel_event=cancel_event,
    )
    document = "\n".join((metadata_text, page_text))
    if _looks_supplementary(evidence, document):
        return False

    target_dois = frozenset(
        identifier.value
        for identifier in request.literature.metadata.identifiers
        if identifier.namespace == "doi"
    )
    document_dois = _canonical_dois((document,))
    if document_dois and target_dois and document_dois.isdisjoint(target_dois):
        return False
    capture_dois = _canonical_dois((evidence.capture_locator,))
    if target_dois & (document_dois | capture_dois):
        return True

    if (
        evidence.start_kind == "direct-file"
        and evidence.from_exact_start
        and evidence.request_navigation
    ):
        return True

    metadata = request.literature.metadata
    title = metadata.title
    authors = tuple(author.display_name for author in metadata.authors)
    return bool(
        title is not None
        and authors
        and _title_matches(title, document)
        and _author_matches(authors, document)
    )


__all__ = ("browser_pdf_belongs_to_literature",)
