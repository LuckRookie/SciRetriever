"""Second-stage content call, strict draft parser, and canonical Markdown renderer."""

from __future__ import annotations

import html
import re
import threading
import unicodedata
from dataclasses import dataclass, field
from typing import Final

from sciretriever.analysis.markdown_rules import (
    FINAL_FIXED_TITLES,
    FIXED_SECTION_TITLES,
    METADATA_FIELDS,
    MISSING,
    REFERENCE_TITLE,
    ContentMarkdownError,
    fixed_role_for_title,
    heading_comparison_key,
    is_fixed_heading_title,
    is_parallel_metadata_title,
    validate_references,
    validate_sections,
)
from sciretriever.analysis.ports import (
    AnalysisLLMCall,
    canonical_json_bytes,
    parse_strict_json_object,
)
from sciretriever.model.analysis import (
    LiteratureSection,
    LiteratureSectionRole,
    LiteratureSubsection,
)
from sciretriever.model.literature import Author, Identifier
from sciretriever.model.llm import LLMRequest, LLMRequestKind, LLMStructuredResponse
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.parsing import ParserResult
from sciretriever.model.primitives import sha256_digest

_CONTENT_PROMPT_VERSION: Final[str] = "content-markdown-v1"
_CONTENT_PROMPT: Final[str] = (
    "你负责根据同一份 parser-neutral Markdown 与已经确定的完整最终元数据总结正文。\n"
    "只输出 response schema 中的 markdown 字段；不得生成元数据、关键词或摘要。\n"
    "Markdown 必须依次包含固定正文一级标题：研究背景与目标、研究方法、数据、\n"
    "结论与局限性，最后是参考文献。\n"
    "额外正文一级标题只能插在固定正文标题之间或结论之后、参考文献之前。\n"
    "正文只使用 H1/H2；固定内容缺失时精确写未提供；参考文献只写有序原文列表，\n"
    "缺失时精确写未提供。不得补写或改动数值、单位、公式、标识符和参考文献事实。"
)
_CONTENT_RESPONSE_SCHEMA: Final[str] = canonical_json_bytes(
    {
        "additionalProperties": False,
        "properties": {"markdown": {"type": "string"}},
        "required": ["markdown"],
        "type": "object",
    }
).decode("utf-8")

_ATX_HEADING = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$")
_CLOSING_ATX = re.compile(r"^(.*?)(?:[ \t]+#+[ \t]*)$")
_FENCE_OPEN = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_SETEXT_UNDERLINE = re.compile(r"^ {0,3}(?:=+|-+)[ \t]*$")
_ORDERED_REFERENCE = re.compile(r"^ {0,3}([0-9]{1,9})\.[ \t]+(.+?)[ \t]*$")
_ORDERED_BLOCK_MARKER = re.compile(r"^[0-9]{1,9}[.)][ \t]+")
_ORDERED_MARKER_NUMBER = re.compile(r"^ {0,3}([0-9]{1,9})(?=[.)][ \t]+)")
_HEADING_ORDER_MARKER_NUMBER = re.compile(r"^[ \t]*([0-9]{1,9})(?=[.)][ \t]+)")
_HTML_RAW_OPEN = re.compile(r"^ {0,3}<(pre|script|style|textarea)(?:[ \t>]|$)", re.I)
_HTML_COMMENT_OPEN = re.compile(r"^ {0,3}<!--")
_HTML_HEADING_OPEN = re.compile(r"^ {0,3}<h([1-6])(?:[ \t>]|$)", re.I)
_DOI = re.compile(r"(?<![A-Za-z0-9])10\.\d{4,9}/[-._;()/:A-Z0-9]+", re.I)
_ARXIV = re.compile(
    r"\barxiv[ \t]*:[ \t]*(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?/\d{7})(?:v\d+)?\b",
    re.I,
)
_PMID = re.compile(r"\bpmid[ \t]*:?[ \t]*\d{1,9}\b", re.I)
_PMCID = re.compile(r"\b(?:pmcid[ \t]*:?[ \t]*)?PMC\d{1,9}\b", re.I)
_NUMBER_WITH_UNIT = re.compile(
    r"(?<![\d.])"
    r"(?:[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)"
    r"(?:[eE][+-]?\d+)?)"
    r"[ \t]*"
    r"(?:%|‰|ppm|ppb|ppt|°[CFK]?|Å|kg|mg|[µμu]g|ng|pg|"
    r"km|cm|mm|[µμu]m|nm|pm|m|kL|mL|[µμu]L|L|"
    r"ms|[µμu]s|ns|min|h|Hz|kHz|MHz|GHz|"
    r"Pa|kPa|MPa|GPa|mol|mmol|[µμu]mol|"
    r"mM|[µμu]M|M|mV|V|mA|A|mW|kW|W|mJ|kJ|J|meV|keV|eV)"
    r"(?:[²³23]|\^[+-]?\d+)?"
    r"(?:[/·](?:kg|mg|g|mL|L|mol|m|cm|mm|s|min|h|K))?"
    r"(?![A-Za-z0-9_µμ])",
)
_STANDALONE_NUMBER = re.compile(
    r"(?<![A-Za-z0-9_])"
    r"[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)"
    r"(?:[eE][+-]?\d+)?"
    r"(?![A-Za-z0-9_])"
)
_RAW_TEXT_TAGS: Final[tuple[str, ...]] = ("pre", "script", "style", "textarea")
_MAX_HTML_TAG_CHARACTERS: Final[int] = 4_096

