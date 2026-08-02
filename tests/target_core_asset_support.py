from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO

from PyPDF2 import PdfWriter
from PyPDF2.generic import DecodedStreamObject, DictionaryObject, NameObject

from sciretriever.model.access import BoundedByteStream
from sciretriever.model.assets import (
    AcceptedContentReference,
    ArtifactKind,
    AssetCandidate,
    AssetPublication,
    ContentTarget,
    PrimaryPdfAcceptance,
    PublishedArtifact,
    StagedArtifact,
    SupplementaryAssetAcceptance,
)
from sciretriever.model.canonical_json import CanonicalJsonObject
from sciretriever.model.execution import ContentAcceptance
from sciretriever.model.literature import Identifier, UnifiedMetadataSnapshot
from sciretriever.model.primitives import (
    AssetId,
    AssetRole,
    MetadataSnapshotId,
    RelativeArtifactPath,
    Sha256,
    WorkVersionAssetId,
    WorkVersionId,
    sha256_digest,
)

UUID_A = "00000000-0000-0000-0000-000000000001"
UUID_B = "00000000-0000-0000-0000-000000000002"


def pdf(
    *,
    title: str = "Exact Article Title",
    author: str = "Ada Lovelace",
    year: int = 2024,
    doi: str | None = "10.1000/exact",
    text: str | None = "Article body",
) -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    if text is not None:
        page = writer.pages[0]
        font = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
        )
        escaped_text = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        content = DecodedStreamObject()
        content.set_data(f"BT\n/F1 12 Tf\n72 720 Td\n({escaped_text}) Tj\nET\n".encode("ascii"))
        page[NameObject("/Contents")] = content
    subject = f"doi:{doi}" if doi is not None else "article"
    writer.add_metadata(
        {"/Title": title, "/Author": author, "/CreationDate": f"D:{year}0101", "/Subject": subject}
    )
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def target(
    *, doi: str | None = "10.1000/exact", current: AcceptedContentReference | None = None
) -> ContentTarget:
    identifiers = () if doi is None else (Identifier(namespace="doi", value=doi),)
    metadata = UnifiedMetadataSnapshot(
        snapshot_id=MetadataSnapshotId(UUID_B),
        revision=3,
        title="Exact Article Title",
        authors=("Ada Lovelace",),
        identifiers=identifiers,
        publication_year=2024,
        sha256=sha256_digest(b"metadata"),
    )
    accepted = () if current is None else (current,)
    return ContentTarget(
        work_version_id=WorkVersionId(UUID_A),
        current_metadata=metadata,
        accepted_content=accepted,
        current_accepted_content=current,
        expected_metadata_revision=3,
        expected_accepted_content_sha256=None if current is None else current.sha256,
        expected_accepted_content_revision=None if current is None else current.revision,
    )


def stream(body: bytes, media_type: str) -> BoundedByteStream:
    return BoundedByteStream(
        chunks=(body,), media_type=media_type, final_locator="opaque:final", size=len(body)
    )


def artifact(kind: ArtifactKind, body: bytes) -> PublishedArtifact:
    digest = sha256_digest(body)
    directory = "raw"
    return PublishedArtifact(
        kind=kind,
        path=RelativeArtifactPath(f"{directory}/{str(digest)[:2]}/{digest}"),
        sha256=digest,
        size=len(body),
    )


def metadata_hash(content_target: ContentTarget) -> Sha256:
    value = content_target.current_metadata.sha256
    if value is None:
        raise AssertionError("fixture metadata must have a hash")
    return value


def primary_acceptance(content_target: ContentTarget, body: bytes) -> PrimaryPdfAcceptance:
    return PrimaryPdfAcceptance(
        work_version_id=content_target.work_version_id,
        expected_metadata_id=content_target.current_metadata.snapshot_id,
        expected_metadata_revision=content_target.current_metadata.revision,
        expected_metadata_sha256=metadata_hash(content_target),
        artifact_id=AssetId(UUID_B),
        relation_id=WorkVersionAssetId(UUID_A),
        artifact=artifact(ArtifactKind.PRIMARY_PDF, body),
        source=CanonicalJsonObject(()),
    )


def supplementary_acceptance(
    content_target: ContentTarget, body: bytes, *, role: AssetRole = AssetRole.XML
) -> SupplementaryAssetAcceptance:
    return SupplementaryAssetAcceptance(
        work_version_id=content_target.work_version_id,
        expected_metadata_id=content_target.current_metadata.snapshot_id,
        expected_metadata_revision=content_target.current_metadata.revision,
        expected_metadata_sha256=metadata_hash(content_target),
        expected_primary_sha256=content_target.expected_accepted_content_sha256,
        artifact_id=AssetId(UUID_B),
        relation_id=WorkVersionAssetId(UUID_A),
        role=role,
        media_type="application/xml",
        artifact=artifact(ArtifactKind.SUPPLEMENTARY, body),
        source=CanonicalJsonObject(()),
    )


@dataclass(frozen=True, slots=True)
class UnusedFetcher:
    def fetch(self, candidate: AssetCandidate) -> BoundedByteStream:
        del candidate
        raise AssertionError("replay path must not fetch")


@dataclass(frozen=True, slots=True)
class UnusedStore:
    def publish(self, artifact: StagedArtifact) -> PublishedArtifact:
        del artifact
        raise AssertionError("replay path must not publish")


@dataclass(frozen=True, slots=True)
class UnusedPublisher:
    def publish(self, acceptance: ContentAcceptance) -> AssetPublication:
        del acceptance
        raise AssertionError("replay path must not publish")


__all__ = (
    "UUID_A",
    "UUID_B",
    "UnusedFetcher",
    "UnusedPublisher",
    "UnusedStore",
    "artifact",
    "metadata_hash",
    "pdf",
    "primary_acceptance",
    "stream",
    "supplementary_acceptance",
    "target",
)
