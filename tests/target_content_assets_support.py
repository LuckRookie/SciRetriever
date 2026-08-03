from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from PyPDF2 import PdfWriter
from PyPDF2.generic import DecodedStreamObject, DictionaryObject, NameObject

from sciretriever.infrastructure.storage.files import CoreArtifactStore
from sciretriever.infrastructure.storage.sqlite import ContentAcceptancePublisher
from sciretriever.model.access import BoundedByteStream, Header
from sciretriever.model.assets import (
    AcceptedContentReference,
    AssetCandidate,
    AssetPublication,
    ContentTarget,
    PrimaryPdfAcceptance,
    PublishedArtifact,
    StagedArtifact,
    SupplementaryAssetAcceptance,
)
from sciretriever.model.execution import (
    TargetProjection,
    ValidatedAssetAcceptance,
    ValidatedDocumentAcceptance,
)
from sciretriever.model.literature import Identifier, UnifiedMetadataSnapshot
from sciretriever.model.primitives import (
    AssetRole,
    MetadataSnapshotId,
    WorkVersionId,
    sha256_digest,
)
from sciretriever.services.assets.ports import RaceCancellation

AssetAcceptance = PrimaryPdfAcceptance | SupplementaryAssetAcceptance

UUID_A = "00000000-0000-0000-0000-000000000001"
UUID_B = "00000000-0000-0000-0000-000000000002"


def pdf(
    *,
    title: str = "Exact Article Title",
    author: str = "Ada Lovelace",
    year: int = 2024,
    doi: str | None = "10.1000/exact",
    pages: int = 2,
) -> bytes:
    writer = PdfWriter()
    for _index in range(pages):
        writer.add_blank_page(width=612, height=792)
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
    content = DecodedStreamObject()
    content.set_data(b"BT\n/F1 12 Tf\n72 720 Td\n(Article body) Tj\nET\n")
    page[NameObject("/Contents")] = content
    subject = f"doi:{doi}" if doi is not None else "article"
    writer.add_metadata(
        {"/Title": title, "/Author": author, "/CreationDate": f"D:{year}0101", "/Subject": subject}
    )
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def target(*, current: AcceptedContentReference | None = None) -> ContentTarget:
    metadata = UnifiedMetadataSnapshot(
        snapshot_id=MetadataSnapshotId(UUID_B),
        revision=3,
        title="Exact Article Title",
        authors=("Ada Lovelace",),
        identifiers=(Identifier(namespace="doi", value="10.1000/exact"),),
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


@dataclass(frozen=True, slots=True)
class Resolver:
    candidates: tuple[AssetCandidate, ...]
    identity: str = "fixture-resolver"

    def resolve(self, target: ContentTarget) -> tuple[AssetCandidate, ...]:
        del target
        return self.candidates


@dataclass(frozen=True, slots=True)
class FailingResolver:
    identity: str

    def resolve(self, target: ContentTarget) -> tuple[AssetCandidate, ...]:
        del target
        raise OSError("private resolver failure")


@dataclass(frozen=True, slots=True)
class Fetcher:
    responses: dict[str, BoundedByteStream]

    def fetch(self, candidate: AssetCandidate) -> BoundedByteStream:
        return self.responses[candidate.locator]


class ControlledFetcher:
    def __init__(
        self,
        responses: dict[str, BoundedByteStream | OSError | TimeoutError],
        delays: dict[str, float] | None = None,
    ) -> None:
        self.responses = responses
        self.delays = delays or {}
        self.calls: list[str] = []
        self.cancelled = threading.Event()

    def fetch(self, candidate: AssetCandidate) -> BoundedByteStream:
        self.calls.append(candidate.locator)
        delay = self.delays.get(candidate.locator, 0.0)
        if delay:
            time.sleep(delay)
        response = self.responses[candidate.locator]
        if isinstance(response, (OSError, TimeoutError)):
            raise response
        return response

    def fetch_cancellable(
        self,
        candidate: AssetCandidate,
        token: RaceCancellation,
    ) -> BoundedByteStream:
        self.calls.append(candidate.locator)
        deadline = time.monotonic() + self.delays.get(candidate.locator, 0.0)
        while time.monotonic() < deadline:
            if token.cancelled:
                self.cancelled.set()
                raise TimeoutError
            time.sleep(0.005)
        response = self.responses[candidate.locator]
        if isinstance(response, (OSError, TimeoutError)):
            raise response
        return response


class DeterministicRaceFetcher:
    def __init__(self, responses: dict[str, BoundedByteStream]) -> None:
        self.responses = responses
        self.late_entered = threading.Event()
        self.fast_release = threading.Event()
        self.service_done = threading.Event()
        self.cancellation_probe = threading.Event()
        self.cancellation_seen = threading.Event()
        self.late_release = threading.Event()
        self.late_finished = threading.Event()
        self.winner_authority_hidden = threading.Event()

    def fetch(self, candidate: AssetCandidate) -> BoundedByteStream:
        return self.responses[candidate.locator]

    def fetch_cancellable(
        self,
        candidate: AssetCandidate,
        token: RaceCancellation,
    ) -> BoundedByteStream:
        if candidate.locator == "fast":
            if not self.late_entered.wait(1.0) or not self.fast_release.wait(1.0):
                raise TimeoutError
            return self.responses[candidate.locator]
        self.late_entered.set()
        if not self.cancellation_probe.wait(1.0):
            raise TimeoutError
        if token.cancelled:
            self.cancellation_seen.set()
        if not self.late_release.wait(1.0):
            raise TimeoutError
        if not hasattr(token, "claim"):
            self.winner_authority_hidden.set()
        self.late_finished.set()
        return self.responses[candidate.locator]


class RecordingPublisher:
    def __init__(self, events: list[str], projection: TargetProjection) -> None:
        self.events = events
        self.projection = projection
        self.commands: list[ValidatedAssetAcceptance | ValidatedDocumentAcceptance] = []

    def publish(
        self, acceptance: ValidatedAssetAcceptance | ValidatedDocumentAcceptance
    ) -> AssetPublication:
        self.events.append("catalog")
        self.commands.append(acceptance)
        if isinstance(acceptance, ValidatedAssetAcceptance):
            value = acceptance.acceptance
        else:
            raise AssertionError("document acceptance is not an asset publication")
        return AssetPublication(
            asset_id=value.artifact_id,
            relation_id=value.relation_id,
            replayed=False,
        )


@dataclass(frozen=True, slots=True)
class ProjectedPublisher:
    publisher: ContentAcceptancePublisher
    projection: TargetProjection

    def publish(
        self, acceptance: ValidatedAssetAcceptance | ValidatedDocumentAcceptance
    ) -> AssetPublication:
        result = self.publisher.publish(acceptance)
        assert result is not None
        return result


class RecordingStore:
    def __init__(self, root: Path, events: list[str]) -> None:
        self._store = CoreArtifactStore(root)
        self.events = events

    def publish(self, artifact: StagedArtifact) -> PublishedArtifact:
        self.events.append("file")
        return self._store.publish(artifact)


def candidate(
    locator: str, role: AssetRole = AssetRole.PRIMARY_PDF, provider: str = "provider"
) -> AssetCandidate:
    return AssetCandidate(
        provider=provider,
        role=role,
        locator=locator,
        headers=(Header(name="Authorization", value="secret"),),
    )


def stream(content: bytes, media_type: str = "application/pdf") -> BoundedByteStream:
    return BoundedByteStream(
        chunks=(content,),
        media_type=media_type,
        final_locator="https://final.invalid/private",
        size=len(content),
    )
