"""Shared, format-neutral mechanics for bibliography codecs.

This module deliberately contains no Literature admission or export-selection
rules.  It only bounds short-lived input, constructs the existing neutral
metadata model, and produces stable per-record codec diagnostics.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from typing import BinaryIO, Final

from sciretriever.entry.ports import BibliographyFieldOmission, BibliographyRecordFailure
from sciretriever.model.literature import Affiliation, Author, AuthorKind, Identifier
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.record import BibliographicRecord
from sciretriever.model.report import StableFailure

DEFAULT_MAX_INPUT_BYTES: Final[int] = 8 * 1024 * 1024
_READ_SIZE: Final[int] = 64 * 1024
_SPACE = re.compile(r"\s+")
_YEAR = re.compile(r"(?<!\d)(\d{4})(?!\d)")
_DATE = re.compile(r"^(?P<year>\d{4})(?:[-/](?P<month>\d{1,2})(?:[-/](?P<day>\d{1,2}))?)?$")


class CodecDocumentError(ValueError):
    """A stable whole-document failure that cannot reveal source bytes."""

    __slots__ = ("code", "reason", "action")

    def __init__(self, code: str, reason: str, action: str) -> None:
        self.code = code
        self.reason = reason
        self.action = action
        super().__init__(reason)


def clean_text(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = _SPACE.sub(
        " ", unicodedata.normalize("NFC", normalize_unicode_scalars(value))
    ).strip()
    return normalized or None


def normalize_unicode_scalars(value: str) -> str:
    """Combine valid UTF-16 pairs and reject every unpaired surrogate."""

    result: list[str] = []
    index = 0
    while index < len(value):
        codepoint = ord(value[index])
        if 0xD800 <= codepoint <= 0xDBFF:
            if index + 1 >= len(value):
                raise ValueError("text contains an unpaired Unicode surrogate")
            trailing = ord(value[index + 1])
            if not 0xDC00 <= trailing <= 0xDFFF:
                raise ValueError("text contains an unpaired Unicode surrogate")
            scalar = 0x10000 + ((codepoint - 0xD800) << 10) + trailing - 0xDC00
            result.append(chr(scalar))
            index += 2
            continue
        if 0xDC00 <= codepoint <= 0xDFFF:
            raise ValueError("text contains an unpaired Unicode surrogate")
        result.append(value[index])
        index += 1
    return "".join(result)


def ordered_text(values: Iterable[str]) -> tuple[str, ...]:
    result: list[str] = []
    for value in values:
        normalized = clean_text(value)
        if normalized is not None and normalized not in result:
            result.append(normalized)
    return tuple(result)


def split_keywords(value: str | None) -> tuple[str, ...]:
    if value is None:
        return ()
    return ordered_text(re.split(r"[;,]", value))


def publication_date(value: str | None) -> tuple[str | None, int | None]:
    """Preserve a source date while normalizing an unambiguous numeric date."""

    normalized = clean_text(value)
    if normalized is None:
        return None, None
    match = _DATE.fullmatch(normalized)
    if match is not None:
        year = int(match.group("year"))
        month_text = match.group("month")
        day_text = match.group("day")
        if not 1 <= year <= 9999:
            return normalized, None
        if month_text is None:
            return normalized, year
        month = int(month_text)
        if not 1 <= month <= 12:
            return normalized, year
        if day_text is None:
            return f"{year:04d}-{month:02d}", year
        day = int(day_text)
        if not 1 <= day <= 31:
            return normalized, year
        return f"{year:04d}-{month:02d}-{day:02d}", year
    year_match = _YEAR.search(normalized)
    return normalized, int(year_match.group(1)) if year_match is not None else None


def parse_year(value: str | None) -> int | None:
    normalized = clean_text(value)
    if normalized is None:
        return None
    match = _YEAR.search(normalized)
    if match is None:
        return None
    year = int(match.group(1))
    return year if 1 <= year <= 9999 else None


def display_author(value: str, *, organization: bool = False) -> Author:
    """Keep the source display value; split only an explicit comma form."""

    normalized = clean_text(value)
    if normalized is None:
        raise ValueError("author display name is empty")
    if organization:
        return Author(kind=AuthorKind.ORGANIZATION, display_name=normalized)
    family, separator, given = normalized.partition(",")
    if separator and clean_text(family) is not None and clean_text(given) is not None:
        return Author(
            kind=AuthorKind.PERSON,
            display_name=normalized,
            given_name=clean_text(given),
            family_name=clean_text(family),
        )
    return Author(kind=AuthorKind.UNKNOWN, display_name=normalized)


def identifiers(values: Iterable[tuple[str, str]]) -> tuple[Identifier, ...]:
    result: list[Identifier] = []
    for namespace, value in values:
        normalized_namespace = clean_text(namespace)
        normalized_value = clean_text(value)
        if normalized_namespace is None or normalized_value is None:
            continue
        identifier = Identifier(namespace=normalized_namespace, value=normalized_value)
        if identifier not in result:
            result.append(identifier)
    return tuple(result)


def metadata_record(
    record_index: int,
    *,
    title: str | None = None,
    authors: Iterable[Author] = (),
    abstract: str | None = None,
    date: str | None = None,
    year: int | None = None,
    document_type: str | None = None,
    language: str | None = None,
    venue: str | None = None,
    publisher: str | None = None,
    volume: str | None = None,
    issue: str | None = None,
    pages: str | None = None,
    identifier_values: Iterable[tuple[str, str]] = (),
    keywords: Iterable[str] = (),
) -> BibliographicRecord:
    normalized_date, date_year = publication_date(date)
    normalized_year = year if year is not None else date_year
    record = BibliographicRecord(
        record_index=record_index,
        metadata=LiteratureMetadata(
            title=clean_text(title),
            authors=tuple(authors),
            abstract=clean_text(abstract),
            publication_date=normalized_date,
            publication_year=normalized_year,
            document_type=clean_text(document_type),
            language=clean_text(language),
            venue=clean_text(venue),
            publisher=clean_text(publisher),
            volume=clean_text(volume),
            issue=clean_text(issue),
            pages=clean_text(pages),
            identifiers=identifiers(identifier_values),
            keywords=ordered_text(keywords),
        ),
    )
    validate_record_unicode(record)
    return record


def read_text(source: BinaryIO, *, max_input_bytes: int) -> str:
    if type(max_input_bytes) is not int or max_input_bytes <= 0:
        raise ValueError("max_input_bytes must be a positive integer")
    chunks: list[bytes] = []
    total = 0
    try:
        while True:
            chunk = source.read(_READ_SIZE)
            if not isinstance(chunk, bytes):
                raise CodecDocumentError(
                    "bibliography-invalid-stream",
                    "The bibliography input did not provide binary data.",
                    "Provide a readable binary bibliography input and retry.",
                )
            if not chunk:
                break
            total += len(chunk)
            if total > max_input_bytes:
                raise CodecDocumentError(
                    "bibliography-input-too-large",
                    "The bibliography input exceeds the configured byte limit.",
                    "Split the bibliography into smaller inputs and retry.",
                )
            chunks.append(chunk)
    except CodecDocumentError:
        raise
    except Exception:
        raise CodecDocumentError(
            "bibliography-input-read-failed",
            "The bibliography input could not be read safely.",
            "Check the input stream and retry the operation.",
        ) from None

    payload = b"".join(chunks)
    encoding = "utf-16" if payload.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
    try:
        return payload.decode(encoding, errors="strict")
    except UnicodeDecodeError:
        raise CodecDocumentError(
            "bibliography-invalid-encoding",
            "The bibliography input is not valid UTF-8 or BOM-marked UTF-16.",
            "Convert the input to UTF-8 and retry the operation.",
        ) from None


def document_failure(error: CodecDocumentError) -> BibliographyRecordFailure:
    return BibliographyRecordFailure(
        record_index=0,
        failure=StableFailure(
            code=error.code,
            reason=error.reason,
            action=error.action,
            retryable=False,
        ),
    )


def malformed_record(record_index: int, *, format_name: str) -> BibliographyRecordFailure:
    return BibliographyRecordFailure(
        record_index=record_index,
        failure=StableFailure(
            code="bibliography-malformed-record",
            reason=f"The {format_name} record is malformed or contains unsupported value types.",
            action="Correct or remove this record and retry the operation.",
            retryable=False,
        ),
    )


def empty_document(*, format_name: str) -> BibliographyRecordFailure:
    return BibliographyRecordFailure(
        record_index=0,
        failure=StableFailure(
            code="bibliography-empty-input",
            reason=f"The input contains no {format_name} bibliography records.",
            action="Provide at least one bibliography record and retry the operation.",
            retryable=False,
        ),
    )


def unencodable_record(record_index: int) -> BibliographyRecordFailure:
    return BibliographyRecordFailure(
        record_index=record_index,
        failure=StableFailure(
            code="bibliography-record-unencodable",
            reason="The selected Literature does not contain convertible bibliography metadata.",
            action="Add a title or DOI, then retry the export.",
            retryable=False,
        ),
    )


def omission(record_index: int, field: str, reason: str) -> BibliographyFieldOmission:
    return BibliographyFieldOmission(record_index=record_index, field=field, reason=reason)


def author_omissions(
    record: BibliographicRecord,
    *,
    supports_orcid: bool,
    supports_affiliations: bool,
) -> tuple[BibliographyFieldOmission, ...]:
    result: list[BibliographyFieldOmission] = []
    if not supports_orcid and any(author.orcid is not None for author in record.metadata.authors):
        result.append(
            omission(
                record.record_index,
                "authors.orcid",
                "The selected format cannot express author ORCID values reliably.",
            )
        )
    if not supports_affiliations and any(author.affiliations for author in record.metadata.authors):
        result.append(
            omission(
                record.record_index,
                "authors.affiliations",
                "The selected format cannot express author affiliations reliably.",
            )
        )
    return tuple(result)


def identifier_groups(metadata: LiteratureMetadata) -> dict[str, tuple[Identifier, ...]]:
    groups: dict[str, list[Identifier]] = {}
    for identifier in metadata.identifiers:
        groups.setdefault(identifier.namespace, []).append(identifier)
    return {namespace: tuple(values) for namespace, values in groups.items()}


def identifier_omissions(
    record: BibliographicRecord,
    *,
    supported: frozenset[str],
) -> tuple[BibliographyFieldOmission, ...]:
    result: list[BibliographyFieldOmission] = []
    for namespace, values in identifier_groups(record.metadata).items():
        if namespace not in supported:
            result.append(
                omission(
                    record.record_index,
                    f"identifiers.{namespace}",
                    "The selected format has no reliable field for this identifier namespace.",
                )
            )
        elif len(values) > 1:
            result.append(
                omission(
                    record.record_index,
                    f"identifiers.{namespace}.additional",
                    "The selected format can express only one value for this identifier namespace.",
                )
            )
    return tuple(result)


def has_export_identity(record: BibliographicRecord) -> bool:
    return record.metadata.title is not None or any(
        item.namespace == "doi" for item in record.metadata.identifiers
    )


def validate_record_unicode(record: BibliographicRecord) -> None:
    """Require normalized Unicode scalar text throughout one neutral record."""

    for value in _record_text_values(record):
        if normalize_unicode_scalars(value) != value:
            raise ValueError("record text must contain normalized Unicode scalars")


def _record_text_values(record: BibliographicRecord) -> Iterable[str]:
    metadata = record.metadata
    for value in (
        metadata.title,
        metadata.abstract,
        metadata.publication_date,
        metadata.document_type,
        metadata.language,
        metadata.venue,
        metadata.publisher,
        metadata.volume,
        metadata.issue,
        metadata.pages,
    ):
        if value is not None:
            yield value
    yield from metadata.keywords
    for author in metadata.authors:
        yield author.display_name
        for value in (author.given_name, author.family_name, author.orcid):
            if value is not None:
                yield value
        for affiliation in author.affiliations:
            yield affiliation.name
            if affiliation.ror is not None:
                yield affiliation.ror
    for identifier in metadata.identifiers:
        yield identifier.namespace
        yield identifier.value


def author_display(author: Author) -> str:
    if author.kind is AuthorKind.ORGANIZATION:
        return "{" + author.display_name + "}"
    if author.family_name is not None:
        return (
            f"{author.family_name}, {author.given_name}"
            if author.given_name is not None
            else author.family_name
        )
    return author.display_name


def affiliations(value: object) -> tuple[Affiliation, ...]:
    if not isinstance(value, list):
        return ()
    result: list[Affiliation] = []
    for item in value:
        if isinstance(item, str):
            name = clean_text(item)
            if name is not None:
                result.append(Affiliation(name=name))
            continue
        if not isinstance(item, dict):
            raise ValueError("affiliation must be text or an object")
        name_value = item.get("name")
        if not isinstance(name_value, str):
            raise ValueError("affiliation object requires a name")
        ror_value = item.get("ROR", item.get("ror"))
        if ror_value is not None and not isinstance(ror_value, str):
            raise ValueError("affiliation ROR must be text")
        result.append(Affiliation(name=name_value, ror=ror_value))
    return tuple(result)


def write_all(destination: BinaryIO, payload: bytes) -> None:
    remaining = memoryview(payload)
    while remaining:
        try:
            written = destination.write(remaining)
        except Exception:
            raise RuntimeError("bibliography output stream failed") from None
        if type(written) is not int or written <= 0 or written > len(remaining):
            raise RuntimeError("bibliography output stream rejected bytes")
        remaining = remaining[written:]


__all__ = (
    "CodecDocumentError",
    "DEFAULT_MAX_INPUT_BYTES",
    "affiliations",
    "author_display",
    "author_omissions",
    "clean_text",
    "display_author",
    "document_failure",
    "empty_document",
    "has_export_identity",
    "identifier_groups",
    "identifier_omissions",
    "identifiers",
    "malformed_record",
    "metadata_record",
    "normalize_unicode_scalars",
    "omission",
    "ordered_text",
    "parse_year",
    "publication_date",
    "read_text",
    "split_keywords",
    "unencodable_record",
    "validate_record_unicode",
    "write_all",
)
