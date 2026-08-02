from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from sciretriever.kernel import CanonicalJsonValue
from sciretriever.model.documents import SourceLocator
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import AssetRole, WorkVersionState
from sciretriever.model.sources import Provenance


@dataclass(frozen=True, slots=True)
class MetadataView:
    revision: int
    sha256: str
    values: UnifiedMetadataValues
    provenance: tuple[Provenance, ...]


@dataclass(frozen=True, slots=True)
class AssetView:
    asset_id: str
    role: AssetRole
    sha256: str
    media_type: str
    byte_size: int
    storage_path: str
    provenance: tuple[Provenance, ...]


@dataclass(frozen=True, slots=True)
class LightDocumentView:
    artifact_id: str
    sha256: str
    document: CanonicalJsonValue
    provenance: tuple[Provenance, ...]


@dataclass(frozen=True, slots=True)
class AnalysisView:
    artifact_id: str
    sha256: str
    provider: str
    model: str
    input_sha256: str
    proposal: CanonicalJsonValue
    provenance: tuple[Provenance, ...]


@dataclass(frozen=True, slots=True)
class CurrentFailure:
    stage: str
    code: str
    reason: str
    action: str
    retryable: bool
    updated_at: str


@dataclass(frozen=True, slots=True)
class ObservationView:
    observation_id: str
    provider: str
    field_name: str
    value: CanonicalJsonValue
    observed_at: str
    provenance: Provenance


@dataclass(frozen=True, slots=True)
class ExtensionResultView:
    namespace: str
    schema_version: str
    artifact_id: str | None
    sha256: str | None
    value: CanonicalJsonValue


@dataclass(frozen=True, slots=True)
class ReferenceSetView:
    complete: bool
    items: tuple[ReferenceView, ...]


@dataclass(frozen=True, slots=True)
class TagView:
    name: str
    evidence: CanonicalJsonValue


@dataclass(frozen=True, slots=True)
class TagSetView:
    complete: bool
    items: tuple[TagView, ...]


@dataclass(frozen=True, slots=True)
class WorkVersionSummary:
    kind: Literal["work-version"]
    work_id: str
    work_version_id: str
    version_role: str
    title: str
    state: WorkVersionState
    is_preferred: bool


@dataclass(frozen=True, slots=True)
class WorkSummary:
    kind: Literal["work"]
    work_id: str
    work_version_id: str
    preferred_work_version_id: str
    title: str
    state: WorkVersionState


LibrarySummary = WorkSummary | WorkVersionSummary


__all__ = (
    "AnalysisView",
    "AssetView",
    "AuthorView",
    "CurrentFailure",
    "ExtensionResultView",
    "LibrarySummary",
    "LightDocumentView",
    "MetadataView",
    "ObservationView",
    "ReferenceSetView",
    "ReferenceView",
    "TagSetView",
    "TagView",
    "UnifiedMetadataValues",
    "WorkSummary",
    "WorkVersionSummary",
)


@dataclass(frozen=True, slots=True)
class AuthorView:
    display_name: str
    family_name: str | None
    given_name: str | None
    orcid: str | None
    affiliations: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class UnifiedMetadataValues:
    title: str
    authors: tuple[AuthorView, ...]
    abstract: str | None
    publication_date: str | None
    publication_year: int | None
    document_type: str | None
    language: str | None
    venue: str | None
    publisher: str | None
    volume: str | None
    issue: str | None
    pages: str | None
    article_number: str | None
    open_access_status: str | None
    identifiers: tuple[Identifier, ...]


@dataclass(frozen=True, slots=True)
class ReferenceView:
    reference_id: str
    raw_text: str
    title: str | None
    authors: tuple[AuthorView, ...]
    publication_year: int | None
    source: str | None
    identifiers: tuple[Identifier, ...]
    resolved_work_id: str | None
    resolved_work_version_id: str | None
    evidence: tuple[SourceLocator, ...]
