from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Annotated, Literal, TypeAlias

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from sciretriever.content.light_models import LightDocumentV1, Section
from sciretriever.kernel.errors import Action, Reason
from sciretriever.kernel.json import JsonOutput


class ProposalValueError(ValueError):
    pass


def _strict_text(value: str | None) -> str | None:
    if value is not None and not value.strip():
        raise ProposalValueError("text must be nonblank or null")
    return value


Text = Annotated[str, Field(min_length=1, max_length=100_000), AfterValidator(_strict_text)]
OptionalText = Annotated[str | None, Field(max_length=100_000), AfterValidator(_strict_text)]
IdentifierNamespace = Annotated[Text, Field(max_length=128)]
IdentifierValue = Annotated[Text, Field(max_length=2048)]
UUIDText = Annotated[
    str, Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
]
AnalysisJsonSchema: TypeAlias = dict[str, JsonOutput]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class SourceLocator(_StrictModel):
    asset_id: UUIDText
    page_start: Annotated[int, Field(ge=1)]
    page_end: Annotated[int, Field(ge=1)]
    block_id: Text
    char_start: Annotated[int, Field(ge=0)]
    char_end: Annotated[int, Field(ge=0)]


class EvidenceText(_StrictModel):
    text: Text
    evidence: Annotated[tuple[SourceLocator, ...], Field(min_length=1, max_length=10_000)]

    @field_validator("evidence")
    @classmethod
    def canonical_evidence(cls, value: tuple[SourceLocator, ...]) -> tuple[SourceLocator, ...]:
        ordered = tuple(sorted(value, key=_locator_key))
        if len(ordered) != len(set(ordered)):
            raise ProposalValueError("duplicate evidence")
        return ordered


class Identifier(_StrictModel):
    namespace: IdentifierNamespace
    value: IdentifierValue


