"""Complete two-stage Analysis orchestration and neutral proposal formation."""

from __future__ import annotations

import threading
from collections.abc import Callable
from datetime import datetime, timezone
from uuid import uuid4

from pydantic import ValidationError

from sciretriever.agents.api import (
    AgentFailure,
    AgentProvenance,
    AgentRuntime,
    AgentStructuredResult,
)
from sciretriever.analysis.content import (
    ContentAnalysisInput,
    ContentAnalysisLimits,
    content_analysis_failure,
)
from sciretriever.analysis.markdown import (
    build_content_analysis_call,
    parse_content_markdown_response,
    render_canonical_markdown,
)
from sciretriever.analysis.markdown_rules import ContentMarkdownError
from sciretriever.analysis.metadata import (
    MetadataAnalysisFailure,
    MetadataAnalysisReceipt,
    MetadataAnalysisStage,
    MetadataStageInput,
)
from sciretriever.analysis.metadata_rules import metadata_input_sha256
from sciretriever.analysis.ports import (
    AnalysisArtifactPublicationPort,
    AnalysisArtifactReadPort,
    AnalysisCall,
    AnalysisCurrentInputPort,
    AnalysisRequestKind,
    ContentInputIdentity,
    StagedContentMarkdown,
    canonical_json_bytes,
)
from sciretriever.model.analysis import (
    ArtifactRef,
    LiteratureContentProposal,
    LiteratureSection,
    NoUsableContent,
    analysis_input_sha256,
    content_sha256,
)
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.parsing import ParserResult
from sciretriever.model.primitives import (
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance

_PARAMETER_SCHEMA = "sciretriever-analysis-content-parameters-v1"
_CORE_REQUEST_COUNT = 2

ProvenanceIdFactory = Callable[[], ProvenanceId]
Clock = Callable[[], UtcTimestamp]


def _new_provenance_id() -> ProvenanceId:
    return ProvenanceId(str(uuid4()))


def _utc_now() -> UtcTimestamp:
    return UtcTimestamp.model_validate(datetime.now(timezone.utc))


def _runtime_value(value: object) -> object:
    """Prevent static annotations from replacing intentional runtime checks."""

    return value


def _checked_runtime(value: object) -> AgentRuntime:
    if not isinstance(value, AgentRuntime):
        raise TypeError("runtime must be an AgentRuntime")
    return value


def _checked_artifact_reader(value: object) -> AnalysisArtifactReadPort:
    if not isinstance(value, AnalysisArtifactReadPort):
        raise TypeError("artifact_reader must implement AnalysisArtifactReadPort")
    return value


def _checked_current_inputs(value: object) -> AnalysisCurrentInputPort:
    if not isinstance(value, AnalysisCurrentInputPort):
        raise TypeError("current_inputs must implement AnalysisCurrentInputPort")
    return value


def _checked_artifact_publisher(value: object) -> AnalysisArtifactPublicationPort:
    if not isinstance(value, AnalysisArtifactPublicationPort):
        raise TypeError("artifact_publisher must implement AnalysisArtifactPublicationPort")
    return value


def _checked_limits(value: object) -> ContentAnalysisLimits:
    if not isinstance(value, ContentAnalysisLimits):
        raise TypeError("limits must be ContentAnalysisLimits")
    return value


class AnalysisService:
    """Produce one complete proposal or one explicit no-content result.

    The service owns no database state and never constructs the authoritative
    ``LiteratureContent``.  It reads one verified complete Parser Markdown,
    executes the two frozen Analysis stages, rechecks current input identity,
    publishes canonical Markdown create-if-absent, and returns only the
    revision-free neutral proposal.
    """

    __slots__ = (
        "_artifact_publisher",
        "_artifact_reader",
        "_clock",
        "_content_max_output_tokens",
        "_current_inputs",
        "_limits",
        "_metadata_max_output_tokens",
        "_metadata_stage",
        "_provenance_id_factory",
        "_runtime",
    )

    def __init__(  # noqa: C901
        self,
        *,
        runtime: AgentRuntime,
        artifact_reader: AnalysisArtifactReadPort,
        current_inputs: AnalysisCurrentInputPort,
        artifact_publisher: AnalysisArtifactPublicationPort,
        metadata_max_output_tokens: int,
        content_max_output_tokens: int,
        limits: ContentAnalysisLimits,
        provenance_id_factory: ProvenanceIdFactory = _new_provenance_id,
        clock: Clock = _utc_now,
    ) -> None:
        checked_runtime = _checked_runtime(runtime)
        checked_artifact_reader = _checked_artifact_reader(artifact_reader)
        checked_current_inputs = _checked_current_inputs(current_inputs)
        checked_artifact_publisher = _checked_artifact_publisher(artifact_publisher)
        checked_limits = _checked_limits(limits)
        if type(metadata_max_output_tokens) is not int or metadata_max_output_tokens < 1:
            raise ValueError("metadata_max_output_tokens must be a positive integer")
        if type(content_max_output_tokens) is not int or content_max_output_tokens < 1:
            raise ValueError("content_max_output_tokens must be a positive integer")
        if not callable(provenance_id_factory):
            raise TypeError("provenance_id_factory must be callable")
        if not callable(clock):
            raise TypeError("clock must be callable")

        self._runtime = checked_runtime
        self._artifact_reader = checked_artifact_reader
        self._current_inputs = checked_current_inputs
        self._artifact_publisher = checked_artifact_publisher
        self._metadata_max_output_tokens = metadata_max_output_tokens
        self._content_max_output_tokens = content_max_output_tokens
        self._limits = checked_limits
        self._provenance_id_factory = provenance_id_factory
        self._clock = clock
        self._metadata_stage = MetadataAnalysisStage(
            runtime=checked_runtime,
            max_output_tokens=metadata_max_output_tokens,
        )

    def __repr__(self) -> str:
        return "<AnalysisService>"

    def analyze(
        self,
        analysis_input: ContentAnalysisInput,
        *,
        cancel_event: threading.Event | None = None,
    ) -> NoUsableContent | LiteratureContentProposal:
        """Run the closed content use case without publishing a partial result."""

        self._require_not_cancelled(cancel_event)
        identity = self._validate_input_and_budgets(analysis_input)
        parser_markdown_bytes, parser_markdown = self._read_parser_markdown(analysis_input)
        self._require_not_cancelled(cancel_event)
        self._require_current_input(identity)

        receipt = self._execute_metadata_stage(
            analysis_input,
            parser_markdown_bytes,
            cancel_event=cancel_event,
        )
        self._require_not_cancelled(cancel_event)
        self._validate_metadata_receipt(receipt)
        if isinstance(receipt.result, NoUsableContent):
            self._require_current_input(identity)
            return receipt.result

        final_metadata = receipt.result.metadata
        try:
            final_metadata_sha256 = metadata_input_sha256(final_metadata)
            content_call = build_content_analysis_call(
                parser_result=analysis_input.parser_result,
                parser_markdown=parser_markdown,
                final_metadata=final_metadata,
                max_output_tokens=self._content_max_output_tokens,
                cancel_event=cancel_event,
            )
        except Exception:
            raise content_analysis_failure("analysis-content-contract") from None

        self._require_not_cancelled(cancel_event)
        response = self._complete_content_call(content_call)
        try:
            draft = parse_content_markdown_response(
                response,
                parser_result=analysis_input.parser_result,
                parser_markdown=parser_markdown,
            )
        except ContentMarkdownError:
            raise content_analysis_failure("analysis-content-draft") from None
        except (ValidationError, UnicodeError, TypeError, ValueError, RecursionError):
            raise content_analysis_failure("analysis-content-draft") from None

        self._require_not_cancelled(cancel_event)
        self._require_current_input(identity)
        staged = self._render_markdown(final_metadata, draft.sections, draft.references)
        proposal = self._build_proposal(
            analysis_input=analysis_input,
            final_metadata=final_metadata,
            final_metadata_sha256=final_metadata_sha256,
            sections=draft.sections,
            references=draft.references,
            markdown=staged.artifact,
            metadata_receipt=receipt,
            content_call=content_call,
            content_provenance=response.provenance,
        )
        self._publish_markdown(staged)
        return proposal

    def _validate_input_and_budgets(
        self,
        analysis_input: ContentAnalysisInput,
    ) -> ContentInputIdentity:
        try:
            input_value = _runtime_value(analysis_input)
            if not isinstance(input_value, ContentAnalysisInput):
                raise TypeError("invalid content Analysis input")
            parser_result = analysis_input.parser_result
            checked_parser = ParserResult.model_validate(parser_result.model_dump(mode="python"))
            checked_metadata = LiteratureMetadata.model_validate(
                analysis_input.initial_metadata.model_dump(mode="python")
            )
            if (
                checked_parser != parser_result
                or checked_metadata != analysis_input.initial_metadata
            ):
                raise ValueError("invalid current Analysis model")
            for observation in analysis_input.user_observations:
                checked_observation = MetadataObservation.model_validate(
                    observation.model_dump(mode="python")
                )
                if checked_observation != observation:
                    raise ValueError("invalid metadata observation")
            if (
                parser_result.source_asset_id != analysis_input.primary_asset_id
                or parser_result.source_sha256 != analysis_input.primary_pdf_sha256
                or metadata_input_sha256(analysis_input.initial_metadata)
                != analysis_input.input_metadata_sha256
            ):
                raise ValueError("content Analysis input identity is not aligned")
            identity = analysis_input.input_identity()
        except Exception:
            raise content_analysis_failure("analysis-content-input") from None

        size = analysis_input.parser_result.markdown.byte_size
        limits = self._limits
        if (
            size > limits.max_input_bytes
            or limits.max_total_llm_requests < _CORE_REQUEST_COUNT
            or self._metadata_max_output_tokens + self._content_max_output_tokens
            > limits.max_total_output_tokens
        ):
            raise content_analysis_failure("analysis-content-budget")
        chunk_count = (size + limits.max_chunk_bytes - 1) // limits.max_chunk_bytes
        if chunk_count > limits.max_chunk_count:
            raise content_analysis_failure("analysis-content-budget")
        if chunk_count != 1:
            raise content_analysis_failure("analysis-content-chunking-unsupported")
        return identity

    def _read_parser_markdown(
        self,
        analysis_input: ContentAnalysisInput,
    ) -> tuple[bytes, str]:
        reference = analysis_input.parser_result.markdown
        maximum = reference.byte_size + 1
        try:
            chunks: list[bytes] = []
            size = 0
            with self._artifact_reader.open_artifact(reference) as stream:
                while size < maximum:
                    chunk = stream.read(maximum - size)
                    if type(chunk) is not bytes:
                        raise TypeError("artifact reader must return bytes")
                    if not chunk:
                        break
                    chunks.append(chunk)
                    size += len(chunk)
                payload = b"".join(chunks)
            if len(payload) != reference.byte_size or sha256_digest(payload) != reference.sha256:
                raise ValueError("Parser Markdown bytes do not match their descriptor")
            markdown = payload.decode("utf-8", errors="strict")
            if not markdown.strip() or "\x00" in markdown:
                raise ValueError("Parser Markdown must be nonblank UTF-8 text")
            return payload, markdown
        except Exception:
            raise content_analysis_failure("analysis-content-artifact-read") from None

    def _require_current_input(self, identity: ContentInputIdentity) -> None:
        try:
            matches = self._current_inputs.current_input_matches(identity)
        except Exception:
            raise content_analysis_failure("analysis-content-input-check") from None
        if type(matches) is not bool:
            raise content_analysis_failure("analysis-content-contract")
        if not matches:
            raise content_analysis_failure("analysis-content-input-stale")

    def _execute_metadata_stage(
        self,
        analysis_input: ContentAnalysisInput,
        parser_markdown_bytes: bytes,
        *,
        cancel_event: threading.Event | None,
    ) -> MetadataAnalysisReceipt:
        try:
            return self._metadata_stage.execute(
                MetadataStageInput(
                    parser_result=analysis_input.parser_result,
                    parser_markdown_bytes=parser_markdown_bytes,
                    initial_metadata=analysis_input.initial_metadata,
                    input_metadata_revision=analysis_input.input_metadata_revision,
                    input_metadata_sha256=analysis_input.input_metadata_sha256,
                    user_observations=analysis_input.user_observations,
                ),
                cancel_event=cancel_event,
            )
        except MetadataAnalysisFailure as error:
            raise content_analysis_failure(
                "analysis-content-metadata-stage",
                retryable=error.failure.retryable,
            ) from None
        except Exception:
            raise content_analysis_failure("analysis-content-metadata-stage") from None

    def _validate_metadata_receipt(self, receipt: MetadataAnalysisReceipt) -> None:
        aligned = (
            receipt.request.kind is AnalysisRequestKind.METADATA
            and receipt.request.max_output_tokens == self._metadata_max_output_tokens
            and receipt.provenance.input_sha256 == receipt.request.input_sha256
        )
        if not aligned:
            raise content_analysis_failure("analysis-content-contract")

    def _complete_content_call(self, call: AnalysisCall) -> AgentStructuredResult:
        if (
            call.request.kind is not AnalysisRequestKind.CONTENT
            or call.request.max_output_tokens != self._content_max_output_tokens
        ):
            raise content_analysis_failure("analysis-content-contract")
        try:
            response = self._runtime.execute(
                call.to_agent_call(),
                cancel_event=call.cancel_event,
            )
        except AgentFailure as error:
            raise content_analysis_failure(
                "analysis-content-llm",
                retryable=error.failure.retryable,
            ) from None
        except Exception:
            raise content_analysis_failure("analysis-content-llm") from None
        if not isinstance(response, AgentStructuredResult):
            raise content_analysis_failure(
                "analysis-content-llm",
                retryable=False,
            )
        if response.provenance.input_sha256 != call.request.input_sha256:
            raise content_analysis_failure(
                "analysis-content-llm",
                retryable=False,
            )
        return response

    def _render_markdown(
        self,
        final_metadata: LiteratureMetadata,
        sections: tuple[LiteratureSection, ...],
        references: tuple[str, ...],
    ) -> StagedContentMarkdown:
        try:
            markdown_bytes = render_canonical_markdown(
                metadata=final_metadata,
                sections=sections,
                references=references,
            )
            if type(markdown_bytes) is not bytes or not markdown_bytes:
                raise TypeError("canonical Markdown renderer must return bytes")
            artifact = ArtifactRef(
                sha256=sha256_digest(markdown_bytes),
                media_type="text/markdown",
                byte_size=len(markdown_bytes),
            )
            return StagedContentMarkdown(artifact=artifact, content=markdown_bytes)
        except Exception:
            raise content_analysis_failure("analysis-content-render") from None

    def _build_proposal(
        self,
        *,
        analysis_input: ContentAnalysisInput,
        final_metadata: LiteratureMetadata,
        final_metadata_sha256: Sha256,
        sections: tuple[LiteratureSection, ...],
        references: tuple[str, ...],
        markdown: ArtifactRef,
        metadata_receipt: MetadataAnalysisReceipt,
        content_call: AnalysisCall,
        content_provenance: AgentProvenance,
    ) -> LiteratureContentProposal:
        try:
            if (
                metadata_receipt.provenance.provider != content_provenance.provider
                or metadata_receipt.provenance.model != content_provenance.model
            ):
                raise ValueError("Analysis stage provenance identities do not align")
            provider = content_provenance.provider
            model = content_provenance.model
            checked_sections = tuple(sections)
            provenance_id_value = _runtime_value(self._provenance_id_factory())
            observed_at_value = _runtime_value(self._clock())
            if not isinstance(provenance_id_value, ProvenanceId):
                raise TypeError("provenance_id_factory must return ProvenanceId")
            if not isinstance(observed_at_value, UtcTimestamp):
                raise TypeError("clock must return UtcTimestamp")
            parameter_manifest = {
                "model": model,
                "provider": provider,
                "schema": _PARAMETER_SCHEMA,
                "stages": [
                    {
                        "kind": metadata_receipt.request.kind.value,
                        "max_output_tokens": metadata_receipt.request.max_output_tokens,
                        "parameters_sha256": str(metadata_receipt.provenance.parameters_sha256),
                        "prompt_version": metadata_receipt.prompt_version,
                    },
                    {
                        "kind": content_call.request.kind.value,
                        "max_output_tokens": content_call.request.max_output_tokens,
                        "parameters_sha256": str(content_provenance.parameters_sha256),
                        "prompt_version": content_call.prompt_version,
                    },
                ],
            }
            analysis_provenance = Provenance(
                provenance_id=provenance_id_value,
                source_kind=SourceKind.ANALYSIS,
                source_name=f"{provider}/{model}",
                source_record_id=None,
                observed_at=observed_at_value,
                input_sha256=analysis_input_sha256(
                    analysis_input.primary_pdf_sha256,
                    analysis_input.parser_result.result_sha256,
                    final_metadata_sha256,
                ),
                parameters_sha256=sha256_digest(canonical_json_bytes(parameter_manifest)),
            )
            structured_hash = content_sha256(
                metadata_sha256=final_metadata_sha256,
                sections=checked_sections,
                references=references,
            )
            return LiteratureContentProposal(
                literature_id=analysis_input.literature_id,
                primary_asset_id=analysis_input.primary_asset_id,
                primary_pdf_sha256=analysis_input.primary_pdf_sha256,
                parser_result_sha256=analysis_input.parser_result.result_sha256,
                input_metadata_revision=analysis_input.input_metadata_revision,
                input_metadata_sha256=analysis_input.input_metadata_sha256,
                final_metadata=final_metadata,
                metadata_sha256=final_metadata_sha256,
                sections=checked_sections,
                references=references,
                literature_content_sha256=structured_hash,
                markdown=markdown,
                provenance=analysis_provenance,
            )
        except Exception:
            raise content_analysis_failure("analysis-content-contract") from None

    def _publish_markdown(self, staged: StagedContentMarkdown) -> None:
        try:
            published = self._artifact_publisher.publish_markdown(staged)
        except Exception:
            raise content_analysis_failure("analysis-content-artifact-publication") from None
        published_value = _runtime_value(published)
        if not isinstance(published_value, ArtifactRef) or published_value != staged.artifact:
            raise content_analysis_failure("analysis-content-artifact-publication")

    @staticmethod
    def _require_not_cancelled(cancel_event: threading.Event | None) -> None:
        if cancel_event is None:
            return
        try:
            cancelled = cancel_event.is_set()
        except Exception:
            raise content_analysis_failure("analysis-content-contract") from None
        if type(cancelled) is not bool:
            raise content_analysis_failure("analysis-content-contract")
        if cancelled:
            raise content_analysis_failure("analysis-content-cancelled")


__all__ = (
    "AnalysisService",
    "Clock",
    "ProvenanceIdFactory",
)
