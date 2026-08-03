# noqa: SIZE_OK - one capability contract matrix keeps all fake port evidence together
from __future__ import annotations

import json
import unittest
from typing import get_type_hints

from pydantic import TypeAdapter, ValidationError

from sciretriever.infrastructure.sources.assets import BoundedTransportPort
from sciretriever.model import documents
from sciretriever.model.access import (
    BoundedByteStream,
    Header,
    TransportRequest,
    TransportResponse,
)
from sciretriever.model.analysis import AnalysisProposalV1
from sciretriever.model.assets import (
    AcceptedContentReference,
    ArtifactKind,
    AssetCandidate,
    ContentTarget,
    PublishedArtifact,
    StagedArtifact,
)
from sciretriever.model.literature import Identifier, UnifiedMetadataSnapshot
from sciretriever.model.llm import LLMProvenance, LLMRequest, LLMStructuredResponse
from sciretriever.model.parsing import ParserProvenance, ParserRequest, ParserResult
from sciretriever.model.primitives import (
    AdmissionBindingId,
    AssetId,
    AssetRole,
    BatchRunId,
    BibliographyFormat,
    CitationDirection,
    MetadataSnapshotId,
    RelativeArtifactPath,
    UtcTimestamp,
    WorkId,
    WorkVersionId,
    sha256_digest,
)
from sciretriever.model.record import (
    ExportEncodingResult,
    ImportedBibliographicRecord,
    RecordParseResult,
)
from sciretriever.model.sources import (
    CitationDiscoveryRequest,
    CitationObservation,
    MetadataDiscoveryRequest,
    MetadataObservation,
    ProviderCitationResult,
    ProviderDiscoveryResult,
)
from sciretriever.services.analysis.ports import LLMPort
from sciretriever.services.assets.ports import (
    ArtifactStorePort,
    AssetFetcherPort,
    AssetResolverPort,
)
from sciretriever.services.collection.ports import (
    CitationDiscoveryPort,
    Clock,
    MetadataDiscoveryPort,
)
from sciretriever.services.documents.ports import ParserPort
from sciretriever.services.execution.ports import (
    AdmissionGuard,
    AdmissionPort,
    CatalogIdentity,
    OutputIdentity,
)
from sciretriever.services.library import BibliographyCodec, BinaryInput, BinaryOutput

UUID_A = "00000000-0000-4000-8000-000000000001"
UUID_B = "00000000-0000-4000-8000-000000000002"