_MAX_ALIGNMENT_SOURCE_BYTES: Final[int] = 32 * 1024 * 1024
_MAX_ALIGNMENT_DRAFT_BYTES: Final[int] = 4 * 1024 * 1024
_MAX_ALIGNMENT_FACTS: Final[int] = 16_384
_MAX_ALIGNMENT_REFERENCES: Final[int] = 4_096
_MAX_ALIGNMENT_REFERENCE_CHARACTERS: Final[int] = 65_536
_MAX_ALIGNMENT_REFERENCE_TOTAL_CHARACTERS: Final[int] = 4 * 1024 * 1024
_MAX_ALIGNMENT_FORMULA_CHARACTERS: Final[int] = 4_096


@dataclass(frozen=True, slots=True, repr=False)
class ContentMarkdownDraft:
    """Private validated result of the second Analysis stage."""

    sections: tuple[LiteratureSection, ...]
    references: tuple[str, ...]

    def __post_init__(self) -> None:
        validate_sections(self.sections)
        validate_references(self.references)

    def __repr__(self) -> str:
        return (
            "<ContentMarkdownDraft "
            f"sections={len(self.sections)} references={len(self.references)}>"
        )


@dataclass(frozen=True, slots=True)
class _Heading:
    level: int
    title: str


@dataclass(slots=True)
class _SubsectionBuilder:
    title: str
    lines: list[str] = field(default_factory=list)


@dataclass(slots=True)
class _SectionBuilder:
    role: LiteratureSectionRole
    title: str | None
    direct_lines: list[str] = field(default_factory=list)
    subsections: list[_SubsectionBuilder] = field(default_factory=list)


@dataclass(slots=True)
class _DraftParser:
    builders: list[_SectionBuilder] = field(default_factory=list)
    reference_lines: list[str] = field(default_factory=list)
    current_section: _SectionBuilder | None = None
    current_subsection: _SubsectionBuilder | None = None
    references_started: bool = False
    fixed_index: int = 0
    seen_h1: set[str] = field(default_factory=set)

    def consume(self, token: str | _Heading) -> None:
        if isinstance(token, str):
            self._consume_text(token)
        elif token.level > 2:
            raise ContentMarkdownError("heading-depth")
        elif token.level == 2:
            self._consume_h2(token.title)
        else:
            self._consume_h1(token.title)

    def finish(self) -> ContentMarkdownDraft:
        if not self.references_started or self.fixed_index != len(FIXED_SECTION_TITLES):
            raise ContentMarkdownError("section-order")
        sections = tuple(_build_section(builder) for builder in self.builders)
        references = _parse_references(self.reference_lines)
        try:
            return ContentMarkdownDraft(sections=sections, references=references)
        except (TypeError, ValueError):
            raise ContentMarkdownError("structure") from None

    def _consume_text(self, line: str) -> None:
        if self.current_subsection is not None:
            self.current_subsection.lines.append(line)
        elif self.current_section is not None:
            self.current_section.direct_lines.append(line)
        elif self.references_started:
            self.reference_lines.append(line)
        elif line.strip():
            raise ContentMarkdownError("preamble")

    def _consume_h2(self, title: str) -> None:
        if self.references_started or self.current_section is None:
            raise ContentMarkdownError("h2-position")
        if is_parallel_metadata_title(title):
            raise ContentMarkdownError("parallel-metadata")
        self.current_subsection = _SubsectionBuilder(title=title)
        self.current_section.subsections.append(self.current_subsection)

    def _consume_h1(self, title: str) -> None:
        self.current_section = None
        self.current_subsection = None
        title_key = heading_comparison_key(title)
        if title_key in self.seen_h1:
            raise ContentMarkdownError("duplicate-heading")
        self.seen_h1.add(title_key)
        if self.references_started:
            raise ContentMarkdownError("reference-last")
        if title == REFERENCE_TITLE:
            self._start_references()
            return
        if title in {"元数据", "摘要"} or is_parallel_metadata_title(title):
            raise ContentMarkdownError("parallel-metadata")
        if title not in FINAL_FIXED_TITLES and is_fixed_heading_title(title):
            raise ContentMarkdownError("fixed-title")
        self._start_body_section(title)

    def _start_references(self) -> None:
        if self.fixed_index != len(FIXED_SECTION_TITLES):
            raise ContentMarkdownError("section-order")
        self.references_started = True

    def _start_body_section(self, title: str) -> None:
        role = fixed_role_for_title(title)
        if role is None:
            if self.fixed_index == 0 or title in FINAL_FIXED_TITLES:
                raise ContentMarkdownError("section-order")
            section = _SectionBuilder(
                role=LiteratureSectionRole.ADDITIONAL,
                title=title,
            )
        else:
            expected = (title, role)
            if (
                self.fixed_index >= len(FIXED_SECTION_TITLES)
                or FIXED_SECTION_TITLES[self.fixed_index] != expected
            ):
                raise ContentMarkdownError("section-order")
            self.fixed_index += 1
            section = _SectionBuilder(role=role, title=None)
        self.current_section = section
        self.builders.append(section)


def build_content_analysis_call(
    *,
    model: str,
    parser_result: ParserResult,
    parser_markdown: str,
    final_metadata: LiteratureMetadata,
    max_output_tokens: int,
    cancel_event: threading.Event | None = None,
) -> AnalysisLLMCall:
    """Build the only valid second-stage call with complete aligned context."""

    if not isinstance(final_metadata, LiteratureMetadata):
        raise TypeError("final_metadata must be LiteratureMetadata")
    _validated_parser_markdown_bytes(parser_result, parser_markdown)

    structured_input = canonical_json_bytes(
        {
            "final_metadata": final_metadata.model_dump(mode="json"),
            "parser_markdown": parser_markdown,
            "parser_result": parser_result.model_dump(mode="json"),
        }
    ).decode("utf-8")
    return AnalysisLLMCall(
        request=LLMRequest(
            kind=LLMRequestKind.CONTENT,
            input_sha256=sha256_digest(structured_input.encode("utf-8")),
            model=model,
            max_output_tokens=max_output_tokens,
        ),
        prompt_version=_CONTENT_PROMPT_VERSION,
        prompt=_CONTENT_PROMPT,
        structured_input=structured_input,
        response_schema=_CONTENT_RESPONSE_SCHEMA,
        cancel_event=cancel_event,
    )


