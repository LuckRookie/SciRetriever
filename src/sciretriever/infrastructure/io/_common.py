from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Final, Iterable

from sciretriever.model.execution import Action, FailureEvidence, Reason
from sciretriever.model.literature import Identifier
from sciretriever.model.record import (
    ExportOmission,
    ImportedBibliographicRecord,
    RecordParseResult,
)
from sciretriever.services.library.ports import BinaryInput, BinaryOutput

MAX_INPUT_BYTES: Final = 8 * 1024 * 1024
READ_SIZE: Final = 64 * 1024
_SPACE: Final = re.compile(r"\s+")
_IDENTIFIER_ORDER: Final = {"doi": 0, "pmid": 1, "pmcid": 2, "arxiv": 3, "isbn": 4, "issn": 5}
_MONTHS: Final = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}


class CodecInputError(Exception):
    def __init__(self, code: str, reason: str) -> None:
        self.code = code
        self.reason = reason
        super().__init__(reason)

    def __str__(self) -> str:
        return self.reason


class CodecOutputError(Exception):
    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)

    def __str__(self) -> str:
        return self.reason


@dataclass(frozen=True, slots=True)
class RecordFields:
    title: str | None
    authors: tuple[str, ...] = ()
    identifier_values: tuple[tuple[str, str], ...] = ()
    abstract: str | None = None
    keywords: tuple[str, ...] = ()
    tags: tuple[str, ...] = ()
    references: tuple[str, ...] = ()
    institutions: tuple[str, ...] = ()
    year: int | None = None
    month: int | None = None
    venue: str | None = None
    volume: str | None = None
    issue: str | None = None
    pages: str | None = None
    item_type: str | None = None
    language: str | None = None


def read_bounded(stream: BinaryInput) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while chunk := stream.read(READ_SIZE):
        if not isinstance(chunk, bytes):
            raise CodecInputError("invalid-stream", "bibliography stream returned non-bytes")
        total += len(chunk)
        if total > MAX_INPUT_BYTES:
            raise CodecInputError("input-too-large", "bibliography input exceeds the byte limit")
        chunks.append(chunk)
    return b"".join(chunks)


def decode_bytes(value: bytes) -> str:
    encodings = (
        ("utf-8-sig", "utf-16") if value.startswith((b"\xff\xfe", b"\xfe\xff")) else ("utf-8-sig",)
    )
    for encoding in encodings:
        try:
            return value.decode(encoding, errors="strict")
        except UnicodeDecodeError:
            continue
    raise CodecInputError("invalid-encoding", "input is not valid UTF-8 or BOM-marked UTF-16")


def clean(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = _SPACE.sub(" ", unicodedata.normalize("NFC", value)).strip()
    return normalized or None


def ordered(values: Iterable[str]) -> tuple[str, ...]:
    return tuple(value for raw in values if (value := clean(raw)) is not None)


def set_values(values: Iterable[str]) -> tuple[str, ...]:
    return tuple(sorted(set(ordered(values)), key=lambda value: (value.casefold(), value)))


def split_values(value: str | None) -> tuple[str, ...]:
    if value is None:
        return ()
    return ordered(re.split(r"[;,]", value))


def split_authors(value: str | None) -> tuple[str, ...]:
    if value is None:
        return ()
    return ordered(re.split(r"\s+and\s+", value, flags=re.IGNORECASE))


def identifiers(values: Iterable[tuple[str, str]]) -> tuple[Identifier, ...]:
    normalized: set[Identifier] = set()
    for namespace, raw in values:
        value = clean(raw)
        if value is None:
            continue
        key = namespace.casefold()
        if key == "doi":
            value = re.sub(
                r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", value, flags=re.IGNORECASE
            ).casefold()
        elif key in {"pmid", "pmcid", "arxiv", "isbn", "issn"}:
            value = re.sub(rf"^{key}:\s*", "", value, flags=re.IGNORECASE)
        normalized.add(Identifier(namespace=key, value=value))
    return tuple(
        sorted(
            normalized,
            key=lambda item: (
                _IDENTIFIER_ORDER.get(item.namespace, 99),
                item.namespace,
                item.value,
            ),
        )
    )


def parse_year(value: str | None) -> int | None:
    if value is None:
        return None
    match = re.search(r"\b(\d{4})\b", value)
    return None if match is None else int(match.group(1))


def parse_month(value: str | None) -> int | None:
    if value is None:
        return None
    match = re.search(r"(?:^|[-/\s])([0-9]{1,2}|[A-Za-z]{3,9})(?:[-/\s]|$)", value)
    if match is None:
        return None
    token = match.group(1).casefold()
    return int(token) if token.isdigit() and 1 <= int(token) <= 12 else _MONTHS.get(token[:3])


def parse_date(value: str | None) -> tuple[int | None, int | None]:
    return parse_year(value), parse_month(value)


def record(fields: RecordFields) -> ImportedBibliographicRecord:
    title = clean(fields.title)
    if title is None:
        raise CodecInputError("missing-title", "record has no convertible title")
    return ImportedBibliographicRecord(
        title=title,
        authors=ordered(fields.authors),
        identifiers=identifiers(fields.identifier_values),
        abstract=clean(fields.abstract),
        keywords=set_values(fields.keywords),
        tags=set_values(fields.tags),
        references=ordered(fields.references),
        institutions=ordered(fields.institutions),
        year=fields.year,
        month=fields.month,
        venue=clean(fields.venue),
        volume=clean(fields.volume),
        issue=clean(fields.issue),
        pages=clean(fields.pages),
        item_type=clean(fields.item_type),
        language=clean(fields.language),
    )


def rejected(ordinal: int, code: str, reason: str) -> RecordParseResult:
    return RecordParseResult(
        ordinal=ordinal,
        record=ImportedBibliographicRecord(
            title="",
            authors=(),
            identifiers=(),
            abstract=None,
            keywords=(),
            tags=(),
            references=(),
        ),
        failure=FailureEvidence(
            code=code,
            reason=Reason(value=reason),
            action=Action(value="Correct or remove this bibliography record."),
            retryable=False,
        ),
    )


def write_all(stream: BinaryOutput, payload: bytes) -> int:
    written = 0
    view = memoryview(payload)
    while view:
        count = stream.write(view.tobytes())
        if count <= 0 or count > len(view):
            raise CodecOutputError("bibliography output stream did not accept bytes")
        written += count
        view = view[count:]
    return written


def identifier_omissions(
    record_value: ImportedBibliographicRecord, supported: frozenset[str]
) -> tuple[ExportOmission, ...]:
    return tuple(
        ExportOmission(field="identifiers", reason=f"unsupported-namespace:{item.namespace}")
        for item in record_value.identifiers
        if item.namespace.casefold() not in supported
    )


def supported_identifiers(
    record_value: ImportedBibliographicRecord, supported: frozenset[str]
) -> tuple[Identifier, ...]:
    return tuple(
        item for item in record_value.identifiers if item.namespace.casefold() in supported
    )
