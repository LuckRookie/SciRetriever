from __future__ import annotations

from dataclasses import dataclass
from enum import Enum, unique

from sciretriever.content.analysis import AnalysisProposalV1
from sciretriever.kernel.contracts import EvidenceText, Identifier
from sciretriever.kernel.enums import AssetRole
from sciretriever.kernel.errors import BoundaryError
from sciretriever.kernel.hashes import Sha256
from sciretriever.kernel.ids import (
    AssetId,
    LightDocumentId,
    MetadataSnapshotId,
    WorkVersionId,
)
from sciretriever.kernel.paths import RelativeArtifactPath


@dataclass(frozen=True, slots=True)
class UnifiedMetadataSnapshot:
    snapshot_id: MetadataSnapshotId
    revision: int
    title: str
    authors: tuple[str, ...]
    identifiers: tuple[Identifier, ...]
    abstract: str | None = None
    publication_date: str | None = None
    publication_year: int | None = None
    publisher: str | None = None
    venue: str | None = None
    volume: str | None = None
    issue: str | None = None
    pages: str | None = None
    article_number: str | None = None
    work_type: str | None = None
    language: str | None = None
    keywords: tuple[str, ...] = ()
    sha256: Sha256 | None = None

    def __post_init__(self) -> None:  # noqa: C901
        if not isinstance(self.snapshot_id, MetadataSnapshotId):
            raise BoundaryError.for_field("snapshot_id", "must be MetadataSnapshotId")
        if (
            not isinstance(self.revision, int)
            or isinstance(self.revision, bool)
            or self.revision < 1
        ):
            raise BoundaryError.for_field("revision", "must be a positive integer")
        if not isinstance(self.title, str) or not self.title.strip():
            raise BoundaryError.for_field("title", "must be nonblank text")
        if not isinstance(self.authors, tuple) or not all(
            isinstance(item, str) for item in self.authors
        ):
            raise BoundaryError.for_field("authors", "must be a tuple of strings")
        if not isinstance(self.identifiers, tuple) or not all(
            isinstance(item, Identifier) for item in self.identifiers
        ):
            raise BoundaryError.for_field("identifiers", "must be a tuple of Identifier")
        if self.abstract is not None and not isinstance(self.abstract, str):
            raise BoundaryError.for_field("abstract", "must be text or None")
        optional_text = (
            self.publication_date,
            self.publisher,
            self.venue,
            self.volume,
            self.issue,
            self.pages,
            self.article_number,
            self.work_type,
            self.language,
        )
        if not all(value is None or isinstance(value, str) for value in optional_text):
            raise BoundaryError.for_field(
                "metadata", "optional bibliographic fields must be text or None"
            )
        if self.publication_year is not None and (
            not isinstance(self.publication_year, int) or isinstance(self.publication_year, bool)
        ):
            raise BoundaryError.for_field("publication_year", "must be an integer or None")
        if not isinstance(self.keywords, tuple) or not all(
            isinstance(item, str) for item in self.keywords
        ):
            raise BoundaryError.for_field("keywords", "must be a tuple of strings")
        if self.sha256 is not None and not isinstance(self.sha256, Sha256):
            raise BoundaryError.for_field("sha256", "must be Sha256 or None")


@dataclass(frozen=True, slots=True)
class AcceptedContentReference:
    content_id: AssetId | LightDocumentId
    sha256: Sha256
    revision: int

    def __post_init__(self) -> None:
        if not isinstance(self.content_id, (AssetId, LightDocumentId)):
            raise BoundaryError.for_field("content_id", "must be AssetId or LightDocumentId")
        if not isinstance(self.sha256, Sha256):
            raise BoundaryError.for_field("sha256", "must be Sha256")
        if (
            not isinstance(self.revision, int)
            or isinstance(self.revision, bool)
            or self.revision < 1
        ):
            raise BoundaryError.for_field("revision", "must be a positive integer")