def parse_content_markdown_response(
    response: LLMStructuredResponse,
    *,
    parser_result: ParserResult,
    parser_markdown: str,
) -> ContentMarkdownDraft:
    """Parse the closed provider-neutral response into sections and references."""

    if not isinstance(response, LLMStructuredResponse):
        raise TypeError("response must be an LLMStructuredResponse")
    try:
        result = parse_strict_json_object(response.result)
    except (TypeError, ValueError):
        raise ContentMarkdownError("response-shape") from None
    markdown = result.get("markdown")
    if set(result) != {"markdown"} or type(markdown) is not str:
        raise ContentMarkdownError("response-shape")
    return parse_content_markdown_draft(
        markdown,
        parser_result=parser_result,
        parser_markdown=parser_markdown,
    )


def parse_content_markdown_draft(
    markdown: str,
    *,
    parser_result: ParserResult,
    parser_markdown: str,
) -> ContentMarkdownDraft:
    """Parse and align one private draft without retaining either source text."""

    if type(markdown) is not str:
        raise TypeError("content Markdown draft must be text")
    try:
        markdown_bytes = markdown.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        raise ContentMarkdownError("utf8") from None
    if "\x00" in markdown or not markdown.strip():
        raise ContentMarkdownError("empty")
    try:
        parser_markdown_bytes = _validated_parser_markdown_bytes(
            parser_result,
            parser_markdown,
        )
    except ValueError:
        raise ContentMarkdownError("input-alignment") from None
    if (
        len(markdown_bytes) > _MAX_ALIGNMENT_DRAFT_BYTES
        or len(parser_markdown_bytes) > _MAX_ALIGNMENT_SOURCE_BYTES
    ):
        raise ContentMarkdownError("alignment-budget")

    parser = _DraftParser()
    for token in _scan_markdown(markdown.replace("\r\n", "\n").replace("\r", "\n")):
        parser.consume(token)
    draft = parser.finish()
    _validate_draft_alignment(
        draft=draft,
        draft_markdown=markdown,
        parser_markdown=parser_markdown,
    )
    return draft


def _validated_parser_markdown_bytes(
    parser_result: ParserResult,
    parser_markdown: str,
) -> bytes:
    if not isinstance(parser_result, ParserResult):
        raise TypeError("parser_result must be a ParserResult")
    if type(parser_markdown) is not str:
        raise TypeError("parser_markdown must be text")
    try:
        parser_markdown_bytes = parser_markdown.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        raise ValueError("parser Markdown must be valid UTF-8") from None
    if not parser_markdown.strip():
        raise ValueError("parser Markdown must be nonblank")
    if (
        len(parser_markdown_bytes) != parser_result.markdown.byte_size
        or sha256_digest(parser_markdown_bytes) != parser_result.markdown.sha256
    ):
        raise ValueError("parser Markdown does not match the ParserResult manifest")
    return parser_markdown_bytes


def _validate_draft_alignment(
    *,
    draft: ContentMarkdownDraft,
    draft_markdown: str,
    parser_markdown: str,
) -> None:
    normalized_source = _normalize_evidence_text(parser_markdown)
    if len(draft.references) > _MAX_ALIGNMENT_REFERENCES:
        raise ContentMarkdownError("alignment-budget")
    reference_characters = 0
    for reference in draft.references:
        reference_characters += len(reference)
        if len(reference) > _MAX_ALIGNMENT_REFERENCE_CHARACTERS:
            raise ContentMarkdownError("alignment-budget")
        if reference_characters > _MAX_ALIGNMENT_REFERENCE_TOTAL_CHARACTERS:
            raise ContentMarkdownError("alignment-budget")
        normalized_reference = _normalize_evidence_text(reference)
        if not normalized_reference or normalized_reference not in normalized_source:
            raise ContentMarkdownError("reference-alignment")

    source_identifiers = _extract_stable_identifiers(parser_markdown)
    draft_identifiers = _extract_stable_identifiers(draft_markdown)
    if not draft_identifiers.issubset(source_identifiers):
        raise ContentMarkdownError("identifier-alignment")

    source_measurements = _extract_measurements(parser_markdown)
    draft_measurements = _extract_measurements(draft_markdown)
    if not draft_measurements.issubset(source_measurements):
        raise ContentMarkdownError("measurement-alignment")

    source_formulas = _extract_formulas(parser_markdown)
    draft_formulas = _extract_formulas(draft_markdown)
    if not draft_formulas.issubset(source_formulas):
        raise ContentMarkdownError("formula-alignment")

    source_numbers = _extract_standalone_numbers(parser_markdown)
    draft_numbers = _extract_standalone_numbers(draft_markdown)
    if not draft_numbers.issubset(source_numbers):
        raise ContentMarkdownError("number-alignment")


def _normalize_evidence_text(value: str) -> str:
    visible = html.unescape(value)
    normalized = unicodedata.normalize("NFKC", visible)
    return " ".join(normalized.split())


def _bounded_matches(pattern: re.Pattern[str], value: str) -> tuple[str, ...]:
    matches: list[str] = []
    for match in pattern.finditer(value):
        matches.append(match.group(0))
        if len(matches) > _MAX_ALIGNMENT_FACTS:
            raise ContentMarkdownError("alignment-budget")
    return tuple(matches)


