"""Frozen provider-neutral contracts for validated PDF analysis."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Final

from sciretriever.core.ids import validate_uuid
from sciretriever.normalization.contracts import PdfEvidenceLocator


SECTION_IDS: Final[tuple[str, ...]] = (
    "document_information", "abstract", "research_background",
    "research_question_and_objectives", "research_approach", "methods",
    "data_and_materials", "results", "conclusion", "limitations",
)
CANONICAL_FIELDS: Final[frozenset[str]] = frozenset({
    "title", "abstract", "language", "work_type", "publication_date",
    "publication_year", "publisher_id", "venue_id", "volume", "issue",
    "pages", "article_number", "open_access_status",
})
IDENTIFIER_NAMESPACES: Final[frozenset[str]] = frozenset({"doi", "arxiv", "pmid", "pmcid", "isbn", "issn"})


def _text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be non-blank text")
    return value


def _ids(values: tuple[str, ...], name: str, *, allow_empty: bool = False) -> None:
    if not isinstance(values, tuple) or (not values and not allow_empty):
        raise ValueError(f"{name} must contain evidence IDs")
    if len(values) != len(set(values)):
        raise ValueError(f"{name} contains duplicate IDs")
    for value in values:
        validate_uuid(value, name)


@dataclass(frozen=True, slots=True)
class AnalysisSection:
    section_id: str
    heading: str
    content: str
    insufficient_evidence: bool
    evidence_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        _text(self.heading, "heading")
        _text(self.content, "content")
        if type(self.insufficient_evidence) is not bool:
            raise TypeError("insufficient_evidence must be a boolean")
        _ids(self.evidence_ids, "section evidence_ids")

    def to_dict(self) -> dict[str, object]:
        return {"section_id": self.section_id, "heading": self.heading, "content": self.content,
                "insufficient_evidence": self.insufficient_evidence, "evidence_ids": list(self.evidence_ids)}


@dataclass(frozen=True, slots=True)
class CanonicalFieldProposal:
    field_name: str
    value: str | int
    evidence_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.field_name not in CANONICAL_FIELDS:
            raise ValueError("unsupported canonical field")
        if isinstance(self.value, str):
            _text(self.value, "canonical value")
            if self.field_name == "publication_date" and re.fullmatch(r"\d{4}(?:-\d{2}-\d{2})?", self.value) is None:
                raise ValueError("publication_date must be YYYY or YYYY-MM-DD")
            if self.field_name in {"publisher_id", "venue_id"}:
                validate_uuid(self.value, self.field_name)
        elif type(self.value) is not int or self.field_name != "publication_year" or self.value < 0:
            raise TypeError("canonical value has an invalid type")
        _ids(self.evidence_ids, "canonical field evidence_ids")

    def to_dict(self) -> dict[str, object]:
        return {"field_name": self.field_name, "value": self.value, "evidence_ids": list(self.evidence_ids)}


@dataclass(frozen=True, slots=True)
class AnalysisReference:
    reference_id: str
    order: int
    raw_reference: str
    resolved_work_id: str | None
    identifier_namespace: str | None
    identifier_value: str | None
    evidence_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        validate_uuid(self.reference_id, "reference_id")
        if type(self.order) is not int or self.order < 0:
            raise ValueError("reference order must be non-negative")
        _text(self.raw_reference, "raw_reference")
        if self.resolved_work_id is not None:
            validate_uuid(self.resolved_work_id, "resolved_work_id")
        if (self.identifier_namespace is None) != (self.identifier_value is None):
            raise ValueError("reference identifier namespace and value must be paired")
        if self.identifier_namespace is not None:
            if self.identifier_namespace not in IDENTIFIER_NAMESPACES:
                raise ValueError("unsupported reference identifier namespace")
            _text(self.identifier_value, "identifier_value")
        _ids(self.evidence_ids, "reference evidence_ids")

    def to_dict(self) -> dict[str, object]:
        return {"reference_id": self.reference_id, "order": self.order, "raw_reference": self.raw_reference,
                "resolved_work_id": self.resolved_work_id, "identifier_namespace": self.identifier_namespace,
                "identifier_value": self.identifier_value, "evidence_ids": list(self.evidence_ids)}


@dataclass(frozen=True, slots=True)
class NewTagProposal:
    canonical_name: str
    definition: str
    aliases: tuple[str, ...]

    def __post_init__(self) -> None:
        _text(self.canonical_name, "new tag canonical_name")
        _text(self.definition, "new tag definition")
        if not isinstance(self.aliases, tuple) or any(not isinstance(item, str) or not item.strip() for item in self.aliases):
            raise ValueError("new tag aliases must be non-blank text")

    def to_dict(self) -> dict[str, object]:
        return {"canonical_name": self.canonical_name, "definition": self.definition, "aliases": list(self.aliases)}


@dataclass(frozen=True, slots=True)
class NewEntityProposal:
    entity_type: str
    canonical_name: str

    def __post_init__(self) -> None:
        if self.entity_type not in {"publisher", "venue"}:
            raise ValueError("new entity type must be publisher or venue")
        _text(self.canonical_name, "new entity canonical_name")

    def to_dict(self) -> dict[str, object]:
        return {"entity_type": self.entity_type, "canonical_name": self.canonical_name}


@dataclass(frozen=True, slots=True)
class GeneratedTag:
    tag_id: str
    evidence_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        validate_uuid(self.tag_id, "tag_id")
        _ids(self.evidence_ids, "generated tag evidence_ids")

    def to_dict(self) -> dict[str, object]:
        return {"tag_id": self.tag_id, "evidence_ids": list(self.evidence_ids)}


@dataclass(frozen=True, slots=True)
class AnalysisDocument:
    sections: tuple[AnalysisSection, ...]
    canonical_fields: tuple[CanonicalFieldProposal, ...]
    references: tuple[AnalysisReference, ...]
    generated_tags: tuple[GeneratedTag, ...]
    new_tag_proposals: tuple[NewTagProposal, ...]
    new_entity_proposals: tuple[NewEntityProposal, ...]
    evidence: tuple[PdfEvidenceLocator, ...] = ()

    def __post_init__(self) -> None:
        if tuple(item.section_id for item in self.sections) != SECTION_IDS:
            raise ValueError("analysis sections must use the exact stable order")
        field_names = [item.field_name for item in self.canonical_fields]
        if len(field_names) != len(set(field_names)):
            raise ValueError("canonical fields contain duplicates")
        orders = [item.order for item in self.references]
        reference_ids = [item.reference_id for item in self.references]
        if len(orders) != len(set(orders)) or len(reference_ids) != len(set(reference_ids)):
            raise ValueError("references contain duplicate IDs or orders")
        tag_ids = [item.tag_id for item in self.generated_tags]
        if len(tag_ids) != len(set(tag_ids)):
            raise ValueError("generated tags contain duplicate IDs")
        evidence_ids = [item.evidence_id for item in self.evidence]
        if len(evidence_ids) != len(set(evidence_ids)):
            raise ValueError("analysis evidence contains duplicate IDs")
        used = {value for item in self.sections for value in item.evidence_ids}
        used.update(value for item in self.canonical_fields for value in item.evidence_ids)
        used.update(value for item in self.references for value in item.evidence_ids)
        used.update(value for item in self.generated_tags for value in item.evidence_ids)
        if self.evidence and set(evidence_ids) != used:
            raise ValueError("analysis evidence must exactly cover promoted evidence IDs")

    def to_dict(self) -> dict[str, object]:
        locators = {item.evidence_id: item.to_dict() for item in self.evidence}
        def enriched(value: AnalysisSection | CanonicalFieldProposal | AnalysisReference | GeneratedTag,
                     evidence_ids: tuple[str, ...]) -> dict[str, object]:
            result = value.to_dict()
            result["locators"] = [locators[item] for item in evidence_ids]
            return result
        return {"sections": [enriched(item, item.evidence_ids) for item in self.sections],
                "canonical_fields": [enriched(item, item.evidence_ids) for item in self.canonical_fields],
                "references": [enriched(item, item.evidence_ids) for item in self.references],
                "generated_tags": [enriched(item, item.evidence_ids) for item in self.generated_tags],
                "new_tag_proposals": [item.to_dict() for item in self.new_tag_proposals],
                "new_entity_proposals": [item.to_dict() for item in self.new_entity_proposals],
                "evidence": [item.to_dict() for item in self.evidence]}


@dataclass(frozen=True, slots=True)
class AnalysisProviderRequest:
    system_prompt: str
    input_json: str
    response_schema: dict[str, object]
    max_completion_tokens: int


@dataclass(frozen=True, slots=True)
class AnalysisProviderResponse:
    content: str
    provider: str
    model: str

    def __post_init__(self) -> None:
        _text(self.content, "provider response content")
        _text(self.provider, "provider response provider")
        _text(self.model, "provider response model")


__all__ = ("AnalysisDocument", "AnalysisProviderRequest", "AnalysisProviderResponse", "AnalysisReference",
           "AnalysisSection", "CANONICAL_FIELDS", "CanonicalFieldProposal", "GeneratedTag", "NewEntityProposal",
           "NewTagProposal", "SECTION_IDS")
