"""Deterministic generic summaries, tags, and citation links."""

from __future__ import annotations

import json
import unicodedata
from typing import Protocol

from sciretriever.catalog import (
    ArtifactRegistration,
    ArtifactRepository,
    CitationRepository,
    EnrichmentRepository,
)
from sciretriever.catalog.processing import ProcessingRunRepository
from sciretriever.catalog.records import NormalizedArtifactRecord, ProcessingRunRecord
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.core.derivation import canonical_json_bytes, canonical_sha256, stable_derivation_id
from sciretriever.core.package import LightStructure, NormalizedContent
from sciretriever.errors import NormalizationError
from sciretriever.storage import DerivedArtifactStore

from .models import EnrichmentResult, Summarizer


ENRICHER_VERSION = "1"
LIGHT_STRUCTURE_MEDIA_TYPE = "application/vnd.sciretriever.light-structure.v1+json"


class NormalizationResultLike(Protocol):
    @property
    def content(self) -> NormalizedContent:
        ...

    @property
    def content_artifact(self) -> NormalizedArtifactRecord:
        ...


def _blocks(content: NormalizedContent) -> tuple[str, ...]:
    values: list[str] = []
    for section in content.sections:
        if section.title:
            values.append(section.title)
        if section.text:
            values.append(section.text)
    for table in content.tables:
        if table.caption:
            values.append(table.caption)
        values.extend(cell.text for cell in table.cells if cell.text)
        if table.notes:
            values.append(table.notes)
    values.extend(reference.text for reference in content.references)
    return tuple(values)


def build_summary_input(content: NormalizedContent) -> str:
    seen = set()
    result = []
    for block in _blocks(content):
        cleaned = " ".join(block.split())
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            result.append(cleaned)
    return "\n\n".join(result)


def deterministic_summary(content: NormalizedContent, max_characters: int) -> str | None:
    if not isinstance(max_characters, int) or isinstance(max_characters, bool) or max_characters <= 0:
        raise ValueError("max_characters must be positive")
    text = build_summary_input(content)
    if not text:
        return None
    if len(text) <= max_characters:
        return text
    candidate = text[: max_characters + 1]
    boundary = candidate.rfind(" ", 0, max_characters + 1)
    return candidate[: boundary if boundary > 0 else max_characters].rstrip()


def normalize_tags(values: tuple[str, ...], *, max_count: int = 32) -> tuple[str, ...]:
    normalized = set()
    for value in values:
        tag = unicodedata.normalize("NFC", value).casefold()
        tag = " ".join(tag.split()).strip(" \t\r\n.,;:!?()[]{}\"'")
        if tag:
            normalized.add(tag[:64].rstrip())
    return tuple(sorted(normalized))[:max_count]


