from __future__ import annotations

import hashlib
import io
import os
import stat
import tempfile
import unittest
import warnings
import zipfile
from contextlib import AbstractContextManager, closing
from pathlib import Path
from typing import BinaryIO
from unittest.mock import patch

from sciretriever.model.parsing import (
    ParserArtifactRef,
    ParserProvenance,
    ParserResource,
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
from sciretriever.parsing.archive import (
    ParserArchiveBounds,
    ParserArchiveError,
    extract_parser_archive,
)
from sciretriever.parsing.markdown import (
    MarkdownConversionBounds,
    MarkdownConversionError,
    canonical_resource_path,
    normalize_parser_markdown,
    validated_markdown_resource_references,
)
from sciretriever.parsing.ports import StagedParserArtifact, StagedParserResource
from sciretriever.parsing.resources import (
    NormalizedParserArtifacts,
    ParserResourceBounds,
    ParserResourceConversionError,
    convert_parser_artifacts,
    validate_normalized_parser_artifacts,
)

_REAL_TEMPORARY_DIRECTORY = tempfile.TemporaryDirectory
_PNG = b"\x89PNG\r\n\x1a\nfixture-image"
_CSV = b"column,value\nalpha,1\n"
_MARKDOWN = (
    b"# Parsed\n\n"
    b'![figure](./images/Figure%201.PNG "caption")\n\n'
    b"![table][data]\n\n"
    b"[data]: <tables/data.csv>\n\n"
    b"`![inline](../ignored.png)`\n\n"
    b"```markdown\n![fenced](%252e%252e/private.png)\n```\n\n"
    b"ordinary text mentions images/not-a-reference.png\n"
)


class _BytesContent:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.open_calls = 0

    def open(self) -> AbstractContextManager[BinaryIO]:
        self.open_calls += 1
        return closing(io.BytesIO(self.payload))

    def __repr__(self) -> str:
        return "_BytesContent(<redacted>)"


class _TemporaryRecorder:
    def __init__(self) -> None:
        self.paths: list[Path] = []

    def __call__(self, *, prefix: str) -> tempfile.TemporaryDirectory[str]:
        temporary = _REAL_TEMPORARY_DIRECTORY(prefix=prefix)
        self.paths.append(Path(temporary.name))
        return temporary


def _artifact(
    payload: bytes,
    media_type: str,
    *,
    declared_sha256: Sha256 | None = None,
    declared_size: int | None = None,
    content: _BytesContent | None = None,
) -> StagedParserArtifact:
    return StagedParserArtifact(
        artifact=ParserArtifactRef(
            sha256=sha256_digest(payload) if declared_sha256 is None else declared_sha256,
            media_type=media_type,
            byte_size=len(payload) if declared_size is None else declared_size,
        ),
        content=_BytesContent(payload) if content is None else content,
    )


def _resource(
    reference: str,
    payload: bytes,
    media_type: str,
    *,
    declared_sha256: Sha256 | None = None,
    declared_size: int | None = None,
    content: _BytesContent | None = None,
) -> StagedParserResource:
    return StagedParserResource(
        reference=reference,
        artifact=_artifact(
            payload,
            media_type,
            declared_sha256=declared_sha256,
            declared_size=declared_size,
            content=content,
        ),
    )


def _read(content: object) -> bytes:
    opener = getattr(content, "open")
    with opener() as stream:
        return stream.read()


def _parser_result_hash(value: NormalizedParserArtifacts) -> Sha256:
    source_sha256 = Sha256("a" * 64)
    provenance = ParserProvenance(
        provenance=Provenance(
            provenance_id=ProvenanceId("123e4567-e89b-12d3-a456-426614174101"),
            source_kind=SourceKind.PARSER,
            source_name="fixture-parser",
            source_record_id=None,
            observed_at=UtcTimestamp("2026-08-12T03:04:05Z"),
            input_sha256=source_sha256,
            parameters_sha256=Sha256("b" * 64),
        ),
        parser_version="1.0",
        mode="fixture",
        model_identity=None,
    )
    return parser_result_sha256(
        source_asset_id=AssetId("123e4567-e89b-12d3-a456-426614174102"),
        source_sha256=source_sha256,
        page_count=2,
        markdown=value.markdown.artifact,
        resources=tuple(
            ParserResource(
                reference=resource.reference,
                artifact=resource.artifact.artifact,
            )
            for resource in value.resources
        ),
        provenance=provenance,
    )


def _zip(
    entries: tuple[tuple[str | zipfile.ZipInfo, bytes], ...],
    *,
    compression: int = zipfile.ZIP_STORED,
) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=compression) as archive:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            for name, payload in entries:
                if isinstance(name, zipfile.ZipInfo):
                    name.compress_type = compression
                archive.writestr(name, payload)
    return output.getvalue()


