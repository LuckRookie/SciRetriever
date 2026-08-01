from __future__ import annotations

from typing import Protocol

from sciretriever.interoperability.model import (
    ExportEncodingResult, ImportedBibliographicRecord, RecordParseResult,
)
from sciretriever.kernel.enums import BibliographyFormat
from sciretriever.interoperability.publisher_contracts import ImportRecordProjection, ImportResult


class BinaryInput(Protocol):
    def read(self, size: int) -> bytes: ...


class BinaryOutput(Protocol):
    def write(self, value: bytes) -> int: ...


class BibliographyCodec(Protocol):
    format: BibliographyFormat

    def read(self, stream: BinaryInput) -> tuple[RecordParseResult, ...]: ...

    def write(
        self, records: tuple[ImportedBibliographicRecord, ...], stream: BinaryOutput
    ) -> ExportEncodingResult: ...


__all__ = (
    "BibliographyCodec", "BinaryInput", "BinaryOutput", "ImportRecordProjection",
    "ImportResult",
)
