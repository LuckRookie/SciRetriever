"""Validated immutable DocumentPackageVersion publication."""

from __future__ import annotations

from dataclasses import dataclass
import json
from urllib.parse import quote

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.packages import PackageSourceRepository, PackageVersionRepository
from sciretriever.catalog.processing import ProcessingRunRepository
from sciretriever.catalog.records import (
    AssetIntentRecord,
    PackageVersionRecord,
    ProcessingRunRecord,
    RawAssetRecord,
    NormalizedArtifactRecord,
    WorkVersionAssetRecord,
)
from sciretriever.catalog.repository import canonical_json
from sciretriever.core.derivation import canonical_sha256, stable_derivation_id
from sciretriever.core.enums import ProcessingRunState, ProcessingStage
from sciretriever.core.package import (
    ArtifactRecord,
    DocumentPackageVersion,
    FileRecord,
    CurrentAnalysisSnapshot,
    Lineage,
    SourceProvenance,
)
from sciretriever.errors import PackagingError, StorageError
from sciretriever.storage import DerivedArtifactStore
from sciretriever.core.timestamps import utc_now_rfc3339

from .quality import QualityGate
from ..normalization.contracts import NormalizationDraft
from ..normalization.service import NormalizationResult


PUBLISHER_VERSION = "1"


@dataclass(frozen=True, slots=True)
class PackagePublicationResult:
    package: DocumentPackageVersion
    record: PackageVersionRecord
    created: bool


def _lineage(run: ProcessingRunRecord, *, output_file_ids: tuple[str, ...] = (), output_artifact_ids: tuple[str, ...] | None = None) -> Lineage:
    details = json.loads(run.details_json or "{}")
    outputs = tuple(details.get("output_artifact_ids", ())) if output_artifact_ids is None else output_artifact_ids
    return Lineage(
        stable_derivation_id("lineage", {"run_id": run.id, "stage": run.stage.value}),
        run.id, run.stage, details.get("producer", "sciretriever"),
        details.get("producer_version", "1"), run.started_at, run.finished_at or run.started_at,
        tuple(details.get("input_raw_asset_ids", ())), tuple(details.get("input_artifact_ids", ())),
        output_file_ids, outputs, details.get("parameters_sha256", canonical_sha256({})),
    )


def _material(package: DocumentPackageVersion) -> dict[str, object]:
    value = package.to_dict()
    value.pop("package_version")
    value.pop("package_sha256")
    value.pop("published_at")
    value["lineage"] = [item for item in value["lineage"] if item["stage"] != "publication"]
    return value


