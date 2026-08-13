"""BibTeX/BibLaTeX codec for neutral bibliographic records."""

from __future__ import annotations

import re
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
    read_text,
    split_keywords,
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
from sciretriever.model.literature import Author
from sciretriever.model.record import BibliographicRecord

_ENTRY_START = re.compile(r"(?m)^\s*@(?P<type>[A-Za-z][A-Za-z0-9_-]*)\s*[{(]")
_FIELD = re.compile(r"(?P<name>[A-Za-z][A-Za-z0-9_-]*)\s*=")
_ENTRY_TYPE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")
_SKIPPED_TYPES = frozenset({"comment", "preamble", "string"})
_SUPPORTED_IDENTIFIERS = frozenset({"doi", "arxiv", "pmid", "pmcid", "isbn", "issn"})
_TYPE_ALIASES = {
    "journal-article": "article",
    "article-journal": "article",
    "proceedings-article": "inproceedings",
    "paper-conference": "inproceedings",
    "book-chapter": "incollection",
    "chapter": "incollection",
    "report": "techreport",
    "thesis": "phdthesis",
}


def decode_bibtex(source: BinaryIO, *, max_input_bytes: int) -> BibliographyDecodeResult:
    try:
        text = read_text(source, max_input_bytes=max_input_bytes)
    except CodecDocumentError as error:
        return BibliographyDecodeResult(items=(document_failure(error),))

    payloads = tuple(
        payload
        for entry_type, payload in _entry_payloads(text)
        if entry_type.casefold() not in _SKIPPED_TYPES
    )
    if not payloads:
        return BibliographyDecodeResult(items=(empty_document(format_name="BibTeX"),))

    items: list[DecodedBibliographyItem] = []
    for record_index, payload in enumerate(payloads):
        try:
            items.append(_parse_record(record_index, payload))
        except (IndexError, KeyError, TypeError, ValueError):
            items.append(malformed_record(record_index, format_name="BibTeX"))
    return BibliographyDecodeResult(items=tuple(items))


def encode_bibtex(
    records: tuple[BibliographicRecord, ...],
    destination: BinaryIO,
) -> BibliographyEncodeResult:
    encoded_indexes: list[int] = []
    failures = []
    omissions: list[BibliographyFieldOmission] = []
    payloads: list[str] = []
    for ordinal, record in enumerate(records, start=1):
        if not has_export_identity(record):
            failures.append(unencodable_record(record.record_index))
            continue
        try:
            validate_record_unicode(record)
            entry_type, type_omission = _encoded_entry_type(record)
            fields = _encoded_fields(record)
            rendered_fields = ",\n".join(f"  {name}={{{_escape(value)}}}" for name, value in fields)
            payloads.append(f"@{entry_type}{{record-{ordinal:06d},\n{rendered_fields}\n}}")
        except (KeyError, TypeError, ValueError):
            failures.append(unencodable_record(record.record_index))
            continue
        encoded_indexes.append(record.record_index)
        if type_omission is not None:
            omissions.append(type_omission)
        omissions.extend(
            author_omissions(record, supports_orcid=False, supports_affiliations=False)
        )
        omissions.extend(identifier_omissions(record, supported=_SUPPORTED_IDENTIFIERS))

    payload = ("\n\n".join(payloads) + ("\n" if payloads else "")).encode("utf-8")
    write_all(destination, payload)
    return BibliographyEncodeResult(
        encoded_record_indexes=tuple(encoded_indexes),
        failures=tuple(failures),
        omissions=tuple(omissions),
    )


def _entry_payloads(text: str) -> tuple[tuple[str, str], ...]:
    matches = tuple(_ENTRY_START.finditer(text))
    return tuple(
        (
            match.group("type"),
            text[match.start() : matches[index + 1].start() if index + 1 < len(matches) else None],
        )
        for index, match in enumerate(matches)
    )


