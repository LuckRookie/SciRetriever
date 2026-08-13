"""Closed rules for Analysis content Markdown drafts and canonical rendering."""

from __future__ import annotations

import html
import re
import unicodedata
from typing import Final

from sciretriever.model.analysis import LiteratureSection, LiteratureSectionRole

MISSING: Final[str] = "未提供"
FIXED_SECTION_TITLES: Final[tuple[tuple[str, LiteratureSectionRole], ...]] = (
    ("研究背景与目标", LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES),
    ("研究方法", LiteratureSectionRole.METHODS),
    ("数据", LiteratureSectionRole.DATA),
    ("结论与局限性", LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS),
)
REFERENCE_TITLE: Final[str] = "参考文献"
FINAL_FIXED_TITLES: Final[frozenset[str]] = frozenset(
    {"元数据", "摘要", REFERENCE_TITLE, *(title for title, _ in FIXED_SECTION_TITLES)}
)
METADATA_FIELDS: Final[tuple[tuple[str, str], ...]] = (
    ("Title", "title"),
    ("Authors", "authors"),
    ("DOI", "doi"),
    ("Other Identifiers", "other_identifiers"),
    ("Publication Date", "publication_date"),
    ("Year", "publication_year"),
    ("Document Type", "document_type"),
    ("Language", "language"),
    ("Venue", "venue"),
    ("Publisher", "publisher"),
    ("Volume", "volume"),
    ("Issue", "issue"),
    ("Pages", "pages"),
    ("Keywords", "keywords"),
)

_FIXED_ROLE_BY_TITLE: Final[dict[str, LiteratureSectionRole]] = dict(FIXED_SECTION_TITLES)
_PARALLEL_METADATA_TITLES: Final[frozenset[str]] = frozenset(
    {
        "abstract",
        "authors",
        "document type",
        "doi",
        "issue",
        "keywords",
        "language",
        "metadata",
        "other identifiers",
        "pages",
        "publication date",
        "publisher",
        "title",
        "venue",
        "volume",
        "year",
        "元数据",
        "作者",
        "出版商",
        "出版日期",
        "卷",
        "年份",
        "摘要",
        "文献类型",
        "期",
        "期刊",
        "标题",
        "语言",
        "其他标识符",
        "页码",
        "关键词",
    }
)
_MISSING_EXPRESSIONS: Final[frozenset[str]] = frozenset(
    {
        "n/a",
        "na",
        "none",
        "not available",
        "not provided",
        "null",
        "unknown",
        "无",
        "无相关信息",
        "暂无",
        "未知",
        "未提及",
        MISSING,
    }
)
_HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
_HTML_TAG = re.compile(r"</?[A-Za-z][^>\n]{0,1024}>")
_ENTIRE_MARKDOWN_LINK = re.compile(r"^\[([^\]\n]{1,1024})\]\([^\n]{0,2048}\)$")
_ENTIRE_REFERENCE_LINK = re.compile(r"^\[([^\]\n]{1,1024})\]\[([^\]\n]{0,1024})\]$")
_ENTIRE_SHORTCUT_REFERENCE_LINK = re.compile(r"^\[([^\]\n]{1,1024})\]$")
_MAX_INLINE_HTML_TAG_CHARACTERS: Final[int] = 4_096
_VOID_HTML_TAGS: Final[frozenset[str]] = frozenset(
    {
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    }
)
_MISSING_WRAPPERS: Final[tuple[tuple[str, str], ...]] = (
    ("**", "**"),
    ("__", "__"),
    ("~~", "~~"),
    ("`", "`"),
    ("*", "*"),
    ("_", "_"),
)


class ContentMarkdownError(ValueError):
    """Stable, redacted rejection of a private second-stage draft."""

    __slots__ = ("code",)

    def __init__(self, code: str) -> None:
        if type(code) is not str or not code:
            raise ValueError("content Markdown error code must be nonblank text")
        self.code = code
        super().__init__("invalid Analysis content Markdown draft")

    def __repr__(self) -> str:
        return f"<ContentMarkdownError code={self.code}>"


def fixed_role_for_title(title: str) -> LiteratureSectionRole | None:
    """Return the fixed body role for an exact H1 title."""

    return _FIXED_ROLE_BY_TITLE.get(title)


def heading_comparison_key(title: str) -> str:
    """Return the bounded visible-title key used by heading rules."""

    return _visible_heading_title(title).casefold()


def is_fixed_heading_title(title: str) -> bool:
    """Return whether visible heading text collides with a fixed title."""

    key = heading_comparison_key(title)
    return any(key == fixed_title.casefold() for fixed_title in FINAL_FIXED_TITLES)


def is_parallel_metadata_title(title: str) -> bool:
    """Reject headings that would recreate first-stage metadata or abstract."""

    return heading_comparison_key(title) in _PARALLEL_METADATA_TITLES


