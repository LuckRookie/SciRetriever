from __future__ import annotations

from dataclasses import FrozenInstanceError, asdict, fields
import json
from typing import get_type_hints
import unittest

from sciretriever.batching.ports import AdmissionGuard, AdmissionPort, CatalogIdentity, OutputIdentity
from sciretriever.collection.model import (
    CitationDiscoveryRequest, CitationObservation, MetadataDiscoveryRequest,
    MetadataObservation, ProviderCitationResult, ProviderDiscoveryResult,
)
from sciretriever.collection.ports import CitationDiscoveryPort, MetadataDiscoveryPort
from sciretriever.content.model import (
    AcceptedContentReference, AcceptedPrimaryPdf, AnalysisProposalV1, ArtifactKind, AssetCandidate,
    BoundedByteStream, ContentTarget, Header, LightDocumentBlock, LightDocumentManifest,
    ParserResult, PublishedArtifact, StagedArtifact, TransportRequest, TransportResponse,
    UnifiedMetadataSnapshot,
)
from sciretriever.content.ports import (
    AnalysisModelPort, ArtifactStorePort, AssetFetcherPort, AssetResolverPort,
    BoundedTransportPort, ParserPort,
)
from sciretriever.interoperability.model import (
    ExportEncodingResult, ImportedBibliographicRecord, RecordParseResult,
)
from sciretriever.interoperability.ports import BibliographyCodec, BinaryInput, BinaryOutput
from sciretriever.kernel.contracts import Identifier
from sciretriever.kernel.enums import AssetRole, BibliographyFormat, CitationDirection
from sciretriever.kernel.hashes import Sha256
from sciretriever.kernel.ids import (
    AssetId, BatchRunId, LightDocumentId, MetadataSnapshotId, WorkId, WorkVersionId,
    AdmissionBindingId,
)
from sciretriever.kernel.paths import RelativeArtifactPath


UUID_A = "00000000-0000-4000-8000-000000000001"
UUID_B = "00000000-0000-4000-8000-000000000002"


class FakeCapabilities:
    def search(self, request: MetadataDiscoveryRequest) -> ProviderDiscoveryResult:
        return ProviderDiscoveryResult("fake", (MetadataObservation("fake", "r1", request.query, (), None, (), None),), None)

    def expand(self, request: CitationDiscoveryRequest) -> ProviderCitationResult:
        observation = CitationObservation("fake", request.seed, Identifier("doi", "10.1/x"), CitationDirection.REFERENCES)
        return ProviderCitationResult("fake", (observation,), None)

    def resolve(self, target: ContentTarget) -> tuple[AssetCandidate, ...]:
        _ = target
        return (AssetCandidate("fake", AssetRole.PRIMARY_PDF, "https://example.test/a.pdf", ()),)

    def fetch(self, candidate: AssetCandidate) -> BoundedByteStream:
        return BoundedByteStream((b"%PDF-1.7",), "application/pdf", candidate.locator, 8)

    def parse(self, primary_pdf: AcceptedPrimaryPdf) -> ParserResult:
        block = LightDocumentBlock("body", 0, "text", ())
        document = LightDocumentManifest(LightDocumentId(UUID_B), primary_pdf.asset_id, primary_pdf.sha256, (block,), "fake")
        return ParserResult(document, "fake", "v1")

    def analyze(self, document: LightDocumentManifest) -> AnalysisProposalV1:
        _ = document
        return AnalysisProposalV1.model_validate_json(json.dumps({
            "schema_version": "1",
            "final_bibliography": {
                "title": "Title", "authors": [], "abstract": None,
                "publication_date": None, "publication_year": None,
                "document_type": None, "language": None, "venue": None,
                "publisher": None, "volume": None, "issue": None, "pages": None,
                "article_number": None, "open_access_status": None, "identifiers": [],
            },
            "classification": {"document_type": None, "language": None, "subjects": []},
            "content_overview": {"summary": None, "conclusions": []},
            "research_objectives": [], "methods": [], "key_results": [],
            "conclusions_and_limitations": {"conclusions": [], "limitations": []},
            "keywords_and_tags": {"keywords": [], "tags": []}, "references": [],
        }))

    def execute(self, request: TransportRequest) -> TransportResponse:
        return TransportResponse(200, request.url, (Header("content-type", "application/pdf"),), b"ok")

    def publish(self, artifact: StagedArtifact) -> PublishedArtifact:
        return PublishedArtifact(artifact.kind, artifact.path, artifact.sha256, len(artifact.content))


class MemoryInput:
    def read(self, size: int) -> bytes:
        return b"record"[:size]


class MemoryOutput:
    def __init__(self) -> None:
        self.value = b""

    def write(self, value: bytes) -> int:
        self.value += value
        return len(value)