def _parse_record(record_index: int, payload: str) -> BibliographicRecord:
    match = _ENTRY_START.match(payload)
    if match is None:
        raise ValueError("missing BibTeX entry")
    entry_type = match.group("type").casefold()
    opening_position = match.end() - 1
    opening = payload[opening_position]
    closing = "}" if opening == "{" else ")"
    closing_position = _matching_close(payload, opening_position, opening, closing)
    body = payload[opening_position + 1 : closing_position]
    key_end = body.find(",")
    if key_end <= 0 or clean_text(body[:key_end]) is None:
        raise ValueError("missing BibTeX key")
    fields = _parse_fields(body, key_end + 1)

    date = _first(fields, "date")
    year = parse_year(_first(fields, "year"))
    identifier_values: list[tuple[str, str]] = []
    for namespace in ("doi", "pmid", "pmcid", "isbn", "issn", "arxiv"):
        value = _first(fields, namespace)
        if value is not None:
            identifier_values.append((namespace, value))
    eprint = _first(fields, "eprint")
    eprint_type = _first(fields, "eprinttype", "archiveprefix")
    if eprint is not None and eprint_type is not None and eprint_type.casefold() == "arxiv":
        identifier_values.append(("arxiv", eprint))

    return metadata_record(
        record_index,
        title=_first(fields, "title"),
        authors=_parse_authors(_first(fields, "author")),
        abstract=_first(fields, "abstract"),
        date=date,
        year=year,
        document_type=entry_type,
        language=_first(fields, "language", "langid"),
        venue=_first(fields, "journaltitle", "journal", "booktitle", "eventtitle"),
        publisher=_first(fields, "publisher"),
        volume=_first(fields, "volume"),
        issue=_first(fields, "number", "issue"),
        pages=_first(fields, "pages"),
        identifier_values=identifier_values,
        keywords=split_keywords(_first(fields, "keywords")),
    )


def _matching_close(
    payload: str,
    opening_position: int,
    opening: str,
    closing: str,
) -> int:
    depth = 1
    quoted = False
    escaped = False
    for position in range(opening_position + 1, len(payload)):
        character = payload[position]
        if escaped:
            escaped = False
            continue
        if character == "\\":
            escaped = True
            continue
        if character == '"':
            quoted = not quoted
            continue
        if quoted:
            continue
        if character == opening:
            depth += 1
        elif character == closing:
            depth -= 1
            if depth == 0:
                return position
    raise ValueError("unbalanced BibTeX entry")


def _parse_fields(body: str, position: int) -> dict[str, str]:
    result: dict[str, str] = {}
    while position < len(body):
        position = _skip(body, position, " ,\t\r\n")
        if position >= len(body):
            break
        match = _FIELD.match(body, position)
        if match is None:
            raise ValueError("malformed BibTeX field")
        name = match.group("name").casefold()
        if name in result:
            raise ValueError("duplicate BibTeX field")
        position = _skip(body, match.end(), " \t\r\n")
        value, position = _read_value(body, position)
        components = [value]
        position = _skip(body, position, " \t\r\n")
        while position < len(body) and body[position] == "#":
            position = _skip(body, position + 1, " \t\r\n")
            component, position = _read_value(body, position)
            components.append(component)
            position = _skip(body, position, " \t\r\n")
        result[name] = clean_text("".join(components)) or ""
        if position < len(body) and body[position] not in ",":
            raise ValueError("malformed BibTeX field separator")
        if position < len(body):
            position += 1
    return result


def _read_value(body: str, position: int) -> tuple[str, int]:
    if position >= len(body):
        raise ValueError("missing BibTeX value")
    marker = body[position]
    if marker == "{":
        value, end = _balanced_value(body, position, "{", "}")
        return _unescape(value), end
    if marker == '"':
        escaped = False
        result: list[str] = []
        for current in range(position + 1, len(body)):
            character = body[current]
            if escaped:
                result.append(character)
                escaped = False
            elif character == "\\":
                escaped = True
                result.append(character)
            elif character == '"':
                return _unescape("".join(result)), current + 1
            else:
                result.append(character)
        raise ValueError("unbalanced BibTeX quote")
    end = position
    while end < len(body) and body[end] not in ",#":
        end += 1
    value = clean_text(body[position:end])
    if value is None:
        raise ValueError("empty BibTeX value")
    return value, end