def _extract_stable_identifiers(value: str) -> frozenset[str]:
    normalized = unicodedata.normalize("NFKC", html.unescape(value))
    identifiers: set[str] = set()
    for raw_doi in _bounded_matches(_DOI, normalized):
        doi = raw_doi.rstrip(".,;:")
        while doi.endswith(")") and doi.count(")") > doi.count("("):
            doi = doi[:-1]
        identifiers.add("doi:" + doi.casefold())
    for raw_arxiv in _bounded_matches(_ARXIV, normalized):
        identifiers.add("arxiv:" + re.sub(r"[ \t]", "", raw_arxiv).casefold())
    for raw_pmid in _bounded_matches(_PMID, normalized):
        digits = re.search(r"\d{1,9}$", raw_pmid)
        if digits is not None:
            identifiers.add("pmid:" + digits.group(0))
    for raw_pmcid in _bounded_matches(_PMCID, normalized):
        pmcid = re.search(r"PMC\d{1,9}$", raw_pmcid, re.I)
        if pmcid is not None:
            identifiers.add("pmcid:" + pmcid.group(0).casefold())
    if len(identifiers) > _MAX_ALIGNMENT_FACTS:
        raise ContentMarkdownError("alignment-budget")
    return frozenset(identifiers)


def _extract_measurements(value: str) -> frozenset[str]:
    normalized = unicodedata.normalize("NFKC", html.unescape(value))
    measurements = {
        re.sub(r"[ \t,]", "", match).replace("µ", "u").replace("μ", "u")
        for match in _bounded_matches(_NUMBER_WITH_UNIT, normalized)
    }
    if len(measurements) > _MAX_ALIGNMENT_FACTS:
        raise ContentMarkdownError("alignment-budget")
    return frozenset(measurements)


def _extract_standalone_numbers(value: str) -> frozenset[str]:
    normalized = unicodedata.normalize("NFKC", html.unescape(value))
    mask = _markdown_protected_mask(normalized)
    _mask_html_tags(normalized, mask)
    _mask_markdown_structure_numbers(normalized, mask)
    for pattern in (_DOI, _ARXIV, _PMID, _PMCID, _NUMBER_WITH_UNIT):
        _mask_pattern_matches(pattern, normalized, mask)
    _mask_formula_spans(normalized, mask)

    numbers: set[str] = set()
    number_count = 0
    for match in _STANDALONE_NUMBER.finditer(normalized):
        if _span_is_masked(mask, match.start(), match.end()):
            continue
        number_count += 1
        if number_count > _MAX_ALIGNMENT_FACTS:
            raise ContentMarkdownError("alignment-budget")
        numbers.add(match.group(0).replace(",", "").replace("E", "e"))
    return frozenset(numbers)


def _extract_formulas(value: str) -> frozenset[str]:
    formulas: set[str] = set()
    formula_count = 0
    index = 0
    while index < len(value):
        delimiters = _formula_delimiters_at(value, index)
        if delimiters is None:
            index += 1
            continue
        opening, closing = delimiters

        content_start = index + len(opening)
        content_end = value.find(closing, content_start)
        if content_end < 0:
            index = content_start
            continue
        content = value[content_start:content_end]
        if opening == "$" and "\n" in content:
            index = content_start
            continue
        if len(content) > _MAX_ALIGNMENT_FORMULA_CHARACTERS:
            raise ContentMarkdownError("alignment-budget")
        normalized = unicodedata.normalize("NFKC", html.unescape(content))
        normalized = "".join(normalized.split())
        if normalized:
            formula_count += 1
            if formula_count > _MAX_ALIGNMENT_FACTS:
                raise ContentMarkdownError("alignment-budget")
            formulas.add(normalized)
        index = content_end + len(closing)
    return frozenset(formulas)


def _formula_delimiters_at(value: str, index: int) -> tuple[str, str] | None:
    if value.startswith("$$", index):
        return "$$", "$$"
    if value.startswith(r"\(", index):
        return r"\(", r"\)"
    if value.startswith(r"\[", index):
        return r"\[", r"\]"
    if value[index] == "$" and (index == 0 or value[index - 1] != "\\"):
        return "$", "$"
    return None


def _markdown_protected_mask(value: str) -> bytearray:
    mask = bytearray(len(value))
    _mask_fenced_and_indented_code(value, mask)
    _mask_inline_code(value, mask)
    _mask_html_comments_and_raw_text(value, mask)
    return mask


def _mask_fenced_and_indented_code(value: str, mask: bytearray) -> None:
    fence_character: str | None = None
    fence_length = 0
    offset = 0
    for line_with_ending in value.splitlines(keepends=True):
        line = line_with_ending.rstrip("\r\n")
        line_end = offset + len(line_with_ending)
        if fence_character is not None:
            _mark_mask(mask, offset, line_end)
            if _is_fence_close(line, fence_character, fence_length):
                fence_character = None
                fence_length = 0
            offset = line_end
            continue

        opened = _FENCE_OPEN.match(line)
        if opened is not None:
            marker, info = opened.groups()
            if marker[0] != "`" or "`" not in info:
                fence_character = marker[0]
                fence_length = len(marker)
                _mark_mask(mask, offset, line_end)
                offset = line_end
                continue

        indentation = len(line) - len(line.lstrip(" "))
        if line.startswith("\t") or indentation >= 4:
            _mark_mask(mask, offset, line_end)
        offset = line_end

    if offset < len(value):
        line = value[offset:]
        if (
            fence_character is not None
            or line.startswith("\t")
            or len(line) - len(line.lstrip(" ")) >= 4
        ):
            _mark_mask(mask, offset, len(value))