class FakeCapabilities:
    @property
    def identity(self) -> str:
        return "fake"

    def search(self, request: MetadataDiscoveryRequest) -> ProviderDiscoveryResult:
        return ProviderDiscoveryResult(
            provider="fake",
            observations=(
                MetadataObservation(
                    provider="fake",
                    provider_record_id="r1",
                    title=request.query,
                    authors=(),
                    publication_year=None,
                    identifiers=(),
                    abstract=None,
                ),
            ),
            failure=None,
        )

    def expand(self, request: CitationDiscoveryRequest) -> ProviderCitationResult:
        observation = CitationObservation(
            provider="fake",
            source_work_id=request.seed,
            target_identifier=Identifier(namespace="doi", value="10.1/x"),
            direction=CitationDirection.REFERENCES,
        )
        return ProviderCitationResult(provider="fake", observations=(observation,), failure=None)

    def resolve(self, target: ContentTarget) -> tuple[AssetCandidate, ...]:
        _ = target
        return (
            AssetCandidate(
                provider="fake",
                role=AssetRole.PRIMARY_PDF,
                locator="https://example.test/a.pdf",
                headers=(),
            ),
        )

    def fetch(self, candidate: AssetCandidate) -> BoundedByteStream:
        return BoundedByteStream(
            chunks=(b"%PDF-1.7",),
            media_type="application/pdf",
            final_locator=candidate.locator,
            size=8,
        )

    def parse(self, request: ParserRequest) -> ParserResult:
        return ParserResult(
            document=documents.LightDocumentV1(
                schema_version="1",
                title=None,
                abstract=(),
                sections=(),
                references=(),
                provenance=(),
            ),
            pdf_pages=1,
            block_manifest=(),
            provenance=ParserProvenance(
                parser_name="fake",
                parser_version="1",
                backend="fake",
                model="fake",
                parameters_sha256=sha256_digest(b"parameters"),
                input_sha256=request.asset_sha256,
            ),
        )

    def analyze(self, request: LLMRequest) -> LLMStructuredResponse:
        return LLMStructuredResponse(
            proposal=AnalysisProposalV1.model_validate_json(
                json.dumps(
                    {
                        "schema_version": "1",
                        "final_bibliography": {
                            "title": "Title",
                            "authors": [],
                            "abstract": None,
                            "publication_date": None,
                            "publication_year": None,
                            "document_type": None,
                            "language": None,
                            "venue": None,
                            "publisher": None,
                            "volume": None,
                            "issue": None,
                            "pages": None,
                            "article_number": None,
                            "open_access_status": None,
                            "identifiers": [],
                        },
                        "classification": {
                            "document_type": None,
                            "language": None,
                            "subjects": [],
                        },
                        "content_overview": {"summary": None, "conclusions": []},
                        "research_objectives": [],
                        "methods": [],
                        "key_results": [],
                        "conclusions_and_limitations": {
                            "conclusions": [],
                            "limitations": [],
                        },
                        "keywords_and_tags": {"keywords": [], "tags": []},
                        "references": [],
                    }
                )
            ),
            provenance=LLMProvenance(
                provider="fake",
                model=request.model,
                input_sha256=sha256_digest(b"document"),
                parameters_sha256=sha256_digest(b"parameters"),
            ),
        )

    def execute(self, request: TransportRequest) -> TransportResponse:
        return TransportResponse(
            status=200,
            final_url=request.url,
            headers=(Header(name="content-type", value="application/pdf"),),
            body=b"ok",
        )

    def publish(self, artifact: StagedArtifact) -> PublishedArtifact:
        return PublishedArtifact(
            kind=artifact.kind,
            path=artifact.path,
            sha256=artifact.sha256,
            size=len(artifact.content),
        )


class MemoryInput:
    def read(self, size: int = -1) -> bytes:
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
        return (
            RecordParseResult(
                ordinal=0,
                record=ImportedBibliographicRecord(
                    title="Title",
                    authors=(),
                    identifiers=(),
                    abstract=None,
                    keywords=(),
                    tags=(),
                    references=(),
                ),
                failure=None,
            ),
        )

    def write(
        self, records: tuple[ImportedBibliographicRecord, ...], stream: BinaryOutput
    ) -> ExportEncodingResult:
        written = stream.write(records[0].title.encode("utf-8"))
        return ExportEncodingResult(record_count=len(records), bytes_written=written, omissions=())


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

    def acquire_package_owner(
        self, catalog: CatalogIdentity, work_version_id: WorkVersionId
    ) -> AdmissionGuard:
        return FakeGuard()

    def acquire_output_path(self, output: OutputIdentity) -> AdmissionGuard:
        return FakeGuard()