def is_missing_expression(value: str) -> bool:
    """Return whether an entire value is an unauthorized missing-value alias."""

    candidate = value.strip().casefold()
    if candidate in _MISSING_EXPRESSIONS:
        return True
    return _unwrapped_visible_value(value).casefold() in _MISSING_EXPRESSIONS


def validate_sections(sections: tuple[LiteratureSection, ...]) -> None:
    """Validate the ordered section contract independently of persistence."""

    if type(sections) is not tuple or any(
        not isinstance(section, LiteratureSection) for section in sections
    ):
        raise TypeError("sections must be a tuple of LiteratureSection")

    expected_roles = tuple(role for _, role in FIXED_SECTION_TITLES)
    seen_roles: list[LiteratureSectionRole] = []
    additional_titles: set[str] = set()
    for section in sections:
        if section.role is LiteratureSectionRole.ADDITIONAL:
            if not seen_roles or section.title is None:
                raise ContentMarkdownError("section-order")
            _validate_heading_title(section.title)
            if is_fixed_heading_title(section.title) or is_parallel_metadata_title(section.title):
                raise ContentMarkdownError("parallel-metadata")
            title_key = heading_comparison_key(section.title)
            if title_key in additional_titles:
                raise ContentMarkdownError("duplicate-heading")
            additional_titles.add(title_key)
            _validate_section_content(section, additional=True)
            continue

        expected_index = len(seen_roles)
        if (
            expected_index >= len(expected_roles)
            or section.role is not expected_roles[expected_index]
        ):
            raise ContentMarkdownError("section-order")
        if section.title is not None:
            raise ContentMarkdownError("fixed-title")
        seen_roles.append(section.role)
        _validate_section_content(section, additional=False)

    if tuple(seen_roles) != expected_roles:
        raise ContentMarkdownError("section-order")


def validate_references(references: tuple[str, ...]) -> None:
    """Validate already unnumbered, ordered reference text values."""

    if type(references) is not tuple or any(type(reference) is not str for reference in references):
        raise TypeError("references must be a tuple of text")
    for reference in references:
        if (
            not reference
            or reference != reference.strip()
            or reference == MISSING
            or "\r" in reference
            or any(not line.strip() for line in reference.split("\n"))
            or is_missing_expression(reference)
            or any(line.strip() == MISSING for line in reference.split("\n"))
            or not _has_visible_content(reference)
        ):
            raise ContentMarkdownError("references")


def _validate_section_content(section: LiteratureSection, *, additional: bool) -> None:
    direct = section.markdown
    if "\r" in direct:
        raise ContentMarkdownError("line-ending")
    if direct != MISSING and is_missing_expression(direct):
        raise ContentMarkdownError("missing-marker")
    if direct != MISSING and _has_missing_marker_line(direct):
        raise ContentMarkdownError("missing-marker")
    _validate_subsections(section)

    if direct == MISSING:
        if additional or section.subsections:
            raise ContentMarkdownError("missing-marker")
        return
    if _has_visible_content(direct) or section.subsections:
        return
    raise ContentMarkdownError("empty-section")


def _validate_subsections(section: LiteratureSection) -> None:
    for subsection in section.subsections:
        _validate_heading_title(subsection.title)
        if is_parallel_metadata_title(subsection.title):
            raise ContentMarkdownError("parallel-metadata")
        if "\r" in subsection.markdown:
            raise ContentMarkdownError("line-ending")
        if is_missing_expression(subsection.markdown) or _has_missing_marker_line(
            subsection.markdown
        ):
            raise ContentMarkdownError("empty-subsection")
        if not _has_visible_content(subsection.markdown):
            raise ContentMarkdownError("empty-subsection")


def _validate_heading_title(title: str) -> None:
    if (
        title != title.strip()
        or "\n" in title
        or "\r" in title
        or not _visible_heading_title(title)
    ):
        raise ContentMarkdownError("heading")


def _has_missing_marker_line(markdown: str) -> bool:
    return any(is_missing_expression(line) for line in markdown.splitlines())


def _has_visible_content(markdown: str) -> bool:
    return bool(_HTML_COMMENT.sub("", markdown).strip())


def _unwrapped_visible_value(value: str) -> str:
    candidate = unicodedata.normalize("NFKC", html.unescape(value))
    candidate = _HTML_COMMENT.sub("", candidate)
    candidate = _HTML_TAG.sub("", candidate).strip()
    changed = True
    while changed and candidate:
        changed = False
        for opening, closing in _MISSING_WRAPPERS:
            if (
                candidate.startswith(opening)
                and candidate.endswith(closing)
                and len(candidate) >= len(opening) + len(closing)
            ):
                candidate = candidate[len(opening) : len(candidate) - len(closing)].strip()
                changed = True
                break
    return candidate.strip()


