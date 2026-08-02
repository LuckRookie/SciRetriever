from __future__ import annotations

from sciretriever.interoperability.model import ExportEncodingResult, RecordParseResult
from sciretriever.kernel import (
    BoundaryError,
    CanonicalJsonObject,
    parse_canonical_json,
)
from sciretriever.model.primitives import BibliographyFormat

from ._common import CodecInputError, decode_bytes, read_bounded, record, rejected


def _text(fields: dict, name: str) -> str | None:
    value = fields.get(name)
    return value if isinstance(value, str) else None


def _strings(value) -> tuple[str, ...]:
    return (
        tuple(item for item in value if isinstance(item, str)) if isinstance(value, tuple) else ()
    )


class CslJsonCodec:
    format = BibliographyFormat.CSL_JSON

    def read(self, stream) -> tuple[RecordParseResult, ...]:  # noqa: C901
        try:
            value = parse_canonical_json(decode_bytes(read_bounded(stream)))
        except (CodecInputError, BoundaryError) as error:
            return (rejected(0, "malformed-json", str(error)),)
        values = value if isinstance(value, tuple) else (value,)
        if not values:
            return (rejected(0, "empty-input", "input contains no CSL JSON records"),)
        results: list[RecordParseResult] = []
        for ordinal, item in enumerate(values):
            try:
                if not isinstance(item, CanonicalJsonObject):
                    raise CodecInputError("malformed-record", "CSL JSON record must be an object")
                fields = dict(item.entries)
                authors: list[str] = []
                raw_authors = fields.get("author", ())
                if not isinstance(raw_authors, tuple):
                    raise CodecInputError("malformed-record", "CSL author must be an array")
                for author in raw_authors:
                    if not isinstance(author, CanonicalJsonObject):
                        raise CodecInputError("malformed-record", "CSL author must be an object")
                    names = dict(author.entries)
                    literal = names.get("literal")
                    if isinstance(literal, str):
                        authors.append(literal)
                    else:
                        family, given = names.get("family"), names.get("given")
                        if isinstance(family, str):
                            authors.append(
                                f"{family}, {given}" if isinstance(given, str) else family
                            )
                issued = fields.get("issued")
                date_parts = (
                    dict(issued.entries).get("date-parts", ())
                    if isinstance(issued, CanonicalJsonObject)
                    else ()
                )
                first_date = (
                    date_parts[0]
                    if isinstance(date_parts, tuple)
                    and date_parts
                    and isinstance(date_parts[0], tuple)
                    else ()
                )
                keyword = _text(fields, "keyword")
                ids = tuple(
                    (name.casefold(), value)
                    for name in ("DOI", "PMID", "PMCID", "ISBN", "ISSN")
                    if isinstance(value := fields.get(name), str)
                )
                item_type = _text(fields, "type")
                result = record(
                    title=_text(fields, "title"),
                    authors=authors,
                    identifier_values=ids,
                    abstract=_text(fields, "abstract"),
                    keywords=() if keyword is None else tuple(keyword.replace(",", ";").split(";")),
                    tags=_strings(fields.get("categories")),
                    references=_strings(fields.get("references")),
                    year=first_date[0] if first_date and isinstance(first_date[0], int) else None,
                    month=first_date[1]
                    if len(first_date) > 1 and isinstance(first_date[1], int)
                    else None,
                    venue=_text(fields, "container-title"),
                    volume=_text(fields, "volume"),
                    issue=_text(fields, "issue"),
                    pages=_text(fields, "page"),
                    item_type=(
                        None
                        if item_type is None
                        else {"article-journal": "article"}.get(item_type, item_type)
                    ),
                    language=_text(fields, "language"),
                )
                results.append(RecordParseResult(ordinal, result, None))
            except (CodecInputError, KeyError, TypeError, ValueError) as error:
                results.append(rejected(ordinal, "malformed-record", str(error)))
        return tuple(results)

    def write(self, records, stream) -> ExportEncodingResult:
        raise NotImplementedError
