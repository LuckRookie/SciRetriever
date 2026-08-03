from __future__ import annotations

import json
from typing import TypeAlias

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
    read_bounded,
    record,
    rejected,
    split_values,
    write_all,
)
from .csl_write import json_bytes

JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
_SUPPORTED_IDENTIFIERS = frozenset(("doi", "pmid", "pmcid", "arxiv", "isbn", "issn"))


def _duplicate_keys(pairs: list[tuple[str, JsonValue]]) -> dict[str, JsonValue]:
    result: dict[str, JsonValue] = {}
    for key, value in pairs:
        if key in result:
            raise CodecInputError("malformed-json", "CSL JSON contains duplicate object keys")
        result[key] = value
    return result


def _reject_constant(value: str) -> JsonValue:
    raise CodecInputError("malformed-json", f"CSL JSON contains non-finite value {value}")


def _text(fields: dict[str, JsonValue], name: str) -> str | None:
    value = fields.get(name)
    return value if isinstance(value, str) else None


def _texts(value: JsonValue | None) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    strings = tuple(item for item in value if isinstance(item, str))
    if len(strings) != len(value):
        raise CodecInputError("malformed-record", "CSL JSON array contains a non-text value")
    return strings


def _authors(value: JsonValue | None) -> tuple[tuple[str, str], ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise CodecInputError("malformed-record", "CSL author must be an array")
    authors: list[tuple[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            raise CodecInputError("malformed-record", "CSL author must be an object")
        literal = item.get("literal")
        if isinstance(literal, str):
            authors.append((literal, _affiliations(item)))
            continue
        family, given = item.get("family"), item.get("given")
        if not isinstance(family, str) or (given is not None and not isinstance(given, str)):
            raise CodecInputError("malformed-record", "CSL author has no supported name")
        authors.append((f"{family}, {given}" if given else family, _affiliations(item)))
    return tuple(authors)


def _affiliations(author: dict[str, JsonValue]) -> str:
    value = author.get("affiliation")
    if not isinstance(value, list):
        return ""
    names: list[str] = []
    for item in value:
        if isinstance(item, str):
            names.append(item)
            continue
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if isinstance(name, str):
            names.append(name)
    return "\x1f".join(names)


def _references(value: JsonValue | None) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise CodecInputError("malformed-record", "CSL references must be an array")
    result: list[str] = []
    for item in value:
        if isinstance(item, str):
            result.append(item)
            continue
        if not isinstance(item, dict):
            raise CodecInputError("malformed-record", "CSL reference is not an object or text")
        raw = item.get("unstructured") or item.get("title")
        if not isinstance(raw, str):
            raise CodecInputError("malformed-record", "CSL reference has no text")
        result.append(raw)
    return tuple(result)


def _date(fields: dict[str, JsonValue]) -> tuple[int | None, int | None]:
    issued = fields.get("issued")
    if not isinstance(issued, dict):
        return None, None
    parts = issued.get("date-parts")
    if not isinstance(parts, list) or not parts or not isinstance(parts[0], list):
        return None, None
    first = parts[0]
    if not first or not isinstance(first[0], int) or isinstance(first[0], bool):
        return None, None
    year = first[0]
    month = first[1] if len(first) > 1 and isinstance(first[1], int) else None
    return year, month


def _identifier_values(fields: dict[str, JsonValue]) -> tuple[tuple[str, str], ...]:
    values: list[tuple[str, str]] = []
    for field, namespace in (
        ("DOI", "doi"),
        ("PMID", "pmid"),
        ("PMCID", "pmcid"),
        ("ISBN", "isbn"),
        ("ISSN", "issn"),
    ):
        value = fields.get(field)
        if isinstance(value, str):
            values.append((namespace, value))
    archive = fields.get("archive")
    location = fields.get("archive_location")
    if isinstance(archive, str) and archive.casefold() == "arxiv" and isinstance(location, str):
        values.append(("arxiv", location))
    return tuple(values)


def _parse_item(item: JsonValue) -> ImportedBibliographicRecord:
    if not isinstance(item, dict):
        raise CodecInputError("malformed-record", "CSL JSON record must be an object")
    year, month = _date(item)
    author_values = _authors(item.get("author"))
    institutions = tuple(
        dict.fromkeys(
            affiliation
            for _name, affiliations in author_values
            for affiliation in affiliations.split("\x1f")
            if affiliation
        )
    )
    keyword = item.get("keyword")
    keywords = split_values(keyword) if isinstance(keyword, str) else _texts(keyword)
    return record(
        RecordFields(
            title=_text(item, "title"),
            authors=tuple(name for name, _affiliation in author_values),
            identifier_values=_identifier_values(item),
            abstract=_text(item, "abstract"),
            keywords=keywords,
            tags=_texts(item.get("categories")),
            references=_references(item.get("references")),
            institutions=institutions,
            year=year,
            month=month,
            venue=_text(item, "container-title"),
            volume=_text(item, "volume"),
            issue=_text(item, "issue"),
            pages=_text(item, "page"),
            item_type={"article-journal": "article"}.get(
                _text(item, "type") or "", _text(item, "type")
            ),
            language=_text(item, "language"),
        )
    )


class CslJsonCodec:
    format = BibliographyFormat.CSL_JSON

    def read(self, stream) -> tuple[RecordParseResult, ...]:
        try:
            text = decode_bytes(read_bounded(stream))
            value: JsonValue = json.loads(
                text, object_pairs_hook=_duplicate_keys, parse_constant=_reject_constant
            )
        except CodecInputError as error:
            return (rejected(0, error.code, error.reason),)
        except json.JSONDecodeError:
            return (rejected(0, "malformed-json", "input is not valid CSL JSON"),)
        values = value if isinstance(value, list) else [value]
        if not values:
            return (rejected(0, "empty-input", "input contains no CSL JSON records"),)
        results: list[RecordParseResult] = []
        for ordinal, item in enumerate(values):
            try:
                parsed = _parse_item(item)
                results.append(RecordParseResult(ordinal=ordinal, record=parsed, failure=None))
            except (CodecInputError, KeyError, TypeError, ValueError, IndexError):
                results.append(
                    rejected(ordinal, "malformed-record", "CSL JSON record is malformed")
                )
        return tuple(results)

    def write(
        self, records: tuple[ImportedBibliographicRecord, ...], stream
    ) -> ExportEncodingResult:
        omissions_list: list[ExportOmission] = []
        for record_value in records:
            omissions_list.extend(identifier_omissions(record_value, _SUPPORTED_IDENTIFIERS))
            if record_value.institutions and not record_value.authors:
                omissions_list.append(
                    ExportOmission(field="institutions", reason="no-author-affiliation-slot")
                )
        payload = json_bytes(records, _SUPPORTED_IDENTIFIERS)
        bytes_written = write_all(stream, payload)
        return ExportEncodingResult(
            record_count=len(records), bytes_written=bytes_written, omissions=tuple(omissions_list)
        )


__all__ = ("CslJsonCodec",)
