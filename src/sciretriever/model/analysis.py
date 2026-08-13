"""Neutral Analysis results and the current LiteratureContent contract."""

from __future__ import annotations

import json
from enum import Enum, unique
from typing import Annotated, Literal, Mapping, TypeAlias, cast

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sciretriever.model.literature import Identifier
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.primitives import (
    AssetId,
    LiteratureId,
    Sha256,
    SourceKind,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance

_MISSING = "未提供"
_ANALYSIS_INPUT_TAG = "sciretriever-literature-content-input-v1"
_RESERVED_SECTION_TITLES = frozenset(
    {
        "元数据",
        "摘要",
        "参考文献",
        "研究背景与目标",
        "研究方法",
        "数据",
        "结论与局限性",
    }
)


class _AnalysisModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


def _nonblank(value: str) -> str:
    candidate = value.strip()
    if not candidate:
        raise ValueError("must be a nonblank string")
    return candidate


def _optional_nonblank(value: str | None) -> str | None:
    return None if value is None else _nonblank(value)


@unique
class LiteratureSectionRole(str, Enum):
    """Closed roles for ordered body sections."""

    BACKGROUND_AND_OBJECTIVES = "background-and-objectives"
    METHODS = "methods"
    DATA = "data"
    CONCLUSIONS_AND_LIMITATIONS = "conclusions-and-limitations"
    ADDITIONAL = "additional"


class NoUsableContent(_AnalysisModel):
    """The explicit first-stage decision that the parsed content is unusable."""

    outcome: Literal["no_usable_content"]


class FinalMetadataProposal(_AnalysisModel):
    """The first-stage structured metadata proposal."""

    outcome: Literal["usable"]
    metadata: LiteratureMetadata


MetadataAnalysisResult: TypeAlias = Annotated[
    NoUsableContent | FinalMetadataProposal,
    Field(discriminator="outcome"),
]


class LiteratureSubsection(_AnalysisModel):
    """An ordered H2 and its Markdown body."""

    title: str
    markdown: str

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str) -> str:
        return _nonblank(value)

    @field_validator("markdown")
    @classmethod
    def validate_markdown(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("subsection Markdown must be nonblank")
        return value


class LiteratureSection(_AnalysisModel):
    """One ordered H1 section in the final structured content."""

    role: LiteratureSectionRole
    title: str | None = None
    markdown: str
    subsections: tuple[LiteratureSubsection, ...] = ()

    @field_validator("role", mode="before")
    @classmethod
    def validate_role(cls, value: object) -> LiteratureSectionRole:
        if isinstance(value, LiteratureSectionRole):
            return value
        if isinstance(value, str):
            try:
                return LiteratureSectionRole(value)
            except ValueError as error:
                raise ValueError("must be a supported Literature section role") from error
        raise TypeError("must be a supported Literature section role")

    @field_validator("title")
    @classmethod
    def validate_optional_title(cls, value: str | None) -> str | None:
        return _optional_nonblank(value)

    @field_validator("subsections", mode="before")
    @classmethod
    def normalize_subsections(cls, value: object) -> object:
        if isinstance(value, list):
            return tuple(cast(list[object], value))
        return value

    @model_validator(mode="after")
    def validate_section_title(self) -> "LiteratureSection":
        fixed_roles = {
            LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
            LiteratureSectionRole.METHODS,
            LiteratureSectionRole.DATA,
            LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
        }
        if self.role in fixed_roles and self.title is not None:
            raise ValueError("fixed Literature sections cannot have custom titles")
        if self.role is LiteratureSectionRole.ADDITIONAL:
            if self.title is None:
                raise ValueError("additional Literature sections require a title")
            if self.title in _RESERVED_SECTION_TITLES:
                raise ValueError("additional section title conflicts with a reserved title")
        return self


class ArtifactRef(_AnalysisModel):
    """A content-addressed final Markdown artifact descriptor."""

    sha256: Sha256
    media_type: str
    byte_size: int = Field(strict=True, ge=0)

    @field_validator("media_type")
    @classmethod
    def validate_media_type(cls, value: str) -> str:
        return _nonblank(value)


def _as_text(value: object) -> str:
    if isinstance(value, Enum):
        return str(value.value)
    root = getattr(value, "root", None)
    if isinstance(root, str):
        return root
    if isinstance(value, str):
        return value
    return str(value)


def _subsection_payload(value: LiteratureSubsection | Mapping[str, object]) -> dict[str, str]:
    if isinstance(value, LiteratureSubsection):
        return {"markdown": value.markdown, "title": value.title}
    return {
        "markdown": _as_text(value["markdown"]),
        "title": _as_text(value["title"]),
    }


def _section_payload(value: LiteratureSection | Mapping[str, object]) -> dict[str, object]:
    if isinstance(value, LiteratureSection):
        role: object = value.role
        title = value.title
        markdown = value.markdown
        subsections: object = value.subsections
    else:
        role = value["role"]
        title = value.get("title")
        markdown = value["markdown"]
        subsections = value["subsections"]
    if not isinstance(subsections, (tuple, list)):
        raise TypeError("subsections must be a tuple or list")
    checked_subsections = cast(
        tuple[LiteratureSubsection | Mapping[str, object], ...]
        | list[LiteratureSubsection | Mapping[str, object]],
        subsections,
    )
    return {
        "markdown": _as_text(markdown),
        "role": _as_text(role),
        "subsections": [_subsection_payload(item) for item in checked_subsections],
        "title": None if title is None else _as_text(title),
    }


def content_sha256(
    *,
    metadata_sha256: Sha256 | str,
    sections: tuple[LiteratureSection | Mapping[str, object], ...]
    | list[LiteratureSection | Mapping[str, object]],
    references: tuple[str, ...] | list[str],
) -> Sha256:
    """Compute the hash of metadata hash, ordered sections, and references only."""

    payload = {
        "metadata_sha256": _as_text(metadata_sha256),
        "references": [_as_text(reference) for reference in references],
        "sections": [_section_payload(section) for section in sections],
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return sha256_digest(encoded)


def analysis_input_sha256(
    primary_pdf_sha256: Sha256,
    parser_result_sha256: Sha256,
    metadata_sha256: Sha256,
) -> Sha256:
    """Bind one content Analysis result to its three canonical inputs."""

    checked_primary_pdf_sha256 = _require_sha256(
        primary_pdf_sha256,
        field_name="primary_pdf_sha256",
    )
    checked_parser_result_sha256 = _require_sha256(
        parser_result_sha256,
        field_name="parser_result_sha256",
    )
    checked_metadata_sha256 = _require_sha256(
        metadata_sha256,
        field_name="metadata_sha256",
    )
    payload = {
        "metadata_sha256": str(checked_metadata_sha256),
        "parser_result_sha256": str(checked_parser_result_sha256),
        "primary_pdf_sha256": str(checked_primary_pdf_sha256),
        "schema": _ANALYSIS_INPUT_TAG,
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return sha256_digest(encoded)


def _require_sha256(value: object, *, field_name: str) -> Sha256:
    if not isinstance(value, Sha256):
        raise TypeError(f"{field_name} must be Sha256")
    return value


def _validate_fixed_section_content(section: LiteratureSection) -> None:
    if section.markdown != _MISSING and section.markdown.strip() == _MISSING:
        raise ValueError("missing marker must be the exact string 未提供")
    if section.markdown == _MISSING:
        if section.subsections:
            raise ValueError("missing marker cannot be mixed with subsections")
        return
    if section.markdown.strip() or any(item.markdown.strip() for item in section.subsections):
        return
    raise ValueError("fixed Literature section must have content or the missing marker")


def _validate_additional_section_content(section: LiteratureSection) -> None:
    if section.title is None:
        raise ValueError("additional Literature sections require a title")
    if section.title in _RESERVED_SECTION_TITLES:
        raise ValueError("additional section title conflicts with a reserved title")
    if section.markdown != _MISSING and section.markdown.strip() == _MISSING:
        raise ValueError("missing marker must be the exact string 未提供")
    if section.markdown == _MISSING or (not section.markdown.strip() and not section.subsections):
        raise ValueError("empty additional Literature sections are not created")


class LiteratureContent(_AnalysisModel):
    """The one currently accepted structured content result for a Literature."""

    literature_content_sha256: Sha256
    metadata_revision: int = Field(strict=True, ge=1)
    metadata_sha256: Sha256
    sections: tuple[LiteratureSection, ...]
    references: tuple[str, ...] = ()
    markdown: ArtifactRef
    provenance: Provenance

    @field_validator("sections", mode="before")
    @classmethod
    def normalize_sections(cls, value: object) -> object:
        if isinstance(value, list):
            return tuple(cast(list[object], value))
        return value

    @field_validator("references", mode="before")
    @classmethod
    def normalize_references(cls, value: object) -> object:
        if isinstance(value, list):
            return tuple(cast(list[object], value))
        return value

    @field_validator("references")
    @classmethod
    def validate_references(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        normalized = tuple(_nonblank(item) for item in value)
        if any(item == _MISSING for item in normalized):
            raise ValueError("missing marker is not a reference")
        return normalized

    @field_validator("markdown")
    @classmethod
    def validate_markdown_artifact(cls, value: ArtifactRef) -> ArtifactRef:
        if value.media_type != "text/markdown":
            raise ValueError("LiteratureContent Markdown artifact must use text/markdown")
        if value.byte_size == 0:
            raise ValueError("LiteratureContent Markdown artifact must be non-empty")
        return value

    @model_validator(mode="after")
    def validate_content_structure(self) -> "LiteratureContent":
        self._validate_sections()
        self._validate_content_hash()
        self._validate_provenance()
        return self

    def _validate_sections(self) -> None:
        fixed_roles = (
            LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
            LiteratureSectionRole.METHODS,
            LiteratureSectionRole.DATA,
            LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
        )
        seen_fixed: list[LiteratureSectionRole] = []
        for section in self.sections:
            if section.role in fixed_roles:
                if section.role in seen_fixed:
                    raise ValueError("fixed Literature section roles must be unique")
                seen_fixed.append(section.role)
                _validate_fixed_section_content(section)
            else:
                _validate_additional_section_content(section)
        if tuple(seen_fixed) != fixed_roles:
            raise ValueError("all four fixed Literature section roles are required and ordered")

    def _validate_content_hash(self) -> None:
        expected = content_sha256(
            metadata_sha256=self.metadata_sha256,
            sections=self.sections,
            references=self.references,
        )
        if self.literature_content_sha256 != expected:
            raise ValueError("content hash does not match sections and references")

    def _validate_provenance(self) -> None:
        provenance = self.provenance
        if provenance.source_kind is not SourceKind.ANALYSIS:
            raise ValueError("LiteratureContent provenance must use source kind analysis")
        if provenance.source_record_id is not None:
            raise ValueError("LiteratureContent provenance cannot retain a source record ID")
        if provenance.input_sha256 is None or provenance.parameters_sha256 is None:
            raise ValueError("LiteratureContent provenance requires both input hashes")


class LiteratureContentProposal(_AnalysisModel):
    """A complete temporary Analysis result awaiting Literature acceptance.

    The proposal binds the two-stage result to the exact inputs consumed by
    Analysis but deliberately carries no authoritative output metadata
    revision.  Literature assigns that revision only while atomically
    accepting the complete result.
    """

    literature_id: LiteratureId
    primary_asset_id: AssetId
    primary_pdf_sha256: Sha256
    parser_result_sha256: Sha256
    input_metadata_revision: int = Field(strict=True, ge=1)
    input_metadata_sha256: Sha256
    final_metadata: LiteratureMetadata
    metadata_sha256: Sha256
    sections: tuple[LiteratureSection, ...]
    references: tuple[str, ...] = ()
    literature_content_sha256: Sha256
    markdown: ArtifactRef
    provenance: Provenance

    @field_validator("sections", mode="before")
    @classmethod
    def normalize_sections(cls, value: object) -> object:
        if isinstance(value, list):
            return tuple(cast(list[object], value))
        return value

    @field_validator("references", mode="before")
    @classmethod
    def normalize_references(cls, value: object) -> object:
        if isinstance(value, list):
            return tuple(cast(list[object], value))
        return value

    @field_validator("references")
    @classmethod
    def validate_references(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        normalized = tuple(_nonblank(item) for item in value)
        if any(item == _MISSING for item in normalized):
            raise ValueError("missing marker is not a reference")
        return normalized

    @field_validator("markdown")
    @classmethod
    def validate_markdown_artifact(cls, value: ArtifactRef) -> ArtifactRef:
        if value.media_type != "text/markdown":
            raise ValueError("LiteratureContent Markdown artifact must use text/markdown")
        if value.byte_size == 0:
            raise ValueError("LiteratureContent Markdown artifact must be non-empty")
        return value

    @model_validator(mode="after")
    def validate_proposal_structure(self) -> "LiteratureContentProposal":
        self._validate_sections()
        expected = content_sha256(
            metadata_sha256=self.metadata_sha256,
            sections=self.sections,
            references=self.references,
        )
        if self.literature_content_sha256 != expected:
            raise ValueError("content hash does not match sections and references")
        provenance = self.provenance
        if provenance.source_kind is not SourceKind.ANALYSIS:
            raise ValueError("LiteratureContent provenance must use source kind analysis")
        if provenance.source_record_id is not None:
            raise ValueError("LiteratureContent provenance cannot retain a source record ID")
        if provenance.input_sha256 is None or provenance.parameters_sha256 is None:
            raise ValueError("LiteratureContent provenance requires both input hashes")
        return self

    def _validate_sections(self) -> None:
        fixed_roles = (
            LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
            LiteratureSectionRole.METHODS,
            LiteratureSectionRole.DATA,
            LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
        )
        seen_fixed: list[LiteratureSectionRole] = []
        for section in self.sections:
            if section.role in fixed_roles:
                if section.role in seen_fixed:
                    raise ValueError("fixed Literature section roles must be unique")
                seen_fixed.append(section.role)
                _validate_fixed_section_content(section)
            else:
                _validate_additional_section_content(section)
        if tuple(seen_fixed) != fixed_roles:
            raise ValueError("all four fixed Literature section roles are required and ordered")


class ReferenceLookup(_AnalysisModel):
    """A temporary, non-persistent lookup hint extracted from reference text."""

    reference_index: int = Field(strict=True, ge=0)
    identifiers: tuple[Identifier, ...] = ()
    title: str | None = None
    authors: tuple[str, ...] = ()
    publication_year: int | None = Field(default=None, strict=True, ge=1, le=9999)

    @field_validator("identifiers", "authors", mode="before")
    @classmethod
    def normalize_collections(cls, value: object) -> object:
        if isinstance(value, list):
            return tuple(cast(list[object], value))
        return value

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str | None) -> str | None:
        return _optional_nonblank(value)

    @field_validator("authors")
    @classmethod
    def validate_authors(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(_nonblank(item) for item in value)

    @model_validator(mode="after")
    def validate_lookup_target(self) -> "ReferenceLookup":
        if not self.identifiers and self.title is None:
            raise ValueError("reference lookup requires an identifier or title")
        return self


__all__ = (
    "ArtifactRef",
    "FinalMetadataProposal",
    "LiteratureContent",
    "LiteratureContentProposal",
    "LiteratureSection",
    "LiteratureSectionRole",
    "LiteratureSubsection",
    "MetadataAnalysisResult",
    "NoUsableContent",
    "ReferenceLookup",
    "analysis_input_sha256",
    "content_sha256",
)
