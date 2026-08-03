from __future__ import annotations

import json
from typing import TypeAlias

from sciretriever.model.record import ImportedBibliographicRecord

from ._common import supported_identifiers

JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]


def _author(value: str, institutions: tuple[str, ...]) -> dict[str, JsonValue]:
    result: dict[str, JsonValue] = {"literal": value}
    if institutions:
        result["affiliation"] = [{"name": item} for item in institutions]
    return result


def _put_optional(result: dict[str, JsonValue], name: str, value: str | None) -> None:
    if value is not None:
        result[name] = value


def json_record(
    record_value: ImportedBibliographicRecord, supported: frozenset[str]
) -> dict[str, JsonValue]:
    result: dict[str, JsonValue] = {
        "title": record_value.title,
        "type": record_value.item_type or "article",
        "author": [_author(author, record_value.institutions) for author in record_value.authors],
    }
    _put_optional(result, "abstract", record_value.abstract)
    if record_value.year is not None:
        date_parts: list[JsonValue] = [record_value.year]
        if record_value.month is not None:
            date_parts.append(record_value.month)
        result["issued"] = {"date-parts": [date_parts]}
    _put_optional(result, "container-title", record_value.venue)
    for name, value in (
        ("volume", record_value.volume),
        ("issue", record_value.issue),
        ("page", record_value.pages),
        ("language", record_value.language),
    ):
        _put_optional(result, name, value)
    if record_value.keywords:
        result["keyword"] = "; ".join(record_value.keywords)
    if record_value.tags:
        result["categories"] = list(record_value.tags)
    if record_value.references:
        result["references"] = [
            {"unstructured": reference} for reference in record_value.references
        ]
    for identifier in supported_identifiers(record_value, supported):
        namespace = identifier.namespace.casefold()
        if namespace == "arxiv":
            result["archive"] = "arXiv"
            result["archive_location"] = identifier.value
        else:
            result[namespace.upper()] = identifier.value
    return result


def json_bytes(
    records: tuple[ImportedBibliographicRecord, ...], supported: frozenset[str]
) -> bytes:
    return json.dumps(
        [json_record(record_value, supported) for record_value in records],
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("ascii")
