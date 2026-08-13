"""RIS codec for neutral bibliographic records."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import BinaryIO

from sciretriever.entry.codecs._common import (
    CodecDocumentError,
    author_display,
    author_omissions,
    clean_text,
    display_author,
    document_failure,
    empty_document,
    has_export_identity,
    identifier_groups,
    identifier_omissions,
    malformed_record,
    metadata_record,
    omission,
    parse_year,
    publication_date,
    read_text,
    unencodable_record,
    validate_record_unicode,
    write_all,
)
from sciretriever.entry.ports import (
    BibliographyDecodeResult,
    BibliographyEncodeResult,
    BibliographyFieldOmission,
    DecodedBibliographyItem,
)
from sciretriever.model.literature import AuthorKind
from sciretriever.model.record import BibliographicRecord

_TAGGED_LINE = re.compile(r"^(?P<tag>[A-Za-z0-9]{2})  - ?(?P<value>.*)$")
_ISBN = re.compile(r"^(?:\d{9}[\dXx]|\d{13})$")
_ISSN = re.compile(r"^\d{7}[\dXx]$")
_SUPPORTED_IDENTIFIERS = frozenset({"doi", "isbn", "issn"})
_RIS_TO_TYPE = {
    "JOUR": "journal-article",
    "EJOUR": "journal-article",
    "BOOK": "book",
    "CHAP": "book-chapter",
    "CONF": "proceedings-article",
    "THES": "thesis",
    "RPRT": "report",
    "GEN": "other",
}
_TYPE_TO_RIS = {
    "journal-article": "JOUR",
    "article-journal": "JOUR",
    "article": "JOUR",
    "book": "BOOK",
    "book-chapter": "CHAP",
    "chapter": "CHAP",
    "proceedings-article": "CONF",
    "paper-conference": "CONF",
    "conference": "CONF",
    "thesis": "THES",
    "report": "RPRT",
    "other": "GEN",
}


@dataclass(frozen=True, slots=True)
class _RisGroup:
    pairs: tuple[tuple[str, str], ...]
    complete: bool


def decode_ris(source: BinaryIO, *, max_input_bytes: int) -> BibliographyDecodeResult:
    try:
        text = read_text(source, max_input_bytes=max_input_bytes)
    except CodecDocumentError as error:
        return BibliographyDecodeResult(items=(document_failure(error),))
    groups = _groups(text)
    if not groups:
        return BibliographyDecodeResult(items=(empty_document(format_name="RIS"),))
    items: list[DecodedBibliographyItem] = []
    for record_index, group in enumerate(groups):
        if not group.complete:
            items.append(malformed_record(record_index, format_name="RIS"))
            continue
        try:
            items.append(_parse_group(record_index, group.pairs))
        except (IndexError, KeyError, TypeError, ValueError):
            items.append(malformed_record(record_index, format_name="RIS"))
    return BibliographyDecodeResult(items=tuple(items))


def encode_ris(
    records: tuple[BibliographicRecord, ...],
    destination: BinaryIO,
) -> BibliographyEncodeResult:
    encoded_indexes: list[int] = []
    failures = []
    omissions: list[BibliographyFieldOmission] = []
    payloads: list[str] = []
    for record in records:
        if not has_export_identity(record):
            failures.append(unencodable_record(record.record_index))
            continue
        try:
            validate_record_unicode(record)
            ris_type, type_omission = _encoded_type(record)
            payloads.append("\n".join(_encoded_lines(record, ris_type)))
        except (KeyError, TypeError, ValueError):
            failures.append(unencodable_record(record.record_index))
            continue
        encoded_indexes.append(record.record_index)
        if type_omission is not None:
            omissions.append(type_omission)
        omissions.extend(
            author_omissions(record, supports_orcid=False, supports_affiliations=False)
        )
        kind_omission = _author_kind_omission(record)
        if kind_omission is not None:
            omissions.append(kind_omission)
        omissions.extend(identifier_omissions(record, supported=_SUPPORTED_IDENTIFIERS))
    payload = ("\n\n".join(payloads) + ("\n" if payloads else "")).encode("utf-8")
    write_all(destination, payload)
    return BibliographyEncodeResult(
        encoded_record_indexes=tuple(encoded_indexes),
        failures=tuple(failures),
        omissions=tuple(omissions),
    )


def _groups(text: str) -> tuple[_RisGroup, ...]:
    groups: list[_RisGroup] = []
    current: list[tuple[str, str]] | None = None
    malformed_prefix = False
    for line in text.splitlines():
        if not line.strip():
            continue
        match = _TAGGED_LINE.fullmatch(line)
        if match is None:
            current, malformed_prefix = _append_continuation(
                current,
                line,
                malformed_prefix,
            )
            continue
        tag = match.group("tag").upper()
        value = match.group("value").strip()
        if tag == "TY":
            if current is not None:
                groups.append(_RisGroup(pairs=tuple(current), complete=False))
            current = [(tag, value)]
            malformed_prefix = False
            continue
        if current is None:
            current = []
            malformed_prefix = True
        current.append((tag, value))
        if tag == "ER":
            groups.append(
                _RisGroup(
                    pairs=tuple(current),
                    complete=not malformed_prefix and bool(current) and current[0][0] == "TY",
                )
            )
            current = None
            malformed_prefix = False
    if current is not None:
        groups.append(_RisGroup(pairs=tuple(current), complete=False))
    return tuple(groups)


def _append_continuation(
    current: list[tuple[str, str]] | None,
    line: str,
    malformed_prefix: bool,
) -> tuple[list[tuple[str, str]], bool]:
    if current is None:
        return [], True
    if not current:
        return current, True
    tag, value = current[-1]
    current[-1] = (tag, f"{value} {line.strip()}".strip())
    return current, malformed_prefix


def _parse_group(record_index: int, pairs: tuple[tuple[str, str], ...]) -> BibliographicRecord:
    if not pairs or pairs[0][0] != "TY" or pairs[-1][0] != "ER":
        raise ValueError("invalid RIS delimiters")
    fields: dict[str, list[str]] = {}
    for tag, value in pairs:
        fields.setdefault(tag, []).append(value)
    ris_type = _first(fields, "TY")
    if ris_type is None:
        raise ValueError("missing RIS type")
    date = _first(fields, "DA", "Y1")
    normalized_date, date_year = publication_date(date)
    year = parse_year(_first(fields, "PY")) or date_year
    start = _first(fields, "SP")
    end = _first(fields, "EP")
    pages = f"{start}-{end}" if start is not None and end is not None else start or end
    if pages is None:
        pages = _first(fields, "PP")

    return metadata_record(
        record_index,
        title=_first(fields, "TI", "T1"),
        authors=tuple(
            display_author(value)
            for value in (*fields.get("AU", ()), *fields.get("A1", ()))
            if clean_text(value) is not None
        ),
        abstract=_first(fields, "AB", "N2"),
        date=normalized_date,
        year=year,
        document_type=_RIS_TO_TYPE.get(ris_type.upper(), ris_type.upper()),
        language=_first(fields, "LA"),
        venue=_first(fields, "JO", "JF", "T2"),
        publisher=_first(fields, "PB"),
        volume=_first(fields, "VL"),
        issue=_first(fields, "IS"),
        pages=pages,
        identifier_values=_identifier_values(fields),
        keywords=fields.get("KW", ()),
    )


def _identifier_values(fields: dict[str, list[str]]) -> tuple[tuple[str, str], ...]:
    result = [("doi", value) for value in fields.get("DO", ())]
    for serial in fields.get("SN", ()):
        compact = re.sub(r"[-\s]", "", serial)
        if _ISBN.fullmatch(compact) is not None:
            result.append(("isbn", serial))
        elif _ISSN.fullmatch(compact) is not None:
            result.append(("issn", serial))
    for accession in fields.get("AN", ()):
        match = re.fullmatch(r"PMID:\s*(\d+)", accession, re.IGNORECASE)
        if match is not None:
            result.append(("pmid", match.group(1)))
    for note in fields.get("N1", ()):
        match = re.fullmatch(r"(PMID|PMCID|arXiv):\s*(\S+)", note, re.IGNORECASE)
        if match is not None:
            result.append((match.group(1).casefold(), match.group(2)))
    return tuple(result)


def _first(fields: dict[str, list[str]], *names: str) -> str | None:
    for name in names:
        for value in fields.get(name, ()):
            normalized = clean_text(value)
            if normalized is not None:
                return normalized
    return None


def _encoded_type(
    record: BibliographicRecord,
) -> tuple[str, BibliographyFieldOmission | None]:
    document_type = record.metadata.document_type
    if document_type is None:
        return "GEN", None
    candidate = _TYPE_TO_RIS.get(document_type.casefold())
    if candidate is not None:
        return candidate, None
    if re.fullmatch(r"[A-Za-z0-9]{2,6}", document_type) is not None:
        return document_type.upper(), None
    return (
        "GEN",
        omission(
            record.record_index,
            "document_type",
            "The document type is not a supported RIS type and was exported as GEN.",
        ),
    )


def _author_kind_omission(
    record: BibliographicRecord,
) -> BibliographyFieldOmission | None:
    if all(author.kind is AuthorKind.UNKNOWN for author in record.metadata.authors):
        return None
    return omission(
        record.record_index,
        "authors.kind",
        "The RIS format cannot preserve explicit author kinds reliably.",
    )


def _encoded_lines(record: BibliographicRecord, ris_type: str) -> tuple[str, ...]:
    metadata = record.metadata
    lines = [f"TY  - {ris_type}"]
    _add(lines, "TI", metadata.title)
    for author in metadata.authors:
        value = author_display(author)
        if value.startswith("{") and value.endswith("}"):
            value = value[1:-1]
        _add(lines, "AU", value)
    _add(lines, "AB", metadata.abstract)
    _add(lines, "DA", metadata.publication_date)
    if metadata.publication_year is not None:
        _add(lines, "PY", str(metadata.publication_year))
    _add(lines, "LA", metadata.language)
    _add(lines, "JO", metadata.venue)
    _add(lines, "PB", metadata.publisher)
    _add(lines, "VL", metadata.volume)
    _add(lines, "IS", metadata.issue)
    if metadata.pages is not None:
        start, separator, end = metadata.pages.partition("-")
        _add(lines, "SP", start)
        if separator and end:
            _add(lines, "EP", end)
    groups = identifier_groups(metadata)
    if groups.get("doi"):
        _add(lines, "DO", groups["doi"][0].value)
    for namespace in ("isbn", "issn"):
        if groups.get(namespace):
            _add(lines, "SN", groups[namespace][0].value)
    for keyword in metadata.keywords:
        _add(lines, "KW", keyword)
    lines.append("ER  - ")
    return tuple(lines)


def _add(lines: list[str], tag: str, value: str | None) -> None:
    normalized = clean_text(value)
    if normalized is not None:
        lines.append(f"{tag}  - {normalized}")


__all__ = ("decode_ris", "encode_ris")
