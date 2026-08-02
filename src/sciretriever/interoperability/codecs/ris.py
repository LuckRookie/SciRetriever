from __future__ import annotations

from sciretriever.interoperability.model import ExportEncodingResult, RecordParseResult
from sciretriever.model.primitives import BibliographyFormat

from ._common import CodecInputError, decode_bytes, read_bounded, record, rejected


class RisCodec:
    format = BibliographyFormat.RIS

    def read(self, stream) -> tuple[RecordParseResult, ...]:  # noqa: C901
        try:
            lines = decode_bytes(read_bounded(stream)).splitlines()
        except CodecInputError as error:
            return (rejected(0, error.code, error.reason),)
        groups: list[list[tuple[str, str]]] = []
        current: list[tuple[str, str]] = []
        for line in lines:
            if len(line) < 6 or line[2:6] != "  - ":
                if line.strip():
                    current.append(("??", line))
                continue
            tag, value = line[:2], line[6:].strip()
            current.append((tag, value))
            if tag == "ER":
                groups.append(current)
                current = []
        if current:
            groups.append(current)
        results: list[RecordParseResult] = []
        for ordinal, pairs in enumerate(groups):
            try:
                fields: dict[str, list[str]] = {}
                for key, value in pairs:
                    fields.setdefault(key, []).append(value)
                if "??" in fields or "TY" not in fields or "ER" not in fields:
                    raise CodecInputError(
                        "malformed-record", "RIS record has malformed or missing delimiters"
                    )

                def one(key: str) -> str | None:
                    return fields.get(key, [None])[0]

                year_text = one("PY") or one("Y1")
                date = one("DA")
                pages = "-".join(value for value in (one("SP"), one("EP")) if value)
                accession = one("AN")
                ids = tuple(
                    (key, value)
                    for key, value in (("doi", one("DO")), ("pmid", accession), ("issn", one("SN")))
                    if value
                )
                notes = fields.get("N1", [])
                item_type = one("TY")
                result = record(
                    title=one("TI") or one("T1"),
                    authors=fields.get("AU", []),
                    identifier_values=ids,
                    abstract=one("AB"),
                    keywords=fields.get("KW", []),
                    tags=(value[4:] for value in notes if value.casefold().startswith("tag:")),
                    references=fields.get("CR", []),
                    institutions=fields.get("AD", []),
                    year=int(year_text[:4]) if year_text and year_text[:4].isdigit() else None,
                    month=int(date.split("/")[1])
                    if date and len(date.split("/")) > 1 and date.split("/")[1].isdigit()
                    else None,
                    venue=one("JO") or one("JF") or one("T2"),
                    volume=one("VL"),
                    issue=one("IS"),
                    pages=pages,
                    item_type=(
                        None
                        if item_type is None
                        else {"JOUR": "article", "BOOK": "book"}.get(item_type, item_type)
                    ),
                    language=one("LA"),
                )
                results.append(RecordParseResult(ordinal, result, None))
            except (CodecInputError, KeyError, TypeError, ValueError) as error:
                results.append(rejected(ordinal, "malformed-record", str(error)))
        return tuple(results) or (rejected(0, "empty-input", "input contains no RIS records"),)

    def write(self, records, stream) -> ExportEncodingResult:
        raise NotImplementedError
