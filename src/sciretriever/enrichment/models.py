"""Generic enrichment contracts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from sciretriever.catalog.records import CitationRecord, NormalizedArtifactRecord, ProcessingRunRecord
from sciretriever.core.package import LightStructure


class Summarizer(Protocol):
    name: str
    version: str

    def summarize(self, text: str, max_characters: int) -> str:
        ...


@dataclass(frozen=True, slots=True)
class EnrichmentResult:
    run: ProcessingRunRecord
    light_structure: LightStructure
    artifact: NormalizedArtifactRecord | None
    citations: tuple[CitationRecord, ...]


__all__ = ("EnrichmentResult", "Summarizer")
