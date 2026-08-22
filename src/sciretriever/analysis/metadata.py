"""First-stage parsed-content judgment and complete metadata proposal.

This module owns one private LLM request.  It verifies the Parser artifact and
current metadata input before the call, accepts only the two closed Analysis
results, and applies deterministic source-alignment rules before returning an
existing neutral Model value.  Prompts, requests, raw responses, and LLM
provenance never enter the public result; the execution receipt retains only
the neutral request identity, aligned provenance hashes, and prompt version.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field, replace
from typing import Final

from pydantic import ValidationError

from sciretriever.agents import (
    AgentBudget,
    AgentFailure,
    AgentPort,
    AgentProvenance,
    AgentStructuredResponse,
    open_session,
)
from sciretriever.analysis.metadata_rules import (
    MetadataRuleViolation,
    metadata_input_sha256,
    validate_metadata_proposal,
    validate_user_observations,
)
from sciretriever.analysis.ports import (
    AnalysisCall,
    AnalysisRequest,
    AnalysisRequestKind,
    canonical_json_bytes,
    parse_strict_json_object,
)
from sciretriever.model.analysis import FinalMetadataProposal, NoUsableContent
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.parsing import ParserResult
from sciretriever.model.primitives import Sha256, sha256_digest
from sciretriever.model.report import StableFailure

_PROMPT_VERSION: Final[str] = "analysis-metadata-stage-v1"
_PROMPT: Final[str] = """You perform only the first SciRetriever Analysis stage.

Judge the actual parsed work, not its topic relevance and never its page count.
Return exactly {"outcome":"no_usable_content","metadata":null} only when the
input is solely a cover, a table of contents, title/metadata/abstract without
the work, an access or download error, or content explicitly belonging to a
different work.  A complete short article, communication, comment, correction,
or one-page work is usable.  Garbled, truncated, indeterminate, or resource-only
input is an error and must not be described as no usable content.