def _visible_heading_title(title: str) -> str:
    candidate = unicodedata.normalize("NFKC", html.unescape(title))
    candidate = _project_inline_html_visible_text(candidate).strip()
    changed = True
    while changed and candidate:
        changed = False
        link_label = _entire_markdown_link_label(candidate)
        if link_label is not None:
            candidate = link_label.strip()
            changed = True
            continue
        for opening, closing in _MISSING_WRAPPERS:
            if (
                candidate.startswith(opening)
                and candidate.endswith(closing)
                and len(candidate) >= len(opening) + len(closing)
            ):
                candidate = candidate[len(opening) : len(candidate) - len(closing)].strip()
                changed = True
                break
    return " ".join(candidate.split())


def _entire_markdown_link_label(value: str) -> str | None:
    for pattern in (
        _ENTIRE_MARKDOWN_LINK,
        _ENTIRE_REFERENCE_LINK,
        _ENTIRE_SHORTCUT_REFERENCE_LINK,
    ):
        match = pattern.fullmatch(value)
        if match is not None:
            return match.group(1)
    return None


def _project_inline_html_visible_text(value: str) -> str:
    visible: list[str] = []
    open_tags: list[str] = []
    index = 0
    while index < len(value):
        opening = value.find("<", index)
        if opening < 0:
            visible.append(value[index:])
            break
        visible.append(value[index:opening])
        if value.startswith("<!--", opening):
            index = _inline_html_comment_end(value, opening)
            continue
        tag = _parse_inline_html_tag(value, opening)
        if tag is None:
            visible.append("<")
            index = opening + 1
            continue
        tag_end, name, closing, self_closing = tag
        if closing:
            if not open_tags or open_tags[-1] != name:
                raise ContentMarkdownError("heading")
            open_tags.pop()
        elif not self_closing and name not in _VOID_HTML_TAGS:
            open_tags.append(name)
        index = tag_end
    if open_tags:
        raise ContentMarkdownError("heading")
    return "".join(visible)


def _inline_html_comment_end(value: str, opening: int) -> int:
    closing = value.find("-->", opening + 4)
    if closing < 0 or closing + 3 - opening > _MAX_INLINE_HTML_TAG_CHARACTERS:
        raise ContentMarkdownError("heading")
    return closing + 3


def _parse_inline_html_tag(
    value: str,
    opening: int,
) -> tuple[int, str, bool, bool] | None:
    identity = _inline_html_tag_identity(value, opening)
    if identity is None:
        return None
    attributes_start, name, closing = identity
    tag_end = _inline_html_tag_end(value, opening, attributes_start)
    attributes = value[attributes_start : tag_end - 1]
    if closing and attributes.strip():
        raise ContentMarkdownError("heading")
    return tag_end, name, closing, not closing and attributes.rstrip().endswith("/")


def _inline_html_tag_identity(
    value: str,
    opening: int,
) -> tuple[int, str, bool] | None:
    cursor = opening + 1
    closing = cursor < len(value) and value[cursor] == "/"
    if closing:
        cursor += 1
    if cursor >= len(value) or not value[cursor].isascii() or not value[cursor].isalpha():
        if cursor < len(value) and value[cursor] in "!?":
            raise ContentMarkdownError("heading")
        return None

    name_start = cursor
    cursor += 1
    while cursor < len(value) and (
        value[cursor].isascii() and (value[cursor].isalnum() or value[cursor] == "-")
    ):
        cursor += 1
    name = value[name_start:cursor].casefold()
    if cursor >= len(value) or not (value[cursor].isspace() or value[cursor] in "/>"):
        raise ContentMarkdownError("heading")
    return cursor, name, closing


def _inline_html_tag_end(value: str, opening: int, cursor: int) -> int:
    quote: str | None = None
    while cursor < len(value):
        if cursor + 1 - opening > _MAX_INLINE_HTML_TAG_CHARACTERS:
            raise ContentMarkdownError("heading")
        character = value[cursor]
        if quote is not None:
            if character == quote:
                quote = None
        elif character in {'"', "'"}:
            quote = character
        elif character == "<":
            raise ContentMarkdownError("heading")
        elif character == ">":
            return cursor + 1
        cursor += 1
    raise ContentMarkdownError("heading")


__all__ = (
    "ContentMarkdownError",
    "FINAL_FIXED_TITLES",
    "FIXED_SECTION_TITLES",
    "METADATA_FIELDS",
    "MISSING",
    "REFERENCE_TITLE",
    "fixed_role_for_title",
    "heading_comparison_key",
    "is_fixed_heading_title",
    "is_missing_expression",
    "is_parallel_metadata_title",
    "validate_references",
    "validate_sections",
)
