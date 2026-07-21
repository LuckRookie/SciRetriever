"""Generic bounded normalization into the schema-v1 content model."""

from __future__ import annotations

from dataclasses import dataclass, field

from sciretriever.core.derivation import stable_derivation_id
from sciretriever.core.ids import validate_uuid
from sciretriever.core.package import (
    EvidenceLocator,
    NormalizedContent,
    ReferenceRecord,
    SectionRecord,
    TableCell,
    TableRecord,
)
from sciretriever.core.validation import normalize_content_text
from sciretriever.errors import NormalizationError
from sciretriever.normalization.contracts import (
    NormalizationDraft,
    NormalizationParameters,
    RawNormalizationInput,
    SourceUnit,
)
from sciretriever.normalization.identifiers import extract_identifiers
from sciretriever.normalization.markup import MarkupUnit, extract_html_units, extract_xml_units
from sciretriever.normalization.pdf import extract_pdf_units


NORMALIZER_NAME = "generic"
NORMALIZER_VERSION = "3"


@dataclass(slots=True)
class _CellBuilder:
    row_index: int
    column_index: int
    is_header: bool
    row_span: int
    column_span: int
    parts: list[str] = field(default_factory=list)


@dataclass(slots=True)
class _TableBuilder:
    ordinal: int
    caption_parts: list[str] = field(default_factory=list)
    notes_parts: list[str] = field(default_factory=list)
    cells: dict[tuple[int, int], _CellBuilder] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class _PendingEvidence:
    source_unit_id: str
    file_id: str
    source_end: int
    target_kind: str
    target_index: int
    target_start: int
    target_end: int
    cell_key: tuple[int, int] | None = None


def _stable_id(kind: str, source_key: str, ordinal: str | int) -> str:
    return stable_derivation_id(
        kind,
        {"normalizer_version": NORMALIZER_VERSION, "source_key": source_key, "ordinal": ordinal},
    )


def _input_units(
    value: RawNormalizationInput,
    parameters: NormalizationParameters,
) -> tuple[str, tuple[MarkupUnit, ...]]:
    payload = value.payload
    normalized_media_type = value.media_type.split(";", 1)[0].strip().lower()
    if normalized_media_type == "application/pdf":
        pdf_units = extract_pdf_units(payload, parameters.max_pages)
        if len(pdf_units) > parameters.max_structural_units:
            raise NormalizationError("PDF exceeds the configured structural-unit bound")
        return (
            "PDF_BLOCK",
            tuple(
                MarkupUnit(path, text, "section")
                for path, text in pdf_units
                if text.strip()
            ),
        )
    if normalized_media_type in {"application/xml", "text/xml", "application/jats+xml"}:
        return (
            "XML_NODE",
            extract_xml_units(
                payload,
                parameters.max_structural_units,
                parameters.max_depth,
                parameters.max_elements,
            ),
        )
    if normalized_media_type in {"text/html", "application/xhtml+xml"}:
        return (
            "HTML_NODE",
            extract_html_units(
                payload,
                parameters.max_structural_units,
                parameters.max_depth,
                parameters.max_elements,
            ),
        )
    raise NormalizationError(f"unsupported normalization media type: {value.media_type}")


def _mapping_path(pending: _PendingEvidence, tables: tuple[TableRecord, ...]) -> str:
    if pending.target_kind == "section":
        return f"/sections/{pending.target_index}/text"
    if pending.target_kind == "reference":
        return f"/references/{pending.target_index}/text"
    if pending.target_kind == "table_caption":
        return f"/tables/{pending.target_index}/caption"
    if pending.target_kind == "table_note":
        return f"/tables/{pending.target_index}/notes"
    if pending.cell_key is None:
        raise NormalizationError("table-cell evidence is missing a cell coordinate")
    cells = tables[pending.target_index].cells
    for index, cell in enumerate(cells):
        if (cell.row_index, cell.column_index) == pending.cell_key:
            return f"/tables/{pending.target_index}/cells/{index}/text"
    raise NormalizationError("table-cell evidence refers to a missing cell")


