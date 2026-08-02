from __future__ import annotations

import unittest

from sciretriever.core import assets as core_assets
from sciretriever.core.assets import AssetValidationCode
from sciretriever.model.primitives import AssetRole
from tests.target_core_asset_support import pdf, stream, target


class CoreAssetValidationTests(unittest.TestCase):
    def test_content_acceptance_preserves_pdf_and_role_decisions(self) -> None:
        valid = pdf()
        cases = (
            ("exact-doi", stream(valid, "application/pdf"), target(), AssetRole.PRIMARY_PDF, None),
            (
                "title-author-year-fallback",
                stream(pdf(doi=None), "application/pdf"),
                target(doi=None),
                AssetRole.PRIMARY_PDF,
                None,
            ),
            (
                "wrong-doi",
                stream(pdf(doi="10.9999/wrong"), "application/pdf"),
                target(),
                AssetRole.PRIMARY_PDF,
                "identity-mismatch",
            ),
            (
                "primary-reference-doi",
                stream(
                    pdf(doi=None, text="Article body cites 10.9999/reference"), "application/pdf"
                ),
                target(),
                AssetRole.PRIMARY_PDF,
                None,
            ),
            (
                "identity-unconfirmed",
                stream(pdf(title="", author="", doi=None), "application/pdf"),
                target(),
                AssetRole.PRIMARY_PDF,
                "identity-unconfirmed",
            ),
            (
                "supplementary-marker",
                stream(
                    pdf(title="Supplementary Information for Exact Article Title") + b"x" * 400,
                    "application/pdf",
                ),
                target(),
                AssetRole.PRIMARY_PDF,
                "not-primary",
            ),
            (
                "supplementary-body",
                stream(
                    pdf(text="Supplementary Information for Exact Article Title") + b"x" * 400,
                    "application/pdf",
                ),
                target(),
                AssetRole.PRIMARY_PDF,
                "not-primary",
            ),
            (
                "malformed",
                stream(b"x" * 400, "application/pdf"),
                target(),
                AssetRole.PRIMARY_PDF,
                "format-invalid",
            ),
            (
                "truncated",
                stream(valid[:-20], "application/pdf"),
                target(),
                AssetRole.PRIMARY_PDF,
                "format-invalid",
            ),
            (
                "wrong-media",
                stream(valid, "text/plain"),
                target(),
                AssetRole.PRIMARY_PDF,
                "media-type-invalid",
            ),
            (
                "oversize",
                stream(valid, "application/pdf"),
                target(),
                AssetRole.PRIMARY_PDF,
                "size-invalid",
            ),
            (
                "xml",
                stream(b"<article>article body</article>", "application/xml"),
                target(),
                AssetRole.XML,
                None,
            ),
            (
                "html",
                stream(b"<html><body>ok</body></html>", "text/html"),
                target(),
                AssetRole.HTML,
                None,
            ),
            (
                "supplementary",
                stream(b"bytes", "application/octet-stream"),
                target(),
                AssetRole.SUPPLEMENTARY,
                None,
            ),
            (
                "supplementary-pdf",
                stream(pdf(), "application/pdf"),
                target(),
                AssetRole.SUPPLEMENTARY_PDF,
                None,
            ),
            (
                "supplementary-reference-doi",
                stream(pdf(doi=None, text="Supplement cites 10.9999/reference"), "application/pdf"),
                target(),
                AssetRole.SUPPLEMENTARY_PDF,
                None,
            ),
            (
                "xml-reference-doi",
                stream(b"<article><p>Reference 10.9999/reference</p></article>", "application/xml"),
                target(),
                AssetRole.XML,
                None,
            ),
            (
                "html-reference-doi",
                stream(
                    b"<html><body><p>Reference 10.9999/reference</p></body></html>",
                    "text/html",
                ),
                target(),
                AssetRole.HTML,
                None,
            ),
        )
        for name, content, content_target, role, expected_code in cases:
            with self.subTest(name=name):
                failure = core_assets.validate_asset(
                    content,
                    content_target,
                    role,
                    min_pdf_bytes=300,
                    max_asset_bytes=100_000 if name != "oversize" else len(valid) - 1,
                )
                self.assertEqual(None if failure is None else failure.value, expected_code)

    def test_content_acceptance_rejects_unusable_supported_assets(self) -> None:
        cases = (
            (
                "blank-pdf",
                stream(pdf(text=None), "application/pdf"),
                target(),
                AssetRole.PRIMARY_PDF,
                AssetValidationCode.PARSE_INVALID,
            ),
            (
                "malformed-startxref-pdf",
                stream(b"%PDF-1.7\n" + b"body" * 100 + b"\n%%EOF", "application/pdf"),
                target(),
                AssetRole.PRIMARY_PDF,
                AssetValidationCode.PARSE_INVALID,
            ),
            (
                "empty-xml",
                stream(b"<article />", "application/xml"),
                target(),
                AssetRole.XML,
                AssetValidationCode.PARSE_INVALID,
            ),
            (
                "blank-html",
                stream(b"<html><body> \n\t</body></html>", "text/html"),
                target(),
                AssetRole.HTML,
                AssetValidationCode.PARSE_INVALID,
            ),
        )
        for name, content, content_target, role, expected_code in cases:
            with self.subTest(name=name):
                failure = core_assets.validate_asset(
                    content,
                    content_target,
                    role,
                    min_pdf_bytes=300,
                    max_asset_bytes=100_000,
                )
                self.assertEqual(failure, expected_code)

    def test_supplementary_structured_assets_reject_explicit_conflicting_doi(self) -> None:
        cases = (
            (
                AssetRole.SUPPLEMENTARY_PDF,
                stream(pdf(doi="10.9999/wrong"), "application/pdf"),
            ),
            (
                AssetRole.XML,
                stream(
                    b'<article><article-id pub-id-type="doi">10.9999/wrong</article-id></article>',
                    "application/xml",
                ),
            ),
            (
                AssetRole.HTML,
                stream(
                    b'<html><head><meta name="citation_doi" content="10.9999/wrong"></head>'
                    b"<body>article</body></html>",
                    "text/html",
                ),
            ),
        )
        for role, content in cases:
            with self.subTest(role=role):
                failure = core_assets.validate_asset(
                    content,
                    target(),
                    role,
                    min_pdf_bytes=300,
                    max_asset_bytes=100_000,
                )
                self.assertEqual(failure, AssetValidationCode.IDENTITY_MISMATCH)


if __name__ == "__main__":
    unittest.main()
