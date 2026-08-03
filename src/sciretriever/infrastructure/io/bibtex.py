from __future__ import annotations

import re

from sciretriever.model.primitives import BibliographyFormat
from sciretriever.model.record import (
    ExportEncodingResult,
    ExportOmission,
    ImportedBibliographicRecord,
    RecordParseResult,
)

from ._common import (
    CodecInputError,
    RecordFields,
    decode_bytes,
    identifier_omissions,
    parse_date,
    parse_month,
    parse_year,
    read_bounded,
    record,
    rejected,
    split_authors,
    split_values,
    supported_identifiers,
    write_all,
)

_ENTRY_START = re.compile(r"(?m)^\s*@([A-Za-z][A-Za-z0-9_-]*)\s*[{(]")
_ENTRY_TYPE = re.compile(r"^\s*@([A-Za-z][A-Za-z0-9_-]*)", re.IGNORECASE)
_ENTRY_TYPE_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")
_SUPPORTED_IDENTIFIERS = frozenset(("doi", "pmid", "pmcid", "arxiv", "isbn", "issn"))
_SKIPPED_ENTRIES = frozenset(("comment", "preamble", "string"))


def _entries(text: str) -> tuple[str, ...]:
    starts = tuple(match.start() for match in _ENTRY_START.finditer(text))
    return tuple(text[start:end] for start, end in zip(starts, starts[1:] + (len(text),)))


def _field(item: dict[str, str], *names: str) -> str | None:
    for name in names:
        value = item.get(name)
        if value is not None:
            return value
    return None


def _identifier_values(item: dict[str, str]) -> tuple[tuple[str, str], ...]:
    values = [
        (name, item[name])
        for name in ("doi", "pmid", "pmcid", "arxiv", "isbn", "issn")
        if name in item
    ]
    eprint = item.get("eprint")
    if eprint and item.get("eprinttype", "").casefold() == "arxiv":
        values.append(("arxiv", eprint))
    return tuple(values)


def _read_value(body: str, position: int) -> tuple[str, int]:
    if body[position] == "{":
        start = position + 1
        depth = 1
        position += 1
        while position < len(body) and depth:
            if body[position] == "{" and body[position - 1] != "\\":
                depth += 1
            elif body[position] == "}" and body[position - 1] != "\\":
                depth -= 1
            position += 1
        if depth:
            raise CodecInputError("malformed-record", "BibTeX field has unbalanced braces")
        return body[start : position - 1], position
    if body[position] == '"':
        start = position + 1
        position += 1
        while position < len(body):
            if body[position] == '"' and body[position - 1] != "\\":
                return body[start:position], position + 1
            position += 1
        raise CodecInputError("malformed-record", "BibTeX field has unbalanced quotes")
    start = position
    while position < len(body) and body[position] != ",":
        position += 1
    return body[start:position].strip(), position


def _parse_payload_fields(payload: str) -> dict[str, str]:  # noqa: C901
    match = _ENTRY_TYPE.match(payload)
    if match is None:
        raise CodecInputError("malformed-record", "BibTeX record has no entry type")
    opening = payload[match.end() :].lstrip()[:1]
    if opening not in ("{", "("):
        raise CodecInputError("malformed-record", "BibTeX record has no opening delimiter")
    closing = "}" if opening == "{" else ")"
    body = payload[payload.index(opening, match.end()) + 1 :]
    if not body.rstrip().endswith(closing):
        raise CodecInputError("malformed-record", "BibTeX record has no closing delimiter")
    body = body.rstrip()[:-1]
    comma = body.find(",")
    if comma < 1:
        raise CodecInputError("malformed-record", "BibTeX record has no entry key")
    fields: dict[str, str] = {"ENTRYTYPE": match.group(1).casefold()}
    position = comma + 1
    while position < len(body):
        while position < len(body) and body[position] in " ,\t\r\n":
            position += 1
        if position >= len(body):
            break
        field_match = re.match(r"([A-Za-z][A-Za-z0-9_-]*)\s*=", body[position:])
        if field_match is None:
            raise CodecInputError("malformed-record", "BibTeX record has malformed field")
        name = field_match.group(1).casefold()
        position += field_match.end()
        while position < len(body) and body[position].isspace():
            position += 1
        if position >= len(body):
            raise CodecInputError("malformed-record", "BibTeX field has no value")
        value, position = _read_value(body, position)
        fields[name] = value
        while position < len(body) and body[position] in " \t\r\n":
            position += 1
        if position < len(body) and body[position] == ",":
            position += 1
    return fields


