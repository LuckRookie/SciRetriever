from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, TypeAlias, assert_never

from sciretriever.kernel import EvidenceText, Identifier, Provenance, SourceLocator
from sciretriever.kernel.ids import WorkId, WorkVersionId


@dataclass(frozen=True, slots=True)
class Author:
    display_name: str
    family_name: str | None
    given_name: str | None
    orcid: str | None
    affiliations: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ParagraphBlock:
    kind: Literal["paragraph"]
    block_id: str
    text: str
    evidence: tuple[SourceLocator, ...]


@dataclass(frozen=True, slots=True)
class ListBlock:
    kind: Literal["list"]
    block_id: str
    ordered: bool
    items: tuple[EvidenceText, ...]


@dataclass(frozen=True, slots=True)
class TableBlock:
    kind: Literal["table"]
    block_id: str
    caption: EvidenceText | None
    columns: tuple[str, ...]
    rows: tuple[tuple[str, ...], ...]
    evidence: tuple[SourceLocator, ...]


@dataclass(frozen=True, slots=True)
class FormulaBlock:
    kind: Literal["formula"]
    block_id: str
    text: str
    label: str | None
    evidence: tuple[SourceLocator, ...]


@dataclass(frozen=True, slots=True)
class FigureCaptionBlock:
    kind: Literal["figure-caption"]
    block_id: str
    text: str
    evidence: tuple[SourceLocator, ...]


Block: TypeAlias = ParagraphBlock | ListBlock | TableBlock | FormulaBlock | FigureCaptionBlock


@dataclass(frozen=True, slots=True)
class Section:
    section_id: str
    level: int
    title: EvidenceText | None
    blocks: tuple[Block, ...]
    children: tuple[Section, ...]


@dataclass(frozen=True, slots=True)
class ReferenceView:
    reference_id: str
    raw_text: str
    title: str | None
    authors: tuple[Author, ...]
    publication_year: int | None
    source: str | None
    identifiers: tuple[Identifier, ...]
    resolved_work_id: WorkId | None
    resolved_work_version_id: WorkVersionId | None
    evidence: tuple[SourceLocator, ...]


@dataclass(frozen=True, slots=True)
class LightDocumentV1:
    schema_version: Literal["1"]
    title: EvidenceText | None
    abstract: tuple[EvidenceText, ...]
    sections: tuple[Section, ...]
    references: tuple[ReferenceView, ...]
    provenance: tuple[Provenance, ...]

    def canonical_bytes(self) -> bytes:
        from sciretriever.content.light_serialization import document_bytes
        return document_bytes(self)


def block_text(block: Block) -> str:
    match block:
        case ParagraphBlock(text=text) | FormulaBlock(text=text) | FigureCaptionBlock(text=text):
            return text
        case ListBlock(items=items):
            return "".join(item.text for item in items)
        case TableBlock(caption=caption, columns=columns, rows=rows):
            return "".join((*columns, *(cell for row in rows for cell in row), "" if caption is None else caption.text))
        case unreachable:
            assert_never(unreachable)


__all__ = (
    "Author", "Block", "FigureCaptionBlock", "FormulaBlock", "LightDocumentV1",
    "ListBlock", "ParagraphBlock", "ReferenceView", "Section", "TableBlock",
)
