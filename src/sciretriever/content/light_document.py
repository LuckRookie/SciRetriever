from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Final
from uuid import UUID

from sciretriever.content.light_models import (
    Author,
    Block,
    FigureCaptionBlock,
    FormulaBlock,
    LightDocumentV1,
    ListBlock,
    ParagraphBlock,
    ReferenceView,
    Section,
    TableBlock,
)
from sciretriever.kernel import AssetId, EvidenceText, Identifier, Provenance, SourceLocator
from sciretriever.kernel.ids import WorkId, WorkVersionId
from sciretriever.kernel.json import CanonicalJsonInput

_DOCUMENT_FIELDS: Final = frozenset(
    ("schema_version", "title", "abstract", "sections", "references", "provenance")
)


@dataclass(frozen=True, slots=True)
class LightDocumentBounds:
    max_archive_bytes: int = 64 * 1024 * 1024
    max_member_bytes: int = 32 * 1024 * 1024
    max_extracted_bytes: int = 128 * 1024 * 1024
    max_json_bytes: int = 32 * 1024 * 1024
    max_json_depth: int = 64
    max_pages: int = 10_000
    max_blocks: int = 100_000
    max_spans: int = 500_000
    max_text_characters: int = 20_000_000
    max_table_cells: int = 1_000_000


@dataclass(frozen=True, slots=True)
class LightDocumentError(Exception):
    code: str

    def __str__(self) -> str:
        return self.code


@dataclass(frozen=True, slots=True)
class ManifestBlock:
    block_id: str
    page_number: int
    char_length: int


class _Budget:
    __slots__ = ("block_ids", "blocks", "bounds", "cells", "spans", "text")

    def __init__(self, bounds: LightDocumentBounds) -> None:
        self.bounds = bounds
        self.block_ids: set[str] = set()
        self.blocks = 0
        self.spans = 0
        self.text = 0
        self.cells = 0

    def add_text(self, value: str) -> str:
        if not isinstance(value, str) or not value.strip():
            raise LightDocumentError("invalid-text")
        self.text += len(value)
        if self.text > self.bounds.max_text_characters:
            raise LightDocumentError("text-bound")
        return value


def _closed(
    value: CanonicalJsonInput, fields: frozenset[str], name: str
) -> dict[str, CanonicalJsonInput]:
    if not isinstance(value, dict) or set(value) != fields:
        raise LightDocumentError(f"{name}-schema")
    return value


def _array(value: CanonicalJsonInput, name: str) -> list[CanonicalJsonInput]:
    if not isinstance(value, list):
        raise LightDocumentError(f"{name}-array")
    return value