def _parse_payload(payload: str) -> ImportedBibliographicRecord | None:
    kind_match = _ENTRY_TYPE.match(payload)
    if kind_match is not None and kind_match.group(1).casefold() in _SKIPPED_ENTRIES:
        return None
    item = _parse_payload_fields(payload)
    date_year, date_month = parse_date(_field(item, "date"))
    year = parse_year(_field(item, "year")) or date_year
    month = parse_month(_field(item, "month")) or date_month
    return record(
        RecordFields(
            title=item.get("title"),
            authors=split_authors(item.get("author")),
            identifier_values=_identifier_values(item),
            abstract=item.get("abstract"),
            keywords=split_values(item.get("keywords")),
            tags=split_values(item.get("tags")),
            references=split_values(item.get("references")),
            institutions=split_values(_field(item, "institution", "organization")),
            year=year,
            month=month,
            venue=_field(item, "journaltitle", "journal", "booktitle", "eventtitle"),
            volume=item.get("volume"),
            issue=_field(item, "number", "issue"),
            pages=item.get("pages", "").replace("--", "-") or None,
            item_type=item.get("ENTRYTYPE"),
            language=item.get("language"),
        )
    )


def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\r", " ").replace("\n", " ")


def _entry_type(record_value: ImportedBibliographicRecord) -> tuple[str, ExportOmission | None]:
    candidate = record_value.item_type or "misc"
    if _ENTRY_TYPE_PATTERN.fullmatch(candidate) is not None:
        return candidate, None
    return "misc", ExportOmission(field="item_type", reason="invalid-bibtex-entry-type")


def _field_lines(record_value: ImportedBibliographicRecord) -> tuple[tuple[str, str], ...]:
    values: list[tuple[str, str]] = [("title", record_value.title)]
    optional = (
        ("author", " and ".join(record_value.authors) if record_value.authors else None),
        ("abstract", record_value.abstract),
        ("year", str(record_value.year) if record_value.year is not None else None),
        ("month", str(record_value.month) if record_value.month is not None else None),
        ("journal", record_value.venue),
        ("volume", record_value.volume),
        ("number", record_value.issue),
        ("pages", record_value.pages.replace("-", "--") if record_value.pages else None),
    )
    values.extend((name, value) for name, value in optional if value is not None)
    for identifier in supported_identifiers(record_value, _SUPPORTED_IDENTIFIERS):
        values.append((identifier.namespace.casefold(), identifier.value))
    if record_value.keywords:
        values.append(("keywords", "; ".join(record_value.keywords)))
    if record_value.tags:
        values.append(("tags", "; ".join(record_value.tags)))
    if record_value.references:
        values.append(("references", "; ".join(record_value.references)))
    if record_value.institutions:
        values.append(("institution", "; ".join(record_value.institutions)))
    if record_value.language is not None:
        values.append(("language", record_value.language))
    return tuple(values)


class BibtexCodec:
    format = BibliographyFormat.BIBTEX

    def read(self, stream) -> tuple[RecordParseResult, ...]:
        try:
            text = decode_bytes(read_bounded(stream))
        except CodecInputError as error:
            return (rejected(0, error.code, error.reason),)
        results: list[RecordParseResult] = []
        for ordinal, payload in enumerate(_entries(text)):
            try:
                parsed = _parse_payload(payload)
                if parsed is not None:
                    results.append(RecordParseResult(ordinal=ordinal, record=parsed, failure=None))
            except (CodecInputError, KeyError, TypeError, ValueError, IndexError):
                results.append(rejected(ordinal, "malformed-record", "BibTeX record is malformed"))
        return tuple(results) or (rejected(0, "empty-input", "input contains no BibTeX records"),)

    def write(
        self, records: tuple[ImportedBibliographicRecord, ...], stream
    ) -> ExportEncodingResult:
        payloads: list[str] = []
        omissions: list[ExportOmission] = []
        for index, record_value in enumerate(records, start=1):
            entry_type, type_omission = _entry_type(record_value)
            if type_omission is not None:
                omissions.append(type_omission)
            omissions.extend(identifier_omissions(record_value, _SUPPORTED_IDENTIFIERS))
            fields = ",\n".join(
                f"  {name}={{{_escape(value)}}}" for name, value in _field_lines(record_value)
            )
            payloads.append(f"@{entry_type}{{record-{index:06d},\n{fields}\n}}")
        payload = ("\n\n".join(payloads) + ("\n" if payloads else "")).encode("utf-8")
        bytes_written = write_all(stream, payload)
        return ExportEncodingResult(
            record_count=len(records), bytes_written=bytes_written, omissions=tuple(omissions)
        )


__all__ = ("BibtexCodec",)
