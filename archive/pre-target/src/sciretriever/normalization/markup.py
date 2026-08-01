"""Bounded XML and HTML extraction with generic table ownership."""

from __future__ import annotations

from dataclasses import dataclass

from bs4 import BeautifulSoup
from bs4.element import NavigableString, Tag
from xml.etree import ElementTree

from sciretriever.errors import NormalizationError


_REFERENCE_TAGS = frozenset({"ref", "reference", "mixed-citation", "element-citation", "bibitem"})
_TABLE_TAGS = frozenset({"table", "table-wrap"})
_ROW_TAGS = frozenset({"tr", "row"})
_CELL_TAGS = frozenset({"td", "th", "entry"})
_CAPTION_TAGS = frozenset({"caption", "title", "label"})
_NOTE_TAGS = frozenset({"note", "notes", "table-wrap-foot", "tfoot"})


@dataclass(frozen=True, slots=True)
class MarkupUnit:
    path: str
    text: str
    kind: str
    table_key: str | None = None
    row_index: int | None = None
    column_index: int | None = None
    is_header: bool = False
    row_span: int = 1
    column_span: int = 1


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _positive_span(value: object | None) -> int:
    if value is None:
        return 1
    try:
        parsed = int(str(value))
    except ValueError:
        return 1
    return max(1, parsed)


def extract_xml_units(
    payload: bytes,
    max_units: int,
    max_depth: int,
    max_elements: int,
) -> tuple[MarkupUnit, ...]:
    upper = payload.upper()
    if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
        raise NormalizationError("XML declarations with DTDs or entities are unsupported")
    try:
        root = ElementTree.fromstring(payload)
    except ElementTree.ParseError as error:
        raise NormalizationError(f"XML parsing failed: {error}") from error
    units: list[MarkupUnit] = []
    element_count = 0
    table_count = 0
    table_row_counts: dict[str, int] = {}

    def visit(
        element: ElementTree.Element,
        path: str,
        depth: int,
        reference_context: bool,
        table_key: str | None,
        row_index: int | None,
        column_index: int | None,
        table_kind: str | None,
        cell_is_header: bool,
        cell_row_span: int,
        cell_column_span: int,
    ) -> None:
        nonlocal element_count, table_count
        element_count += 1
        if element_count > max_elements:
            raise NormalizationError("XML exceeds the configured element bound")
        if depth > max_depth:
            raise NormalizationError("XML exceeds the configured depth bound")
        tag = _local_name(element.tag)
        if tag in _TABLE_TAGS and table_key is None:
            table_key = f"xml-table-{table_count}"
            table_count += 1
        reference = reference_context or (table_key is None and tag in _REFERENCE_TAGS)
        if tag in _ROW_TAGS and table_key is not None:
            row_index = table_row_counts.get(table_key, 0)
            table_row_counts[table_key] = row_index + 1
        if table_key is not None:
            if tag in _CELL_TAGS:
                table_kind = "table_cell"
                cell_is_header = tag == "th" or element.attrib.get("role", "").lower() in {
                    "columnheader", "rowheader",
                }
                cell_row_span = _positive_span(element.attrib.get("rowspan"))
                cell_column_span = _positive_span(element.attrib.get("colspan"))
            elif tag in _CAPTION_TAGS:
                table_kind = "table_caption"
            elif tag in _NOTE_TAGS:
                table_kind = "table_note"
            elif table_kind is None:
                table_kind = "table_note"
        children = list(element)
        cell_children = [child for child in children if _local_name(child.tag) in _CELL_TAGS]
        child_cell_indexes = {id(child): index for index, child in enumerate(cell_children)}
        if tag in _CELL_TAGS and table_key is not None and column_index is None:
            column_index = 0

        def add_text(text: str | None, text_path: str) -> None:
            if text is None or not text.strip():
                return
            kind = "reference" if reference else "section"
            current_row = row_index
            current_column = column_index
            if table_key is not None:
                kind = table_kind or "table_note"
            units.append(
                MarkupUnit(
                    text_path,
                    text,
                    kind,
                    table_key,
                    current_row,
                    current_column,
                    cell_is_header,
                    cell_row_span,
                    cell_column_span,
                )
            )
            if len(units) > max_units:
                raise NormalizationError("XML exceeds the configured structural-unit bound")

        add_text(element.text, f"{path}/text()")
        for index, child in enumerate(children):
            child_tag = _local_name(child.tag)
            child_path = f"{path}/{child_tag}[{index + 1}]"
            child_row = row_index
            child_column = column_index
            if child_tag in _ROW_TAGS and table_key is not None:
                child_row = None
                child_column = None
            elif child_tag in _CELL_TAGS and table_key is not None:
                child_column = child_cell_indexes[id(child)]
            visit(
                child, child_path, depth + 1, reference, table_key, child_row, child_column,
                table_kind, cell_is_header, cell_row_span, cell_column_span,
            )
            add_text(child.tail, f"{child_path}/tail()")

    visit(root, f"/{_local_name(root.tag)}[1]", 1, False, None, None, None, None, False, 1, 1)
    return tuple(units)