For usable content return exactly {"outcome":"usable","metadata":{...}} and
include every LiteratureMetadata field.  Preserve every non-empty initial
value; only rebuild flat full-text keywords, normalize a publisher when it is
provably the same entity with a legal suffix variation, and fill missing values
that are explicitly present in the parsed Markdown.  Do not infer name parts,
ORCID, ROR, identifiers, or author-affiliation mappings.  Do not produce
classification, tags, provenance, explanations, confidence, or parallel data.
"""

_METADATA_FIELDS: Final[frozenset[str]] = frozenset(LiteratureMetadata.model_fields)
_AUTHOR_FIELDS: Final[frozenset[str]] = frozenset(
    {"kind", "display_name", "given_name", "family_name", "orcid", "affiliations"}
)
_AFFILIATION_FIELDS: Final[frozenset[str]] = frozenset({"name", "ror"})
_IDENTIFIER_FIELDS: Final[frozenset[str]] = frozenset({"namespace", "value"})


@dataclass(frozen=True, slots=True, repr=False)
class MetadataStageInput:
    """Verified-reader bytes and the current metadata view consumed by stage one."""

    parser_result: ParserResult = field(repr=False)
    parser_markdown_bytes: bytes = field(repr=False)
    initial_metadata: LiteratureMetadata = field(repr=False)
    input_metadata_revision: int
    input_metadata_sha256: Sha256
    user_observations: tuple[MetadataObservation, ...] = field(repr=False)

    def __repr__(self) -> str:
        return "<MetadataStageInput>"


@dataclass(frozen=True, slots=True, repr=False)
class MetadataAnalysisReceipt:
    """Safe execution identity consumed by the later Analysis service stage."""

    result: NoUsableContent | FinalMetadataProposal
    request: AnalysisRequest
    provenance: AgentProvenance
    prompt_version: str

    def __post_init__(self) -> None:
        if not isinstance(self.result, (NoUsableContent, FinalMetadataProposal)):
            raise TypeError("result must be a metadata Analysis result")
        if not isinstance(self.request, AnalysisRequest):
            raise TypeError("request must be an AnalysisRequest")
        if not isinstance(self.provenance, AgentProvenance):
            raise TypeError("provenance must be an AgentProvenance")
        if type(self.prompt_version) is not str or not self.prompt_version:
            raise ValueError("prompt_version must be nonblank text")

    def __repr__(self) -> str:
        return "<MetadataAnalysisReceipt>"


class MetadataAnalysisFailure(RuntimeError):
    """Stable, redacted failure from the first Analysis stage."""

    _MESSAGE = "metadata analysis stage failed"

    def __init__(self, failure: StableFailure) -> None:
        if not isinstance(failure, StableFailure):
            raise TypeError("failure must be a StableFailure")
        super().__init__(self._MESSAGE)
        self.failure = failure

    def __repr__(self) -> str:
        return "<MetadataAnalysisFailure>"


class MetadataAnalysisStage:
    """Build and validate exactly one private metadata-analysis request."""

    def __init__(
        self,
        *,
        agents: AgentPort,
        model: str,
        max_output_tokens: int,
        agent_budget: AgentBudget | None = None,
    ) -> None:
        if not isinstance(agents, AgentPort):
            raise TypeError("agent must implement AgentPort")
        if type(model) is not str or not model.strip() or len(model.strip()) > 512:
            raise ValueError("model must be stable bounded text")
        if type(max_output_tokens) is not int or max_output_tokens < 1:
            raise ValueError("max_output_tokens must be a positive integer")
        selected_budget = (
            AgentBudget(max_output_tokens=max_output_tokens)
            if agent_budget is None
            else agent_budget
        )
        if not isinstance(selected_budget, AgentBudget):
            raise TypeError("agent_budget must be an AgentBudget")
        if max_output_tokens > selected_budget.max_output_tokens:
            raise ValueError("stage output must fit the Agent budget")
        self._agents = agents
        self._model = model.strip()
        self._max_output_tokens = max_output_tokens
        self._agent_budget = replace(
            selected_budget,
            max_output_tokens=max_output_tokens,
        )

    def __repr__(self) -> str:
        return "<MetadataAnalysisStage>"

    def analyze(
        self,
        stage_input: MetadataStageInput,
        *,
        cancel_event: threading.Event | None = None,
    ) -> NoUsableContent | FinalMetadataProposal:
        """Return one closed result without retaining any private call material."""

        return self.execute(stage_input, cancel_event=cancel_event).result

    def execute(
        self,
        stage_input: MetadataStageInput,
        *,
        cancel_event: threading.Event | None = None,
    ) -> MetadataAnalysisReceipt:
        """Execute stage one and retain only safe request/provenance identity."""

        markdown = self._validate_input(stage_input)
        call = self._build_call(stage_input, markdown, cancel_event=cancel_event)
        response = self._complete(call)
        parsed = self._parse_response(response)
        if isinstance(parsed, NoUsableContent):
            result: NoUsableContent | FinalMetadataProposal = parsed
        else:
            try:
                validate_metadata_proposal(
                    stage_input.initial_metadata,
                    parsed,
                    markdown,
                )
            except MetadataRuleViolation as error:
                code = (
                    "analysis-metadata-alignment"
                    if error.kind == "alignment"
                    else "analysis-metadata-proposal"
                )
                raise MetadataAnalysisFailure(_failure_for(code, retryable=False)) from None
            except (TypeError, ValueError, UnicodeError, RecursionError):
                raise MetadataAnalysisFailure(
                    _failure_for("analysis-metadata-proposal", retryable=False)
                ) from None
            result = FinalMetadataProposal(outcome="usable", metadata=parsed)
        return MetadataAnalysisReceipt(
            result=result,
            request=call.request,
            provenance=response.provenance,
            prompt_version=call.prompt_version,
        )

    def _validate_input(self, stage_input: MetadataStageInput) -> str:
        try:
            _require_stage_input_types(stage_input)
            _revalidate_stage_input_models(stage_input)
            markdown = _verified_parser_markdown(stage_input)
            if metadata_input_sha256(stage_input.initial_metadata) != (
                stage_input.input_metadata_sha256
            ):
                raise ValueError("invalid metadata hash")
            validate_user_observations(
                stage_input.initial_metadata,
                stage_input.user_observations,
            )
            return markdown
        except MetadataRuleViolation:
            raise MetadataAnalysisFailure(
                _failure_for("analysis-metadata-input", retryable=False)
            ) from None
        except (
            ValidationError,
            UnicodeError,
            TypeError,
            ValueError,
            RecursionError,
        ):
            raise MetadataAnalysisFailure(
                _failure_for("analysis-metadata-input", retryable=False)
            ) from None

    def _build_call(
        self,
        stage_input: MetadataStageInput,
        markdown: str,
        *,
        cancel_event: threading.Event | None,
    ) -> AnalysisCall:
        parser = stage_input.parser_result
        payload = {
            "initial_metadata": stage_input.initial_metadata.model_dump(mode="json"),
            "input_metadata_revision": stage_input.input_metadata_revision,
            "input_metadata_sha256": stage_input.input_metadata_sha256.root,
            "parser": {
                "markdown_sha256": parser.markdown.sha256.root,
                "page_count": parser.page_count,
                "result_sha256": parser.result_sha256.root,
                "source_asset_id": parser.source_asset_id.root,
                "source_sha256": parser.source_sha256.root,
            },
            "parser_markdown": markdown,
        }
        try:
            structured_bytes = canonical_json_bytes(payload)
            structured_input = structured_bytes.decode("utf-8", errors="strict")
            request = AnalysisRequest(
                kind=AnalysisRequestKind.METADATA,
                input_sha256=sha256_digest(structured_bytes),
                model=self._model,
                max_output_tokens=self._max_output_tokens,
            )
            return AnalysisCall(
                request=request,
                prompt_version=_PROMPT_VERSION,
                prompt=_PROMPT,
                structured_input=structured_input,
                response_schema=_RESPONSE_SCHEMA,
                cancel_event=cancel_event,
            )
        except (ValidationError, UnicodeError, TypeError, ValueError, RecursionError):
            raise MetadataAnalysisFailure(
                _failure_for("analysis-metadata-input", retryable=False)
            ) from None

    def _complete(self, call: AnalysisCall) -> AgentStructuredResponse:
        try:
            request = call.to_agent_request(budget=self._agent_budget)
            with open_session(
                self._agents,
                max_turns=1,
                cancel_event=call.cancel_event,
                budget=self._agent_budget,
            ) as session:
                response = session.complete(request)
        except AgentFailure as error:
            if error.failure.code == "agent-structured-response":
                raise MetadataAnalysisFailure(
                    _failure_for("analysis-metadata-structure", retryable=False)
                ) from None
            raise MetadataAnalysisFailure(
                _failure_for(
                    "analysis-metadata-llm",
                    retryable=error.failure.retryable,
                )
            ) from None
        except Exception:
            raise MetadataAnalysisFailure(
                _failure_for("analysis-metadata-llm", retryable=True)
            ) from None

        if not isinstance(response, AgentStructuredResponse):
            raise MetadataAnalysisFailure(_failure_for("analysis-metadata-llm", retryable=False))
        try:
            provider_name = self._agents.provider_name
            aligned = (
                type(provider_name) is str
                and bool(provider_name.strip())
                and response.provenance.provider == provider_name.strip()
                and response.provenance.model == call.request.model
                and response.provenance.input_sha256 == call.request.input_sha256
            )
        except Exception:
            aligned = False
        if not aligned:
            raise MetadataAnalysisFailure(_failure_for("analysis-metadata-llm", retryable=False))
        return response

    def _parse_response(
        self,
        response: AgentStructuredResponse,
    ) -> NoUsableContent | LiteratureMetadata:
        try:
            root = parse_strict_json_object(response.result)
            if frozenset(root) != frozenset({"outcome", "metadata"}):
                raise ValueError("invalid metadata response envelope")
            outcome = root.get("outcome")
            raw_metadata = root.get("metadata")
            if outcome == "no_usable_content":
                if raw_metadata is not None:
                    raise ValueError("invalid no-content response")
                return NoUsableContent(outcome="no_usable_content")
            if outcome != "usable":
                raise ValueError("invalid usable response")
            if not isinstance(raw_metadata, dict):
                raise TypeError("invalid metadata object")
            if frozenset(raw_metadata) != _METADATA_FIELDS:
                raise ValueError("incomplete metadata object")
            _validate_nested_metadata_shape(raw_metadata)
            return LiteratureMetadata.model_validate(raw_metadata)
        except (
            ValidationError,
            UnicodeError,
            TypeError,
            ValueError,
            RecursionError,
        ):
            raise MetadataAnalysisFailure(
                _failure_for("analysis-metadata-structure", retryable=False)
            ) from None


def _require_stage_input_types(stage_input: MetadataStageInput) -> None:
    if not isinstance(stage_input, MetadataStageInput):
        raise TypeError("invalid stage input")
    if (
        type(stage_input.input_metadata_revision) is not int
        or stage_input.input_metadata_revision < 1
    ):
        raise ValueError("invalid metadata revision")
    if not isinstance(stage_input.input_metadata_sha256, Sha256):
        raise TypeError("invalid metadata hash")
    if not isinstance(stage_input.parser_result, ParserResult):
        raise TypeError("invalid parser result")
    if type(stage_input.parser_markdown_bytes) is not bytes:
        raise TypeError("invalid parser Markdown bytes")
    if not isinstance(stage_input.initial_metadata, LiteratureMetadata):
        raise TypeError("invalid initial metadata")
    if type(stage_input.user_observations) is not tuple:
        raise TypeError("invalid user observations")


def _revalidate_stage_input_models(stage_input: MetadataStageInput) -> None:
    checked_parser = ParserResult.model_validate(
        stage_input.parser_result.model_dump(mode="python")
    )
    if checked_parser != stage_input.parser_result:
        raise ValueError("invalid parser result")
    checked_metadata = LiteratureMetadata.model_validate(
        stage_input.initial_metadata.model_dump(mode="python")
    )
    if checked_metadata != stage_input.initial_metadata:
        raise ValueError("invalid initial metadata")
    for observation in stage_input.user_observations:
        if not isinstance(observation, MetadataObservation):
            raise TypeError("invalid user observation")
        checked_observation = MetadataObservation.model_validate(
            observation.model_dump(mode="python")
        )
        if checked_observation != observation:
            raise ValueError("invalid user observation")


def _verified_parser_markdown(stage_input: MetadataStageInput) -> str:
    artifact = stage_input.parser_result.markdown
    markdown_bytes = stage_input.parser_markdown_bytes
    if (
        artifact.media_type != "text/markdown"
        or artifact.byte_size != len(markdown_bytes)
        or artifact.sha256 != sha256_digest(markdown_bytes)
    ):
        raise ValueError("invalid Parser Markdown artifact")
    markdown = markdown_bytes.decode("utf-8", errors="strict")
    if not markdown.strip() or "\x00" in markdown:
        raise ValueError("invalid Parser Markdown text")
    return markdown


def _validate_nested_metadata_shape(raw_metadata: dict[str, object]) -> None:
    authors = raw_metadata.get("authors")
    identifiers = raw_metadata.get("identifiers")
    keywords = raw_metadata.get("keywords")
    if not isinstance(authors, list) or not isinstance(identifiers, list):
        raise TypeError("metadata collections must be arrays")
    if not isinstance(keywords, list):
        raise TypeError("metadata keywords must be an array")
    for author in authors:
        if not isinstance(author, dict) or frozenset(author) != _AUTHOR_FIELDS:
            raise ValueError("invalid author object")
        affiliations = author.get("affiliations")
        if not isinstance(affiliations, list):
            raise TypeError("author affiliations must be an array")
        for affiliation in affiliations:
            if not isinstance(affiliation, dict) or frozenset(affiliation) != _AFFILIATION_FIELDS:
                raise ValueError("invalid affiliation object")
    for identifier in identifiers:
        if not isinstance(identifier, dict) or frozenset(identifier) != _IDENTIFIER_FIELDS:
            raise ValueError("invalid identifier object")


def _failure_for(code: str, *, retryable: bool) -> StableFailure:
    messages: dict[str, tuple[str, str]] = {
        "analysis-metadata-input": (
            "The first Analysis stage input is not complete and aligned.",
            "Refresh the current Parser result and metadata before retrying.",
        ),
        "analysis-metadata-llm": (
            "The metadata language-model call did not return an aligned result.",
            "Check the configured Analysis provider and retry the target.",
        ),
        "analysis-metadata-structure": (
            "The metadata language-model result violated the closed structure.",
            "Check the private metadata prompt and model before retrying.",
        ),
        "analysis-metadata-proposal": (
            "The metadata proposal changed a protected bibliographic fact.",
            "Retry without replacing reliable current metadata.",
        ),
        "analysis-metadata-alignment": (
            "The metadata proposal contains values without parsed-PDF evidence.",
            "Retry with only values explicitly supported by the parsed work.",
        ),
    }
    try:
        reason, action = messages[code]
    except KeyError:
        raise ValueError("unsupported metadata failure code") from None
    return StableFailure(
        code=code,
        reason=reason,
        action=action,
        retryable=retryable,
    )


def _optional_string_schema() -> dict[str, object]:
    return {"anyOf": [{"type": "string"}, {"type": "null"}]}


def _response_schema_value() -> dict[str, object]:
    affiliation = {
        "additionalProperties": False,
        "properties": {
            "name": {"type": "string"},
            "ror": _optional_string_schema(),
        },
        "required": ["name", "ror"],
        "type": "object",
    }
    author = {
        "additionalProperties": False,
        "properties": {
            "affiliations": {"items": affiliation, "type": "array"},
            "display_name": {"type": "string"},
            "family_name": _optional_string_schema(),
            "given_name": _optional_string_schema(),
            "kind": {
                "enum": ["person", "organization", "unknown"],
                "type": "string",
            },
            "orcid": _optional_string_schema(),
        },
        "required": sorted(_AUTHOR_FIELDS),
        "type": "object",
    }
    identifier = {
        "additionalProperties": False,
        "properties": {
            "namespace": {"type": "string"},
            "value": {"type": "string"},
        },
        "required": sorted(_IDENTIFIER_FIELDS),
        "type": "object",
    }
    metadata = {
        "additionalProperties": False,
        "properties": {
            "abstract": _optional_string_schema(),
            "authors": {"items": author, "type": "array"},
            "document_type": _optional_string_schema(),
            "identifiers": {"items": identifier, "type": "array"},
            "issue": _optional_string_schema(),
            "keywords": {"items": {"type": "string"}, "type": "array"},
            "language": _optional_string_schema(),
            "pages": _optional_string_schema(),
            "publication_date": _optional_string_schema(),
            "publication_year": {
                "anyOf": [
                    {"type": "integer"},
                    {"type": "null"},
                ]
            },
            "publisher": _optional_string_schema(),
            "title": _optional_string_schema(),
            "venue": _optional_string_schema(),
            "volume": _optional_string_schema(),
        },
        "required": sorted(_METADATA_FIELDS),
        "type": "object",
    }
    return {
        "additionalProperties": False,
        "properties": {
            "metadata": {
                "anyOf": [
                    metadata,
                    {"type": "null"},
                ]
            },
            "outcome": {
                "enum": ["no_usable_content", "usable"],
                "type": "string",
            },
        },
        "required": ["metadata", "outcome"],
        "type": "object",
    }


_RESPONSE_SCHEMA: Final[str] = canonical_json_bytes(_response_schema_value()).decode("utf-8")

__all__ = (
    "MetadataAnalysisFailure",
    "MetadataAnalysisReceipt",
    "MetadataAnalysisStage",
    "MetadataStageInput",
)