@dataclass(frozen=True, slots=True)
class ContentTarget:
    work_version_id: WorkVersionId
    current_metadata: UnifiedMetadataSnapshot
    accepted_content: tuple[AcceptedContentReference, ...]
    current_accepted_content: AcceptedContentReference | None
    expected_metadata_revision: int
    expected_accepted_content_sha256: Sha256 | None
    expected_accepted_content_revision: int | None

    def __post_init__(self) -> None:
        if not isinstance(self.work_version_id, WorkVersionId):
            raise BoundaryError.for_field("work_version_id", "must be WorkVersionId")
        if not isinstance(self.current_metadata, UnifiedMetadataSnapshot):
            raise BoundaryError.for_field("current_metadata", "must be UnifiedMetadataSnapshot")
        if not isinstance(self.accepted_content, tuple) or not all(
            isinstance(item, AcceptedContentReference) for item in self.accepted_content
        ):
            raise BoundaryError.for_field(
                "accepted_content", "must be a tuple of AcceptedContentReference"
            )
        if (
            self.current_accepted_content is not None
            and self.current_accepted_content not in self.accepted_content
        ):
            raise BoundaryError.for_field(
                "current_accepted_content", "must be present in accepted_content"
            )
        if self.expected_metadata_revision != self.current_metadata.revision:
            raise BoundaryError.for_field(
                "expected_metadata_revision", "must match current metadata revision"
            )
        current = self.current_accepted_content
        current_hash = None if current is None else current.sha256
        current_revision = None if current is None else current.revision
        if self.expected_accepted_content_sha256 != current_hash:
            raise BoundaryError.for_field(
                "expected_accepted_content_sha256", "must match current accepted content"
            )
        if self.expected_accepted_content_revision != current_revision:
            raise BoundaryError.for_field(
                "expected_accepted_content_revision", "must match current accepted content"
            )


@dataclass(frozen=True, slots=True)
class Header:
    name: str
    value: str


@dataclass(frozen=True, slots=True)
class AssetCandidate:
    provider: str
    role: AssetRole
    locator: str
    headers: tuple[Header, ...]


@dataclass(frozen=True, slots=True)
class BoundedByteStream:
    chunks: tuple[bytes, ...]
    media_type: str
    final_locator: str
    size: int

    @property
    def content(self) -> bytes:
        return b"".join(self.chunks)


@dataclass(frozen=True, slots=True)
class AcceptedPrimaryPdf:
    asset_id: AssetId
    work_version_id: WorkVersionId
    sha256: Sha256
    media_type: str


@dataclass(frozen=True, slots=True)
class LightDocumentBlock:
    kind: str
    ordinal: int
    text: str
    evidence: tuple[EvidenceText, ...]


@dataclass(frozen=True, slots=True)
class LightDocumentManifest:
    document_id: LightDocumentId
    source_asset_id: AssetId
    source_sha256: Sha256
    blocks: tuple[LightDocumentBlock, ...]
    parser_name: str


@dataclass(frozen=True, slots=True)
class ParserResult:
    document: LightDocumentManifest
    parser_name: str
    parser_version: str


@dataclass(frozen=True, slots=True)
class TransportRequest:
    method: str
    url: str
    headers: tuple[Header, ...]
    body: bytes | None
    timeout_seconds: int
    max_response_bytes: int


@dataclass(frozen=True, slots=True)
class TransportResponse:
    status: int
    final_url: str
    headers: tuple[Header, ...]
    body: bytes


@unique
class ArtifactKind(str, Enum):
    PRIMARY_PDF = "primary-pdf"
    SUPPLEMENTARY = "supplementary"
    LIGHT_DOCUMENT = "light-document"
    ANALYSIS = "analysis"


@dataclass(frozen=True, slots=True)
class StagedArtifact:
    kind: ArtifactKind
    path: RelativeArtifactPath
    sha256: Sha256
    content: bytes

    def __post_init__(self) -> None:
        if Sha256.from_bytes(self.content) != self.sha256:
            raise BoundaryError.for_field("sha256", "must match artifact content")


@dataclass(frozen=True, slots=True)
class PublishedArtifact:
    kind: ArtifactKind
    path: RelativeArtifactPath
    sha256: Sha256
    size: int


__all__ = (
    "AcceptedContentReference",
    "AcceptedPrimaryPdf",
    "AnalysisProposalV1",
    "ArtifactKind",
    "AssetCandidate",
    "BoundedByteStream",
    "ContentTarget",
    "Header",
    "LightDocumentBlock",
    "LightDocumentManifest",
    "ParserResult",
    "PublishedArtifact",
    "StagedArtifact",
    "TransportRequest",
    "TransportResponse",
    "UnifiedMetadataSnapshot",
)