def extract_html_units(
    payload: bytes,
    max_units: int,
    max_depth: int,
    max_elements: int,
) -> tuple[MarkupUnit, ...]:
    try:
        soup = BeautifulSoup(payload.decode("utf-8", errors="strict"), "html.parser")
    except (UnicodeDecodeError, ValueError) as error:
        raise NormalizationError(f"HTML parsing failed: {error}") from error
    for element in soup(["script", "style", "template"]):
        element.decompose()
    elements = tuple(soup.find_all(True))
    if len(elements) > max_elements:
        raise NormalizationError("HTML exceeds the configured element bound")
    for element in elements:
        depth = sum(1 for parent in element.parents if isinstance(parent, Tag))
        if depth > max_depth:
            raise NormalizationError("HTML exceeds the configured depth bound")
    tables = {id(table): f"html-table-{index}" for index, table in enumerate(soup.find_all("table"))}
    units: list[MarkupUnit] = []
    for index, node in enumerate(soup.find_all(string=True)):
        if not isinstance(node, NavigableString) or not str(node).strip():
            continue
        parents = tuple(parent for parent in node.parents if isinstance(parent, Tag))
        table = next((parent for parent in parents if parent.name.lower() == "table"), None)
        table_key = None if table is None else tables[id(table)]
        parent_names = tuple(parent.name.lower() for parent in parents)
        reference = table is None and any(name in _REFERENCE_TAGS for name in parent_names)
        kind = "reference" if reference else "section"
        row_index = None
        column_index = None
        is_header = False
        row_span = 1
        column_span = 1
        if table is not None:
            cell = next((parent for parent in parents if parent.name.lower() in {"td", "th"}), None)
            caption = next((parent for parent in parents if parent.name.lower() == "caption"), None)
            note = next((parent for parent in parents if parent.name.lower() in _NOTE_TAGS), None)
            if cell is not None:
                kind = "table_cell"
                row = cell.find_parent("tr")
                row_tag = row if isinstance(row, Tag) else None
                rows = [
                    candidate
                    for candidate in table.find_all("tr")
                    if candidate.find_parent("table") is table
                ]
                row_index = rows.index(row_tag) if row_tag is not None and row_tag in rows else 0
                cells = row_tag.find_all(["th", "td"], recursive=False) if row_tag is not None else [cell]
                column_index = cells.index(cell) if cell in cells else 0
                is_header = cell.name.lower() == "th"
                row_span = _positive_span(cell.get("rowspan"))
                column_span = _positive_span(cell.get("colspan"))
            elif caption is not None:
                kind = "table_caption"
            elif note is not None or table is not None:
                kind = "table_note"
        parent = node.parent.name.lower() if node.parent and node.parent.name else "document"
        units.append(
            MarkupUnit(
                f"/{parent}/text()[{index + 1}]", str(node), kind, table_key,
                row_index, column_index, is_header, row_span, column_span,
            )
        )
        if len(units) > max_units:
            raise NormalizationError("HTML exceeds the configured structural-unit bound")
    return tuple(units)


__all__ = ("MarkupUnit", "extract_html_units", "extract_xml_units")
