from __future__ import annotations

import re

import bibtexparser

from sciretriever.interoperability.model import ExportEncodingResult, RecordParseResult
from sciretriever.kernel import BibliographyFormat

from ._common import CodecInputError, decode_bytes, read_bounded, record, rejected


def _entries(text: str) -> tuple[str, ...]:
    starts = tuple(match.start() for match in re.finditer(r"(?m)^\s*@(?=[A-Za-z]+\s*[{(])", text))
    return tuple(text[start:end] for start, end in zip(starts, starts[1:] + (len(text),)))


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
                if payload.count("{") != payload.count("}"):
                    raise CodecInputError("malformed-record", "BibTeX record has unbalanced braces")
                values = bibtexparser.loads(payload).entries
                if len(values) != 1:
                    raise CodecInputError("malformed-record", "BibTeX record cannot be parsed")
                item = values[0]
                authors = tuple(
                    part.strip() for part in item.get("author", "").split(" and ") if part.strip()
                )

                def split(name: str) -> tuple[str, ...]:
                    return tuple(
                        part.strip()
                        for part in re.split(r"[;,]", item.get(name, ""))
                        if part.strip()
                    )

                ids = tuple(
                    (name, item[name])
                    for name in ("doi", "pmid", "pmcid", "arxiv", "isbn", "issn")
                    if name in item
                )
                result = record(
                    title=item.get("title"),
                    authors=authors,
                    identifier_values=ids,
                    abstract=item.get("abstract"),
                    keywords=split("keywords"),
                    tags=split("tags"),
                    references=split("references"),
                    institutions=split("institution"),
                    year=int(item["year"]) if item.get("year", "").isdigit() else None,
                    month=int(item["month"]) if item.get("month", "").isdigit() else None,
                    venue=item.get("journal") or item.get("booktitle"),
                    volume=item.get("volume"),
                    issue=item.get("number"),
                    pages=item.get("pages", "").replace("--", "-"),
                    item_type=item.get("ENTRYTYPE"),
                    language=item.get("language"),
                )
                results.append(RecordParseResult(ordinal, result, None))
            except (CodecInputError, KeyError, TypeError, ValueError) as error:
                results.append(rejected(ordinal, "malformed-record", str(error)))
        return tuple(results) or (rejected(0, "empty-input", "input contains no BibTeX records"),)

    def write(self, records, stream) -> ExportEncodingResult:
        raise NotImplementedError
