from __future__ import annotations

import unittest
from pathlib import Path

from target_analysis_support import complete_document
from target_completion_support import prepare_completion

from sciretriever.core.documents import document_bytes
from sciretriever.core.execution import ExecutionRejectedError
from sciretriever.core.literature.acceptance import CompletionRejectedError
from sciretriever.infrastructure.storage.files import CoreArtifactStore
from sciretriever.model.analysis import (
    AnalysisBounds,
    AnalysisContext,
    AnalysisResult,
    AnalysisTarget,
)
from sciretriever.model.assets import PublishedArtifact, StagedArtifact
from sciretriever.model.execution import TargetProjection, ValidatedCompletionAcceptance
from sciretriever.model.literature import CompletionSubmission, VersionFacts, WorkFacts
from sciretriever.model.llm import LLMProvenance, LLMRequest, LLMStructuredResponse
from sciretriever.model.primitives import WorkId, WorkVersionId, sha256_digest
from sciretriever.services.analysis import (
    AnalysisArtifactStorePort,
    AnalysisService,
    AnalysisServiceDependencies,
    CompletionAcceptancePort,
    LLMPort,
)
from sciretriever.services.literature import CompletionAcceptanceService
from tests.target_publisher_support import ScenarioFactory


class RecordingLlm(LLMPort):
    def __init__(self, proposal) -> None:
        self.proposal = proposal
        self.requests: list[LLMRequest] = []

    def analyze(self, request: LLMRequest) -> LLMStructuredResponse:
        self.requests.append(request)
        return LLMStructuredResponse(
            proposal=self.proposal,
            provenance=LLMProvenance(
                provider="openai",
                model=request.model,
                input_sha256=request.input_sha256,
                parameters_sha256=sha256_digest(b"parameters"),
            ),
        )


class RecordingStore(AnalysisArtifactStorePort):
    def __init__(self, root: Path, events: list[str]) -> None:
        self.store = CoreArtifactStore(root)
        self.events = events

    def publish(self, artifact: StagedArtifact) -> PublishedArtifact:
        self.events.append("artifact")
        return self.store.publish(artifact)


class RecordingCompletion(CompletionAcceptancePort):
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.submission = None
        self.target = None

    def accept_completion(
        self,
        submission: CompletionSubmission,
        target_projection: TargetProjection,
    ) -> None:
        self.events.append("completion")
        self.submission = submission
        self.target = target_projection


class RecordingPublisher:
    def __init__(self, events: list[str]) -> None:
        self.events = events

    def publish_completion(self, acceptance: ValidatedCompletionAcceptance) -> None:
        self.events.append("completion")


class MissingLiteratureFacts:
    def get_work_facts(self, work_id: WorkId) -> WorkFacts | None:
        del work_id
        return None

    def get_version_facts(self, version_id: WorkVersionId) -> VersionFacts | None:
        del version_id
        return None


