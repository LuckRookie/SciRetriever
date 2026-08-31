from __future__ import annotations

import json
import threading
import unittest

from sciretriever.agents.api import AgentProvenance, AgentStructuredResult
from sciretriever.analysis.markdown import (
    ContentMarkdownDraft,
    build_content_analysis_call,
    parse_content_markdown_draft,
    parse_content_markdown_response,
    render_canonical_markdown,
)
from sciretriever.analysis.markdown_rules import ContentMarkdownError, heading_comparison_key
from sciretriever.analysis.ports import AnalysisRequestKind
from sciretriever.model.analysis import (
    LiteratureSection,
    LiteratureSectionRole,
    LiteratureSubsection,
)
from sciretriever.model.literature import Affiliation, Author, AuthorKind, Identifier
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.parsing import (
    ParserArtifactRef,
    ParserProvenance,
    ParserResult,
    parser_result_sha256,
)
from sciretriever.model.primitives import (
    AssetId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance

_MODEL = "fixture-content-model"
_ASSET_ID = AssetId("123e4567-e89b-12d3-a456-426614174000")
_SOURCE_SHA256 = sha256_digest(b"fixture pdf")
_PARSER_PROVENANCE_ID = ProvenanceId("223e4567-e89b-12d3-a456-426614174000")
_TIMESTAMP = UtcTimestamp("2026-08-12T01:02:03Z")
_PRIVATE_SENTINEL = "CONTENT-DRAFT-PRIVATE-SENTINEL"


def _metadata(*, complete: bool = True) -> LiteratureMetadata:
    if not complete:
        return LiteratureMetadata(title="Target paper")
    return LiteratureMetadata(
        title="Target paper",
        authors=(
            Author(
                kind=AuthorKind.PERSON,
                display_name="Ada Lovelace",
                given_name="Ada",
                family_name="Lovelace",
                orcid="0000-0002-1825-0097",
                affiliations=(Affiliation(name="Analytical Engine Institute", ror="03yrm5c26"),),
            ),
            Author(
                kind=AuthorKind.ORGANIZATION,
                display_name="Example Collaboration",
            ),
        ),
        abstract="The final first-stage abstract.",
        publication_date="2024-01-02",
        publication_year=2024,
        document_type="article",
        language="en",
        venue="Journal of Fixtures",
        publisher="Fixture Publisher",
        volume="7",
        issue="2",
        pages="e123",
        identifiers=(
            Identifier(namespace="doi", value="10.1234/example"),
            Identifier(namespace="arxiv", value="2401.00001"),
            Identifier(namespace="pmid", value="12345"),
        ),
        keywords=("analysis", "verification"),
    )


def _parser_result(markdown: str) -> ParserResult:
    encoded = markdown.encode("utf-8")
    markdown_ref = ParserArtifactRef(
        sha256=sha256_digest(encoded),
        media_type="text/markdown",
        byte_size=len(encoded),
    )
    provenance = ParserProvenance(
        provenance=Provenance(
            provenance_id=_PARSER_PROVENANCE_ID,
            source_kind=SourceKind.PARSER,
            source_name="fixture-parser",
            source_record_id=None,
            observed_at=_TIMESTAMP,
            input_sha256=_SOURCE_SHA256,
            parameters_sha256=Sha256("a" * 64),
        ),
        parser_version="1.0",
        mode="fixture-mode",
        model_identity=None,
    )
    return ParserResult(
        source_asset_id=_ASSET_ID,
        source_sha256=_SOURCE_SHA256,
        page_count=2,
        markdown=markdown_ref,
        resources=(),
        result_sha256=parser_result_sha256(
            source_asset_id=_ASSET_ID,
            source_sha256=_SOURCE_SHA256,
            page_count=2,
            markdown=markdown_ref,
            resources=(),
            provenance=provenance,
        ),
        provenance=provenance,
    )


def _minimal_draft(*, references: str = "未提供") -> str:
    return f"""# 研究背景与目标

未提供

# 研究方法

未提供

# 数据

未提供

# 结论与局限性

未提供

# 参考文献

{references}
"""


def _response(call_input_sha256: Sha256, result: object) -> AgentStructuredResult:
    return AgentStructuredResult(
        result=json.dumps(result, ensure_ascii=False, separators=(",", ":")),
        provenance=AgentProvenance(
            provider="fixture-provider",
            model=_MODEL,
            input_sha256=call_input_sha256,
            parameters_sha256=Sha256("b" * 64),
        ),
    )


def _parse_draft(markdown: str) -> ContentMarkdownDraft:
    return parse_content_markdown_draft(
        markdown,
        parser_result=_parser_result(markdown),
        parser_markdown=markdown,
    )


def _parse_draft_against(markdown: str, parser_markdown: str) -> ContentMarkdownDraft:
    return parse_content_markdown_draft(
        markdown,
        parser_result=_parser_result(parser_markdown),
        parser_markdown=parser_markdown,
    )


class AnalysisMarkdownTests(unittest.TestCase):
    def test_content_call_carries_the_same_parser_markdown_and_complete_final_metadata(
        self,
    ) -> None:
        parser_markdown = "# Parsed paper\n\nFull parser-neutral content.\n"
        parser_result = _parser_result(parser_markdown)
        final_metadata = _metadata()
        cancel_event = threading.Event()

        call = build_content_analysis_call(
            parser_result=parser_result,
            parser_markdown=parser_markdown,
            final_metadata=final_metadata,
            max_output_tokens=4096,
            cancel_event=cancel_event,
        )

        self.assertIs(call.request.kind, AnalysisRequestKind.CONTENT)
        self.assertNotIn("model", call.request.__dataclass_fields__)
        self.assertEqual(call.request.max_output_tokens, 4096)
        self.assertIs(call.cancel_event, cancel_event)
        structured_input = json.loads(call.structured_input)
        self.assertEqual(
            structured_input,
            {
                "final_metadata": final_metadata.model_dump(mode="json"),
                "parser_markdown": parser_markdown,
                "parser_result": parser_result.model_dump(mode="json"),
            },
        )
        self.assertEqual(
            call.request.input_sha256,
            sha256_digest(call.structured_input.encode("utf-8")),
        )
        self.assertEqual(
            json.loads(call.response_schema),
            {
                "additionalProperties": False,
                "properties": {"markdown": {"type": "string"}},
                "required": ["markdown"],
                "type": "object",
            },
        )
        self.assertNotIn("Target paper", call.prompt)
        self.assertIn("不得生成元数据、关键词或摘要", call.prompt)

    def test_content_call_rejects_parser_markdown_that_does_not_match_the_manifest(self) -> None:
        parser_markdown = "# Parsed paper\n"
        parser_result = _parser_result(parser_markdown)
        cases = (
            parser_markdown + "changed",
            parser_markdown.replace("paper", "other"),
        )
        for mismatched in cases:
            with self.subTest(mismatched=mismatched), self.assertRaises(ValueError) as caught:
                build_content_analysis_call(
                    parser_result=parser_result,
                    parser_markdown=mismatched,
                    final_metadata=_metadata(),
                    max_output_tokens=128,
                )
            self.assertNotIn(mismatched, repr(caught.exception))

    def test_draft_parser_requires_aligned_parser_input_and_rejects_invented_facts(
        self,
    ) -> None:
        parser_markdown = """# Source paper

The source reports 5 mg and the equation $E=mc^2$.
Its identifiers are DOI 10.1000/source, arXiv:2401.00001, PMID: 12345,
and PMCID: PMC123456.

# References

Ada A. Source title. 2024. DOI 10.1000/source.
"""
        parser_result = _parser_result(parser_markdown)
        valid_draft = """# 研究背景与目标

这是一句不要求逐字出现在原文中的合法总结。

# 研究方法

未提供

# 数据

剂量为 5 mg，关系式为 $E=mc^2$。

# 结论与局限性

未提供

# 参考文献

1. Ada A. Source title. 2024. DOI 10.1000/source.
"""

        parsed = parse_content_markdown_draft(
            valid_draft,
            parser_result=parser_result,
            parser_markdown=parser_markdown,
        )

        self.assertIn("合法总结", parsed.sections[0].markdown)
        self.assertEqual(
            parsed.references,
            ("Ada A. Source title. 2024. DOI 10.1000/source.",),
        )

        invented = {
            "doi": valid_draft.replace("10.1000/source", "10.9999/fake", 1),
            "arxiv": valid_draft.replace(
                "这是一句不要求逐字出现在原文中的合法总结。",
                "这是一句总结，标识符为 arXiv:9999.99999。",
                1,
            ),
            "pmid": valid_draft.replace(
                "这是一句不要求逐字出现在原文中的合法总结。",
                "这是一句总结，标识符为 PMID: 999999。",
                1,
            ),
            "pmcid": valid_draft.replace(
                "这是一句不要求逐字出现在原文中的合法总结。",
                "这是一句总结，标识符为 PMCID: PMC999999。",
                1,
            ),
            "reference text": valid_draft.replace(
                "Ada A. Source title. 2024. DOI 10.1000/source.",
                "Ada A. Fabricated title. 2024. DOI 10.1000/source.",
            ),
            "number and unit": valid_draft.replace("5 mg", "50 mg"),
            "formula": valid_draft.replace("$E=mc^2$", "$E=mc^3$"),
        }
        for name, draft in invented.items():
            with self.subTest(name=name), self.assertRaises(ContentMarkdownError) as caught:
                parse_content_markdown_draft(
                    draft,
                    parser_result=parser_result,
                    parser_markdown=parser_markdown,
                )
            self.assertNotIn("Source title", repr(caught.exception))

    def test_standalone_numbers_are_aligned_without_treating_markdown_markers_as_facts(
        self,
    ) -> None:
        parser_markdown = """# Source paper

The study reports 42 samples, a 5 mg dose, DOI 10.1000/source,
and the formula $E=mc^2$.
"""

        def draft_with_background(background: str) -> str:
            return _minimal_draft().replace(
                "未提供\n\n# 研究方法",
                f"{background}\n\n# 研究方法",
                1,
            )

        preserved = _parse_draft_against(
            draft_with_background(
                "The study reports 42 samples, a 5 mg dose, DOI 10.1000/source, and $E=mc^2$."
            ),
            parser_markdown,
        )
        self.assertIn("42 samples", preserved.sections[0].markdown)

        ordinary_summary = _parse_draft_against(
            draft_with_background("The study characterizes the sampled cohort."),
            parser_markdown,
        )
        self.assertIn("characterizes", ordinary_summary.sections[0].markdown)

        structural_numbers = _parse_draft_against(
            draft_with_background(
                "1. First qualitative observation.\n"
                "2. Second qualitative observation.\n\n"
                "## 3. Interpretation\n\n"
                "The observations are summarized qualitatively."
            ),
            parser_markdown,
        )
        self.assertEqual(structural_numbers.sections[0].subsections[0].title, "3. Interpretation")

        with self.assertRaises(ContentMarkdownError) as caught:
            _parse_draft_against(
                draft_with_background("The study reports 43 samples."),
                parser_markdown,
            )
        self.assertEqual(caught.exception.code, "number-alignment")

    def test_heading_text_numbers_are_aligned_but_heading_ordinals_are_structural(self) -> None:
        parser_markdown = "The source reports a cohort of 42 samples."

        def draft_with_background(background: str) -> str:
            return _minimal_draft().replace(
                "未提供\n\n# 研究方法",
                f"{background}\n\n# 研究方法",
                1,
            )

        preserved = _parse_draft_against(
            draft_with_background(
                "Summary of the cohort.\n\n## Cohort of 42 samples\n\nQualitative interpretation."
            ),
            parser_markdown,
        )
        self.assertEqual(preserved.sections[0].subsections[0].title, "Cohort of 42 samples")

        structural_ordinal = _parse_draft_against(
            draft_with_background(
                "Summary of the cohort.\n\n## 3. Interpretation\n\nQualitative interpretation."
            ),
            parser_markdown,
        )
        self.assertEqual(structural_ordinal.sections[0].subsections[0].title, "3. Interpretation")

        ordinary_summary = _parse_draft_against(
            draft_with_background("The study summarizes cohort composition."),
            parser_markdown,
        )
        self.assertIn("summarizes", ordinary_summary.sections[0].markdown)

        with self.assertRaises(ContentMarkdownError) as caught:
            _parse_draft_against(
                draft_with_background(
                    "Summary of the cohort.\n\n"
                    "## Cohort of 43 samples\n\nQualitative interpretation."
                ),
                parser_markdown,
            )
        self.assertEqual(caught.exception.code, "number-alignment")

    def test_measurement_alignment_preserves_unit_case_and_micro_symbol_equivalence(
        self,
    ) -> None:
        parser_markdown = "The source reports 5 M, 2 mM, and a length of 8 μm."

        def draft_with_data(data: str) -> str:
            return _minimal_draft().replace(
                "未提供\n\n# 结论与局限性",
                f"{data}\n\n# 结论与局限性",
                1,
            )

        exact = _parse_draft_against(draft_with_data("The concentration was 5 M."), parser_markdown)
        self.assertIn("5 M", exact.sections[2].markdown)

        for equivalent in ("8 μm", "8 µm", "8 um"):
            with self.subTest(equivalent=equivalent):
                parsed = _parse_draft_against(
                    draft_with_data(f"The measured length was {equivalent}."),
                    parser_markdown,
                )
                self.assertIn(equivalent, parsed.sections[2].markdown)

        for changed in ("5 m", "2 mm"):
            with self.subTest(changed=changed):
                with self.assertRaises(ContentMarkdownError) as caught:
                    _parse_draft_against(
                        draft_with_data(f"The reported value was {changed}."),
                        parser_markdown,
                    )
                self.assertEqual(caught.exception.code, "measurement-alignment")

    def test_draft_parser_rechecks_parser_manifest_without_retaining_source_text(self) -> None:
        parser_markdown = "# Source\n\nPrivate parser source text.\n"
        parser_result = _parser_result(parser_markdown)

        with self.assertRaises(ContentMarkdownError) as caught:
            parse_content_markdown_draft(
                _minimal_draft(),
                parser_result=parser_result,
                parser_markdown=parser_markdown + "tampered",
            )

        self.assertNotIn("Private parser source text", repr(caught.exception))

        with self.assertRaises(ContentMarkdownError):
            parse_content_markdown_response(
                _response(Sha256("c" * 64), {"markdown": _minimal_draft()}),
                parser_result=parser_result,
                parser_markdown=parser_markdown + "tampered",
            )

    def test_closed_response_contains_only_the_markdown_draft(self) -> None:
        parser_markdown = "# Parsed paper\n"
        call = build_content_analysis_call(
            parser_result=_parser_result(parser_markdown),
            parser_markdown=parser_markdown,
            final_metadata=_metadata(),
            max_output_tokens=128,
        )

        parsed = parse_content_markdown_response(
            _response(call.request.input_sha256, {"markdown": _minimal_draft()}),
            parser_result=_parser_result(parser_markdown),
            parser_markdown=parser_markdown,
        )

        self.assertIsInstance(parsed, ContentMarkdownDraft)
        self.assertEqual(len(parsed.sections), 4)
        self.assertEqual(parsed.references, ())

        for field_name in ("metadata", "keywords", "abstract"):
            with self.subTest(field_name=field_name), self.assertRaises(ContentMarkdownError):
                parse_content_markdown_response(
                    _response(
                        call.request.input_sha256,
                        {
                            "markdown": _minimal_draft(),
                            field_name: _PRIVATE_SENTINEL,
                        },
                    ),
                    parser_result=_parser_result(parser_markdown),
                    parser_markdown=parser_markdown,
                )

    def test_parser_preserves_extra_positions_h2_markdown_fences_and_reference_text(self) -> None:
        draft = f"""# 研究背景与目标

背景保持 12.5 μm、$E=mc^2$ 与 DOI 10.1234/example。

# 理论基础

直属理论说明。

## 定义

```python
# 元数据
### 代码中的标题不是文档标题
value = "{_PRIVATE_SENTINEL}"
```

# 研究方法

未提供

# 数据

## 样本

| 指标 | 值 |
| --- | --- |
| 长度 | 8 mm |

# 讨论

额外讨论保持原位。

# 结论与局限性

结论正文。

# 参考文献

1. Ada A. Exact title. DOI 10.1111/example.
2. Organization B. Report without a DOI.
"""

        parsed = _parse_draft(draft)

        self.assertEqual(
            tuple((section.role, section.title) for section in parsed.sections),
            (
                (LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES, None),
                (LiteratureSectionRole.ADDITIONAL, "理论基础"),
                (LiteratureSectionRole.METHODS, None),
                (LiteratureSectionRole.DATA, None),
                (LiteratureSectionRole.ADDITIONAL, "讨论"),
                (LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS, None),
            ),
        )
        self.assertEqual(
            parsed.sections[0].markdown,
            "背景保持 12.5 μm、$E=mc^2$ 与 DOI 10.1234/example。",
        )
        self.assertEqual(parsed.sections[1].markdown, "直属理论说明。")
        self.assertEqual(parsed.sections[1].subsections[0].title, "定义")
        self.assertIn("# 元数据", parsed.sections[1].subsections[0].markdown)
        self.assertIn(_PRIVATE_SENTINEL, parsed.sections[1].subsections[0].markdown)
        self.assertEqual(parsed.sections[3].markdown, "")
        self.assertIn("| 长度 | 8 mm |", parsed.sections[3].subsections[0].markdown)
        self.assertEqual(
            parsed.references,
            (
                "Ada A. Exact title. DOI 10.1111/example.",
                "Organization B. Report without a DOI.",
            ),
        )
        self.assertTrue(all(isinstance(reference, str) for reference in parsed.references))

    def test_fixed_missing_marker_and_empty_additional_sections_are_strict(self) -> None:
        cases = {
            "spaced fixed marker": _minimal_draft().replace("未提供", " 未提供 ", 1),
            "empty fixed section": _minimal_draft().replace(
                "未提供\n\n# 研究方法", "\n# 研究方法", 1
            ),
            "missing with h2": _minimal_draft().replace(
                "未提供\n\n# 研究方法",
                "未提供\n\n## 不应存在\n\n内容\n\n# 研究方法",
                1,
            ),
            "empty additional": _minimal_draft().replace(
                "# 研究方法",
                "# 空章节\n\n# 研究方法",
                1,
            ),
            "missing additional": _minimal_draft().replace(
                "# 研究方法",
                "# 空章节\n\n未提供\n\n# 研究方法",
                1,
            ),
            "empty h2": _minimal_draft().replace(
                "未提供\n\n# 研究方法",
                "## 空小节\n\n# 研究方法",
                1,
            ),
            "mixed missing marker": _minimal_draft().replace(
                "未提供\n\n# 研究方法",
                "未提供\n\n其它内容\n\n# 研究方法",
                1,
            ),
            "alternate missing marker": _minimal_draft().replace("未提供", "N/A", 1),
        }
        for name, draft in cases.items():
            with self.subTest(name=name), self.assertRaises(ContentMarkdownError) as caught:
                _parse_draft(draft)
            self.assertNotIn(_PRIVATE_SENTINEL, repr(caught.exception))

    def test_heading_contract_rejects_missing_duplicate_reordered_or_parallel_structure(
        self,
    ) -> None:
        base = _minimal_draft()
        reordered = """# 研究背景与目标

未提供

# 数据

未提供

# 研究方法

未提供

# 结论与局限性

未提供

# 参考文献

未提供
"""
        cases = {
            "missing": base.replace("# 研究方法\n\n未提供\n\n", "", 1),
            "duplicate": base.replace(
                "# 数据",
                "# 研究方法\n\n重复\n\n# 数据",
                1,
            ),
            "renamed": base.replace("# 研究方法", "# 方法", 1),
            "reordered": reordered,
            "additional before first": "# 理论\n\n内容\n\n" + base,
            "h1 after references": base + "\n# 附录\n\n内容\n",
            "metadata h1": base.replace("# 研究方法", "# 元数据\n\n并行值\n\n# 研究方法", 1),
            "abstract h1": base.replace("# 研究方法", "# 摘要\n\n并行值\n\n# 研究方法", 1),
            "english metadata": base.replace(
                "# 研究方法",
                "# Metadata\n\nparallel\n\n# 研究方法",
                1,
            ),
            "parallel keywords": base.replace(
                "# 研究方法",
                "# Keywords\n\nparallel\n\n# 研究方法",
                1,
            ),
            "parallel chinese title": base.replace(
                "# 研究方法",
                "# 标题\n\nparallel\n\n# 研究方法",
                1,
            ),
            "h3": base.replace("未提供", "### 不支持\n\n内容", 1),
            "h2 under references": base.replace(
                "# 参考文献\n\n未提供",
                "# 参考文献\n\n## 不支持\n\n内容",
                1,
            ),
            "parallel h2 keywords": base.replace(
                "未提供\n\n# 研究方法",
                "## Keywords\n\nparallel\n\n# 研究方法",
                1,
            ),
            "setext heading": base.replace(
                "未提供\n\n# 研究方法",
                "parallel metadata\n---\n\n# 研究方法",
                1,
            ),
            "preamble": _PRIVATE_SENTINEL + "\n\n" + base,
        }
        for name, draft in cases.items():
            with self.subTest(name=name), self.assertRaises(ContentMarkdownError) as caught:
                _parse_draft(draft)
            self.assertNotIn(_PRIVATE_SENTINEL, repr(caught.exception))

    def test_decorated_heading_titles_cannot_bypass_reserved_fixed_or_duplicate_rules(
        self,
    ) -> None:
        base = _minimal_draft()
        invalid = {
            "strong metadata": base.replace(
                "# 研究方法", "# **元数据**\n\nparallel\n\n# 研究方法", 1
            ),
            "emphasis abstract": base.replace(
                "# 研究方法", "# _摘要_\n\nparallel\n\n# 研究方法", 1
            ),
            "code metadata": base.replace(
                "# 研究方法", "# `Metadata`\n\nparallel\n\n# 研究方法", 1
            ),
            "html abstract": base.replace(
                "# 研究方法", "# <span>摘要</span>\n\nparallel\n\n# 研究方法", 1
            ),
            "linked keywords": base.replace(
                "# 研究方法",
                "# [Keywords](https://example.test/keywords)\n\nparallel\n\n# 研究方法",
                1,
            ),
            "decorated fixed": base.replace(
                "# 研究方法", "# **研究方法**\n\nparallel\n\n# 研究方法", 1
            ),
            "decorated duplicate": base.replace(
                "# 研究方法",
                "# 讨论\n\nFirst discussion.\n\n# **讨论**\n\nSecond discussion.\n\n# 研究方法",
                1,
            ),
        }
        for name, draft in invalid.items():
            with self.subTest(name=name), self.assertRaises(ContentMarkdownError):
                _parse_draft(draft)

        valid = base.replace(
            "未提供\n\n# 研究方法",
            """Visible content.

```markdown
# **元数据**
```

Inline `# _摘要_` remains code.

    # [Keywords](https://example.test/keywords)

# 讨论

An ordinary additional section.

# 研究方法""",
            1,
        )
        parsed = _parse_draft(valid)
        self.assertEqual(parsed.sections[1].title, "讨论")
        self.assertIn("# **元数据**", parsed.sections[0].markdown)

    def test_quoted_inline_html_heading_projection_is_bounded_and_fail_closed(self) -> None:
        base = _minimal_draft()
        quoted_reserved = {
            '<span title=">">摘要</span>': "摘要",
            '<span data-x="a>b">Metadata</span>': "metadata",
        }
        for title, expected_key in quoted_reserved.items():
            with self.subTest(key=title):
                self.assertEqual(heading_comparison_key(title), expected_key)

        for title in quoted_reserved:
            draft = base.replace(
                "# 研究方法",
                f"# {title}\n\nparallel\n\n# 研究方法",
                1,
            )
            with self.subTest(rejected=title), self.assertRaises(ContentMarkdownError):
                _parse_draft(draft)

        malformed = '<span title=">">摘要</span'
        over_budget = f'<span data-x="{"x" * 4097}">Metadata</span>'
        for title in (malformed, over_budget):
            with self.subTest(fail_closed_key=title[:40]), self.assertRaises(ContentMarkdownError):
                heading_comparison_key(title)
            draft = base.replace(
                "# 研究方法",
                f"# {title}\n\nparallel\n\n# 研究方法",
                1,
            )
            with (
                self.subTest(fail_closed_draft=title[:40]),
                self.assertRaises(ContentMarkdownError),
            ):
                _parse_draft(draft)

        ordinary_title = '<span title="a>b">讨论</span>'
        self.assertEqual(heading_comparison_key(ordinary_title), "讨论")
        ordinary = _parse_draft(
            base.replace(
                "# 研究方法",
                f"# {ordinary_title}\n\nOrdinary discussion.\n\n# 研究方法",
                1,
            )
        )
        self.assertEqual(ordinary.sections[1].title, ordinary_title)

    def test_reference_link_heading_titles_use_the_visible_label_for_all_rules(self) -> None:
        base = _minimal_draft()
        reserved = {
            "full metadata": ("[Metadata][metadata-id]", "metadata"),
            "collapsed abstract": ("[摘要][]", "摘要"),
            "shortcut keywords": ("[Keywords]", "keywords"),
            "decorated fixed": ("[**研究方法**][methods-id]", "研究方法"),
        }
        for name, (title, expected_key) in reserved.items():
            with self.subTest(key=name):
                self.assertEqual(heading_comparison_key(title), expected_key)

        for name, (title, _) in reserved.items():
            draft = base.replace(
                "# 研究方法",
                f"# {title}\n\nparallel\n\n# 研究方法",
                1,
            )
            with self.subTest(rejected=name), self.assertRaises(ContentMarkdownError):
                _parse_draft(draft)

        duplicate = base.replace(
            "# 研究方法",
            "# 讨论\n\nFirst discussion.\n\n"
            "# [讨论][discussion-id]\n\nSecond discussion.\n\n# 研究方法",
            1,
        )
        with self.assertRaises(ContentMarkdownError):
            _parse_draft(duplicate)

        ordinary_title = "[理论讨论][discussion-id]"
        self.assertEqual(heading_comparison_key(ordinary_title), "理论讨论")
        ordinary = _parse_draft(
            base.replace(
                "# 研究方法",
                f"# {ordinary_title}\n\nOrdinary discussion.\n\n# 研究方法",
                1,
            )
        )
        self.assertEqual(ordinary.sections[1].title, ordinary_title)

    def test_raw_html_and_entity_headings_cannot_bypass_the_heading_contract(self) -> None:
        base = _minimal_draft()
        invalid = {
            "raw metadata h1": base.replace(
                "# 研究方法",
                "<h1>元数据</h1>\n\nparallel\n\n# 研究方法",
                1,
            ),
            "raw abstract h1": base.replace(
                "# 研究方法",
                '<H1 class="parallel">摘要</H1>\n\nparallel\n\n# 研究方法',
                1,
            ),
            "raw h3": base.replace("未提供", "<h3>unsupported depth</h3>\n\ncontent", 1),
            "multiline raw h4": base.replace(
                "未提供",
                '<h4\nclass="unsupported">depth</h4>\n\ncontent',
                1,
            ),
            "entity metadata": base.replace(
                "# 研究方法",
                "# &#x5143;&#x6570;&#x636e;\n\nparallel\n\n# 研究方法",
                1,
            ),
            "entity abstract": base.replace(
                "# 研究方法",
                "# &#25688;&#35201;\n\nparallel\n\n# 研究方法",
                1,
            ),
            "entity setext": base.replace(
                "未提供\n\n# 研究方法",
                "&#x5143;&#x6570;&#x636e;\n===\n\n# 研究方法",
                1,
            ),
        }
        for name, draft in invalid.items():
            with self.subTest(name=name), self.assertRaises(ContentMarkdownError):
                _parse_draft(draft)

        encoded_fixed = base.replace("# 研究方法", "# &#x7814;&#x7a76;&#x65b9;&#x6cd5;", 1).replace(
            "# 参考文献", "# &#21442;&#32771;&#25991;&#29486;", 1
        )
        parsed = _parse_draft(encoded_fixed)
        self.assertEqual(len(parsed.sections), 4)

    def test_html_heading_text_in_code_contexts_is_not_structural(self) -> None:
        draft = _minimal_draft().replace(
            "未提供\n\n# 研究方法",
            """Visible content.

```html
<h1>元数据</h1>
<h3>hidden depth</h3>
```

Inline `<h1>摘要</h1>` remains code.

    <h2>indented code</h2>

# 研究方法""",
            1,
        )

        parsed = _parse_draft(draft)

        self.assertIn("<h1>元数据</h1>", parsed.sections[0].markdown)
        self.assertIn("Inline `<h1>摘要</h1>`", parsed.sections[0].markdown)
        self.assertIn("    <h2>indented code</h2>", parsed.sections[0].markdown)

    def test_html_heading_tags_are_closed_outside_code_and_raw_text_contexts(self) -> None:
        base = _minimal_draft()
        invalid = {
            "nested in container": base.replace(
                "未提供", "<div><h1>parallel heading</h1></div>", 1
            ),
            "after visible text": base.replace(
                "未提供", 'Prefix <section><h2 class="bad">nested</h2></section>.', 1
            ),
            "multiline nested tag": base.replace(
                "未提供",
                '<section>prefix<h6\n class="bad">nested</h6></section>',
                1,
            ),
        }
        for name, draft in invalid.items():
            with self.subTest(name=name), self.assertRaises(ContentMarkdownError):
                _parse_draft(draft)

        code_and_raw_text = base.replace(
            "未提供\n\n# 研究方法",
            """Visible content.

```html
<h1>fenced code</h1>
```

Inline `<h2>inline code</h2>` remains code.

    <h3>indented code</h3>

<pre><h4>preformatted sample</h4></pre>
<script>const sample = "<h5>script sample</h5>";</script>
<style>.sample::before { content: "<h6>style sample</h6>"; }</style>
<textarea><h1>textarea sample</h1></textarea>

# 研究方法""",
            1,
        )
        parsed = _parse_draft(code_and_raw_text)
        self.assertIn("<h1>fenced code</h1>", parsed.sections[0].markdown)
        self.assertIn("`<h2>inline code</h2>`", parsed.sections[0].markdown)
        self.assertIn("    <h3>indented code</h3>", parsed.sections[0].markdown)
        self.assertIn("<pre><h4>preformatted sample</h4></pre>", parsed.sections[0].markdown)

        sections = (
            LiteratureSection(
                role=LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
                title=None,
                markdown="""Prefix <div><h3>section injection</h3></div>.

```html
<h1>fenced code</h1>
```

Inline `<h2>inline code</h2>` remains code.

    <h3>indented code</h3>

<pre><h4>raw text</h4></pre>""",
            ),
            LiteratureSection(
                role=LiteratureSectionRole.METHODS,
                title=None,
                markdown="未提供",
            ),
            LiteratureSection(
                role=LiteratureSectionRole.DATA,
                title=None,
                markdown="",
                subsections=(
                    LiteratureSubsection(
                        title="Sample",
                        markdown='Prefix <h4 class="bad">subsection injection</h4>.',
                    ),
                ),
            ),
            LiteratureSection(
                role=LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
                title=None,
                markdown="未提供",
            ),
        )
        rendered = render_canonical_markdown(
            metadata=LiteratureMetadata(
                title="Prefix <div><h1>metadata injection</h1></div>.",
                abstract='Prefix <h2 class="bad">abstract injection</h2>.',
            ),
            sections=sections,
            references=("Prefix <h5>reference injection</h5>.",),
        ).decode("utf-8")

        for opening, text, closing in (
            ("<h1>", "metadata injection", "</h1>"),
            ('<h2 class="bad">', "abstract injection", "</h2>"),
            ("<h3>", "section injection", "</h3>"),
            ('<h4 class="bad">', "subsection injection", "</h4>"),
            ("<h5>", "reference injection", "</h5>"),
        ):
            with self.subTest(text=text):
                self.assertIn(f"\\{opening}{text}\\{closing}", rendered)

        self.assertIn("```html\n<h1>fenced code</h1>\n```", rendered)
        self.assertIn("Inline `<h2>inline code</h2>` remains code.", rendered)
        self.assertIn("    <h3>indented code</h3>", rendered)
        self.assertIn("<pre><h4>raw text</h4></pre>", rendered)

    def test_malformed_or_over_budget_html_heading_prefixes_fail_closed_everywhere(
        self,
    ) -> None:
        long_heading = f'<div><h2 data-x="{"x" * 4097}">long heading</h2></div>'
        malformed_heading = '<div><h3 data-x="unterminated>malformed heading</h3></div>'
        payloads = {
            "over budget": long_heading,
            "malformed": malformed_heading,
        }
        for name, payload in payloads.items():
            draft = _minimal_draft().replace("未提供", payload, 1)
            with self.subTest(draft=name):
                with self.assertRaises(ContentMarkdownError) as caught:
                    _parse_draft(draft)
                self.assertEqual(caught.exception.code, "html-heading")

        def render_with_payload(location: str, payload: str) -> bytes:
            metadata = LiteratureMetadata(
                title=payload if location == "metadata" else "Safe title",
                abstract=payload if location == "abstract" else "Safe abstract",
            )
            background = payload if location == "section" else "Safe background."
            data_markdown = "" if location == "subsection" else "Safe data."
            subsections = (
                (LiteratureSubsection(title="Sample", markdown=payload),)
                if location == "subsection"
                else ()
            )
            sections = (
                LiteratureSection(
                    role=LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
                    title=None,
                    markdown=background,
                ),
                LiteratureSection(
                    role=LiteratureSectionRole.METHODS,
                    title=None,
                    markdown="Safe methods.",
                ),
                LiteratureSection(
                    role=LiteratureSectionRole.DATA,
                    title=None,
                    markdown=data_markdown,
                    subsections=subsections,
                ),
                LiteratureSection(
                    role=LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
                    title=None,
                    markdown="Safe conclusion.",
                ),
            )
            references = (payload,) if location == "reference" else ("Safe reference.",)
            return render_canonical_markdown(
                metadata=metadata,
                sections=sections,
                references=references,
            )

        for name, payload in payloads.items():
            for location in ("metadata", "abstract", "section", "subsection", "reference"):
                with self.subTest(renderer=name, location=location):
                    with self.assertRaises(ContentMarkdownError) as caught:
                        render_with_payload(location, payload)
                    self.assertEqual(caught.exception.code, "html-heading")

        long_literal = f'<h1 data-x="{"x" * 4097}">literal heading sample</h1>'
        protected_draft = _minimal_draft().replace(
            "未提供\n\n# 研究方法",
            f"""Visible content.

```html
{long_literal}
```

Inline `{long_literal}` remains code.

    {long_literal}

<pre>{long_literal}</pre>
<script>const sample = "{long_literal}";</script>
<style>.sample::before {{ content: "{long_literal}"; }}</style>
<textarea>{long_literal}</textarea>

# 研究方法""",
            1,
        )
        protected = _parse_draft(protected_draft)
        self.assertGreaterEqual(protected.sections[0].markdown.count(long_literal), 7)
        rendered = render_canonical_markdown(
            metadata=_metadata(),
            sections=protected.sections,
            references=protected.references,
        ).decode("utf-8")
        self.assertGreaterEqual(rendered.count(long_literal), 7)

    def test_reference_section_accepts_only_exact_missing_or_sequential_ordered_items(self) -> None:
        missing = _parse_draft(_minimal_draft())
        self.assertEqual(missing.references, ())

        references = _parse_draft(
            _minimal_draft(references="1. First raw text.\n2. Second raw text without DOI.")
        )
        self.assertEqual(
            references.references,
            ("First raw text.", "Second raw text without DOI."),
        )

        multiline = _parse_draft(
            _minimal_draft(references="1. First line.\n   Continued raw text.\n2. Next item.")
        )
        self.assertEqual(
            multiline.references,
            ("First line.\nContinued raw text.", "Next item."),
        )

        invalid_references = (
            "- unordered item",
            "a paragraph",
            "1. first\n3. skipped",
            "1. 未提供",
            "1. unknown",
            "未提供\n1. extra",
            "1. first\n  insufficient indentation",
        )
        for value in invalid_references:
            with self.subTest(value=value), self.assertRaises(ContentMarkdownError):
                _parse_draft(_minimal_draft(references=value))

    def test_only_the_exact_raw_missing_marker_is_accepted_as_missing(self) -> None:
        base = _minimal_draft()
        decorated = (
            "**未提供**",
            "_未提供_",
            "`未提供`",
            "<span>未提供</span>",
            "<!-- wrapper --><strong>未提供</strong>",
        )
        for value in decorated:
            with self.subTest(section=value), self.assertRaises(ContentMarkdownError):
                _parse_draft(base.replace("未提供", value, 1))
            with self.subTest(reference=value), self.assertRaises(ContentMarkdownError):
                _parse_draft(_minimal_draft(references=f"1. {value}"))

        comment_only = {
            "additional h1": base.replace(
                "# 研究方法",
                "# 注释章节\n\n<!-- comment only -->\n\n# 研究方法",
                1,
            ),
            "h2": base.replace(
                "未提供\n\n# 研究方法",
                "## 注释小节\n\n<!-- comment only -->\n\n# 研究方法",
                1,
            ),
        }
        for name, draft in comment_only.items():
            with self.subTest(name=name), self.assertRaises(ContentMarkdownError):
                _parse_draft(draft)

        real_sentence = _parse_draft(
            base.replace("未提供", "资料未提供，因此本文讨论这一证据缺口。", 1)
        )
        self.assertIn("资料未提供", real_sentence.sections[0].markdown)

    def test_indented_and_tilde_fenced_heading_text_is_not_structural(self) -> None:
        draft = _minimal_draft().replace(
            "未提供\n\n# 研究方法",
            """Visible content.

~~~~text
# 摘要
### hidden depth
~~~~

    # 元数据

# 研究方法""",
            1,
        )

        parsed = _parse_draft(draft)

        self.assertIn("# 摘要", parsed.sections[0].markdown)
        self.assertIn("### hidden depth", parsed.sections[0].markdown)
        self.assertIn("    # 元数据", parsed.sections[0].markdown)

    def test_renderer_has_one_deterministic_utf8_golden_document(self) -> None:
        draft = """# 研究背景与目标

Background.

# 理论基础

Theory.

## 定义

Definition body.

# 研究方法

未提供

# 数据

## 样本

8 mm sample.

# 结论与局限性

Conclusion.

# 参考文献

1. First reference.
2. Second reference.
"""
        parsed = _parse_draft(draft)

        rendered = render_canonical_markdown(
            metadata=_metadata(),
            sections=parsed.sections,
            references=parsed.references,
        )

        expected = """# 元数据

+ Title: Target paper
+ Authors:
  1. Ada Lovelace
     + Kind: person
     + Given Name: Ada
     + Family Name: Lovelace
     + ORCID: 0000-0002-1825-0097
     + Affiliations:
       1. Analytical Engine Institute
          + ROR: 03yrm5c26
  2. Example Collaboration
     + Kind: organization
+ DOI: 10.1234/example
+ Other Identifiers: arxiv:2401.00001, pmid:12345
+ Publication Date: 2024-01-02
+ Year: 2024
+ Document Type: article
+ Language: en
+ Venue: Journal of Fixtures
+ Publisher: Fixture Publisher
+ Volume: 7
+ Issue: 2
+ Pages: e123
+ Keywords: analysis, verification

# 摘要

The final first-stage abstract.

# 研究背景与目标

Background.

# 理论基础

Theory.

## 定义

Definition body.

# 研究方法

未提供

# 数据

## 样本

8 mm sample.

# 结论与局限性

Conclusion.

# 参考文献

1. First reference.
2. Second reference.
""".encode("utf-8")
        self.assertEqual(rendered, expected)
        self.assertEqual(
            rendered,
            render_canonical_markdown(
                metadata=_metadata(),
                sections=parsed.sections,
                references=parsed.references,
            ),
        )
        self.assertEqual(rendered.decode("utf-8").count("# 元数据\n"), 1)
        self.assertEqual(rendered.decode("utf-8").count("# 摘要\n"), 1)

    def test_renderer_uses_the_exact_missing_marker_for_all_absent_metadata(self) -> None:
        parsed = _parse_draft(_minimal_draft())

        rendered = render_canonical_markdown(
            metadata=_metadata(complete=False),
            sections=parsed.sections,
            references=parsed.references,
        ).decode("utf-8")

        self.assertIn("+ Authors: 未提供\n", rendered)
        self.assertIn("+ DOI: 未提供\n", rendered)
        self.assertIn("+ Keywords: 未提供\n", rendered)
        self.assertIn("# 摘要\n\n未提供\n", rendered)
        self.assertTrue(rendered.endswith("# 参考文献\n\n未提供\n"))

    def test_renderer_prevents_metadata_text_from_creating_parallel_h1(self) -> None:
        parsed = _parse_draft(_minimal_draft())
        metadata = LiteratureMetadata(
            title="First line\n# injected heading",
            abstract="Abstract line\n# injected abstract heading",
        )

        rendered = render_canonical_markdown(
            metadata=metadata,
            sections=parsed.sections,
            references=("First line.\nContinued raw text.",),
        ).decode("utf-8")

        self.assertIn("+ Title: First line\n    \\# injected heading", rendered)
        self.assertIn("Abstract line\n\\# injected abstract heading", rendered)
        self.assertIn("1. First line.\n   Continued raw text.", rendered)
        self.assertEqual(
            sum(line.startswith("# ") for line in rendered.splitlines()),
            7,
        )

    def test_renderer_neutralizes_raw_html_headings_in_every_free_text_field(self) -> None:
        sections = (
            LiteratureSection(
                role=LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
                title=None,
                markdown="<h3>body injection</h3>",
            ),
            LiteratureSection(
                role=LiteratureSectionRole.METHODS,
                title=None,
                markdown="未提供",
            ),
            LiteratureSection(
                role=LiteratureSectionRole.DATA,
                title=None,
                markdown="",
                subsections=(
                    LiteratureSubsection(
                        title="Sample",
                        markdown="<h4>subsection injection</h4>",
                    ),
                ),
            ),
            LiteratureSection(
                role=LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
                title=None,
                markdown="未提供",
            ),
        )
        metadata = LiteratureMetadata(
            title="<h1>metadata injection</h1>",
            abstract="<h2>abstract injection</h2>",
        )

        rendered = render_canonical_markdown(
            metadata=metadata,
            sections=sections,
            references=("<h5>reference injection</h5>",),
        ).decode("utf-8")

        for level, value in (
            (1, "metadata injection"),
            (2, "abstract injection"),
            (3, "body injection"),
            (4, "subsection injection"),
            (5, "reference injection"),
        ):
            with self.subTest(level=level):
                self.assertIn(f"\\<h{level}>{value}\\</h{level}>", rendered)
                self.assertNotIn(f"\n<h{level}>{value}</h{level}>", rendered)

    def test_renderer_preserves_html_heading_text_inside_code(self) -> None:
        parsed = _parse_draft(
            _minimal_draft().replace(
                "未提供\n\n# 研究方法",
                "```html\n<h1>code sample</h1>\n```\n\n# 研究方法",
                1,
            )
        )

        rendered = render_canonical_markdown(
            metadata=_metadata(),
            sections=parsed.sections,
            references=parsed.references,
        ).decode("utf-8")

        self.assertIn("```html\n<h1>code sample</h1>\n```", rendered)


if __name__ == "__main__":
    unittest.main()