class PackagePublisher:
    def __init__(self, catalog: CatalogEngine, derived_store: DerivedArtifactStore) -> None:
        self.sources = PackageSourceRepository(catalog)
        self.versions = PackageVersionRepository(catalog)
        self.runs = ProcessingRunRepository(catalog)
        self.derived_store = derived_store
        self.quality = QualityGate()

    def load_verified(self, record: PackageVersionRecord) -> DocumentPackageVersion:
        owner_id = record.storage_path.rsplit("/", 1)[-1]
        publication = self.derived_store.find_published("document_package", owner_id)
        if publication is None or publication.storage_path != record.storage_path:
            raise PackagingError("package storage is missing or mismatched")
        payload = self.derived_store.read_verified(publication).decode("utf-8")
        package = DocumentPackageVersion.from_json(payload)
        if package.document_id != record.work_version_id or package.package_version != record.version:
            raise PackagingError("package identity conflicts with catalog")
        if package.package_sha256 != record.sha256 or package.quality is not record.quality:
            raise PackagingError("package metadata conflicts with catalog")
        return package

    def load_by_document_hash(
        self,
        document_id: str,
        package_sha256: str,
    ) -> DocumentPackageVersion:
        record = self.versions.get_by_document_hash(document_id, package_sha256)
        if record is None:
            raise PackagingError("document package does not exist for the supplied document ID and hash")
        return self.load_verified(record)

    def _verify_artifacts(
        self, artifacts: tuple[NormalizedArtifactRecord, ...]
    ) -> None:
        for artifact in artifacts:
            try:
                publication = self.derived_store.find_published(
                    artifact.kind, artifact.id
                )
                if publication is not None:
                    self.derived_store.read_verified(publication)
            except StorageError as error:
                raise PackagingError(
                    "package artifact storage failed integrity validation"
                ) from error
            if publication is None or (
                publication.storage_path,
                publication.sha256,
                publication.byte_size,
            ) != (artifact.storage_path, artifact.sha256, artifact.byte_size):
                raise PackagingError("package artifact storage is missing or mismatched")

    def _files_and_provenance(
        self, work_version_id: str
    ) -> tuple[
        tuple[FileRecord, ...],
        tuple[SourceProvenance, ...],
        tuple[tuple[WorkVersionAssetRecord, RawAssetRecord, AssetIntentRecord | None], ...],
    ]:
        source_rows = self.sources.list_files_with_intent(work_version_id)
        files = []
        provenance = []
        for link, raw, intent in source_rows:
            files.append(FileRecord(raw.id, link.asset_role, raw.media_type, raw.storage_path, raw.sha256, raw.byte_size))
            data = json.loads(raw.provenance_json if intent is None else intent.provenance_json)
            acquisition_method = str(data.get("acquisition_method") or data.get("method") or "acquire")
            provider = str(
                data.get("provider")
                or (
                    "existing-asset-import"
                    if acquisition_method == "existing-asset-import"
                    else "catalog"
                )
            )
            source_uri = data.get("source_uri") or data.get("source_url")
            if source_uri is None and data.get("source_id") is not None:
                source_uri = f"urn:sciretriever:source:{quote(str(data['source_id']), safe='')}"
            timestamp_source = raw if intent is None else intent
            provenance_identity = {"file_id": raw.id, "sha256": raw.sha256}
            if intent is not None:
                provenance_identity["intent_id"] = intent.id
            provenance.append(SourceProvenance(
                stable_derivation_id("source_provenance", provenance_identity),
                raw.id, provider, acquisition_method,
                str(data.get("agent", "sciretriever")), str(data.get("started_at", timestamp_source.created_at)),
                str(data.get("completed_at", getattr(timestamp_source, "updated_at", timestamp_source.created_at))),
                source_uri,
            ))
        return tuple(files), tuple(provenance), source_rows

    def publish(
        self,
        work_version_id: str,
        raw_acceptance_run: ProcessingRunRecord,
        normalized: NormalizationResult,
    ) -> PackagePublicationResult:
        lock_id = stable_derivation_id("package_publication_lock", {"work_id": work_version_id})
        with self.derived_store.run_lock(lock_id):
            return self._publish_locked(work_version_id, raw_acceptance_run, normalized)

    def _publish_locked(
        self,
        work_version_id: str,
        raw_acceptance_run: ProcessingRunRecord,
        normalized: NormalizationResult,
    ) -> PackagePublicationResult:
        files, provenance, source_rows = self._files_and_provenance(work_version_id)
        draft = NormalizationDraft(normalized.content, normalized.evidence, normalized.source_units, normalized.source_map_artifact.id)
        decision = self.quality.validate(tuple(link.asset_role for link, _, _ in source_rows), draft)
        artifacts = [normalized.content_artifact, normalized.source_map_artifact]
        current = self.sources.current_analysis_snapshot(work_version_id)
        if current is not None:
            artifacts.extend(current[1])
        self._verify_artifacts(tuple(artifacts))
        artifact_contracts = tuple(ArtifactRecord(item.id, item.kind, item.media_type, item.storage_path, item.sha256, item.byte_size) for item in artifacts)
        artifact_ids = tuple(item.id for item in artifacts)
        validation = self.runs.claim_or_resume(
            work_version_id, "package_validation", "sciretriever.package_validator", PUBLISHER_VERSION,
            {"schema_version": "1", "quality": decision.quality.value}, input_artifact_ids=artifact_ids,
            input_artifact_anchor_id=normalized.source_map_artifact.id,
        )
        if validation.state.value != "succeeded":
            validation = self.runs.succeed(validation.id)
        nonpublication_lineage = [
            _lineage(raw_acceptance_run, output_file_ids=tuple(item.file_id for item in files)),
            _lineage(normalized.run),
        ]
        snapshot = None
        if current is not None:
            snapshot, _, analysis_runs = current
            nonpublication_lineage.extend(_lineage(run) for run in analysis_runs)
        nonpublication_lineage.append(_lineage(validation, output_artifact_ids=()))
        provisional_time = utc_now_rfc3339()
        provisional_parameters = {
            "candidate": canonical_sha256({"artifacts": artifact_ids, "quality": decision.quality.value})
        }
        provisional_run = ProcessingRunRecord(
            stable_derivation_id("processing_run", {"provisional_package": work_version_id}),
            work_version_id,
            ProcessingStage.PUBLICATION,
            ProcessingRunState.ACTIVE,
            None,
            artifact_ids[0] if artifact_ids else None,
            None,
            canonical_json({
                "producer": "sciretriever.package_publisher",
                "producer_version": PUBLISHER_VERSION,
                "parameters_sha256": canonical_sha256(provisional_parameters),
                "input_raw_asset_ids": [],
                "input_artifact_ids": list(artifact_ids),
                "output_artifact_ids": [],
            }),
            provisional_time,
            None,
        )
        provisional_package = DocumentPackageVersion.create(
            document_id=work_version_id, package_version=1, published_at=provisional_run.started_at,
            quality=decision.quality, limitations=decision.limitations,
            identifiers=self.sources.list_identifiers(work_version_id), source_provenance=provenance, files=files,
            normalized_content=normalized.content, evidence=normalized.evidence, current_analysis=snapshot,
            artifacts=artifact_contracts, lineage=tuple(nonpublication_lineage + [_lineage(provisional_run, output_artifact_ids=())]),
        )
        material_hash = canonical_sha256(_material(provisional_package))
        latest = self.versions.latest(work_version_id)
        if latest is not None:
            existing = self.load_verified(latest)
            if canonical_sha256(_material(existing)) == material_hash:
                return PackagePublicationResult(existing, latest, False)
        version = 1 if latest is None else latest.version + 1
        publication_run = self.runs.claim_or_resume(
            work_version_id, "publication", "sciretriever.package_publisher", PUBLISHER_VERSION,
            {"material_sha256": material_hash, "version": version}, input_artifact_ids=artifact_ids,
            input_artifact_anchor_id=normalized.source_map_artifact.id,
        )
        package = DocumentPackageVersion.create(
            document_id=work_version_id, package_version=version, published_at=publication_run.started_at,
            quality=decision.quality, limitations=decision.limitations,
            identifiers=self.sources.list_identifiers(work_version_id), source_provenance=provenance, files=files,
            normalized_content=normalized.content, evidence=normalized.evidence, current_analysis=snapshot,
            artifacts=artifact_contracts, lineage=tuple(nonpublication_lineage + [_lineage(publication_run, output_artifact_ids=())]),
        )
        package = DocumentPackageVersion.from_json(package.to_json())
        package_id = stable_derivation_id("package_version", {"work_id": work_version_id, "version": version, "sha256": package.package_sha256})
        publication = self.derived_store.publish_bytes("document_package", package_id, package.to_json().encode("utf-8"))
        record = self.versions.register_published(
            work_version_id, publication_run.id, version, package.schema_version, package.quality,
            publication.storage_path, package.package_sha256, package.published_at,
        )
        return PackagePublicationResult(package, record, True)


__all__ = ("PackagePublicationResult", "PackagePublisher")