class FakeCodec:
    format = BibliographyFormat.RIS

    def read(self, stream: BinaryInput) -> tuple[RecordParseResult, ...]:
        stream.read(64)
        return (RecordParseResult(0, ImportedBibliographicRecord("Title", (), (), None, (), (), ()), None),)

    def write(self, records: tuple[ImportedBibliographicRecord, ...], stream: BinaryOutput) -> ExportEncodingResult:
        written = stream.write(records[0].title.encode("utf-8"))
        return ExportEncodingResult(len(records), written, ())


class FakeGuard:
    def __enter__(self) -> AdmissionGuard:
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        return None


class FakeAdmission:
    def acquire_core_write(self, catalog: CatalogIdentity) -> AdmissionGuard:
        return FakeGuard()

    def acquire_exchange_batch_owner(self, batch_run_id: BatchRunId) -> AdmissionGuard:
        return FakeGuard()

    def acquire_package_owner(self, catalog: CatalogIdentity, work_version_id: WorkVersionId) -> AdmissionGuard:
        return FakeGuard()

    def acquire_output_path(self, output: OutputIdentity) -> AdmissionGuard:
        return FakeGuard()


class TargetCapabilityPortTests(unittest.TestCase):
    @staticmethod
    def content_target() -> ContentTarget:
        metadata = UnifiedMetadataSnapshot(
            MetadataSnapshotId(UUID_B), 3, "Title", (), (), None,
        )
        accepted = AcceptedContentReference(
            AssetId(UUID_A), Sha256.from_bytes(b"pdf"), 2,
        )
        return ContentTarget(
            WorkVersionId(UUID_A), metadata, (accepted,), accepted, 3,
            accepted.sha256, accepted.revision,
        )

    def test_deterministic_fakes_drive_every_capability_method(self) -> None:
        fake = FakeCapabilities()
        metadata: MetadataDiscoveryPort = fake
        citation: CitationDiscoveryPort = fake
        resolver: AssetResolverPort = fake
        fetcher: AssetFetcherPort = fake
        parser: ParserPort = fake
        model: AnalysisModelPort = fake
        transport: BoundedTransportPort = fake
        store: ArtifactStorePort = fake
        request = MetadataDiscoveryRequest("query", None, None, 10)
        content_target = self.content_target()
        target = content_target.work_version_id
        candidates = resolver.resolve(content_target)
        stream = fetcher.fetch(candidates[0])
        pdf = AcceptedPrimaryPdf(AssetId(UUID_A), target, Sha256.from_bytes(stream.content), stream.media_type)
        document = parser.parse(pdf).document
        staged = StagedArtifact(ArtifactKind.LIGHT_DOCUMENT, RelativeArtifactPath("light/a.json"), Sha256.from_bytes(b"{}"), b"{}")
        self.assertEqual(metadata.search(request).provider, "fake")
        self.assertEqual(citation.expand(CitationDiscoveryRequest(WorkId(UUID_A), CitationDirection.REFERENCES, 10)).provider, "fake")
        self.assertEqual(model.analyze(document).schema_version, "1")
        self.assertEqual(transport.execute(TransportRequest("GET", "https://example.test", (), None, 2, 20)).status, 200)
        self.assertEqual(store.publish(staged).path, staged.path)

    def test_codec_and_admission_fakes_drive_every_method(self) -> None:
        codec: BibliographyCodec = FakeCodec()
        output = MemoryOutput()
        parsed = codec.read(MemoryInput())
        encoded = codec.write((parsed[0].record,), output)
        admission: AdmissionPort = FakeAdmission()
        binding = AdmissionBindingId(UUID_A)
        catalog = CatalogIdentity(binding, Sha256.from_bytes(b"catalog"))
        leases = (
            admission.acquire_core_write(catalog),
            admission.acquire_exchange_batch_owner(BatchRunId(UUID_A)),
            admission.acquire_package_owner(catalog, WorkVersionId(UUID_B)),
            admission.acquire_output_path(OutputIdentity(AdmissionBindingId(UUID_B), Sha256.from_bytes(b"output"))),
        )
        for guard in leases:
            with guard:
                pass
        self.assertEqual((encoded.record_count, output.value), (1, b"Title"))

    def test_public_dtos_are_frozen_explicit_and_type_resolvable(self) -> None:
        value = MetadataDiscoveryRequest("query", 2020, 2024, 5)
        with self.assertRaises(FrozenInstanceError):
            setattr(value, "query", "changed")
        self.assertEqual(tuple(item.name for item in fields(value)), ("query", "year_from", "year_to", "limit"))
        self.assertEqual(json.loads(json.dumps(asdict(value)))["limit"], 5)
        self.assertEqual(get_type_hints(MetadataDiscoveryPort.search)["return"], ProviderDiscoveryResult)
        target = self.content_target()
        self.assertEqual(target.current_metadata.revision, target.expected_metadata_revision)
        self.assertEqual(target.accepted_content[-1].sha256, target.expected_accepted_content_sha256)
        self.assertEqual(target.accepted_content[-1].revision, target.expected_accepted_content_revision)
        self.assertEqual(
            json.loads(json.dumps(asdict(target)))["current_metadata"]["title"],
            "Title",
        )


if __name__ == "__main__":
    unittest.main()