def normalize_inputs(
    inputs: tuple[RawNormalizationInput, ...],
    parameters: NormalizationParameters | None = None,
    *,
    work_id: str | None = None,
) -> NormalizationDraft:
    params = parameters or NormalizationParameters()
    if work_id is not None:
        work_id = validate_uuid(work_id, "work_id")
    if not isinstance(inputs, tuple) or not inputs:
        raise ValueError("inputs must be a non-empty tuple")
    if not all(isinstance(value, RawNormalizationInput) for value in inputs):
        raise TypeError("inputs must contain RawNormalizationInput values")
    ordered_inputs = tuple(sorted(inputs, key=lambda value: (value.role.value, value.file_id)))
    if len({value.file_id for value in ordered_inputs}) != len(ordered_inputs):
        raise NormalizationError("normalization inputs must have unique file ids")
    source_key = stable_derivation_id(
        "normalization_run",
        {
            "normalizer_version": NORMALIZER_VERSION,
            "work_id": work_id,
            "parameters": params.to_dict(),
            "inputs": [
                {
                    "file_id": value.file_id,
                    "role": value.role.value,
                    "media_type": value.media_type,
                    "sha256": value.sha256,
                }
                for value in ordered_inputs
            ],
        },
    )
    content_artifact_id = _stable_id("normalized_content", source_key, 0)
    source_map_artifact_id = _stable_id("source_map", source_key, 0)
    source_units: list[SourceUnit] = []
    sections: list[SectionRecord] = []
    references: list[ReferenceRecord] = []
    table_builders: dict[str, _TableBuilder] = {}
    pending_evidence: list[_PendingEvidence] = []
    total_characters = 0

    for value in ordered_inputs:
        if len(value.payload) > params.max_input_bytes:
            raise NormalizationError("source asset exceeds the configured input byte bound")
        _source_type, extracted_units = _input_units(value, params)
        for unit in extracted_units:
            text = normalize_content_text(unit.text, "source text", allow_blank=True)
            total_characters += len(text)
            if total_characters > params.max_text_characters:
                raise NormalizationError("normalized text exceeds the configured character bound")
            unit_index = len(source_units)
            source_unit_id = _stable_id(
                "source_unit",
                source_key,
                f"{value.file_id}:{unit_index}:{unit.path}:{text}",
            )
            source_units.append(SourceUnit(source_unit_id, value.file_id, unit_index, text, unit.path))
            if unit.kind == "reference":
                target_index = len(references)
                reference_id = _stable_id("reference", source_key, target_index)
                references.append(
                    ReferenceRecord(reference_id, target_index, text, extract_identifiers(text))
                )
                pending_evidence.append(
                    _PendingEvidence(
                        source_unit_id, value.file_id, len(text), "reference", target_index,
                        0, len(text),
                    )
                )
                continue
            if unit.table_key is None:
                target_index = len(sections)
                section_id = _stable_id("section", source_key, target_index)
                sections.append(SectionRecord(section_id, None, target_index, None, text))
                pending_evidence.append(
                    _PendingEvidence(
                        source_unit_id, value.file_id, len(text), "section", target_index,
                        0, len(text),
                    )
                )
                continue
            qualified_table_key = f"{value.file_id}:{unit.table_key}"
            builder = table_builders.get(qualified_table_key)
            if builder is None:
                builder = _TableBuilder(len(table_builders))
                table_builders[qualified_table_key] = builder
            if unit.kind == "table_cell":
                cell_key = (unit.row_index or 0, unit.column_index or 0)
                cell = builder.cells.get(cell_key)
                if cell is None:
                    cell = _CellBuilder(
                        cell_key[0], cell_key[1], unit.is_header, unit.row_span, unit.column_span,
                    )
                    builder.cells[cell_key] = cell
                else:
                    cell.is_header = cell.is_header or unit.is_header
                    cell.row_span = max(cell.row_span, unit.row_span)
                    cell.column_span = max(cell.column_span, unit.column_span)
                target_start = sum(len(part) for part in cell.parts)
                cell.parts.append(text)
                target_kind = "table_cell"
            elif unit.kind == "table_caption":
                target_start = sum(len(part) for part in builder.caption_parts)
                builder.caption_parts.append(text)
                target_kind = "table_caption"
                cell_key = None
            else:
                target_start = sum(len(part) for part in builder.notes_parts)
                builder.notes_parts.append(text)
                target_kind = "table_note"
                cell_key = None
            pending_evidence.append(
                _PendingEvidence(
                    source_unit_id,
                    value.file_id,
                    len(text),
                    target_kind,
                    builder.ordinal,
                    target_start,
                    target_start + len(text),
                    cell_key,
                )
            )

    tables: list[TableRecord] = []
    for builder in table_builders.values():
        table_id = _stable_id("table", source_key, builder.ordinal)
        cells = tuple(
            TableCell(
                row,
                column,
                "".join(cell.parts),
                cell.is_header,
                cell.row_span,
                cell.column_span,
            )
            for (row, column), cell in sorted(builder.cells.items())
        )
        caption = "".join(builder.caption_parts) or None
        notes = "".join(builder.notes_parts) or None
        tables.append(TableRecord(table_id, builder.ordinal, caption, cells, None, notes))
    table_records = tuple(tables)
    evidence = tuple(
        EvidenceLocator(
            evidence_id=_stable_id(
                "evidence",
                source_key,
                f"{pending.source_unit_id}:{_mapping_path(pending, table_records)}:{pending.target_start}",
            ),
            file_id=pending.file_id,
            source_artifact_id=source_map_artifact_id,
            source_unit_id=pending.source_unit_id,
            source_start=0,
            source_end=pending.source_end,
            normalized_path=_mapping_path(pending, table_records),
            normalized_start=pending.target_start,
            normalized_end=pending.target_end,
        )
        for pending in pending_evidence
    )
    normalized_content = NormalizedContent(
        artifact_id=content_artifact_id,
        sections=tuple(sections),
        tables=table_records,
        references=tuple(references),
    )
    return NormalizationDraft(
        content=normalized_content,
        evidence=evidence,
        source_units=tuple(source_units),
        source_map_artifact_id=source_map_artifact_id,
    )


__all__ = ("NORMALIZER_NAME", "NORMALIZER_VERSION", "normalize_inputs")