def _mask_inline_code(value: str, mask: bytearray) -> None:
    offset = 0
    for line_with_ending in value.splitlines(keepends=True):
        content_length = len(line_with_ending.rstrip("\r\n"))
        line_end = offset + content_length
        pending: dict[int, int] = {}
        index = offset
        while index < line_end:
            if mask[index] or value[index] != "`":
                index += 1
                continue
            run_end = index + 1
            while run_end < line_end and not mask[run_end] and value[run_end] == "`":
                run_end += 1
            run_length = run_end - index
            opening = pending.pop(run_length, None)
            if opening is None:
                pending[run_length] = index
            else:
                _mark_mask(mask, opening, run_end)
            index = run_end
        offset += len(line_with_ending)


def _mask_html_comments_and_raw_text(value: str, mask: bytearray) -> None:
    folded = value.casefold()
    index = 0
    while index < len(value):
        opening = value.find("<", index)
        if opening < 0:
            return
        if mask[opening] or _is_backslash_escaped(value, opening):
            index = opening + 1
            continue
        if value.startswith("<!--", opening):
            closing = value.find("-->", opening + 4)
            end = len(value) if closing < 0 else closing + 3
            _mark_mask(mask, opening, end)
            index = end
            continue

        raw_name = _raw_text_open_name(folded, opening)
        if raw_name is None:
            tag_end = _html_tag_end(value, opening) if _is_html_tag_start(value, opening) else None
            index = opening + 1 if tag_end is None else tag_end
            continue
        tag_end = _html_tag_end(value, opening)
        if tag_end is None:
            index = opening + 1
            continue
        raw_end = _raw_text_end(value, folded, raw_name, tag_end)
        _mark_mask(mask, opening, raw_end)
        index = raw_end


def _raw_text_open_name(folded: str, opening: int) -> str | None:
    name_start = opening + 1
    for name in _RAW_TEXT_TAGS:
        name_end = name_start + len(name)
        if folded.startswith(name, name_start) and name_end < len(folded):
            boundary = folded[name_end]
            if boundary.isspace() or boundary in "/>":
                return name
    return None


def _raw_text_end(value: str, folded: str, name: str, start: int) -> int:
    needle = f"</{name}"
    search_from = start
    while True:
        closing = folded.find(needle, search_from)
        if closing < 0:
            return len(value)
        name_end = closing + len(needle)
        if name_end < len(value) and (value[name_end].isspace() or value[name_end] == ">"):
            tag_end = _html_tag_end(value, closing)
            if tag_end is not None:
                return tag_end
        search_from = closing + 2


def _html_tag_end(value: str, opening: int) -> int | None:
    quote: str | None = None
    limit = min(len(value), opening + _MAX_HTML_TAG_CHARACTERS)
    index = opening + 1
    while index < limit:
        character = value[index]
        if quote is not None:
            if character == quote:
                quote = None
        elif character in {'"', "'"}:
            quote = character
        elif character == ">":
            return index + 1
        index += 1
    return None


def _is_html_tag_start(value: str, opening: int) -> bool:
    cursor = opening + 1
    if cursor < len(value) and value[cursor] == "/":
        cursor += 1
    return cursor < len(value) and value[cursor].isalpha()


def _iter_html_heading_tag_spans(
    value: str,
    mask: bytearray,
    *,
    include_closing: bool,
) -> tuple[tuple[int, int], ...]:
    spans: list[tuple[int, int]] = []
    index = 0
    while index < len(value):
        opening = value.find("<", index)
        if opening < 0:
            break
        if mask[opening] or _is_backslash_escaped(value, opening):
            index = opening + 1
            continue
        heading = _lex_html_heading_tag(value, opening)
        if heading is None:
            tag_end = _html_tag_end(value, opening) if _is_html_tag_start(value, opening) else None
            index = opening + 1 if tag_end is None else tag_end
            continue
        tag_end, closing = heading
        if closing and not include_closing:
            index = tag_end
            continue
        spans.append((opening, tag_end))
        if len(spans) > _MAX_ALIGNMENT_FACTS:
            raise ContentMarkdownError("alignment-budget")
        index = tag_end
    return tuple(spans)


def _lex_html_heading_tag(value: str, opening: int) -> tuple[int, bool] | None:
    prefix = _html_heading_tag_prefix(value, opening)
    if prefix is None:
        return None
    attributes_start, closing = prefix
    tag_end = _bounded_html_heading_tag_end(value, opening, attributes_start)
    if closing and value[attributes_start : tag_end - 1].strip():
        raise ContentMarkdownError("html-heading")
    return tag_end, closing


def _html_heading_tag_prefix(value: str, opening: int) -> tuple[int, bool] | None:
    cursor = opening + 1
    closing = cursor < len(value) and value[cursor] == "/"
    if closing:
        cursor += 1
    if (
        cursor + 1 >= len(value)
        or value[cursor].casefold() != "h"
        or value[cursor + 1] not in "123456"
    ):
        return None
    boundary_index = cursor + 2
    if boundary_index >= len(value):
        raise ContentMarkdownError("html-heading")
    boundary = value[boundary_index]
    if boundary.isspace() or boundary in "/>":
        return boundary_index, closing
    if boundary.isascii() and (boundary.isalnum() or boundary in "-_:"):
        return None
    raise ContentMarkdownError("html-heading")


def _bounded_html_heading_tag_end(value: str, opening: int, cursor: int) -> int:
    quote: str | None = None
    limit = min(len(value), opening + _MAX_HTML_TAG_CHARACTERS)
    while cursor < limit:
        character = value[cursor]
        if quote is not None:
            if character == quote:
                quote = None
        elif character in {'"', "'"}:
            quote = character
        elif character == "<":
            raise ContentMarkdownError("html-heading")
        elif character == ">":
            return cursor + 1
        cursor += 1
    raise ContentMarkdownError("html-heading")