def _optional_text(value: CanonicalJsonInput, name: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise LightDocumentError(f"{name}-text")
    return value


def _text(value: CanonicalJsonInput, name: str) -> str:
    if not isinstance(value, str):
        raise LightDocumentError(f"{name}-text")
    return value


def _integer(value: CanonicalJsonInput, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise LightDocumentError(f"{name}-integer")
    return value


def _locator(
    value: CanonicalJsonInput,
    asset_id: AssetId,
    pages: int,
    manifest: dict[str, ManifestBlock],
    budget: _Budget,
) -> SourceLocator:
    fields = _closed(
        value,
        frozenset(("asset_id", "page_start", "page_end", "block_id", "char_start", "char_end")),
        "locator",
    )
    try:
        locator = SourceLocator(
            AssetId(_text(fields["asset_id"], "asset-id")),
            _integer(fields["page_start"], "page-start"),
            _integer(fields["page_end"], "page-end"),
            _text(fields["block_id"], "block-id"),
            _integer(fields["char_start"], "char-start"),
            _integer(fields["char_end"], "char-end"),
        )
    except (TypeError, ValueError) as error:
        raise LightDocumentError("locator-value") from error
    if locator.asset_id != asset_id or locator.page_end > pages:
        raise LightDocumentError("locator-asset-page")
    block = manifest.get(locator.block_id)
    if (
        block is None
        or locator.page_start != block.page_number
        or locator.page_end != block.page_number
    ):
        raise LightDocumentError("locator-block-page")
    if locator.char_end > block.char_length or locator.char_start == locator.char_end:
        raise LightDocumentError("locator-block-char")
    budget.spans += 1
    if budget.spans > budget.bounds.max_spans:
        raise LightDocumentError("span-bound")
    return locator


def _locators(
    value: CanonicalJsonInput,
    asset_id: AssetId,
    pages: int,
    manifest: dict[str, ManifestBlock],
    budget: _Budget,
) -> tuple[SourceLocator, ...]:
    items = tuple(
        _locator(item, asset_id, pages, manifest, budget) for item in _array(value, "evidence")
    )
    if not items:
        raise LightDocumentError("missing-evidence")
    return tuple(
        sorted(
            items,
            key=lambda item: (
                str(item.asset_id),
                item.page_start,
                item.page_end,
                item.block_id,
                item.char_start,
                item.char_end,
            ),
        )
    )


def _evidence(
    value: CanonicalJsonInput,
    asset_id: AssetId,
    pages: int,
    manifest: dict[str, ManifestBlock],
    budget: _Budget,
) -> EvidenceText:
    fields = _closed(value, frozenset(("text", "evidence")), "evidence-text")
    return EvidenceText(
        budget.add_text(_text(fields["text"], "evidence")),
        _locators(fields["evidence"], asset_id, pages, manifest, budget),
    )


def _block(  # noqa: C901
    value: CanonicalJsonInput,
    asset_id: AssetId,
    pages: int,
    manifest: dict[str, ManifestBlock],
    budget: _Budget,
) -> Block:
    if not isinstance(value, dict) or not isinstance(value.get("kind"), str):
        raise LightDocumentError("block-schema")
    budget.blocks += 1
    if budget.blocks > budget.bounds.max_blocks:
        raise LightDocumentError("block-bound")
    kind = value["kind"]
    block_id = value.get("block_id")
    if not isinstance(block_id, str) or block_id not in manifest or block_id in budget.block_ids:
        raise LightDocumentError("block-id")
    budget.block_ids.add(block_id)
    if kind == "paragraph":
        fields = _closed(value, frozenset(("kind", "block_id", "text", "evidence")), "paragraph")
        return ParagraphBlock(
            "paragraph",
            block_id,
            budget.add_text(_text(fields["text"], "paragraph")),
            _locators(fields["evidence"], asset_id, pages, manifest, budget),
        )
    if kind == "list":
        fields = _closed(value, frozenset(("kind", "block_id", "ordered", "items")), "list")
        if not isinstance(fields["ordered"], bool):
            raise LightDocumentError("list-ordered")
        items = tuple(
            _evidence(item, asset_id, pages, manifest, budget)
            for item in _array(fields["items"], "items")
        )
        if not items:
            raise LightDocumentError("list-empty")
        return ListBlock("list", block_id, fields["ordered"], items)
    if kind == "table":
        fields = _closed(
            value,
            frozenset(("kind", "block_id", "caption", "columns", "rows", "evidence")),
            "table",
        )
        columns = tuple(
            budget.add_text(_text(item, "column")) for item in _array(fields["columns"], "columns")
        )
        rows = tuple(
            tuple(budget.add_text(_text(cell, "cell")) for cell in _array(row, "row"))
            for row in _array(fields["rows"], "rows")
        )
        if not columns or any(len(row) != len(columns) for row in rows):
            raise LightDocumentError("table-shape")
        budget.cells += len(columns) * len(rows)
        if budget.cells > budget.bounds.max_table_cells:
            raise LightDocumentError("table-cell-bound")
        caption = (
            None
            if fields["caption"] is None
            else _evidence(fields["caption"], asset_id, pages, manifest, budget)
        )
        return TableBlock(
            "table",
            block_id,
            caption,
            columns,
            rows,
            _locators(fields["evidence"], asset_id, pages, manifest, budget),
        )
    if kind == "formula":
        fields = _closed(
            value, frozenset(("kind", "block_id", "text", "label", "evidence")), "formula"
        )
        return FormulaBlock(
            "formula",
            block_id,
            budget.add_text(_text(fields["text"], "formula")),
            _optional_text(fields["label"], "label"),
            _locators(fields["evidence"], asset_id, pages, manifest, budget),
        )
    if kind == "figure-caption":
        fields = _closed(
            value, frozenset(("kind", "block_id", "text", "evidence")), "figure-caption"
        )
        return FigureCaptionBlock(
            "figure-caption",
            block_id,
            budget.add_text(_text(fields["text"], "figure-caption")),
            _locators(fields["evidence"], asset_id, pages, manifest, budget),
        )
    raise LightDocumentError("block-kind")


def _section(
    value: CanonicalJsonInput,
    asset_id: AssetId,
    pages: int,
    manifest: dict[str, ManifestBlock],
    budget: _Budget,
    depth: int,
) -> Section:
    if depth > 32 or depth > budget.bounds.max_json_depth:
        raise LightDocumentError("section-depth")
    fields = _closed(
        value, frozenset(("section_id", "level", "title", "blocks", "children")), "section"
    )
    if not isinstance(fields["section_id"], str) or not fields["section_id"].strip():
        raise LightDocumentError("section-id")
    if (
        not isinstance(fields["level"], int)
        or isinstance(fields["level"], bool)
        or fields["level"] < 1
    ):
        raise LightDocumentError("section-level")
    title = (
        None
        if fields["title"] is None
        else _evidence(fields["title"], asset_id, pages, manifest, budget)
    )
    blocks = tuple(
        _block(item, asset_id, pages, manifest, budget)
        for item in _array(fields["blocks"], "blocks")
    )
    children = tuple(
        _section(item, asset_id, pages, manifest, budget, depth + 1)
        for item in _array(fields["children"], "children")
    )
    return Section(fields["section_id"], fields["level"], title, blocks, children)


def _author(value: CanonicalJsonInput, budget: _Budget) -> Author:
    fields = _closed(
        value,
        frozenset(("display_name", "family_name", "given_name", "orcid", "affiliations")),
        "author",
    )
    affiliations = tuple(
        budget.add_text(_text(item, "affiliation"))
        for item in _array(fields["affiliations"], "affiliations")
    )
    if len(affiliations) != len(set(affiliations)):
        raise LightDocumentError("author-affiliation-duplicate")
    return Author(
        budget.add_text(_text(fields["display_name"], "display-name")),
        _optional_text(fields["family_name"], "family-name"),
        _optional_text(fields["given_name"], "given-name"),
        _optional_text(fields["orcid"], "orcid"),
        affiliations,
    )


def _reference(
    value: CanonicalJsonInput,
    asset_id: AssetId,
    pages: int,
    manifest: dict[str, ManifestBlock],
    budget: _Budget,
) -> ReferenceView:
    fields = _closed(
        value,
        frozenset(
            (
                "reference_id",
                "raw_text",
                "title",
                "authors",
                "publication_year",
                "source",
                "identifiers",
                "resolved_work_id",
                "resolved_work_version_id",
                "evidence",
            )
        ),
        "reference",
    )
    reference_id = _text(fields["reference_id"], "reference-id")
    try:
        UUID(reference_id)
    except ValueError as error:
        raise LightDocumentError("reference-id") from error
    identifiers = tuple(
        Identifier.from_json(
            json.dumps(item, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
        )
        for item in _array(fields["identifiers"], "identifiers")
    )
    if len(identifiers) != len(set(identifiers)):
        raise LightDocumentError("reference-identifier-duplicate")
    year = fields["publication_year"]
    if year is not None and (not isinstance(year, int) or isinstance(year, bool)):
        raise LightDocumentError("reference-year")
    resolved_work = fields["resolved_work_id"]
    resolved_version = fields["resolved_work_version_id"]
    return ReferenceView(
        reference_id,
        budget.add_text(_text(fields["raw_text"], "raw-text")),
        _optional_text(fields["title"], "reference-title"),
        tuple(_author(item, budget) for item in _array(fields["authors"], "authors")),
        year,
        _optional_text(fields["source"], "reference-source"),
        identifiers,
        None if resolved_work is None else WorkId(_text(resolved_work, "resolved-work-id")),
        None
        if resolved_version is None
        else WorkVersionId(_text(resolved_version, "resolved-version-id")),
        _locators(fields["evidence"], asset_id, pages, manifest, budget),
    )


def _provenance(value: CanonicalJsonInput) -> Provenance:
    if not isinstance(value, dict):
        raise LightDocumentError("provenance-schema")
    try:
        return Provenance.from_json(
            json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
        )
    except (TypeError, ValueError) as error:
        raise LightDocumentError("provenance-value") from error


def validate_light_document(
    value: CanonicalJsonInput,
    asset_id: AssetId,
    pdf_pages: int,
    block_manifest: tuple[ManifestBlock, ...],
    bounds: LightDocumentBounds,
) -> LightDocumentV1:
    fields = _closed(value, _DOCUMENT_FIELDS, "light-document")
    if fields["schema_version"] != "1" or pdf_pages < 1 or pdf_pages > bounds.max_pages:
        raise LightDocumentError("document-version-pages")
    manifest = {block.block_id: block for block in block_manifest}
    if len(manifest) != len(block_manifest):
        raise LightDocumentError("manifest-block-duplicate")
    if any(
        block.page_number < 1 or block.page_number > pdf_pages or block.char_length < 1
        for block in block_manifest
    ):
        raise LightDocumentError("manifest-block-value")
    budget = _Budget(bounds)
    title = (
        None
        if fields["title"] is None
        else _evidence(fields["title"], asset_id, pdf_pages, manifest, budget)
    )
    abstract = tuple(
        _evidence(item, asset_id, pdf_pages, manifest, budget)
        for item in _array(fields["abstract"], "abstract")
    )
    sections = tuple(
        _section(item, asset_id, pdf_pages, manifest, budget, 1)
        for item in _array(fields["sections"], "sections")
    )
    if not sections or budget.blocks == 0 or budget.text == 0:
        raise LightDocumentError("document-no-body")
    references = tuple(
        _reference(item, asset_id, pdf_pages, manifest, budget)
        for item in _array(fields["references"], "references")
    )
    provenance = tuple(_provenance(item) for item in _array(fields["provenance"], "provenance"))
    if len({item.reference_id for item in references}) != len(references):
        raise LightDocumentError("reference-duplicate")
    if len({item.provenance_id for item in provenance}) != len(provenance):
        raise LightDocumentError("provenance-duplicate")
    return LightDocumentV1("1", title, abstract, sections, references, provenance)


__all__ = (
    "LightDocumentBounds",
    "LightDocumentError",
    "LightDocumentV1",
    "ManifestBlock",
    "validate_light_document",
)
