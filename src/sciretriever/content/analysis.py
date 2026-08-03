from __future__ import annotations

import json
from dataclasses import dataclass

from pydantic import ValidationError

import sciretriever.model.analysis as analysis_models
import sciretriever.model.execution as execution_models
from sciretriever.core.documents import document_bytes
from sciretriever.model import documents
from sciretriever.model.analysis import (
    AnalysisProposalV1,
    Classification,
    ConclusionsAndLimitations,
    ContentOverview,
    KeywordsAndTags,
    ReferenceView,
    UnifiedMetadataValues,
)


@dataclass(frozen=True, slots=True)
class AnalysisBounds:
    max_input_characters: int
    max_source_units: int
    max_output_characters: int = 10_000_000


class AnalysisValidationError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code
        self.reason = execution_models.Reason(value="Analysis output failed strict validation.")
        self.action = execution_models.Action(
            value="Retry with a supported model and complete source evidence."
        )

    def __str__(self) -> str:
        return self.code


def analysis_bytes(value: AnalysisProposalV1) -> bytes:
    return json.dumps(
        value.model_dump(mode="json"),
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")


def analysis_json_schema() -> analysis_models.AnalysisJsonSchema:
    return AnalysisProposalV1.model_json_schema()


def validate_analysis_text(
    payload: str, document: documents.LightDocumentV1, bounds: AnalysisBounds
) -> AnalysisProposalV1:
    if len(payload) > bounds.max_output_characters:
        raise AnalysisValidationError("analysis_output_too_large")
    try:
        proposal = AnalysisProposalV1.model_validate_json(payload)
    except ValidationError as error:
        raise AnalysisValidationError("analysis_invalid_output") from error
    allowed = _document_locator_bounds(document)
    if any(not _locator_resolves(locator, allowed) for locator in _proposal_locators(proposal)):
        raise AnalysisValidationError("analysis_invalid_evidence")
    return proposal


def validate_analysis_input(document: documents.LightDocumentV1, bounds: AnalysisBounds) -> str:
    payload = document_bytes(document).decode("ascii")
    if (
        len(payload) > bounds.max_input_characters
        or _source_units(document.sections) > bounds.max_source_units
    ):
        raise AnalysisValidationError("analysis_input_too_large")
    return payload


def _document_locator_bounds(
    document: documents.LightDocumentV1,
) -> dict[tuple[str, int, int, str], int]:
    value = json.loads(document_bytes(document))
    found: dict[tuple[str, int, int, str], int] = {}

    def visit(item: object) -> None:
        if isinstance(item, dict):
            if set(item) == {
                "asset_id",
                "page_start",
                "page_end",
                "block_id",
                "char_start",
                "char_end",
            }:
                key = (item["asset_id"], item["page_start"], item["page_end"], item["block_id"])
                found[key] = max(found.get(key, 0), item["char_end"])
            else:
                for nested in item.values():
                    visit(nested)
        elif isinstance(item, list):
            for nested in item:
                visit(nested)

    visit(value)
    return found


def _locator_resolves(
    locator: tuple[str, int, int, str, int, int], allowed: dict[tuple[str, int, int, str], int]
) -> bool:
    asset, page_start, page_end, block_id, char_start, char_end = locator
    return char_start < char_end <= allowed.get((asset, page_start, page_end, block_id), -1)


def _proposal_locators(proposal: AnalysisProposalV1) -> set[tuple[str, int, int, str, int, int]]:
    found: set[tuple[str, int, int, str, int, int]] = set()

    def visit(item: object) -> None:
        if isinstance(item, dict):
            if set(item) == {
                "asset_id",
                "page_start",
                "page_end",
                "block_id",
                "char_start",
                "char_end",
            }:
                found.add(
                    (
                        item["asset_id"],
                        item["page_start"],
                        item["page_end"],
                        item["block_id"],
                        item["char_start"],
                        item["char_end"],
                    )
                )
            else:
                for nested in item.values():
                    visit(nested)
        elif isinstance(item, list):
            for nested in item:
                visit(nested)

    visit(proposal.model_dump(mode="json"))
    return found


def _source_units(sections: tuple[documents.Section, ...]) -> int:
    return sum(len(section.blocks) + _source_units(section.children) for section in sections)


__all__ = (
    "AnalysisBounds",
    "AnalysisValidationError",
    "Classification",
    "ConclusionsAndLimitations",
    "ContentOverview",
    "KeywordsAndTags",
    "ReferenceView",
    "UnifiedMetadataValues",
    "analysis_bytes",
    "analysis_json_schema",
    "validate_analysis_input",
    "validate_analysis_text",
)
