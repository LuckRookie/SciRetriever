from __future__ import annotations

from typing import Annotated, Literal, TypeAlias

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator

from sciretriever.model.canonical_json import JsonOutput
from sciretriever.model.documents import EvidenceText, ReferenceView, SourceLocator
from sciretriever.model.literature import Author, Identifier


class _AnalysisModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


def _strict_text(value: str | None) -> str | None:
    if value is not None and not value.strip():
        raise ValueError("text must be nonblank or null")
    return value


Text = Annotated[str, Field(min_length=1, max_length=100_000), AfterValidator(_strict_text)]
OptionalText = Annotated[str | None, Field(max_length=100_000), AfterValidator(_strict_text)]
AnalysisJsonSchema: TypeAlias = dict[str, JsonOutput]


class UnifiedMetadataValues(_AnalysisModel):
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
        keys = tuple((item.namespace, item.value) for item in ordered)
        if len(keys) != len(set(keys)):
            raise ValueError("duplicate identifiers")
        return ordered


class Classification(_AnalysisModel):
    document_type: OptionalText
    language: OptionalText
    subjects: Annotated[tuple[EvidenceText, ...], Field(max_length=10_000)]


class ContentOverview(_AnalysisModel):
    summary: EvidenceText | None
    conclusions: Annotated[tuple[EvidenceText, ...], Field(max_length=10_000)]


class ConclusionsAndLimitations(_AnalysisModel):
    conclusions: Annotated[tuple[EvidenceText, ...], Field(max_length=10_000)]
    limitations: Annotated[tuple[EvidenceText, ...], Field(max_length=10_000)]


class KeywordsAndTags(_AnalysisModel):
    keywords: Annotated[tuple[Text, ...], Field(max_length=10_000)]
    tags: Annotated[tuple[Text, ...], Field(max_length=10_000)]

    @field_validator("keywords", "tags")
    @classmethod
    def canonical_terms(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        ordered = tuple(sorted(value, key=lambda text: (text.casefold(), text)))
        if len(ordered) != len(set(ordered)):
            raise ValueError("duplicate terms")
        return ordered


class AnalysisProposalV1(_AnalysisModel):
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


__all__ = (
    "AnalysisJsonSchema",
    "AnalysisProposalV1",
    "Author",
    "Classification",
    "ConclusionsAndLimitations",
    "ContentOverview",
    "EvidenceText",
    "Identifier",
    "KeywordsAndTags",
    "ReferenceView",
    "SourceLocator",
    "UnifiedMetadataValues",
)