class GenericEnricher:
    def __init__(self, catalog: CatalogEngine, derived_store: DerivedArtifactStore, *, summary_max_characters: int = 1_000, summary_input_max_characters: int = 100_000) -> None:
        if summary_max_characters <= 0 or summary_input_max_characters <= 0:
            raise ValueError("summary bounds must be positive")
        self.runs = ProcessingRunRepository(catalog)
        self.artifacts = ArtifactRepository(catalog)
        self.enrichment = EnrichmentRepository(catalog)
        self.citation_repository = CitationRepository(catalog)
        self.derived_store = derived_store
        self.summary_max_characters = summary_max_characters
        self.summary_input_max_characters = summary_input_max_characters

    def _load(self, run: ProcessingRunRecord) -> EnrichmentResult:
        details = json.loads(run.details_json or "{}")
        outputs = tuple(details.get("output_artifact_ids", ()))
        if not outputs:
            return EnrichmentResult(run, LightStructure(), None, ())
        artifact = self.artifacts.get(outputs[0])
        if artifact is None:
            raise NormalizationError("enrichment artifact is missing")
        publication = self.derived_store.find_published("light_structure", artifact.id)
        if publication is None or (publication.sha256, publication.byte_size) != (artifact.sha256, artifact.byte_size):
            raise NormalizationError("enrichment artifact storage conflicts with catalog")
        light = LightStructure.from_dict(json.loads(self.derived_store.read_verified(publication)))
        return EnrichmentResult(run, light, artifact, ())

    def enrich(
        self,
        work_version_id: str,
        normalized_result: NormalizationResultLike,
        summarizer: Summarizer | None = None,
    ) -> EnrichmentResult:
        summarizer_name = "deterministic_fallback" if summarizer is None else summarizer.name
        summarizer_version = ENRICHER_VERSION if summarizer is None else summarizer.version
        parameters = {
            "summary_max_characters": self.summary_max_characters,
            "summary_input_max_characters": self.summary_input_max_characters,
            "summarizer": summarizer_name,
            "summarizer_version": summarizer_version,
        }
        run = self.runs.claim_or_resume(
            work_version_id, "enrichment", "sciretriever.generic_enricher", ENRICHER_VERSION,
            parameters, input_artifact_ids=(normalized_result.content_artifact.id,),
        )
        with self.derived_store.run_lock(run.id):
            current = self.runs.get(run.id)
            if current is None:
                raise NormalizationError("claimed enrichment run is missing")
            if current.state.value == "succeeded":
                return self._load(current)
            if current.state.value == "failed":
                current = self.runs.claim_or_resume(
                    work_version_id, "enrichment", "sciretriever.generic_enricher", ENRICHER_VERSION,
                    parameters, input_artifact_ids=(normalized_result.content_artifact.id,),
                )
            summary_input = build_summary_input(normalized_result.content)[: self.summary_input_max_characters]
            summary = None
            if summarizer is not None and summary_input:
                try:
                    candidate = summarizer.summarize(summary_input, self.summary_max_characters)
                    if not isinstance(candidate, str) or not candidate.strip():
                        raise ValueError("summarizer returned blank or invalid output")
                    summary = " ".join(candidate.split())[: self.summary_max_characters].rstrip()
                except Exception as error:
                    self.runs.record_nonblocking_failure(current.id, "summarizer_failed", str(error))
            if summary is None:
                summary = deterministic_summary(normalized_result.content, self.summary_max_characters)
            tags = normalize_tags(tuple(section.title for section in normalized_result.content.sections if section.title))
            identifiers = tuple(identifier for reference in normalized_result.content.references for identifier in reference.identifiers)
            citations = self.citation_repository.register_identifier_links(work_version_id, normalized_result.content_artifact.id, identifiers)
            cited_ids = tuple(sorted({item.cited_work_id for item in citations if item.cited_work_id is not None}))
            if summary is None and not tags and not cited_ids:
                succeeded = self.runs.succeed(current.id)
                return EnrichmentResult(succeeded, LightStructure(), None, citations)
            artifact_id = stable_derivation_id("light_structure_artifact", {"run_id": current.id, "summary": summary, "tags": tags, "citations": cited_ids})
            light = LightStructure(summary, tags, cited_ids, artifact_id)
            payload = canonical_json_bytes(light.to_dict())
            publication = self.derived_store.publish_bytes("light_structure", artifact_id, payload)
            record = self.artifacts.register_pair_after_publication(
                work_version_id, normalized_result.content_artifact.raw_asset_id,
                (ArtifactRegistration(artifact_id, "light_structure", "1", publication.storage_path, publication.sha256, LIGHT_STRUCTURE_MEDIA_TYPE, publication.byte_size, {"processing_run_id": current.id, "input_artifact_id": normalized_result.content_artifact.id}),),
            )[0]
            input_sha = canonical_sha256(normalized_result.content.to_dict())
            if summary is not None:
                self.enrichment.register_result(work_version_id, normalized_result.content_artifact.id, "summary", "1", input_sha, {"summary": summary})
            if tags:
                self.enrichment.register_result(work_version_id, normalized_result.content_artifact.id, "tags", "1", input_sha, {"tags": list(tags)})
            succeeded = self.runs.succeed(current.id, output_artifact_ids=(record.id,))
            return EnrichmentResult(succeeded, light, record, citations)


__all__ = (
    "ENRICHER_VERSION",
    "GenericEnricher",
    "LIGHT_STRUCTURE_MEDIA_TYPE",
    "build_summary_input",
    "deterministic_summary",
    "normalize_tags",
)