class TargetCapabilityPortTests(unittest.TestCase):
    @staticmethod
    def content_target() -> ContentTarget:
        metadata = UnifiedMetadataSnapshot(
            snapshot_id=MetadataSnapshotId(UUID_B),
            revision=3,
            title="Title",
            authors=(),
            identifiers=(),
            abstract=None,
        )
        accepted = AcceptedContentReference(
            content_id=AssetId(UUID_A),
            sha256=sha256_digest(b"pdf"),
            revision=2,
        )
        return ContentTarget(
            work_version_id=WorkVersionId(UUID_A),
            current_metadata=metadata,
            accepted_content=(accepted,),
            current_accepted_content=accepted,
            expected_metadata_revision=3,
            expected_accepted_content_sha256=accepted.sha256,
            expected_accepted_content_revision=accepted.revision,
        )

    def test_deterministic_fakes_drive_every_capability_method(self) -> None:
        fake = FakeCapabilities()
        metadata: MetadataDiscoveryPort = fake
        citation: CitationDiscoveryPort = fake
        resolver: AssetResolverPort = fake
        fetcher: AssetFetcherPort = fake
        parser: ParserPort = fake
        model: LLMPort = fake
        transport: BoundedTransportPort = fake
        store: ArtifactStorePort = fake
        request = MetadataDiscoveryRequest(query="query", year_from=None, year_to=None, limit=10)
        content_target = self.content_target()
        candidates = resolver.resolve(content_target)
        stream = fetcher.fetch(candidates[0])
        parser_request = ParserRequest(
            pdf=b"".join(stream.chunks),
            asset_id=AssetId(UUID_A),
            asset_sha256=sha256_digest(b"".join(stream.chunks)),
            resume_task_id=None,
        )
        self.assertIsNotNone(parser.parse(parser_request).document)
        staged = StagedArtifact(
            kind=ArtifactKind.LIGHT_DOCUMENT,
            path=RelativeArtifactPath("light/a.json"),
            sha256=sha256_digest(b"{}"),
            content=b"{}",
        )
        self.assertEqual(metadata.search(request).provider, "fake")
        self.assertEqual(
            citation.expand(
                CitationDiscoveryRequest(
                    seed=WorkId(UUID_A), direction=CitationDirection.REFERENCES, limit=10
                )
            ).provider,
            "fake",
        )
        analysis_request = LLMRequest(
            source="document",
            input_sha256=sha256_digest(b"document"),
            model="fake",
            max_output_tokens=32,
        )
        self.assertEqual(model.analyze(analysis_request).proposal.schema_version, "1")
        self.assertEqual(
            transport.execute(
                TransportRequest(
                    method="GET",
                    url="https://example.test",
                    headers=(),
                    body=None,
                    timeout_seconds=2,
                    max_response_bytes=20,
                )
            ).status,
            200,
        )
        self.assertEqual(store.publish(staged).path, staged.path)

    def test_collection_clock_port_is_owned_and_callable(self) -> None:
        def fixed_clock() -> UtcTimestamp:
            return UtcTimestamp("2026-08-03T00:00:00.000Z")

        clock: Clock = fixed_clock

        self.assertEqual(clock(), UtcTimestamp("2026-08-03T00:00:00.000Z"))
        self.assertEqual(Clock.__module__, "sciretriever.services.collection.ports")

    def test_codec_and_admission_fakes_drive_every_method(self) -> None:
        codec: BibliographyCodec = FakeCodec()
        output = MemoryOutput()
        parsed = codec.read(MemoryInput())
        encoded = codec.write((parsed[0].record,), output)
        admission: AdmissionPort = FakeAdmission()
        binding = AdmissionBindingId(UUID_A)
        catalog = CatalogIdentity(binding, sha256_digest(b"catalog"))
        leases = (
            admission.acquire_core_write(catalog),
            admission.acquire_exchange_batch_owner(BatchRunId(UUID_A)),
            admission.acquire_package_owner(catalog, WorkVersionId(UUID_B)),
            admission.acquire_output_path(
                OutputIdentity(AdmissionBindingId(UUID_B), sha256_digest(b"output"))
            ),
        )
        for guard in leases:
            with guard:
                pass
        self.assertEqual((encoded.record_count, output.value), (1, b"Title"))

    def test_public_dtos_are_frozen_explicit_and_type_resolvable(self) -> None:
        value = MetadataDiscoveryRequest(query="query", year_from=2020, year_to=2024, limit=5)
        with self.assertRaises(ValidationError):
            setattr(value, "query", "changed")
        self.assertEqual(
            tuple(type(value).model_fields), ("query", "year_from", "year_to", "limit")
        )
        self.assertEqual(json.loads(value.model_dump_json())["limit"], 5)
        self.assertEqual(
            get_type_hints(MetadataDiscoveryPort.search)["return"], ProviderDiscoveryResult
        )
        target = self.content_target()
        self.assertEqual(target.current_metadata.revision, target.expected_metadata_revision)
        self.assertEqual(
            target.accepted_content[-1].sha256, target.expected_accepted_content_sha256
        )
        self.assertEqual(
            target.accepted_content[-1].revision, target.expected_accepted_content_revision
        )
        self.assertEqual(
            json.loads(TypeAdapter(type(target)).dump_json(target))["current_metadata"]["title"],
            "Title",
        )


if __name__ == "__main__":
    unittest.main()
