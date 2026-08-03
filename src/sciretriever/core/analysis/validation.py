from __future__ import annotations

from collections.abc import Iterator
from typing import Final, assert_never

from pydantic import ValidationError

from sciretriever.model import analysis as analysis_models
from sciretriever.model import documents, llm
from sciretriever.model.primitives import sha256_digest

from .errors import AnalysisValidationError

_ANALYSIS_FIELDS: Final[frozenset[str]] = frozenset(
    ("schema_version", *analysis_models.ANALYSIS_CATEGORIES)
)
_LocatorKey = tuple[str, int, int, str]


def _iter_sections(
    sections: tuple[documents.Section, ...],
) -> Iterator[documents.Section]:
    for section in sections:
        yield section
        yield from _iter_sections(section.children)


def _block_locators(block: documents.Block) -> Iterator[documents.SourceLocator]:
    match block:
        case documents.ParagraphBlock(evidence=evidence):
            yield from evidence
        case documents.ListBlock(items=items):
            for item in items:
                yield from item.evidence
        case documents.TableBlock(caption=caption, evidence=evidence):
            if caption is not None:
                yield from caption.evidence
            yield from evidence
        case documents.FormulaBlock(evidence=evidence):
            yield from evidence
        case documents.FigureCaptionBlock(evidence=evidence):
            yield from evidence
        case unreachable:
            assert_never(unreachable)


def _document_locators(
    document: documents.LightDocumentV1,
) -> Iterator[documents.SourceLocator]:
    if document.title is not None:
        yield from document.title.evidence
    for item in document.abstract:
        yield from item.evidence
    for section in _iter_sections(document.sections):
        if section.title is not None:
            yield from section.title.evidence
        for block in section.blocks:
            yield from _block_locators(block)
    for reference in document.references:
        yield from reference.evidence


def _document_locator_bounds(
    document: documents.LightDocumentV1,
) -> dict[_LocatorKey, int]:
    bounds: dict[_LocatorKey, int] = {}
    for locator in _document_locators(document):
        key = (
            str(locator.asset_id),
            locator.page_start,
            locator.page_end,
            locator.block_id,
        )
        bounds[key] = max(bounds.get(key, 0), locator.char_end)
    return bounds


def _proposal_locators(
    proposal: analysis_models.AnalysisProposalV1,
) -> Iterator[documents.SourceLocator]:
    yield from (
        locator for subject in proposal.classification.subjects for locator in subject.evidence
    )
    if proposal.content_overview.summary is not None:
        yield from proposal.content_overview.summary.evidence
    yield from (
        locator for item in proposal.content_overview.conclusions for locator in item.evidence
    )
    yield from (locator for item in proposal.research_objectives for locator in item.evidence)
    yield from (locator for item in proposal.methods for locator in item.evidence)
    yield from (locator for item in proposal.key_results for locator in item.evidence)
    yield from (
        locator
        for item in proposal.conclusions_and_limitations.conclusions
        for locator in item.evidence
    )
    yield from (
        locator
        for item in proposal.conclusions_and_limitations.limitations
        for locator in item.evidence
    )
    yield from (locator for item in proposal.references for locator in item.evidence)


def _locator_resolves(
    locator: documents.SourceLocator,
    bounds: dict[_LocatorKey, int],
) -> bool:
    key = (
        str(locator.asset_id),
        locator.page_start,
        locator.page_end,
        locator.block_id,
    )
    return locator.char_start < locator.char_end <= bounds.get(key, -1)


def _source_units(sections: tuple[documents.Section, ...]) -> int:
    return sum(len(section.blocks) + _source_units(section.children) for section in sections)


def _source_ascii(source: str) -> bytes:
    if not source.strip():
        raise AnalysisValidationError("analysis_invalid_input")
    try:
        return source.encode("ascii")
    except UnicodeEncodeError as error:
        raise AnalysisValidationError("analysis_invalid_input") from error


def validate_analysis_input(
    source: str,
    document: documents.LightDocumentV1,
    bounds: analysis_models.AnalysisBounds,
) -> str:
    _source_ascii(source)
    if (
        len(source) > bounds.max_input_characters
        or _source_units(document.sections) > bounds.max_source_units
    ):
        raise AnalysisValidationError("analysis_input_too_large")
    return source


def validate_analysis_proposal(
    proposal: analysis_models.AnalysisProposalV1,
    document: documents.LightDocumentV1,
) -> analysis_models.AnalysisProposalV1:
    fields = frozenset(type(proposal).model_fields)
    if proposal.schema_version != "1" or fields != _ANALYSIS_FIELDS:
        raise AnalysisValidationError("analysis_invalid_output")
    bounds = _document_locator_bounds(document)
    if any(not _locator_resolves(locator, bounds) for locator in _proposal_locators(proposal)):
        raise AnalysisValidationError("analysis_invalid_evidence")
    return proposal


def validate_analysis_text(
    payload: str,
    document: documents.LightDocumentV1,
    bounds: analysis_models.AnalysisBounds,
) -> analysis_models.AnalysisProposalV1:
    if len(payload) > bounds.max_output_characters:
        raise AnalysisValidationError("analysis_output_too_large")
    try:
        proposal = analysis_models.AnalysisProposalV1.model_validate_json(payload)
    except ValidationError as error:
        raise AnalysisValidationError("analysis_invalid_output") from error
    return validate_analysis_proposal(proposal, document)


def validate_llm_request(
    request: llm.LLMRequest,
    document: documents.LightDocumentV1,
    bounds: analysis_models.AnalysisBounds,
) -> llm.LLMRequest:
    source = validate_analysis_input(request.source, document, bounds)
    if request.input_sha256 != sha256_digest(source.encode("ascii")):
        raise AnalysisValidationError("analysis_input_mismatch")
    return request


def validate_llm_response(
    request: llm.LLMRequest,
    response: llm.LLMStructuredResponse,
    document: documents.LightDocumentV1,
    bounds: analysis_models.AnalysisBounds,
) -> llm.LLMStructuredResponse:
    validate_llm_request(request, document, bounds)
    if response.provenance.input_sha256 != request.input_sha256:
        raise AnalysisValidationError("analysis_input_mismatch")
    if response.provenance.model != request.model:
        raise AnalysisValidationError("analysis_model_mismatch")
    validate_analysis_proposal(response.proposal, document)
    return response


__all__ = (
    "validate_analysis_input",
    "validate_analysis_proposal",
    "validate_analysis_text",
    "validate_llm_request",
    "validate_llm_response",
)