def _reject_unsafe_html_headings(value: str, mask: bytearray) -> None:
    if _iter_html_heading_tag_spans(value, mask, include_closing=False):
        raise ContentMarkdownError("html-heading")


def _neutralize_html_heading_tags(value: str) -> str:
    mask = _markdown_protected_mask(value)
    spans = _iter_html_heading_tag_spans(value, mask, include_closing=True)
    if not spans:
        return value
    rendered: list[str] = []
    previous = 0
    for start, end in spans:
        rendered.extend((value[previous:start], "\\", value[start:end]))
        previous = end
    rendered.append(value[previous:])
    return "".join(rendered)


def _mask_html_tags(value: str, mask: bytearray) -> None:
    index = 0
    while index < len(value):
        opening = value.find("<", index)
        if opening < 0:
            return
        if mask[opening] or _is_backslash_escaped(value, opening):
            index = opening + 1
            continue
        if not _is_html_tag_start(value, opening):
            index = opening + 1
            continue
        tag_end = _html_tag_end(value, opening)
        if tag_end is None:
            index = opening + 1
            continue
        _mark_mask(mask, opening, tag_end)
        index = tag_end


def _mask_markdown_structure_numbers(value: str, mask: bytearray) -> None:
    offset = 0
    for line_with_ending in value.splitlines(keepends=True):
        line = line_with_ending.rstrip("\r\n")
        heading = _ATX_HEADING.match(line)
        if heading is not None:
            _mark_mask(mask, offset + heading.start(1), offset + heading.end(1))
            raw_title = heading.group(2)
            if raw_title is not None:
                ordinal = _HEADING_ORDER_MARKER_NUMBER.match(raw_title)
                if ordinal is not None:
                    title_start = heading.start(2)
                    _mark_mask(
                        mask,
                        offset + title_start + ordinal.start(1),
                        offset + title_start + ordinal.end(1),
                    )
        else:
            marker = _ORDERED_MARKER_NUMBER.match(line)
            if marker is not None:
                _mark_mask(mask, offset + marker.start(1), offset + marker.end(1))
        offset += len(line_with_ending)


def _mask_pattern_matches(pattern: re.Pattern[str], value: str, mask: bytearray) -> None:
    match_count = 0
    for match in pattern.finditer(value):
        match_count += 1
        if match_count > _MAX_ALIGNMENT_FACTS:
            raise ContentMarkdownError("alignment-budget")
        _mark_mask(mask, match.start(), match.end())


def _mask_formula_spans(value: str, mask: bytearray) -> None:
    formula_count = 0
    index = 0
    while index < len(value):
        delimiters = _formula_delimiters_at(value, index)
        if delimiters is None:
            index += 1
            continue
        opening, closing = delimiters
        content_start = index + len(opening)
        content_end = value.find(closing, content_start)
        if content_end < 0 or (opening == "$" and "\n" in value[content_start:content_end]):
            index = content_start
            continue
        formula_count += 1
        if formula_count > _MAX_ALIGNMENT_FACTS:
            raise ContentMarkdownError("alignment-budget")
        end = content_end + len(closing)
        _mark_mask(mask, index, end)
        index = end


def _mark_mask(mask: bytearray, start: int, end: int) -> None:
    if end > start:
        mask[start:end] = b"\x01" * (end - start)


def _span_is_masked(mask: bytearray, start: int, end: int) -> bool:
    return any(mask[start:end])


def _is_backslash_escaped(value: str, index: int) -> bool:
    backslashes = 0
    cursor = index - 1
    while cursor >= 0 and value[cursor] == "\\":
        backslashes += 1
        cursor -= 1
    return backslashes % 2 == 1


def render_canonical_markdown(
    *,
    metadata: LiteratureMetadata,
    sections: tuple[LiteratureSection, ...],
    references: tuple[str, ...],
) -> bytes:
    """Render final metadata, abstract, parsed body, and references as UTF-8."""

    if not isinstance(metadata, LiteratureMetadata):
        raise TypeError("metadata must be LiteratureMetadata")
    validate_sections(sections)
    validate_references(references)

    lines = ["# 元数据", ""]
    for label, key in METADATA_FIELDS:
        if key == "authors":
            lines.extend(_render_authors(metadata.authors))
        else:
            lines.append(f"+ {label}: {_metadata_inline(_metadata_value(metadata, key), 4)}")
    lines.extend(["", "# 摘要", "", _safe_body_text(_value_text(metadata.abstract))])

    fixed_titles_by_role = {role: title for title, role in FIXED_SECTION_TITLES}
    for section in sections:
        title = fixed_titles_by_role.get(section.role, section.title)
        if title is None:
            raise ContentMarkdownError("fixed-title")
        lines.extend(["", f"# {title}", ""])
        lines.extend(_render_section_body(section))

    lines.extend(["", f"# {REFERENCE_TITLE}", ""])
    if references:
        for index, reference in enumerate(references, start=1):
            lines.extend(_render_reference(index, reference))
    else:
        lines.append(MISSING)
    return ("\n".join(lines).rstrip() + "\n").encode("utf-8")