def _encrypted(payload: bytes) -> bytes:
    result = bytearray(payload)
    for signature, flag_offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        position = result.index(signature)
        flags = int.from_bytes(
            result[position + flag_offset : position + flag_offset + 2], "little"
        )
        result[position + flag_offset : position + flag_offset + 2] = (flags | 1).to_bytes(
            2, "little"
        )
    return bytes(result)


class ParsingResourceTests(unittest.TestCase):
    def test_markdown_resources_are_normalized_filtered_and_content_addressed(self) -> None:
        figure_content = _BytesContent(_PNG)
        table_content = _BytesContent(_CSV)
        unused_content = _BytesContent(_PNG)
        private_json_content = _BytesContent(b'{"private": true}')
        candidates = (
            _resource(
                "bundle/images/Figure 1.PNG",
                _PNG,
                "image/png",
                content=figure_content,
            ),
            _resource(
                "bundle/tables/data.csv",
                _CSV,
                "text/csv",
                content=table_content,
            ),
            _resource(
                "bundle/images/unused.png",
                _PNG,
                "image/png",
                content=unused_content,
            ),
            _resource(
                "bundle/middle.json",
                b'{"private": true}',
                "application/json",
                content=private_json_content,
            ),
        )

        converted = convert_parser_artifacts(
            _artifact(_MARKDOWN, "text/markdown"),
            markdown_source_reference="bundle/full.md",
            candidates=candidates,
        )

        normalized = _read(converted.markdown.content)
        self.assertIn(b'![figure](<bundle/images/Figure 1.PNG> "caption")', normalized)
        self.assertIn(b"[data]: <bundle/tables/data.csv>", normalized)
        self.assertIn(b"![fenced](%252e%252e/private.png)", normalized)
        self.assertIn(b"ordinary text mentions images/not-a-reference.png", normalized)
        self.assertEqual(
            converted.markdown.artifact,
            ParserArtifactRef(
                sha256=sha256_digest(normalized),
                media_type="text/markdown",
                byte_size=len(normalized),
            ),
        )
        self.assertEqual(
            tuple(resource.reference for resource in converted.resources),
            ("bundle/images/Figure 1.PNG", "bundle/tables/data.csv"),
        )
        self.assertEqual(
            tuple(_read(resource.artifact.content) for resource in converted.resources),
            (_PNG, _CSV),
        )
        self.assertEqual(figure_content.open_calls, 1)
        self.assertEqual(table_content.open_calls, 1)
        self.assertEqual(unused_content.open_calls, 0)
        self.assertEqual(private_json_content.open_calls, 0)

    def test_conversion_and_result_hash_are_deterministic_across_candidate_order(self) -> None:
        markdown = _artifact(
            b"![z](images/z.png)\n![a](images/a.png)\n",
            "text/markdown",
        )
        candidates = (
            _resource("bundle/images/z.png", _PNG + b"z", "image/png"),
            _resource("bundle/images/a.png", _PNG + b"a", "image/png"),
        )

        first = convert_parser_artifacts(
            markdown,
            markdown_source_reference="bundle/full.md",
            candidates=candidates,
        )
        second = convert_parser_artifacts(
            markdown,
            markdown_source_reference="bundle/full.md",
            candidates=tuple(reversed(candidates)),
        )

        self.assertEqual(first.markdown.artifact, second.markdown.artifact)
        self.assertEqual(
            tuple((item.reference, item.artifact.artifact) for item in first.resources),
            tuple((item.reference, item.artifact.artifact) for item in second.resources),
        )
        self.assertEqual(_parser_result_hash(first), _parser_result_hash(second))
        normalized_payload = _read(first.markdown.content)
        self.assertEqual(
            validated_markdown_resource_references(normalized_payload),
            ("bundle/images/a.png", "bundle/images/z.png"),
        )

        with self.assertRaises(MarkdownConversionError) as caught:
            validated_markdown_resource_references(b"![a](./images/a.png)\n")
        self.assertEqual(caught.exception.code, "markdown-reference-invalid")

    def test_html_image_src_is_parsed_outside_code_and_rewritten_safely(self) -> None:
        payload = b'<img alt="literal > marker" src="./images/Figure%201.PNG">\n'

        normalized = normalize_parser_markdown(
            payload,
            source_reference="bundle/full.md",
        )

        self.assertEqual(
            normalized.payload,
            b'<img alt="literal > marker" src="bundle/images/Figure 1.PNG">\n',
        )
        self.assertEqual(
            tuple(resource.reference for resource in normalized.resources),
            ("bundle/images/Figure 1.PNG",),
        )

        with self.assertRaises(MarkdownConversionError) as caught:
            normalize_parser_markdown(
                b'<img src="https://user:secret@example.invalid/private.png">\n',
                source_reference="bundle/full.md",
            )
        self.assertEqual(caught.exception.code, "markdown-reference-invalid")

    def test_html_srcset_candidates_are_rewritten_and_form_the_exact_closure(self) -> None:
        payload = (
            b"<picture>\n"
            b"<SOURCE SRCSET='images/a.png'>\n"
            b'<img src="images/fallback.png" '
            b'SrCsEt="images/a.png 1x, images/Figure%25201.PNG 2x">\n'
            b"<source srcset=images/c.png>\n"
            b"</picture>\n"
        )

        normalized = normalize_parser_markdown(
            payload,
            source_reference="bundle/full.md",
        )

        self.assertEqual(
            normalized.payload,
            (
                b"<picture>\n"
                b"<SOURCE SRCSET='bundle/images/a.png'>\n"
                b'<img src="bundle/images/fallback.png" '
                b'SrCsEt="bundle/images/a.png 1x, '
                b'bundle/images/Figure%201.PNG 2x">\n'
                b"<source srcset=bundle/images/c.png>\n"
                b"</picture>\n"
            ),
        )
        self.assertEqual(
            tuple(resource.reference for resource in normalized.resources),
            (
                "bundle/images/Figure 1.PNG",
                "bundle/images/a.png",
                "bundle/images/c.png",
                "bundle/images/fallback.png",
            ),
        )
        self.assertEqual(
            validated_markdown_resource_references(
                b'<picture><source srcset="images/a.png"><img srcset="images/b.png 2x"></picture>\n'
            ),
            ("images/a.png", "images/b.png"),
        )

    def test_html_srcset_widths_encoded_commas_and_repeated_urls_are_supported(
        self,
    ) -> None:
        payload = (
            b'<source srcset="images/a%2Cb.png 320w, images/b.png 640w">\n'
            b'<img srcset="images/repeated.png 1x, images/repeated.png 2x">\n'
        )

        normalized = normalize_parser_markdown(
            payload,
            source_reference="bundle/full.md",
        )

        self.assertEqual(
            normalized.payload,
            (
                b'<source srcset="bundle/images/a%2Cb.png 320w, '
                b'bundle/images/b.png 640w">\n'
                b'<img srcset="bundle/images/repeated.png 1x, '
                b'bundle/images/repeated.png 2x">\n'
            ),
        )
        self.assertEqual(
            tuple(resource.reference for resource in normalized.resources),
            (
                "bundle/images/a,b.png",
                "bundle/images/b.png",
                "bundle/images/repeated.png",
            ),
        )
        self.assertEqual(
            validated_markdown_resource_references(normalized.payload),
            (
                "bundle/images/a,b.png",
                "bundle/images/b.png",
                "bundle/images/repeated.png",
            ),
        )

    def test_srcset_resources_are_retained_and_missing_members_fail_closed(self) -> None:
        markdown = _artifact(
            b'<picture><source srcset="images/a.png 1x, images/b.png 2x">'
            b'<img src="images/fallback.png"></picture>\n',
            "text/markdown",
        )
        candidates = (
            _resource("bundle/images/a.png", _PNG + b"a", "image/png"),
            _resource("bundle/images/b.png", _PNG + b"b", "image/png"),
            _resource("bundle/images/fallback.png", _PNG + b"fallback", "image/png"),
        )

        converted = convert_parser_artifacts(
            markdown,
            markdown_source_reference="bundle/full.md",
            candidates=candidates,
        )

        self.assertEqual(
            tuple(resource.reference for resource in converted.resources),
            (
                "bundle/images/a.png",
                "bundle/images/b.png",
                "bundle/images/fallback.png",
            ),
        )

        with self.assertRaises(ParserResourceConversionError) as caught:
            convert_parser_artifacts(
                markdown,
                markdown_source_reference="bundle/full.md",
                candidates=(candidates[0], candidates[2]),
            )
        self.assertEqual(caught.exception.code, "resource-reference-missing")

    def test_html_src_and_srcset_are_exact_attributes_and_duplicates_fail_closed(
        self,
    ) -> None:
        data_only = (
            b'<img data-src="safe.png" xlink:src="also-safe.png">\n'
            b'<source DATA-SRC="source-safe.png" data-srcset="candidate.png 1x">\n'
        )

        normalized = normalize_parser_markdown(
            data_only,
            source_reference="bundle/full.md",
        )

        self.assertEqual(normalized.payload, data_only)
        self.assertEqual(normalized.resources, ())

        unsafe = (
            b'<img data-src="safe.png" src="../../escape.png">\n',
            b'<source data-src="safe.png" src="https://external.invalid/x.png">\n',
            b'<img title=\'literal src="safe.png"\' src="../../escape.png">\n',
            b'<img src="images/first.png" SRC="images/second.png">\n',
            b'<img srcset="images/first.png" SRCSET="images/second.png">\n',
            b'<img alt="missing separator"src="images/ambiguous.png">\n',
            b"<img src>\n",
            b"<img src=>\n",
            b"<source srcset>\n",
            b"<source srcset=>\n",
        )
        for payload in unsafe:
            with self.subTest(payload=payload):
                with self.assertRaises(MarkdownConversionError) as caught:
                    normalize_parser_markdown(
                        payload,
                        source_reference="bundle/full.md",
                    )
                self.assertEqual(caught.exception.code, "markdown-reference-invalid")
                self.assertNotIn("escape.png", str(caught.exception))
                self.assertNotIn("external.invalid", repr(caught.exception))

    def test_html_srcset_rejects_external_unsafe_and_ambiguous_candidates(self) -> None:
        invalid_srcsets = (
            "https://example.invalid/a.png 1x, images/b.png 2x",
            "http://example.invalid/a.png 1x",
            "data:image/png;base64,AAAA 1x, images/b.png 2x",
            "/absolute/a.png 1x",
            "../parent.png 1x",
            r"images\backslash.png 1x",
            r"C:\drive.png 1x",
            "%252e%252e/private.png 1x",
            "https%253A%252F%252Fexample.invalid%252Fa.png 1x",
            "images/a&#32;1x",
        )

        for srcset in invalid_srcsets:
            with self.subTest(srcset=srcset):
                with self.assertRaises(MarkdownConversionError) as caught:
                    normalize_parser_markdown(
                        f'<img srcset="{srcset}">\n'.encode(),
                        source_reference="bundle/full.md",
                    )
                self.assertEqual(caught.exception.code, "markdown-reference-invalid")
                self.assertNotIn(srcset, str(caught.exception))
                self.assertNotIn(srcset, repr(caught.exception))

    def test_html_srcset_rejects_empty_malformed_and_mixed_descriptors(self) -> None:
        invalid_srcsets = (
            "",
            "   ",
            "images/a.png x",
            "images/a.png 1q",
            "images/a.png 0w",
            "images/a.png -1x",
            "images/a.png 1x 2x",
            "images/a.png 320w, images/b.png 2x",
            ", images/a.png 1x",
            "images/a.png 1x,, images/b.png 2x",
            "images/a.png 1x,",
        )

        for srcset in invalid_srcsets:
            with self.subTest(srcset=srcset):
                with self.assertRaises(MarkdownConversionError) as caught:
                    normalize_parser_markdown(
                        f'<source srcset="{srcset}">\n'.encode(),
                        source_reference="bundle/full.md",
                    )
                self.assertEqual(caught.exception.code, "markdown-reference-invalid")

    def test_html_srcset_candidates_obey_count_and_character_budgets(self) -> None:
        with self.assertRaises(MarkdownConversionError) as caught:
            normalize_parser_markdown(
                b'<img srcset="images/a.png 1x, images/b.png 2x">\n',
                source_reference="bundle/full.md",
                bounds=MarkdownConversionBounds(max_resource_references=1),
            )
        self.assertEqual(caught.exception.code, "markdown-budget-exceeded")

        with self.assertRaises(MarkdownConversionError) as caught:
            normalize_parser_markdown(
                b'<source srcset="images/reference-too-long.png">\n',
                source_reference="b.md",
                bounds=MarkdownConversionBounds(max_reference_characters=12),
            )
        self.assertEqual(caught.exception.code, "markdown-reference-invalid")

    def test_html_boolean_attributes_preserve_the_separator_before_src(self) -> None:
        for boolean_attribute in ("hidden", "ismap"):
            with self.subTest(boolean_attribute=boolean_attribute):
                payload = f'<img {boolean_attribute} src="images/a.png">\n'.encode()

                normalized = normalize_parser_markdown(
                    payload,
                    source_reference="bundle/full.md",
                )

                self.assertEqual(
                    normalized.payload,
                    f'<img {boolean_attribute} src="bundle/images/a.png">\n'.encode(),
                )
                self.assertEqual(
                    tuple(resource.reference for resource in normalized.resources),
                    ("bundle/images/a.png",),
                )

    def test_fenced_inline_code_and_plain_text_are_not_resource_references(self) -> None:
        markdown = (
            b"```markdown\n![escape](../private.png)\n```\n"
            b"`![inline](C:%5cprivate.png)`\n"
            b"ordinary images/figure.png and ! \\[not-an-image](../x.png)\n"
        )

        normalized = normalize_parser_markdown(
            markdown,
            source_reference="bundle/full.md",
        )

        self.assertEqual(normalized.payload, markdown)
        self.assertEqual(normalized.resources, ())

    def test_unsafe_or_encoded_image_references_fail_closed(self) -> None:
        unsafe = (
            "/etc/passwd",
            "../private.png",
            "images\\private.png",
            "C:\\private.png",
            "https://example.invalid/private.png",
            "//user:secret@example.invalid/private.png",
            "file:///private.png",
            "%2e%2e/private.png",
            "%2E%2E/private.png",
            "%252e%252e/private.png",
            "images/%5cprivate.png",
            "images/%255Cprivate.png",
            "https%253A%252F%252Fexample.invalid%252Fprivate.png",
        )

        for reference in unsafe:
            with self.subTest(reference=reference):
                with self.assertRaises(MarkdownConversionError) as caught:
                    normalize_parser_markdown(
                        f"![resource]({reference})\n".encode(),
                        source_reference="bundle/full.md",
                    )
                self.assertEqual(caught.exception.code, "markdown-reference-invalid")
                self.assertNotIn(reference, str(caught.exception))
                self.assertNotIn(reference, repr(caught.exception))

    def test_duplicate_alias_missing_reference_and_reference_definitions_are_rejected(self) -> None:
        payload = b"![first](./images/a.png)\n![second](images/a.png)\n"
        with self.assertRaises(MarkdownConversionError) as caught:
            normalize_parser_markdown(payload, source_reference="bundle/full.md")
        self.assertEqual(caught.exception.code, "markdown-reference-duplicate")

        duplicate_definition = b"![first][figure]\n[figure]: images/a.png\n[FIGURE]: images/b.png\n"
        with self.assertRaises(MarkdownConversionError) as caught:
            normalize_parser_markdown(
                duplicate_definition,
                source_reference="bundle/full.md",
            )
        self.assertEqual(caught.exception.code, "markdown-reference-duplicate")

        missing = b"![missing](images/missing.png)\n"
        with self.assertRaises(ParserResourceConversionError) as caught:
            convert_parser_artifacts(
                _artifact(missing, "text/markdown"),
                markdown_source_reference="bundle/full.md",
                candidates=(),
            )
        self.assertEqual(caught.exception.code, "resource-reference-missing")

        candidate = _resource("bundle/images/a.png", _PNG, "image/png")
        for duplicates in (
            (candidate, candidate),
            (
                candidate,
                _resource("bundle/images/./a.png", _PNG, "image/png"),
            ),
            (
                candidate,
                _resource("bundle/IMAGES/a.png", _PNG, "image/png"),
            ),
        ):
            with self.subTest(duplicates=duplicates):
                with self.assertRaises(ParserResourceConversionError) as caught:
                    convert_parser_artifacts(
                        _artifact(b"![a](images/a.png)\n", "text/markdown"),
                        markdown_source_reference="bundle/full.md",
                        candidates=duplicates,
                    )
                self.assertEqual(caught.exception.code, "resource-reference-duplicate")

    def test_markdown_and_resource_bytes_hash_size_media_and_budgets_must_align(self) -> None:
        valid_markdown = _artifact(b"![a](images/a.png)\n", "text/markdown")
        valid_resource = _resource("bundle/images/a.png", _PNG, "image/png")
        invalid_markdown = (
            _artifact(b"\xff", "text/markdown"),
            _artifact(b" \n\t", "text/markdown"),
            _artifact(
                b"![a](images/a.png)\n",
                "text/markdown",
                declared_sha256=Sha256("f" * 64),
            ),
            _artifact(
                b"![a](images/a.png)\n",
                "text/markdown",
                declared_size=999,
            ),
            _artifact(b"![a](images/a.png)\n", "text/plain"),
        )
        for markdown in invalid_markdown:
            with self.subTest(markdown=markdown.artifact):
                with self.assertRaises(ParserResourceConversionError) as caught:
                    convert_parser_artifacts(
                        markdown,
                        markdown_source_reference="bundle/full.md",
                        candidates=(valid_resource,),
                    )
                self.assertEqual(caught.exception.code, "markdown-artifact-invalid")

        invalid_resources = (
            _resource(
                "bundle/images/a.png",
                _PNG,
                "image/png",
                declared_sha256=Sha256("e" * 64),
            ),
            _resource(
                "bundle/images/a.png",
                _PNG,
                "image/png",
                declared_size=len(_PNG) + 1,
            ),
            _resource("bundle/images/a.png", _PNG, "image/jpeg"),
            _resource("bundle/images/a.png", b"not a png", "image/png"),
        )
        for resource in invalid_resources:
            with self.subTest(resource=resource.artifact.artifact):
                with self.assertRaises(ParserResourceConversionError) as caught:
                    convert_parser_artifacts(
                        valid_markdown,
                        markdown_source_reference="bundle/full.md",
                        candidates=(resource,),
                    )
                self.assertEqual(caught.exception.code, "resource-artifact-invalid")

        with self.assertRaises(MarkdownConversionError) as caught:
            normalize_parser_markdown(
                b"# too long\n",
                source_reference="bundle/full.md",
                bounds=MarkdownConversionBounds(max_markdown_bytes=4),
            )
        self.assertEqual(caught.exception.code, "markdown-budget-exceeded")

        second = _resource("bundle/images/b.png", _PNG, "image/png")
        two_images = _artifact(
            b"![a](images/a.png)\n![b](images/b.png)\n",
            "text/markdown",
        )
        budget_cases = (
            ParserResourceBounds(max_resource_count=1),
            ParserResourceBounds(max_resource_bytes=len(_PNG) - 1),
            ParserResourceBounds(max_total_resource_bytes=(len(_PNG) * 2) - 1),
        )
        for bounds in budget_cases:
            with self.subTest(bounds=bounds):
                with self.assertRaises(ParserResourceConversionError) as caught:
                    convert_parser_artifacts(
                        two_images,
                        markdown_source_reference="bundle/full.md",
                        candidates=(valid_resource, second),
                        resource_bounds=bounds,
                    )
                self.assertEqual(caught.exception.code, "resource-budget-exceeded")

    def test_normalized_acceptance_enforces_bounds_conflicts_and_exact_closure(self) -> None:
        one_markdown_payload = b"![a](images/a.png)\n"
        two_markdown_payload = b"![a](images/a.png)\n![b](images/b.png)\n"
        one_markdown = _artifact(one_markdown_payload, "text/markdown")
        two_markdown = _artifact(two_markdown_payload, "text/markdown")
        first = _resource("images/a.png", _PNG, "image/png")
        second = _resource("images/b.png", _PNG, "image/png")

        with self.assertRaises(ParserResourceConversionError) as caught:
            validate_normalized_parser_artifacts(
                one_markdown,
                resources=(first,),
                markdown_bounds=MarkdownConversionBounds(
                    max_markdown_bytes=len(one_markdown_payload) - 1
                ),
            )
        self.assertEqual(caught.exception.code, "markdown-artifact-invalid")

        resource_budget_cases = (
            (
                two_markdown,
                (first, second),
                ParserResourceBounds(max_resource_count=1),
            ),
            (
                one_markdown,
                (first,),
                ParserResourceBounds(max_resource_bytes=len(_PNG) - 1),
            ),
            (
                two_markdown,
                (first, second),
                ParserResourceBounds(max_total_resource_bytes=(len(_PNG) * 2) - 1),
            ),
        )
        for markdown, resources, bounds in resource_budget_cases:
            with self.subTest(bounds=bounds):
                with self.assertRaises(ParserResourceConversionError) as caught:
                    validate_normalized_parser_artifacts(
                        markdown,
                        resources=resources,
                        resource_bounds=bounds,
                    )
                self.assertEqual(caught.exception.code, "resource-budget-exceeded")

        with self.assertRaises(ParserResourceConversionError) as caught:
            validate_normalized_parser_artifacts(
                _artifact(b"![a](images/Figure.png)\n", "text/markdown"),
                resources=(
                    _resource("images/Figure.png", _PNG, "image/png"),
                    _resource("images/figure.png", _PNG, "image/png"),
                ),
            )
        self.assertEqual(caught.exception.code, "resource-reference-duplicate")

        with self.assertRaises(ParserResourceConversionError) as caught:
            validate_normalized_parser_artifacts(
                one_markdown,
                resources=(first, second),
            )
        self.assertEqual(caught.exception.code, "resource-reference-invalid")

    def test_archive_is_owner_only_bounded_and_cleaned_while_selected_bytes_survive(self) -> None:
        payload = _zip(
            (
                ("bundle/full.md", _MARKDOWN),
                ("bundle/images/Figure 1.PNG", _PNG),
                ("bundle/tables/data.csv", _CSV),
                ("bundle/images/unused.png", _PNG),
                ("bundle/middle.json", b'{"private": true}'),
                ("bundle/layout.pdf", b"private layout"),
                ("bundle/span.pdf", b"private span"),
                ("bundle/origin.pdf", b"private origin copy"),
            )
        )
        recorder = _TemporaryRecorder()

        with patch("sciretriever.parsing.archive.tempfile.TemporaryDirectory", recorder):
            with extract_parser_archive(payload) as extracted:
                self.assertEqual(len(recorder.paths), 1)
                stage = recorder.paths[0]
                self.assertEqual(stage.parent, Path(tempfile.gettempdir()))
                self.assertEqual(stat.S_IMODE(stage.stat().st_mode), 0o700)
                self.assertEqual(
                    tuple(member.reference for member in extracted.members),
                    tuple(sorted(member.reference for member in extracted.members)),
                )
                for path in stage.rglob("*"):
                    expected = 0o700 if path.is_dir() else 0o600
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), expected)
                    self.assertEqual(path.stat().st_uid, os.getuid())

                members = {member.reference: member for member in extracted.members}
                markdown_member = members["bundle/full.md"]
                candidates = tuple(
                    StagedParserResource(
                        reference=reference,
                        artifact=StagedParserArtifact(
                            artifact=ParserArtifactRef(
                                sha256=members[reference].sha256,
                                media_type=media_type,
                                byte_size=members[reference].byte_size,
                            ),
                            content=members[reference].content,
                        ),
                    )
                    for reference, media_type in (
                        ("bundle/images/Figure 1.PNG", "image/png"),
                        ("bundle/tables/data.csv", "text/csv"),
                        ("bundle/images/unused.png", "image/png"),
                        ("bundle/middle.json", "application/json"),
                    )
                )
                converted = convert_parser_artifacts(
                    StagedParserArtifact(
                        artifact=ParserArtifactRef(
                            sha256=markdown_member.sha256,
                            media_type="text/markdown",
                            byte_size=markdown_member.byte_size,
                        ),
                        content=markdown_member.content,
                    ),
                    markdown_source_reference="bundle/full.md",
                    candidates=candidates,
                )
            self.assertFalse(recorder.paths[0].exists())

        self.assertEqual(
            tuple(resource.reference for resource in converted.resources),
            ("bundle/images/Figure 1.PNG", "bundle/tables/data.csv"),
        )
        self.assertEqual(
            tuple(_read(item.artifact.content) for item in converted.resources), (_PNG, _CSV)
        )

    def test_archive_rejects_paths_duplicates_symlinks_nonregular_and_encryption(self) -> None:
        symlink = zipfile.ZipInfo("bundle/link.png")
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        directory = zipfile.ZipInfo("bundle/directory/")
        directory.create_system = 3
        directory.external_attr = (stat.S_IFDIR | 0o700) << 16
        encrypted = _encrypted(_zip((("bundle/file.txt", b"secret"),)))
        cases = (
            _zip((("/absolute.txt", b"x"),)),
            _zip((("../parent.txt", b"x"),)),
            _zip((("bundle\\backslash.txt", b"x"),)),
            _zip((("C:/drive.txt", b"x"),)),
            _zip((("bundle/%252e%252e/private.txt", b"x"),)),
            _zip((("bundle/a/./b.txt", b"x"), ("bundle/a/b.txt", b"y"))),
            _zip((("bundle/A.txt", b"x"), ("bundle/a.txt", b"y"))),
            _zip(((symlink, b"target"),)),
            _zip(((directory, b""),)),
            encrypted,
        )

        for payload in cases:
            recorder = _TemporaryRecorder()
            with self.subTest(payload_sha256=hashlib.sha256(payload).hexdigest()):
                with patch("sciretriever.parsing.archive.tempfile.TemporaryDirectory", recorder):
                    with self.assertRaises(ParserArchiveError) as caught:
                        extract_parser_archive(payload)
                self.assertIn(caught.exception.code, {"archive-entry-invalid", "archive-duplicate"})
                self.assertTrue(all(not path.exists() for path in recorder.paths))
                self.assertNotIn("private.txt", str(caught.exception))

    def test_archive_rejects_truncation_and_each_resource_budget(self) -> None:
        ordinary = _zip((("a.txt", b"a"), ("b.txt", b"bb")))
        compressed = _zip(
            (("bomb.txt", b"A" * 10_000),),
            compression=zipfile.ZIP_DEFLATED,
        )
        cases = (
            (ordinary[:-9], ParserArchiveBounds(), "archive-invalid"),
            (ordinary, ParserArchiveBounds(max_archive_bytes=len(ordinary) - 1), "archive-budget"),
            (ordinary, ParserArchiveBounds(max_file_count=1), "archive-budget"),
            (ordinary, ParserArchiveBounds(max_member_bytes=1), "archive-budget"),
            (ordinary, ParserArchiveBounds(max_total_bytes=2), "archive-budget"),
            (compressed, ParserArchiveBounds(max_compression_ratio=2), "archive-budget"),
        )

        for payload, bounds, expected_code in cases:
            recorder = _TemporaryRecorder()
            with self.subTest(expected_code=expected_code, bounds=bounds):
                with patch("sciretriever.parsing.archive.tempfile.TemporaryDirectory", recorder):
                    with self.assertRaises(ParserArchiveError) as caught:
                        extract_parser_archive(payload, bounds=bounds)
                self.assertEqual(caught.exception.code, expected_code)
                self.assertTrue(all(not path.exists() for path in recorder.paths))

    def test_archive_context_cleans_staging_when_conversion_fails(self) -> None:
        payload = _zip((("bundle/full.md", b"![missing](images/missing.png)\n"),))
        recorder = _TemporaryRecorder()

        with patch("sciretriever.parsing.archive.tempfile.TemporaryDirectory", recorder):
            with self.assertRaises(ParserResourceConversionError):
                with extract_parser_archive(payload) as extracted:
                    member = extracted.members[0]
                    convert_parser_artifacts(
                        StagedParserArtifact(
                            artifact=ParserArtifactRef(
                                sha256=member.sha256,
                                media_type="text/markdown",
                                byte_size=member.byte_size,
                            ),
                            content=member.content,
                        ),
                        markdown_source_reference=member.reference,
                        candidates=(),
                    )
            self.assertEqual(len(recorder.paths), 1)
            self.assertFalse(recorder.paths[0].exists())

    def test_canonical_resource_path_is_idempotent_and_rejects_encoded_escape(self) -> None:
        canonical = canonical_resource_path("bundle/./images/Figure%201.PNG")
        self.assertEqual(canonical, "bundle/images/Figure 1.PNG")
        self.assertEqual(canonical_resource_path(canonical), canonical)

        for value in ("%2e%2e/x", "%252E%252E/x", "x/%255csecret"):
            with self.subTest(value=value), self.assertRaises(MarkdownConversionError):
                canonical_resource_path(value)


if __name__ == "__main__":
    unittest.main()
