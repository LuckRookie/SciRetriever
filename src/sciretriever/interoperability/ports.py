from __future__ import annotations

from typing import Protocol

from sciretriever.model.execution import ImportRecordProjection, ImportResult
from sciretriever.model.primitives import BibliographyFormat
from sciretriever.model.record import (
    ExportEncodingResult,
    ImportedBibliographicRecord,
    RecordParseResult,
)


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
    "BibliographyCodec",
    "BinaryInput",
    "BinaryOutput",
    "ImportRecordProjection",
    "ImportResult",
)