@dataclass(slots=True)
class _MarkdownScanner:
    tokens: list[str | _Heading] = field(default_factory=list)
    fence_character: str | None = None
    fence_length: int = 0
    html_end: str | None = None

    def consume(self, line: str) -> None:
        if self.fence_character is not None:
            self._consume_fence_continuation(line)
            return
        if self.html_end is not None:
            self._consume_html_continuation(line)
            return
        if self._open_fence(line) or self._open_html_block(line):
            return
        heading = _parse_atx_heading(line)
        if heading is not None:
            self.tokens.append(heading)
            return
        if _SETEXT_UNDERLINE.match(line) is not None and _previous_line_can_be_setext(self.tokens):
            raise ContentMarkdownError("heading-syntax")
        self.tokens.append(line)

    def _consume_html_continuation(self, line: str) -> bool:
        if self.html_end is None:
            return False
        self.tokens.append(line)
        if self.html_end.casefold() in line.casefold():
            self.html_end = None
        return True

    def _open_html_block(self, line: str) -> bool:
        if _HTML_HEADING_OPEN.match(line) is not None:
            raise ContentMarkdownError("html-heading")
        raw = _HTML_RAW_OPEN.match(line)
        if raw is not None:
            self.html_end = f"</{raw.group(1)}>"
            self.tokens.append(line)
            if self.html_end.casefold() in line.casefold():
                self.html_end = None
            return True
        if _HTML_COMMENT_OPEN.match(line) is None:
            return False
        self.tokens.append(line)
        if "-->" not in line:
            self.html_end = "-->"
        return True

    def _consume_fence_continuation(self, line: str) -> bool:
        if self.fence_character is None:
            return False
        self.tokens.append(line)
        if _is_fence_close(line, self.fence_character, self.fence_length):
            self.fence_character = None
            self.fence_length = 0
        return True

    def _open_fence(self, line: str) -> bool:
        opened = _FENCE_OPEN.match(line)
        if opened is None:
            return False
        marker, info = opened.groups()
        if marker[0] == "`" and "`" in info:
            return False
        self.fence_character = marker[0]
        self.fence_length = len(marker)
        self.tokens.append(line)
        return True


def _scan_markdown(markdown: str) -> tuple[str | _Heading, ...]:
    protected = _markdown_protected_mask(markdown)
    _reject_unsafe_html_headings(markdown, protected)
    scanner = _MarkdownScanner()
    offset = 0
    for line in markdown.split("\n"):
        first_content = len(line) - len(line.lstrip(" \t"))
        marker_index = offset + first_content
        if marker_index < offset + len(line) and protected[marker_index]:
            scanner.tokens.append(line)
        else:
            scanner.consume(line)
        offset += len(line) + 1
    return tuple(scanner.tokens)


def _is_fence_close(line: str, character: str, minimum_length: int) -> bool:
    candidate = line.lstrip(" ")
    indentation = len(line) - len(candidate)
    if indentation > 3:
        return False
    marker_length = len(candidate) - len(candidate.lstrip(character))
    return marker_length >= minimum_length and not candidate[marker_length:].strip()


def _parse_atx_heading(line: str) -> _Heading | None:
    match = _ATX_HEADING.match(line)
    if match is None:
        return None
    marker, raw_title = match.groups()
    title = "" if raw_title is None else raw_title.rstrip()
    closing = _CLOSING_ATX.match(title)
    if closing is not None:
        title = closing.group(1).rstrip()
    title = unicodedata.normalize("NFKC", html.unescape(title)).strip()
    if not title:
        raise ContentMarkdownError("empty-heading")
    return _Heading(level=len(marker), title=title)


def _previous_line_can_be_setext(tokens: list[str | _Heading]) -> bool:
    if not tokens or not isinstance(tokens[-1], str):
        return False
    previous = tokens[-1]
    if not previous.strip() or previous.startswith("    ") or previous.startswith("\t"):
        return False
    candidate = previous.lstrip(" ")
    return (
        not candidate.startswith((">", "- ", "* ", "+ ", "#", "```", "~~~"))
        and _ORDERED_BLOCK_MARKER.match(candidate) is None
    )


def _build_section(builder: _SectionBuilder) -> LiteratureSection:
    direct = _trim_blank_lines(builder.direct_lines)
    subsections: list[LiteratureSubsection] = []
    for subsection in builder.subsections:
        markdown = _trim_blank_lines(subsection.lines)
        if not markdown:
            raise ContentMarkdownError("empty-subsection")
        try:
            subsections.append(
                LiteratureSubsection(
                    title=subsection.title,
                    markdown=markdown,
                )
            )
        except (TypeError, ValueError):
            raise ContentMarkdownError("subsection") from None
    try:
        return LiteratureSection(
            role=builder.role,
            title=builder.title,
            markdown=direct,
            subsections=tuple(subsections),
        )
    except (TypeError, ValueError):
        raise ContentMarkdownError("section") from None


def _trim_blank_lines(lines: list[str]) -> str:
    return "\n".join(_trim_outer_blank_lines(lines))


def _trim_outer_blank_lines(lines: list[str]) -> list[str]:
    start = 0
    end = len(lines)
    while start < end and not lines[start].strip():
        start += 1
    while end > start and not lines[end - 1].strip():
        end -= 1
    return lines[start:end]


def _parse_references(lines: list[str]) -> tuple[str, ...]:
    body = _trim_outer_blank_lines(lines)
    if body == [MISSING]:
        return ()
    if not body or any(line.strip() == MISSING for line in body):
        raise ContentMarkdownError("references")

    result = _parse_reference_items(body)
    validate_references(result)
    return result


