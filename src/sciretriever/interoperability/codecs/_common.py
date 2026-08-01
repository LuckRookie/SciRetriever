from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Final

from sciretriever.interoperability.model import ImportedBibliographicRecord, RecordParseResult
from sciretriever.kernel import Action, FailureEvidence, Identifier, Reason

MAX_INPUT_BYTES: Final = 8 * 1024 * 1024
READ_SIZE: Final = 64 * 1024
_SPACE: Final = re.compile(r"\s+")
_IDENTIFIER_ORDER: Final = {"doi": 0, "pmid": 1, "pmcid": 2, "arxiv": 3, "isbn": 4, "issn": 5}
_XML_DECLARATION: Final = re.compile(
    r"^\ufeff?\s*<\?xml\b[^?]*\bencoding\s*=\s*(['\"])([^'\"]+)\1[^?]*\?>",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class CodecInputError(Exception):
    code: str
    reason: str

    def __str__(self) -> str:
        return self.reason


def read_bounded(stream) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while chunk := stream.read(READ_SIZE):
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


def decode_xml_bytes(value: bytes) -> str:  # noqa: C901
    if value.startswith(b"\xef\xbb\xbf"):
        encoding, physical = "utf-8-sig", "utf-8"
    elif value.startswith(b"\xff\xfe"):
        encoding, physical = "utf-16", "utf-16-le"
    elif value.startswith(b"\xfe\xff"):
        encoding, physical = "utf-16", "utf-16-be"
    elif value.startswith(b"<\x00?\x00"):
        encoding, physical = "utf-16-le", "utf-16-le"
    elif value.startswith(b"\x00<\x00?"):
        encoding, physical = "utf-16-be", "utf-16-be"
    else:
        encoding, physical = "utf-8", "utf-8"
    try:
        text = value.decode(encoding, errors="strict")
    except UnicodeDecodeError as error:
        raise CodecInputError(
            "invalid-encoding", "XML bytes do not match a supported encoding"
        ) from error
    if "\x00" in text:
        raise CodecInputError("invalid-encoding", "decoded XML must not contain NUL characters")
    declaration = _XML_DECLARATION.match(text)
    if declaration is not None:
        declared = declaration.group(2).casefold()
        compatible = {
            "utf-8": {"utf-8"},
            "utf-16": {"utf-16-le", "utf-16-be"},
            "utf-16le": {"utf-16-le"},
            "utf-16-le": {"utf-16-le"},
            "utf_16_le": {"utf-16-le"},
            "utf-16be": {"utf-16-be"},
            "utf-16-be": {"utf-16-be"},
            "utf_16_be": {"utf-16-be"},
        }.get(declared)
        if compatible is None:
            raise CodecInputError(
                "unsupported-encoding", "XML declaration names an unsupported encoding"
            )
        if physical not in compatible:
            raise CodecInputError(
                "encoding-mismatch", "XML declaration does not match the byte encoding"
            )
    elif physical != "utf-8":
        raise CodecInputError("missing-encoding", "UTF-16 XML must declare its encoding")
    return text


def clean(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = _SPACE.sub(" ", unicodedata.normalize("NFC", value)).strip()
    return normalized or None


def ordered(values) -> tuple[str, ...]:
    return tuple(value for raw in values if (value := clean(raw)) is not None)


def set_values(values) -> tuple[str, ...]:
    return tuple(sorted(set(ordered(values)), key=lambda value: (value.casefold(), value)))


def identifiers(values) -> tuple[Identifier, ...]:
    normalized: set[Identifier] = set()
    for namespace, raw in values:
        value = clean(raw)
        if value is None:
            continue
        key = namespace.casefold()
        if key == "doi":
            value = re.sub(
                r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", value, flags=re.I
            ).casefold()
        elif key in {"pmid", "pmcid", "arxiv", "isbn", "issn"}:
            value = re.sub(rf"^{key}:\s*", "", value, flags=re.I)
        normalized.add(Identifier(key, value))
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


def rejected(ordinal: int, code: str, reason: str) -> RecordParseResult:
    return RecordParseResult(
        ordinal,
        ImportedBibliographicRecord("", (), (), None, (), (), ()),
        FailureEvidence(
            code,
            Reason(reason),
            Action("Correct or remove this bibliography record."),
            False,
        ),
    )


def record(
    *,
    title: str | None,
    authors=(),
    identifier_values=(),
    abstract=None,
    keywords=(),
    tags=(),
    references=(),
    institutions=(),
    year=None,
    month=None,
    venue=None,
    volume=None,
    issue=None,
    pages=None,
    item_type=None,
    language=None,
) -> ImportedBibliographicRecord:
    normalized_title = clean(title)
    if normalized_title is None:
        raise CodecInputError("missing-title", "record has no convertible title")
    return ImportedBibliographicRecord(
        normalized_title,
        ordered(authors),
        identifiers(identifier_values),
        clean(abstract),
        set_values(keywords),
        set_values(tags),
        ordered(references),
        ordered(institutions),
        year,
        month,
        clean(venue),
        clean(volume),
        clean(issue),
        clean(pages),
        clean(item_type),
        clean(language),
    )