class M6AnalysisServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.factory = ScenarioFactory()
        self.addCleanup(self.factory.cleanup)

    def test_service_publishes_then_requests_atomic_completion(self) -> None:
        prepared = prepare_completion(self.factory)
        document = complete_document()
        target = AnalysisTarget(
            work_version_id=prepared.context.work_version_id,
            light_document_id=prepared.context.light_document_id,
            light_document_sha256=sha256_digest(document_bytes(document)),
            metadata_snapshot_id=prepared.context.metadata_snapshot_id,
            metadata_revision=prepared.context.metadata_revision,
            metadata_sha256=prepared.context.metadata_sha256,
            parser_identity=prepared.context.parser_identity,
            model_provider=prepared.context.model_provider,
            model_identity=prepared.context.model_identity,
            parameters_sha256=sha256_digest(b"parameters"),
        )
        context = AnalysisContext(
            document=document,
            bounds=AnalysisBounds(max_input_characters=200_000, max_source_units=100),
            max_output_tokens=321,
        )
        events: list[str] = []
        llm = RecordingLlm(prepared.proposal)
        completion = RecordingCompletion(events)
        service = AnalysisService(
            AnalysisServiceDependencies(
                llm=llm,
                artifact_store=RecordingStore(prepared.storage, events),
                completion=completion,
            )
        )

        result = service.accept(context, target, prepared.target)

        self.assertIsInstance(result, AnalysisResult)
        self.assertEqual(events, ["artifact", "completion"])
        self.assertEqual(len(llm.requests), 1)
        self.assertEqual(
            llm.requests[0].input_sha256,
            sha256_digest(document_bytes(document)),
        )
        self.assertIsNotNone(completion.submission)
        self.assertIs(completion.target, prepared.target)
        assert completion.submission is not None
        self.assertEqual(
            completion.submission.light_document_sha256,
            sha256_digest(document_bytes(document)),
        )

    def test_hash_mismatch_short_circuits_before_all_ports(self) -> None:
        prepared = prepare_completion(self.factory)
        document = complete_document()
        target = AnalysisTarget(
            work_version_id=prepared.context.work_version_id,
            light_document_id=prepared.context.light_document_id,
            light_document_sha256=type(prepared.context.light_document_sha256)("9" * 64),
            metadata_snapshot_id=prepared.context.metadata_snapshot_id,
            metadata_revision=prepared.context.metadata_revision,
            metadata_sha256=prepared.context.metadata_sha256,
            parser_identity=prepared.context.parser_identity,
            model_provider=prepared.context.model_provider,
            model_identity=prepared.context.model_identity,
            parameters_sha256=sha256_digest(b"parameters"),
        )
        events: list[str] = []
        llm = RecordingLlm(prepared.proposal)
        completion = RecordingCompletion(events)
        service = AnalysisService(
            AnalysisServiceDependencies(
                llm=llm,
                artifact_store=RecordingStore(prepared.storage, events),
                completion=completion,
            )
        )

        with self.assertRaisesRegex(Exception, "analysis_input_mismatch"):
            service.accept(
                AnalysisContext(
                    document=document,
                    bounds=AnalysisBounds(max_input_characters=200_000, max_source_units=100),
                    max_output_tokens=321,
                ),
                target,
                prepared.target,
            )

        self.assertEqual(events, [])
        self.assertEqual(llm.requests, [])

    def test_invalid_completion_target_short_circuits_before_document_and_all_ports(self) -> None:
        prepared = prepare_completion(self.factory)
        document = complete_document()
        context = AnalysisContext(
            document=document,
            bounds=AnalysisBounds(max_input_characters=200_000, max_source_units=100),
            max_output_tokens=321,
        )
        events: list[str] = []
        llm = RecordingLlm(prepared.proposal)
        completion = RecordingCompletion(events)
        service = AnalysisService(
            AnalysisServiceDependencies(
                llm=llm,
                artifact_store=RecordingStore(prepared.storage, events),
                completion=completion,
            )
        )
        invalid_target = prepared.target.model_copy(
            update={"result": prepared.target.result.model_copy(update={"stage": "analysis"})}
        )

        with self.assertRaises(ExecutionRejectedError):
            service.accept(context, prepared.context, invalid_target)

        self.assertEqual(events, [])
        self.assertEqual(llm.requests, [])

    def test_missing_literature_facts_reject_before_completion_publisher(self) -> None:
        prepared = prepare_completion(self.factory)
        document = complete_document()
        target = AnalysisTarget(
            work_version_id=prepared.context.work_version_id,
            light_document_id=prepared.context.light_document_id,
            light_document_sha256=sha256_digest(document_bytes(document)),
            metadata_snapshot_id=prepared.context.metadata_snapshot_id,
            metadata_revision=prepared.context.metadata_revision,
            metadata_sha256=prepared.context.metadata_sha256,
            parser_identity=prepared.context.parser_identity,
            model_provider=prepared.context.model_provider,
            model_identity=prepared.context.model_identity,
            parameters_sha256=sha256_digest(b"parameters"),
        )
        context = AnalysisContext(
            document=document,
            bounds=AnalysisBounds(max_input_characters=200_000, max_source_units=100),
            max_output_tokens=321,
        )
        events: list[str] = []
        llm = RecordingLlm(prepared.proposal)
        publisher = RecordingPublisher(events)
        completion = CompletionAcceptanceService(MissingLiteratureFacts(), publisher)
        service = AnalysisService(
            AnalysisServiceDependencies(
                llm=llm,
                artifact_store=RecordingStore(prepared.storage, events),
                completion=completion,
            )
        )

        with self.assertRaisesRegex(CompletionRejectedError, "resolved reference work"):
            service.accept(context, target, prepared.target)

        self.assertEqual(events, ["artifact"])
        self.assertEqual(publisher.events.count("completion"), 0)


if __name__ == "__main__":
    unittest.main()
