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
    supported_identifiers,
    write_all,
)

_TAGGED_LINE = re.compile(r"^(?P<tag>[A-Za-z0-9?]{2})  - (?P<value>.*)$")
_SUPPORTED_IDENTIFIERS = frozenset(("doi", "pmid", "pmcid", "arxiv", "isbn", "issn"))
_TYPE_TO_RIS = {"article": "JOUR", "book": "BOOK", "chapter": "CHAP"}
_RIS_TO_TYPE = {value: key for key, value in _TYPE_TO_RIS.items()}


def _groups(text: str) -> tuple[tuple[tuple[str, str], ...], ...]:
    groups: list[tuple[tuple[str, str], ...]] = []
    current: list[tuple[str, str]] = []
    malformed = False
    for line in text.splitlines():
        if not line.strip():
            continue
        match = _TAGGED_LINE.fullmatch(line)
        if match is None:
            if current:
                tag, value = current[-1]
                current[-1] = (tag, f"{value} {line.strip()}")
            else:
                malformed = True
            continue
        tag, value = match.group("tag").upper(), match.group("value").strip()
        if tag == "TY" and current:
            groups.append((("??", ""), *current))
            current = []
            malformed = False
        current.append((tag, value))
        if tag == "ER":
            groups.append(tuple(current) if not malformed else (("??", ""), *current))
            current = []
            malformed = False
    if current:
        groups.append(tuple(current) if not malformed else (("??", ""), *current))
    return tuple(groups)


def _first(fields: dict[str, list[str]], key: str) -> str | None:
    values = fields.get(key)
    return None if not values else values[0]


def _identifier_values(fields: dict[str, list[str]]) -> tuple[tuple[str, str], ...]:
    values: list[tuple[str, str]] = []
    for value in fields.get("DO", ()):
        values.append(("doi", value))
    for value in fields.get("AN", ()):
        match = re.fullmatch(r"(?i)pmid:\s*(.+)", value)
        values.append(("pmid", match.group(1) if match is not None else value))
    for value in fields.get("SN", ()):
        values.append(("issn", value))
    for note in fields.get("N1", ()):
        match = re.fullmatch(r"identifier:([^:]+):(.+)", note, re.IGNORECASE)
        if match is not None:
            values.append((match.group(1), match.group(2)))
    return tuple(values)


def _parse_group(pairs: tuple[tuple[str, str], ...]) -> ImportedBibliographicRecord:
    fields: dict[str, list[str]] = {}
    for key, value in pairs:
        fields.setdefault(key, []).append(value)
    if "TY" not in fields or "ER" not in fields or "??" in fields:
        raise CodecInputError("malformed-record", "RIS record has malformed delimiters")
    year_text = _first(fields, "PY") or _first(fields, "Y1")
    date_year, date_month = parse_date(_first(fields, "DA"))
    start_page = _first(fields, "SP")
    end_page = _first(fields, "EP")
    pages = "-".join(value for value in (start_page, end_page) if value)
    item_type = _first(fields, "TY")
    return record(
        RecordFields(
            title=_first(fields, "TI") or _first(fields, "T1"),
            authors=tuple(fields.get("AU", ())) + tuple(fields.get("A1", ())),
            identifier_values=_identifier_values(fields),
            abstract=_first(fields, "AB") or _first(fields, "N2"),
            keywords=tuple(fields.get("KW", ())),
            tags=tuple(
                value[4:] for value in fields.get("N1", ()) if value.casefold().startswith("tag:")
            ),
            references=tuple(fields.get("CR", ())),
            institutions=tuple(fields.get("AD", ())),
            year=parse_year(year_text) or date_year,
            month=parse_month(_first(fields, "DA")) or date_month,
            venue=_first(fields, "JO") or _first(fields, "JF") or _first(fields, "T2"),
            volume=_first(fields, "VL"),
            issue=_first(fields, "IS"),
            pages=pages or _first(fields, "PP"),
            item_type=_RIS_TO_TYPE.get(item_type or "", item_type),
            language=_first(fields, "LA"),
        )
    )


def _value(value: str) -> str:
    return value.replace("\r", " ").replace("\n", " ").strip()