def _parse_reference_items(body: list[str]) -> tuple[str, ...]:
    references: list[str] = []
    current_lines: list[str] = []
    expected_number = 1
    for line in body:
        if not line.strip():
            continue
        item = _ORDERED_REFERENCE.match(line)
        if item is not None:
            if item.group(1) != str(expected_number):
                raise ContentMarkdownError("references")
            if current_lines:
                references.append("\n".join(current_lines))
            current_lines = [item.group(2).strip()]
            expected_number += 1
            continue
        if not current_lines or len(line) - len(line.lstrip(" ")) < 3:
            raise ContentMarkdownError("references")
        current_lines.append(line.lstrip(" ").rstrip())
    if current_lines:
        references.append("\n".join(current_lines))
    if not references or any(not reference or reference == MISSING for reference in references):
        raise ContentMarkdownError("references")
    return tuple(references)


def _value_text(value: object) -> str:
    if value is None:
        return MISSING
    if isinstance(value, tuple):
        return ", ".join(_value_text(item) for item in value) if value else MISSING
    if isinstance(value, Author):
        return value.display_name
    if isinstance(value, Identifier):
        return f"{value.namespace}:{value.value}"
    return str(getattr(value, "value", value))


def _render_authors(authors: tuple[Author, ...]) -> list[str]:
    if not authors:
        return [f"+ Authors: {MISSING}"]
    lines = ["+ Authors:"]
    for index, author in enumerate(authors, start=1):
        author_prefix = f"  {index}. "
        lines.append(author_prefix + _metadata_inline(author.display_name, len(author_prefix)))
        lines.append(f"     + Kind: {author.kind.value}")
        if author.given_name is not None:
            lines.append(f"     + Given Name: {_metadata_inline(author.given_name, 8)}")
        if author.family_name is not None:
            lines.append(f"     + Family Name: {_metadata_inline(author.family_name, 8)}")
        if author.orcid is not None:
            lines.append(f"     + ORCID: {author.orcid}")
        if author.affiliations:
            lines.append("     + Affiliations:")
            for affiliation_index, affiliation in enumerate(author.affiliations, start=1):
                affiliation_prefix = f"       {affiliation_index}. "
                lines.append(
                    affiliation_prefix + _metadata_inline(affiliation.name, len(affiliation_prefix))
                )
                if affiliation.ror is not None:
                    lines.append(f"          + ROR: {affiliation.ror}")
    return lines


def _metadata_value(metadata: LiteratureMetadata, key: str) -> str:
    if key == "doi":
        return _value_text(
            tuple(
                identifier.value
                for identifier in metadata.identifiers
                if identifier.namespace == "doi"
            )
        )
    if key == "other_identifiers":
        return _value_text(
            tuple(
                f"{identifier.namespace}:{identifier.value}"
                for identifier in metadata.identifiers
                if identifier.namespace != "doi"
            )
        )
    if key == "keywords":
        return _value_text(metadata.keywords)
    return _value_text(getattr(metadata, key))


def _render_section_body(section: LiteratureSection) -> list[str]:
    lines: list[str] = []
    if section.markdown:
        lines.append(_safe_body_text(section.markdown.rstrip()))
    for subsection in section.subsections:
        if lines:
            lines.append("")
        lines.extend(
            (
                f"## {subsection.title}",
                "",
                _safe_body_text(subsection.markdown.rstrip()),
            )
        )
    return lines if lines else [MISSING]


def _render_reference(index: int, reference: str) -> list[str]:
    prefix = f"{index}. "
    reference_lines = _safe_body_text(reference).split("\n")
    return [
        prefix + reference_lines[0],
        *(" " * len(prefix) + line for line in reference_lines[1:]),
    ]


def _metadata_inline(value: str, continuation_indent: int) -> str:
    normalized = _safe_body_text(value)
    lines = normalized.split("\n")
    indentation = " " * continuation_indent
    return ("\n" + indentation).join(lines)


@dataclass(slots=True)
class _RenderedTextEscaper:
    fence_character: str | None = None
    fence_length: int = 0
    html_end: str | None = None

    def consume(self, line: str) -> str:
        if self._consume_fence(line) or self._consume_html(line):
            return line
        if self._open_fence(line) or self._open_html(line):
            return line
        if (
            _ATX_HEADING.match(line) is None
            and _SETEXT_UNDERLINE.match(line) is None
            and _HTML_HEADING_OPEN.match(line) is None
        ):
            return line
        indentation = line[: len(line) - len(line.lstrip(" "))]
        return indentation + "\\" + line[len(indentation) :]

    def _consume_fence(self, line: str) -> bool:
        if self.fence_character is None:
            return False
        if _is_fence_close(line, self.fence_character, self.fence_length):
            self.fence_character = None
            self.fence_length = 0
        return True

    def _open_fence(self, line: str) -> bool:
        opened = _FENCE_OPEN.match(line)
        if opened is None:
            return False
        marker, info = opened.groups()
        if marker[0] == "`" and "`" in info:
            return False
        self.fence_character = marker[0]
        self.fence_length = len(marker)
        return True

    def _consume_html(self, line: str) -> bool:
        if self.html_end is None:
            return False
        if self.html_end.casefold() in line.casefold():
            self.html_end = None
        return True

    def _open_html(self, line: str) -> bool:
        raw_html = _HTML_RAW_OPEN.match(line)
        if raw_html is not None:
            self.html_end = f"</{raw_html.group(1)}>"
            if self.html_end.casefold() in line.casefold():
                self.html_end = None
            return True
        if _HTML_COMMENT_OPEN.match(line) is None:
            return False
        if "-->" not in line:
            self.html_end = "-->"
        return True


def _safe_body_text(value: str) -> str:
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    normalized = _neutralize_html_heading_tags(normalized)
    escaper = _RenderedTextEscaper()
    return "\n".join(escaper.consume(line) for line in normalized.split("\n"))


__all__ = (
    "ContentMarkdownDraft",
    "build_content_analysis_call",
    "parse_content_markdown_draft",
    "parse_content_markdown_response",
    "render_canonical_markdown",
)
