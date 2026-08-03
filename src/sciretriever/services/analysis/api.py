from __future__ import annotations

from dataclasses import dataclass

from sciretriever.core.analysis import (
    AnalysisValidationError,
    analysis_bytes,
    assemble_completion_submission,
    validate_llm_request,
    validate_llm_response,
)
from sciretriever.core.documents import document_bytes
from sciretriever.core.execution import validate_completion_target
from sciretriever.model import analysis as analysis_models
from sciretriever.model import assets as asset_models
from sciretriever.model import execution as execution_models
from sciretriever.model import llm as llm_models
from sciretriever.model.primitives import RelativeArtifactPath, sha256_digest

from .ports import AnalysisArtifactStorePort, CompletionAcceptancePort, LLMPort


@dataclass(frozen=True, slots=True)
class AnalysisServiceDependencies:
    llm: LLMPort
    artifact_store: AnalysisArtifactStorePort
    completion: CompletionAcceptancePort


class AnalysisService:
    def __init__(self, dependencies: AnalysisServiceDependencies) -> None:
        self._dependencies = dependencies

    def accept(
        self,
        context: analysis_models.AnalysisContext,
        target: analysis_models.AnalysisTarget,
        target_projection: execution_models.TargetProjection,
    ) -> analysis_models.AnalysisResult:
        validate_completion_target(target_projection, target.work_version_id)
        source_bytes = document_bytes(context.document)
        source = source_bytes.decode("ascii")
        input_sha256 = sha256_digest(source_bytes)
        if input_sha256 != target.light_document_sha256:
            raise AnalysisValidationError("analysis_input_mismatch")
        request = llm_models.LLMRequest(
            source=source,
            input_sha256=input_sha256,
            model=target.model_identity,
            max_output_tokens=context.max_output_tokens,
        )
        validate_llm_request(request, context.document, context.bounds)
        response = self._dependencies.llm.analyze(request)
        validate_llm_response(request, response, context.document, context.bounds)
        if response.provenance.provider != target.model_provider:
            raise AnalysisValidationError("analysis_provider_mismatch")
        if response.provenance.parameters_sha256 != target.parameters_sha256:
            raise AnalysisValidationError("analysis_parameters_mismatch")
        content = analysis_bytes(response.proposal)
        published = self._dependencies.artifact_store.publish(
            asset_models.StagedArtifact(
                kind=asset_models.ArtifactKind.ANALYSIS,
                path=RelativeArtifactPath("staged"),
                sha256=sha256_digest(content),
                content=content,
            )
        )
        submission = assemble_completion_submission(
            response.proposal,
            target,
            target_projection,
            published,
        )
        self._dependencies.completion.accept_completion(submission, target_projection)
        return analysis_models.AnalysisResult(artifact=published, submission=submission)


__all__ = ("AnalysisService", "AnalysisServiceDependencies")