def _balanced_value(
    body: str,
    position: int,
    opening: str,
    closing: str,
) -> tuple[str, int]:
    depth = 1
    escaped = False
    for current in range(position + 1, len(body)):
        character = body[current]
        if escaped:
            escaped = False
            continue
        if character == "\\":
            escaped = True
        elif character == opening:
            depth += 1
        elif character == closing:
            depth -= 1
            if depth == 0:
                return body[position + 1 : current], current + 1
    raise ValueError("unbalanced BibTeX value")


def _parse_authors(value: str | None) -> tuple[Author, ...]:
    if value is None:
        return ()
    authors: list[Author] = []
    for raw in re.split(r"\s+and\s+", value, flags=re.IGNORECASE):
        normalized = clean_text(raw)
        if normalized is None:
            continue
        organization = normalized.startswith("{") and normalized.endswith("}")
        if organization:
            normalized = clean_text(normalized[1:-1]) or ""
        authors.append(display_author(normalized, organization=organization))
    return tuple(authors)


def _first(fields: dict[str, str], *names: str) -> str | None:
    for name in names:
        value = clean_text(fields.get(name))
        if value is not None:
            return value
    return None


def _skip(value: str, position: int, characters: str) -> int:
    while position < len(value) and value[position] in characters:
        position += 1
    return position


def _unescape(value: str) -> str:
    return value.replace("\\{", "{").replace("\\}", "}").replace("\\\\", "\\")


def _escape(value: str) -> str:
    normalized = value.replace("\r", " ").replace("\n", " ").replace("\\", "\\\\")
    if normalized.count("{") != normalized.count("}"):
        normalized = normalized.replace("{", "\\{").replace("}", "\\}")
    return normalized


def _encoded_entry_type(
    record: BibliographicRecord,
) -> tuple[str, BibliographyFieldOmission | None]:
    document_type = record.metadata.document_type
    if document_type is None:
        return "misc", None
    candidate = _TYPE_ALIASES.get(document_type.casefold(), document_type.casefold())
    if _ENTRY_TYPE.fullmatch(candidate) is not None:
        return candidate, None
    return (
        "misc",
        omission(
            record.record_index,
            "document_type",
            "The document type is not a valid BibTeX entry type and was exported as misc.",
        ),
    )


def _encoded_fields(record: BibliographicRecord) -> tuple[tuple[str, str], ...]:
    metadata = record.metadata
    values: list[tuple[str, str]] = []
    if metadata.title is not None:
        values.append(("title", metadata.title))
    if metadata.authors:
        values.append(("author", " and ".join(author_display(item) for item in metadata.authors)))
    optional = (
        ("abstract", metadata.abstract),
        ("date", metadata.publication_date),
        ("year", str(metadata.publication_year) if metadata.publication_year is not None else None),
        ("language", metadata.language),
        ("journaltitle", metadata.venue),
        ("publisher", metadata.publisher),
        ("volume", metadata.volume),
        ("number", metadata.issue),
        ("pages", metadata.pages),
    )
    values.extend((name, value) for name, value in optional if value is not None)
    groups = identifier_groups(metadata)
    for namespace in ("doi", "pmid", "pmcid", "isbn", "issn"):
        if groups.get(namespace):
            values.append((namespace, groups[namespace][0].value))
    if groups.get("arxiv"):
        values.extend((("eprint", groups["arxiv"][0].value), ("eprinttype", "arXiv")))
    if metadata.keywords:
        values.append(("keywords", "; ".join(metadata.keywords)))
    return tuple(values)


__all__ = ("decode_bibtex", "encode_bibtex")
