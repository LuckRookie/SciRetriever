"""CSL JSON codec for neutral bibliographic records."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from math import isfinite
from typing import BinaryIO, TypeAlias, cast

from sciretriever.entry.codecs._common import (
    CodecDocumentError,
    affiliations,
    clean_text,
    document_failure,
    empty_document,
    has_export_identity,
    identifier_groups,
    identifier_omissions,
    malformed_record,
    metadata_record,
    normalize_unicode_scalars,
    omission,
    ordered_text,
    publication_date,
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
from sciretriever.model.literature import Author, AuthorKind
from sciretriever.model.record import BibliographicRecord

JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
_SUPPORTED_IDENTIFIERS = frozenset({"doi", "arxiv", "pmid", "pmcid", "isbn", "issn"})
_TYPE_TO_CSL = {
    "journal-article": "article-journal",
    "article": "article-journal",
    "book-chapter": "chapter",
    "proceedings-article": "paper-conference",
}


@dataclass(frozen=True, slots=True)
class _JsonObject:
    pairs: tuple[tuple[str, object], ...]


class _NonFiniteValue:
    __slots__ = ()


_NON_FINITE = _NonFiniteValue()


def decode_csl_json(source: BinaryIO, *, max_input_bytes: int) -> BibliographyDecodeResult:
    try:
        text = read_text(source, max_input_bytes=max_input_bytes)
    except CodecDocumentError as error:
        return BibliographyDecodeResult(items=(document_failure(error),))
    try:
        value = cast(
            object,
            json.loads(
                text,
                object_pairs_hook=_preserve_object,
                parse_constant=_preserve_nonfinite,
            ),
        )
    except (json.JSONDecodeError, RecursionError):
        return _json_document_failure(
            "The input is not valid CSL JSON.",
            "Correct the JSON document and retry the operation.",
        )
    if isinstance(value, list):
        values = value
    elif isinstance(value, _JsonObject):
        values = [value]
    else:
        return _json_document_failure(
            "The CSL JSON root is not one record or an array of records.",
            "Provide a CSL JSON object or array and retry the operation.",
        )
    if not values:
        return BibliographyDecodeResult(items=(empty_document(format_name="CSL JSON"),))
    items: list[DecodedBibliographyItem] = []
    for record_index, value in enumerate(values):
        try:
            item = _materialize_json(value)
            items.append(_parse_record(record_index, item))
        except (IndexError, KeyError, RecursionError, TypeError, ValueError):
            items.append(malformed_record(record_index, format_name="CSL JSON"))
    return BibliographyDecodeResult(items=tuple(items))


def encode_csl_json(
    records: tuple[BibliographicRecord, ...],
    destination: BinaryIO,
) -> BibliographyEncodeResult:
    encoded_indexes: list[int] = []
    failures = []
    omissions: list[BibliographyFieldOmission] = []
    values: list[JsonValue] = []
    for ordinal, record in enumerate(records, start=1):
        if not has_export_identity(record):
            failures.append(unencodable_record(record.record_index))
            continue
        try:
            validate_record_unicode(record)
            value, date_omission = _encoded_record(record, ordinal)
        except (KeyError, TypeError, ValueError):
            failures.append(unencodable_record(record.record_index))
            continue
        encoded_indexes.append(record.record_index)
        values.append(value)
        if date_omission is not None:
            omissions.append(date_omission)
        omissions.extend(identifier_omissions(record, supported=_SUPPORTED_IDENTIFIERS))
    payload = json.dumps(
        values,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    write_all(destination, payload)
    return BibliographyEncodeResult(
        encoded_record_indexes=tuple(encoded_indexes),
        failures=tuple(failures),
        omissions=tuple(omissions),
    )


def _json_document_failure(reason: str, action: str) -> BibliographyDecodeResult:
    return BibliographyDecodeResult(
        items=(
            document_failure(
                CodecDocumentError(
                    "bibliography-malformed-json",
                    reason,
                    action,
                )
            ),
        )
    )


def _preserve_object(pairs: list[tuple[str, object]]) -> _JsonObject:
    return _JsonObject(pairs=tuple(pairs))


def _preserve_nonfinite(_value: str) -> _NonFiniteValue:
    return _NON_FINITE


def _materialize_json(value: object) -> JsonValue:
    if isinstance(value, _NonFiniteValue):
        raise ValueError("CSL JSON number must be finite")
    if isinstance(value, _JsonObject):
        result: dict[str, JsonValue] = {}
        for raw_key, raw_value in value.pairs:
            key = normalize_unicode_scalars(raw_key)
            if key in result:
                raise ValueError("CSL JSON object fields must be unique")
            result[key] = _materialize_json(raw_value)
        return result
    if isinstance(value, list):
        return [_materialize_json(item) for item in value]
    if isinstance(value, str):
        return normalize_unicode_scalars(value)
    if isinstance(value, float) and not isfinite(value):
        raise ValueError("CSL JSON number must be finite")
    if value is None or isinstance(value, (bool, int, float)):
        return value
    raise TypeError("CSL JSON value has an invalid runtime type")


def _parse_record(record_index: int, value: JsonValue) -> BibliographicRecord:
    if not isinstance(value, dict):
        raise ValueError("CSL record must be an object")
    date, year = _issued_date(value.get("issued"))
    identifier_values: list[tuple[str, str]] = []
    for field, namespace in (
        ("DOI", "doi"),
        ("PMID", "pmid"),
        ("PMCID", "pmcid"),
        ("ISBN", "isbn"),
        ("ISSN", "issn"),
    ):
        item = _optional_text(value, field)
        if item is not None:
            identifier_values.append((namespace, item))
    archive = _optional_text(value, "archive")
    archive_location = _optional_text(value, "archive_location")
    if archive is not None and archive.casefold() == "arxiv" and archive_location is not None:
        identifier_values.append(("arxiv", archive_location))
    return metadata_record(
        record_index,
        title=_optional_text(value, "title"),
        authors=_authors(value.get("author")),
        abstract=_optional_text(value, "abstract"),
        date=date,
        year=year,
        document_type=_optional_text(value, "type"),
        language=_optional_text(value, "language"),
        venue=_optional_text(value, "container-title"),
        publisher=_optional_text(value, "publisher"),
        volume=_optional_text(value, "volume"),
        issue=_optional_text(value, "issue"),
        pages=_optional_text(value, "page"),
        identifier_values=identifier_values,
        keywords=_keywords(value.get("keyword")),
    )


def _optional_text(fields: dict[str, JsonValue], name: str) -> str | None:
    value = fields.get(name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("CSL text field has an invalid type")
    return clean_text(value)


def _authors(value: JsonValue | None) -> tuple[Author, ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise ValueError("CSL author must be an array")
    return tuple(_author(item) for item in value)


def _author(value: JsonValue) -> Author:
    if not isinstance(value, dict):
        raise ValueError("CSL author must be an object")
    author_affiliations = affiliations(value.get("affiliation"))
    orcid_value = value.get("ORCID", value.get("orcid"))
    if orcid_value is not None and not isinstance(orcid_value, str):
        raise ValueError("CSL author ORCID must be text")
    literal = value.get("literal")
    if literal is not None:
        if not isinstance(literal, str):
            raise ValueError("CSL literal author must be text")
        return Author(
            kind=AuthorKind.ORGANIZATION,
            display_name=literal,
            orcid=orcid_value,
            affiliations=author_affiliations,
        )
    given = value.get("given")
    family = value.get("family")
    if given is not None and not isinstance(given, str):
        raise ValueError("CSL given name must be text")
    if family is not None and not isinstance(family, str):
        raise ValueError("CSL family name must be text")
    normalized_given = clean_text(given)
    normalized_family = clean_text(family)
    if normalized_given is None and normalized_family is None:
        raise ValueError("CSL person author has no name")
    display = " ".join(item for item in (normalized_given, normalized_family) if item is not None)
    return Author(
        kind=AuthorKind.PERSON,
        display_name=display,
        given_name=normalized_given,
        family_name=normalized_family,
        orcid=orcid_value,
        affiliations=author_affiliations,
    )


def _issued_date(value: JsonValue | None) -> tuple[str | None, int | None]:
    if value is None:
        return None, None
    if not isinstance(value, dict):
        raise ValueError("CSL issued date must be an object")
    parts = value.get("date-parts")
    if not isinstance(parts, list) or not parts or not isinstance(parts[0], list):
        raise ValueError("CSL issued date-parts are malformed")
    first = parts[0]
    if not 1 <= len(first) <= 3 or any(type(item) is not int for item in first):
        raise ValueError("CSL issued date-parts are malformed")
    year = cast(int, first[0])
    if not 1 <= year <= 9999:
        raise ValueError("CSL issued year is out of range")
    date = f"{year:04d}"
    if len(first) >= 2:
        month = cast(int, first[1])
        if not 1 <= month <= 12:
            raise ValueError("CSL issued month is out of range")
        date += f"-{month:02d}"
    if len(first) == 3:
        day = cast(int, first[2])
        if not 1 <= day <= 31:
            raise ValueError("CSL issued day is out of range")
        date += f"-{day:02d}"
    return date, year


def _keywords(value: JsonValue | None) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return split_keywords(value)
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError("CSL keyword must be text or an array of text")
    return ordered_text(cast(list[str], value))


def _encoded_record(
    record: BibliographicRecord,
    ordinal: int,
) -> tuple[dict[str, JsonValue], BibliographyFieldOmission | None]:
    metadata = record.metadata
    result: dict[str, JsonValue] = {
        "id": f"record-{ordinal:06d}",
        "type": _TYPE_TO_CSL.get(
            metadata.document_type.casefold() if metadata.document_type is not None else "",
            metadata.document_type or "article",
        ),
    }
    _put(result, "title", metadata.title)
    _put(result, "abstract", metadata.abstract)
    _put(result, "language", metadata.language)
    _put(result, "container-title", metadata.venue)
    _put(result, "publisher", metadata.publisher)
    _put(result, "volume", metadata.volume)
    _put(result, "issue", metadata.issue)
    _put(result, "page", metadata.pages)
    if metadata.authors:
        result["author"] = [_encoded_author(author) for author in metadata.authors]
    date_parts, date_omission = _encoded_date(record)
    if date_parts is not None:
        result["issued"] = {"date-parts": [date_parts]}
    if metadata.keywords:
        result["keyword"] = "; ".join(metadata.keywords)
    groups = identifier_groups(metadata)
    for namespace in ("doi", "pmid", "pmcid", "isbn", "issn"):
        if groups.get(namespace):
            result[namespace.upper()] = groups[namespace][0].value
    if groups.get("arxiv"):
        result["archive"] = "arXiv"
        result["archive_location"] = groups["arxiv"][0].value
    return result, date_omission


def _encoded_author(author: Author) -> dict[str, JsonValue]:
    result: dict[str, JsonValue]
    if author.kind is AuthorKind.PERSON and (
        author.given_name is not None or author.family_name is not None
    ):
        result = {}
        _put(result, "given", author.given_name)
        _put(result, "family", author.family_name)
    else:
        result = {"literal": author.display_name}
    _put(result, "ORCID", author.orcid)
    if author.affiliations:
        encoded_affiliations: list[JsonValue] = []
        for affiliation in author.affiliations:
            encoded: dict[str, JsonValue] = {"name": affiliation.name}
            _put(encoded, "ROR", affiliation.ror)
            encoded_affiliations.append(encoded)
        result["affiliation"] = encoded_affiliations
    return result


def _encoded_date(
    record: BibliographicRecord,
) -> tuple[list[JsonValue] | None, BibliographyFieldOmission | None]:
    metadata = record.metadata
    if metadata.publication_date is not None:
        normalized, year = publication_date(metadata.publication_date)
        if normalized is not None and re.fullmatch(r"\d{4}(?:-\d{2}(?:-\d{2})?)?", normalized):
            return [int(item) for item in normalized.split("-")], None
        if metadata.publication_year is not None:
            return (
                [metadata.publication_year],
                omission(
                    record.record_index,
                    "publication_date",
                    "CSL JSON cannot express the non-numeric publication date exactly.",
                ),
            )
        if year is not None:
            return [year], None
        return (
            None,
            omission(
                record.record_index,
                "publication_date",
                "CSL JSON cannot express the non-numeric publication date exactly.",
            ),
        )
    if metadata.publication_year is not None:
        return [metadata.publication_year], None
    return None, None


def _put(result: dict[str, JsonValue], name: str, value: str | None) -> None:
    if value is not None:
        result[name] = value


__all__ = ("decode_csl_json", "encode_csl_json")
