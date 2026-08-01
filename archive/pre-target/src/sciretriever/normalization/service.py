"""Persistent replayable normalization processing service."""

from __future__ import annotations

from dataclasses import dataclass
import json
from collections.abc import Callable

from sciretriever.catalog import (
    ArtifactRegistration,
    ArtifactRepository,
    NormalizedArtifactRecord,
    PackageSourceRepository,
    ProcessingRunRecord,
    ProcessingRunRepository,
)
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.core.derivation import canonical_json_bytes
from sciretriever.core.package import EvidenceLocator, NormalizedContent, SOURCE_MAP_MEDIA_TYPE
from sciretriever.errors import NormalizationError
from sciretriever.storage import DerivedArtifactStore, RawAssetStore

from .contracts import NormalizationParameters, RawNormalizationInput, SourceUnit
from .normalizer import NORMALIZER_VERSION, normalize_inputs


NORMALIZED_CONTENT_MEDIA_TYPE = "application/vnd.sciretriever.normalized-content.v1+json"


@dataclass(frozen=True, slots=True)
class NormalizationResult:
    run: ProcessingRunRecord
    content: NormalizedContent
    evidence: tuple[EvidenceLocator, ...]
    source_units: tuple[SourceUnit, ...]
    content_artifact: NormalizedArtifactRecord
    source_map_artifact: NormalizedArtifactRecord


class NormalizationService:
    def __init__(
        self,
        catalog: CatalogEngine,
        raw_store: RawAssetStore,
        derived_store: DerivedArtifactStore,
        parameters: NormalizationParameters | None = None,
    ) -> None:
        if not isinstance(raw_store, RawAssetStore):
            raise TypeError("raw_store must be a RawAssetStore")
        if not isinstance(derived_store, DerivedArtifactStore):
            raise TypeError("derived_store must be a DerivedArtifactStore")
        self.sources = PackageSourceRepository(catalog)
        self.runs = ProcessingRunRepository(catalog)
        self.artifacts = ArtifactRepository(catalog)
        self.raw_store = raw_store
        self.derived_store = derived_store
        self.parameters = parameters or NormalizationParameters()

    def _load_result(self, run: ProcessingRunRecord) -> NormalizationResult:
        details = json.loads(run.details_json or "{}")
        output_ids = tuple(details.get("output_artifact_ids", ()))
        records = tuple(self.artifacts.get(artifact_id) for artifact_id in output_ids)
        if any(record is None for record in records):
            raise NormalizationError("successful normalization run has missing artifacts")
        typed = tuple(record for record in records if record is not None)
        by_kind = {record.kind: record for record in typed}
        try:
            content_record = by_kind["normalized_content"]
            source_record = by_kind["source_map"]
        except KeyError as error:
            raise NormalizationError("successful normalization run has incomplete outputs") from error
        content_publication = self.derived_store.find_published(content_record.kind, content_record.id)
        source_publication = self.derived_store.find_published(source_record.kind, source_record.id)
        if content_publication is None or source_publication is None:
            raise NormalizationError("normalization artifact storage is missing")
        if (content_publication.sha256, content_publication.byte_size) != (content_record.sha256, content_record.byte_size):
            raise NormalizationError("normalized content catalog metadata conflicts with storage")
        if (source_publication.sha256, source_publication.byte_size) != (source_record.sha256, source_record.byte_size):
            raise NormalizationError("source map catalog metadata conflicts with storage")
        content = NormalizedContent.from_dict(json.loads(self.derived_store.read_verified(content_publication)))
        source_map = json.loads(self.derived_store.read_verified(source_publication))
        evidence = tuple(EvidenceLocator.from_dict(value) for value in source_map["evidence"])
        units = tuple(SourceUnit(**value) for value in source_map["source_units"])
        return NormalizationResult(run, content, evidence, units, content_record, source_record)

    def run(
        self,
        work_version_id: str,
        checkpoint: Callable[[str], None] | None = None,
    ) -> NormalizationResult:
        files = self.sources.list_files(work_version_id)
        if not files:
            raise NormalizationError("work has no raw assets")
        identities = [(link.raw_asset_id, link.asset_role) for link, _ in files]
        if len(identities) != len(set(identities)):
            raise NormalizationError("work contains duplicate raw asset roles")
        inputs = tuple(
            RawNormalizationInput(
                raw.id,
                link.asset_role,
                raw.media_type,
                raw.sha256,
                self.raw_store.read_verified(
                    raw.storage_path, raw.sha256, raw.byte_size, self.parameters.max_input_bytes
                ),
            )
            for link, raw in files
        )
        run = self.runs.claim_or_resume(
            work_version_id,
            "normalization",
            "sciretriever.normalizer",
            NORMALIZER_VERSION,
            self.parameters.to_dict(),
            input_raw_asset_ids=tuple(item.file_id for item in inputs),
        )
        with self.derived_store.run_lock(run.id):
            current = self.runs.get(run.id)
            if current is None:
                raise NormalizationError("claimed normalization run is missing")
            if current.state.value == "succeeded":
                return self._load_result(current)
            if current.state.value == "failed":
                current = self.runs.claim_or_resume(
                    work_version_id,
                    "normalization",
                    "sciretriever.normalizer",
                    NORMALIZER_VERSION,
                    self.parameters.to_dict(),
                    input_raw_asset_ids=tuple(item.file_id for item in inputs),
                )
            try:
                draft = normalize_inputs(inputs, self.parameters, work_version_id=work_version_id)
                content_payload = canonical_json_bytes(draft.content.to_dict())
                source_payload = canonical_json_bytes(draft.source_map_dict())
                content_publication = self.derived_store.publish_bytes(
                    "normalized_content", draft.content.artifact_id, content_payload, checkpoint=checkpoint
                )
                source_publication = self.derived_store.publish_bytes(
                    "source_map", draft.source_map_artifact_id, source_payload, checkpoint=checkpoint
                )
                anchor = inputs[0].file_id
                provenance = {
                    "normalizer": "sciretriever.normalizer",
                    "normalizer_version": NORMALIZER_VERSION,
                    "processing_run_id": current.id,
                    "parameters": self.parameters.to_dict(),
                    "input_file_ids": [item.file_id for item in inputs],
                }
                registered = self.artifacts.register_pair_after_publication(
                    work_version_id,
                    anchor,
                    (
                        ArtifactRegistration(
                            draft.content.artifact_id, "normalized_content", "1",
                            content_publication.storage_path, content_publication.sha256,
                            NORMALIZED_CONTENT_MEDIA_TYPE, content_publication.byte_size, provenance,
                        ),
                        ArtifactRegistration(
                            draft.source_map_artifact_id, "source_map", "1",
                            source_publication.storage_path, source_publication.sha256,
                            SOURCE_MAP_MEDIA_TYPE, source_publication.byte_size, provenance,
                        ),
                    ),
                )
                succeeded = self.runs.succeed(current.id, output_artifact_ids=tuple(item.id for item in registered))
                by_kind = {item.kind: item for item in registered}
                return NormalizationResult(
                    succeeded, draft.content, draft.evidence, draft.source_units,
                    by_kind["normalized_content"], by_kind["source_map"],
                )
            except Exception as error:
                latest = self.runs.get(current.id)
                if latest is not None and latest.state.value == "active":
                    self.runs.fail(current.id, "normalization_failed", str(error))
                raise


__all__ = ("NORMALIZED_CONTENT_MEDIA_TYPE", "NormalizationResult", "NormalizationService")
