from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SkipValidation

from sciretriever.model.analysis import AnalysisProposalV1, UnifiedMetadataValues
from sciretriever.model.canonical_json import CanonicalJsonObject
from sciretriever.model.documents import LightDocumentV1, ReferenceView
from sciretriever.model.primitives import (
    AssetId,
    AssetRole,
    ObservationId,
    RelativeArtifactPath,
    Sha256,
    UtcTimestamp,
    VersionRole,
    WorkId,
    WorkVersionId,
    WorkVersionState,
)
from sciretriever.model.sources import Provenance


class _LibraryViewModel(BaseModel):
    model_config = ConfigDict(
        arbitrary_types_allowed=True,
        extra="forbid",
        frozen=True,
        strict=True,
    )


class MetadataView(_LibraryViewModel):
    revision: int = Field(ge=0)
    sha256: Sha256
    values: UnifiedMetadataValues
    provenance: tuple[Provenance, ...]


class AssetView(_LibraryViewModel):
    asset_id: AssetId
    role: AssetRole
    sha256: Sha256
    media_type: str = Field(min_length=1)
    byte_size: int = Field(ge=0)
    storage_path: RelativeArtifactPath
    provenance: tuple[Provenance, ...]


class LightDocumentView(_LibraryViewModel):
    artifact_id: AssetId
    sha256: Sha256
    document: LightDocumentV1
    provenance: tuple[Provenance, ...]


class AnalysisView(_LibraryViewModel):
    artifact_id: AssetId
    sha256: Sha256
    provider: str = Field(min_length=1)
    model: str = Field(min_length=1)
    input_sha256: Sha256
    proposal: AnalysisProposalV1
    provenance: tuple[Provenance, ...]


class ObservationView(_LibraryViewModel):
    observation_id: ObservationId
    provider: str = Field(min_length=1)
    field_name: str = Field(min_length=1)
    value: SkipValidation[CanonicalJsonObject]
    observed_at: UtcTimestamp
    provenance: Provenance


class ExtensionResultView(_LibraryViewModel):
    namespace: str = Field(min_length=1)
    schema_version: str = Field(min_length=1)
    artifact_id: AssetId | None
    sha256: Sha256 | None
    value: SkipValidation[CanonicalJsonObject]


class ReferenceSetView(_LibraryViewModel):
    complete: bool
    items: tuple[ReferenceView, ...]


class TagView(_LibraryViewModel):
    name: str = Field(min_length=1)
    evidence: SkipValidation[CanonicalJsonObject]


class TagSetView(_LibraryViewModel):
    complete: bool
    items: tuple[TagView, ...]


class WorkVersionSummary(_LibraryViewModel):
    kind: Literal["work-version"]
    work_id: WorkId
    work_version_id: WorkVersionId
    version_role: VersionRole
    title: str = Field(min_length=1)
    state: WorkVersionState
    is_preferred: bool


class WorkSummary(_LibraryViewModel):
    kind: Literal["work"]
    work_id: WorkId
    work_version_id: WorkVersionId
    preferred_work_version_id: WorkVersionId
    title: str = Field(min_length=1)
    state: WorkVersionState


LibrarySummary = WorkSummary | WorkVersionSummary


__all__ = (
    "AnalysisView",
    "AssetView",
    "ExtensionResultView",
    "LibrarySummary",
    "LightDocumentView",
    "MetadataView",
    "ObservationView",
    "ReferenceSetView",
    "TagSetView",
    "TagView",
    "WorkSummary",
    "WorkVersionSummary",
)