class Author(_StrictModel):
    display_name: Text
    family_name: OptionalText
    given_name: OptionalText
    orcid: OptionalText
    affiliations: Annotated[tuple[Text, ...], Field(max_length=1000)]

    @field_validator("affiliations")
    @classmethod
    def canonical_affiliations(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        ordered = tuple(sorted(value, key=lambda text: (text.casefold(), text)))
        if len(ordered) != len(set(ordered)):
            raise ProposalValueError("duplicate affiliations")
        return ordered


class UnifiedMetadataValues(_StrictModel):
    title: Text
    authors: Annotated[tuple[Author, ...], Field(max_length=10_000)]
    abstract: OptionalText
    publication_date: OptionalText
    publication_year: Annotated[int | None, Field(ge=0, le=9999)]
    document_type: OptionalText
    language: OptionalText
    venue: OptionalText
    publisher: OptionalText
    volume: OptionalText
    issue: OptionalText
    pages: OptionalText
    article_number: OptionalText
    open_access_status: OptionalText
    identifiers: Annotated[tuple[Identifier, ...], Field(max_length=10_000)]

    @field_validator("identifiers")
    @classmethod
    def canonical_identifiers(cls, value: tuple[Identifier, ...]) -> tuple[Identifier, ...]:
        ordered = tuple(sorted(value, key=lambda item: (item.namespace, item.value)))
        if len(ordered) != len(set(ordered)):
            raise ProposalValueError("duplicate identifiers")
        return ordered


class ReferenceView(_StrictModel):
    reference_id: UUIDText
    raw_text: Text
    title: OptionalText
    authors: Annotated[tuple[Author, ...], Field(max_length=10_000)]
    publication_year: Annotated[int | None, Field(ge=0, le=9999)]
    source: OptionalText
    identifiers: Annotated[tuple[Identifier, ...], Field(max_length=10_000)]
    resolved_work_id: UUIDText | None
    resolved_work_version_id: UUIDText | None
    evidence: Annotated[tuple[SourceLocator, ...], Field(min_length=1, max_length=10_000)]

    @field_validator("identifiers")
    @classmethod
    def canonical_identifiers(cls, value: tuple[Identifier, ...]) -> tuple[Identifier, ...]:
        return UnifiedMetadataValues.canonical_identifiers(value)

    @field_validator("evidence")
    @classmethod
    def canonical_evidence(cls, value: tuple[SourceLocator, ...]) -> tuple[SourceLocator, ...]:
        return EvidenceText.canonical_evidence(value)


class Classification(_StrictModel):
    document_type: OptionalText
    language: OptionalText
    subjects: Annotated[tuple[EvidenceText, ...], Field(max_length=10_000)]


class ContentOverview(_StrictModel):
    summary: EvidenceText | None
    conclusions: Annotated[tuple[EvidenceText, ...], Field(max_length=10_000)]


class ConclusionsAndLimitations(_StrictModel):
    conclusions: Annotated[tuple[EvidenceText, ...], Field(max_length=10_000)]
    limitations: Annotated[tuple[EvidenceText, ...], Field(max_length=10_000)]


class KeywordsAndTags(_StrictModel):
    keywords: Annotated[tuple[Text, ...], Field(max_length=10_000)]
    tags: Annotated[tuple[Text, ...], Field(max_length=10_000)]

    @field_validator("keywords", "tags")
    @classmethod
    def canonical_terms(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        ordered = tuple(sorted(value, key=lambda text: (text.casefold(), text)))
        if len(ordered) != len(set(ordered)):
            raise ProposalValueError("duplicate terms")
        return ordered


class AnalysisProposalV1(_StrictModel):
    schema_version: Literal["1"]
    final_bibliography: UnifiedMetadataValues
    classification: Classification
    content_overview: ContentOverview
    research_objectives: Annotated[tuple[EvidenceText, ...], Field(max_length=10_000)]
    methods: Annotated[tuple[EvidenceText, ...], Field(max_length=10_000)]
    key_results: Annotated[tuple[EvidenceText, ...], Field(max_length=10_000)]
    conclusions_and_limitations: ConclusionsAndLimitations
    keywords_and_tags: KeywordsAndTags
    references: Annotated[tuple[ReferenceView, ...], Field(max_length=100_000)]

    @model_validator(mode="after")
    def unique_references(self) -> AnalysisProposalV1:
        ids = tuple(item.reference_id for item in self.references)
        if len(ids) != len(set(ids)):
            raise ProposalValueError("duplicate references")
        return self

    def canonical_bytes(self) -> bytes:
        return json.dumps(
            self.model_dump(mode="json"),
            ensure_ascii=True,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii")


@dataclass(frozen=True, slots=True)
class AnalysisBounds:
    max_input_characters: int
    max_source_units: int
    max_output_characters: int = 10_000_000


class AnalysisValidationError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code
        self.reason = Reason("Analysis output failed strict validation.")
        self.action = Action("Retry with a supported model and complete source evidence.")

    def __str__(self) -> str:
        return self.code


def analysis_json_schema() -> AnalysisJsonSchema:
    return AnalysisProposalV1.model_json_schema()


def validate_analysis_text(
    payload: str, document: LightDocumentV1, bounds: AnalysisBounds
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


def validate_analysis_input(document: LightDocumentV1, bounds: AnalysisBounds) -> str:
    payload = document.canonical_bytes().decode("ascii")
    if (
        len(payload) > bounds.max_input_characters
        or _source_units(document.sections) > bounds.max_source_units
    ):
        raise AnalysisValidationError("analysis_input_too_large")
    return payload


def _locator_key(value: SourceLocator) -> tuple[str, int, int, str, int, int]:
    return (
        value.asset_id,
        value.page_start,
        value.page_end,
        value.block_id,
        value.char_start,
        value.char_end,
    )


def _document_locator_bounds(document: LightDocumentV1) -> dict[tuple[str, int, int, str], int]:
    value = json.loads(document.canonical_bytes())
    found: dict[tuple[str, int, int, str], int] = {}

    def visit(item) -> None:
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
    value = proposal.model_dump(mode="json")

    def visit(item) -> None:
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

    visit(value)
    return found


def _source_units(sections: tuple[Section, ...]) -> int:
    return sum(len(section.blocks) + _source_units(section.children) for section in sections)


__all__ = (
    "AnalysisBounds",
    "AnalysisProposalV1",
    "AnalysisValidationError",
    "Classification",
    "ConclusionsAndLimitations",
    "ContentOverview",
    "KeywordsAndTags",
    "ReferenceView",
    "UnifiedMetadataValues",
    "analysis_json_schema",
    "validate_analysis_input",
    "validate_analysis_text",
)
