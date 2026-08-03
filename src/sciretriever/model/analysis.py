from __future__ import annotations

from typing import Annotated, Final, Literal, TypeAlias

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator

from sciretriever.model.assets import PublishedArtifact
from sciretriever.model.canonical_json import JsonOutput
from sciretriever.model.documents import EvidenceText, LightDocumentV1, ReferenceView, SourceLocator
from sciretriever.model.literature import (
    Author,
    CompletionSubmission,
    Identifier,
)
from sciretriever.model.primitives import (
    LightDocumentId,
    MetadataSnapshotId,
    Sha256,
    WorkVersionId,
)


class _AnalysisModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class _AnalysisStructureError(ValueError):
    pass


def _strict_text(value: str | None) -> str | None:
    if value is not None and not value.strip():
        raise _AnalysisStructureError("text must be nonblank or null")
    return value


Text = Annotated[str, Field(min_length=1, max_length=100_000), AfterValidator(_strict_text)]
OptionalText = Annotated[str | None, Field(max_length=100_000), AfterValidator(_strict_text)]
AnalysisJsonSchema: TypeAlias = dict[str, JsonOutput]

ANALYSIS_CATEGORIES: Final[tuple[str, ...]] = (
    "final_bibliography",
    "classification",
    "content_overview",
    "research_objectives",
    "methods",
    "key_results",
    "conclusions_and_limitations",
    "keywords_and_tags",
    "references",
)


class AnalysisBounds(_AnalysisModel):
    max_input_characters: int = Field(strict=True, gt=0)
    max_source_units: int = Field(strict=True, gt=0)
    max_output_characters: int = Field(default=10_000_000, strict=True, gt=0)


class AnalysisContext(_AnalysisModel):
    document: LightDocumentV1 = Field(repr=False)
    bounds: AnalysisBounds
    max_output_tokens: int = Field(strict=True, gt=0)


class AnalysisTarget(_AnalysisModel):
    work_version_id: WorkVersionId
    light_document_id: LightDocumentId
    light_document_sha256: Sha256
    metadata_snapshot_id: MetadataSnapshotId
    metadata_revision: int = Field(strict=True, ge=1)
    metadata_sha256: Sha256
    parser_identity: str = Field(min_length=1)
    model_provider: str = Field(min_length=1)
    model_identity: str = Field(min_length=1)
    parameters_sha256: Sha256


class AnalysisResult(_AnalysisModel):
    artifact: PublishedArtifact
    submission: CompletionSubmission


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
            raise _AnalysisStructureError("duplicate identifiers")
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
            raise _AnalysisStructureError("duplicate terms")
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
    "ANALYSIS_CATEGORIES",
    "AnalysisJsonSchema",
    "AnalysisBounds",
    "AnalysisContext",
    "AnalysisProposalV1",
    "AnalysisResult",
    "AnalysisTarget",
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
