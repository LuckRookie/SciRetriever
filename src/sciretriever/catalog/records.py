"""Immutable, dialect-neutral records returned by the catalog repositories."""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Mapping

from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import (
    AssetIntentState,
    AssetRole,
    DomainRunStatus,
    PackageQuality,
    ProcessingRunState,
    ProcessingStage,
)
from sciretriever.core.ids import validate_uuid
from sciretriever.core.timestamps import parse_rfc3339
from sciretriever.core.validation import (
    validate_media_type,
    validate_sha256,
    validate_storage_path,
    validate_token,
)


def _canonical_json(value: str, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    try:
        decoded = json.loads(value)
        canonical = json.dumps(
            decoded,
            ensure_ascii=True,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field_name} must be canonical JSON") from error
    if canonical != value:
        raise ValueError(f"{field_name} must be canonical JSON")
    return value


def _positive_int(value: int, field_name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{field_name} must be an integer")
    if value <= 0:
        raise ValueError(f"{field_name} must be positive")
    return value


def _timestamp(value: str, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    if len(value) != 24:
        raise ValueError(f"{field_name} must use millisecond RFC3339 UTC form")
    parse_rfc3339(value)
    return value


@dataclass(frozen=True, slots=True)
class WorkRecord:
    id: str
    status: str
    preferred_work_version_id: str | None
    preferred_version_is_manual: bool
    needs_review: bool
    review_reason: str | None
    merged_into_work_id: str | None
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class IdentityReviewRecord:
    id: str
    state: str
    identifiers_json: str
    candidate_work_ids_json: str
    reason: str
    decision: str | None
    created_at: str
    updated_at: str
    resolved_at: str | None


@dataclass(frozen=True, slots=True)
class IdentityResolution:
    decision: str
    identifiers: tuple[Identifier, ...]
    work: WorkRecord | None = None
    work_version: WorkVersionRecord | None = None
    review: IdentityReviewRecord | None = None

    def __post_init__(self) -> None:
        if self.decision not in {"created", "reused", "review_required"}:
            raise ValueError(f"unsupported identity decision: {self.decision!r}")
        if self.decision == "review_required":
            if self.work is not None or self.work_version is not None or self.review is None:
                raise ValueError("review_required requires only a review record")
        elif self.work is None or self.review is not None:
            raise ValueError("created and reused decisions require only a work record")


@dataclass(frozen=True, slots=True)
class WorkVersionRecord:
    id: str
    work_id: str
    version_class: str
    normalized_title: str
    title: str
    abstract: str | None
    language: str | None
    work_type: str | None
    publication_date: str | None
    publication_year: int | None
    publisher_id: str | None
    venue_id: str | None
    volume: str | None
    issue: str | None
    pages: str | None
    article_number: str | None
    open_access_status: str | None
    provider_precedence: int | None
    stable_version_key: str
    is_provisional: bool
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class MetadataObservationRecord:
    id: str
    work_version_id: str
    provider: str
    provider_record_id: str
    field_name: str
    value_json: str
    provenance_json: str
    observed_at: str


@dataclass(frozen=True, slots=True)
class AuthorRecord:
    id: str
    display_name: str
    normalized_name: str
    orcid: str | None
    status: str
    merged_into_author_id: str | None
    created_at: str


@dataclass(frozen=True, slots=True)
class AuthorshipRecord:
    id: str
    work_version_id: str
    author_id: str
    position: int
    role: str | None
    is_corresponding: bool
    affiliation: str | None
    created_at: str


@dataclass(frozen=True, slots=True)
class RegistryRecord:
    id: str
    canonical_name: str
    created_at: str


@dataclass(frozen=True, slots=True)
class TagRecord:
    id: str
    canonical_name: str
    definition: str | None
    created_at: str


@dataclass(frozen=True, slots=True)
class VersionRelationRecord:
    id: str
    source_work_version_id: str
    target_work_version_id: str
    relation_type: str
    evidence_json: str
    created_at: str


@dataclass(frozen=True, slots=True)
class VersionReferenceRecord:
    id: str
    citing_work_version_id: str
    cited_work_id: str | None
    reference_order: int
    raw_reference: str
    cited_namespace: str | None
    cited_value: str | None
    source_artifact_id: str | None
    locator_json: str | None
    created_at: str


@dataclass(frozen=True, slots=True)
class MetadataLabelRecord:
    id: str
    work_version_id: str
    taxonomy: str
    taxonomy_version: str
    input_sha256: str
    label: str
    needs_review: bool
    created_at: str


@dataclass(frozen=True, slots=True)
class RawAssetRecord:
    id: str
    sha256: str
    storage_path: str
    media_type: str
    format: str
    byte_size: int
    provenance_json: str
    created_at: str

    def __post_init__(self) -> None:
        validate_uuid(self.id, "id")
        validate_sha256(self.sha256)
        validate_storage_path(self.storage_path)
        if self.storage_path != f"raw/{self.sha256[:2]}/{self.sha256}":
            raise ValueError("storage_path must be the deterministic content-addressed path")
        validate_media_type(self.media_type)
        validate_token(self.format, "format")
        _positive_int(self.byte_size, "byte_size")
        _canonical_json(self.provenance_json, "provenance_json")
        _timestamp(self.created_at, "created_at")

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> "RawAssetRecord":
        return cls(**{field: row[field] for field in cls.__dataclass_fields__})


@dataclass(frozen=True, slots=True)
class WorkVersionAssetRecord:
    work_version_id: str
    raw_asset_id: str
    asset_role: AssetRole
    linked_at: str

    def __post_init__(self) -> None:
        validate_uuid(self.work_version_id, "work_id")
        validate_uuid(self.raw_asset_id, "raw_asset_id")
        if not isinstance(self.asset_role, AssetRole):
            raise TypeError("asset_role must be an AssetRole")
        _timestamp(self.linked_at, "linked_at")

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> "WorkVersionAssetRecord":
        values = {field: row[field] for field in cls.__dataclass_fields__}
        values["asset_role"] = AssetRole(values["asset_role"])
        return cls(**values)


@dataclass(frozen=True, slots=True)
class AssetIntentRecord:
    id: str
    work_version_id: str
    raw_asset_id: str | None
    asset_role: AssetRole
    state: AssetIntentState
    temporary_path: str
    storage_path: str
    expected_sha256: str
    media_type: str
    format: str
    expected_byte_size: int
    provenance_json: str
    created_at: str
    updated_at: str

    def __post_init__(self) -> None:
        validate_uuid(self.id, "id")
        validate_uuid(self.work_version_id, "work_id")
        if self.raw_asset_id is not None:
            validate_uuid(self.raw_asset_id, "raw_asset_id")
        if not isinstance(self.asset_role, AssetRole):
            raise TypeError("asset_role must be an AssetRole")
        if not isinstance(self.state, AssetIntentState):
            raise TypeError("state must be an AssetIntentState")
        validate_storage_path(self.temporary_path)
        validate_storage_path(self.storage_path)
        validate_sha256(self.expected_sha256, "expected_sha256")
        if self.temporary_path != f"staging/{self.id}.part":
            raise ValueError("temporary_path must be the deterministic staging path")
        if self.storage_path != f"raw/{self.expected_sha256[:2]}/{self.expected_sha256}":
            raise ValueError("storage_path must be the deterministic content-addressed path")
        validate_media_type(self.media_type)
        validate_token(self.format, "format")
        _positive_int(self.expected_byte_size, "expected_byte_size")
        _canonical_json(self.provenance_json, "provenance_json")
        has_asset = self.raw_asset_id is not None
        if has_asset != (self.state in {AssetIntentState.PUBLISHED, AssetIntentState.FINALIZED}):
            raise ValueError("raw_asset_id must match the asset intent state")
        _timestamp(self.created_at, "created_at")
        _timestamp(self.updated_at, "updated_at")

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> "AssetIntentRecord":
        values = {field: row[field] for field in cls.__dataclass_fields__}
        values["asset_role"] = AssetRole(values["asset_role"])
        values["state"] = AssetIntentState(values["state"])
        return cls(**values)


@dataclass(frozen=True, slots=True)
class DomainRunRecord:
    id: str
    package_version_id: str
    status: DomainRunStatus
    output_pointer: str | None
    output_sha256: str | None
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class ProcessingRunRecord:
    id: str
    work_version_id: str
    stage: ProcessingStage
    state: ProcessingRunState
    input_raw_asset_id: str | None
    input_artifact_id: str | None
    output_artifact_id: str | None
    details_json: str | None
    started_at: str
    finished_at: str | None

    @classmethod
    def from_row(cls, row: Mapping[Any, Any]) -> "ProcessingRunRecord":
        values = {field: row[field] for field in cls.__dataclass_fields__}
        values["stage"] = ProcessingStage(values["stage"])
        values["state"] = ProcessingRunState(values["state"])
        return cls(**values)


@dataclass(frozen=True, slots=True)
class ExternalParserAttemptRecord:
    id: str
    processing_run_id: str
    sequence: int
    state: str
    external_task_id: str | None
    metadata_json: str
    started_at: str
    finished_at: str | None

    @classmethod
    def from_row(cls, row: Mapping[Any, Any]) -> "ExternalParserAttemptRecord":
        return cls(**{field: row[field] for field in cls.__dataclass_fields__})


@dataclass(frozen=True, slots=True)
class CurrentAnalysisRecord:
    id: str
    work_version_id: str
    revision: int
    processing_run_id: str
    parser_artifact_id: str
    analysis_artifact_id: str
    content_json: str
    provenance_json: str
    created_at: str
    updated_at: str

    @classmethod
    def from_row(cls, row: Mapping[Any, Any]) -> "CurrentAnalysisRecord":
        return cls(**{field: row[field] for field in cls.__dataclass_fields__})


@dataclass(frozen=True, slots=True)
class NormalizedArtifactRecord:
    id: str
    work_version_id: str
    raw_asset_id: str
    kind: str
    schema_version: str
    storage_path: str
    sha256: str
    media_type: str
    byte_size: int
    provenance_json: str
    created_at: str

    @classmethod
    def from_row(cls, row: Mapping[Any, Any]) -> "NormalizedArtifactRecord":
        return cls(**{field: row[field] for field in cls.__dataclass_fields__})


@dataclass(frozen=True, slots=True)
class ArtifactRegistration:
    id: str
    kind: str
    schema_version: str
    storage_path: str
    sha256: str
    media_type: str
    byte_size: int
    provenance: object


@dataclass(frozen=True, slots=True)
class PackageVersionRecord:
    id: str
    work_version_id: str
    processing_run_id: str | None
    version: int
    schema_version: str
    quality: PackageQuality
    storage_path: str
    sha256: str
    published_at: str

    @classmethod
    def from_row(cls, row: Mapping[Any, Any]) -> "PackageVersionRecord":
        values = {field: row[field] for field in cls.__dataclass_fields__}
        values["quality"] = PackageQuality(values["quality"])
        return cls(**values)


IdentityResolutionResult = IdentityResolution


__all__ = (
    "AuthorRecord",
    "AuthorshipRecord",
    "AssetIntentRecord",
    "DomainRunRecord",
    "CurrentAnalysisRecord",
    "ExternalParserAttemptRecord",
    "IdentityResolution",
    "IdentityResolutionResult",
    "IdentityReviewRecord",
    "MetadataLabelRecord",
    "MetadataObservationRecord",
    "ArtifactRegistration",
    "NormalizedArtifactRecord",
    "PackageVersionRecord",
    "ProcessingRunRecord",
    "RawAssetRecord",
    "RegistryRecord",
    "TagRecord",
    "VersionRelationRecord",
    "VersionReferenceRecord",
    "WorkRecord",
    "WorkVersionRecord",
    "WorkVersionAssetRecord",
)