def _add(lines: list[str], tag: str, value: str | None) -> None:
    if value is not None and value != "":
        lines.append(f"{tag}  - {_value(value)}")


def _ris_type(record_value: ImportedBibliographicRecord) -> tuple[str, ExportOmission | None]:
    candidate = (record_value.item_type or "GEN").casefold()
    if candidate in _TYPE_TO_RIS:
        return _TYPE_TO_RIS[candidate], None
    if re.fullmatch(r"[A-Za-z0-9]{1,6}", candidate) is not None:
        return candidate.upper(), None
    return "GEN", ExportOmission(field="item_type", reason="invalid-ris-type")


def _identifier_lines(record_value: ImportedBibliographicRecord) -> tuple[str, ...]:
    lines: list[str] = []
    for identifier in supported_identifiers(record_value, _SUPPORTED_IDENTIFIERS):
        namespace = identifier.namespace.casefold()
        if namespace == "doi":
            lines.append(f"DO  - {_value(identifier.value)}")
        elif namespace == "pmid":
            lines.append(f"AN  - PMID:{_value(identifier.value)}")
        elif namespace == "issn":
            lines.append(f"SN  - {_value(identifier.value)}")
        else:
            lines.append(f"N1  - identifier:{namespace}:{_value(identifier.value)}")
    return tuple(lines)


def _record_lines(record_value: ImportedBibliographicRecord, item_type: str) -> tuple[str, ...]:
    lines: list[str] = [f"TY  - {item_type}", f"TI  - {_value(record_value.title)}"]
    lines.extend(f"AU  - {_value(author)}" for author in record_value.authors)
    _add(lines, "AB", record_value.abstract)
    if record_value.year is not None:
        _add(lines, "PY", str(record_value.year))
    if record_value.year is not None and record_value.month is not None:
        _add(lines, "DA", f"{record_value.year:04d}/{record_value.month:02d}")
    _add(lines, "JO", record_value.venue)
    _add(lines, "VL", record_value.volume)
    _add(lines, "IS", record_value.issue)
    if record_value.pages is not None:
        start, separator, end = record_value.pages.partition("-")
        _add(lines, "SP", start)
        _add(lines, "EP", end if separator else None)
    lines.extend(_identifier_lines(record_value))
    lines.extend(f"KW  - {_value(keyword)}" for keyword in record_value.keywords)
    lines.extend(f"N1  - tag:{_value(tag)}" for tag in record_value.tags)
    lines.extend(f"CR  - {_value(reference)}" for reference in record_value.references)
    lines.extend(f"AD  - {_value(institution)}" for institution in record_value.institutions)
    _add(lines, "LA", record_value.language)
    lines.append("ER  - ")
    return tuple(lines)


class RisCodec:
    format = BibliographyFormat.RIS

    def read(self, stream) -> tuple[RecordParseResult, ...]:
        try:
            text = decode_bytes(read_bounded(stream))
        except CodecInputError as error:
            return (rejected(0, error.code, error.reason),)
        results: list[RecordParseResult] = []
        for ordinal, pairs in enumerate(_groups(text)):
            try:
                parsed = _parse_group(pairs)
                results.append(RecordParseResult(ordinal=ordinal, record=parsed, failure=None))
            except (CodecInputError, KeyError, TypeError, ValueError, IndexError):
                results.append(rejected(ordinal, "malformed-record", "RIS record is malformed"))
        return tuple(results) or (rejected(0, "empty-input", "input contains no RIS records"),)

    def write(
        self, records: tuple[ImportedBibliographicRecord, ...], stream
    ) -> ExportEncodingResult:
        payloads: list[str] = []
        omissions: list[ExportOmission] = []
        for record_value in records:
            item_type, type_omission = _ris_type(record_value)
            if type_omission is not None:
                omissions.append(type_omission)
            omissions.extend(identifier_omissions(record_value, _SUPPORTED_IDENTIFIERS))
            payloads.append("\n".join(_record_lines(record_value, item_type)))
        payload = ("\n\n".join(payloads) + ("\n" if payloads else "")).encode("utf-8")
        bytes_written = write_all(stream, payload)
        return ExportEncodingResult(
            record_count=len(records), bytes_written=bytes_written, omissions=tuple(omissions)
        )


__all__ = ("RisCodec",)
