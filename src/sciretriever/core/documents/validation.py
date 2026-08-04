from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

from typing_extensions import assert_never

from sciretriever.model import documents
from sciretriever.model.parsing import ManifestBlock
from sciretriever.model.primitives import AssetId

from .text import block_text


@dataclass(frozen=True, slots=True)
class LightDocumentError(Exception):
    code: str

    def __str__(self) -> str:
        return self.code


def _iter_sections(sections: tuple[documents.Section, ...]) -> Iterator[documents.Section]:
    for section in sections:
        yield section
        yield from _iter_sections(section.children)


def _iter_blocks(document: documents.LightDocumentV1) -> Iterator[documents.Block]:
    for section in _iter_sections(document.sections):
        yield from section.blocks


def _max_section_depth(sections: tuple[documents.Section, ...], depth: int = 1) -> int:
    if not sections:
        return depth - 1
    return max(
        depth,
        *(_max_section_depth(section.children, depth + 1) for section in sections),
    )


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


def _table_cells(block: documents.Block) -> int:
    match block:
        case documents.TableBlock(columns=columns, rows=rows):
            return len(columns) * len(rows)
        case (
            documents.ParagraphBlock()
            | documents.ListBlock()
            | documents.FormulaBlock()
            | documents.FigureCaptionBlock()
        ):
            return 0
        case unreachable:
            assert_never(unreachable)


def _iter_locators(document: documents.LightDocumentV1) -> Iterator[documents.SourceLocator]:
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


def _iter_text(document: documents.LightDocumentV1) -> Iterator[str]:
    if document.title is not None:
        yield document.title.text
    yield from (item.text for item in document.abstract)
    for section in _iter_sections(document.sections):
        if section.title is not None:
            yield section.title.text
        yield from (block_text(block) for block in section.blocks)
    for reference in document.references:
        yield reference.raw_text
        if reference.title is not None:
            yield reference.title
        if reference.source is not None:
            yield reference.source
        for author in reference.authors:
            yield author.display_name
            if author.family_name is not None:
                yield author.family_name
            if author.given_name is not None:
                yield author.given_name
            yield from author.affiliations


def validate_document_alignment(document: documents.LightDocumentV1, asset_id: AssetId) -> None:
    if any(locator.asset_id != asset_id for locator in _iter_locators(document)):
        raise LightDocumentError("document-asset-mismatch")


def validate_document_completeness(
    document: documents.LightDocumentV1,
    bounds: documents.LightDocumentBounds,
) -> None:
    blocks = tuple(_iter_blocks(document))
    if not document.sections or not blocks or not any(_iter_text(document)):
        raise LightDocumentError("document-no-body")
    if len(blocks) > bounds.max_blocks:
        raise LightDocumentError("block-bound")
    if sum(len(value) for value in _iter_text(document)) > bounds.max_text_characters:
        raise LightDocumentError("text-bound")
    cells = sum(_table_cells(block) for block in blocks)
    if cells > bounds.max_table_cells:
        raise LightDocumentError("table-cell-bound")


def _manifest_by_id(
    block_manifest: tuple[ManifestBlock, ...], pdf_pages: int
) -> dict[str, ManifestBlock]:
    manifest = {block.block_id: block for block in block_manifest}
    if len(manifest) != len(block_manifest):
        raise LightDocumentError("manifest-block-duplicate")
    if any(block.page_number > pdf_pages for block in block_manifest):
        raise LightDocumentError("manifest-block-page")
    return manifest


def _validate_block_ids(
    document: documents.LightDocumentV1, manifest: dict[str, ManifestBlock]
) -> None:
    block_ids = tuple(block.block_id for block in _iter_blocks(document))
    if len(block_ids) != len(set(block_ids)) or any(item not in manifest for item in block_ids):
        raise LightDocumentError("block-id")


def _validate_locator_bounds(
    document: documents.LightDocumentV1,
    pdf_pages: int,
    manifest: dict[str, ManifestBlock],
) -> None:
    for locator in _iter_locators(document):
        block = manifest.get(locator.block_id)
        if block is None or locator.page_start != block.page_number:
            raise LightDocumentError("locator-block-page")
        if locator.page_end != block.page_number or locator.page_end > pdf_pages:
            raise LightDocumentError("locator-block-page")
        if locator.char_end > block.char_length:
            raise LightDocumentError("locator-block-char")


def validate_light_document(
    document: documents.LightDocumentV1,
    asset_id: AssetId,
    pdf_pages: int,
    block_manifest: tuple[ManifestBlock, ...],
    bounds: documents.LightDocumentBounds,
) -> documents.LightDocumentV1:
    if pdf_pages < 1 or pdf_pages > bounds.max_pages:
        raise LightDocumentError("document-pages")
    if _max_section_depth(document.sections) > bounds.max_section_depth:
        raise LightDocumentError("section-depth")
    manifest = _manifest_by_id(block_manifest, pdf_pages)
    _validate_block_ids(document, manifest)
    locators = tuple(_iter_locators(document))
    if len(locators) > bounds.max_spans:
        raise LightDocumentError("span-bound")
    validate_document_alignment(document, asset_id)
    _validate_locator_bounds(document, pdf_pages, manifest)
    validate_document_completeness(document, bounds)
    return document


__all__ = (
    "LightDocumentError",
    "validate_document_alignment",
    "validate_document_completeness",
    "validate_light_document",
)
