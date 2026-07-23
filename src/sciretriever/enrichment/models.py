"""Generic enrichment contracts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from sciretriever.catalog.records import NormalizedArtifactRecord, ProcessingRunRecord, VersionReferenceRecord
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
    citations: tuple[VersionReferenceRecord, ...]


__all__ = ("EnrichmentResult", "Summarizer")
